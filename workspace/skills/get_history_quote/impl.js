#!/usr/bin/env node
/**
 * skills/get_history_quote/impl.js (OpenClaw skill version)
 *
 * 對 ./data/historical_orders.csv 內 10k 筆訂單做加權相似度比對，回 top-K。
 *
 * Ported from GatherEase 25.01DummyData/order/similarity_checker.py
 *   ProductName  40%  text similarity (LCS-based ratio)
 *   OrderDate    30%  closer in time = more similar (5y cutoff)
 *   Spec         20%  Euclidean distance on [Φ, width, length]
 *   Hardness     10%  numerical proximity (50 Shore A range)
 *
 * 純函數、無 LLM、可重現。
 */

const fs = require('fs/promises');
const path = require('path');

const SKILL_DIR = __dirname;
const CSV_PATH = path.join(SKILL_DIR, 'data', 'historical_orders.csv');

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

// ─── CSV parse ──────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => {
    const cells = line.split(',');
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i]; });
    return row;
  });
}

function parseSpec(spec) {
  if (Array.isArray(spec)) return spec.map(Number);
  return String(spec).split('*').map(s => parseInt(s, 10));
}

// ─── Similarity primitives ──────────────────────────────────
function textSimilarity(a, b) {
  a = (a || '').toLowerCase();
  b = (b || '').toLowerCase();
  if (a === b) return 1.0;
  if (!a || !b) return 0;
  const matches = lcsLength(a, b);
  return (2 * matches) / (a.length + b.length);
}

function lcsLength(a, b) {
  const dp = Array(a.length + 1).fill(null).map(() => Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i-1] === b[j-1]) dp[i][j] = dp[i-1][j-1] + 1;
      else dp[i][j] = Math.max(dp[i-1][j], dp[i][j-1]);
    }
  }
  return dp[a.length][b.length];
}

function euclideanDistance(specA, specB) {
  if (specA.length !== specB.length) throw new Error('Spec arrays must have same length');
  return Math.sqrt(specA.reduce((sum, x, i) => sum + (x - specB[i]) ** 2, 0));
}

function dateSimilarity(newDateStr, oldDateStr) {
  const newDate = new Date(newDateStr);
  const oldDate = new Date(oldDateStr);
  const dayDiff = Math.abs((newDate - oldDate) / (1000 * 60 * 60 * 24));
  const maxDays = 365 * 5;
  if (dayDiff >= maxDays) return 0;
  return 1.0 - (dayDiff / maxDays);
}

// ─── Scoring ────────────────────────────────────────────────
const WEIGHTS = { product: 0.40, date: 0.30, spec: 0.20, hardness: 0.10 };
const MAX_SPEC_DIST = 50.0;
const MAX_HARDNESS_RANGE = 50.0;

function computeSimilarityScore(newOrder, oldOrder) {
  const productSim = textSimilarity(newOrder.ProductName, oldOrder.ProductName);
  const dateSim = dateSimilarity(newOrder.OrderDate, oldOrder.OrderDate);
  const specDist = euclideanDistance(newOrder.Spec, parseSpec(oldOrder.Spec));
  const specSim = Math.max(0, 1.0 - (specDist / MAX_SPEC_DIST));
  const hardnessDiff = Math.abs(newOrder.Hardness - parseInt(oldOrder.Hardness, 10));
  const hardnessSim = Math.max(0, 1.0 - (hardnessDiff / MAX_HARDNESS_RANGE));
  return (
    WEIGHTS.product   * productSim +
    WEIGHTS.date      * dateSim +
    WEIGHTS.spec      * specSim +
    WEIGHTS.hardness  * hardnessSim
  );
}

// ─── main ───────────────────────────────────────────────────
async function main() {
  const { new_order, k = 5 } = await readStdin();
  if (!new_order) throw new Error('missing new_order in stdin');

  const raw = await fs.readFile(CSV_PATH, 'utf8');
  const orders = parseCSV(raw);
  const normalizedNew = { ...new_order, Spec: parseSpec(new_order.Spec) };

  const startedAt = Date.now();
  const scored = orders.map(order => ({
    order,
    score: computeSimilarityScore(normalizedNew, order)
  }));
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, k);
  const elapsedMs = Date.now() - startedAt;

  // 加權平均單價（若 CSV 有 UnitPrice 欄）
  const weights = top.map(t => t.score);
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  let weightedAvgUnitPrice = null;
  if (top.some(t => t.order.UnitPrice)) {
    const sumWeighted = top.reduce(
      (s, t) => s + parseFloat(t.order.UnitPrice || 0) * t.score, 0
    );
    weightedAvgUnitPrice = Math.round(sumWeighted / totalWeight);
  }

  const output = {
    new_order_input: normalizedNew,
    k,
    matches: top.map(t => ({
      OrderID: parseInt(t.order.OrderID, 10),
      OrderDate: t.order.OrderDate,
      ProductName: t.order.ProductName,
      Hardness: parseInt(t.order.Hardness, 10),
      Quantity: parseInt(t.order.Quantity, 10),
      Color: t.order.Color,
      Spec: t.order.Spec,
      score: Math.round(t.score * 1000) / 1000
    })),
    weighted_avg_unit_price: weightedAvgUnitPrice,
    method: 'weighted similarity: name 40% + date 30% + spec 20% + hardness 10%',
    _meta: {
      skill: 'get_history_quote',
      agent: 'quote',
      historical_orders_scanned: orders.length,
      elapsed_ms: elapsedMs,
      finished_at: new Date().toISOString()
    }
  };

  process.stdout.write(JSON.stringify(output));
}

main().catch(err => {
  console.error(`[get_history_quote] fatal: ${err.message}`);
  process.exit(1);
});
