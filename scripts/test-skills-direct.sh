#!/usr/bin/env bash
#
# scripts/test-skills-direct.sh
#
# 在 sandbox 內直接 invoke 10 個 skill cli.sh（不走 agent）。
# 驗證的是：cli.sh 本身 + workspace path + egress policy。
# Agent 不在迴路裡——所以「agent 守門擋」「agent prompt 沒寫對」都不會干擾。
#
# 每個 skill 跑 happy-path input，OK/FAIL/SKIP 三色 status。
# 跑完 print 報表。
#

set -uo pipefail
SANDBOX="${NEMOCLAW_SANDBOX:-gatherease-quote-agent}"
SKILLS_BASE="/sandbox/.openclaw/workspace/skills"

# 顏色（如果 stdout 是 TTY）
if [ -t 1 ]; then
  G='\033[32m'; R='\033[31m'; Y='\033[33m'; B='\033[34m'; D='\033[2m'; N='\033[0m'
else
  G=''; R=''; Y=''; B=''; D=''; N=''
fi

declare -A RESULTS
declare -A NOTES

# ─── helper ─────────────────────────────────────────────
run_skill() {
  local name="$1"
  local json_input="$2"
  local timeout="${3:-30}"

  echo ""
  echo -e "${B}── [$name] ──${N}"
  echo -e "${D}  input: $json_input${N}"

  # 在 sandbox 內用 echo|pipe 跑 cli.sh
  local cmd="echo '$json_input' | bash $SKILLS_BASE/$name/cli.sh"
  local out
  local code
  out=$(timeout "$timeout" nemoclaw "$SANDBOX" exec -- bash -c "$cmd" 2>&1)
  code=$?

  if [ $code -eq 0 ]; then
    RESULTS[$name]="OK"
    NOTES[$name]=$(echo "$out" | tr -d '\r' | head -c 200)
    echo -e "${G}  ✓ exit 0${N}"
    echo "$out" | tail -10
  elif [ $code -eq 124 ]; then
    RESULTS[$name]="TIMEOUT"
    NOTES[$name]="timeout ${timeout}s"
    echo -e "${R}  ✗ TIMEOUT after ${timeout}s${N}"
  else
    RESULTS[$name]="FAIL (exit $code)"
    NOTES[$name]=$(echo "$out" | tr -d '\r' | tail -c 300)
    echo -e "${R}  ✗ exit $code${N}"
    echo "$out" | tail -15
  fi
}

# ─── DNS / egress probes 先做 ────────────────────────────
echo "════════════════════════════════════════════════════════"
echo "  Step 0: DNS / egress probe (排除根因用)"
echo "════════════════════════════════════════════════════════"

probe() {
  local label="$1"
  local cmd="$2"
  echo ""
  echo -e "${B}── $label ──${N}"
  nemoclaw "$SANDBOX" exec -- bash -c "$cmd" 2>&1 | head -5
}

probe "DNS smtp.gmail.com" "getent hosts smtp.gmail.com || echo 'DNS FAILED'"
probe "DNS imap.gmail.com" "getent hosts imap.gmail.com || echo 'DNS FAILED'"
probe "DNS api.line.me"    "getent hosts api.line.me || echo 'DNS FAILED'"
probe "TCP smtp.gmail.com:587 (3s timeout)" "timeout 3 bash -c 'cat < /dev/tcp/smtp.gmail.com/587' 2>&1 || echo 'TCP closed/blocked'"
probe "TCP imap.gmail.com:993" "timeout 3 bash -c 'cat < /dev/tcp/imap.gmail.com/993' 2>&1 || echo 'TCP closed/blocked'"

# ─── 10 個 skill 測 ─────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════"
echo "  Step 1-10: 10 個 skill 直測"
echo "════════════════════════════════════════════════════════"

# 純本地（不需網路，預期 OK）
run_skill "order_store"        '{"action":"list"}'                                30
run_skill "get_history_quote"  '{"product_keywords":["矽膠","包膠輪"],"top_k":3}' 30
run_skill "check_schedule"     '{"product_type":"silicone_roller","needed_qty":200,"target_date":"2026-06-10"}' 30
run_skill "calc_cost"          '{"bom":[{"material":"silicone_rubber_55A","qty_g":500},{"material":"steel_shaft_grade45","qty_g":1500}],"labor_hours":2.0,"qty":200}' 30
run_skill "compare_suppliers"  '{"order_id":"TEST-001","quotes":[{"supplier_id":"SUP-001","unit_price_twd":420,"lead_days":7,"moq":50},{"supplier_id":"SUP-002","unit_price_twd":380,"lead_days":10,"moq":30}]}' 30
run_skill "generate_quote_pdf" '{"order_id":"TEST-001","customer_name":"測試客戶","items":[{"sku":"silicone_roller_A1","qty":200,"unit_price_twd":520}],"total_twd":104000,"output_path":"/tmp/test-quote.pdf"}' 30

# 對外（要 egress，可能 FAIL）
run_skill "read_drawing"       '{"pdf_path":"data/sample-drawing.pdf"}' 45
run_skill "inbox_watch"        '{"mode":"new_inquiry","max_messages":3,"mark_seen":false}' 30
run_skill "send_email"         '{"to":"sunnxebusiness@gmail.com","subject":"sandbox skill direct test","body":"如果你看到這封 = sandbox SMTP egress 通 + send_email cli.sh work"}' 30
run_skill "line_notify"        '{"action":"push_text","text":"sandbox skill direct test — line_notify cli.sh work"}' 30

# ─── 報表 ───────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════"
echo "  📊 報表"
echo "════════════════════════════════════════════════════════"
printf "%-22s %-15s %s\n" "SKILL" "STATUS" "NOTE"
printf "%-22s %-15s %s\n" "────────────────────" "─────────────" "──────────────────────────────"
for skill in order_store get_history_quote check_schedule calc_cost compare_suppliers generate_quote_pdf read_drawing inbox_watch send_email line_notify; do
  status="${RESULTS[$skill]:-NOT_RUN}"
  note="${NOTES[$skill]:-}"
  case "$status" in
    OK)       printf "${G}%-22s %-15s${N} %s\n" "$skill" "$status" "${note:0:60}" ;;
    TIMEOUT)  printf "${R}%-22s %-15s${N} %s\n" "$skill" "$status" "${note:0:60}" ;;
    FAIL*)    printf "${R}%-22s %-15s${N} %s\n" "$skill" "$status" "${note:0:60}" ;;
    *)        printf "${Y}%-22s %-15s${N} %s\n" "$skill" "$status" "${note:0:60}" ;;
  esac
done

echo ""
echo "下一步建議："
echo "  - OK 的：可以放心給 agent 用"
echo "  - FAIL 的：看 NOTE 內 stderr，多半是 egress policy 或 input shape"
echo "  - TIMEOUT 的：第一次 npm install 慢，再跑一次"
echo ""
echo "報表詳細看上面每個 [$skill] 區段。"
