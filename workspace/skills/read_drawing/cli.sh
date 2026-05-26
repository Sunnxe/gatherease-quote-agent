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
if [ ! -d "$SKILL_DIR/node_modules/pdf-to-png-converter" ]; then
  echo "[read_drawing] first run: installing pdf-to-png-converter (~15s)..." >&2
  cd "$SKILL_DIR"
  if [ ! -f package.json ]; then
    echo '{"name":"read_drawing","version":"1.0.0","private":true}' > package.json
  fi
  npm install --no-audit --no-fund --silent pdf-to-png-converter >&2 || {
    echo "[read_drawing] npm install pdf-to-png-converter FAILED — fallback to mock will activate" >&2
  }
fi

exec node "$SKILL_DIR/impl.js"
