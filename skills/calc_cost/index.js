/**
 * skills/calc_cost/index.js
 * Agent: quote (報價主)
 * Category: CONTROL — pure calculation, no LLM, fully deterministic & auditable
 *
 * 接受標準 7 行 BOM (對齊 GatherEase 25.01DummyData/bom/BOM_orders.csv schema)，
 * 從 data/bom_cost_data.csv 查每一行的 base_unit_cost，乘以 qty，
 * 加 overhead，套 tier markup，回建議單價。
 *
 * + 可選 surface_treatment_supplier 覆寫某行外購價（demo 多維權衡用）
 */

const fs = require('fs/promises');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const COST_CSV = path.join(ROOT, 'data', 'bom_cost_data.csv');
const SUPPLIERS_JSON = path.join(ROOT, 'data', 'suppliers.json');

// 簡易內建常數（沒值得單獨 JSON 化的兩個率）
const OVERHEAD_PCT = 12;
const MARKUP_TABLE = { tier_A: 32, tier_B: 24, tier_C: 18 };

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

/**
 * @param {object} args
 * @param {string} args.product_id
 * @param {Array<{part_name, qty, unit?}>} args.bom  - 標準 7 行 BOM
 * @param {number} args.qty  - 訂單支數
 * @param {string} [args.surface_treatment_supplier_id]  - 若指定則覆寫某行外購價
 * @param {string} [args.customer_tier]  - tier_A / tier_B / tier_C，預設 tier_A
 */
async function run({ product_id, bom, qty, surface_treatment_supplier_id, customer_tier = 'tier_A' }) {
  if (!Array.isArray(bom)) throw new Error('bom must be an array of {part_name, qty}');
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('qty must be > 0');

  const costTable = await loadCostTable();
  const suppliers = await loadSuppliers();

  // 若有指定 surface treatment 廠商，準備覆寫
  let surfaceSupplier = null;
  if (surface_treatment_supplier_id) {
    surfaceSupplier = suppliers.find(s => s.id === surface_treatment_supplier_id);
    if (!surfaceSupplier) throw new Error(`Supplier not found: ${surface_treatment_supplier_id}`);
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
      // 覆寫成廠商報的價
      unitCost = surfaceSupplier.pricing.unit_price_twd;
      costSource = `supplier:${surfaceSupplier.name}`;
    } else if (costTable.has(name)) {
      const entry = costTable.get(name);
      if (entry.base_unit_cost === null) {
        // 例：Roller Core (Shaft) 是 Vendor 但沒寫單價 → demo 假設為 $650
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

  // overhead
  const unitCostWithOverhead = directUnitCost * (1 + OVERHEAD_PCT / 100);

  // markup → 建議單價
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
    unknown_parts: unknownParts,    // 報出 cost table 找不到的 part，方便除錯
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

module.exports = { run };

// CLI test
if (require.main === module) {
  // 模擬一張 Anti-Static Silicone Roller 訂單的 7 行 BOM
  const sampleBOM = [
    { part_name: 'Roller Core (Shaft)', qty_per_unit: 1 },
    { part_name: 'Anti-Static Silicone Cover', qty_per_unit: 0.8 },   // ~0.8 kg per unit
    { part_name: 'Adhesive (Bonding Agent)', qty_per_unit: 60 },       // ~60 ml per unit
    { part_name: 'End Caps (if applicable)', qty_per_unit: 2 },
    { part_name: 'Bearings', qty_per_unit: 2 },
    { part_name: 'Surface Finish (Grinding)', qty_per_unit: 1 },
    { part_name: 'Packaging/Protection', qty_per_unit: 1 }
  ];
  run({
    product_id: 'Anti-Static Silicone Roller',
    bom: sampleBOM,
    qty: 200,
    surface_treatment_supplier_id: 'SUP-002',
    customer_tier: 'tier_A'
  }).then(r => console.log(JSON.stringify(r, null, 2))).catch(e => { console.error(e); process.exit(1); });
}
