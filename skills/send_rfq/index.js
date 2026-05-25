/**
 * skills/send_rfq/index.js
 * Agent: quote (報價主)
 * Category: OUTPUT — 對外、不可逆、需 NemoClaw 守門
 *
 * 發詢價信給代工廠，含工程圖 PDF 附件。
 *
 * NemoClaw 守門：
 *   gate-4-blueprint-egress：傳送圖面前，必須先比對 supplier 白名單。
 *   demo 中此 skill 被呼叫時，NemoClaw 會 HOLD 並推 LINE 給老闆確認。
 *
 * Demo 模式：未設 GMAIL_APP_PASSWORD → mock 寄出（log 一行）。
 * Real 模式：用 nodemailer + Gmail SMTP 真寄。
 */

const fs = require('fs/promises');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const SUPPLIERS_PATH = path.join(ROOT, 'data', 'suppliers.json');
const AUDIT_LOG = path.join(ROOT, 'logs', 'audit.jsonl');

async function load(p) { return JSON.parse(await fs.readFile(p, 'utf8')); }

async function auditAppend(entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
  await fs.appendFile(AUDIT_LOG, line);
}

function buildEmailBody({ product_id, qty, desired_lead_time_days, customer_reference, supplier_name }) {
  return `${supplier_name} 您好，

GatherEase / 桐聚科技 在此向貴司詢價：

  產品：${product_id}（包膠鐵輪 150×30）
  數量：${qty} 支
  期望交期：${desired_lead_time_days} 天內（自確認單日起）
  客戶參考：${customer_reference || 'N/A'}

請見附件工程圖（GatherEase.ai 圖框）。煩請於 2 個工作天內回覆：
  1. 單價（TWD / 支）
  2. 最快可交天數
  3. 是否包含抗靜電認證（如適用）

—
桐聚科技 / GatherEase
（由 AI 報價助手代發，最終報價由人簽核）`;
}

async function sendOneSupplier(supplier, payload, drawingPdfPath) {
  // ─── Real mode: nodemailer + SMTP ───
  if (process.env.GMAIL_APP_PASSWORD && process.env.NODE_ENV !== 'test') {
    let nodemailer;
    try { nodemailer = require('nodemailer'); }
    catch { throw new Error('nodemailer not installed. Run: npm install nodemailer'); }

    const transport = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
    });

    const info = await transport.sendMail({
      from: `"桐聚科技 AI 報價助手" <${process.env.GMAIL_USER}>`,
      to: supplier.contact.email,
      subject: `【詢價】${payload.product_id} × ${payload.qty} 支 / 期望 ${payload.desired_lead_time_days} 天`,
      text: buildEmailBody({ ...payload, supplier_name: supplier.name }),
      attachments: [{ filename: 'drawing.pdf', path: drawingPdfPath }]
    });

    return { supplier_id: supplier.id, message_id: info.messageId, sent_at: new Date().toISOString(), mode: 'real' };
  }

  // ─── Demo / mock mode ───
  return {
    supplier_id: supplier.id,
    message_id: `mock-${Date.now()}-${supplier.id}`,
    sent_at: new Date().toISOString(),
    mode: 'mock',
    recipient: supplier.contact.email,
    preview: buildEmailBody({ ...payload, supplier_name: supplier.name }).slice(0, 240) + '…'
  };
}

async function run({ supplier_ids, product_id, qty, desired_lead_time_days, drawing_pdf_path, customer_reference }) {
  const { suppliers } = await load(SUPPLIERS_PATH);
  const matched = supplier_ids.map(id => suppliers.find(s => s.id === id)).filter(Boolean);

  if (matched.length === 0) {
    throw new Error('No matching suppliers found for supplier_ids');
  }

  // ─── NemoClaw 守門呼叫點（real 模式由 sandbox runtime 攔截）───
  // demo 模式：在 audit log 寫一行 HOLD，由 orchestrator 推 LINE 給老闆確認
  await auditAppend({
    level: 'HOLD',
    gate: 'gate-4-blueprint-egress',
    skill: 'send_rfq',
    msg: `準備寄詢價＋圖面給 ${matched.length} 家代工廠`,
    suppliers: matched.map(s => ({ id: s.id, name: s.name, email: s.contact.email }))
  });

  const payload = { product_id, qty, desired_lead_time_days, customer_reference };
  const sent = [];
  for (const sup of matched) {
    const result = await sendOneSupplier(sup, payload, drawing_pdf_path);
    sent.push(result);
    await auditAppend({ level: 'ALLOW', skill: 'send_rfq', action: 'sent', ...result });
  }

  return {
    sent,
    blocked_by_guardrail: [],
    _meta: {
      skill: 'send_rfq',
      agent: 'quote',
      mode: process.env.GMAIL_APP_PASSWORD ? 'real' : 'mock',
      finished_at: new Date().toISOString()
    }
  };
}

module.exports = { run };

// CLI test: node skills/send_rfq/index.js
if (require.main === module) {
  run({
    supplier_ids: ['SUP-001', 'SUP-002', 'SUP-003'],
    product_id: 'RW-PU-150-30',
    qty: 200,
    desired_lead_time_days: 10,
    drawing_pdf_path: '/tmp/dummy-drawing.pdf',
    customer_reference: 'CUST-001 / 鴻碩'
  })
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch(e => { console.error(e); process.exit(1); });
}
