/**
 * skills/line_notify/index.js
 * Agent: system (跨 orchestrator HOLD 點)
 *
 * 把 HOLD 事件推 LINE 給老闆，等老闆點 flex message 按鈕、webhook 接到 postback → resolve。
 *
 * 使用流程：
 *   1. orchestrator.holdForBoss 呼叫 pushHoldToBoss({ holdId, gate, summary, options })
 *   2. 這支 skill 用 @line/bot-sdk push flex message 給 LINE_BOSS_USER_ID
 *   3. orchestrator await 這個 promise → 卡在這裡等老闆
 *   4. 老闆按按鈕 → LINE 送 postback 到我們的 webhook（webhook.js）
 *   5. webhook 拆解 postback data 拿到 holdId + choice
 *   6. webhook 呼叫 resolveHold(holdId, choice) → promise 解開、orchestrator 繼續
 *
 * Demo mode（LINE_CHANNEL_ACCESS_TOKEN 未設）：直接回 null，讓 orchestrator 走 mock
 */

let lineSdk = null;
function getLineSdk() {
  if (lineSdk) return lineSdk;
  try {
    lineSdk = require('@line/bot-sdk');
    return lineSdk;
  } catch {
    return null;
  }
}

let client = null;
function getClient() {
  if (client) return client;
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) return null;
  const sdk = getLineSdk();
  if (!sdk) {
    console.warn('[line_notify] @line/bot-sdk not installed. Run: npm install @line/bot-sdk');
    return null;
  }
  client = new sdk.Client({
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.LINE_CHANNEL_SECRET
  });
  return client;
}

// ─────────────────────────────────────────────────────────────
// Pending HOLDs: 用 holdId 對 webhook 回來的 postback 找到 orchestrator 的 await
// ─────────────────────────────────────────────────────────────
const pendingHolds = new Map();

const HOLD_TIMEOUT_MS = 5 * 60 * 1000;   // 5 分鐘老闆沒回 → reject

/**
 * 推 HOLD 給老闆、回 promise 等老闆按按鈕
 * @returns {Promise<{action: string, choice_index: number}>}
 */
async function pushHoldToBoss({ hold_id, gate, summary, options }) {
  const cli = getClient();
  if (!cli) {
    throw new Error('[line_notify] LINE not configured (set LINE_CHANNEL_ACCESS_TOKEN + LINE_BOSS_USER_ID in .env)');
  }
  const userId = process.env.LINE_BOSS_USER_ID;
  if (!userId) {
    throw new Error('[line_notify] LINE_BOSS_USER_ID not set. Add boss as friend, send any message, check webhook log for userId, put in .env.');
  }

  const flex = buildFlexMessage({ hold_id, gate, summary, options });

  await cli.pushMessage(userId, flex);
  console.log(`[line_notify] Pushed HOLD ${hold_id} (${gate}) to LINE user ${userId.slice(0, 8)}...`);

  return new Promise((resolve, reject) => {
    pendingHolds.set(hold_id, { resolve, reject, gate, options, pushedAt: Date.now() });
    setTimeout(() => {
      if (pendingHolds.has(hold_id)) {
        pendingHolds.delete(hold_id);
        reject(new Error(`HOLD ${hold_id} timeout after ${HOLD_TIMEOUT_MS / 60000} min — 老闆沒按按鈕`));
      }
    }, HOLD_TIMEOUT_MS);
  });
}

/**
 * Webhook 收到 postback 時呼叫，解 pending promise
 * @returns {boolean} 有 match 到 pending HOLD 才回 true
 */
