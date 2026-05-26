#!/usr/bin/env bash
#
# scripts/debug-agent-session.sh
#
# 為什麼 Agent Thinking 面板顯示「等 agent 跑起來... session 還沒建」
# 但你 cat session jsonl 看明明有東西？這個 script 一步步診斷。
#

set -uo pipefail
SANDBOX="${NEMOCLAW_SANDBOX:-gatherease-quote-agent}"
MIRROR_PORT="${MIRROR_PORT:-8000}"

hr() { echo ""; echo "──── $1 ────"; }

hr "1) mirror server 跑著嗎"
if curl -fsS "http://localhost:${MIRROR_PORT}/api/health" >/dev/null 2>&1; then
  curl -s "http://localhost:${MIRROR_PORT}/api/health" | python3 -m json.tool
else
  echo "❌ mirror server NOT responding on port $MIRROR_PORT"
  echo "   啟動：./scripts/start-demo-mirror.sh"
  exit 1
fi

hr "2) git: mirror server code 是最新的嗎"
cd "$(dirname "$0")/.."
if grep -q "/api/agent-session" scripts/demo-mirror-server.js; then
  echo "✓ demo-mirror-server.js 內有 /api/agent-session endpoint"
else
  echo "❌ mirror server code 沒有 /api/agent-session endpoint！git pull?"
  exit 1
fi

hr "3) /api/agent-session 直接打看結果"
curl -s "http://localhost:${MIRROR_PORT}/api/agent-session" | python3 -m json.tool || echo "❌ endpoint 回 error"

hr "4) sandbox 內 session 檔列表"
nemoclaw "$SANDBOX" exec -- bash -c '
ls -t /sandbox/.openclaw/agents/main/sessions/ 2>/dev/null | head -10
echo ""
echo "最新 jsonl："
LATEST=$(ls -t /sandbox/.openclaw/agents/main/sessions/*.jsonl 2>/dev/null | head -1)
echo "  $LATEST"
if [ -n "$LATEST" ]; then
  echo "  size: $(wc -c < "$LATEST") bytes"
  echo "  lines: $(wc -l < "$LATEST")"
fi
'

hr "5) tail 最新 session jsonl 看內容 (前 5 行)"
nemoclaw "$SANDBOX" exec -- bash -c '
LATEST=$(ls -t /sandbox/.openclaw/agents/main/sessions/*.jsonl 2>/dev/null | head -1)
[ -n "$LATEST" ] && head -5 "$LATEST"
'

hr "6) mirror cache 內 agent-session 是不是 stale"
echo "重啟 mirror server 清 cache："
echo "  pkill -f demo-mirror-server.js && ./scripts/start-demo-mirror.sh &"

hr "7) HTML 端 console"
echo "用 browser DevTools console："
echo "  fetch('/api/agent-session').then(r=>r.json()).then(console.log)"
