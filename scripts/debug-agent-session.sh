#!/usr/bin/env bash
#
# scripts/debug-agent-session.sh (v2 — no bash -c multi-line)
#
# 為什麼 Agent Thinking 面板顯示「等 agent 跑起來... session 還沒建」？
# 這個 script 一步步診斷。
#
# nemoclaw exec grpc 不接受帶 newline 的 args，所以這 script 不再用 bash -c '<multi-line>'。
#

set -uo pipefail
SANDBOX="${NEMOCLAW_SANDBOX:-gatherease-quote-agent}"
MIRROR_PORT="${MIRROR_PORT:-8000}"
SESSIONS_DIR="/sandbox/.openclaw/agents/main/sessions"

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

hr "4) sandbox 內 sessions dir 內容 (ls 不用 bash -c)"
nemoclaw "$SANDBOX" exec -- ls -la "$SESSIONS_DIR" 2>&1 | head -20

hr "5) 列出 .jsonl 檔（host 端 sort 挑最新）"
SESSION_FILES=$(nemoclaw "$SANDBOX" exec -- ls -t "$SESSIONS_DIR" 2>&1 | grep '\.jsonl$' || true)
if [ -z "$SESSION_FILES" ]; then
  echo "❌ 沒有 .jsonl 檔——還沒跑過 session"
  echo "   觸發 agent："
  echo "     curl -X POST http://localhost:${MIRROR_PORT}/api/agent-trigger \\"
  echo "       -H 'Content-Type: application/json' \\"
  echo "       -d '{\"message\":\"請列出當前所有訂單\"}'"
else
  LATEST=$(echo "$SESSION_FILES" | head -1)
  echo "最新：$LATEST"
  echo ""
  echo "── tail 前 5 行 ──"
  nemoclaw "$SANDBOX" exec -- tail -5 "$SESSIONS_DIR/$LATEST"
fi

hr "6) mirror cache + restart 提示"
echo "如果 endpoint 回 stale 或空：清 cache + restart"
echo "  pkill -f demo-mirror-server.js"
echo "  ./scripts/start-demo-mirror.sh &"

hr "7) browser DevTools console"
echo "  fetch('/api/agent-session').then(r=>r.json()).then(console.log)"
