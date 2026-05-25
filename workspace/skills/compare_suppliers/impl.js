#!/usr/bin/env node
/**
 * skills/compare_suppliers/impl.js (OpenClaw skill version)
 *
 * 讀 ./data/suppliers.json，3 家代工廠多維比對。
 */

const fs = require('fs/promises');
const path = require('path');

const SKILL_DIR = __dirname;
const SUPPLIERS_JSON = path.join(SKILL_DIR, 'data', 'suppliers.json');

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

async function main() {
  const { supplier_ids, customer_requirements = {} } = await readStdin();
  if (!Array.isArray(supplier_ids)) throw new Error('supplier_ids must be array');

  const raw = await fs.readFile(SUPPLIERS_JSON, 'utf8');
  const { suppliers } = JSON.parse(raw);

  const maxDays = customer_requirements.max_surface_treatment_days ?? Infinity;
  const requiresAntiStatic = !!customer_requirements.requires_anti_static;

  const result = supplier_ids
    .map(id => suppliers.find(s => s.id === id))
    .filter(Boolean)
    .map(s => ({
      supplier_id: s.id,
      name: s.name,
      price_twd: s.pricing.unit_price_twd,
      lead_time_days: s.lead_time_days,
      yield_rate_pct: s.quality.yield_rate_pct,
      anti_static: s.quality.anti_static_capable,
      certifications: s.quality.certifications,
      meets_lead_time: s.lead_time_days <= maxDays,
      meets_quality: !requiresAntiStatic || s.quality.anti_static_capable,
      notes: s.notes
    }));

  process.stdout.write(JSON.stringify({
    candidates: result,
    customer_requirements,
    _meta: {
      skill: 'compare_suppliers',
      agent: 'quote',
      finished_at: new Date().toISOString()
    }
  }));
}

main().catch(err => {
  console.error(`[compare_suppliers] fatal: ${err.message}`);
  process.exit(1);
});
