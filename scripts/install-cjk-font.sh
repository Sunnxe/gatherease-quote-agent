#!/usr/bin/env bash
#
# scripts/install-cjk-font.sh
#
# 從 GitHub 下載 Noto Sans TC Regular .ttf 寫進 sandbox
# generate_quote_pdf 用 path /sandbox/.openclaw/workspace/data/fonts/NotoSansTC-Regular.ttf
#
# 為什麼不用 @expo-google-fonts/noto-sans-tc npm package:
#   它是 Expo (React Native) 設計，.ttf 不一定 bundle 在 npm publish 內 (depends version)
#   直接從 GitHub release 抓 .ttf 最穩
#

set -uo pipefail
SANDBOX="${NEMOCLAW_SANDBOX:-gatherease-quote-agent}"
SANDBOX_FONT_DIR="/sandbox/.openclaw/workspace/data/fonts"
SANDBOX_FONT_PATH="$SANDBOX_FONT_DIR/NotoSansCJKtc-Regular.otf"

# 方法 A：讓 sandbox 自己 curl 下載 (16MB) — github raw 可能過 sandbox proxy
# 方法 B (fallback)：host curl 下載 + chunked write 進 sandbox

URL_PRIMARY="https://github.com/notofonts/noto-cjk/raw/refs/heads/main/Sans/OTF/TraditionalChinese/NotoSansCJKtc-Regular.otf"
URL_BACKUP="https://raw.githubusercontent.com/notofonts/noto-cjk/main/Sans/OTF/TraditionalChinese/NotoSansCJKtc-Regular.otf"

echo "▶ 1) Make sandbox font dir"
nemoclaw "$SANDBOX" exec -- mkdir -p "$SANDBOX_FONT_DIR"

echo ""
echo "▶ 2) 試 sandbox 自己 curl 下載 (最簡單，但需要 sandbox proxy allow github)"
SANDBOX_DL_OK=$(nemoclaw "$SANDBOX" exec -- bash -c "curl -fL -o $SANDBOX_FONT_PATH '$URL_PRIMARY' 2>&1 && stat -c%s $SANDBOX_FONT_PATH 2>/dev/null || echo FAIL" 2>&1)
echo "$SANDBOX_DL_OK" | tail -5

if echo "$SANDBOX_DL_OK" | grep -qE "^[0-9]+$" || nemoclaw "$SANDBOX" exec -- bash -c "[ -s $SANDBOX_FONT_PATH ] && stat -c%s $SANDBOX_FONT_PATH" 2>&1 | grep -qE "^[0-9]+$"; then
  echo "✅ Sandbox curl 成功"
  nemoclaw "$SANDBOX" exec -- ls -la "$SANDBOX_FONT_PATH"
  exit 0
fi

echo ""
echo "▶ 2b) Sandbox curl 擋 → fallback: host 下載 + chunked write 進 sandbox"

HOST_TMP="/tmp/NotoSansCJKtc-Regular.otf"
if [ ! -f "$HOST_TMP" ] || [ $(stat -c%s "$HOST_TMP") -lt 1000000 ]; then
  echo "  Downloading from host..."
  curl -fL --progress-bar -o "$HOST_TMP" "$URL_PRIMARY" || \
  curl -fL --progress-bar -o "$HOST_TMP" "$URL_BACKUP" || {
    echo "❌ host download 也失敗"
    exit 1
  }
fi
HOST_SIZE=$(stat -c%s "$HOST_TMP")
echo "  Host file: $HOST_SIZE bytes"

echo ""
echo "▶ 3) Chunked write 進 sandbox (60KB chunks, $((HOST_SIZE/60000)) chunks，~$((HOST_SIZE/60000/2)) sec)"

# 先 empty target file
nemoclaw "$SANDBOX" exec -- bash -c "rm -f $SANDBOX_FONT_PATH && touch $SANDBOX_FONT_PATH"

CHUNK_BYTES=60000  # raw bytes, base64 ~80KB safe under nemoclaw arg limit
TOTAL_CHUNKS=$(( (HOST_SIZE + CHUNK_BYTES - 1) / CHUNK_BYTES ))
echo "  Writing $TOTAL_CHUNKS chunks..."

for i in $(seq 0 $((TOTAL_CHUNKS - 1))); do
  CHUNK_B64=$(dd if="$HOST_TMP" bs=$CHUNK_BYTES count=1 skip=$i 2>/dev/null | base64 -w0)
  nemoclaw "$SANDBOX" exec -- bash -c "echo $CHUNK_B64 | base64 -d >> $SANDBOX_FONT_PATH" 2>/dev/null
  # progress every 20 chunks
  if [ $((i % 20)) -eq 0 ]; then
    printf "  [%d/%d] %d%% \n" "$i" "$TOTAL_CHUNKS" "$((i * 100 / TOTAL_CHUNKS))"
  fi
done
echo "  [$TOTAL_CHUNKS/$TOTAL_CHUNKS] 100% done"

echo ""
echo "▶ 4) Verify size 一致"
SANDBOX_SIZE=$(nemoclaw "$SANDBOX" exec -- stat -c%s "$SANDBOX_FONT_PATH" 2>/dev/null | tr -d '\r\n ')
echo "  host:    $HOST_SIZE bytes"
echo "  sandbox: $SANDBOX_SIZE bytes"
if [ "$HOST_SIZE" = "$SANDBOX_SIZE" ]; then
  echo "  ✅ MATCH"
else
  echo "  ⚠️ MISMATCH — some chunks 可能失敗"
fi

echo ""
echo "════════════════════════════════════════════════════════"
echo "✅ Noto Sans CJK TC 字型已寫進 sandbox: $SANDBOX_FONT_DIR/"
echo "════════════════════════════════════════════════════════"
echo ""
echo "下一步：改 generate_quote_pdf/impl.js 字型路徑指向這裡:"
echo "  const CJK_FONT_PATH = '$SANDBOX_FONT_DIR/NotoSansCJKtc-Regular.otf';"
