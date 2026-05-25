/**
 * skills/get_history_quote/index.js
 * Agent: quote (報價主)
 * Category: INPUT
 *
 * 對新詢價訂單做加權相似度比對，從歷史 10,000 筆訂單裡找 top-K 最像的，
 * 提供老闆做定價參考。
 *
 * 加權公式 (port 自 GatherEase 25.01DummyData/order/similarity_checker.py)：
 *   ProductName  40%  (text similarity, Levenshtein-like via simple ratio)
 *   OrderDate    30%  (closer in time = more similar, 5y cutoff)
 *   Spec         20%  (Euclidean distance on [Φ, width, length])
 *   Hardness     10%  (numerical proximity, 50 Shore A max range)
 *
 * 純函數、可重現、無外部依賴（只讀本地 CSV）。
 */

const fs = require('fs/promises');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_CSV = path.join(ROOT, 'data', 'historical_orders.csv');

// ─────────────────────────────────────────────────────────────
// CSV parse — 簡易版，10k 筆夠用、不引依賴
// ─────────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => {
    // 不處理 quoted commas — 我們的資料無 quote
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

// ─────────────────────────────────────────────────────────────
// Similarity primitives (與 Python 對等)
// ─────────────────────────────────────────────────────────────
function textSimilarity(a, b) {
  // difflib.SequenceMatcher 的 ratio() 近似——用 longest common subsequence 近似
  // 對短字串夠準
  a = (a || '').toLowerCase();
  b = (b || '').toLowerCase();
  if (a === b) return 1.0;
  if (!a || !b) return 0;

  // simple ratio: 2 * matches / (len(a) + len(b))
  const matches = lcsLength(a, b);
  return (2 * matches) / (a.length + b.length);
}

function lcsLength(a, b) {
  // O(n*m) but n,m are short ProductName strings — fine
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
  if (specA.length !== specB.length) {
    throw new Error('Spec arrays must have same length');
  }
  return Math.sqrt(specA.reduce((sum, x, i) => sum + (x - specB[i]) ** 2, 0));
}

function dateSimilarity(newDateStr, oldDateStr) {
  const newDate = new Date(newDateStr);
  const oldDate = new Date(oldDateStr);
  const dayDiff = Math.abs((newDate - oldDate) / (1000 * 60 * 60 * 24));
  const maxDays = 365 * 5;   // 5 年 cutoff
  if (dayDiff >= maxDays) return 0;
  return 1.0 - (dayDiff / maxDays);
}

// ─────────────────────────────────────────────────────────────
// Main scoring
// ─────────────────────────────────────────────────────────────
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

// ─────────────────────────────────────────────────────────────
// Skill entry point
// ─────────────────────────────────────────────────────────────
async function run({ new_order, k = 5, csv_path }) {
  const csvFile = csv_path
    ? (path.isAbsolute(csv_path) ? csv_path : path.join(ROOT, csv_path))
    : DEFAULT_CSV;

  const raw = await fs.readFile(csvFile, 'utf8');
  const orders = parseCSV(raw);

  // Normalize new_order.Spec
  const normalizedNew = {
    ...new_order,
    Spec: parseSpec(new_order.Spec)
  };

  // Score all (10k orders × ~1ms = ~10s worst case; 通常更快)
  const startedAt = Date.now();
  const scored = orders.map(order => ({
    order,
    score: computeSimilarityScore(normalizedNew, order)
  }));
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, k);
  const elapsedMs = Date.now() - startedAt;

  // 加權平均單價（用 score 當權重）—— 提供老闆做定價建議
  // 注意：historical_orders.csv 沒有 unit_price 欄位，這裡用 Quantity*Hardness 當 proxy
  // （demo 用；正式版要加 UnitPrice 欄）
  const weights = top.map(t => t.score);
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  let weightedAvgUnitPrice = null;
  if (top.some(t => t.order.UnitPrice)) {
    const sumWeighted = top.reduce(
      (s, t) => s + parseFloat(t.order.UnitPrice || 0) * t.score, 0
    );
    weightedAvgUnitPrice = Math.round(sumWeighted / totalWeight);
  }

  return {
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
}

module.exports = { run, computeSimilarityScore, textSimilarity };

// CLI test: node skills/get_history_quote/index.js
if (require.main === module) {
  run({
    new_order: {
      ProductName: 'Anti-Static Silicone Roller',
      OrderDate: '2026-05-25',
      Hardness: 55,
      Spec: '25*35*600'
    },
    k: 5
  })
    .then(r => {
      console.log('— Top 5 similar historical orders —');
      r.matches.forEach((m, i) => {
        console.log(`${i+1}. [${m.OrderDate}] OrderID ${m.OrderID} · ${m.ProductName} · H${m.Hardness} · ${m.Spec} · score ${m.score}`);
      });
      console.log(`\n• Scanned ${r._meta.historical_orders_scanned} orders in ${r._meta.elapsed_ms}ms`);
    })
    .catch(e => { console.error(e); process.exit(1); });
}
