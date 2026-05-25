#!/usr/bin/env bash
#
# get_history_quote skill CLI entry
# stdin: JSON {new_order: {ProductName, OrderDate, Hardness, Spec}, k}
# stdout: JSON {matches: [...], _meta: {...}}
#

set -euo pipefail
SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$SKILL_DIR/impl.js"
