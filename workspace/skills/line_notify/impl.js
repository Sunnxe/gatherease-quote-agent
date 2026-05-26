#!/usr/bin/env node
/**
 * skills/line_notify/impl.js (OpenClaw skill version)
 *
 * 推 flex message 到廖老闆 LINE，**立刻 return** (不阻塞等回覆)。
 * 老闆按按鈕後的 webhook → openclaw agent -m 注入新 user message，
 * agent 看到才繼續。
 *
 * 用 Node 22 內建 fetch (不依賴 @line/bot-sdk —— sandbox 內可能沒裝)。
 */

const fs = require('fs/promises');
const path = require('path');

const SKILL_DIR = __dirname;
const PENDING_DIR = path.join(SKILL_DIR, 'pending');

const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push';

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

// ─── Flex message builder (跟舊版一致，NVIDIA 綠主色) ───
function buildFlexMessage({ hold_id, gate, summary, options }) {
  const gateColorMap = {
    'gate-1-secret-probe':         { emoji: '🚨', color: '#FF3B3B', label: '套機密偵測' },
    'gate-pre-rfq':                { emoji: '📋', color: '#FFB020', label: '發詢價前確認' },
    'gate-2-tradeoff-decision':    { emoji: '⚖️',  color: '#FFB020', label: '多維權衡' },
    'gate-3-final-quote-signoff':  { emoji: '✍️',  color: '#76B900', label: '最終簽核' },
    'gate-4-blueprint-egress':     { emoji: '📐', color: '#FFB020', label: '圖面外送確認' }
  };
  const meta = gateColorMap[gate] || { emoji: '🛡️', color: '#76B900', label: gate };

  const altText = `${meta.emoji} NemoClaw 守門・${meta.label} — ${(summary || '').slice(0, 80)}`;
  const safeBody = (summary || '').length > 380 ? summary.slice(0, 380) + '…' : (summary || '');

  return {
    type: 'flex',
    altText,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box', layout: 'vertical',
        backgroundColor: meta.color, paddingAll: '12px',
        contents: [
          { type: 'text', text: `${meta.emoji} NemoClaw 守門`, color: '#FFFFFF', size: 'xs', weight: 'bold' },
          { type: 'text', text: meta.label, color: '#FFFFFF', size: 'lg', weight: 'bold', margin: 'sm' }
        ]
      },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '14px',
        contents: [
          { type: 'text', text: safeBody, wrap: true, size: 'sm', color: '#222222' }
        ]
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '10px',
        contents: (options || []).map((label, i) => ({
          type: 'button',
          style: i === 0 ? 'primary' : (i === (options.length - 1) ? 'link' : 'secondary'),
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
      styles: { header: { backgroundColor: meta.color }, footer: { separator: true } }
    }
  };
}

// ─── Push via LINE Messaging API (native fetch, 不用 @line/bot-sdk) ───
async function pushToLINE({ userId, accessToken, flex }) {
  const resp = await fetch(LINE_PUSH_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      to: userId,
      messages: [flex],
      notificationDisabled: false
    })
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '(no body)');
    throw new Error(`LINE push failed: HTTP ${resp.status} — ${body.slice(0, 200)}`);
  }
}

// ─── main ───
async function main() {
  const input = await readStdin();
  const { hold_id, gate, summary, options, order_id, extra } = input;

  if (!hold_id) throw new Error('hold_id required');
  if (!gate) throw new Error('gate required');
  if (!summary) throw new Error('summary required');
  if (!Array.isArray(options) || options.length === 0) throw new Error('options must be non-empty array');

  const userId = process.env.LINE_BOSS_USER_ID;
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!userId) throw new Error('LINE_BOSS_USER_ID env var not set');
  if (!token) throw new Error('LINE_CHANNEL_ACCESS_TOKEN env var not set');

  // 寫 pending file (host webhook server 收到 postback 後可查、注入 agent)
  // extra 欄位給 agent 塞 callback 時要 lookup 的 context（譬如 gate-2 的 ranked_supplier_ids）
  await fs.mkdir(PENDING_DIR, { recursive: true });
  const pendingPath = path.join(PENDING_DIR, `${hold_id}.json`);
  await fs.writeFile(pendingPath, JSON.stringify({
    hold_id, gate, summary, options,
    order_id: order_id || null,
    extra: extra || {},
    pushed_at: new Date().toISOString()
  }, null, 2));

  // Push to LINE
  const flex = buildFlexMessage({ hold_id, gate, summary, options });
  await pushToLINE({ userId, accessToken: token, flex });

  process.stdout.write(JSON.stringify({
    status: 'pushed',
    hold_id,
    gate,
    pushed_to_userid: userId.slice(0, 8) + '...',
    pushed_at: new Date().toISOString(),
    options_count: options.length,
    pending_file: pendingPath,
    waiting_for: `boss to tap a button on LINE flex message. Agent should wait for next user message "老闆已決定 hold_id=${hold_id} choice=N action=..." injected via webhook → openclaw agent -m`
  }));
}

main().catch(err => {
  console.error(`[line_notify] fatal: ${err.message}`);
  process.exit(1);
});
