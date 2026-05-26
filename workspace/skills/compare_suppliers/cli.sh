#!/usr/bin/env bash
#
# compare_suppliers skill CLI entry
# stdin: JSON {supplier_ids, customer_requirements}
# stdout: JSON {candidates, ...}
#

set -euo pipefail
SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"

WORKSPACE_DIR="$(cd "$SKILL_DIR/../.." && pwd)"
[ -f "$WORKSPACE_DIR/.env" ] && { set -a; source "$WORKSPACE_DIR/.env"; set +a; }

exec node "$SKILL_DIR/impl.js"
