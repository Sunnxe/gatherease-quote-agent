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
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');

const ROOT = path.resolve(__dirname, '..');
const SHOWCASE = path.join(ROOT, 'showcase');
const SANDBOX = process.env.NEMOCLAW_SANDBOX || 'gatherease-quote-agent';
const PORT = parseInt(process.env.MIRROR_PORT || '8000', 10);

const app = express();

// ─── helper: exec promise w/ timeout ────────────────────
function execAsync(cmd, timeout = 10000) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        return reject(err);
      }
      resolve(stdout.toString());
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
app.get('/api/agent-session', async (req, res) => {
  try {
    const result = await cached('agent-session', async () => {
      // 找最新 session file
      const listOut = await execAsync(
        `nemoclaw ${SANDBOX} exec -- bash -c 'ls -t /sandbox/.openclaw/agents/main/sessions/*.jsonl 2>/dev/null | head -1'`,
        10000
      );
      const sessionFile = listOut.trim();
      if (!sessionFile || !sessionFile.endsWith('.jsonl')) {
        return { sessionFile: null, events: [], note: 'no session jsonl yet' };
      }

      // Tail 最新 N 行
      const content = await execAsync(
        `nemoclaw ${SANDBOX} exec -- tail -80 "${sessionFile}"`,
        10000
      );

      const events = [];
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          // 抽出有用 fields
          const role = obj.role || obj.type || obj.kind || 'unknown';
          let text = '';
          if (typeof obj.content === 'string') text = obj.content;
          else if (Array.isArray(obj.content)) {
            text = obj.content.map(c => c.text || c.content || JSON.stringify(c).slice(0,200)).join(' ');
          } else if (obj.content && typeof obj.content === 'object') {
            text = JSON.stringify(obj.content).slice(0, 500);
          } else if (obj.message) text = obj.message;
          else text = JSON.stringify(obj).slice(0, 300);

          events.push({
            role,
            tool_name: obj.tool_name || obj.name || null,
            text: text.slice(0, 600),  // truncate long content
            ts: obj.ts || obj.timestamp || obj.createdAt || null
          });
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
