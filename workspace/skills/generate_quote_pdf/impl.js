#!/usr/bin/env node
/**
 * skills/generate_quote_pdf/impl.js
 *
 * 產生客戶報價單 PDF：
 *   - PDFKit + Noto Sans TC 中文字型（lazy install @expo-google-fonts/noto-sans-tc）
 *   - Optional user_password 開檔密碼（agent 可帶 password 參數，預設 order_id 後 4 碼）
 *   - 固定 layout function (drawRow / drawSection)，不每次重寫
 *
 * 輸出: workspace/data/orders/<order_id>/quote-<order_id>.pdf
 */

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');

const SKILL_DIR = __dirname;
const WORKSPACE_DIR = path.resolve(SKILL_DIR, '..', '..');

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

function fmtMoney(n) {
  if (n == null) return '—';
  return 'NT$ ' + Math.round(n).toLocaleString('en-US');
}

// 找 Noto Sans TC .ttf path（@expo-google-fonts/noto-sans-tc 內含 .ttf）
function findCjkFontPath() {
  try {
    const pkg = require.resolve('@expo-google-fonts/noto-sans-tc/package.json');
    const dir = path.dirname(pkg);
    // 找 Regular 400 weight
    const candidates = ['NotoSansTC_400Regular.ttf', 'NotoSansTC_500Medium.ttf'];
    for (const c of candidates) {
      const p = path.join(dir, c);
      if (fsSync.existsSync(p)) return p;
    }
    // fallback：scan dir
    const files = fsSync.readdirSync(dir).filter(f => f.endsWith('.ttf'));
    if (files.length) return path.join(dir, files[0]);
  } catch {}
  return null;
}

function findCjkBoldPath() {
  try {
    const pkg = require.resolve('@expo-google-fonts/noto-sans-tc/package.json');
    const dir = path.dirname(pkg);
    for (const c of ['NotoSansTC_700Bold.ttf', 'NotoSansTC_500Medium.ttf']) {
      const p = path.join(dir, c);
      if (fsSync.existsSync(p)) return p;
    }
  } catch {}
  return null;
}

