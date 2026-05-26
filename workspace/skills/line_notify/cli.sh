#!/usr/bin/env bash
#
# line_notify skill CLI entry
# stdin: JSON {hold_id, gate, summary, options}
# stdout: JSON {status: "pushed", ...}
#

set -euo pipefail
SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"

WORKSPACE_DIR="$(cd "$SKILL_DIR/../.." && pwd)"
[ -f "$WORKSPACE_DIR/.env" ] && { set -a; source "$WORKSPACE_DIR/.env"; set +a; }

exec node "$SKILL_DIR/impl.js"
