#!/usr/bin/env bash
#
# scripts/add-vision-model.sh
#
# 在 sandbox openclaw.json 內註冊 vision model：
#   nvidia/llama-3.1-nemotron-nano-vl-8b-v1 (NVIDIA Nemotron VL)
#
# 為什麼需要：
#   NemoClaw 的 nemoclaw-nemotron-inference-fix.js guard 強制把所有
#   inference request 重 route 到 openclaw.json registered 的主模型。
#   如果只註冊 nemotron-3-super-120b-a12b (純文字)，sandbox 內任何
#   vision call 都會被改成 nemotron-super 而忽略 image。
#
#   把 vision model 加進 models block 後，inference.local 才會
#   transparent forward vision request 到對應的 NIM endpoint。
#
# 用法：./scripts/add-vision-model.sh
#

set -euo pipefail
SANDBOX="${NEMOCLAW_SANDBOX:-gatherease-quote-agent}"
CFG="/sandbox/.openclaw/openclaw.json"

PYSCRIPT=$(cat <<'PYEOF'
import json, sys
PATH = "/sandbox/.openclaw/openclaw.json"
with open(PATH) as f:
    cfg = json.load(f)

models = cfg["models"]["providers"]["inference"]["models"]

# 要加的 vision model — Nemotron VL (NVIDIA 全家族)
VISION_MODELS = [
    {
        "id": "nvidia/llama-3.1-nemotron-nano-vl-8b-v1",
        "name": "inference/nvidia/llama-3.1-nemotron-nano-vl-8b-v1",
        "reasoning": False,
        "input": ["text", "image"],
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        "contextWindow": 32768,
        "maxTokens": 4096
    },
    # backup: meta llama vision (備用，跟 read_drawing 原本 code 兼容)
    {
        "id": "meta/llama-3.2-90b-vision-instruct",
        "name": "inference/meta/llama-3.2-90b-vision-instruct",
        "reasoning": False,
        "input": ["text", "image"],
        "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0},
        "contextWindow": 131072,
        "maxTokens": 4096
    }
]

existing_ids = {m.get("id") for m in models}
added = []
for vm in VISION_MODELS:
    if vm["id"] not in existing_ids:
        models.append(vm)
        added.append(vm["id"])

with open(PATH, "w") as f:
    json.dump(cfg, f, indent=2)

print(f"added: {added}")
print(f"total models now: {len(models)}")
for m in models:
    print(f"  - {m['id']} ({'+'.join(m.get('input', ['text']))})")
PYEOF
)

B64=$(echo -n "$PYSCRIPT" | base64 -w0 2>/dev/null || echo -n "$PYSCRIPT" | base64 | tr -d '\n')

echo "▶ 1) Backup openclaw.json"
nemoclaw "$SANDBOX" exec -- cp -v "$CFG" "${CFG}.before-add-vision.$(date +%s)"
echo ""

echo "▶ 2) 寫 python script 進 sandbox /tmp"
nemoclaw "$SANDBOX" exec -- bash -c "echo $B64 | base64 -d > /tmp/add_vision.py"

echo ""
echo "▶ 3) 跑 python script"
nemoclaw "$SANDBOX" exec -- python3 /tmp/add_vision.py
echo ""

echo "▶ 4) Recover gateway 讓 config reload"
nemoclaw "$SANDBOX" recover
echo ""

echo "▶ 5) Verify vision model 真註冊"
nemoclaw "$SANDBOX" exec -- python3 -c "import json; d=json.load(open('$CFG')); m=d['models']['providers']['inference']['models']; print('Total:', len(m)); [print(' -', x['id']) for x in m]"
echo ""

echo "════════════════════════════════════════════════════════"
echo "✅ Vision model 加進 sandbox openclaw.json"
echo "════════════════════════════════════════════════════════"
echo ""
echo "測試："
echo "  nemoclaw $SANDBOX exec -- bash -c 'echo \"{\\\"model\\\":\\\"nvidia/llama-3.1-nemotron-nano-vl-8b-v1\\\",\\\"messages\\\":[{\\\"role\\\":\\\"user\\\",\\\"content\\\":\\\"hi\\\"}],\\\"max_tokens\\\":20}\" > /tmp/vt.json && curl -sS -X POST https://inference.local/v1/chat/completions -H \"Content-Type: application/json\" -d @/tmp/vt.json' | head -5"
echo ""
echo "response 內 'model' field 應該不再是 nemotron-3-super，而是 llama-3.1-nemotron-nano-vl-8b-v1"
