#!/usr/bin/env node
/**
 * skills/check_schedule/impl.js (OpenClaw skill version)
 *
 * 生管 (planner) — 算自家產線排程 vs 客戶要的交期。
 * 純計算、no LLM、deterministic & auditable。
 * 讀 ./data/schedule.json (as_of_date 為基準，不用 new Date 確保 demo 可重現)。
 */

const fs = require('fs/promises');
const path = require('path');

const SKILL_DIR = __dirname;
const SCHEDULE_JSON = path.join(SKILL_DIR, 'data', 'schedule.json');

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

function daysBetween(a, b) {
  return Math.floor((new Date(b) - new Date(a)) / (1000 * 60 * 60 * 24));
}

async function checkSchedule({ product_id, qty, customer_desired_lead_days, surface_treatment_lead_days }) {
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('qty must be > 0');
  if (!Number.isFinite(customer_desired_lead_days) || customer_desired_lead_days <= 0) {
    throw new Error('customer_desired_lead_days must be > 0');
  }

  const raw = await fs.readFile(SCHEDULE_JSON, 'utf8');
  const sched = JSON.parse(raw);
  const line = sched.lines[0];   // 包膠線 A — demo 只一條線

  const asOf = sched.as_of_date;   // 2026-05-25
  const earliestStart = line.earliest_start_date;
  const daysToEarliestStart = Math.max(0, daysBetween(asOf, earliestStart));

  const purchaseSteel = sched.process_lead_times.steel_wheel_purchase_days;       // 3
  const surface = surface_treatment_lead_days !== undefined
    ? Number(surface_treatment_lead_days)
    : 4;   // 預設最快代工 (大同 4 天)
  const inHousePU = sched.process_lead_times.in_house_pu_coating_days;            // 6
  const qcPack = sched.process_lead_times.qc_and_pack_days;                       // 1

  const totalDays = daysToEarliestStart + purchaseSteel + surface + inHousePU + qcPack;
  const gapDays = totalDays - customer_desired_lead_days;
  const achievable = gapDays <= 0;

  return {
    product_id,
    qty,
    earliest_start_date: earliestStart,
    days_to_earliest_start: daysToEarliestStart,
    purchase_steel_wheel_days: purchaseSteel,
    surface_treatment_days: surface,
    in_house_pu_coating_days: inHousePU,
    qc_pack_days: qcPack,
    total_lead_time_days: totalDays,
    customer_desired_lead_days,
    gap_days: gapDays,
    achievable,
    note: achievable
      ? `在客戶要的 ${customer_desired_lead_days} 天內做得出來 (最快 ${totalDays} 天)`
      : `差 ${gapDays} 天 — 最快 ${totalDays} 天，客戶要 ${customer_desired_lead_days} 天。需要選最快代工廠或跟客戶談延期`,
    schedule_basis: {
      as_of: asOf,
      line: line.line_name,
      line_id: line.line_id,
      capacity_units_per_day: line.capacity_units_per_day,
      current_backlog_units: line.current_backlog_units,
      next_window: line.earliest_start_date,
      scheduled_orders_count: (line.scheduled_orders || []).length
    },
    _meta: {
      skill: 'check_schedule',
      agent: 'planner',
      schedule_file: 'data/schedule.json',
      calculated_at: new Date().toISOString()
    }
  };
}

async function main() {
  const input = await readStdin();
  const result = await checkSchedule(input);
  process.stdout.write(JSON.stringify(result));
}

main().catch(err => {
  console.error(`[check_schedule] fatal: ${err.message}`);
  process.exit(1);
});
