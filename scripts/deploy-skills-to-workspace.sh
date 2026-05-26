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
# v3 (2026-05-26)：全部改用 stdin pipe 傳檔，繞過 nemoclaw grpc 32KB arg 限制
#                 (之前 AGENTS.md 變大 24KB+ 寫不進去)。
#

set -euo pipefail
cd "$(dirname "$0")/.."

SANDBOX="${NEMOCLAW_SANDBOX:-gatherease-quote-agent}"
SANDBOX_WS="/sandbox/.openclaw/workspace"
SANDBOX_SKILLS="$SANDBOX_WS/skills"

SKILLS=(order_store read_drawing get_history_quote check_schedule calc_cost compare_suppliers line_notify send_email generate_quote_pdf inbox_watch)

# _lib 是 shared helper (order_writeback.js)，每個 skill 都 require 它
LIB_DIR_NAME="_lib"

# ─── 核心 helper：用 stdin pipe 傳 base64 寫進 sandbox ───
# 之前用 `bash -c "echo '$B64' | base64 -d > ..."` 把 B64 包成 arg → grpc 32KB 上限。
# 改成 `printf '%s' "$B64" | nemoclaw exec -- bash -c "base64 -d > ..."` → B64 走 stdin、arg 只剩 30 bytes。
deploy_file_to_sandbox() {
  local src_file="$1"
  local dest_path="$2"
  if [ ! -f "$src_file" ]; then
    echo "  ⚠️  source missing: $src_file"
    return 1
  fi
  local size
  size=$(wc -c < "$src_file")
  # 跳超大檔（>100KB ARG_MAX 限制，printf 本身也會炸）
  if [ "$size" -gt 102400 ]; then
    echo "  ⊘ $(basename "$src_file") ($size bytes) — SKIP (>100KB)"
    return 0
  fi
  local b64
  b64=$(base64 -w0 "$src_file" 2>/dev/null || base64 "$src_file" | tr -d '\n')
  # 確保 dest dir 存在
  local dest_dir
  dest_dir=$(dirname "$dest_path")
  nemoclaw "$SANDBOX" exec -- mkdir -p "$dest_dir" < /dev/null > /dev/null
  # stdin pipe — B64 不當 arg，沒有 32KB 限制
  printf '%s' "$b64" | nemoclaw "$SANDBOX" exec -- bash -c "base64 -d > '$dest_path'" > /dev/null
}

echo "▶ Sanity check"
nemoclaw "$SANDBOX" connect --probe-only
echo ""

echo "▶ 確保 sandbox workspace/skills/ + _lib dir 存在"
nemoclaw "$SANDBOX" exec -- mkdir -p "$SANDBOX_SKILLS" "$SANDBOX_SKILLS/$LIB_DIR_NAME" < /dev/null
echo ""

# ─── Deploy _lib first（skill 都 require）───
echo "▶ Deploying shared $LIB_DIR_NAME/"
if [ -d "workspace/skills/$LIB_DIR_NAME" ]; then
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    rel=$(basename "$f")
    size=$(wc -c < "$f")
    echo "  → $LIB_DIR_NAME/$rel ($size bytes)"
    deploy_file_to_sandbox "$f" "$SANDBOX_SKILLS/$LIB_DIR_NAME/$rel"
  done < <(find "workspace/skills/$LIB_DIR_NAME" -type f -name '*.js')
else
  echo "  ⚠️  workspace/skills/$LIB_DIR_NAME 不存在，skip"
fi
echo ""

