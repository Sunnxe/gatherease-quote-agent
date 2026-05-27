#!/usr/bin/env node
/**
 * scripts/demo-mirror-server.js
 *
 * 在 VM host 上跑的 Express server，給 factory-quote-demo.html 抓真實 OpenClaw / NemoClaw data。
 *
 * Sunny Mac 透過 Brev SSH port forward 看 http://localhost:8000/factory-quote-demo.html。
 *
 * Endpoints:
 *   GET /                       → factory-quote-demo.html (auto redirect)
 *   GET /factory-quote-demo.html → static serve
 *   GET /api/status             → nemoclaw status --json (sandbox 整體狀態)
 *   GET /api/skills             → nemoclaw <sandbox> exec -- openclaw skills list (6 skills ready 列表)
 *   GET /api/policies           → 從 status 抽出 policies array (NemoClaw v10 + 3 preset)
 *   GET /api/audit?n=50         → tail logs/audit.jsonl 最近 N 行
 *
 * 跑：
 *   ./scripts/start-demo-mirror.sh
 *   或：MIRROR_PORT=8000 node scripts/demo-mirror-server.js
 */

const express = require('express');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');

const ROOT = path.resolve(__dirname, '..');
const SHOWCASE = path.join(ROOT, 'showcase');
const SANDBOX = process.env.NEMOCLAW_SANDBOX || 'gatherease-quote-agent';
const PORT = parseInt(process.env.MIRROR_PORT || '8000', 10);

const app = express();
app.use(express.json({ limit: '64kb' })); // for /api/agent-trigger POST body

// ─── helper: exec promise w/ timeout ────────────────────
// nemoclaw CLI silent-fails when stdout 是 pipe (non-TTY) — terminal 跑 work
// 但 Node child_process exec 直接 exit non-zero、stdout/stderr 都空。
// 解法：用 script(1) (util-linux 內建) 偽造 TTY 包外層，stdout 變 \r\r\n 需 strip。
function execAsync(cmd, timeout = 10000) {
  // single-quote escape: ' → '\''
  const escaped = cmd.replace(/'/g, "'\\''");
  const wrapped = `script -qec '${escaped}' /dev/null`;
  return new Promise((resolve, reject) => {
    exec(wrapped, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      // script(1) inserts \r\r\n line endings; normalize to \n
      resolve(stdout.toString().replace(/\r\r?\n/g, '\n').replace(/\r/g, ''));
    });
  });
}

// ─── 簡單 in-memory cache (避免 polling 壓死 sandbox SSH relay) ──
const _cache = new Map();
async function cached(key, fn, ttlMs = 30000) {
  const now = Date.now();
  const hit = _cache.get(key);
  if (hit && now - hit.at < ttlMs) return hit.data;
  try {
    const data = await fn();
    _cache.set(key, { data, at: now });
    return data;
  } catch (e) {
    // 失敗時用 stale cache 比 spam error 好
    if (hit) {
      console.warn(`[cache:${key}] fresh fetch failed, using stale: ${e.message}`);
      return hit.data;
    }
    throw e;
  }
}

// ─── CORS (Sunny Mac 可能跨域) ──────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// ─── Static serve showcase/ ─────────────────────────────
app.use(express.static(SHOWCASE));
app.get('/', (req, res) => res.redirect('/factory-quote-demo.html'));

// ─── /api/status (30s cached) ───────────────────────────
app.get('/api/status', async (req, res) => {
  try {
    const out = await cached('status', () => execAsync('nemoclaw status --json'), 30000);
    const data = JSON.parse(out);
    const sandbox = (data.sandboxes || []).find(s => s.name === SANDBOX) || {};
    res.json({
      sandbox_name: sandbox.name || SANDBOX,
      openshell_version: sandbox.openshellVersion || 'unknown',
      model: sandbox.model || data.liveInference?.model || 'unknown',
      provider: sandbox.provider || data.liveInference?.provider || 'unknown',
      gpu_enabled: !!sandbox.gpuEnabled,
      gateway_healthy: !!data.gatewayHealth?.healthy,
      gateway_state: data.gatewayHealth?.state || 'unknown',
      policies: sandbox.policies || [],
      is_default: !!sandbox.isDefault,
      raw_at: new Date().toISOString()
    });
  } catch (e) {
    console.error('[api/status] error:', e.message);
    res.status(500).json({ error: e.message, stderr: e.stderr });
  }
});

