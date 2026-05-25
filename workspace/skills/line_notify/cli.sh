#!/usr/bin/env bash
#
# line_notify skill CLI entry
# stdin: JSON {hold_id, gate, summary, options}
# stdout: JSON {status: "pushed", hold_id, ...}
#
# 推完立刻 return，不阻塞等老闆。Agent 接著在 chat 等 user message 進來。
#

set -euo pipefail
SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$SKILL_DIR/impl.js"
