#!/usr/bin/env node
/**
 * scripts/email-bridge.js — host VM 跑（sandbox 外）
 *
 * 解決 sandbox 內 squid proxy 擋 SMTP/IMAP 的問題：
 *   - 對外 SMTP/IMAP 通訊在 host 跑（無 proxy 限制）
 *   - sandbox 內 send_email/inbox_watch 用 BRIDGE_MODE=outbox 改寫 outbox/inbox JSON
 *   - 這支 bridge 監看 sandbox outbox（用 nemoclaw exec polling）
 *     + IMAP poll 抓信寫到 sandbox inbox（用 nemoclaw exec base64 + cat）
 *
 * 起：
 *   cd ~/gatherease-quote-agent
 *   set -a; source .env; set +a
 *   node scripts/email-bridge.js
 *   # 或 nohup ... &
 */

const { spawnSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');

const SANDBOX = process.env.NEMOCLAW_SANDBOX || 'gatherease-quote-agent';
const SANDBOX_OUTBOX = '/sandbox/.openclaw/workspace/data/outbox';
const SANDBOX_INBOX  = '/sandbox/.openclaw/workspace/data/inbox';

const OUTBOX_POLL_MS = parseInt(process.env.BRIDGE_OUTBOX_POLL_MS || '5000', 10);
const INBOX_POLL_MS  = parseInt(process.env.BRIDGE_INBOX_POLL_MS  || '30000', 10);

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const FROM_NAME = process.env.GMAIL_FROM_NAME || 'GatherEase 報價助手 🦞';

if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
  console.error('[email-bridge] ❌ GMAIL_USER / GMAIL_APP_PASSWORD env not set. source .env first.');
  process.exit(1);
}

// ─── nemoclaw exec helper (TTY-wrapped via script(1)) ────
function nexec(cmd, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const escaped = cmd.replace(/'/g, "'\\''");
    const wrapped = `script -qec '${escaped}' /dev/null`;
    exec(wrapped, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve(stdout.toString().replace(/\r\r?\n/g, '\n').replace(/\r/g, ''));
    });
  });
}

