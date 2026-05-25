#!/usr/bin/env bash
# Path A: 強制把 NemoClaw sandbox 內的 OpenClaw 降到 blueprint.yaml min_openclaw_version
#
# 為什麼：
#   NemoClaw v0.0.36 的 rcf_patch.py 預期 patch 一段叫 tryWriteSingleTopLevelIncludeMutation
#   的 symbol，但 OpenClaw 2026.5.18 已將該段 refactor 掉。Base image 帶 5.18、
#   blueprint 標 MIN_VER=2026.4.24，Step 16 的邏輯說「5.18 >= 4.24 就保留」，所以 5.18
#   被保留 → Step 18 的 rcf_patch 抓不到舊 symbol → 整個 sandbox build fail。
#
#   這個 script 改 Step 16 的邏輯，強制 install MIN_VER（降版到 4.24）。
#   2026.4.24 是 rcf_patch.py 寫的時候對齊的版本（大概率），降下去 patch 就找得到。
#
# 怎麼用（在 Linux VM 上）：
#   1. 先跑一次 `nemoclaw onboard` 讓它失敗在 Step 18（會在 /tmp/nemoclaw-build-XXXX/
#      留下完整 Dockerfile + context）
#   2. 立刻跑這個 script：./pathA-downgrade-openclaw.sh
#   3. script 會找最新的 build dir、拷出來、patch Dockerfile、印出下一步指令
#   4. 跑印出來的 `nemoclaw onboard --from <path>` 指令
#   5. 等 5-15 分鐘看新 build 成不成（這次 Step 16 會降版、Step 18 patch 應該對得上）
#
# 停損：90 分鐘內如果還沒成 → 回 Path C，把時間投到 LINE + Gmail

set -euo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m'

step()  { echo -e "\n${BLUE}═══ $* ═══${NC}"; }
ok()    { echo -e "${GREEN}✅ $*${NC}"; }
warn()  { echo -e "${YELLOW}⚠️  $*${NC}"; }
err()   { echo -e "${RED}❌ $*${NC}"; }

# ─────────────────────────────────────────────────────────────
# Step 1: 找最新的 build dir
# ─────────────────────────────────────────────────────────────
step "Step 1 · 找 nemoclaw build context"

BUILD_DIR=$(ls -dt /tmp/nemoclaw-build-* 2>/dev/null | head -1 || echo "")

if [ -z "$BUILD_DIR" ] || [ ! -d "$BUILD_DIR" ]; then
  err "找不到 /tmp/nemoclaw-build-*"
  echo ""
  warn "請先跑這個讓 NemoClaw 產生 build context（會在 Step 18 失敗、但 /tmp 會留資料）："
  echo "  nemoclaw onboard"
  echo ""
  echo "失敗後立刻回來跑這個 script。"
  exit 1
fi

ok "找到 build dir: $BUILD_DIR"
echo "內容："
ls "$BUILD_DIR" | head -20

# ─────────────────────────────────────────────────────────────
# Step 2: 拷貝出來不要被清掉
# ─────────────────────────────────────────────────────────────
step "Step 2 · 拷貝到 ~/nemoclaw-custom-$(date +%s)"

CUSTOM_DIR=~/nemoclaw-custom-$(date +%s)
cp -r "$BUILD_DIR" "$CUSTOM_DIR"
ok "拷貝完成：$CUSTOM_DIR"

DOCKERFILE="$CUSTOM_DIR/Dockerfile"
if [ ! -f "$DOCKERFILE" ]; then
  err "$DOCKERFILE 不存在"
  ls "$CUSTOM_DIR"
  exit 1
fi
ok "Dockerfile 找到：$DOCKERFILE"

# ─────────────────────────────────────────────────────────────
# Step 3: Patch Dockerfile 強制降版 OpenClaw
# ─────────────────────────────────────────────────────────────
step "Step 3 · Patch Dockerfile (force OpenClaw downgrade)"

DOCKERFILE_PATH="$DOCKERFILE" python3 << 'PYEOF'
import re, shutil, sys, os

dockerfile = os.environ['DOCKERFILE_PATH']
shutil.copy(dockerfile, dockerfile + ".orig")

with open(dockerfile) as f:
    content = f.read()

# 找 Step 16 RUN 裡的 if/else 版本檢查 block，整段替換成「強制 install MIN_VER」
# 原本是：if [ ... ]; then echo no upgrade; else npm install MIN_VER; fi;
# 變成：echo path-A; rm -rf openclaw; npm install MIN_VER;
pattern = re.compile(
    r"if \[ \"\$\(printf '%s\\\\n%s' \"\$MIN_VER\" \"\$CUR_VER\" \| sort -V \| head -n1\)\" = \"\$MIN_VER\" \];\s+then.*?fi;",
    re.DOTALL
)

# 簡化版 pattern（避免反斜線地獄）
pattern = re.compile(
    r"if \[ \"\$\(printf.+?fi;",
    re.DOTALL
)

replacement = (
    'echo "INFO: GatherEase Path A — forcing OpenClaw to $MIN_VER for rcf_patch.py compat";     '
    'rm -rf /usr/local/lib/node_modules/openclaw /usr/local/bin/openclaw;     '
    'npm install -g --no-audit --no-fund --no-progress "openclaw@${MIN_VER}";'
)

new_content, count = pattern.subn(replacement, content, count=1)

if count == 0:
    print("❌ Step 16 if/else pattern not found — Dockerfile 結構可能變了")
    print()
    print("--- Dockerfile 前 100 行 ---")
    for i, line in enumerate(content.split('\n')[:100], 1):
        print(f"  {i}: {line[:160]}")
    sys.exit(1)

with open(dockerfile, 'w') as f:
    f.write(new_content)

print(f"✅ Step 16 patched (count={count})")
print(f"   原檔備份：{dockerfile}.orig")
print()
print("--- patched section（含關鍵字 'GatherEase Path A' 或 'MIN_VER'）---")
for i, line in enumerate(new_content.split('\n'), 1):
    if 'GatherEase Path A' in line or 'openclaw@${MIN_VER}' in line:
        print(f"  L{i}: {line[:180]}")
PYEOF

# ─────────────────────────────────────────────────────────────
# Step 4: 印出下一步指令
# ─────────────────────────────────────────────────────────────
step "Step 4 · 下一步"

cat <<EOF

${GREEN}準備好了。${NC} 跑這個指令觸發 build（5-15 分鐘）：

  ${BLUE}nemoclaw onboard --from $DOCKERFILE${NC}

預期：
  - Step 16 會看到 "INFO: GatherEase Path A — forcing OpenClaw to 2026.4.24"
  - Step 17 COPY rcf_patch.py（不變）
  - Step 18 RUN rcf_patch.py — ${GREEN}如果降版成功、這次應該過${NC}
  - Steps 19–62 繼續跑、sandbox image 完成
  - [7/8] [8/8] onboard 結束、印 "Sandbox is ready" 或類似

如果 Step 18 還是掛同樣 rcf_patch.py error → 2026.4.24 也不是答案，
要再試更舊版（用 openclaw@2026.3.x），或回 Path C。

監看進度（另一 tab）：
  ${BLUE}watch -n 3 'docker ps --format "table {{.Names}}\t{{.Status}}" | head'${NC}

備份原 Dockerfile：
  $DOCKERFILE.orig

EOF
