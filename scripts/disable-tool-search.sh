#!/usr/bin/env bash
#
# scripts/disable-tool-search.sh
#
# 解決 agent 卡在 tool_search_code wrapper 的問題。
#
# OpenClaw 預設啟用 tool_search_code wrapper（compact prompt for large tool catalog），
# 但 Nemotron 對這個 wrapper 的 API 抓不到——一直猜 require()/openclaw.tools.call({skill,input})
# 之類錯誤形式，session jsonl 顯示卡 30+ 輪不會脫困。
#
# 官方 doc：
#   "Direct tool exposure is still the right default for small catalogs."
#   set "tools": { "toolSearch": false } 改回 direct exposure
#
# 我們只有 10 個 skill，遠在 small catalog 範圍。
#
# 改完跑 nemoclaw recover 讓 gateway reload config。
#

set -euo pipefail
SANDBOX="${NEMOCLAW_SANDBOX:-gatherease-quote-agent}"
CFG="/sandbox/.openclaw/openclaw.json"

echo "▶ Sandbox: $SANDBOX"
echo "▶ Config:  $CFG"
echo ""

echo "▶ 1) Backup current config"
nemoclaw "$SANDBOX" exec -- cp -v "$CFG" "${CFG}.before-toolsearch-disable.$(date +%s)"
echo ""

echo "▶ 2) 加 tools.toolSearch=false (Python json round-trip)"
nemoclaw "$SANDBOX" exec -- bash -c "python3 <<'EOF'
import json, sys
PATH = '$CFG'
with open(PATH) as f:
    cfg = json.load(f)
tools = cfg.setdefault('tools', {})
prev = tools.get('toolSearch', '(not set, default=true)')
tools['toolSearch'] = False
with open(PATH, 'w') as f:
    json.dump(cfg, f, indent=2)
print(f'  tools.toolSearch: {prev} → False')
print(f'  total config keys: {list(cfg.keys())}')
EOF"
echo ""

echo "▶ 3) Verify 改完的 config"
nemoclaw "$SANDBOX" exec -- bash -c "python3 -c 'import json; d=json.load(open(\"$CFG\")); print(\"tools.toolSearch =\", d.get(\"tools\",{}).get(\"toolSearch\"))'"
echo ""

echo "▶ 4) Recover gateway 讓 config 生效"
nemoclaw "$SANDBOX" recover
echo ""

echo "▶ 5) Verify gateway healthy"
nemoclaw status --json | python3 -c "
import json, sys
d = json.load(sys.stdin)
gw = d.get('gatewayHealth', {})
print(f'  gateway.healthy: {gw.get(\"healthy\")}')
print(f'  gateway.state:   {gw.get(\"state\")}')
"
echo ""

echo "════════════════════════════════════════════════════════"
echo "✅ tool_search wrapper 已停用"
echo "════════════════════════════════════════════════════════"
echo ""
echo "下一步：dashboard chat 開新 session 試："
echo "  /new"
echo "  請列出當前所有訂單"
echo ""
echo "agent 現在應該直接 call \`order_store\` skill 而不是進 tool_search_code loop。"
echo ""
echo "如果想 rollback："
echo "  nemoclaw $SANDBOX exec -- ls /sandbox/.openclaw/openclaw.json.before-*"
echo "  nemoclaw $SANDBOX exec -- cp <backup_file> /sandbox/.openclaw/openclaw.json"
echo "  nemoclaw $SANDBOX recover"
echo ""