function resolveHold(hold_id, choice_index, action_label) {
  const pending = pendingHolds.get(hold_id);
  if (!pending) {
    console.warn(`[line_notify] No pending HOLD matched ${hold_id} (already resolved or timed out?)`);
    return false;
  }
  pendingHolds.delete(hold_id);
  const elapsed = ((Date.now() - pending.pushedAt) / 1000).toFixed(1);
  console.log(`[line_notify] Resolved HOLD ${hold_id} → choice ${choice_index} "${action_label}" (after ${elapsed}s)`);
  pending.resolve({
    action: action_label || pending.options[choice_index] || `choice_${choice_index}`,
    choice_index,
    elapsed_seconds: Number(elapsed)
  });
  return true;
}

// ─────────────────────────────────────────────────────────────
// Build LINE Flex Message
// 設計：NVIDIA 綠主色、清楚的 HOLD gate 標題、按鈕對應 options 陣列
// ─────────────────────────────────────────────────────────────
function buildFlexMessage({ hold_id, gate, summary, options }) {
  const gateColorMap = {
    'gate-1-secret-probe':         { emoji: '🚨', color: '#FF3B3B', label: '套機密偵測' },
    'gate-pre-rfq':                { emoji: '📋', color: '#FFB020', label: '發詢價前確認' },
    'gate-2-tradeoff-decision':    { emoji: '⚖️',  color: '#FFB020', label: '多維權衡' },
    'gate-3-final-quote-signoff':  { emoji: '✍️',  color: '#76B900', label: '最終簽核' },
    'gate-4-blueprint-egress':     { emoji: '📐', color: '#FFB020', label: '圖面外送確認' }
  };
  const meta = gateColorMap[gate] || { emoji: '🛡️', color: '#76B900', label: gate };

  // 限制：LINE flex message altText 上限 400 字、summary 顯示有限制；safe 截斷
  const altText = `${meta.emoji} NemoClaw 守門・${meta.label} — ${summary.slice(0, 80)}`;
  const safeBody = summary.length > 380 ? summary.slice(0, 380) + '…' : summary;

  return {
    type: 'flex',
    altText,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: meta.color,
        paddingAll: '12px',
        contents: [
          { type: 'text', text: `${meta.emoji} NemoClaw 守門`, color: '#FFFFFF', size: 'xs', weight: 'bold' },
          { type: 'text', text: meta.label, color: '#FFFFFF', size: 'lg', weight: 'bold', margin: 'sm' }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '14px',
        contents: [
          {
            type: 'text',
            text: safeBody,
            wrap: true,
            size: 'sm',
            color: '#222222'
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: '10px',
        contents: options.map((label, i) => ({
          type: 'button',
          style: i === 0 ? 'primary' : (i === options.length - 1 ? 'link' : 'secondary'),
          color: i === 0 ? '#76B900' : undefined,
          height: 'sm',
          action: {
            type: 'postback',
            label,
            data: `hold_id=${encodeURIComponent(hold_id)}&choice=${i}&label=${encodeURIComponent(label)}`,
            displayText: `已選：${label}`
          }
        }))
      },
      styles: {
        header: { backgroundColor: meta.color },
        footer: { separator: true }
      }
    }
  };
}

module.exports = {
  pushHoldToBoss,
  resolveHold,
  getClient,
  buildFlexMessage,     // 暴露給 webhook + unit test
  _pendingHolds: pendingHolds   // 暴露給 webhook + 除錯
};

// CLI test：node skills/line_notify/index.js → push 一個 mock HOLD
if (require.main === module) {
  pushHoldToBoss({
    hold_id: `test-${Date.now()}`,
    gate: 'gate-2-tradeoff-decision',
    summary: '⚖️ 多維權衡測試訊息\n要壓進客戶 10 天 + 抗靜電認證：\n• 全鋼表處 $320 / 9 天 / ❌\n• 永鎵 $420 / 4 天 / ✅\n• 新鎏鍍 $370 / 7 天 / ❌\n→ 只有永鎵同時滿足',
    options: ['選永鎵（搶單）', '改選新鎏鍍 + 延 3 天', '取消']
  })
    .then(r => { console.log('Boss replied:', r); process.exit(0); })
    .catch(e => { console.error(e); process.exit(1); });
}
