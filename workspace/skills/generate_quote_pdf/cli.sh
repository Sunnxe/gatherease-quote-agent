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

# Lazy install pdfkit (first run only; NemoClaw npm preset allows npmjs.org)
if [ ! -d "$SKILL_DIR/node_modules/pdfkit" ]; then
  echo "[generate_quote_pdf] first run: installing pdfkit..." >&2
  # Minimal package.json 避免 npm walk up parent dir 找到別人的 package.json
  if [ ! -f "$SKILL_DIR/package.json" ]; then
    echo '{"name":"generate-quote-pdf-deps","version":"0.0.0","private":true}' > "$SKILL_DIR/package.json"
  fi
  ( cd "$SKILL_DIR" && npm install --silent --omit=optional pdfkit 2>&1 | tail -3 ) >&2
fi

exec node "$SKILL_DIR/impl.js"