async function main() {
  const input = await readStdin();
  const {
    order_id,
    customer_name,
    customer_email,
    product_name,
    qty,
    unit_price_twd,
    total_twd,
    lead_days,
    supplier_choice,
    terms,
    signed_by,
    user_password   // optional: 客戶開檔密碼
  } = input;

  if (!order_id) throw new Error('order_id required');
  if (!customer_name) throw new Error('customer_name required');
  if (!product_name) throw new Error('product_name required');
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('qty must be > 0');
  if (!Number.isFinite(unit_price_twd) || unit_price_twd <= 0) throw new Error('unit_price_twd must be > 0');

  const PDFDocument = require('pdfkit');

  const computedTotal = total_twd || (unit_price_twd * qty);
  const orderDir = path.join(WORKSPACE_DIR, 'data', 'orders', order_id);
  await fs.mkdir(orderDir, { recursive: true });
  const pdfPath = path.join(orderDir, `quote-${order_id}.pdf`);

  // ─── CJK 字型 ───
  const cjkRegular = findCjkFontPath();
  const cjkBold = findCjkBoldPath() || cjkRegular;
  if (!cjkRegular) {
    console.error('[generate_quote_pdf] ⚠️ Noto Sans TC 字型沒裝，中文會亂碼。請 cli.sh 先 lazy install @expo-google-fonts/noto-sans-tc');
  }

  // ─── PDF 加密 ───
  // 預設密碼用 order_id 後 4 碼（QUO-2026-0001 → "0001"）— agent 可在 user_password 覆寫
  const pwd = user_password || (order_id.match(/\d{4}$/) ? order_id.match(/\d{4}$/)[0] : null);
  const pdfOpts = {
    size: 'A4',
    margins: { top: 56, bottom: 60, left: 56, right: 56 },
    info: {
      Title: `報價單 ${order_id}`,
      Author: 'GatherRoller (via GatherEase AI assistant)',
      Subject: `Quote for ${customer_name}`
    }
  };
  if (pwd) {
    pdfOpts.userPassword = pwd;
    pdfOpts.permissions = { printing: 'highResolution', modifying: false, copying: false, annotating: false };
  }

  const doc = new PDFDocument(pdfOpts);
  if (cjkRegular) {
    doc.registerFont('CJK', cjkRegular);
    doc.registerFont('CJK-Bold', cjkBold);
    doc.font('CJK');
  }

  const stream = fsSync.createWriteStream(pdfPath);
  doc.pipe(stream);

  // ─── helpers (reusable layout, 不每次重寫) ───
  const NV_GREEN = '#76B900';
  const setFont = (variant, size, color) => {
    doc.font(variant === 'bold' ? 'CJK-Bold' : 'CJK')
       .fontSize(size).fillColor(color || '#1a1a1a');
  };
  const hr = (color = '#eee', width = 1) => {
    doc.strokeColor(color).lineWidth(width)
       .moveTo(56, doc.y).lineTo(539, doc.y).stroke();
    doc.moveDown(0.5);
  };
  const drawRow = (label, value, opts = {}) => {
    const y = doc.y;
    setFont('regular', opts.size || 11, '#666');
    doc.text(label, 60, y, { width: 130 });
    setFont(opts.bold ? 'bold' : 'regular', opts.size || 11, opts.valueColor || '#1a1a1a');
    doc.text(value, 200, y, { width: 320 });
    doc.moveDown(0.5);
  };

  // ─── Header ───
  setFont('bold', 26, '#1a1a1a');
  doc.text('報 價 單', { align: 'center', characterSpacing: 4 });
  setFont('regular', 11, '#666');
  doc.text('QUOTATION · Rubber Roller Specialist Since 1989', { align: 'center' });
  doc.moveDown(0.5);
  doc.strokeColor(NV_GREEN).lineWidth(3)
     .moveTo(56, doc.y).lineTo(539, doc.y).stroke();
  doc.moveDown(1.2);

  // ─── Meta block ───
  setFont('regular', 11, '#1a1a1a');
  drawRow('單號', order_id);
  drawRow('日期', new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' }));
  drawRow('客戶', customer_name);
  drawRow('聯絡 Email', customer_email || '—');
  doc.moveDown(1);

  // ─── Quote details ───
  setFont('bold', 14, NV_GREEN);
  doc.text('報價明細');
  doc.moveDown(0.3);
  hr('#eee', 1);

  drawRow('產品', product_name);
  drawRow('數量', `${qty} 隻`);
  drawRow('單價', `${fmtMoney(unit_price_twd)} / 隻`);
  drawRow('總金額', fmtMoney(computedTotal), { bold: true, size: 13, valueColor: NV_GREEN });
  drawRow('交期', `${lead_days || 14} 個工作天（自確認訂單起算）`);
  if (supplier_choice) drawRow('表面處理供應商', supplier_choice);
  doc.moveDown(1.5);

  // ─── Terms ───
  if (terms) {
    setFont('bold', 13, NV_GREEN);
    doc.text('付款條件');
    doc.moveDown(0.3);
    hr('#eee', 1);
    setFont('regular', 11, '#444');
    doc.text(terms, 60, doc.y, { width: 480, lineGap: 4 });
    doc.moveDown(1);
  }

  // ─── Signature ───
  doc.moveDown(0.5);
  doc.strokeColor('#ccc').dash(3, { space: 3 })
     .moveTo(56, doc.y).lineTo(539, doc.y).stroke().undash();
  doc.moveDown(0.5);
  setFont('regular', 11, '#1a1a1a');
  if (signed_by) {
    const y1 = doc.y;
    setFont('regular', 11, '#666');
    doc.text('簽核人', 60, y1, { width: 130 });
    setFont('bold', 13, NV_GREEN);
    doc.text(signed_by, 200, y1, { width: 320 });
    doc.moveDown(0.5);
  }
  const sigTime = new Date().toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit'
  });
  const y2 = doc.y;
  setFont('regular', 11, '#666');
  doc.text('簽核時間', 60, y2, { width: 130 });
  setFont('regular', 11, '#444');
  doc.text(sigTime, 200, y2, { width: 320 });
  doc.moveDown(2);

  // ─── Footer ───
  setFont('regular', 9, '#999');
  doc.text('本報價單由 GatherEase AI assistant 自動生成', { align: 'center' });
  setFont('regular', 8, '#aaa');
  doc.text('Powered by NVIDIA Nemotron Super 120B + NemoClaw kernel-level governance · all actions audit-logged', { align: 'center' });
  doc.moveDown(0.3);
  setFont('bold', 9, NV_GREEN);
  doc.text('GatherEase · 流程交給 AI，決策留給老闆', { align: 'center' });

  doc.end();
  await new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  const stat = await fs.stat(pdfPath);

  process.stdout.write(JSON.stringify({
    status: 'generated',
    order_id,
    pdf_path: pdfPath,
    output_format: 'pdf',
    size_bytes: stat.size,
    cjk_font_used: !!cjkRegular,
    password_protected: !!pwd,
    user_password_hint: pwd ? `(${pwd.length} chars, agent 應告知客戶)` : null,
    generated_at: new Date().toISOString()
  }));
}

main().catch(err => {
  console.error(`[generate_quote_pdf] fatal: ${err.message}`);
  process.exit(1);
});
