#!/usr/bin/env bash
#
# compare_suppliers skill CLI entry
# stdin: JSON {supplier_ids: [...], customer_requirements: {...}}
# stdout: JSON [...3 suppliers compared...]
#

set -euo pipefail
SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$SKILL_DIR/impl.js"
