#!/usr/bin/env bash
#
# scripts/inspect-agent-config.sh
#
# 撈 sandbox 內所有 agent 相關 config + tool list。
#
# 根因：trajectory 顯示 toolCount=1 (只有 tool_search_code wrapper)，
# agent 沒有 exec/file_read/file_write 能力。AGENTS.md 教它跑 `exec bash skills/.../cli.sh`
# 它根本沒這把工具，只好用 tool_search_code 寫 JS 鬼打牆 15 次。
#
# 這個 script 把所有設定貼出來，看 schema 在哪裡加 tools/capabilities。
#

set -uo pipefail
SANDBOX="${NEMOCLAW_SANDBOX:-gatherease-quote-agent}"

hr() { echo ""; echo "════════ $1 ════════"; }

hr "1) openclaw version"
nemoclaw "$SANDBOX" exec -- openclaw --version 2>&1 || echo "no --version"

hr "2) openclaw agents list"
nemoclaw "$SANDBOX" exec -- openclaw agents list 2>&1 || echo "agents list 失敗"

hr "3) openclaw agents show main"
nemoclaw "$SANDBOX" exec -- openclaw agents show main 2>&1 || echo "no show subcommand"

hr "4) openclaw tools list (全部可用 tools)"
nemoclaw "$SANDBOX" exec -- openclaw tools list 2>&1 | head -40 || echo "no tools list"

hr "5) openclaw config show"
nemoclaw "$SANDBOX" exec -- openclaw config show 2>&1 | head -80 || echo "no config show"

hr "6) /sandbox/.openclaw/openclaw.json 完整內容"
nemoclaw "$SANDBOX" exec -- cat /sandbox/.openclaw/openclaw.json 2>&1

hr "7) /sandbox/.openclaw/agents/ 目錄結構"
nemoclaw "$SANDBOX" exec -- ls -laR /sandbox/.openclaw/agents/ 2>&1 | head -60

hr "8) /sandbox/.openclaw/agents/main/ 內所有 config 檔 (cat)"
nemoclaw "$SANDBOX" exec -- ls /sandbox/.openclaw/agents/main/ 2>&1 | grep -E '\.(json|yaml|yml|toml)$' | while read f; do
  echo "── $f ──"
  nemoclaw "$SANDBOX" exec -- cat "/sandbox/.openclaw/agents/main/$f" 2>&1
  echo ""
done

hr "9) workspace .md 檔 agent 是否真的讀到 (寫個 marker 看)"
nemoclaw "$SANDBOX" exec -- ls -la /sandbox/.openclaw/workspace/ 2>&1

hr "10) openclaw --help (找 agent config / tools 相關 subcommand)"
nemoclaw "$SANDBOX" exec -- openclaw --help 2>&1 | head -50

hr "11) openclaw agents --help"
nemoclaw "$SANDBOX" exec -- openclaw agents --help 2>&1 | head -30

hr "12) openclaw tools --help"
nemoclaw "$SANDBOX" exec -- openclaw tools --help 2>&1 | head -30

hr "DONE"
echo ""
echo "把以上所有輸出貼給 Claude，他會根據你 sandbox 真實 schema 寫 fix script："
echo "  - 在 agent config 加 exec / file_read / file_write tool"
echo "  - 把 inference timeout 從 60s 拉到 300s"
echo ""
