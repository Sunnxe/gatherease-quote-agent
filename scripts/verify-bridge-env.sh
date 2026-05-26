#!/usr/bin/env bash
#
# scripts/verify-bridge-env.sh
#
# 確認 sandbox 內 /sandbox/.openclaw/workspace/.env 真的含 BRIDGE_MODE=outbox
# Test 1 失敗 (送 SMTP) 因為 cli.sh 沒看到 BRIDGE_MODE=outbox 走 outbox writer。
#

set -uo pipefail
SANDBOX="${NEMOCLAW_SANDBOX:-gatherease-quote-agent}"
SANDBOX_ENV="/sandbox/.openclaw/workspace/.env"

hr() { echo ""; echo "── $1 ──"; }

hr "1) sandbox .env 是否有 BRIDGE_MODE"
nemoclaw "$SANDBOX" exec -- bash -c "if grep -q '^BRIDGE_MODE=' $SANDBOX_ENV 2>/dev/null; then echo 'FOUND:'; grep '^BRIDGE_MODE=' $SANDBOX_ENV; else echo 'MISSING'; fi"

hr "2) sandbox .env 完整內容（敏感變數遮蔽）"
nemoclaw "$SANDBOX" exec -- bash -c "sed -E 's/(=)([^=]{4})[^=]+([^=]{2})$/\\1\\2***\\3/g' $SANDBOX_ENV 2>/dev/null | head -20"

hr "3) 強制寫入 BRIDGE_MODE=outbox（如果 step 1 顯示 MISSING）"
if [ -f .env ]; then
  TMP=$(mktemp)
  grep -v '^BRIDGE_MODE=' .env > "$TMP"
  echo "BRIDGE_MODE=outbox" >> "$TMP"
  B64=$(base64 -w0 "$TMP" 2>/dev/null || base64 "$TMP" | tr -d '\n')
  nemoclaw "$SANDBOX" exec -- bash -c "echo $B64 | base64 -d > $SANDBOX_ENV && chmod 600 $SANDBOX_ENV"
  rm -f "$TMP"
  echo "✓ 寫入完成"
else
  echo "❌ host .env not found in $(pwd)"
  exit 1
fi

hr "4) 再驗證一次"
nemoclaw "$SANDBOX" exec -- grep '^BRIDGE_MODE=' "$SANDBOX_ENV" 2>&1

hr "5) 直接 sandbox 跑 send_email 驗證 BRIDGE_MODE 真的被 cli.sh 看到"
nemoclaw "$SANDBOX" exec -- bash -c "echo '{\"to\":\"sunnxebusiness@gmail.com\",\"subject\":\"BRIDGE_MODE verify\",\"body\":\"BRIDGE_MODE verify test\"}' | bash /sandbox/.openclaw/workspace/skills/send_email/cli.sh" 2>&1 | tail -8

echo ""
echo "預期結果: status=queued + outbox_id（不是 SMTP error）"
