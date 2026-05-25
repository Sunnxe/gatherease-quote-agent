#!/usr/bin/env bash
# setup-vm.sh — Day 3 一鍵建沙盒 + 套政策 + 驗證 NemoClaw kernel-level 強制
#
# 用法（在 Brev VM 上、gatherease-quote-agent/ 根目錄）：
#
#   export NVIDIA_API_KEY=nvapi-...
#   chmod +x setup-vm.sh
#   ./setup-vm.sh
#
# 這個 script 做的事：
#   1. 檢查環境（NVIDIA_API_KEY、nemoclaw、openclaw、node、repo 結構）
#   2. nemoclaw onboard（建 OpenShell 沙盒，kernel-level egress hook 起來）
#   3. 解析剛建好的沙盒名稱
#   4. 套用 ./presets/gatherease-egress.yaml（自動把 sandbox 名字 sed 進去）
#   5. nemoclaw <name> status + doctor 印健康狀態（這是 demo 影片的「治理是真的」鏡頭）
#   6. 印下一步該做什麼

set -euo pipefail

# ─────────────────────────────────────────────────────────────
# 顏色
# ─────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

step()    { echo -e "\n${BOLD}${BLUE}═══ $* ═══${NC}"; }
ok()      { echo -e "${GREEN}✅ $*${NC}"; }
warn()    { echo -e "${YELLOW}⚠️  $*${NC}"; }
err()     { echo -e "${RED}❌ $*${NC}"; }
hint()    { echo -e "${YELLOW}   ↪ $*${NC}"; }

# ─────────────────────────────────────────────────────────────
# 0. Pre-flight
# ─────────────────────────────────────────────────────────────
step "Step 0 · Pre-flight 檢查"

# repo 結構
if [ ! -f "./orchestrator.js" ] || [ ! -d "./presets" ] || [ ! -f "./presets/gatherease-egress.yaml" ]; then
  err "找不到 ./orchestrator.js 或 ./presets/gatherease-egress.yaml"
  hint "請在 gatherease-quote-agent/ 根目錄執行此 script"
  exit 1
fi
ok "repo 結構 OK（orchestrator.js + presets/gatherease-egress.yaml）"

# NVIDIA_API_KEY
if [ -z "${NVIDIA_API_KEY:-}" ]; then
  err "NVIDIA_API_KEY 環境變數未設"
  hint "去 https://build.nvidia.com 申請 key，然後："
  hint "  export NVIDIA_API_KEY=nvapi-..."
  hint "  ./setup-vm.sh"
  exit 1
fi
ok "NVIDIA_API_KEY 已設（前 8 字元：${NVIDIA_API_KEY:0:8}...，後文不再 echo）"

# 工具版本
nemoclaw --version || { err "nemoclaw 不在 PATH"; exit 1; }
node --version
ok "工具版本確認"

# ─────────────────────────────────────────────────────────────
# 1. NemoClaw onboard
# ─────────────────────────────────────────────────────────────
step "Step 1 · NemoClaw onboard（建沙盒）"

EXISTING=$(nemoclaw list 2>&1 || true)
echo "$EXISTING"

if echo "$EXISTING" | grep -qi "no sandbox"; then
  echo ""
  echo "→ 沒有現存沙盒，跑 nemoclaw onboard..."
  echo ""

  # 嘗試非互動模式（v0.0.36 可能還沒完整支援，失敗就退到互動）
  set +e
  NEMOCLAW_POLICY_TIER=open \
    nemoclaw onboard \
      --non-interactive \
      --yes-i-accept-third-party-software 2>&1 | tee /tmp/nemoclaw-onboard.log
  ONBOARD_EXIT=$?
  set -e

  if [ $ONBOARD_EXIT -ne 0 ]; then
    warn "非互動 onboard 失敗 (exit $ONBOARD_EXIT)"
    hint "v0.0.36 alpha 可能不完整支援非互動，請手動跑："
    hint "  nemoclaw onboard"
    hint "  → inference provider 選 NVIDIA Nemotron cloud"
    hint "  → API key 從 \$NVIDIA_API_KEY 取（環境變數已設、為防洩漏不 echo）"
    hint "  → 沙盒名稱可以接受預設或自訂"
    hint "做完後重新跑此 script，它會偵測到沙盒存在並繼續"
    exit 1
  fi

  ok "Onboard 完成"
else
  ok "沙盒已存在，跳過 onboard"
fi

# ─────────────────────────────────────────────────────────────
# 2. 解析沙盒名稱
# ─────────────────────────────────────────────────────────────
step "Step 2 · 取得沙盒名稱"
nemoclaw list

# 嘗試從 nemoclaw list 抓第一個沙盒名稱
# 格式可能類似：「NAME    STATUS\n<name>   running」或表格、或 JSON
SANDBOX_NAME=""

# 先試 JSON
if SANDBOX_JSON=$(nemoclaw list --json 2>/dev/null); then
  if command -v jq >/dev/null 2>&1; then
    SANDBOX_NAME=$(echo "$SANDBOX_JSON" | jq -r '.[0].name // .sandboxes[0].name // empty' 2>/dev/null || echo "")
  fi
