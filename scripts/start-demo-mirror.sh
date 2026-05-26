#!/usr/bin/env bash
#
# scripts/start-demo-mirror.sh
#
# 啟動 demo mirror server，serve factory-quote-demo.html + 4 個 /api endpoints
# 從 nemoclaw CLI 抓真實 sandbox / skills / policy / audit data。
#

set -euo pipefail
cd "$(dirname "$0")/.."

# Kill 舊 mirror process (避免 port 衝突)
pkill -f 'demo-mirror-server.js' 2>/dev/null || true
sleep 1

# Sanity check
if ! command -v nemoclaw >/dev/null 2>&1; then
  echo "❌ nemoclaw CLI 不在 PATH"
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "❌ node 不在 PATH"
  exit 1
fi

# express 是 host 已裝的 dep (orchestrator 階段裝過)
if [ ! -d node_modules/express ]; then
  echo "▶ 安裝 express..."
  npm install --no-save --silent express 2>&1 | tail -3
fi

# Quick smoke test：nemoclaw status 能跑
if ! nemoclaw status --json >/dev/null 2>&1; then
  echo "❌ nemoclaw status --json 跑不起來。請確認 sandbox 在跑：nemoclaw list"
  exit 1
fi

# Start
export MIRROR_PORT="${MIRROR_PORT:-8000}"
export NEMOCLAW_SANDBOX="${NEMOCLAW_SANDBOX:-gatherease-quote-agent}"

exec node scripts/demo-mirror-server.js
