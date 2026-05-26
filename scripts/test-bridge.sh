#!/usr/bin/env bash
#
# scripts/test-bridge.sh
#
# 測試 4 條 path:
#   1. Email send (sandbox skill 寫 outbox → host bridge → SMTP → 真寄到 sunnxebusiness@gmail.com)
#   2. Email receive (你寄信給 s778906@gmail.com → host IMAP poll → 寫 sandbox inbox → inbox_watch 讀)
#   3. LINE send (sandbox line_notify cli.sh push flex → 真送你手機)
#   4. LINE receive (你手機按按鈕 → LINE webhook 收到 postback → resolveHold)
#

set -uo pipefail
SANDBOX="${NEMOCLAW_SANDBOX:-gatherease-quote-agent}"
SKILLS="/sandbox/.openclaw/workspace/skills"

cd "$(dirname "$0")/.."

if [ -t 1 ]; then
  G='\033[32m'; R='\033[31m'; Y='\033[33m'; B='\033[34m'; D='\033[2m'; N='\033[0m'
else
  G=''; R=''; Y=''; B=''; D=''; N=''
fi

hr() { echo ""; echo -e "${B}════════ $1 ════════${N}"; }

# ─── 檢查 service 都在跑 ───
hr "0) 服務檢查"
for svc in demo-mirror-server.js email-bridge.js line_notify/webhook.js; do
  PID=$(pgrep -f "$svc" | head -1)
  if [ -n "$PID" ]; then
    echo -e "${G}✓ $svc (PID $PID)${N}"
  else
    echo -e "${R}✗ $svc NOT running — run ./scripts/start-all.sh${N}"
  fi
done

# ─── Test 1: Email SEND ───
hr "1) Email SEND (sandbox skill → outbox → bridge → SMTP)"
echo "在 sandbox 跑 send_email cli.sh（BRIDGE_MODE=outbox）..."
SEND_RESULT=$(nemoclaw "$SANDBOX" exec -- bash -c "echo '{\"to\":\"sunnxebusiness@gmail.com\",\"subject\":\"bridge test — sandbox to host SMTP\",\"body\":\"如果你收到這封 = bridge 接通\\n寄出時間: $(date)\\n路徑: sandbox cli.sh → outbox/*.json → host email-bridge.js → SMTP\"}' | bash $SKILLS/send_email/cli.sh" 2>&1 | tail -3)
echo -e "${D}$SEND_RESULT${N}"

if echo "$SEND_RESULT" | grep -q '"status":"queued"'; then
  echo -e "${G}✓ 寫進 outbox 成功${N}"
  OUTBOX_ID=$(echo "$SEND_RESULT" | grep -oE '"outbox_id":"[^"]+"' | cut -d'"' -f4)
  echo "outbox_id: $OUTBOX_ID"
  echo ""
  echo "等 bridge 5-10 秒撿走 + SMTP 寄出..."
  for i in 1 2 3 4 5 6 7 8; do
    sleep 2
    SENT=$(nemoclaw "$SANDBOX" exec -- ls /sandbox/.openclaw/workspace/data/outbox/sent/ 2>/dev/null | grep "$OUTBOX_ID" | head -1)
    if [ -n "$SENT" ]; then
      echo -e "${G}✓ 偵測到已寄出（$SENT）在 outbox/sent/${N}"
      nemoclaw "$SANDBOX" exec -- cat "/sandbox/.openclaw/workspace/data/outbox/sent/$SENT" 2>&1 | grep -oE '"(status|sent_at|message_id)":"[^"]+"' | head -3
      break
    fi
    echo "  ... $((i*2))s, 還沒看到 sent/"
  done

  # 也 check failed
  FAILED=$(nemoclaw "$SANDBOX" exec -- ls /sandbox/.openclaw/workspace/data/outbox/failed/ 2>/dev/null | grep "$OUTBOX_ID" | head -1)
  if [ -n "$FAILED" ]; then
    echo -e "${R}✗ 寄信失敗（$FAILED）在 outbox/failed/${N}"
    nemoclaw "$SANDBOX" exec -- cat "/sandbox/.openclaw/workspace/data/outbox/failed/$FAILED" 2>&1 | head -20
  fi
else
  echo -e "${R}✗ 寫 outbox 失敗${N}"
fi

echo ""
echo -e "${Y}📥 請去 sunnxebusiness@gmail.com 收件匣看「bridge test — sandbox to host SMTP」這封信${N}"

