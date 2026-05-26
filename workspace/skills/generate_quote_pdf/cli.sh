#!/usr/bin/env bash
#
# generate_quote_pdf skill CLI entry
# stdin: JSON {order_id, customer, product, qty, prices, lead, terms, signed_by}
# stdout: JSON {status, pdf_path, ...}
#

set -euo pipefail
SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"

WORKSPACE_DIR="$(cd "$SKILL_DIR/../.." && pwd)"
[ -f "$WORKSPACE_DIR/.env" ] && { set -a; source "$WORKSPACE_DIR/.env"; set +a; }

# Lazy install pdfkit + Noto Sans TC CJK 字型 (約 14MB, 第一次 ~30s)
# @expo-google-fonts/noto-sans-tc 內含 .ttf 直接給 pdfkit registerFont
if [ ! -d "$SKILL_DIR/node_modules/pdfkit" ] || [ ! -d "$SKILL_DIR/node_modules/@expo-google-fonts/noto-sans-tc" ]; then
  echo "[generate_quote_pdf] first run: installing pdfkit + Noto Sans TC CJK (~30s, ~14MB)..." >&2
  if [ ! -f "$SKILL_DIR/package.json" ]; then
    echo '{"name":"generate-quote-pdf-deps","version":"0.0.0","private":true}' > "$SKILL_DIR/package.json"
  fi
  ( cd "$SKILL_DIR" && npm install --no-audit --no-fund pdfkit @expo-google-fonts/noto-sans-tc 2>&1 | tail -5 ) >&2
  if [ -d "$SKILL_DIR/node_modules/@expo-google-fonts/noto-sans-tc" ]; then
    echo "[generate_quote_pdf] ✓ CJK font installed" >&2
  else
    echo "[generate_quote_pdf] ⚠️ CJK font install failed → PDF 中文會亂碼" >&2
  fi
fi

exec node "$SKILL_DIR/impl.js"
