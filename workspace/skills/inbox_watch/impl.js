#!/usr/bin/env node
/**
 * skills/inbox_watch/impl.js
 *
 * 連 imap.gmail.com:993 抓未讀信，解析 MIME 抓 PDF 附件，pdf-parse 抽文字，
 * regex heuristic 抓單價/交期/認證。
 *
 * NemoClaw gmail-imap.yaml egress preset 允許 imap.gmail.com:993。
 */

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');

const SKILL_DIR = __dirname;
const WORKSPACE_DIR = path.resolve(SKILL_DIR, '..', '..');
const SUPPLIERS_JSON = path.join(WORKSPACE_DIR, 'data', 'suppliers.json');

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
// pdf-parse pinned to 1.1.1 (cli.sh) — wrapper 有 `if (!module.parent)` guard，
// 被 require 不會跑 test。新版 2.x 用 exports map 不允許 subpath require。
const pdfParse = require('pdf-parse');

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

async function loadSuppliers() {
  try {
    const raw = await fsSync.promises.readFile(SUPPLIERS_JSON, 'utf8');
    return JSON.parse(raw).suppliers || [];
  } catch { return []; }
}

function matchSupplier(senderEmail, suppliers) {
  if (!senderEmail) return null;
  for (const s of suppliers) {
    const emails = [
      s.contact?.email,
      ...((s.contact?.aliases) || [])
    ].filter(Boolean);
    if (emails.some(e => e.toLowerCase() === senderEmail.toLowerCase())) {
      return { id: s.id, name: s.name };
    }
  }
  return null;
}

// ─── Heuristic: 從 PDF/email text 抓欄位 ───
function extractQuoteFields(text) {
  if (!text) return {};
  const t = text.replace(/\s+/g, ' ');

  const out = {
    unit_price_twd: null,
    lead_days: null,
    moq: null,
    currency: null,
    certifications_mentioned: [],
    anti_static_capable: null
  };

  // Price: NT$ XXX or $ XXX or 單價 XXX or unit price XXX
  const priceRe = [
    /NT\$\s*([\d,]+)/i,
    /單價[^\d]{0,8}([\d,]+)/,
    /unit\s+price[^\d]{0,10}([\d,]+)/i,
    /price[^\d]{0,10}([\d,]+)\s*(?:TWD|NTD)/i,
    /([\d,]+)\s*(?:TWD|NTD)\s*\/\s*(?:支|unit|pc)/i
  ];
  for (const re of priceRe) {
    const m = t.match(re);
    if (m) {
      const n = parseInt(m[1].replace(/,/g, ''), 10);
      if (Number.isFinite(n) && n > 10 && n < 100000) {
        out.unit_price_twd = n;
        out.currency = 'TWD';
        break;
      }
    }
  }

  // Lead time: N 天 / N days / N 工作天
  const leadRe = [
    /(\d+)\s*(?:工作天|working\s*days?)/i,
    /(\d+)\s*(?:天|days?)\b/i,
    /lead\s*time[^\d]{0,8}(\d+)/i,
    /交期[^\d]{0,8}(\d+)/
  ];
  for (const re of leadRe) {
    const m = t.match(re);
    if (m) {
      const n = parseInt(m[1], 10);
      if (Number.isFinite(n) && n >= 1 && n <= 90) {
        out.lead_days = n;
        break;
      }
    }
  }

  // MOQ
  const moqM = t.match(/MOQ[^\d]{0,8}(\d+)/i) || t.match(/最低[訂單量小數量量]+[^\d]{0,8}(\d+)/);
  if (moqM) out.moq = parseInt(moqM[1], 10);

  // Certifications
  const certKeys = ['ESD-S20.20', 'ESD S20.20', 'ESD20.20', 'ISO 9001', 'ISO9001', 'RoHS', 'REACH', 'IATF 16949', 'IATF16949'];
  for (const k of certKeys) {
    const re = new RegExp(k.replace(/[-.\s]/g, '[-.\\s]?'), 'i');
    if (re.test(t)) out.certifications_mentioned.push(k.replace(/\s+/g, ' ').trim());
  }
  out.certifications_mentioned = [...new Set(out.certifications_mentioned)];

  // Anti-static
  if (/抗靜電|anti[-\s]?static|\bESD\b/i.test(t)) {
    out.anti_static_capable = true;
  }

  return out;
}

// ─── Save attachment to disk ───
async function saveAttachment(att, saveDir) {
  await fs.mkdir(saveDir, { recursive: true });
  // 去掉檔名危險字元
  const safe = (att.filename || `attachment-${Date.now()}.bin`).replace(/[^\w一-鿿.\-]/g, '_');
  const p = path.join(saveDir, safe);
  await fs.writeFile(p, att.content);
  return { path: p, size: att.content.length };
}

