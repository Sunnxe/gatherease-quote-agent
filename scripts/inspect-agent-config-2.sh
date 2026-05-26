#!/usr/bin/env bash
#
# scripts/inspect-agent-config-2.sh
#
# 第一輪 inspect 抓到 config 在 /sandbox/.openclaw/openclaw.json
# agents.defaults 內，但 toolCount=1 兩個嫌疑犯：
#   - "skipBootstrap": true   ← 可能跳過 exec/file_read 註冊
#   - "tools.toolSearch": true ← 強制 wrapper
#
# 這個 script 撈：
#   - openclaw agent --help (singular)
#   - openclaw configure --help
#   - openclaw docs search "tools" / "skipBootstrap" / "capabilities"
#   - models.json 內容
#   - 上一次 session 開頭的 SystemMessage（看 prompt 內到底列了哪些 tool）
#

set -uo pipefail
SANDBOX="${NEMOCLAW_SANDBOX:-gatherease-quote-agent}"
hr() { echo ""; echo "════════ $1 ════════"; }

hr "1) openclaw agent --help (singular)"
nemoclaw "$SANDBOX" exec -- openclaw agent --help 2>&1 | head -60

hr "2) openclaw configure --help"
nemoclaw "$SANDBOX" exec -- openclaw configure --help 2>&1 | head -40

hr "3) openclaw config --help (sub)"
nemoclaw "$SANDBOX" exec -- openclaw config --help 2>&1 | head -40

hr "4) openclaw approvals --help (exec approvals)"
nemoclaw "$SANDBOX" exec -- openclaw approvals --help 2>&1 | head -30

hr "5) openclaw capability --help"
nemoclaw "$SANDBOX" exec -- openclaw capability --help 2>&1 | head -30

hr "6) openclaw docs search 'tools'"
nemoclaw "$SANDBOX" exec -- openclaw docs search tools 2>&1 | head -50

hr "7) openclaw docs search 'skipBootstrap'"
nemoclaw "$SANDBOX" exec -- openclaw docs search skipBootstrap 2>&1 | head -40

hr "8) openclaw docs search 'capabilities'"
nemoclaw "$SANDBOX" exec -- openclaw docs search capabilities 2>&1 | head -40

hr "9) openclaw docs search 'exec'"
nemoclaw "$SANDBOX" exec -- openclaw docs search exec 2>&1 | head -40

hr "10) openclaw docs search 'bootstrap'"
nemoclaw "$SANDBOX" exec -- openclaw docs search bootstrap 2>&1 | head -40

hr "11) /sandbox/.openclaw/agents/main/agent/models.json"
nemoclaw "$SANDBOX" exec -- cat /sandbox/.openclaw/agents/main/agent/models.json 2>&1

hr "12) 最新 session 開頭 SystemMessage (看 prompt 內 tool 列表)"
LATEST=$(nemoclaw "$SANDBOX" exec -- ls -t /sandbox/.openclaw/agents/main/sessions/ 2>&1 | grep '\.jsonl$' | grep -v trajectory | head -1)
echo "session: $LATEST"
if [ -n "$LATEST" ]; then
  nemoclaw "$SANDBOX" exec -- head -1 "/sandbox/.openclaw/agents/main/sessions/$LATEST" 2>&1 | head -c 4000
  echo ""
fi

hr "13) 最新 trajectory.jsonl 開頭 (看 runtime tool catalog)"
LATEST_TRAJ=$(nemoclaw "$SANDBOX" exec -- ls -t /sandbox/.openclaw/agents/main/sessions/ 2>&1 | grep '\.trajectory.jsonl$' | head -1)
echo "trajectory: $LATEST_TRAJ"
if [ -n "$LATEST_TRAJ" ]; then
  echo ""
  echo "── grep toolCount / tool_search / capabilities ──"
  nemoclaw "$SANDBOX" exec -- head -5 "/sandbox/.openclaw/agents/main/sessions/$LATEST_TRAJ" 2>&1 | head -c 4000
  echo ""
fi

hr "DONE"
echo ""
echo "把 1-13 結果貼回 Claude，他會根據 doc 結果寫精確 fix（toolSearch=false + skipBootstrap=false + 真有需要再加 tools.allow）"
