#!/usr/bin/env bash
#
# calc_cost skill CLI entry
# stdin: JSON {product_id, bom, qty, surface_treatment_supplier_id?, customer_tier?}
# stdout: JSON {unit_cost_twd, suggested_unit_price_twd, ...}
#

set -euo pipefail
SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"

WORKSPACE_DIR="$(cd "$SKILL_DIR/../.." && pwd)"
[ -f "$WORKSPACE_DIR/.env" ] && { set -a; source "$WORKSPACE_DIR/.env"; set +a; }

exec node "$SKILL_DIR/impl.js"
