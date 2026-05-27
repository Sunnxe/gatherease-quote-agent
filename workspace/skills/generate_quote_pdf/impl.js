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
const { writebackToOrder, findOrdersDir } = require('../_lib/order_writeback');

const SKILL_DIR = __dirname;
const WORKSPACE_DIR = path.resolve(SKILL_DIR, '..', '..');

// 從 order JSON 自動拉產生 PDF 需要的欄位（agent 只要帶 order_id 就好）
function loadOrderForPdf(orderId) {
  try {
    const p = path.join(findOrdersDir(), `${orderId}.json`);
    if (!fsSync.existsSync(p)) return null;
    const order = JSON.parse(fsSync.readFileSync(p, 'utf8'));
    const cb = order.cost_baseline || order.final_cost || {};
    const er = order.engineering_read || {};
    const sc = order.schedule_check || {};
    const cmp = order.comparison || {};
    // 找老闆選的 supplier 名稱（從 comparison 或 audit_trail）
    let supplierName = null;
    const stsAudit = (order.audit_trail || []).filter(a => a.gate === 'gate-2-tradeoff-decision' || a.chosen_supplier_id).slice(-1)[0];
    if (stsAudit?.chosen_supplier_id && cmp?.ranked) {
      const found = cmp.ranked.find(r => r.supplier_id === stsAudit.chosen_supplier_id);
      if (found) supplierName = found.name;
    }
    if (!supplierName) supplierName = cmp?.recommendation?.name || null;

    // ⚡ 老闆 LINE 簽核時打字改價、優先用那個數字
    // 三個來源優先序：
    // 1. order.manual_override_unit_price_twd（agent 顯式設的、最高優先）
    // 2. audit_trail 最近一筆 gate-3 decision 有 unit_price_twd（agent 漏寫 manual_override 也救得回來）
    // 3. cost_baseline.suggested_unit_price_twd（calc_cost 算的、AI 數字）
    const qty = cb.qty || sc.qty || null;
    let override = order.manual_override_unit_price_twd;
    let overrideSource = 'manual_override_unit_price_twd';
    if (!Number.isFinite(override) || override <= 0) {
      // fallback：掃 audit_trail 找 gate-3 + unit_price_twd
      const trail = order.audit_trail || [];
      for (let i = trail.length - 1; i >= 0; i--) {
        const a = trail[i];
        if (a.gate === 'gate-3-final-quote-signoff' && Number.isFinite(a.unit_price_twd) && a.unit_price_twd > 0) {
          override = a.unit_price_twd;
          overrideSource = 'audit_trail gate-3';
          break;
        }
      }
    }
    const computedPrice = cb.suggested_unit_price_twd || null;
    const finalUnit = (Number.isFinite(override) && override > 0) ? override : computedPrice;
    const finalTotal = (finalUnit && qty) ? finalUnit * qty : (cb.suggested_revenue_twd || null);

    return {
      customer_name:  order.customer?.name || null,
      customer_email: order.customer?.email || order.customer?.contact_email || null,
      product_name:   er.product_name_zh || er.product_id || null,
      qty,
      unit_price_twd:  finalUnit,
      total_twd:       finalTotal,
      lead_days:       sc.total_lead_time_days || null,
      supplier_choice: supplierName,
      // 給 audit trail 看的：用的是老闆 override 還是 AI 算的
      _price_source:   (Number.isFinite(override) && override > 0)
        ? `boss_override · ${overrideSource} (NT$${override})`
        : `auto_calc (calc_cost NT$${computedPrice})`
    };
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

function fmtMoney(n) {
  if (n == null) return '—';
  return 'NT$ ' + Math.round(n).toLocaleString('en-US');
}

// 找 Noto Sans CJK TC font path — 優先用 workspace/data/fonts/ (install-cjk-font.sh 寫進去)
// 次選 npm package @expo-google-fonts/noto-sans-tc/*.ttf
const WORKSPACE_FONT_DIR = path.join(WORKSPACE_DIR, 'data', 'fonts');
const NOTO_PKG_DIR = path.join(SKILL_DIR, 'node_modules', '@expo-google-fonts', 'noto-sans-tc');

function findCjkFontPath() {
  // 優先：workspace/data/fonts/ 內 (install-cjk-font.sh 一次性寫的，確定 work)
  const workspaceCandidates = [
    'NotoSansCJKtc-Regular.otf',
    'NotoSansTC-Regular.ttf',
    'NotoSansTC_400Regular.ttf'
  ];
  for (const c of workspaceCandidates) {
    const p = path.join(WORKSPACE_FONT_DIR, c);
    if (fsSync.existsSync(p)) return p;
  }
  // 次選：@expo-google-fonts npm package (如果 npm install 真的 bundle .ttf)
  for (const c of ['NotoSansTC_400Regular.ttf', 'NotoSansTC_500Medium.ttf']) {
    const p = path.join(NOTO_PKG_DIR, c);
    if (fsSync.existsSync(p)) return p;
  }
  // 最後 fallback：scan npm dir 任何 .ttf
  try {
    const files = fsSync.readdirSync(NOTO_PKG_DIR).filter(f => f.endsWith('.ttf'));
    if (files.length) return path.join(NOTO_PKG_DIR, files[0]);
  } catch {}
  return null;
}

function findCjkBoldPath() {
  const workspaceCandidates = [
    'NotoSansCJKtc-Bold.otf',
    'NotoSansCJKtc-Medium.otf',
    'NotoSansCJKtc-Regular.otf',  // 沒 bold 就回 Regular
    'NotoSansTC_700Bold.ttf'
  ];
  for (const c of workspaceCandidates) {
    const p = path.join(WORKSPACE_FONT_DIR, c);
    if (fsSync.existsSync(p)) return p;
  }
  for (const c of ['NotoSansTC_700Bold.ttf', 'NotoSansTC_500Medium.ttf']) {
    const p = path.join(NOTO_PKG_DIR, c);
    if (fsSync.existsSync(p)) return p;
  }
  return null;
}

async function main() {
  const input = await readStdin();
  let {
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

  // 自動從 order 拉欄位（agent 只要帶 order_id）— 沒帶才從 order 補
  const fromOrder = loadOrderForPdf(order_id) || {};
  if (!customer_name)  customer_name  = fromOrder.customer_name;
  if (!customer_email) customer_email = fromOrder.customer_email;
  if (!product_name)   product_name   = fromOrder.product_name;
  if (!qty)            qty            = fromOrder.qty;
  if (!unit_price_twd) unit_price_twd = fromOrder.unit_price_twd;
  if (!total_twd)      total_twd      = fromOrder.total_twd;
  if (!lead_days)      lead_days      = fromOrder.lead_days;
  if (!supplier_choice) supplier_choice = fromOrder.supplier_choice;
  const priceSource = fromOrder._price_source;   // 留給 audit trail

  if (!customer_name) throw new Error('customer_name required (order 沒帶 customer.name、agent 也沒給)');
  if (!product_name)  throw new Error('product_name required (order 沒 read_drawing 結果、agent 也沒給)');
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('qty must be > 0 (order 沒 cost_baseline.qty、agent 也沒給)');
  if (!Number.isFinite(unit_price_twd) || unit_price_twd <= 0) throw new Error('unit_price_twd must be > 0 (order 沒 cost_baseline.suggested_unit_price、agent 也沒給)');

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
    // 如果 CJK font 沒裝起來，fallback to default Helvetica (中文亂碼但不 fatal)
    if (cjkRegular) {
      doc.font(variant === 'bold' ? 'CJK-Bold' : 'CJK');
    } else {
      doc.font(variant === 'bold' ? 'Helvetica-Bold' : 'Helvetica');
    }
    doc.fontSize(size).fillColor(color || '#1a1a1a');
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

  // Auto-writeback：把 final_quote_pdf_path 寫進 order
  const writebackResult = writebackToOrder({
    order_id,
    patch: {
      final_quote_pdf_path: pdfPath,
      final_cost: {
        qty,
        suggested_unit_price_twd: unit_price_twd,
        suggested_revenue_twd: total_twd || (unit_price_twd * qty),
        supplier_choice
      },
      status: 'awaiting_email_to_customer'
    },
    audit: {
      level: 'INFO',
      msg: `quote PDF generated: ${path.basename(pdfPath)} · unit NT$${unit_price_twd}`,
      skill: 'generate_quote_pdf',
      pdf_size: stat.size,
      password_protected: !!pwd,
      unit_price_twd,
      price_source: priceSource || 'agent_param'   // boss_override / auto_calc / agent_param
    }
  });

  process.stdout.write(JSON.stringify({
    status: 'generated',
    order_id,
    writeback: writebackResult,
    pdf_path: pdfPath,
    output_format: 'pdf',
    size_bytes: stat.size,
    cjk_font_used: !!cjkRegular,
    password_protected: !!pwd,
    user_password_hint: pwd ? `開檔密碼 = order_id 後 4 碼` : null,
    next_step: '請 call send_email to customer_email 並 attach 此 PDF；寄完 status 會自動變 quote_sent',
    generated_at: new Date().toISOString()
  }));
}

main().catch(err => {
  console.error(`[generate_quote_pdf] fatal: ${err.message}`);
  process.exit(1);
});
