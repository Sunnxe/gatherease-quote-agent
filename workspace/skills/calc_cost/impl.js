#!/usr/bin/env node
/**
 * skills/calc_cost/impl.js (OpenClaw skill version)
 *
 * 接 stdin JSON，計算 BOM 單位成本 + 建議單價，stdout JSON。
 * 純計算、無 LLM、deterministic & auditable。
 */

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { writebackToOrder, findOrdersDir } = require('../_lib/order_writeback');

const SKILL_DIR = __dirname;
const COST_CSV = path.join(SKILL_DIR, 'data', 'bom_cost_data.csv');
const SUPPLIERS_JSON = path.join(SKILL_DIR, 'data', 'suppliers.json');

// 從 order JSON 拿 engineering_read.bom — 讓 agent 不用搬 BOM 大陣列
function readOrderBom(order_id) {
  try {
    const p = path.join(findOrdersDir(), `${order_id}.json`);
    if (!fsSync.existsSync(p)) return null;
    const order = JSON.parse(fsSync.readFileSync(p, 'utf8'));
    return order?.engineering_read?.bom || null;
  } catch { return null; }
}

// 從 order 拉老闆選定的 supplier_id（gate-2 audit_trail 紀錄）
// 讓 agent 在 gate-2 後不用記得手動帶 surface_treatment_supplier_id
function readChosenSupplierId(order_id) {
  try {
    const p = path.join(findOrdersDir(), `${order_id}.json`);
    if (!fsSync.existsSync(p)) return null;
    const order = JSON.parse(fsSync.readFileSync(p, 'utf8'));
    // 1. 優先看 order.chosen_supplier_id（agent gate-2 callback 後設的）
    if (order?.chosen_supplier_id) return order.chosen_supplier_id;
    // 2. 從 audit_trail 找 gate-2 的 chosen_supplier_id
    for (const audit of (order?.audit_trail || []).slice().reverse()) {
      if (audit.chosen_supplier_id) return audit.chosen_supplier_id;
    }
    return null;
  } catch { return null; }
}

// 從 order.supplier_replies 拉特定廠商本次的真實報價（覆蓋 suppliers.json 標準值）
function readSupplierReplyPrice(order_id, supplier_id) {
  if (!order_id || !supplier_id) return null;
  try {
    const p = path.join(findOrdersDir(), `${order_id}.json`);
    if (!fsSync.existsSync(p)) return null;
    const order = JSON.parse(fsSync.readFileSync(p, 'utf8'));
    const rep = (order.supplier_replies || []).find(r => r.supplier_id === supplier_id);
    if (!rep) return null;
    return rep.unit_price_twd ?? rep.price_twd ?? null;
  } catch { return null; }
}

const OVERHEAD_PCT = 12;
const MARKUP_TABLE = { tier_A: 32, tier_B: 24, tier_C: 18 };

async function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { buf += chunk; });
    process.stdin.on('end', () => {
      try { resolve(buf.trim() ? JSON.parse(buf) : {}); }
      catch (e) { reject(new Error(`stdin not valid JSON: ${e.message}`)); }
    });
    process.stdin.on('error', reject);
  });
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => {
    const cells = line.split(',');
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i] !== undefined ? cells[i] : ''; });
    return row;
  });
}

async function loadCostTable() {
  const raw = await fs.readFile(COST_CSV, 'utf8');
  const rows = parseCSV(raw);
  const table = new Map();
  for (const row of rows) {
    table.set(row.part_name, {
      part_name: row.part_name,
      base_unit_cost: row.base_unit_cost ? parseFloat(row.base_unit_cost) : null,
      lead_time_days: row.lead_time_days ? parseInt(row.lead_time_days, 10) : null,
      sourcing_type: row.sourcing_type
    });
  }
  return table;
}

async function loadSuppliers() {
  try {
    const raw = await fs.readFile(SUPPLIERS_JSON, 'utf8');
    return JSON.parse(raw).suppliers;
  } catch { return []; }
}

