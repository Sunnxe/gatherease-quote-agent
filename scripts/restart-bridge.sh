#!/usr/bin/env bash
#
# scripts/restart-bridge.sh
#
# 重啟 email-bridge.js，包含 source .env（不然 nohup 起來會抓不到 GMAIL_USER/APP_PASSWORD）。
#
# 用法：
#   bash scripts/restart-bridge.sh
#

set -euo pipefail
cd "$(dirname "$0")/.."

# 1. 殺舊的
echo "▶ 殺舊 bridge process..."
pkill -f email-bridge.js 2>/dev/null || echo "  (沒有舊 bridge 在跑)"
sleep 2

# 2. Source .env（關鍵 — nohup 開新 process 不會繼承 shell env）
if [ ! -f .env ]; then
  echo "❌ .env 不存在於 $(pwd)/.env"
  exit 1
fi
echo "▶ Source .env..."
set -a
source .env
set +a

# 3. 檢查必要 env vars 有 set
missing=()
for v in GMAIL_USER GMAIL_APP_PASSWORD; do
  if [ -z "${!v:-}" ]; then
    missing+=("$v")
  fi
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "❌ .env 缺少：${missing[*]}"
  exit 1
fi
echo "  ✓ GMAIL_USER=$GMAIL_USER (App Password set)"

# 4. 起新 bridge
echo "▶ Starting bridge..."
nohup node scripts/email-bridge.js > /tmp/email-bridge.log 2>&1 &
PID=$!
disown
echo "  bridge pid=$PID"

# 5. 等 3 秒看 log 確認沒爆
sleep 3
echo ""
echo "▶ /tmp/email-bridge.log (最近 15 行)："
tail -15 /tmp/email-bridge.log

# 6. 確認 process 還活著
if kill -0 "$PID" 2>/dev/null; then
  echo ""
  echo "✅ bridge 跑起來了 pid=$PID"
else
  echo ""
  echo "❌ bridge 已死。看上面 log 找原因"
  exit 1
fi
