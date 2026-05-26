#!/usr/bin/env bash
#
# read_drawing skill CLI entry
# stdin: JSON {drawing_pdf_path, customer_id, ...}
# stdout: JSON {product_id, specs, bom, confidence, ...}
#

set -euo pipefail
SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"

# Load workspace .env (sandbox 內 deploy-skills.sh 會寫進 /sandbox/.openclaw/workspace/.env)
WORKSPACE_DIR="$(cd "$SKILL_DIR/../.." && pwd)"
[ -f "$WORKSPACE_DIR/.env" ] && { set -a; source "$WORKSPACE_DIR/.env"; set +a; }

# Lazy install pdf-to-png-converter (純 JS PDF→PNG，內部 pdfjs-dist + @napi-rs/canvas
# prebuilt binary，不需要 system poppler-utils。第一次跑 ~15s 裝下來)
# 仿 inbox_watch 模式：不 --silent，讓 npm 輸出 tail -3 給 stderr，install 失敗看得見
if [ ! -d "$SKILL_DIR/node_modules/pdf-to-png-converter" ]; then
  echo "[read_drawing] first run: installing pdf-to-png-converter (~15-30s)..." >&2
  if [ ! -f "$SKILL_DIR/package.json" ]; then
    echo '{"name":"read-drawing-deps","version":"0.0.0","private":true}' > "$SKILL_DIR/package.json"
  fi
  # ⚠️ 不能加 --omit=optional！@napi-rs/canvas 的 platform-specific
  # prebuilt binary 是 optional dependency（每個 OS/arch 一個），少了
  # 就 "Cannot find native binding" (npm bug #4828)
  ( cd "$SKILL_DIR" && npm install --no-audit --no-fund pdf-to-png-converter 2>&1 | tail -8 ) >&2
  if [ -d "$SKILL_DIR/node_modules/pdf-to-png-converter" ]; then
    echo "[read_drawing] ✓ pdf-to-png-converter installed" >&2
  else
    echo "[read_drawing] ⚠️ pdf-to-png-converter install failed → impl.js fallback to mock" >&2
  fi
fi

exec node "$SKILL_DIR/impl.js"