async function calcCost({ product_id, bom, qty, surface_treatment_supplier_id, customer_tier = 'tier_A', order_id }) {
  if (!Array.isArray(bom)) throw new Error('bom must be an array of {part_name, qty_per_unit}');
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('qty must be > 0');

  const costTable = await loadCostTable();
  const suppliers = await loadSuppliers();

  let surfaceSupplier = null;
  let surfaceSourceTag = null;
  if (surface_treatment_supplier_id) {
    surfaceSupplier = suppliers.find(s => s.id === surface_treatment_supplier_id);
    if (!surfaceSupplier) throw new Error(`Supplier not found: ${surface_treatment_supplier_id}`);
    // ⚡ 用本次廠商真實 reply 報價覆蓋 suppliers.json 標準值
    const replyPrice = readSupplierReplyPrice(order_id, surface_treatment_supplier_id);
    if (replyPrice != null) {
      surfaceSupplier = {
        ...surfaceSupplier,
        pricing: { ...surfaceSupplier.pricing, unit_price_twd: replyPrice }
      };
      surfaceSourceTag = `supplier-reply:${surfaceSupplier.name} (本案 NT$${replyPrice}/隻)`;
    } else {
      surfaceSourceTag = `suppliers.json default:${surfaceSupplier.name} (NT$${surfaceSupplier.pricing.unit_price_twd}/隻)`;
    }
  }

  const lineItems = [];
  let directUnitCost = 0;
  const unknownParts = [];

  for (const line of bom) {
    const name = line.part_name;
    const lineQtyPerUnit = line.qty_per_unit !== undefined ? Number(line.qty_per_unit) : 1;
    const isSurfaceTreatmentLine = /surface\s*treatment|surface\s*finish/i.test(name);

    let unitCost = 0;
    let costSource = '';

    if (isSurfaceTreatmentLine && surfaceSupplier) {
      unitCost = surfaceSupplier.pricing.unit_price_twd;
      costSource = `supplier:${surfaceSupplier.name}`;
    } else if (costTable.has(name)) {
      const entry = costTable.get(name);
      if (entry.base_unit_cost === null) {
        unitCost = 650;
        costSource = 'vendor-default (no CSV price)';
      } else {
        unitCost = entry.base_unit_cost;
        costSource = `bom_cost_data.csv:${entry.sourcing_type}`;
      }
    } else {
      unknownParts.push(name);
      continue;
    }

    const lineCostPerUnit = unitCost * lineQtyPerUnit;
    directUnitCost += lineCostPerUnit;

    lineItems.push({
      part_name: name,
      qty_per_unit: lineQtyPerUnit,
      unit_cost_twd: unitCost,
      line_cost_per_unit_twd: Math.round(lineCostPerUnit * 100) / 100,
      cost_source: costSource
    });
  }

  const unitCostWithOverhead = directUnitCost * (1 + OVERHEAD_PCT / 100);
  const markupPct = MARKUP_TABLE[customer_tier] ?? MARKUP_TABLE.tier_A;
  const suggestedUnitPrice = Math.round(unitCostWithOverhead * (1 + markupPct / 100));
  const totalCost = unitCostWithOverhead * qty;
  const suggestedRevenue = suggestedUnitPrice * qty;

  return {
    product_id,
    qty,
    customer_tier,
    surface_treatment_supplier_used: surfaceSupplier ? {
      id: surfaceSupplier.id,
      name: surfaceSupplier.name,
      unit_price_twd: surfaceSupplier.pricing.unit_price_twd,
      lead_time_days: surfaceSupplier.lead_time_days
    } : null,
    bom_breakdown: lineItems,
    unknown_parts: unknownParts,
    unit_direct_cost_twd: Math.round(directUnitCost * 100) / 100,
    overhead_pct: OVERHEAD_PCT,
    unit_cost_with_overhead_twd: Math.round(unitCostWithOverhead * 100) / 100,
    markup_pct_applied: markupPct,
    unit_cost_twd: Math.round(unitCostWithOverhead * 100) / 100,
    total_cost_twd: Math.round(totalCost),
    suggested_unit_price_twd: suggestedUnitPrice,
    suggested_revenue_twd: suggestedRevenue,
    _meta: {
      skill: 'calc_cost',
      agent: 'quote',
      cost_source_file: 'data/bom_cost_data.csv',
      calculated_at: new Date().toISOString()
    }
  };
}

async function main() {
  const input = await readStdin();
  const { order_id } = input;

  // 如果 agent 沒給 bom 但有 order_id → 從 order 自動拿
  // 這是 anti-hallucination 的另一層：agent 連 BOM 都不用打、不會抄錯
  if (!input.bom && order_id) {
    const bomFromOrder = readOrderBom(order_id);
    if (bomFromOrder) {
      input.bom = bomFromOrder;
    }
  }

  // ⚡ 防呆：agent 沒帶 surface_treatment_supplier_id 但 order 裡老闆已選了 → 自動套用
  // 這樣 gate-2 後 agent 只要 call calc_cost {order_id} 就會自動用對的廠商
  if (!input.surface_treatment_supplier_id && order_id) {
    const chosen = readChosenSupplierId(order_id);
    if (chosen) {
      input.surface_treatment_supplier_id = chosen;
      console.error(`[calc_cost] surface_treatment_supplier_id 沒帶、從 order 自動拉 = "${chosen}"`);
    }
  }

  const result = await calcCost(input);

  // Auto-writeback
  let writebackResult = null;
  if (order_id) {
    writebackResult = writebackToOrder({
      order_id,
      patch: { cost_baseline: result },
      audit: {
        level: 'INFO',
        msg: `cost calculated: unit NT$${result.suggested_unit_price_twd}`,
        skill: 'calc_cost',
        unit_cost_twd: result.unit_cost_twd,
        suggested_unit_price_twd: result.suggested_unit_price_twd
      }
    });
  }

  if (order_id && writebackResult && writebackResult.ok) {
    // Slim: 給 agent 看的關鍵數字
    process.stdout.write(JSON.stringify({
      order_id,
      writeback: writebackResult,
      product_id: result.product_id,
      qty: result.qty,
      unit_direct_cost_twd: result.unit_direct_cost_twd,
      unit_cost_with_overhead_twd: result.unit_cost_with_overhead_twd,
      suggested_unit_price_twd: result.suggested_unit_price_twd,
      total_cost_twd: result.total_cost_twd,
      suggested_revenue_twd: result.suggested_revenue_twd,
      markup_pct_applied: result.markup_pct_applied,
      surface_treatment_supplier_used: result.surface_treatment_supplier_used,
      note: 'cost_baseline 完整 BOM breakdown 已寫回 order_store。'
    }));
  } else {
    process.stdout.write(JSON.stringify({ ...result, writeback: writebackResult }));
  }
}

main().catch(err => {
  console.error(`[calc_cost] fatal: ${err.message}`);
  process.exit(1);
});
