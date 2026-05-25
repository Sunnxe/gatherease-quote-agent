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

// ─── Build MIME message body ───
function buildMimeBody({ from, to, subject, body }) {
  const recipients = Array.isArray(to) ? to.join(', ') : to;
  const messageId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@gatherease.local>`;
  const dateHdr = new Date().toUTCString();
  const bodyB64 = Buffer.from(body, 'utf8').toString('base64');

  const lines = [
    `Date: ${dateHdr}`,
    `From: ${from}`,
    `To: ${recipients}`,
    `Subject: ${encodeSubject(subject)}`,
    `Message-ID: ${messageId}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset=UTF-8`,
    `Content-Transfer-Encoding: base64`,
    ``,
    bodyB64.match(/.{1,76}/g).join('\r\n')   // base64 wrap 76 col
  ];

  return { mime: lines.join('\r\n'), messageId };
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

// ─── main ───
async function main() {
  const input = await readStdin();
  const { to, subject, body } = input;

  if (!to) throw new Error('to required');
  if (!subject) throw new Error('subject required');
  if (!body) throw new Error('body required');

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

  const { mime, messageId } = buildMimeBody({ from: headerFrom, to, subject, body });

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
    sent_at: new Date().toISOString(),
    smtp_log_lines: log.length
  }));
}

main().catch(err => {
  console.error(`[send_email] fatal: ${err.message}`);
  process.exit(1);
});
