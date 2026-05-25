#!/usr/bin/env bash
#
# send_email skill CLI entry
# stdin: JSON {to, subject, body, from?}
# stdout: JSON {status: "sent", message_id, ...}
#

set -euo pipefail
SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$SKILL_DIR/impl.js"
