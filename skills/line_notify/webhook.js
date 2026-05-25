/**
 * skills/line_notify/webhook.js
 *
 * LINE Messaging API webhook server。
 * 老闆按 flex message 按鈕 → LINE 送 postback event 到這裡 → 解析後呼叫 resolveHold()。
 *
 * 同時也 log 任何 follow / message event 的 userId，方便第一次接通時找出老闆的 userId
 * （那個值要放進 .env 的 LINE_BOSS_USER_ID）。
 *
 * 啟動：
 *   npm install @line/bot-sdk express
 *   PORT=3000 node skills/line_notify/webhook.js
 *
 * 對外曝光（給 LINE 打到）：
 *   方式 A — ngrok:           ngrok http 3000  → https://XXXX.ngrok-free.app/webhook/line
 *   方式 B — Cloudflare Tunnel: cloudflared tunnel --url http://localhost:3000
 *   方式 C — Brev VM 公網 + Nginx + Let's Encrypt（最 production 但最繁）
 */

const line = require('@line/bot-sdk');
const express = require('express');
const { resolveHold } = require('./index');

const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};

function startWebhook(port = process.env.LINE_WEBHOOK_PORT || 3000) {
  if (!lineConfig.channelSecret || !lineConfig.channelAccessToken) {
    console.error('[line_notify webhook] LINE_CHANNEL_ACCESS_TOKEN 或 LINE_CHANNEL_SECRET 未設，不啟動 webhook');
    return null;
  }

  const app = express();

  // ── DEBUG trace: 印出每個進來的 request（包含 LINE 自己的 Verify） ──
  app.use((req, res, next) => {
    const sig = req.headers['x-line-signature'];
    const t0 = Date.now();
    console.log(`[trace] ${new Date().toISOString()} ${req.method} ${req.url} sig=${sig ? sig.slice(0,12)+'...' : '(none)'} ua=${req.headers['user-agent']}`);
    res.on('finish', () => {
      console.log(`[trace] ↳ ${req.method} ${req.url} responded ${res.statusCode} in ${Date.now()-t0}ms`);
    });
    res.on('close', () => {
      if (!res.writableEnded) {
        console.log(`[trace] ↳ ${req.method} ${req.url} client closed connection after ${Date.now()-t0}ms (no response sent)`);
      }
    });
    next();
  });

  // 健康檢查（給 LINE 設定時驗證 webhook URL 用）
  app.get('/health', (req, res) => res.send('OK'));
  app.get('/webhook/line', (req, res) => res.send('LINE webhook ready (use POST)'));

  // ── 包一層 line.middleware 看它有沒有卡住 ──
  const lineMw = line.middleware(lineConfig);
  const wrappedLineMw = (req, res, next) => {
    console.log(`[trace] entering line.middleware...`);
    let wentNext = false;
    const wrappedNext = (err) => {
      wentNext = true;
      if (err) {
        console.log(`[trace] line.middleware called next(err): ${err.name} - ${err.message}`);
      } else {
        console.log(`[trace] line.middleware called next() OK (signature valid)`);
      }
      next(err);
    };
    setTimeout(() => {
      if (!wentNext) console.log(`[trace] ⚠️  line.middleware did NOT call next() within 3s — IT'S STUCK`);
    }, 3000);
    lineMw(req, res, wrappedNext);
  };

  // LINE webhook（POST + 簽章驗證）
  app.post('/webhook/line', wrappedLineMw, (req, res) => {
    console.log(`[trace] handler reached, events count = ${(req.body.events || []).length}`);
    Promise.all((req.body.events || []).map(handleEvent))
      .then(() => {
        console.log(`[trace] handler Promise.all done, sending 200`);
        res.status(200).end();
      })
      .catch(err => {
        console.error('[webhook] handleEvent error:', err);
        res.status(500).end();
      });
  });

  // ── Express 預設 error handler 也加 log（line.middleware 簽章失敗會走這裡） ──
  app.use((err, req, res, next) => {
    console.log(`[trace] error handler caught: ${err.name} - ${err.message}`);
    if (err.name === 'SignatureValidationFailed') {
      return res.status(401).end();
    }
    if (err.name === 'JSONParseError') {
      return res.status(400).end();
    }
    res.status(500).end();
  });

  app.listen(port, () => {
    console.log(`[line_notify webhook] Listening on http://0.0.0.0:${port}`);
    console.log(`[line_notify webhook] Set LINE channel webhook URL to:`);
    console.log(`  https://<your-public-domain>/webhook/line`);
    console.log(`  (use ngrok / Cloudflare Tunnel / Nginx+LE to expose port ${port})`);
  });

  return app;
}

async function handleEvent(event) {
  // postback = 老闆按了 flex message 的 button
  if (event.type === 'postback') {
    const params = new URLSearchParams(event.postback.data);
    const hold_id = params.get('hold_id');
    const choice = parseInt(params.get('choice'), 10);
    const label = params.get('label');
    const userId = event.source.userId;

    console.log(`[webhook] postback from ${userId.slice(0, 8)}... hold=${hold_id} choice=${choice} (${label})`);

    const resolved = resolveHold(hold_id, choice, label);
    if (!resolved) {
      console.warn(`[webhook] No matching pending HOLD for ${hold_id} — orchestrator 沒在等這個事件（可能 demo 重跑了）`);
    }
    return;
  }

  // follow / message = 用來抓老闆的 LINE userId（第一次接通用）
  if (event.type === 'follow' || event.type === 'message') {
    const userId = event.source.userId;
    console.log(`[webhook] ${event.type} from userId = ${userId}`);
    console.log(`[webhook] ↑ 把這串放進 .env 的 LINE_BOSS_USER_ID`);
    return;
  }

  console.log(`[webhook] unhandled event type: ${event.type}`);
}

module.exports = { startWebhook, handleEvent };

if (require.main === module) {
  startWebhook();
}