// ─── /api/skills (60s cached — exec 比 status 重) ───────
app.get('/api/skills', async (req, res) => {
  // 我們關心的 10 個 GatherEase skill
  const OURS = new Set([
    'order_store', 'inbox_watch', 'read_drawing',
    'get_history_quote', 'check_schedule', 'calc_cost',
    'compare_suppliers', 'line_notify', 'send_email', 'generate_quote_pdf'
  ]);
  try {
    const out = await cached(
      'skills',
      () => execAsync(`nemoclaw ${SANDBOX} exec -- openclaw skills list 2>&1`, 30000),
      60000
    );
    // line patterns like: │ ✓ ready  │ read_drawing       │ ...
    const readySkills = [];
    const allReady = [];
    for (const line of out.split('\n')) {
      const m = line.match(/│\s*✓\s*ready\s*│\s*(?:[^a-z]*\s*)?([a-z_][a-z0-9_-]*)\s+│/);
      if (m) {
        allReady.push(m[1]);
        if (OURS.has(m[1])) readySkills.push(m[1]);
      }
    }
    res.json({
      gatherease_skills_ready: readySkills,
      gatherease_count: readySkills.length,
      gatherease_total: OURS.size,
      gatherease_missing: Array.from(OURS).filter(s => !readySkills.includes(s)),
      total_ready_skills: allReady.length,
      all_ready_sample: allReady.slice(0, 8),
      raw_at: new Date().toISOString()
    });
  } catch (e) {
    console.error('[api/skills] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── /api/policies ──────────────────────────────────────
app.get('/api/policies', async (req, res) => {
  try {
    const out = await execAsync('nemoclaw status --json');
    const data = JSON.parse(out);
    const sandbox = (data.sandboxes || []).find(s => s.name === SANDBOX) || {};
    res.json({
      sandbox: SANDBOX,
      policies: sandbox.policies || [],
      // 我們關心的 3 個 custom preset
      gatherease_custom_active: (sandbox.policies || []).filter(p =>
        ['line-messaging', 'gmail-smtp', 'gmail-imap'].includes(p)
      ),
      raw_at: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── /api/sandbox-activity (sandbox 內治理 + agent log) ──
app.get('/api/sandbox-activity', async (req, res) => {
  try {
    const raw = await cached(
      'activity',
      () => execAsync(`nemoclaw ${SANDBOX} logs --tail 200 2>&1`, 12000),
      10000   // 10s cache for "live feel"
    );

    // Parse 重要 events from OCSF + gateway log
    const events = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const tsMatch = line.match(/\[(\d{10})\.\d+\]/) || line.match(/(\d{4}-\d{2}-\d{2}T[\d:.]+)/);
      const ts = tsMatch ? tsMatch[1] : '';

      // 1. Inference call (agent → Nemotron)
      if (line.includes('routing proxy inference') || line.includes('integrate.api.nvidia.com')) {
        events.push({
          type: 'inference',
          emoji: '🧠',
          label: 'agent → Nemotron Super',
          detail: 'NIM API · /v1/chat/completions',
          ts, raw: line
        });
      }
      // 2. Landlock filesystem governance
      else if (line.includes('Landlock')) {
        const rules = line.match(/rules_applied:(\d+)/);
        events.push({
          type: 'policy',
          emoji: '🛡️',
          label: 'Landlock 強制中',
          detail: rules ? `rules: ${rules[1]} applied` : 'kernel-level fs sandbox',
          ts, raw: line
        });
      }
      // 3. Network egress
      else if (line.includes('NET:OPEN') && line.includes('ALLOWED')) {
        const hostMatch = line.match(/ALLOWED\s+([^\s]+:\d+)/);
        events.push({
          type: 'egress',
          emoji: '🌐',
          label: 'NemoClaw egress ALLOWED',
          detail: hostMatch ? hostMatch[1] : 'connection authorized',
          ts, raw: line
        });
      }
      else if (line.includes('NET:OPEN') && line.includes('DENIED')) {
        events.push({
          type: 'block',
          emoji: '🚫',
          label: 'NemoClaw egress BLOCKED',
          detail: 'unauthorized host attempted',
          ts, raw: line
        });
      }
      // 4. SSH relay (agent exec'ing skill)
      else if (line.includes('SSH:OPEN ALLOWED')) {
        events.push({
          type: 'exec',
          emoji: '⚙️',
          label: 'agent exec → skill',
          detail: 'SSH relay opened to sandbox',
          ts, raw: line
        });
      }
      // 5. Gateway grpc exec
      else if (line.includes('ExecSandbox')) {
        events.push({
          type: 'tool',
          emoji: '🔧',
          label: 'tool call started',
          detail: 'OpenClaw runtime → cli.sh',
          ts, raw: line
        });
      }
    }

    res.json({
      events: events.slice(-40),
      count: events.length,
      raw_at: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ error: e.message, stderr: e.stderr });
  }
});

// ─── /api/agent-session (最新 session jsonl transcript) ─
// 注意：nemoclaw exec grpc 拒絕含 newline 的 args，所以這邊
// 不能用 `bash -c 'multi-line'`。改成 `ls 單檔` + host 端 sort 挑最新。
app.get('/api/agent-session', async (req, res) => {
  try {
    const result = await cached('agent-session', async () => {
      const SESSIONS_DIR = '/sandbox/.openclaw/agents/main/sessions';

      // ls -t 列檔名 (single-line cmd, no bash -c)
      let listOut;
      try {
        listOut = await execAsync(
          `nemoclaw ${SANDBOX} exec -- ls -t ${SESSIONS_DIR}`,
          10000
        );
      } catch (e) {
        // dir 還沒存在
        return { sessionFile: null, events: [], note: 'sessions dir not created yet' };
      }
      // 挑最新的 transcript .jsonl
      // ⚠️ 必須排除 .trajectory.jsonl — 那是 runtime trace，schema 完全不同。
      // 而且 agent 跑時 trajectory mtime 永遠比 transcript 新，ls -t 會優先看到它。
      const fileName = listOut.split('\n').map(s => s.trim())
        .find(s => s.endsWith('.jsonl') && !s.endsWith('.trajectory.jsonl'));
      if (!fileName) {
        return { sessionFile: null, events: [], note: 'no session jsonl yet — trigger an agent first' };
      }
      const sessionFile = `${SESSIONS_DIR}/${fileName}`;

      // Tail 最新 N 行 (single-line cmd, no bash -c)
      const content = await execAsync(
        `nemoclaw ${SANDBOX} exec -- tail -80 ${sessionFile}`,
        10000
      );

      // OpenClaw session jsonl 真實 schema:
      // 每行 {type, id, parentId, timestamp, ...}
      //  type=session/model_change/thinking_level_change/custom/custom_message  → skip (metadata)
      //  type=message + message.role=user → content array of {type:"text",text:"..."}
      //  type=message + message.role=assistant → content array 可能含
      //     {type:"thinking", thinking:"..."} + {type:"text",text:"..."} + {type:"toolCall",id,name,arguments}
      //  type=message + message.role=toolResult → content array of {type:"text",text:"..."}
      const events = [];
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type !== 'message') continue;  // skip session/model_change/etc
          const msg = obj.message;
          if (!msg) continue;
          const role = msg.role;
          const ts = obj.timestamp;
          const items = Array.isArray(msg.content) ? msg.content : [];

          // toolResult: content 內就是工具回應
          if (role === 'toolResult') {
            const text = items.map(c => c.text || JSON.stringify(c)).join('\n');
            events.push({
              role: 'tool_result',
              tool_name: msg.toolName || null,
              text: text.slice(0, 800),
              ts,
              is_error: !!msg.isError
            });
            continue;
          }

          // user / assistant 內可能含多個 items (thinking + text + toolCall)
          for (const it of items) {
            if (it.type === 'thinking') {
              events.push({ role: 'thinking', text: (it.thinking || '').slice(0, 800), ts });
            } else if (it.type === 'text') {
              events.push({ role: role || 'assistant', text: (it.text || '').slice(0, 800), ts });
            } else if (it.type === 'toolCall') {
              const args = typeof it.arguments === 'string'
                ? it.arguments
                : JSON.stringify(it.arguments || {}, null, 2);
              events.push({
                role: 'tool_call',
                tool_name: it.name || null,
                text: args.slice(0, 800),
                ts
              });
            } else if (it.type === 'tool_use') {
              const args = JSON.stringify(it.input || {}, null, 2);
              events.push({
                role: 'tool_call',
                tool_name: it.name || null,
                text: args.slice(0, 800),
                ts
              });
            }
          }
        } catch {
          // 非 JSON line, skip
        }
      }

      const sessionId = sessionFile.split('/').pop().replace('.jsonl', '');
      return {
        sessionFile,
        sessionId,
        events: events.slice(-30),  // 顯示最後 30 turns
        total: events.length
      };
    }, 8000);

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message, stderr: e.stderr });
  }
});

// ─── /api/agent-trigger (POST — 從 HTML 注入 user message 給 sandbox agent) ─
// Body: { "message": "請列出當前所有訂單" }
// Spawn nemoclaw exec，pipe stdout/stderr 到 /tmp/agent-trigger.log。
// 之前 stdio:'ignore' 看不到爆掉，這版會 log，方便 debug。
const TRIGGER_LOG = '/tmp/gatherease-agent-trigger.log';
app.post('/api/agent-trigger', (req, res) => {
  const message = (req.body && req.body.message) ? String(req.body.message) : '';
  if (!message || message.length > 2000) {
    return res.status(400).json({ error: 'message required, max 2000 chars' });
  }
  if (/[\r\n]/.test(message)) {
    return res.status(400).json({ error: 'message cannot contain newline (nemoclaw exec limitation)' });
  }

  // Clear /api/agent-session cache so 新 session 立刻可見
  _cache.delete('agent-session');

  // 開 append 模式的 fd 給 spawn 用
  const startedAt = new Date().toISOString();
  const sep = `\n========== ${startedAt} | "${message}" ==========\n`;
  fsSync.appendFileSync(TRIGGER_LOG, sep);
  const logFd = fsSync.openSync(TRIGGER_LOG, 'a');

  const args = [SANDBOX, 'exec', '--', 'openclaw', 'agent', '--agent', 'main', '-m', message];
  console.log(`[agent-trigger] spawn: nemoclaw ${args.join(' ')}`);

  // Pipe stdout + stderr 到 log file，不再 ignore
  const child = spawn('nemoclaw', args, {
    detached: true,
    stdio: ['ignore', logFd, logFd]
  });
  child.on('error', (err) => {
    console.error('[agent-trigger] spawn error:', err.message);
    fsSync.appendFileSync(TRIGGER_LOG, `\nSPAWN ERROR: ${err.message}\n`);
  });
  child.on('exit', (code, signal) => {
    fsSync.appendFileSync(TRIGGER_LOG, `\n[exit] code=${code} signal=${signal} at ${new Date().toISOString()}\n`);
    fsSync.closeSync(logFd);
  });
  child.unref();

  res.json({
    ok: true,
    dispatched_at: startedAt,
    message,
    log_file: TRIGGER_LOG,
    pid: child.pid,
    note: 'agent 在 sandbox 內跑中，poll /api/agent-session 看 session jsonl。/api/agent-trigger-log 看 spawn stdout/stderr'
  });
});

// ─── /api/order/latest (拿最新 order JSON 給左側 scene 渲染用) ──
app.get('/api/order/latest', async (req, res) => {
  try {
    const result = await cached('order-latest', async () => {
      const ORDERS_DIR = '/sandbox/.openclaw/workspace/data/orders';
      let listOut;
      try {
        listOut = await execAsync(`nemoclaw ${SANDBOX} exec -- ls -t ${ORDERS_DIR}/`, 8000);
      } catch (e) {
        return { exists: false, note: 'orders dir 不存在 / 沒訂單' };
      }
      const files = listOut.split('\n').map(f => f.trim()).filter(f => /^QUO-\d{4}-\d{4}\.json$/.test(f));
      if (files.length === 0) return { exists: false, note: '沒訂單' };
      const latestFile = files[0];
      const content = await execAsync(`nemoclaw ${SANDBOX} exec -- cat ${ORDERS_DIR}/${latestFile}`, 8000);
      try {
        return JSON.parse(content);
      } catch {
        return { exists: false, error: 'parse failed', raw_head: content.slice(0, 200) };
      }
    }, 4000);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── /api/inbox/latest (拿最新進 inbox 的 email 給左側顯示) ──
app.get('/api/inbox/latest', async (req, res) => {
  try {
    const result = await cached('inbox-latest', async () => {
      const INBOX_DIR = '/sandbox/.openclaw/workspace/data/inbox';
      let listOut;
      try {
        listOut = await execAsync(`nemoclaw ${SANDBOX} exec -- ls -t ${INBOX_DIR}/`, 6000);
      } catch {
        return { exists: false };
      }
      const files = listOut.split('\n').map(f => f.trim()).filter(f => /^\d+\.json$/.test(f));
      if (files.length === 0) return { exists: false };
      const latestFile = files[0];
      const content = await execAsync(`nemoclaw ${SANDBOX} exec -- cat ${INBOX_DIR}/${latestFile}`, 6000);
      try {
        return JSON.parse(content);
      } catch {
        return { exists: false, error: 'parse failed' };
      }
    }, 5000);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── /api/reset-demo (清乾淨重來) ──────────────────────
// 從 dashboard 一鍵清乾淨：sessions, orders, inbox, line_notify pending, outbox 卡住的信
// 不會清 sandbox 內 skills 本身（不用每次重 deploy）
app.post('/api/reset-demo', async (req, res) => {
  try {
    const cmd = `
      rm -f /sandbox/.openclaw/agents/main/sessions/*.jsonl
      rm -f /sandbox/.openclaw/workspace/data/orders/*.json
      rm -f /sandbox/.openclaw/workspace/data/inbox/*.json
      rm -f /sandbox/.openclaw/workspace/skills/line_notify/pending/*.json
      mkdir -p /sandbox/.openclaw/workspace/data/outbox/failed
      mv /sandbox/.openclaw/workspace/data/outbox/*.json /sandbox/.openclaw/workspace/data/outbox/failed/ 2>/dev/null || true
      echo "✓ reset"
    `.trim().replace(/\n\s*/g, ' && ');

    const out = await execAsync(`nemoclaw ${SANDBOX} exec -- bash -c "${cmd}"`, 15000);

    // 清 mirror server cache，下個 /api/agent-session fetch 不會看到舊資料
    _cache.delete('agent-session');
    _cache.delete('activity');
    _cache.delete('order-latest');
    _cache.delete('inbox-latest');

    res.json({
      ok: true,
      reset_at: new Date().toISOString(),
      cleared: ['sessions', 'orders', 'inbox', 'line_notify_pending', 'outbox_stuck'],
      sandbox_stdout: out.trim().slice(-200),
      note: 'dashboard 重新整理或 8s polling 後面板會 reset 成空狀態'
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, stderr: e.stderr });
  }
});

// ─── /api/agent-trigger-log (debug: tail spawn stdout/stderr) ─
app.get('/api/agent-trigger-log', async (req, res) => {
  try {
    if (!fsSync.existsSync(TRIGGER_LOG)) {
      return res.json({ exists: false, note: '還沒 trigger 過 agent' });
    }
    const raw = await fs.readFile(TRIGGER_LOG, 'utf8');
    const lines = raw.split('\n');
    // 拿最後 80 行
    res.type('text/plain').send(lines.slice(-80).join('\n'));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── /api/audit?n=50 ────────────────────────────────────
app.get('/api/audit', async (req, res) => {
  const n = Math.min(parseInt(req.query.n || '50', 10), 500);
  const auditPath = path.join(ROOT, 'logs', 'audit.jsonl');
  try {
    if (!fsSync.existsSync(auditPath)) {
      return res.json({ lines: [], count: 0, note: 'audit.jsonl not yet created' });
    }
    const raw = await fs.readFile(auditPath, 'utf8');
    const parsed = raw.trim().split('\n').slice(-n).map(l => {
      try { return JSON.parse(l); }
      catch { return { ts: '', level: 'INFO', msg: l }; }
    });
    res.json({
      lines: parsed,
      count: parsed.length,
      audit_path: 'logs/audit.jsonl',
      raw_at: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── /api/health (sanity check) ─────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, sandbox: SANDBOX, port: PORT, started_at: new Date().toISOString() });
});

// ─── start ──────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('════════════════════════════════════════════════════════');
  console.log(`  🦞 GatherEase demo mirror — http://localhost:${PORT}`);
  console.log('════════════════════════════════════════════════════════');
  console.log('');
  console.log('  Main view:');
  console.log(`    http://localhost:${PORT}/factory-quote-demo.html`);
  console.log('');
  console.log('  Live data endpoints:');
  console.log(`    http://localhost:${PORT}/api/status`);
  console.log(`    http://localhost:${PORT}/api/skills`);
  console.log(`    http://localhost:${PORT}/api/policies`);
  console.log(`    http://localhost:${PORT}/api/audit?n=50`);
  console.log('');
  console.log(`  Sandbox: ${SANDBOX}`);
  console.log('  Stop:    Ctrl+C');
  console.log('');
});