// ─── parse PDF buffer → text ───
async function extractPdfText(buf) {
  try {
    const data = await pdfParse(buf);
    return data.text || '';
  } catch (e) {
    return null;
  }
}

// ─── main IMAP poll ───
async function main() {
  const input = await readStdin();
  const {
    action = 'poll',
    mode = 'any',
    order_id,
    sender_contains,
    subject_contains,
    max_messages = 20,
    mark_seen = true,
    save_attachments_to
  } = input;

  if (action !== 'poll') throw new Error(`unknown action: ${action}. Only 'poll' supported.`);

  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error('GMAIL_USER + GMAIL_APP_PASSWORD env vars not set');

  const saveDir = save_attachments_to
    ? path.resolve(WORKSPACE_DIR, save_attachments_to)
    : path.join(WORKSPACE_DIR, 'data', 'incoming');

  const suppliers = await loadSuppliers();

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false
  });

  await client.connect();
  const lock = await client.getMailboxLock('INBOX');

  const messages = [];
  const savedAttachments = [];

  try {
    const searchCriteria = { seen: false };
    // fetch unseen
    let fetched = 0;
    for await (let msg of client.fetch(searchCriteria, { source: true, envelope: true, uid: true, flags: true })) {
      if (fetched >= max_messages) break;
      try {
        const parsed = await simpleParser(msg.source);
        const fromAddr = parsed.from?.value?.[0];
        const fromEmail = fromAddr?.address?.toLowerCase() || '';
        const fromName = fromAddr?.name || '';
        const subject = parsed.subject || '';

        // mode filtering
        if (mode === 'new_inquiry') {
          // 客戶詢價：subject 有「詢價/RFQ/Quote」+ 有 PDF 附件
          const hasInquiryKw = /詢價|RFQ|Quote\s*Request|Inquiry/i.test(subject);
          const hasPdfAttach = (parsed.attachments || []).some(a => /pdf/i.test(a.contentType || ''));
          if (!(hasInquiryKw && hasPdfAttach)) continue;
        } else if (mode === 'supplier_reply') {
          // 廠商回信：sender 含 'supplier-' 或在 suppliers.json
          const isFromSupplier = /supplier-/i.test(fromEmail) ||
                                  suppliers.some(s => (s.contact?.email || '').toLowerCase() === fromEmail);
          if (!isFromSupplier) continue;
        }
        if (sender_contains && !fromEmail.includes(sender_contains.toLowerCase())) continue;
        if (subject_contains && !subject.toLowerCase().includes(subject_contains.toLowerCase())) continue;

        const matchedSupplier = matchSupplier(fromEmail, suppliers);

        // Save attachments + extract PDF text
        const atts = [];
        let combinedText = parsed.text || '';
        for (const att of (parsed.attachments || [])) {
          const saved = await saveAttachment(att, saveDir);
          savedAttachments.push(saved.path);
          let preview = null;
          if (/pdf/i.test(att.contentType || '')) {
            const text = await extractPdfText(att.content);
            if (text) {
              combinedText += '\n\n[PDF: ' + att.filename + ']\n' + text;
              preview = text.slice(0, 200).replace(/\s+/g, ' ').trim();
            }
          }
          atts.push({
            filename: att.filename,
            content_type: att.contentType,
            saved_path: saved.path,
            size_bytes: saved.size,
            extracted_text_preview: preview
          });
        }

        const extracted = extractQuoteFields(combinedText);

        messages.push({
          uid: msg.uid,
          from: fromName ? `${fromName} <${fromEmail}>` : fromEmail,
          from_email: fromEmail,
          subject,
          received_at: parsed.date?.toISOString() || null,
          matched_supplier: matchedSupplier,
          body_text_preview: (parsed.text || '').slice(0, 200).replace(/\s+/g, ' ').trim(),
          attachments: atts,
          extracted
        });

        // mark seen
        if (mark_seen) {
          await client.messageFlagsAdd({ uid: msg.uid }, ['\\Seen'], { uid: true });
        }

        fetched++;
      } catch (perMsgErr) {
        console.error(`[inbox_watch] message parse error (uid=${msg.uid}): ${perMsgErr.message}`);
      }
    }
  } finally {
    lock.release();
  }

  await client.logout();

  process.stdout.write(JSON.stringify({
    status: 'ok',
    mode,
    order_id: order_id || null,
    fetched_count: messages.length,
    save_dir: saveDir,
    saved_attachments: savedAttachments,
    messages,
    polled_at: new Date().toISOString()
  }));
}

main().catch(err => {
  console.error(`[inbox_watch] fatal: ${err.message}`);
  process.exit(1);
});
