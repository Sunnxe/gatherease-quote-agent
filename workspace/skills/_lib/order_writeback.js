/**
 * skills/_lib/order_writeback.js
 *
 * Shared helper：skill 算完拿 order_id 直接寫回 order JSON，不用回頭叫 agent
 * order_store update。徹底消滅 agent 手抄大 JSON 的爆點。
 *
 * 用法：
 *   const { writebackToOrder } = require('../_lib/order_writeback');
 *   await writebackToOrder({
 *     order_id: 'QUO-2026-0001',
 *     patch: { engineering_read: {...big_nested...}, status: 'analyzing' },
 *     audit: { level: 'INFO', msg: 'engineering read written', skill: 'read_drawing' }
 *   });
 *
 * 設計原則：
 *   - 失敗不丟，回 { ok: false, error: ... } 讓 caller 決定 (大多數 skill 用
 *     auto-writeback 算 bonus，主要功能不應該因為寫回失敗就 hard fail)
 *   - atomic write (rename) 避免 partial JSON 損壞 order
 *   - 完全 in-process — 不 spawn order_store cli.sh，零 IPC 開銷
 */

const fs = require('fs');
const path = require('path');

// 嘗試多個可能的 orders dir 路徑 (sandbox vs host vs custom)
const CANDIDATE_DIRS = [
  '/sandbox/.openclaw/workspace/data/orders',                          // sandbox
  path.resolve(__dirname, '..', '..', 'data', 'orders'),               // host workspace/data/orders
  path.resolve(__dirname, '..', '..', '..', 'workspace', 'data', 'orders')
];

function findOrdersDir() {
  for (const d of CANDIDATE_DIRS) {
    if (fs.existsSync(d)) return d;
  }
  // 預設第一個（sandbox），即使不存在 — 後面 read 會 fail 進 catch
  return CANDIDATE_DIRS[0];
}

function atomicWriteJSON(p, data) {
  const tmp = p + '.tmp.' + process.pid + '.' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

/**
 * 寫 patch 進 order，順便 append audit entry。
 *
 * @param {Object} opts
 * @param {string} opts.order_id     — 必填
 * @param {Object} opts.patch        — 要 merge 到 order top-level 的欄位（shallow merge）
 * @param {Object} [opts.audit]      — 要 append 到 audit_trail 的 entry（自動加 ts）
 * @returns {{ok: boolean, order_id?, fields_updated?, error?}}
 */
function writebackToOrder({ order_id, patch, audit }) {
  if (!order_id) return { ok: false, error: 'order_id required' };
  if (!patch || typeof patch !== 'object') return { ok: false, error: 'patch must be object' };

  try {
    const ordersDir = findOrdersDir();
    const p = path.join(ordersDir, `${order_id}.json`);
    if (!fs.existsSync(p)) {
      return { ok: false, error: `order not found: ${order_id} (dir=${ordersDir})` };
    }

    const order = JSON.parse(fs.readFileSync(p, 'utf8'));

    // shallow merge patch
    const updatedFields = [];
    for (const [k, v] of Object.entries(patch)) {
      order[k] = v;
      updatedFields.push(k);
    }

    // audit append
    if (audit) {
      if (!Array.isArray(order.audit_trail)) order.audit_trail = [];
      order.audit_trail.push({
        ts: new Date().toISOString(),
        ...audit
      });
      updatedFields.push('audit_trail');
    }

    order.updated_at = new Date().toISOString();
    atomicWriteJSON(p, order);

    return { ok: true, order_id, fields_updated: updatedFields };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { writebackToOrder, findOrdersDir };