# ─── Deploy 每個 skill ───
for skill in "${SKILLS[@]}"; do
  local_dir="workspace/skills/$skill"
  remote_dir="$SANDBOX_SKILLS/$skill"

  if [ ! -d "$local_dir" ]; then
    echo "  ⚠️  $local_dir 不存在，skip"
    continue
  fi

  echo "▶ Deploying $skill → $remote_dir"
  nemoclaw "$SANDBOX" exec -- mkdir -p "$remote_dir" < /dev/null

  while IFS= read -r f; do
    rel="${f#$local_dir/}"
    case "$rel" in
      node_modules*|package.json|package-lock.json|.gitkeep) continue ;;
    esac
    if [ -f "$f" ]; then
      size=$(wc -c < "$f")
      if [ "$size" -gt 102400 ]; then
        echo "  ⊘ $rel ($size bytes) — SKIP (>100KB)"
        continue
      fi
      echo "  → $rel ($size bytes)"
      deploy_file_to_sandbox "$f" "$remote_dir/$rel"
    fi
  done < <(find "$local_dir" -type f)

  # cli.sh 要 executable
  nemoclaw "$SANDBOX" exec -- chmod +x "$remote_dir/cli.sh" < /dev/null 2>/dev/null || true
done

# ─── Deploy workspace md files（AGENTS.md 等，可能很大）───
echo ""
echo "▶ Deploy workspace/*.md → sandbox（stdin pipe 不卡 32KB 上限）"
for md in AGENTS.md SOUL.md IDENTITY.md USER.md TOOLS.md HEARTBEAT.md; do
  if [ -f "workspace/$md" ]; then
    size=$(wc -c < "workspace/$md")
    echo "  → $SANDBOX_WS/$md ($size bytes)"
    deploy_file_to_sandbox "workspace/$md" "$SANDBOX_WS/$md"
  fi
done

# ─── Deploy host data/ → sandbox workspace/data/ ───
echo ""
echo "▶ Deploy host data/ → sandbox workspace/data/"
nemoclaw "$SANDBOX" exec -- mkdir -p "$SANDBOX_WS/data" < /dev/null
if [ -d "data" ]; then
  while IFS= read -r f; do
    rel="${f#data/}"
    if [ -f "$f" ]; then
      size=$(wc -c < "$f")
      if [ "$size" -gt 102400 ]; then
        echo "  ⊘ data/$rel ($size bytes) — SKIP (>100KB)"
        continue
      fi
      echo "  → data/$rel ($size bytes)"
      deploy_file_to_sandbox "$f" "$SANDBOX_WS/data/$rel"
    fi
  done < <(find data -type f 2>/dev/null)
fi

# ─── .env (含 BRIDGE_MODE=outbox 注入) ───
if [ -f .env ]; then
  TMP_ENV=$(mktemp)
  grep -v '^BRIDGE_MODE=' .env > "$TMP_ENV"
  echo "BRIDGE_MODE=outbox" >> "$TMP_ENV"
  echo "  → $SANDBOX_WS/.env (chmod 600, + BRIDGE_MODE=outbox 注入)"
  deploy_file_to_sandbox "$TMP_ENV" "$SANDBOX_WS/.env"
  nemoclaw "$SANDBOX" exec -- chmod 600 "$SANDBOX_WS/.env" < /dev/null 2>/dev/null || true
  rm -f "$TMP_ENV"
fi

# ─── Verify ───
echo ""
echo "▶ Verify sandbox workspace/skills/ 內容"
nemoclaw "$SANDBOX" exec -- ls -la "$SANDBOX_SKILLS/" < /dev/null
echo ""

echo "▶ Verify _lib/ 內容"
nemoclaw "$SANDBOX" exec -- ls -la "$SANDBOX_SKILLS/$LIB_DIR_NAME/" < /dev/null
echo ""

echo "▶ Verify AGENTS.md 大小"
nemoclaw "$SANDBOX" exec -- wc -c "$SANDBOX_WS/AGENTS.md" < /dev/null
echo ""

echo "▶ 試跑 order_store list"
nemoclaw "$SANDBOX" exec -- bash -c "echo '{\"action\":\"list\"}' | bash $SANDBOX_SKILLS/order_store/cli.sh" < /dev/null 2>&1 | head -5
echo ""

echo "════════════════════════════════════════════════════════"
echo "✅ Deploy 完成"
echo "下一步：dashboard 重整 + 開新 session + 客戶寄詢價"
echo "════════════════════════════════════════════════════════"
