#!/usr/bin/env bash
#
# inbox_watch skill CLI entry
# stdin: JSON {action, mode, order_id?, sender_contains?, max_messages?, ...}
# stdout: JSON {fetched_count, messages: [...]}
#

set -euo pipefail
SKILL_DIR="$(cd "$(dirname "$0")" && pwd)"

WORKSPACE_DIR="$(cd "$SKILL_DIR/../.." && pwd)"
[ -f "$WORKSPACE_DIR/.env" ] && { set -a; source "$WORKSPACE_DIR/.env"; set +a; }

# Lazy install IMAP + MIME + PDF dep (first run only, ~10s)
NEED_INSTALL=0
for pkg in imapflow mailparser pdf-parse; do
  [ -d "$SKILL_DIR/node_modules/$pkg" ] || NEED_INSTALL=1
done

if [ "$NEED_INSTALL" = "1" ]; then
  echo "[inbox_watch] first run: installing imapflow + mailparser + pdf-parse..." >&2
  if [ ! -f "$SKILL_DIR/package.json" ]; then
    echo '{"name":"inbox-watch-deps","version":"0.0.0","private":true}' > "$SKILL_DIR/package.json"
  fi
  # Pin pdf-parse to 1.1.1 — 新版 2.x exports map 不允許 subpath require
  ( cd "$SKILL_DIR" && npm install --silent --omit=optional imapflow mailparser pdf-parse@1.1.1 2>&1 | tail -3 ) >&2
fi

exec node "$SKILL_DIR/impl.js"
