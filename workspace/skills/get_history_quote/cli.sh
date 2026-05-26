#!/usr/bin/env bash
#
# get_history_quote skill CLI entry
# stdin: JSON {new_order, k}
# stdout: JSON {matches, _meta}
#

set -euo pipefail
SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"

WORKSPACE_DIR="$(cd "$SKILL_DIR/../.." && pwd)"
[ -f "$WORKSPACE_DIR/.env" ] && { set -a; source "$WORKSPACE_DIR/.env"; set +a; }

exec node "$SKILL_DIR/impl.js"
