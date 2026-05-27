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
const fsSync = require('fs');
const path = require('path');

const SKILL_DIR = __dirname;
const PENDING_DIR = path.join(SKILL_DIR, 'pending');
const ORDERS_DIR = '/sandbox/.openclaw/workspace/data/orders';
const SUPPLIERS_FILE = '/sandbox/.openclaw/workspace/data/suppliers.json';

const LINE_PUSH_URL = 'https://api.line.me/v2/bot/message/push';

// ─── 自動從 order JSON 構 summary（避免 agent 自己組搞錯數字 / 格式 / 廠商名）───
function buildSummaryFromOrder(orderId, gate) {
  try {
    const orderPath = path.join(ORDERS_DIR, `${orderId}.json`);
    if (!fsSync.existsSync(orderPath)) return null;
    const order = JSON.parse(fsSync.readFileSync(orderPath, 'utf8'));
    const er = order.engineering_read || {};
    const cb = order.cost_baseline || {};
    const sc = order.schedule_check || {};
    const customer = order.customer || {};

    // 數量 — 優先從 cost_baseline 拿 (真實算出來的)；fallback engineering_read
    const qty = cb.qty || sc.qty || 500;
    const unitPrice = cb.suggested_unit_price_twd;
    const totalRevenue = cb.suggested_revenue_twd || (unitPrice ? unitPrice * qty : null);

    if (gate === 'gate-pre-rfq') {
      // 載入 3 家代工廠資料
      let suppliers = [];
      try {
        const s = JSON.parse(fsSync.readFileSync(SUPPLIERS_FILE, 'utf8'));
        suppliers = (s.suppliers || []).filter(x => x.category === 'surface-treatment-vendor');
      } catch {}
      const supplierList = suppliers.map(s => `· ${s.name}（${s.contact?.name || ''}）${s.contact?.email || ''}`).join('\n');

      // 鐵輪規格 — 從 engineering_read 抓
      const specs = er.specs || {};
      const wheelSpec = specs.shaft_total_length_mm
        ? `S45C 碳鋼 · 外徑 ${specs.outer_diameter_mm}mm × 長 ${specs.shaft_total_length_mm}mm`
        : '鐵輪規格從圖紙';
      const antiStatic = er.quality_requirements?.anti_static_required;

      const lines = [
        `📋 詢價單彙整 · 表面處理外發`,
        ``,
        `[訂單摘要]`,
        `客戶：${customer.name || '-'}`,
        `產品：${er.product_name_zh || er.product_id || '-'}`,
        `數量：${qty} 隻`,
        `建議單價：NT$ ${unitPrice ? unitPrice.toLocaleString() : '-'}`,
        `總價：NT$ ${totalRevenue ? totalRevenue.toLocaleString() : '-'}`,
        `最快交期：${sc.total_lead_time_days || '-'} 天（客戶要 ${sc.customer_desired_lead_days || '-'} 天${sc.achievable ? '、達標' : ''}）`,
        ``,
        `[要外發什麼處理]`,
        `🔧 鐵輪表面處理 × ${qty} 隻`,
        `· 鐵輪本體：${wheelSpec}`,
        `· 處理項目：去銳角、毛邊${antiStatic ? '、需 ESD 導電基底' : ''}`,
        `· 桐聚後段自家做：矽膠包覆${antiStatic ? '（含 ESD 抗靜電配方）' : ''} + 組裝 + QC`,
        ``,
        `[將發 RFQ 給 3 家表面處理代工廠]`,
        supplierList || '（讀 suppliers.json 失敗）',
        ``,
        `老闆確認後寄出？`
      ];
      return lines.join('\n');
    }

    if (gate === 'gate-2-tradeoff-decision') {
      const cmp = order.comparison || {};
      const lines = [
        `⚖️ 多維權衡`,
        ``,
        cmp.recommendation?.headline || 'AI 推薦中...',
        `理由：${cmp.recommendation?.one_liner || '-'}`,
        ``,
        `完整對比：`,
        cmp.trade_off_table || '-',
      ];
      const strat = cmp.strategies?.[0];
      if (strat) {
        lines.push('', strat.headline || '', strat.rationale?.split('\n').slice(0, 4).join('\n') || '');
      }
      return lines.join('\n');
    }

    if (gate === 'gate-3-final-quote-signoff') {
      const finalCost = order.final_cost || cb;
      const supplier = finalCost.surface_treatment_supplier_used;
      const lines = [
        `✍️ 最終報價簽核`,
        ``,
        `客戶：${customer.name || '-'}`,
        `產品：${er.product_name_zh || '-'}`,
        `數量：${qty} 隻`,
        `單價：NT$ ${finalCost.suggested_unit_price_twd?.toLocaleString() || '-'}`,
        `總價：NT$ ${finalCost.suggested_revenue_twd?.toLocaleString() || '-'}`,
        `表面處理：${supplier?.name || '-'}（單件加工費 NT$ ${supplier?.unit_price_twd || '-'}）`,
        `毛利率：${finalCost.markup_pct_applied || '-'}%`,
        ``,
        `簽核並寄出報價單給客戶？`
      ];
      return lines.join('\n');
    }
    return null;
  } catch (e) {
    return null;
  }
}

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
  // LINE flex text 上限約 2000 字、實際裝得進 ~1500 看得舒服。
  const safeBody = (summary || '').length > 1500 ? summary.slice(0, 1500) + '…' : (summary || '');

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
  let { hold_id, gate, summary, options, order_id, extra } = input;

  if (!gate) throw new Error('gate required');
  if (!Array.isArray(options) || options.length === 0) throw new Error('options must be non-empty array');

  // 自動從 order JSON 構 rich summary（避免 agent 漏欄位 / format 出包）
  // 規則：有 order_id → 一律用 buildSummaryFromOrder()；agent 傳的 summary 只當 fallback
  if (order_id) {
    const auto = buildSummaryFromOrder(order_id, gate);
    if (auto) {
      summary = auto;   // ← 強制覆蓋 agent 的 summary，保證資料對、格式對
    }
  }

  if (!summary) throw new Error('summary required (沒提供 order_id 也沒給 summary)');

  // 防呆：agent 在 printf 單引號內常常寫成 \\n（literal backslash+n），LINE 會顯示「\n」字面。
  // 強制把字面 \n / \t 轉成真換行 / tab；不影響本來就用真換行的 caller。
  if (typeof summary === 'string') {
    summary = summary.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  }
  // options 也順便清一次
  options = options.map(o => typeof o === 'string' ? o.replace(/\\n/g, '\n').replace(/\\t/g, '\t') : o);

  // 自動生成 hold_id（agent 不用自己想一個）
  // 規則：有 order_id → `${gate}-${order_id}` （同訂單同 gate 推一次就好）
  //       沒 order_id → timestamp + random suffix（unique）
  if (!hold_id) {
    if (order_id) {
      hold_id = `${gate}-${order_id}`;
    } else {
      hold_id = `${gate}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }
    console.error(`[line_notify] hold_id 沒帶、自動生成為 "${hold_id}"`);
  }

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