// ─── log helper ─────────────────────────────────────────
function log(label, msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${label}] ${msg}`);
}

// ───────────────────────────────────────────────────────
// PART 1: Outbox watcher (sandbox → host → SMTP)
// ───────────────────────────────────────────────────────
//
// 每 OUTBOX_POLL_MS 秒：
//   1. ls sandbox outbox 看新 .json
//   2. cat 每個還沒處理的 → SMTP 真寄
//   3. 把該 .json 移到 outbox/sent/<id>.json + 加 sent_at/message_id
// ───────────────────────────────────────────────────────
// 用 child_process spawn host send_email cli.sh（host BRIDGE_MODE='' 走 SMTP 直連）
async function smtpSend(req) {
  const { to, subject, body, attachments } = req;
  // 直接呼叫 host repo 的 cli.sh（host 跑，無 proxy，會走 nodemailer 原本路徑）
  const repoRoot = path.resolve(__dirname, '..');
  const cli = path.join(repoRoot, 'workspace', 'skills', 'send_email', 'cli.sh');
  const input = JSON.stringify({ to, subject, body, attachments });
  return new Promise((resolve, reject) => {
    const child = require('child_process').spawn('bash', [cli], {
      env: { ...process.env, BRIDGE_MODE: '' }   // 強制清掉 BRIDGE_MODE 走直連
    });
    let out = '', err = '';
    child.stdin.write(input); child.stdin.end();
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', code => {
      if (code === 0) {
        try { resolve(JSON.parse(out)); }
        catch { resolve({ raw: out }); }
      } else {
        reject(new Error(`send_email exit ${code}: ${err}`));
      }
    });
  });
}

const processedOutbox = new Set();

async function pollOutbox() {
  try {
    const lsOut = await nexec(`nemoclaw ${SANDBOX} exec -- ls ${SANDBOX_OUTBOX}/`);
    const files = lsOut.split('\n').filter(f => f.endsWith('.json') && !f.startsWith('.'));

    for (const f of files) {
      if (processedOutbox.has(f)) continue;
      log('outbox', `picking up ${f}`);

      // 讀 JSON
      let raw;
      try { raw = await nexec(`nemoclaw ${SANDBOX} exec -- cat ${SANDBOX_OUTBOX}/${f}`, 8000); }
      catch (e) { log('outbox', `❌ cat ${f} failed: ${e.message}`); continue; }

      let payload;
      try { payload = JSON.parse(raw); }
      catch (e) { log('outbox', `❌ ${f} not valid JSON, skipping`); continue; }

      if (payload.status === 'sent') {
        log('outbox', `${f} already sent, marking processed`);
        processedOutbox.add(f);
        continue;
      }

      // SMTP 真寄
      try {
        log('outbox', `→ SMTP sending ${f}: to=${payload.request?.to} subject="${payload.request?.subject}"`);
        const result = await smtpSend(payload.request);
        payload.status = 'sent';
        payload.sent_at = new Date().toISOString();
        payload.message_id = result.message_id;
        payload.smtp_result = result;
        log('outbox', `✓ sent ${f} → ${result.message_id}`);

        // 寫回 sandbox（標記 sent）+ 移到 sent/ 子資料夾
        const updatedJson = JSON.stringify(payload, null, 2);
        const b64 = Buffer.from(updatedJson, 'utf8').toString('base64');
        await nexec(`nemoclaw ${SANDBOX} exec -- bash -c "mkdir -p ${SANDBOX_OUTBOX}/sent && echo ${b64} | base64 -d > ${SANDBOX_OUTBOX}/sent/${f} && rm ${SANDBOX_OUTBOX}/${f}"`, 10000);
      } catch (e) {
        log('outbox', `❌ SMTP fail ${f}: ${e.message}`);
        payload.status = 'failed';
        payload.failed_at = new Date().toISOString();
        payload.error = e.message;
        const updatedJson = JSON.stringify(payload, null, 2);
        const b64 = Buffer.from(updatedJson, 'utf8').toString('base64');
        await nexec(`nemoclaw ${SANDBOX} exec -- bash -c "mkdir -p ${SANDBOX_OUTBOX}/failed && echo ${b64} | base64 -d > ${SANDBOX_OUTBOX}/failed/${f} && rm ${SANDBOX_OUTBOX}/${f}"`, 10000);
      }

      processedOutbox.add(f);
    }
  } catch (e) {
    if (!e.message.includes('No such file')) {
      log('outbox', `poll error: ${e.message}`);
    }
  }
}

// ───────────────────────────────────────────────────────
// PART 2: Inbox poller (IMAP → host → sandbox inbox/)
// ───────────────────────────────────────────────────────
//
// 每 INBOX_POLL_MS 秒：
//   1. IMAP unseen poll (host 直連，無 proxy)
//   2. 每封 → 解析 → 寫 JSON 到 sandbox /sandbox/.../data/inbox/<uid>.json
//   3. mark seen
// ───────────────────────────────────────────────────────
const lastSeenUids = new Set();

async function pollInbox() {
  let ImapFlow, simpleParser, pdfParse;
  try {
    ImapFlow = require('imapflow').ImapFlow;
    simpleParser = require('mailparser').simpleParser;
    try { pdfParse = require('pdf-parse'); } catch { pdfParse = null; }
  } catch (e) {
    log('inbox', `❌ require failed: ${e.message}. cd workspace/skills/inbox_watch && npm install`);
    return;
  }

  const client = new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true,
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    logger: false
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      let fetched = 0;
      for await (const msg of client.fetch({ seen: false }, { source: true, envelope: true, uid: true })) {
        if (fetched >= 10) break;
        if (lastSeenUids.has(msg.uid)) continue;

        const parsed = await simpleParser(msg.source);
        const fromAddr = parsed.from?.value?.[0];
        const fromEmail = (fromAddr?.address || '').toLowerCase();
        const fromName = fromAddr?.name || '';
        const subject = parsed.subject || '';

        // 附件處理 — 寫到 sandbox 內 data/incoming/
        const sandboxIncoming = `/sandbox/.openclaw/workspace/data/incoming`;
        const atts = [];
        for (const att of (parsed.attachments || [])) {
          const safeName = (att.filename || `att-${Date.now()}.bin`).replace(/[^\w.\-]/g, '_');
          const b64 = att.content.toString('base64');
          // chunked write (base64 too long for one cmd if big)
          try {
            // 寫個小 attachment 直接 base64 -d
            if (b64.length < 500000) {  // < ~370KB raw
              await nexec(`nemoclaw ${SANDBOX} exec -- bash -c "mkdir -p ${sandboxIncoming} && echo ${b64} | base64 -d > ${sandboxIncoming}/${safeName}"`, 20000);
            } else {
              log('inbox', `⚠️ attachment ${safeName} too large (${b64.length} b64 chars), skipping write`);
              continue;
            }
            atts.push({
              filename: safeName,
              content_type: att.contentType,
              saved_path: `${sandboxIncoming}/${safeName}`,
              size_bytes: att.content.length
            });
          } catch (e) {
            log('inbox', `❌ attachment write failed: ${e.message}`);
          }
        }

        const inboxJson = {
          uid: msg.uid,
          from: fromName ? `${fromName} <${fromEmail}>` : fromEmail,
          from_email: fromEmail,
          subject,
          received_at: parsed.date?.toISOString() || null,
          body_text_preview: (parsed.text || '').slice(0, 300).replace(/\s+/g, ' ').trim(),
          attachments: atts,
          fetched_by_bridge_at: new Date().toISOString()
        };

        const b64 = Buffer.from(JSON.stringify(inboxJson, null, 2), 'utf8').toString('base64');
        await nexec(`nemoclaw ${SANDBOX} exec -- bash -c "mkdir -p ${SANDBOX_INBOX} && echo ${b64} | base64 -d > ${SANDBOX_INBOX}/${msg.uid}.json"`, 10000);

        log('inbox', `✓ wrote uid=${msg.uid} from=${fromEmail} subject="${subject.slice(0, 40)}" attachments=${atts.length}`);

        // mark seen
        await client.messageFlagsAdd({ uid: msg.uid }, ['\\Seen'], { uid: true });
        lastSeenUids.add(msg.uid);
        fetched++;
      }
    } finally {
      lock.release();
    }
    await client.logout();
  } catch (e) {
    log('inbox', `IMAP error: ${e.message}`);
    try { await client.close(); } catch {}
  }
}

// ───────────────────────────────────────────────────────
// 主迴圈
// ───────────────────────────────────────────────────────
log('init', `email-bridge starting — sandbox=${SANDBOX}`);
log('init', `outbox poll every ${OUTBOX_POLL_MS}ms, inbox poll every ${INBOX_POLL_MS}ms`);
log('init', `GMAIL_USER=${GMAIL_USER} (App Password set)`);

// 啟動時先 ensure sandbox 的 outbox/inbox dir 存在
(async () => {
  try {
    await nexec(`nemoclaw ${SANDBOX} exec -- bash -c "mkdir -p ${SANDBOX_OUTBOX} ${SANDBOX_INBOX} ${SANDBOX_OUTBOX}/sent ${SANDBOX_OUTBOX}/failed /sandbox/.openclaw/workspace/data/incoming"`, 10000);
    log('init', `✓ sandbox dirs ensured`);
  } catch (e) {
    log('init', `⚠️ mkdir failed: ${e.message}`);
  }
})();

setInterval(pollOutbox, OUTBOX_POLL_MS);
setInterval(pollInbox, INBOX_POLL_MS);

// 啟動立刻 poll 一次
setTimeout(pollOutbox, 2000);
setTimeout(pollInbox, 4000);

process.on('SIGTERM', () => { log('shutdown', 'SIGTERM'); process.exit(0); });
process.on('SIGINT',  () => { log('shutdown', 'SIGINT');  process.exit(0); });
