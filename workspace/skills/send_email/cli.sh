#!/usr/bin/env bash
#
# send_email skill CLI entry
# stdin: JSON {to, subject, body}
# stdout: JSON {status: "sent", message_id, ...}
#

set -euo pipefail
SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"

WORKSPACE_DIR="$(cd "$SKILL_DIR/../.." && pwd)"
[ -f "$WORKSPACE_DIR/.env" ] && { set -a; source "$WORKSPACE_DIR/.env"; set +a; }

exec node "$SKILL_DIR/impl.js"