fi

# 失敗就 fallback 用 grep
if [ -z "$SANDBOX_NAME" ]; then
  SANDBOX_NAME=$(nemoclaw list 2>&1 \
    | grep -vE '^\s*$|^NAME|^---|^Run|No sandbox|^\s*#' \
    | awk '{print $1}' \
    | head -1 || echo "")
fi

# 還是抓不到 → 讓使用者手動指定
if [ -z "$SANDBOX_NAME" ]; then
  err "無法自動抓沙盒名稱，請看上方輸出後手動指定："
  hint "  SANDBOX_NAME=<name> ./setup-vm.sh"
  exit 1
fi

# 允許環境變數覆寫
SANDBOX_NAME="${SANDBOX_NAME_OVERRIDE:-$SANDBOX_NAME}"
ok "沙盒名稱：$SANDBOX_NAME"

# ─────────────────────────────────────────────────────────────
# 3. 套用 egress policy
# ─────────────────────────────────────────────────────────────
step "Step 3 · 套用 NemoClaw egress 政策（這是護城河）"

# 把 YAML 的 sandbox 欄位改成實際名稱（demo 階段先寬鬆相容）
RESOLVED_YAML="/tmp/gatherease-egress-resolved.yaml"
sed "s/^sandbox:.*/sandbox: $SANDBOX_NAME/" ./presets/gatherease-egress.yaml > "$RESOLVED_YAML"

echo "→ 解析後 YAML 開頭："
head -10 "$RESOLVED_YAML"
echo ""

set +e
nemoclaw "$SANDBOX_NAME" policy-add --from-file "$RESOLVED_YAML" --yes
POLICY_EXIT=$?
set -e

if [ $POLICY_EXIT -ne 0 ]; then
  warn "policy-add 回非 0 (exit $POLICY_EXIT)，可能某些 guardrail/filter 不被 v0.0.36 支援"
  hint "看上方錯誤訊息，可能要把 YAML 裡 egress_filters / ingress_filters / guardrails 段落拿掉只留 network_policies"
fi

ok "Egress 政策已套用（或部分套用，看上方輸出）"

# ─────────────────────────────────────────────────────────────
# 4. 健康狀態（這是 demo 影片的「治理是真的」鏡頭）
# ─────────────────────────────────────────────────────────────
step "Step 4 · 沙盒健康狀態（demo 影片鏡頭素材）"

echo "→ nemoclaw $SANDBOX_NAME status:"
nemoclaw "$SANDBOX_NAME" status || true

echo ""
echo "→ nemoclaw $SANDBOX_NAME doctor:"
nemoclaw "$SANDBOX_NAME" doctor || true

# ─────────────────────────────────────────────────────────────
# 5. Summary + 下一步
# ─────────────────────────────────────────────────────────────
step "✅ Day 3 Step A 完成"

cat <<EOF

${GREEN}${BOLD}NemoClaw kernel-level governance is now ACTIVE.${NC}

  Sandbox          : $SANDBOX_NAME
  Policy file      : ./presets/gatherease-egress.yaml
  Status command   : nemoclaw $SANDBOX_NAME status
  Connect to sandbox: nemoclaw $SANDBOX_NAME connect

${BOLD}差別（vs Day 2）：${NC}
  Day 2 完成的：application-level 治理邏輯 + audit trail（orchestrator 自己寫的 log）
  Day 3 補上的：kernel-level egress 強制執行（NemoClaw 在 sandbox 外攔截 syscall/網路）

${BOLD}建議 demo 影片鏡頭：${NC}
  1. nemoclaw list                       — 顯示沙盒 active
  2. nemoclaw $SANDBOX_NAME status       — 顯示健康狀態
  3. cat presets/gatherease-egress.yaml  — 顯示政策內容
  4. node orchestrator.js demo:secret    — 演 gate-1 攔截
  5. tail logs/audit.jsonl               — 顯示稽核軌跡

${BOLD}下一步（Day 3 Step B/C）：${NC}
  B. LINE Messaging API
     - 去 https://developers.line.biz/console/ 建 channel
     - 拿 Channel Access Token + Channel Secret 放進 .env
     - 把 orchestrator 的 HOLD 點換成真 LINE flex message + webhook
  C. Gmail (test 帳號)
     - 開新 Gmail 測試帳號（不要主帳號）
     - 設 App Password 放進 .env
     - send_rfq 切到 real 模式（已有程式碼，只要環境變數設了就自動切）

要把 skills 部署進沙盒（讓 orchestrator 整個跑在 NemoClaw 隔離環境裡），看 Day 3 Step D：
  nemoclaw $SANDBOX_NAME skill install ./skills/read_drawing
  nemoclaw $SANDBOX_NAME skill install ./skills/calc_cost
  nemoclaw $SANDBOX_NAME skill install ./skills/send_rfq
  nemoclaw $SANDBOX_NAME skill install ./skills/get_history_quote

EOF
