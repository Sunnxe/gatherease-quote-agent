#!/usr/bin/env node
/**
 * skills/order_store/impl.js
 *
 * 訂單 CRUD hub。所有訂單存在 workspace/data/orders/<order_id>.json。
 * 多個 skill 共用同一個位置 (sandbox 內 workspace mount，所有 skill 看得到)。
 *
 * Actions:
 *   create        新訂單，auto-gen QUO-YYYY-NNNN
 *   get           讀單筆 order
 *   update        merge patch 到 order，自動更新 updated_at
 *   append_audit  audit_trail append 一筆 (auto ts)
 *   list          列訂單 summary (可 filter by status)
 */

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');

const SKILL_DIR = __dirname;
const WORKSPACE_DIR = path.resolve(SKILL_DIR, '..', '..');
const ORDERS_DIR = path.join(WORKSPACE_DIR, 'data', 'orders');

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

async function ensureOrdersDir() {
  await fs.mkdir(ORDERS_DIR, { recursive: true });
}

function orderPath(orderId) {
  return path.join(ORDERS_DIR, `${orderId}.json`);
}

async function atomicWriteJSON(p, data) {
  const tmp = p + '.tmp.' + process.pid;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, p);
}

async function nextOrderId() {
  const year = new Date().getFullYear();
  let max = 0;
  try {
    const files = await fs.readdir(ORDERS_DIR);
    for (const f of files) {
      const m = f.match(new RegExp(`^QUO-${year}-(\\d{4})\\.json$`));
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
  } catch {}
  return `QUO-${year}-${String(max + 1).padStart(4, '0')}`;
}

function newOrderTemplate({ orderId, customer, incoming }) {
  const now = new Date().toISOString();
  return {
    order_id: orderId,
    status: 'pending_quote',
    customer: customer || { name: null, contact_email: null },
    received_at: now,
    updated_at: now,
    incoming: incoming || null,
    engineering_read: null,
    history_matches: null,
    schedule_check: null,
    cost_baseline: null,
    rfq_sent_to: [],
    rfq_sent_at: null,
    supplier_replies: [],
    comparison: null,
    boss_decisions: [],
    final_cost: null,
    final_quote_pdf_path: null,
    sent_to_customer_at: null,
    audit_trail: [
      { ts: now, level: 'INFO', msg: 'order created', skill: 'order_store' }
    ]
  };
}

async function actionCreate({ customer, incoming }) {
  await ensureOrdersDir();
  const orderId = await nextOrderId();
  const order = newOrderTemplate({ orderId, customer, incoming });
  await atomicWriteJSON(orderPath(orderId), order);
  return order;
}

async function actionGet({ order_id }) {
  if (!order_id) throw new Error('order_id required');
  const p = orderPath(order_id);
  if (!fsSync.existsSync(p)) throw new Error(`order not found: ${order_id}`);
  return JSON.parse(await fs.readFile(p, 'utf8'));
}

async function actionUpdate({ order_id, patch }) {
  if (!order_id) throw new Error('order_id required');
  if (!patch || typeof patch !== 'object') throw new Error('patch must be object');
  const order = await actionGet({ order_id });
  // Shallow merge — patch top-level fields only, nested objects 整個取代
  for (const [k, v] of Object.entries(patch)) {
    order[k] = v;
  }
  order.updated_at = new Date().toISOString();
  await atomicWriteJSON(orderPath(order_id), order);
  return order;
}

async function actionAppendAudit({ order_id, entry }) {
  if (!order_id) throw new Error('order_id required');
  if (!entry || typeof entry !== 'object') throw new Error('entry must be object');
  const order = await actionGet({ order_id });
  if (!Array.isArray(order.audit_trail)) order.audit_trail = [];
  order.audit_trail.push({
    ts: new Date().toISOString(),
    ...entry
  });
  order.updated_at = new Date().toISOString();
  await atomicWriteJSON(orderPath(order_id), order);
  return order;
}

async function actionList({ status, limit }) {
  await ensureOrdersDir();
  const files = (await fs.readdir(ORDERS_DIR))
    .filter(f => /^QUO-\d{4}-\d{4}\.json$/.test(f))
    .sort()
    .reverse();   // newest first
  const summaries = [];
  for (const f of files) {
    try {
      const o = JSON.parse(await fs.readFile(path.join(ORDERS_DIR, f), 'utf8'));
      if (status && o.status !== status) continue;
      summaries.push({
        order_id: o.order_id,
        status: o.status,
        customer_name: o.customer?.name,
        customer_email: o.customer?.contact_email,
        received_at: o.received_at,
        updated_at: o.updated_at
      });
      if (limit && summaries.length >= limit) break;
    } catch {}
  }
  return { orders: summaries, count: summaries.length };
}

async function main() {
  const input = await readStdin();
  const action = input.action;
  if (!action) throw new Error('action required: create | get | update | append_audit | list');

  let result;
  switch (action) {
    case 'create':        result = await actionCreate(input); break;
    case 'get':           result = await actionGet(input); break;
    case 'update':        result = await actionUpdate(input); break;
    case 'append_audit':  result = await actionAppendAudit(input); break;
    case 'list':          result = await actionList(input); break;
    default:              throw new Error(`unknown action: ${action}`);
  }

  process.stdout.write(JSON.stringify(result));
}

main().catch(err => {
  console.error(`[order_store] fatal: ${err.message}`);
  process.exit(1);
});
