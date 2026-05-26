#!/usr/bin/env bash
#
# check_schedule skill CLI entry
# stdin: JSON {product_id, qty, customer_desired_lead_days, surface_treatment_lead_days?}
# stdout: JSON {total_lead_time_days, gap_days, achievable, ...}
#

set -euo pipefail
SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"

WORKSPACE_DIR="$(cd "$SKILL_DIR/../.." && pwd)"
[ -f "$WORKSPACE_DIR/.env" ] && { set -a; source "$WORKSPACE_DIR/.env"; set +a; }

exec node "$SKILL_DIR/impl.js"
