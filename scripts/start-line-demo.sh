#!/usr/bin/env bash
# scripts/start-line-demo.sh
#
# 一鍵啟動 LINE demo：
#   1. 清掉舊的 cloudflared / webhook / orchestrator
#   2. 啟動 cloudflared quick tunnel (背景)
#   3. 抓 trycloudflare URL
#   4. 自動 PUT 到 LINE Channel webhook endpoint API
#   5. 觸發 LINE 的 verify
#   6. 啟動 orchestrator (orchestrator 內嵌 webhook server)
#
# 用法：
#   ./scripts/start-line-demo.sh             # 跑 demo + LINE force
#   ./scripts/start-line-demo.sh --secret    # 帶套機密信件演 gate-1
#   ./scripts/start-line-demo.sh real        # 跑 real mode（呼真 Nemotron）
#
# 需要 .env 內有：
#   LINE_CHANNEL_ACCESS_TOKEN
#   LINE_CHANNEL_SECRET
#   LINE_BOSS_USER_ID

set -euo pipefail

# ── 進到 repo root ──
cd "$(dirname "$0")/.."

# ── Load .env ──
if [ ! -f .env ]; then
  echo "❌ .env not found. Copy .env.example 並填入金鑰。"
  exit 1
fi

# 清掉所有不可見控制字元（保留 newline / tab），不然 source .env 會踩到 nano 留的 ^X
# 用 perl 比 sed 對控制字元範圍更精確
if command -v perl >/dev/null 2>&1; then
  perl -i -pe 's/[\x00-\x08\x0B-\x1F\x7F]//g' .env
else
  tr -d '\000-\010\013-\037\177' < .env > /tmp/.env.clean && mv /tmp/.env.clean .env
fi

# source 失敗（譬如 .env 還是有怪字元）也不要因 set -e 中斷整支 script
# 改用子 shell + grep 過濾，只保留 KEY=VALUE 形式的行
TMP_ENV=$(mktemp)
grep -E '^[A-Z_][A-Z0-9_]*=' .env > "$TMP_ENV" 2>/dev/null || true
set -a
# shellcheck disable=SC1090
source "$TMP_ENV"
set +a
rm -f "$TMP_ENV"

# ── Sanity check 必要金鑰 ──
: "${LINE_CHANNEL_ACCESS_TOKEN:?❌ LINE_CHANNEL_ACCESS_TOKEN not set in .env}"
: "${LINE_CHANNEL_SECRET:?❌ LINE_CHANNEL_SECRET not set in .env}"
: "${LINE_BOSS_USER_ID:?❌ LINE_BOSS_USER_ID not set in .env}"

if [ "$LINE_BOSS_USER_ID" = "1000" ] || [ "$LINE_BOSS_USER_ID" = "U0000000000000000000000000000000" ]; then
  echo "❌ LINE_BOSS_USER_ID looks like a placeholder ($LINE_BOSS_USER_ID)"
  echo "   應該是 U 開頭 33 字 hex。見 docs/LINE-RUNBOOK.md 第 3 節抓 userId。"
  exit 1
fi

# ── Step 1: Kill 舊 process ──
echo "▶ [1/6] 清掉舊 process..."
pkill -f 'cloudflared tunnel --url http://localhost:3000' 2>/dev/null || true
pkill -f 'node skills/line_notify/webhook.js' 2>/dev/null || true
pkill -f 'node orchestrator.js' 2>/dev/null || true
sleep 2
echo "  ✓ done"

# ── Step 2: 啟動 cloudflared ──
echo "▶ [2/6] 啟動 cloudflared tunnel..."
nohup cloudflared tunnel --url http://localhost:3000 > /tmp/cf.log 2>&1 &
CF_PID=$!
echo "  ✓ cloudflared PID=$CF_PID"

# ── Step 3: 等 URL ──
echo "▶ [3/6] 等 tunnel URL（最多 20 秒）..."
URL=""
for i in $(seq 1 20); do
  sleep 1
  URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' /tmp/cf.log | head -1 || true)
  if [ -n "$URL" ]; then
    break
  fi
done
if [ -z "$URL" ]; then
  echo "  ❌ Tunnel 沒在 20 秒內起來，看 /tmp/cf.log"
  tail -20 /tmp/cf.log
  kill "$CF_PID" 2>/dev/null || true
  exit 1
fi
WEBHOOK_URL="${URL}/webhook/line"
echo "  ✓ URL: $URL"
echo "  ✓ Webhook URL: $WEBHOOK_URL"

# ── Step 4: PUT webhook URL 到 LINE Channel ──
echo "▶ [4/6] 自動更新 LINE Channel webhook URL..."
HTTP_CODE=$(curl -s -o /tmp/line-set.log -w "%{http_code}" \
  -X PUT "https://api.line.me/v2/bot/channel/webhook/endpoint" \
  -H "Authorization: Bearer $LINE_CHANNEL_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"endpoint\":\"$WEBHOOK_URL\"}")

if [ "$HTTP_CODE" = "200" ]; then
  echo "  ✓ LINE webhook URL 已更新"
else
  echo "  ⚠️ 自動更新失敗 (HTTP $HTTP_CODE) — 你需要手動貼到 LINE Console:"
  echo "     $WEBHOOK_URL"
  cat /tmp/line-set.log
  echo ""
fi

# ── Step 5: 觸發 LINE Verify ──
echo "▶ [5/6] 觸發 LINE webhook verify..."
# 等 3 秒讓 cloudflared 暖機 (避免第一個請求 timeout)
sleep 3
VERIFY_RESULT=$(curl -s -X POST "https://api.line.me/v2/bot/channel/webhook/test" \
  -H "Authorization: Bearer $LINE_CHANNEL_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"endpoint\":\"$WEBHOOK_URL\"}" 2>&1 || true)
echo "  Verify response: $VERIFY_RESULT"

# ── Step 6: 啟動 orchestrator ──
echo ""
echo "════════════════════════════════════════════════════════════"
echo "  🚀 Webhook URL : $WEBHOOK_URL"
echo "  🚀 cloudflared : PID $CF_PID (log: /tmp/cf.log)"
echo "  🚀 LINE Console: 已自動同步（不用手動貼）"
echo "════════════════════════════════════════════════════════════"
echo ""
echo "▶ [6/6] 啟動 orchestrator..."
echo ""

# 預設 demo + force-line；接受 --secret / real 等 arg pass through
MODE="${1:-demo}"
shift 2>/dev/null || true

export FORCE_LINE_HOLD=1
exec node orchestrator.js "$MODE" "$@"
