#!/usr/bin/env bash
#
# scripts/deploy-skills-to-workspace.sh
#
# `nemoclaw skill install` 把 skill 裝到 managed scope (~/.openclaw/skills/)，
# 但 agent exec tool 看不到那個位置——只看 workspace scope。
#
# 這個 script 改成把 skill 直接寫進 sandbox 的
# /sandbox/.openclaw/workspace/skills/<name>/，agent 才看得到。
#
# 用 base64 + nemoclaw exec 寫檔（避開 newline / quote 問題）。
#

set -euo pipefail
cd "$(dirname "$0")/.."

SANDBOX="${NEMOCLAW_SANDBOX:-gatherease-quote-agent}"
SANDBOX_WS="/sandbox/.openclaw/workspace"
SANDBOX_SKILLS="$SANDBOX_WS/skills"

SKILLS=(order_store read_drawing get_history_quote check_schedule calc_cost compare_suppliers line_notify send_email generate_quote_pdf inbox_watch)

echo "▶ Sanity check"
nemoclaw "$SANDBOX" connect --probe-only
echo ""

echo "▶ 確保 sandbox workspace/skills/ dir 存在"
nemoclaw "$SANDBOX" exec -- mkdir -p "$SANDBOX_SKILLS"
echo ""

# 把每個 skill dir 內的 file 一個一個寫到 sandbox workspace
for skill in "${SKILLS[@]}"; do
  local_dir="workspace/skills/$skill"
  remote_dir="$SANDBOX_SKILLS/$skill"

  if [ ! -d "$local_dir" ]; then
    echo "  ⚠️  $local_dir 不存在，skip"
    continue
  fi

  echo "▶ Deploying $skill → $remote_dir"
  nemoclaw "$SANDBOX" exec -- mkdir -p "$remote_dir"

  # 找所有 source files（不要 node_modules / package*.json，那些 cli.sh lazy install）
  while IFS= read -r f; do
    rel="${f#$local_dir/}"
    case "$rel" in
      node_modules*|package.json|package-lock.json|.gitkeep) continue ;;
    esac
    if [ -f "$f" ]; then
      # 確保目標子目錄存在
      parent=$(dirname "$rel")
      if [ "$parent" != "." ]; then
        nemoclaw "$SANDBOX" exec -- mkdir -p "$remote_dir/$parent"
      fi
      B64=$(base64 -w0 "$f" 2>/dev/null || base64 "$f" | tr -d '\n')
      size=$(wc -c < "$f")
      echo "  → $rel ($size bytes)"
      nemoclaw "$SANDBOX" exec -- bash -c "echo '$B64' | base64 -d > '$remote_dir/$rel'"
    fi
  done < <(find "$local_dir" -type f)

  # cli.sh 要 executable
  nemoclaw "$SANDBOX" exec -- chmod +x "$remote_dir/cli.sh"
done

echo ""
echo "▶ 也把 workspace 5 個 .md + .env 寫進 sandbox"
for md in AGENTS.md SOUL.md IDENTITY.md USER.md TOOLS.md; do
  if [ -f "workspace/$md" ]; then
    B64=$(base64 -w0 "workspace/$md" 2>/dev/null || base64 "workspace/$md" | tr -d '\n')
    echo "  → $SANDBOX_WS/$md"
    nemoclaw "$SANDBOX" exec -- bash -c "echo '$B64' | base64 -d > '$SANDBOX_WS/$md'"
  fi
done

if [ -f .env ]; then
  B64=$(base64 -w0 .env 2>/dev/null || base64 .env | tr -d '\n')
  echo "  → $SANDBOX_WS/.env (chmod 600)"
  nemoclaw "$SANDBOX" exec -- bash -c "echo '$B64' | base64 -d > '$SANDBOX_WS/.env' && chmod 600 '$SANDBOX_WS/.env'"
fi

echo ""
echo "▶ Verify sandbox workspace/skills/ 內容"
nemoclaw "$SANDBOX" exec -- ls -la "$SANDBOX_SKILLS/"
echo ""

echo "▶ 試跑一個 skill 直接從 workspace 路徑"
nemoclaw "$SANDBOX" exec -- bash -c "echo '{\"action\":\"list\"}' | bash $SANDBOX_SKILLS/order_store/cli.sh" 2>&1 | head -5
echo ""

echo "════════════════════════════════════════════════════════"
echo "✅ Skills 寫進 workspace/skills/ 完成"
echo ""
echo "下一步：dashboard chat 開新 session 試："
echo "  /new"
echo "  請列出當前所有訂單"
echo ""
echo "或在 chat 內直接要 agent 用 absolute path："
echo "  請用 exec tool 跑：bash $SANDBOX_SKILLS/order_store/cli.sh"
echo "  stdin: {\"action\":\"list\"}"
echo "════════════════════════════════════════════════════════"
