#!/usr/bin/env node
/**
 * skills/send_email/impl.js (OpenClaw skill version)
 *
 * Native Node SMTP client (net + tls, 零依賴) 真寄 Gmail SMTP。
 *
 * 用 STARTTLS port 587 + AUTH LOGIN (App Password)。
 *
 * NemoClaw gmail-smtp.yaml preset 允許 egress 到 smtp.gmail.com:587。
 * 對其他 host 會被 kernel 層擋 → 治理鏡頭。
 */

const net = require('net');
const tls = require('tls');

const SMTP_HOST = 'smtp.gmail.com';
const SMTP_PORT = 587;
const SMTP_TIMEOUT_MS = 15000;

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

// ─── RFC 2047 encoded-word (UTF-8 base64) for subject ───
function encodeSubject(s) {
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

// ─── Build MIME message body (multipart if attachments) ───
const fs = require('fs');

function buildMimeBody({ from, to, subject, body, attachments }) {
  const recipients = Array.isArray(to) ? to.join(', ') : to;
  const messageId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@gatherease.local>`;
  const dateHdr = new Date().toUTCString();
  const bodyB64 = Buffer.from(body, 'utf8').toString('base64').match(/.{1,76}/g).join('\r\n');

  const hasAttach = Array.isArray(attachments) && attachments.length > 0;

  // ── Headers ──
  const headers = [
    `Date: ${dateHdr}`,
    `From: ${from}`,
    `To: ${recipients}`,
    `Subject: ${encodeSubject(subject)}`,
    `Message-ID: ${messageId}`,
    `MIME-Version: 1.0`
  ];

  if (!hasAttach) {
    // ── Simple single-part text body ──
    headers.push(`Content-Type: text/plain; charset=UTF-8`);
    headers.push(`Content-Transfer-Encoding: base64`);
    headers.push(``);
    return { mime: headers.concat([bodyB64]).join('\r\n'), messageId };
  }

  // ── Multipart/mixed (body + attachments) ──
  const boundary = `BOUND_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  headers.push(``);
  headers.push(`This is a multi-part message in MIME format.`);

  const parts = [];
  // Text part
  parts.push([
    `--${boundary}`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    bodyB64
  ].join('\r\n'));

  // Attachment parts
  for (const att of attachments) {
    const filePath = att.path;
    const filename = att.filename || (filePath ? require('path').basename(filePath) : 'attachment.bin');
    const contentType = att.content_type || guessContentType(filename);
    let data;
    try {
      data = fs.readFileSync(filePath);
    } catch (e) {
      throw new Error(`attachment file not readable: ${filePath} (${e.message})`);
    }
    const dataB64 = data.toString('base64').match(/.{1,76}/g).join('\r\n');

    parts.push([
      `--${boundary}`,
      `Content-Type: ${contentType}; name="${filename}"`,
      `Content-Transfer-Encoding: base64`,
      `Content-Disposition: attachment; filename="${filename}"`,
      ``,
      dataB64
    ].join('\r\n'));
  }

  // Closing boundary
  parts.push(`--${boundary}--`);

  return { mime: headers.concat(parts).join('\r\n'), messageId };
}

function guessContentType(filename) {
  const ext = filename.toLowerCase().split('.').pop();
  const map = {
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg', jpeg: 'image/jpeg',
    txt: 'text/plain',
    csv: 'text/csv',
    json: 'application/json',
    html: 'text/html'
  };
  return map[ext] || 'application/octet-stream';
}

// ─── Tiny SMTP client (zero deps, Node net + tls) ───
function smtpSend({ host, port, username, password, from, to, mime, log }) {
  return new Promise((resolve, reject) => {
    const recipients = Array.isArray(to) ? to : [to];
    let socket = net.createConnection({ host, port });
    socket.setEncoding('utf8');
    socket.setTimeout(SMTP_TIMEOUT_MS);

    const steps = [];
    let upgraded = false;
    let buffer = '';

    function send(cmd, redact = false) {
      log.push(`> ${redact ? '(redacted)' : cmd.replace(/\r?\n/g, '')}`);
      socket.write(cmd + '\r\n');
    }

    function fatal(msg) {
      try { socket.destroy(); } catch {}
      reject(new Error(msg + ' | log: ' + log.join(' | ')));
    }

    function nextStep() {
      const step = steps.shift();
      if (!step) return;
      step();
    }

    function expect(code, action) {
      socket.once('line', (line) => {
        log.push(`< ${line}`);
        if (!line.startsWith(String(code))) {
          return fatal(`expected ${code}, got: ${line}`);
        }
        // consume any pending multi-line response (250-XXX lines before final 250 XXX)
        function drainMulti() {
          if (buffer.length > 0) {
            const i = buffer.indexOf('\r\n');
            if (i >= 0) {
              const more = buffer.slice(0, i);
              buffer = buffer.slice(i + 2);
              if (more.startsWith(String(code) + '-')) {
                log.push(`< ${more}`);
                return drainMulti();
              } else {
                socket.emit('line', more);
              }
            }
          }
          action();
        }
        drainMulti();
      });
    }

    socket.on('data', (data) => {
      buffer += data;
      let i;
      while ((i = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        socket.emit('line', line);
      }
    });

    socket.on('error', (err) => fatal(`socket error: ${err.message}`));
    socket.on('timeout', () => fatal('socket timeout'));
    socket.on('close', () => {
      if (!steps.done) {
        // OK
      }
    });

    // ─── SMTP conversation ───
    steps.push(() => expect('220', () => { send('EHLO gatherease.local'); nextStep(); }));
    steps.push(() => expect('250', () => { send('STARTTLS'); nextStep(); }));
    steps.push(() => expect('220', () => {
      // upgrade socket
      const secureSocket = tls.connect({ socket, servername: host, rejectUnauthorized: true }, () => {
        upgraded = true;
        socket = secureSocket;
        socket.setEncoding('utf8');
        socket.setTimeout(SMTP_TIMEOUT_MS);
        socket.on('data', (data) => {
          buffer += data;
          let j;
          while ((j = buffer.indexOf('\r\n')) >= 0) {
            const line = buffer.slice(0, j);
            buffer = buffer.slice(j + 2);
            socket.emit('line', line);
          }
        });
        socket.on('error', (err) => fatal(`tls error: ${err.message}`));
        socket.on('timeout', () => fatal('tls timeout'));
        send('EHLO gatherease.local');
        nextStep();
      });
      secureSocket.on('error', (err) => fatal(`tls connect error: ${err.message}`));
    }));
    steps.push(() => expect('250', () => { send('AUTH LOGIN'); nextStep(); }));
    steps.push(() => expect('334', () => {
      send(Buffer.from(username, 'utf8').toString('base64'), true);
      nextStep();
    }));
    steps.push(() => expect('334', () => {
      send(Buffer.from(password, 'utf8').toString('base64'), true);
      nextStep();
    }));
    steps.push(() => expect('235', () => { send(`MAIL FROM:<${from}>`); nextStep(); }));
    steps.push(() => expect('250', () => {
      let sentRcpt = 0;
      const sendNextRcpt = () => {
        if (sentRcpt >= recipients.length) {
          send('DATA');
          nextStep();
          return;
        }
        send(`RCPT TO:<${recipients[sentRcpt]}>`);
        expect('250', () => { sentRcpt++; sendNextRcpt(); });
      };
      sendNextRcpt();
    }));
    steps.push(() => expect('354', () => {
      socket.write(mime + '\r\n.\r\n');
      log.push('> (mime body + dot)');
      nextStep();
    }));
    steps.push(() => expect('250', () => {
      send('QUIT');
      steps.done = true;
      try { socket.end(); } catch {}
      resolve({ ok: true });
    }));

    nextStep();
  });
}

// ─── BRIDGE_MODE outbox writer ──────────────────────────
// sandbox 內 squid HTTP-proxy 擋 SMTP，所以 sandbox 跑時不直連，
// 改成把 outbox JSON 寫到 workspace/data/outbox/，host 上 email-bridge.js
// 監看、用 SMTP 真寄。
async function writeOutbox(input) {
  const path = require('path');
  const SKILL_DIR = __dirname;
  const WORKSPACE_DIR = path.resolve(SKILL_DIR, '..', '..');
  const OUTBOX_DIR = path.join(WORKSPACE_DIR, 'data', 'outbox');
  fs.mkdirSync(OUTBOX_DIR, { recursive: true });

  const ts = Date.now();
  const id = `out-${ts}-${Math.random().toString(36).slice(2, 8)}`;
  const file = path.join(OUTBOX_DIR, `${id}.json`);
  const payload = {
    id,
    queued_at: new Date().toISOString(),
    status: 'pending',
    request: input
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  return { id, file };
}

// ─── main ───
async function main() {
  const input = await readStdin();
  const { to, subject, body, attachments } = input;

  if (!to) throw new Error('to required');
  if (!subject) throw new Error('subject required');
  if (!body) throw new Error('body required');

  // ── BRIDGE_MODE=outbox: 寫 JSON 給 host email-bridge.js 監看 ──
  if (process.env.BRIDGE_MODE === 'outbox') {
    const { id, file } = writeOutbox(input);
    process.stdout.write(JSON.stringify({
      status: 'queued',
      bridge_mode: 'outbox',
      outbox_id: id,
      outbox_file: file,
      to: Array.isArray(to) ? to : [to],
      subject,
      queued_at: new Date().toISOString(),
      note: 'host email-bridge.js 監看 outbox，真寄成功會回填 sent_at/message_id 到此 JSON'
    }));
    return;
  }

  // ── 否則直連 SMTP（host 跑 / 本地測試 ok）──
  const username = process.env.GMAIL_USER;
  const password = process.env.GMAIL_APP_PASSWORD;
  if (!username) throw new Error('GMAIL_USER env var not set');
  if (!password) throw new Error('GMAIL_APP_PASSWORD env var not set');

  // SMTP envelope sender 用純 email (MAIL FROM:<...>)
  const envelopeFrom = username;

  // RFC 5322 From: header 可帶 display name —— 收件人 inbox 看到的「寄件人」就是這個
  // 用 GMAIL_FROM_NAME 環境變數覆寫，預設「GatherEase 報價助手 🦞」
  const displayName = process.env.GMAIL_FROM_NAME || 'GatherEase 報價助手 🦞';
  const encodedDisplayName = `=?UTF-8?B?${Buffer.from(displayName, 'utf8').toString('base64')}?=`;
  const headerFrom = `${encodedDisplayName} <${username}>`;

  const { mime, messageId } = buildMimeBody({ from: headerFrom, to, subject, body, attachments });

  const log = [];
  await smtpSend({
    host: SMTP_HOST,
    port: SMTP_PORT,
    username, password,
    from: envelopeFrom,
    to, mime, log
  });

  process.stdout.write(JSON.stringify({
    status: 'sent',
    to: Array.isArray(to) ? to : [to],
    subject,
    from_envelope: envelopeFrom,
    from_display: displayName,
    message_id: messageId,
    attachments_count: Array.isArray(attachments) ? attachments.length : 0,
    sent_at: new Date().toISOString(),
    smtp_log_lines: log.length
  }));
}

main().catch(err => {
  console.error(`[send_email] fatal: ${err.message}`);
  process.exit(1);
});