# ─── Test 2: Email RECEIVE ───
hr "2) Email RECEIVE — 請你做以下 manual 步驟："
echo ""
echo "  從 sunnxebusiness@gmail.com 或任何信箱寄一封到 s778906@gmail.com，"
echo "  Subject 包含「詢價」或「RFQ」字樣（不然 inbox_watch new_inquiry mode filter 掉）"
echo "  附件可選 PDF 工程圖。"
echo ""
echo "  寄完後 30s 內 host bridge 會 IMAP poll 抓到 → 寫 sandbox inbox"
echo ""
read -p "已寄好按 Enter 繼續（會等 35s 然後 check inbox）... " _

echo "等 35s..."
sleep 35

echo "── sandbox inbox dir 內容 ──"
nemoclaw "$SANDBOX" exec -- ls -la /sandbox/.openclaw/workspace/data/inbox/ 2>&1 | tail -10

INBOX_FILES=$(nemoclaw "$SANDBOX" exec -- ls /sandbox/.openclaw/workspace/data/inbox/ 2>&1 | grep '\.json$' | wc -l)
if [ "$INBOX_FILES" -gt 0 ]; then
  echo -e "${G}✓ 發現 $INBOX_FILES 個 inbox json${N}"
  echo ""
  echo "── 跑 inbox_watch (BRIDGE_MODE=outbox 走 bridge 讀檔) ──"
  nemoclaw "$SANDBOX" exec -- bash -c "echo '{\"action\":\"poll\",\"mode\":\"any\",\"max_messages\":3,\"mark_seen\":false}' | bash $SKILLS/inbox_watch/cli.sh" 2>&1 | tail -20
else
  echo -e "${R}✗ inbox 還沒看到信 — 看 bridge log：tail -50 /tmp/email-bridge.log${N}"
  echo ""
  tail -20 /tmp/email-bridge.log 2>/dev/null || echo "/tmp/email-bridge.log 不存在"
fi

# ─── Test 3: LINE SEND ───
hr "3) LINE SEND (sandbox line_notify cli.sh → LINE Messaging API → 你手機)"
echo "在 sandbox 跑 line_notify cli.sh push flex..."
LINE_RESULT=$(nemoclaw "$SANDBOX" exec -- bash -c "echo '{\"hold_id\":\"test-bridge-$(date +%s)\",\"gate\":\"gate-bridge-test\",\"summary\":\"🧪 bridge test\\n如果你看到這則 LINE flex = LINE path 全通\\n時間: $(date)\",\"options\":[\"OK\",\"取消\"]}' | bash $SKILLS/line_notify/cli.sh" 2>&1 | tail -5)
echo -e "${D}$LINE_RESULT${N}"
if echo "$LINE_RESULT" | grep -q '"status":"pushed"'; then
  echo -e "${G}✓ Push LINE 成功${N}"
  HOLD_ID=$(echo "$LINE_RESULT" | grep -oE '"hold_id":"[^"]+"' | cut -d'"' -f4)
  echo -e "${Y}📱 請去你的 LINE app 看「🧪 bridge test」flex message，按 OK 或 取消${N}"
  echo "hold_id: $HOLD_ID"
else
  echo -e "${R}✗ Push LINE 失敗${N}"
fi

# ─── Test 4: LINE RECEIVE ───
hr "4) LINE RECEIVE — 看 webhook 有沒有收到 postback"
echo ""
echo "  按了 LINE flex 上的按鈕後，webhook 應該收到 postback"
echo "  看 webhook log：tail -20 /tmp/line-webhook.log"
echo ""
read -p "按按鈕後按 Enter 繼續（會 tail webhook log）... " _

echo "── /tmp/line-webhook.log 最新 30 行 ──"
tail -30 /tmp/line-webhook.log 2>/dev/null || echo "log 不存在"

# ─── 總結 ───
hr "📊 總結"
echo ""
echo "請手動確認以下 4 件事（demo 鏡頭都用得到）："
echo ""
echo "  [ ] 1. sunnxebusiness@gmail.com 收件匣有「bridge test — sandbox to host SMTP」"
echo "  [ ] 2. sandbox inbox/*.json 有檔 + inbox_watch 跑出來看得到你寄的信"
echo "  [ ] 3. 手機 LINE 看到「🧪 bridge test」flex message"
echo "  [ ] 4. 按按鈕後 /tmp/line-webhook.log 有 postback log"
echo ""
echo "Debug:"
echo "  tail -f /tmp/email-bridge.log         # outbox 撿走 / inbox poll"
echo "  tail -f /tmp/line-webhook.log         # LINE postback"
echo "  tail -f /tmp/mirror.log               # HTML mirror"
echo "  nemoclaw $SANDBOX exec -- ls -la /sandbox/.openclaw/workspace/data/{outbox,inbox}/"
