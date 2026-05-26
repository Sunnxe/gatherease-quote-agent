#!/usr/bin/env node
/**
 * skills/generate_quote_pdf/impl.js
 *
 * 產生客戶報價單 PDF。用 PDFKit (純 JS, lazy install via cli.sh)。
 * NVIDIA green theme。輸出到 workspace/data/orders/<order_id>/quote-<order_id>.pdf
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

async function main() {
  const input = await readStdin();
  const {
    order_id,
    customer_name,
    customer_email,
    product_name,
    product_name_zh,
    qty,
    unit_price_twd,
    total_twd,
    lead_days,
    supplier_choice,
    terms,
    signed_by
  } = input;

  if (!order_id) throw new Error('order_id required');
  if (!customer_name) throw new Error('customer_name required');
  if (!product_name) throw new Error('product_name required');
  if (!Number.isFinite(qty) || qty <= 0) throw new Error('qty must be > 0');
  if (!Number.isFinite(unit_price_twd) || unit_price_twd <= 0) throw new Error('unit_price_twd must be > 0');

  // Node module resolution will walk up node_modules tree starting from SKILL_DIR
  const PDFDocument = require('pdfkit');

  const computedTotal = total_twd || (unit_price_twd * qty);

  const orderDir = path.join(WORKSPACE_DIR, 'data', 'orders', order_id);
  await fs.mkdir(orderDir, { recursive: true });
  const pdfPath = path.join(orderDir, `quote-${order_id}.pdf`);

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 50, bottom: 50, left: 50, right: 50 },
    info: {
      Title: `Quotation ${order_id}`,
      Author: 'GatherRoller (via GatherEase AI assistant)',
      Subject: `Quote for ${customer_name}`
    }
  });

  const stream = fsSync.createWriteStream(pdfPath);
  doc.pipe(stream);

  // ─── Header ───
  doc.fontSize(28).fillColor('#000').text('QUOTATION', { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor('#666')
     .text('GatherRoller', { align: 'center', continued: false });
  doc.fontSize(9).fillColor('#999')
     .text('Rubber Roller Specialist Since 1989', { align: 'center' });
  doc.moveDown(1.5);

  // NVIDIA green divider
  doc.strokeColor('#76B900').lineWidth(2)
     .moveTo(50, doc.y).lineTo(545, doc.y).stroke();
  doc.moveDown(1);

  // ─── Customer block ───
  doc.fontSize(11).fillColor('#000');
  const dateStr = new Date().toISOString().slice(0, 10);
  doc.text(`Order ID:`, { continued: true })
     .fillColor('#666').text(`  ${order_id}`).fillColor('#000');
  doc.text(`Date:`, { continued: true })
     .fillColor('#666').text(`  ${dateStr}`).fillColor('#000');
  doc.text(`Customer:`, { continued: true })
     .fillColor('#666').text(`  ${customer_name}`).fillColor('#000');
  doc.text(`Email:`, { continued: true })
     .fillColor('#666').text(`  ${customer_email || 'n/a'}`).fillColor('#000');
  doc.moveDown(1.5);

  // ─── Quote Details Table ───
  doc.fontSize(14).fillColor('#000').text('Quotation Details');
  doc.moveDown(0.5);

  // Table-like rows
  doc.fontSize(11);
  const startY = doc.y;
  const colX = { label: 60, value: 200 };
  const drawRow = (label, value, opts = {}) => {
    doc.fontSize(opts.size || 11)
       .fillColor(opts.color || '#555').text(label, colX.label, doc.y);
    doc.fillColor(opts.valueColor || '#000')
       .text(value, colX.value, doc.y - (opts.size || 11) - 2, { width: 350 });
    doc.moveDown(0.7);
  };
  drawRow('Product', product_name);
  if (product_name_zh && product_name_zh !== product_name) {
    drawRow('Product (中)', product_name_zh, { color: '#888' });
  }
  drawRow('Quantity', `${qty} units`);
  drawRow('Unit Price', fmtMoney(unit_price_twd));
  drawRow('Total Amount', fmtMoney(computedTotal),
          { size: 13, valueColor: '#76B900' });
  drawRow('Lead Time', `${lead_days || 14} days from confirmed order`);
  if (supplier_choice) drawRow('Surface Treatment', supplier_choice);
  doc.moveDown(1);

  // Divider
  doc.strokeColor('#DDD').lineWidth(1)
     .moveTo(50, doc.y).lineTo(545, doc.y).stroke();
  doc.moveDown(1);

  // ─── Terms & Conditions ───
  if (terms) {
    doc.fontSize(13).fillColor('#000').text('Terms & Conditions');
    doc.moveDown(0.4);
    doc.fontSize(10).fillColor('#444').text(terms, { lineGap: 3, width: 495 });
    doc.moveDown(1);
  }

  // ─── Signature ───
  doc.moveDown(1);
  doc.fontSize(11).fillColor('#000');
  if (signed_by) {
    doc.text(`Approved by: `, { continued: true })
       .fillColor('#76B900').text(signed_by).fillColor('#000');
    const sigTime = new Date().toLocaleString('zh-TW', {
      timeZone: 'Asia/Taipei',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit'
    });
    doc.text(`Signed at: `, { continued: true })
       .fillColor('#666').text(sigTime).fillColor('#000');
  }

  // ─── Footer ───
  doc.moveDown(3);
  doc.fontSize(9).fillColor('#999');
  doc.text(
    'This quotation was generated by GatherEase AI assistant',
    { align: 'center' }
  );
  doc.fontSize(8).text(
    'powered by NVIDIA Nemotron Super 120B + NemoClaw kernel-level governance · all actions audit-logged',
    { align: 'center' }
  );
  doc.moveDown(0.3);
  doc.fontSize(8).fillColor('#76B900').text(
    'GatherEase · 流程交給 AI，決策留給老闆',
    { align: 'center' }
  );

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
    pdf_size_bytes: stat.size,
    page_count: 1,
    generated_at: new Date().toISOString()
  }));
}

main().catch(err => {
  console.error(`[generate_quote_pdf] fatal: ${err.message}`);
  process.exit(1);
});
