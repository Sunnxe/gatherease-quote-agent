#!/usr/bin/env bash
#
# scripts/deploy-skills.sh
#
# 一鍵把 plan A 階段 2 的成果部署進 OpenClaw sandbox：
#   1. nemoclaw skill install × 6 (read_drawing / get_history_quote / calc_cost /
#                                  compare_suppliers / line_notify / send_email)
#   2. 寫 workspace/AGENTS.md SOUL.md IDENTITY.md USER.md TOOLS.md
#      到 sandbox /sandbox/.openclaw/workspace/
#   3. 寫 host 的 .env 到 sandbox workspace/.env (skill cli.sh 會 source)
#   4. verify: openclaw skills list 應該看到 6 個
#   5. print dashboard URL
#
# 用法：./scripts/deploy-skills.sh
#

set -euo pipefail
cd "$(dirname "$0")/.."

SANDBOX="${NEMOCLAW_SANDBOX:-gatherease-quote-agent}"
SANDBOX_WORKSPACE="/sandbox/.openclaw/workspace"

# ─── Sanity ────────────────────────────────────────────────
if ! command -v nemoclaw >/dev/null 2>&1; then
  echo "❌ nemoclaw CLI not found in PATH"
  exit 1
fi

if [ ! -f .env ]; then
  echo "❌ .env not found in repo root. 應該包含 NVIDIA/LINE/GMAIL 等變數。"
  exit 1
fi

echo "▶ Probing sandbox '$SANDBOX'..."
nemoclaw "$SANDBOX" connect --probe-only
echo "  ✓ sandbox is running"
echo ""

# ─── Step 1: install 6 skills ──────────────────────────────
SKILLS=(order_store read_drawing get_history_quote check_schedule calc_cost compare_suppliers line_notify send_email generate_quote_pdf inbox_watch)

for skill in "${SKILLS[@]}"; do
  skill_path="./workspace/skills/$skill"
  if [ ! -f "$skill_path/SKILL.md" ]; then
    echo "  ⚠️  $skill_path/SKILL.md missing — skip"
    continue
  fi
  if [ ! -x "$skill_path/cli.sh" ]; then
    chmod +x "$skill_path/cli.sh"
  fi
  echo "▶ Installing skill: $skill"
  nemoclaw "$SANDBOX" skill install "$skill_path"
  echo ""
done

# ─── Step 2: upload workspace bootstrap (.md) ──────────────
echo "▶ Uploading workspace bootstrap files..."
for md in AGENTS.md SOUL.md IDENTITY.md USER.md TOOLS.md; do
  src="workspace/$md"
  if [ ! -f "$src" ]; then
    echo "  ⚠️  $src missing — skip"
    continue
  fi
  # base64 encode 避免 nemoclaw exec 拒 newline
  B64=$(base64 -w0 "$src" 2>/dev/null || base64 "$src" | tr -d '\n')
  echo "  → $SANDBOX_WORKSPACE/$md ($(wc -c < "$src") bytes)"
  nemoclaw "$SANDBOX" exec -- bash -c "echo '$B64' | base64 -d > '$SANDBOX_WORKSPACE/$md'"
done
echo ""

# ─── Step 3: upload .env to sandbox workspace ──────────────
echo "▶ Uploading .env (sandbox skill cli.sh 會 source 它拿 NVIDIA/LINE/GMAIL env vars)..."
B64=$(base64 -w0 .env 2>/dev/null || base64 .env | tr -d '\n')
nemoclaw "$SANDBOX" exec -- bash -c "echo '$B64' | base64 -d > '$SANDBOX_WORKSPACE/.env' && chmod 600 '$SANDBOX_WORKSPACE/.env'"
echo "  ✓ .env uploaded (chmod 600)"
echo ""

# ─── Step 4: verify ────────────────────────────────────────
echo "▶ Verifying 6 skills loaded in sandbox..."
LOADED=$(nemoclaw "$SANDBOX" exec -- openclaw skills list 2>&1 | grep -Eo "(read_drawing|get_history_quote|calc_cost|compare_suppliers|line_notify|send_email)" | sort -u || true)
COUNT=$(echo "$LOADED" | grep -cv '^$' || true)
echo "  Found: $LOADED"
echo "  Total: $COUNT / 6"
echo ""

if [ "$COUNT" -lt 6 ]; then
  echo "⚠️  少於 6 個 skill loaded。可能要重啟 gateway："
  echo "    nemoclaw $SANDBOX exec -- openclaw gateway restart"
  echo ""
fi

# ─── Step 5: dashboard URL ─────────────────────────────────
echo "════════════════════════════════════════════════════════"
echo "✅ Deployment complete"
echo "════════════════════════════════════════════════════════"
echo ""
echo "🦞 Dashboard URL (Chat / Sessions / Skills tab 都看得到):"
nemoclaw "$SANDBOX" dashboard-url --quiet
echo ""
echo "🧪 試跑 agent (在 sandbox 內 trigger 一個 user message):"
echo "   nemoclaw $SANDBOX exec -- openclaw agent --agent main -m '處理鴻碩電子的詢價 Anti-Static Silicone Roller × 200, 規格 25×35×600 / 55 Shore A, 10 天交期, 需 ESD 認證'"
echo ""
