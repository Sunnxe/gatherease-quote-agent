#!/usr/bin/env node
/**
 * skills/calc_cost/impl.js (OpenClaw skill version)
 *
 * 接 stdin JSON，計算 BOM 單位成本 + 建議單價，stdout JSON。
 * 純計算、無 LLM、deterministic & auditable。
 */

const fs = require('fs/promises');
const path = require('path');

const SKILL_DIR = __dirname;
const COST_CSV = path.join(SKILL_DIR, 'data', 'bom_cost_data.csv');
const SUPPLIERS_JSON = path.join(SKILL_DIR, 'data', 'suppliers.json');

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

async function calcCost({ product_id, bom, qty, surface_treatment_supplier_id, customer_tier = 'tier_A' }) {
  if (!Array.isArray(bom)) throw new Error('bom must be an array of {part_name, qty_per_unit}');
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('qty must be > 0');

  const costTable = await loadCostTable();
  const suppliers = await loadSuppliers();

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
  const result = await calcCost(input);
  process.stdout.write(JSON.stringify(result));
}

main().catch(err => {
  console.error(`[calc_cost] fatal: ${err.message}`);
  process.exit(1);
});
