#!/usr/bin/env bash
#
# read_drawing skill CLI entry
# stdin: JSON {drawing_pdf_path, customer_id, ...}
# stdout: JSON {product_id, specs, bom, confidence, ...}
# exit: 0 = success, non-zero = error (message in stderr)
#

set -euo pipefail

SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"

# 把 stdin 跟 SKILL_DIR 傳給 impl.js
exec node "$SKILL_DIR/impl.js"
