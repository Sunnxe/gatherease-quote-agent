#!/usr/bin/env bash
#
# scripts/install-host-deps.sh
#
# Host VM 端裝 email-bridge.js 需要的 npm 套件 (imapflow, mailparser, pdf-parse)。
# 直接裝在 workspace/skills/inbox_watch/node_modules/ — email-bridge.js
# 用 absolute path require 同一份 node_modules，避免 repo root 又另開 package.json。
#
# 也順便：line_notify 端 npm install (有用到 @line/bot-sdk express)
#

set -uo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

hr() { echo ""; echo "── $1 ──"; }

hr "1) inbox_watch deps (imapflow + mailparser + pdf-parse) → host"
cd "$REPO_ROOT/workspace/skills/inbox_watch"
if [ ! -f package.json ]; then
  echo '{"name":"inbox_watch","version":"1.0.0","private":true}' > package.json
fi
npm install --no-audit --no-fund imapflow mailparser 2>&1 | tail -5
# pdf-parse 用 1.1.1 (有 module.parent guard)
npm install --no-audit --no-fund pdf-parse@1.1.1 2>&1 | tail -5
echo "✓ installed at $(pwd)/node_modules/"
ls -d node_modules/imapflow node_modules/mailparser 2>&1

hr "2a) read_drawing deps (pdf-to-png-converter) → host"
cd "$REPO_ROOT/workspace/skills/read_drawing"
if [ ! -f package.json ]; then
  echo '{"name":"read_drawing","version":"1.0.0","private":true}' > package.json
fi
npm install --no-audit --no-fund pdf-to-png-converter 2>&1 | tail -5
ls -d node_modules/pdf-to-png-converter 2>&1

hr "2) line_notify deps (@line/bot-sdk + express) → host"
cd "$REPO_ROOT/skills/line_notify" 2>/dev/null || cd "$REPO_ROOT/workspace/skills/line_notify"
if [ ! -f package.json ]; then
  echo '{"name":"line_notify","version":"1.0.0","private":true}' > package.json
fi
npm install --no-audit --no-fund @line/bot-sdk express 2>&1 | tail -5
echo "✓ installed at $(pwd)/node_modules/"

hr "3) Verify imports work"
cd "$REPO_ROOT"
node -e "
const p = require('path');
const nm = p.join(__dirname, 'workspace/skills/inbox_watch/node_modules');
try {
  const { ImapFlow } = require(p.join(nm, 'imapflow'));
  const { simpleParser } = require(p.join(nm, 'mailparser'));
  console.log('✓ imapflow + mailparser load OK');
} catch (e) {
  console.error('✗ require failed:', e.message);
  process.exit(1);
}
"

hr "DONE"
echo ""
echo "下一步：重啟 email-bridge"
echo "  pkill -f email-bridge.js"
echo "  nohup node scripts/email-bridge.js > /tmp/email-bridge.log 2>&1 &"
echo "  sleep 3 && tail -10 /tmp/email-bridge.log   # 應該不再 require fail"
