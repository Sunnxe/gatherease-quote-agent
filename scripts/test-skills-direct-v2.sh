#!/usr/bin/env bash
#
# scripts/test-skills-direct-v2.sh
#
# v2: input schema 對齊 SKILL.md（v1 我亂寫 input 6 個 fail 是測試錯不是 skill 壞）
#

set -uo pipefail
SANDBOX="${NEMOCLAW_SANDBOX:-gatherease-quote-agent}"
SKILLS_BASE="/sandbox/.openclaw/workspace/skills"

if [ -t 1 ]; then
  G='\033[32m'; R='\033[31m'; Y='\033[33m'; B='\033[34m'; D='\033[2m'; N='\033[0m'
else
  G=''; R=''; Y=''; B=''; D=''; N=''
fi

declare -A RESULTS NOTES

run_skill() {
  local name="$1" json_input="$2" timeout="${3:-30}"
  echo ""
  echo -e "${B}── [$name] ──${N}"
  echo -e "${D}  input: $json_input${N}"
  local cmd="echo '$json_input' | bash $SKILLS_BASE/$name/cli.sh"
  local out code
  out=$(timeout "$timeout" nemoclaw "$SANDBOX" exec -- bash -c "$cmd" 2>&1)
  code=$?
  if [ $code -eq 0 ]; then
    RESULTS[$name]="OK"
    NOTES[$name]=$(echo "$out" | grep -v 'UNDICI\|trace-warnings' | tr -d '\r' | head -c 250)
    echo -e "${G}  ✓ exit 0${N}"
    echo "$out" | grep -v 'UNDICI\|trace-warnings' | tail -8
  elif [ $code -eq 124 ]; then
    RESULTS[$name]="TIMEOUT"; NOTES[$name]="timeout ${timeout}s"
    echo -e "${R}  ✗ TIMEOUT${N}"
  else
    RESULTS[$name]="FAIL (exit $code)"
    NOTES[$name]=$(echo "$out" | grep -v 'UNDICI\|trace-warnings' | tr -d '\r' | tail -c 300)
    echo -e "${R}  ✗ exit $code${N}"
    echo "$out" | grep -v 'UNDICI\|trace-warnings' | tail -12
  fi
}

# ─── 純本地 6 個（schema 對了應該都 OK）────────────────
run_skill "order_store" '{"action":"list"}' 30

run_skill "get_history_quote" '{"new_order":{"ProductName":"Anti-Static Silicone Roller","OrderDate":"2026-05-26","Hardness":55,"Spec":"25*35*600"},"k":5}' 30

run_skill "check_schedule" '{"product_id":"Anti-Static Silicone Roller","qty":200,"customer_desired_lead_days":10,"surface_treatment_lead_days":4}' 30

run_skill "calc_cost" '{"product_id":"Anti-Static Silicone Roller","bom":[{"part_name":"Roller Core (Shaft)","qty_per_unit":1},{"part_name":"Anti-Static Silicone Cover","qty_per_unit":0.8}],"qty":200,"surface_treatment_supplier_id":"SUP-002","customer_tier":"tier_A"}' 30

run_skill "compare_suppliers" '{"supplier_ids":["SUP-001","SUP-002","SUP-003"],"customer_requirements":{"max_surface_treatment_days":5,"requires_anti_static":true}}' 30

run_skill "generate_quote_pdf" '{"order_id":"TEST-001","customer_name":"昕叡電子有限公司","customer_email":"sunnxebusiness@gmail.com","product_name":"Anti-Static Silicone Rubber Roller A1","product_name_zh":"矽膠抗靜電包膠輪 A1","qty":200,"unit_price_twd":1612,"total_twd":322400,"lead_days":14,"supplier_choice":"永鎵精密表面","terms":"30% T/T deposit","signed_by":"廖老闆（測試）"}' 45

# ─── 對外 4 個（egress 通了才能 work）─────────────────
run_skill "read_drawing" '{"order_id":"TEST-001","drawing_pdf_path":"data/sample-drawing.pdf","customer_name":"昕叡電子"}' 45

run_skill "inbox_watch" '{"action":"poll","mode":"new_inquiry","max_messages":3,"mark_seen":false}' 30

run_skill "send_email" '{"to":"sunnxebusiness@gmail.com","subject":"v2 sandbox skill direct test","body":"如果你看到這封 = sandbox SMTP egress 通"}' 30

run_skill "line_notify" '{"hold_id":"test-hold-001","gate":"gate-test","summary":"測試 line_notify cli.sh","options":["OK","取消"]}' 30

# ─── 報表 ───────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════"
echo "  📊 v2 報表"
echo "════════════════════════════════════════════════════════"
printf "%-22s %-15s %s\n" "SKILL" "STATUS" "NOTE"
printf "%-22s %-15s %s\n" "────────────────────" "─────────────" "──────────────────────────────"
for skill in order_store get_history_quote check_schedule calc_cost compare_suppliers generate_quote_pdf read_drawing inbox_watch send_email line_notify; do
  status="${RESULTS[$skill]:-NOT_RUN}"
  note="${NOTES[$skill]:-}"
  # Strip noise
  note_clean=$(echo "$note" | tr -d '\n' | sed 's/  */ /g' | head -c 70)
  case "$status" in
    OK)       printf "${G}%-22s %-15s${N} %s\n" "$skill" "$status" "$note_clean" ;;
    TIMEOUT)  printf "${R}%-22s %-15s${N} %s\n" "$skill" "$status" "$note_clean" ;;
    FAIL*)    printf "${R}%-22s %-15s${N} %s\n" "$skill" "$status" "$note_clean" ;;
    *)        printf "${Y}%-22s %-15s${N} %s\n" "$skill" "$status" "$note_clean" ;;
  esac
done
echo ""
