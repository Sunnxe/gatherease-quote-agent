#!/usr/bin/env bash
#
# scripts/fix-agent-tools.sh
#
# 根據 inspect-agent-config.sh 結果：
#   - agents.defaults.skipBootstrap=true ← 跳過內建 tool 註冊 (exec/file_read/file_write)
#   - tools.toolSearch=true               ← 強制只有 tool_search_code wrapper
#   - agents/main/agent/ 內無 per-agent override
#
# 改三件事：
#   1. agents.defaults.skipBootstrap → false  (註冊內建工具)
#   2. tools.toolSearch → false               (直接暴露給 LLM)
#   3. agents.defaults.timeoutSeconds 確認 ≥ 300 (現在 600 OK)
#
# 用 base64 + python 寫進 sandbox，避開 nemoclaw exec newline bug。
#

set -euo pipefail
SANDBOX="${NEMOCLAW_SANDBOX:-gatherease-quote-agent}"
CFG="/sandbox/.openclaw/openclaw.json"

echo "▶ Sandbox: $SANDBOX"
echo "▶ Config:  $CFG"
echo ""

# ─── Python script: 改 3 個 flag + verify ──
PYSCRIPT=$(cat <<'PYEOF'
import json, sys
PATH = "/sandbox/.openclaw/openclaw.json"
with open(PATH) as f:
    cfg = json.load(f)

# Before
agents_defaults = cfg.setdefault("agents", {}).setdefault("defaults", {})
tools_block = cfg.setdefault("tools", {})

before_skip = agents_defaults.get("skipBootstrap", "(not set)")
before_search = tools_block.get("toolSearch", "(not set)")
before_timeout = agents_defaults.get("timeoutSeconds", "(not set)")

# After
agents_defaults["skipBootstrap"] = False
tools_block["toolSearch"] = False
if not isinstance(agents_defaults.get("timeoutSeconds"), (int, float)) or agents_defaults["timeoutSeconds"] < 300:
    agents_defaults["timeoutSeconds"] = 600

with open(PATH, "w") as f:
    json.dump(cfg, f, indent=2)

print("┌─ before → after ─")
print(f"│ agents.defaults.skipBootstrap:    {before_skip} -> False")
print(f"│ tools.toolSearch:                 {before_search} -> False")
print(f"│ agents.defaults.timeoutSeconds:   {before_timeout} -> {agents_defaults['timeoutSeconds']}")
print("└─")
PYEOF
)

B64=$(echo -n "$PYSCRIPT" | base64 -w0 2>/dev/null || echo -n "$PYSCRIPT" | base64 | tr -d '\n')

echo "▶ 1) Backup current config"
nemoclaw "$SANDBOX" exec -- cp -v "$CFG" "${CFG}.before-fix-tools.$(date +%s)"
echo ""

echo "▶ 2) Write fix script to /tmp/fix_tools.py (base64 + single-line bash -c)"
nemoclaw "$SANDBOX" exec -- bash -c "echo $B64 | base64 -d > /tmp/fix_tools.py"
echo ""

echo "▶ 3) Run fix script"
nemoclaw "$SANDBOX" exec -- python3 /tmp/fix_tools.py
echo ""

echo "▶ 4) Verify 改完的 config (single-line python -c)"
nemoclaw "$SANDBOX" exec -- python3 -c "import json; d=json.load(open('$CFG')); ag=d.get('agents',{}).get('defaults',{}); t=d.get('tools',{}); print('skipBootstrap =', ag.get('skipBootstrap'), '| toolSearch =', t.get('toolSearch'), '| timeoutSeconds =', ag.get('timeoutSeconds'))"
echo ""

echo "▶ 5) Recover gateway"
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
echo "✅ Fix 套用完成"
echo "════════════════════════════════════════════════════════"
echo ""
echo "下一步："
echo "  1. 觸發 agent: 瀏覽器 http://localhost:8000/factory-quote-demo.html → 點「📦 列訂單」"
echo "  2. 等 5-10 秒 sandbox 新 session jsonl 出現"
echo "  3. tail 新 session 看 toolCount："
echo "     LATEST=\$(nemoclaw $SANDBOX exec -- ls -t /sandbox/.openclaw/agents/main/sessions/ | grep .trajectory.jsonl | head -1)"
echo "     nemoclaw $SANDBOX exec -- head -3 /sandbox/.openclaw/agents/main/sessions/\$LATEST | grep -oE 'toolCount\":[0-9]+'"
echo ""
echo "  期望結果：toolCount > 1 (應該至少 10+ — exec + 10 workspace skills)"
echo ""
echo "Rollback:"
echo "  nemoclaw $SANDBOX exec -- ls /sandbox/.openclaw/openclaw.json.before-fix-tools.*"
echo "  nemoclaw $SANDBOX exec -- cp <backup> /sandbox/.openclaw/openclaw.json"
echo "  nemoclaw $SANDBOX recover"
