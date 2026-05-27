#!/usr/bin/env bash
#
# scripts/start-all.sh — 一鍵啟動 host VM 所有 service
#
# 起：
#   ./scripts/start-all.sh              # 跑全套（deploy + start）
#   ./scripts/start-all.sh --no-deploy  # 跳過 deploy
#   ./scripts/start-all.sh --reset      # 先清 sandbox 資料再起
#
# 停：
#   pkill -f demo-mirror-server.js
#   pkill -f email-bridge.js
#   pkill -f line_notify/webhook.js
#

set -uo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$(pwd)"

SKIP_DEPLOY=0
DO_RESET=0
for arg in "$@"; do
  case "$arg" in
    --no-deploy) SKIP_DEPLOY=1 ;;
    --reset)     DO_RESET=1 ;;
    *) echo "Unknown arg: $arg"; exit 1 ;;
  esac
done

if [ ! -f .env ]; then
  echo "❌ .env not found in $REPO_ROOT — required for GMAIL/LINE/NVIDIA secrets"
  exit 1
fi

set -a; source .env; set +a

echo "════════════════════════════════════════════════════"
echo "  🚀 GatherEase Demo · One-Shot Startup"
echo "════════════════════════════════════════════════════"
echo "  Env check："
for v in GMAIL_USER GMAIL_APP_PASSWORD LINE_CHANNEL_ACCESS_TOKEN LINE_BOSS_USER_ID NVIDIA_API_KEY; do
  if [ -z "${!v:-}" ]; then
    echo "    ⚠️  $v 沒設 (可能跑出 degraded 模式)"
  else
    echo "    ✓ $v set"
  fi
done

# Reset sandbox（option --reset）
SANDBOX="${NEMOCLAW_SANDBOX:-gatherease-quote-agent}"
if [ "$DO_RESET" = "1" ]; then
  echo ""
  echo "▶ Reset sandbox (清 sessions/orders/inbox/line pending)..."
  nemoclaw "$SANDBOX" exec -- bash -c '
    rm -f /sandbox/.openclaw/agents/main/sessions/*.jsonl
    rm -f /sandbox/.openclaw/workspace/data/orders/*.json
    rm -f /sandbox/.openclaw/workspace/data/inbox/*.json
    rm -f /sandbox/.openclaw/workspace/skills/line_notify/pending/*.json
    mkdir -p /sandbox/.openclaw/workspace/data/outbox/failed
    mv /sandbox/.openclaw/workspace/data/outbox/*.json /sandbox/.openclaw/workspace/data/outbox/failed/ 2>/dev/null || true
    echo "  ✓ sandbox cleared"
  ' < /dev/null
fi

# Deploy skills（除非 --no-deploy）
if [ "$SKIP_DEPLOY" = "0" ]; then
  echo ""
  echo "▶ Deploy skills + AGENTS.md to sandbox..."
  bash scripts/deploy-skills-to-workspace.sh 2>&1 | tail -10
fi

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

# 4. Cloudflared quick tunnel — 暴露 :3000 給 LINE Messaging API
echo ""
echo "▶ Starting Cloudflared quick tunnel (公開 :3000 給 LINE webhook)"
# 只殺 quick tunnel (--url mode)，不殺 named tunnel (token mode)
pkill -f "cloudflared tunnel --url" 2>/dev/null || true
sleep 1
rm -f /tmp/cf-quick.log
nohup cloudflared tunnel --url http://localhost:3000 > /tmp/cf-quick.log 2>&1 &
CF_PID=$!
echo "  PID $CF_PID → /tmp/cf-quick.log"

# 等 cloudflared 註冊好 trycloudflare URL（通常 5-15 秒）
echo "  ⏳ 等 cloudflared 註冊 quick tunnel URL..."
CF_URL=""
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  sleep 2
  CF_URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/cf-quick.log 2>/dev/null | head -1)
  if [ -n "$CF_URL" ]; then break; fi
done
if [ -n "$CF_URL" ]; then
  echo "  ✓ public URL: $CF_URL"
else
  echo "  ⚠️  $((i*2))s 內沒拿到 URL，看 /tmp/cf-quick.log debug"
fi

sleep 2

# Health check 確認各 service 真的活著
echo ""
echo "▶ Health check..."
HEALTH_OK=1
if kill -0 "$MIRROR_PID" 2>/dev/null; then
  curl -sf http://localhost:8000/api/health > /dev/null 2>&1 && echo "  ✓ mirror :8000 alive" || { echo "  ✗ mirror health 失敗"; HEALTH_OK=0; }
else
  echo "  ✗ mirror process died — see /tmp/mirror.log"; HEALTH_OK=0
fi
if kill -0 "$BRIDGE_PID" 2>/dev/null; then
  grep -q 'email-bridge starting' /tmp/email-bridge.log 2>/dev/null && echo "  ✓ email-bridge alive" || echo "  ⚠ email-bridge 沒看到 starting log"
else
  echo "  ✗ email-bridge process died — see /tmp/email-bridge.log"; HEALTH_OK=0
fi
if kill -0 "$LINE_PID" 2>/dev/null; then
  curl -sf http://localhost:3000/health > /dev/null 2>&1 && echo "  ✓ line webhook :3000 alive" || echo "  ⚠ line webhook 沒回 (但 process 還在)"
else
  echo "  ✗ line webhook process died — see /tmp/line-webhook.log"; HEALTH_OK=0
fi
if [ -n "$CF_URL" ] && kill -0 "$CF_PID" 2>/dev/null; then
  echo "  ✓ cloudflared quick tunnel alive: $CF_URL"
else
  echo "  ⚠ cloudflared quick tunnel 沒回 URL — LINE callback 會收不到"
fi

echo ""
echo "════════════════════════════════════════════════════════"
if [ "$HEALTH_OK" = "1" ]; then
  echo "  ✅ All services started"
else
  echo "  ⚠️  Some services may be down. Check logs above."
fi
echo "════════════════════════════════════════════════════════"
echo ""
echo "  Mirror server:   http://localhost:8000/factory-quote-demo.html"
echo "                   PID $MIRROR_PID  log /tmp/mirror.log"
echo "  Email bridge:    PID $BRIDGE_PID  log /tmp/email-bridge.log"
echo "  LINE webhook:    PID $LINE_PID  log /tmp/line-webhook.log  (port 3000)"
echo "  CF quick tunnel: PID $CF_PID  log /tmp/cf-quick.log"
echo ""
if [ -n "$CF_URL" ]; then
  echo "  ╔══════════════════════════════════════════════════════╗"
  echo "  ║  📋 重要 — 把這條 URL 貼到 LINE Console webhook：     ║"
  echo "  ╠══════════════════════════════════════════════════════╣"
  echo "  ║                                                       ║"
  echo "  ║  $CF_URL/webhook/line"
  echo "  ║                                                       ║"
  echo "  ║  位置：LINE Developers → Channel → Messaging API     ║"
  echo "  ║       → Webhook URL → 貼 → Verify → Use webhook ON   ║"
  echo "  ║                                                       ║"
  echo "  ║  ⚠️  每次 restart 這個 URL 會變、要重貼               ║"
  echo "  ╚══════════════════════════════════════════════════════╝"
  echo ""
fi
echo "  Tail all:"
echo "    tail -f /tmp/mirror.log /tmp/email-bridge.log /tmp/line-webhook.log /tmp/cf-quick.log"
echo ""
echo "  Test:"
echo "    ./scripts/test-bridge.sh"
echo ""
echo "  Stop all:"
echo "    pkill -f demo-mirror-server.js; pkill -f email-bridge.js; pkill -f 'line_notify/webhook'"
echo ""
