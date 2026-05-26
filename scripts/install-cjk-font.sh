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

set -euo pipefail
SANDBOX="${NEMOCLAW_SANDBOX:-gatherease-quote-agent}"
SANDBOX_FONT_DIR="/sandbox/.openclaw/workspace/data/fonts"

# Noto Sans TC Regular 完整版（含繁體常用字）
# Source: notofonts.github.io releases (Google Noto 官方)
FONT_URL="https://github.com/notofonts/noto-cjk/raw/main/Sans/SubsetOTF/TC/NotoSansCJKtc-Regular.otf"
HOST_TMP="/tmp/NotoSansCJKtc-Regular.otf"

echo "▶ 1) Download Noto Sans CJK TC Regular .otf (約 6 MB)"
if [ ! -f "$HOST_TMP" ]; then
  curl -fL --progress-bar -o "$HOST_TMP" "$FONT_URL" || {
    echo "❌ download failed — 試 fallback URL"
    # Fallback：用 Google Fonts CDN raw URL
    curl -fL --progress-bar -o "$HOST_TMP" \
      "https://github.com/notofonts/noto-cjk/raw/refs/heads/main/Sans/OTF/TraditionalChinese/NotoSansCJKtc-Regular.otf" || exit 1
  }
fi
ls -la "$HOST_TMP"

echo ""
echo "▶ 2) Make sandbox font dir"
nemoclaw "$SANDBOX" exec -- mkdir -p "$SANDBOX_FONT_DIR"

echo ""
echo "▶ 3) base64 + stdin pipe 寫進 sandbox (~6MB)"
# 用 spawn stdin pipe 避 ARG_MAX
node -e "
const fs = require('fs');
const { spawn } = require('child_process');
const b64 = fs.readFileSync('$HOST_TMP').toString('base64');
const proc = spawn('nemoclaw', ['$SANDBOX', 'exec', '--', 'bash', '-c',
  'base64 -d > $SANDBOX_FONT_DIR/NotoSansCJKtc-Regular.otf']);
let stderr = '';
proc.stderr.on('data', d => { stderr += d; });
proc.on('close', code => {
  if (code === 0) console.log('✓ written');
  else { console.error('FAIL code', code, stderr); process.exit(1); }
});
proc.stdin.write(b64);
proc.stdin.end();
"

echo ""
echo "▶ 4) Verify sandbox 內 font size 一致"
HOST_SIZE=$(stat -c%s "$HOST_TMP")
echo "  host: $HOST_SIZE bytes"
nemoclaw "$SANDBOX" exec -- bash -c "echo '  sandbox:' \$(stat -c%s $SANDBOX_FONT_DIR/NotoSansCJKtc-Regular.otf) 'bytes'"

echo ""
echo "════════════════════════════════════════════════════════"
echo "✅ Noto Sans CJK TC 字型已寫進 sandbox: $SANDBOX_FONT_DIR/"
echo "════════════════════════════════════════════════════════"
echo ""
echo "下一步：改 generate_quote_pdf/impl.js 字型路徑指向這裡:"
echo "  const CJK_FONT_PATH = '$SANDBOX_FONT_DIR/NotoSansCJKtc-Regular.otf';"
