#!/usr/bin/env bash
#
# scripts/start-all.sh — 一鍵啟動 host VM 所有 service
#
# 起：
#   ./scripts/start-all.sh
#
# 停：
#   pkill -f demo-mirror-server.js
#   pkill -f email-bridge.js
#   pkill -f line_notify/webhook.js
#

set -uo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

if [ ! -f .env ]; then
  echo "❌ .env not found in $REPO_ROOT — required for GMAIL/LINE/NVIDIA secrets"
  exit 1
fi

set -a; source .env; set +a

# 確保 sandbox workspace .env 有 BRIDGE_MODE=outbox（讓 sandbox 內 skill 走 bridge）
echo "▶ Ensuring BRIDGE_MODE=outbox in sandbox workspace/.env"
SANDBOX="${NEMOCLAW_SANDBOX:-gatherease-quote-agent}"
ENV_TMP=$(mktemp)
cat .env > "$ENV_TMP"
grep -q '^BRIDGE_MODE=' "$ENV_TMP" || echo "BRIDGE_MODE=outbox" >> "$ENV_TMP"
B64=$(base64 -w0 "$ENV_TMP" 2>/dev/null || base64 "$ENV_TMP" | tr -d '\n')
nemoclaw "$SANDBOX" exec -- bash -c "echo $B64 | base64 -d > /sandbox/.openclaw/workspace/.env && chmod 600 /sandbox/.openclaw/workspace/.env"
rm -f "$ENV_TMP"

# 1. demo-mirror-server (port 8000)
echo ""
echo "▶ Starting demo-mirror-server (HTML + agent trigger)"
pkill -f demo-mirror-server.js 2>/dev/null || true
sleep 1
nohup node scripts/demo-mirror-server.js > /tmp/mirror.log 2>&1 &
MIRROR_PID=$!
echo "  PID $MIRROR_PID → /tmp/mirror.log"

# 2. email-bridge (host SMTP/IMAP)
echo ""
echo "▶ Starting email-bridge (SMTP/IMAP for sandbox)"
pkill -f email-bridge.js 2>/dev/null || true
sleep 1
nohup node scripts/email-bridge.js > /tmp/email-bridge.log 2>&1 &
BRIDGE_PID=$!
echo "  PID $BRIDGE_PID → /tmp/email-bridge.log"

# 3. LINE webhook (port 3000)
echo ""
echo "▶ Starting LINE webhook"
pkill -f "line_notify/webhook" 2>/dev/null || true
sleep 1
nohup node skills/line_notify/webhook.js > /tmp/line-webhook.log 2>&1 &
LINE_PID=$!
echo "  PID $LINE_PID → /tmp/line-webhook.log"

sleep 3

echo ""
echo "════════════════════════════════════════════════════════"
echo "  ✅ All services started"
echo "════════════════════════════════════════════════════════"
echo ""
echo "  Mirror server:   http://localhost:8000/factory-quote-demo.html"
echo "                   PID $MIRROR_PID  log /tmp/mirror.log"
echo "  Email bridge:    PID $BRIDGE_PID  log /tmp/email-bridge.log"
echo "  LINE webhook:    PID $LINE_PID  log /tmp/line-webhook.log  (port 3000)"
echo ""
echo "  Tail all:"
echo "    tail -f /tmp/mirror.log /tmp/email-bridge.log /tmp/line-webhook.log"
echo ""
echo "  Test:"
echo "    ./scripts/test-bridge.sh"
echo ""
echo "  Stop all:"
echo "    pkill -f demo-mirror-server.js; pkill -f email-bridge.js; pkill -f 'line_notify/webhook'"
echo ""
