#!/usr/bin/env bash
#
# scripts/disable-tool-search.sh (v2 — avoid newline in nemoclaw exec args)
#
# 解決 agent 卡在 tool_search_code wrapper 的問題。
#
# nemoclaw exec grpc 不接受帶 newline 的 args，所以不能用 bash -c '<heredoc>'。
# 改法：host 端先 base64 encode python script → nemoclaw exec 用 single-line
# echo + base64 -d 寫進 sandbox /tmp → 再 nemoclaw exec python3 跑那個檔。
#

set -euo pipefail
SANDBOX="${NEMOCLAW_SANDBOX:-gatherease-quote-agent}"
CFG="/sandbox/.openclaw/openclaw.json"

echo "▶ Sandbox: $SANDBOX"
echo "▶ Config:  $CFG"
echo ""

# ─── Python script 內容（host 端 here-doc 沒事，等下會 base64） ──
PYSCRIPT=$(cat <<'PYEOF'
import json, sys
PATH = "/sandbox/.openclaw/openclaw.json"
with open(PATH) as f:
    cfg = json.load(f)
tools = cfg.setdefault("tools", {})
prev = tools.get("toolSearch", "(not set, default=true)")
tools["toolSearch"] = False
with open(PATH, "w") as f:
    json.dump(cfg, f, indent=2)
print(f"  tools.toolSearch: {prev} -> False")
print(f"  total top-level keys: {list(cfg.keys())}")
PYEOF
)

# base64 encode (single line)
B64=$(echo -n "$PYSCRIPT" | base64 -w0 2>/dev/null || echo -n "$PYSCRIPT" | base64 | tr -d '\n')

echo "▶ 1) Backup current config (sandbox 內)"
nemoclaw "$SANDBOX" exec -- cp -v "$CFG" "${CFG}.before-toolsearch-disable.$(date +%s)"
echo ""

echo "▶ 2) 把 python script base64 → 寫 /tmp/disable_toolsearch.py"
nemoclaw "$SANDBOX" exec -- bash -c "echo $B64 | base64 -d > /tmp/disable_toolsearch.py"
echo ""

echo "▶ 3) 跑 python script (改 config)"
nemoclaw "$SANDBOX" exec -- python3 /tmp/disable_toolsearch.py
echo ""

echo "▶ 4) Verify 改完 (single-line python -c)"
nemoclaw "$SANDBOX" exec -- python3 -c "import json; d=json.load(open('$CFG')); print('tools.toolSearch =', d.get('tools',{}).get('toolSearch'))"
echo ""

echo "▶ 5) Recover gateway 讓 config 生效"
nemoclaw "$SANDBOX" recover
echo ""

echo "▶ 6) Verify gateway healthy"
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
echo "下一步：HTML 內按 'Trigger Agent' 試："
echo "  http://localhost:8000/factory-quote-demo.html"
echo "  輸入：請列出當前所有訂單"
echo ""
echo "agent 現在應該直接 call \`order_store\` skill 而不是進 tool_search_code loop。"
echo ""
echo "如果想 rollback："
echo "  nemoclaw $SANDBOX exec -- ls /sandbox/.openclaw/"
echo "  nemoclaw $SANDBOX exec -- cp /sandbox/.openclaw/openclaw.json.before-toolsearch-disable.<ts> /sandbox/.openclaw/openclaw.json"
echo "  nemoclaw $SANDBOX recover"
echo ""
