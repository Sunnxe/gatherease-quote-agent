#!/usr/bin/env bash
#
# scripts/inspect-egress.sh
#
# 攻 P1: sandbox 內 DNS 對 smtp/imap/api.line.me 全 FAILED 的根因。
# 我們有 3 個 preset (gmail-smtp, gmail-imap, line-messaging) 但沒 work。
# 一步步撈：active policy / preset 內容 / DNS resolver / iptables / nemoclaw policy debug。
#

set -uo pipefail
SANDBOX="${NEMOCLAW_SANDBOX:-gatherease-quote-agent}"
hr() { echo ""; echo "════════ $1 ════════"; }

hr "1) nemoclaw status (sandbox 整體狀態 + active policies)"
nemoclaw status --json | python3 -c "
import json, sys
d = json.load(sys.stdin)
sandboxes = d.get('sandboxes', [])
target = next((s for s in sandboxes if s.get('name') == '$SANDBOX'), None)
if not target:
    print('SANDBOX not found:', '$SANDBOX')
    sys.exit(0)
print('name:', target.get('name'))
print('policies:', target.get('policies', []))
print('isDefault:', target.get('isDefault'))
print('openshellVersion:', target.get('openshellVersion'))
print('gpuEnabled:', target.get('gpuEnabled'))
print('model:', target.get('model'))
" 2>&1

hr "2) preset yaml 內容（看寫了什麼 allow rule）"
for preset in gatherease-egress; do
  if [ -f "presets/$preset.yaml" ]; then
    echo "── presets/$preset.yaml ──"
    cat "presets/$preset.yaml"
  fi
done

hr "3) sandbox /etc/resolv.conf（看 DNS server 設成什麼）"
nemoclaw "$SANDBOX" exec -- cat /etc/resolv.conf 2>&1 | head -10

hr "4) sandbox 內 dig 試解析 (要 dig 命令)"
nemoclaw "$SANDBOX" exec -- which dig nslookup host 2>&1 | head -5
echo ""
nemoclaw "$SANDBOX" exec -- dig +short smtp.gmail.com 2>&1 | head -5
echo "---"
nemoclaw "$SANDBOX" exec -- dig +short imap.gmail.com @8.8.8.8 2>&1 | head -5

hr "5) sandbox 內 curl 試對 DNS server 直連"
nemoclaw "$SANDBOX" exec -- curl -sS --max-time 5 http://8.8.8.8 2>&1 | head -3
echo "---"
nemoclaw "$SANDBOX" exec -- curl -sS --max-time 5 https://dns.google/resolve?name=smtp.gmail.com 2>&1 | head -10

hr "6) sandbox 內 iptables (看 firewall 規則)"
nemoclaw "$SANDBOX" exec -- iptables -L -n 2>&1 | head -30
echo "---"
nemoclaw "$SANDBOX" exec -- iptables -t nat -L -n 2>&1 | head -20

hr "7) sandbox 內 看現在的 network namespace + proxy env"
nemoclaw "$SANDBOX" exec -- env 2>&1 | grep -iE 'proxy|http|dns' | head -10
echo "---"
nemoclaw "$SANDBOX" exec -- ip route 2>&1 | head -5

hr "8) nemoclaw policy / preset 子命令"
nemoclaw "$SANDBOX" --help 2>&1 | head -40
echo "---"
nemoclaw "$SANDBOX" policy --help 2>&1 | head -20 || echo "no policy subcommand"

hr "9) nemoclaw doctor (sandbox 自診)"
nemoclaw "$SANDBOX" doctor 2>&1 | head -40

hr "10) nemoclaw policy show / list"
nemoclaw "$SANDBOX" policy show 2>&1 | head -40 || true
nemoclaw "$SANDBOX" policy list 2>&1 | head -40 || true

hr "DONE — 把以上輸出貼給 Claude 排查 DNS / egress 根因"
echo ""
echo "重點看："
echo "  - (1) policies array 是否真的含 gmail-smtp/gmail-imap/line-messaging"
echo "  - (2) preset yaml 內 allow rule 寫法（domain whitelist？port？protocol？）"
echo "  - (3) DNS server 是 127.0.0.x (本地) 還是 8.8.8.8 (外部)"
echo "  - (4) dig 試解析能不能繞 /etc/resolv.conf 直接打 8.8.8.8"
echo "  - (6) iptables 是不是 DROP all 但 preset 沒實際插 ALLOW rule"
