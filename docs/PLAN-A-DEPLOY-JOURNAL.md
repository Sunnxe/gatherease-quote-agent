# Plan A 部署日誌 — sandbox agent 跑通到目前的完整紀錄

> 給新 chat session 接手用：讀完這份就有完整 context。
> Last updated: 2026-05-26 (Day 2 半夜)

---

## 一句話現況

**所有 messaging 雙向通了——sandbox agent 能 call 10 個 skill、走 host email bridge 真寄真收 Gmail（含 PDF 附件）、push LINE flex、收 LINE postback。** 剩 task #52「LINE webhook 收 postback 後注入 agent message」就能跑 13-step orchestrated flow 寫完 e2e demo。

---

## 系統架構（5 層 + bridge 細節）

```
┌─────────────────────────────────────────────────────────┐
│ Browser (Mac)                                            │
│   http://localhost:8000/factory-quote-demo.html          │
│   - LINE 風格手機 UI 左邊                                │
│   - Sandbox Activity panel (右上)                        │
│   - Agent Thinking panel (右中) + Trigger 輸入框        │
└──────────────────┬──────────────────────────────────────┘
                   │ Brev SSH port-forward 8000
                   ↓
┌─────────────────────────────────────────────────────────┐
│ VM host (Brev Ubuntu 24.04 — brev-uzbvgjufc)             │
│                                                          │
│   ┌─ scripts/demo-mirror-server.js (port 8000) ──────┐  │
│   │   GET  /api/status, /api/skills, /api/policies    │  │
│   │   GET  /api/sandbox-activity (nemoclaw logs)      │  │
│   │   GET  /api/agent-session (session jsonl 解析)    │  │
│   │   POST /api/agent-trigger (spawn openclaw agent)  │  │
│   │   GET  /api/agent-trigger-log (debug log)         │  │
│   └────────────────────────────────────────────────────┘  │
│                                                          │
│   ┌─ scripts/email-bridge.js ────────────────────────┐  │
│   │   Outbox poller (5s):                            │  │
│   │     nemoclaw exec ls /sandbox/.../outbox/        │  │
│   │     → cat → spawn host send_email cli.sh         │  │
│   │     → SMTP smtp.gmail.com:587 真寄                │  │
│   │     → mv to outbox/sent/                         │  │
│   │   Inbox poller (30s):                            │  │
│   │     IMAP imap.gmail.com:993 search 詢價/RFQ      │  │
│   │     fetch uid (uid range mode) → mailparser      │  │
│   │     寫 sandbox /data/inbox/<uid>.json            │  │
│   │     大附件 stdin pipe → /data/incoming/<file>    │  │
│   └────────────────────────────────────────────────────┘  │
│                                                          │
│   ┌─ skills/line_notify/webhook.js (port 3000) ──────┐  │
│   │   LINE Messaging API webhook                     │  │
│   │   POST /webhook/line: signature verify, postback │  │
│   │   resolveHold (legacy orchestrator)              │  │
│   │   TODO #52: 注入 agent message                   │  │
│   └────────────────────────────────────────────────────┘  │
│                                                          │
└──────────────────┬──────────────────────────────────────┘
                   │ nemoclaw <sandbox> exec --
                   ↓
┌─────────────────────────────────────────────────────────┐
│ NemoClaw sandbox "gatherease-quote-agent" (Linux)        │
│   - Landlock fs + seccomp + network namespace            │
│   - egress: squid HTTP proxy (HTTPS only, no SMTP/IMAP)  │
│   - policies: gmail-smtp, gmail-imap, line-messaging     │
│     (gmail-smtp/imap 是 stub — proxy 不認 SMTP/IMAP)     │
│   - OpenClaw gateway (ws://127.0.0.1:18789)              │
│     ⚠️ 走 embedded fallback (scope upgrade pending)       │
│   - Agent: main (Nemotron-3-Super-120B via NIM)          │
│     skipBootstrap=false + toolSearch=false               │
│   workspace: /sandbox/.openclaw/workspace/               │
│     - AGENTS/TOOLS/IDENTITY/SOUL/USER.md + .env          │
│     - data/{outbox,inbox,incoming}/  ← bridge 用         │
│     - skills/ (10 個 cli.sh + SKILL.md + impl.js)        │
└─────────────────────────────────────────────────────────┘
```

---

## 完整部署順序（成功復現步驟）

### Phase 1 — VM 環境
1. Brev provision Ubuntu **24.04**（22.04 glibc 2.35 跑 NemoClaw 會炸）
2. `curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash` 裝 NemoClaw
3. Tailscale 加入 tailnet
4. `nemoclaw onboard <sandbox-name>`
5. `nemoclaw <sandbox> policy-add presets/gatherease-egress.yaml` × 3 preset

### Phase 2 — Skills + workspace
1. `workspace/skills/` 寫 10 個 skill：order_store, inbox_watch, read_drawing, get_history_quote, check_schedule, calc_cost, compare_suppliers, line_notify, send_email, generate_quote_pdf
2. `workspace/` 寫 5 份 markdown：AGENTS, TOOLS, IDENTITY, SOUL, USER + .env
3. `scripts/deploy-skills-to-workspace.sh` — base64 + nemoclaw exec single-line bash -c
   - **不能用** `nemoclaw skill install` → 那會裝到 managed scope，agent exec 看不到
   - 必須直接寫 `/sandbox/.openclaw/workspace/skills/<name>/`
   - **>100KB 檔自動 skip**（避 ARG_MAX）

### Phase 3 — Mirror server + HTML
1. `scripts/demo-mirror-server.js` (Express + cache + 5 endpoints + script(1) TTY wrap)
2. `showcase/factory-quote-demo.html` (LINE UI + 3 個 live panel + trigger 輸入框)

### Phase 4 — Agent config fix（解 toolCount=1）
跑 `scripts/fix-agent-tools.sh` 改 `/sandbox/.openclaw/openclaw.json`：
```diff
agents.defaults:
- skipBootstrap: true       (→ agent 看不到 exec/file_read/file_write)
+ skipBootstrap: false
- timeoutSeconds: 60
+ timeoutSeconds: 600
tools:
- toolSearch: true          (強制 tool_search_code wrapper)
+ toolSearch: false         (直接暴露所有 tool)
```
然後 `nemoclaw <sandbox> recover` reload gateway。

### Phase 5 — Mirror server TTY fix
mirror server `execAsync` wrap `script -qec 'cmd' /dev/null` 偽 TTY，strip `\r\r\n` → `\n`。
不包 nemoclaw 從 Node child_process exec 跑會 silent fail。

### Phase 6 — Host email bridge 架構
1. `scripts/install-host-deps.sh` 在 host 裝 `imapflow + mailparser + pdf-parse + @line/bot-sdk + express`（寫進 `workspace/skills/inbox_watch/node_modules` + `skills/line_notify/node_modules`）
2. `workspace/skills/send_email/impl.js` + `inbox_watch/impl.js` 加 `detectBridgeMode()`：sandbox 內路徑 → 走 outbox/inbox JSON 檔
3. `scripts/email-bridge.js` 在 host 跑（nohup background）：
   - Outbox poller 5s nemoclaw exec ls → cat → spawn host cli.sh 走 SMTP 真寄
   - Inbox poller 30s IMAP `search({seen:false, or:[詢價/RFQ/...]})` → fetch uid range → 寫 sandbox JSON + attachment（stdin pipe）
4. `scripts/start-all.sh` 一鍵 nohup 起 mirror + email-bridge + line-webhook 三個 service

---

## 卡關全紀錄（按發現順序）

### A) `nemoclaw exec` 不接受 newline / CR 的 args
- **症狀**：`bash -c '<multi-line heredoc>'` → grpc reject "command argument 2 contains newline"
- **解法**：所有命令 single-line。Python 多行用 base64 encode 寫到 sandbox `/tmp/x.py` 再 `python3 /tmp/x.py`

### B) Agent `toolCount=1`，只有 `tool_search_code` wrapper
- **症狀**：trajectory 顯示 `capabilities=none, toolCount=1, clientToolCount=0`。Agent 拼命用 wrapper 寫 JS 模擬 `require('child_process')` / `openclaw.tools.call({skill, input})` 等等，鬼打牆 15+ 次
- **根因**：`agents.defaults.skipBootstrap=true` 跳過內建工具註冊 + `tools.toolSearch=true` 強制 wrapper
- **解法**：fix-agent-tools.sh 改三個 flag

### C) Gateway scope upgrade pending approval
- **症狀**：改 skipBootstrap=false 後每次 `openclaw agent` 跑都出現 `scope upgrade pending approval (requestId: ...)`，gateway 拒接 → fallback embedded agent
- **嘗試解**：`openclaw devices approve <id>` → "unknown requestId"（每次 run 產生新 id，race condition）
- **現狀**：**接受 embedded fallback**。功能 100% work，session jsonl 也寫進標準路徑 `/sandbox/.openclaw/agents/main/sessions/`，HTML panel 抓得到

### D) Dashboard chat 連到 Mac local 不是 sandbox
- **解法**：放棄 dashboard chat，HTML 加 trigger 輸入框 + `POST /api/agent-trigger`

### E) mirror server spawn 啞掉 debug 不到
- **症狀**：`/api/agent-trigger` 回 200 但 sandbox 沒新 session、stdout/stderr 都 `ignore` 看不到
- **解法**：spawn `stdio: ['ignore', logFd, logFd]` 寫 `/tmp/gatherease-agent-trigger.log`，加 `/api/agent-trigger-log` endpoint tail

### F) nemoclaw CLI 從 Node child_process exec 跑 silent fail（**最迷人**）
- **症狀**：terminal 跑 work，**完全相同的命令**從 Node `child_process.exec` 跑 → exit non-zero、stdout/stderr 都空
- **隔離測試**：terminal + stdin /dev/null work / Node + `script -qec 'cmd' /dev/null` 包 work → **nemoclaw CLI detect stdout 不是 TTY 直接 abort**
- **解法**：mirror server `execAsync` helper 包 `script(1)` 偽 TTY + strip `\r\r\n`

### G) Sandbox squid proxy 擋 SMTP/IMAP（**Email 第一道牆**）
- **症狀**：sandbox 內 send_email 跑 `getaddrinfo EAI_AGAIN smtp.gmail.com`，DNS 都解不到
- **根因**：sandbox 走 squid HTTP proxy (10.200.0.1:3128) **只認 HTTPS/HTTP**。SMTP/IMAP 是原始 TCP protocol，proxy 不知道怎麼處理。gmail-smtp / gmail-imap preset 在 policy registry 列名但 proxy backend 沒實際支援
- **對比**：line_notify 走 HTTPS POST api.line.me → 透過 HTTPS_PROXY → ALLOW ✓
- **解法**：**Email bridge 架構** — 對外 SMTP/IMAP 在 host 跑（無 proxy 限制），sandbox skill 走 outbox/inbox JSON 橋接

### H) Host send_email 從 SSH 跑 work，從 nemoclaw exec 跑被擋
- **症狀**：你截圖證明昨天 send_email 真寄到 Gmail，今天 sandbox 跑卻 EAI_AGAIN
- **根因**：昨天那次是直接在 **host VM shell** `bash workspace/skills/send_email/cli.sh < input.json` 跑（host 有完整 internet）；今天是 `nemoclaw exec --` 進 sandbox 跑（受 squid 限制）
- **教訓**：cli.sh 是同一個檔，但「在哪裡跑」決定能不能上網

### I) cli.sh source .env BRIDGE_MODE 沒 export 進 node process
- **症狀**：sandbox `.env` 內已加 `BRIDGE_MODE=outbox`，但 cli.sh source 後 node `process.env.BRIDGE_MODE` 是 undefined
- **嘗試**：trim + CR strip + fs.readFile fallback 都沒用
- **真根因**：每次 `deploy-skills-to-workspace.sh` 結尾把 host `.env` base64 覆蓋進 sandbox 的 .env，**把先前 start-all.sh 動態加的 BRIDGE_MODE=outbox 沖掉**
- **解法**：`detectBridgeMode()` 改用 `__dirname.startsWith('/sandbox/')` 路徑偵測——sandbox 內 `/sandbox/...`，host 上 `/home/ubuntu/...`，永遠分得開、不依賴 .env。同時 deploy script 寫 .env 時也注入 BRIDGE_MODE 雙保險

### J) deploy-skills-to-workspace.sh `Argument list too long`
- **症狀**：deploy 跑到 `data/historical_orders.csv` (660KB) 爆 ARG_MAX
- **根因**：660KB base64 → 880KB 當 shell arg，超過 Linux ARG_MAX (~128KB)
- **解法**：deploy script skip 檔案 > 100KB（data CSV 早期 deploy 過就不變）

### K) IMAP `fetch({seen: false})` 把 criteria 當 sequence range
- **症狀**：bridge 抓信永遠卡同一封 2019 darlingsquare（personal 信），抓不到剛寄的詢價
- **根因**：imapflow `client.fetch(range, query)` 第一個 arg 是 sequence range / UID range。`{seen: false}` 不是 search criteria——被當成「從 sequence #1 開始抓所有」
- **解法**：先 `client.search({seen: false, or: [{subject: '詢價'}, ...]}, {uid: true})` 拿 uids，再 `client.fetch('${uid}:${uid}', query, {uid: true})` async iterator 抓
- **附帶**：subject filter 用 `Inquiry` 太寬會中 EDM marketing 信，改 `Quote Request / Request for Quote / Request for Quotation` 完整 phrase

### L) imapflow `fetchOne(uid)` 預設把 uid 當 sequence number
- **症狀**：search 真的找到 8 個 uids，但 `fetchOne(uid)` 全部 `fetch empty`
- **根因**：imapflow `fetchOne()` 預設 range mode = sequence number。uid 73993 → 試 sequence #73993（信箱沒這麼多）→ empty
- **解法**：改 async iterator + uid mode：`for await (const m of client.fetch(\`${uid}:${uid}\`, query, {uid: true}))`

### M) Attachment `spawn E2BIG`（nemoclaw exec grpc args 比 bash 嚴）
- **症狀**：500KB PDF base64 走 nemoclaw exec inline echo → `spawn E2BIG`
- **根因**：nemoclaw grpc args 上限比 bash ARG_MAX 更嚴（< 100KB 才安全）
- **解法**：3-tier
  - `< 80KB b64`: inline echo (最快)
  - `80KB-5MB`: **spawn nemoclaw exec + stdin pipe 餵 base64**（繞 arg 限制）
  - `> 5MB`: skip
- 驗證：「昕叡電子工程圖.pdf」221KB 真寫進 `/sandbox/.openclaw/workspace/data/incoming/`

### N) IMAP 連線 `ETIMEOUT` 整個 bridge process crash
- **症狀**：bridge `[1]+ Exit 1`，pollInbox 內 IMAP 連線太久沒活動，imapflow 拋 'error' event 沒被 catch
- **解法**：
  - `socketTimeout: 20_000` + `greetingTimeout: 10_000`
  - `client.on('error', err => log(...))` swallow
  - 全域 `process.on('unhandledRejection' / 'uncaughtException')` swallow
  - mark seen 加 retry x3

### O) IMAP mark seen 不可靠 → 重複抓同一封信
- **症狀**：每次 poll 都抓到同 uid 38826（personal welfare meeting 信），無限循環
- **根因**：mark seen 偶爾失敗（網路 jitter）但沒 retry
- **解法**：3 次 attempt + 500/1000/1500ms backoff，加 `lastSeenUids` Set 本地 dedup

### P) Skill impl.js 改完不 redeploy 進 sandbox 看不到
- **症狀**：host 改 detectBridgeMode 邏輯，sandbox 內 impl.js 還是舊版
- **根因**：sandbox 內 skill 副本是早先 base64 寫進去的快照，`git pull` 只更新 host repo
- **教訓**：流程改成「Edit → git commit → push → VM git pull → **deploy-skills-to-workspace.sh** → 測試」
- **memory 已記**：`feedback_redeploy_skills_after_impl_edit.md`

---

## ✅ 已驗證 work 的東西

1. **Sandbox kernel-level governance active**：Landlock + seccomp + netns + egress allowlist
2. **3 個 custom preset 真的套用**：nemoclaw-v10 + line-messaging + gmail-smtp + gmail-imap
3. **10 個 skill cli.sh 在 sandbox workspace/skills/**，全部 9 個 (除 read_drawing fallback) 真 work（手動 + via agent）
4. **5 份 .md 在 sandbox workspace/**（AGENTS 真的被 agent 讀進 prompt）
5. **mirror server 5 個 endpoint 全綠**，TTY-wrap 後 Node child_process exec 不再 silent fail
6. **`/api/agent-trigger` POST 真的 spawn openclaw agent**，sandbox session jsonl 生成正常
7. **HTML Agent Thinking panel 顯示真實 thinking / tool_call / tool_result**
8. **Email send (sandbox→outbox→host SMTP→Gmail)** 真到 sunnxebusiness@gmail.com inbox
9. **Email receive (Gmail→host IMAP→sandbox inbox JSON+PDF)** 真抓到「滾輪詢價」+ 「昕叡電子工程圖.pdf」221KB 寫進 sandbox incoming/
10. **LINE flex push** 真到手機（line_notify cli.sh 走 HTTPS_PROXY → api.line.me）
11. **LINE postback webhook** 真收到（你按按鈕 → /tmp/line-webhook.log 有 trace）

---

## ⚠️ 已知未解（最後 missing pieces）

### P1 — LINE webhook 收到 postback 後沒注入 agent（**最緊急 = task #52**）
- 現狀：webhook 收到 postback → resolveHold()（legacy orchestrator）→ 沒接 sandbox agent
- 要做：webhook handler 加 `spawn nemoclaw exec openclaw agent --agent main -m "[LINE_CB] hold_id=X choice=N action=Y"` 注入 agent 繼續 GATE 後流程
- 解了之後 13-step e2e flow 才能跑通

### P2 — 13-step orchestrated flow 沒實跑過 (= task #53)
- 已有 trigger 機制（HTML 「📦 列訂單」/「🏭 鴻碩詢價」），單個 skill 都通
- 需要實際 trigger「處理鴻碩電子的詢價」看 agent 自主跑：inbox → drawing → history → schedule → cost → compare → GATE(LINE) → rfq email → wait → compare → GATE(LINE) → quote pdf → email

### P3 — Gateway scope upgrade approval 沒乾淨解（cosmetic）
- 走 embedded fallback 完全 work，但 stderr 有「scope upgrade pending」+「EMBEDDED FALLBACK」雜訊
- 不影響功能；錄影鏡頭 stderr 不秀觀眾就好

### P4 — `/proc/self/oom_score_adj` Permission denied 警告（cosmetic）
- 每個 exec 出現一次，無害但 ugly。可選 cli.sh 加 redirect

### P5 — Heartbeat poll 偶爾重複觸發同一 message
- agent trajectory 看過「請列出當前所有訂單」連續被 deliver 3 次
- 影響：agent 多跑幾輪，但答案一致
- 不致命

---

## 重要檔案地圖

| 路徑 | 用途 |
|---|---|
| `scripts/demo-mirror-server.js` | Express live mirror（TTY wrap + agent trigger + log endpoint） |
| `scripts/start-all.sh` | 一鍵起 mirror + email-bridge + LINE webhook |
| `scripts/email-bridge.js` | **host 端 outbox/inbox poller + SMTP/IMAP**（新加） |
| `scripts/install-host-deps.sh` | host 端 npm install imapflow/mailparser/@line/bot-sdk |
| `scripts/deploy-skills-to-workspace.sh` | base64 寫 skill 到 sandbox workspace（skip >100KB） |
| `scripts/fix-agent-tools.sh` | 改 skipBootstrap=false + toolSearch=false + timeout=600 |
| `scripts/verify-bridge-env.sh` | 確認 sandbox .env 內 BRIDGE_MODE |
| `scripts/test-skills-direct.sh` + `test-skills-direct-v2.sh` | 繞 agent 直測 10 skill |
| `scripts/test-bridge.sh` | 4-path test: email send/receive + LINE send/receive |
| `scripts/inspect-egress.sh` | 撈 sandbox policies/preset/resolv.conf/proxy env |
| `scripts/inspect-agent-config.sh` + `inspect-agent-config-2.sh` | 撈 openclaw config schema |
| `scripts/debug-agent-session.sh` | 7 步診斷 Agent Thinking 面板 |
| `scripts/disable-tool-search.sh` | （v2）改 tools.toolSearch=false |
| `showcase/factory-quote-demo.html` | LINE UI + 3 panel + trigger 輸入框 |
| `workspace/AGENTS.md` | event-driven 13-step flow（sandbox /sandbox/.openclaw/workspace/AGENTS.md） |
| `workspace/skills/<name>/cli.sh + impl.js + SKILL.md` | 10 個 skill |
| `presets/gatherease-egress.yaml` | NemoClaw egress policy（line/gmail-smtp/gmail-imap） |
| `docs/PLAN-A-ARCHITECTURE.md` | Plan A 整體架構 + SVG |
| `docs/PLAN-A-DEPLOY-JOURNAL.md` | （這份）部署 + 卡關 + 解法紀錄 |

---

## 常用 debug 命令參考

```bash
# === 一鍵啟動所有 service ===
./scripts/start-all.sh
# 看 service log
tail -f /tmp/mirror.log /tmp/email-bridge.log /tmp/line-webhook.log

# === 4-path test (email/LINE 雙向) ===
./scripts/test-bridge.sh

# === sandbox 狀態 ===
nemoclaw status --json | python3 -m json.tool | head -50

# === sandbox 內 ls (路徑要用 /sandbox/...) ===
nemoclaw gatherease-quote-agent exec -- ls -la /sandbox/.openclaw/agents/main/sessions/

# === 看最新 agent session transcript ===
LATEST=$(nemoclaw gatherease-quote-agent exec -- ls -t /sandbox/.openclaw/agents/main/sessions/ | grep '\.jsonl$' | grep -v trajectory | head -1)
nemoclaw gatherease-quote-agent exec -- tail -50 /sandbox/.openclaw/agents/main/sessions/$LATEST

# === 看 trajectory (runtime details) ===
LATEST_TRAJ=$(nemoclaw gatherease-quote-agent exec -- ls -t /sandbox/.openclaw/agents/main/sessions/ | grep 'trajectory.jsonl$' | head -1)
nemoclaw gatherease-quote-agent exec -- head -3 /sandbox/.openclaw/agents/main/sessions/$LATEST_TRAJ | grep -oE '"toolCount":[0-9]+|"capabilities":\[[^]]*\]'

# === 手動跑 agent 一輪 ===
nemoclaw gatherease-quote-agent exec -- openclaw agent --agent main -m "請列出當前所有訂單" 2>&1 | tail -50

# === 手動跑單一 skill cli.sh（隔離 agent 變數）===
nemoclaw gatherease-quote-agent exec -- bash -c 'echo {\"action\":\"list\"} | bash /sandbox/.openclaw/workspace/skills/order_store/cli.sh'

# === 重啟個別 service ===
pkill -f demo-mirror-server.js && nohup node scripts/demo-mirror-server.js > /tmp/mirror.log 2>&1 &
pkill -f email-bridge.js && nohup node scripts/email-bridge.js > /tmp/email-bridge.log 2>&1 &
pkill -f 'line_notify/webhook' && nohup node skills/line_notify/webhook.js > /tmp/line-webhook.log 2>&1 &

# === 測 mirror endpoint ===
curl -s http://localhost:8000/api/agent-session | python3 -m json.tool | head -60
curl -X POST http://localhost:8000/api/agent-trigger -H 'Content-Type: application/json' -d '{"message":"請列出當前所有訂單"}'

# === Bridge 狀態 ===
nemoclaw gatherease-quote-agent exec -- ls -la /sandbox/.openclaw/workspace/data/{outbox,inbox,incoming}/

# === Skill 改 impl.js 後 一定要 redeploy 進 sandbox ===
./scripts/deploy-skills-to-workspace.sh

# === Verify sandbox impl.js 確實是最新版 ===
nemoclaw gatherease-quote-agent exec -- grep -c detectBridgeMode /sandbox/.openclaw/workspace/skills/send_email/impl.js
```

---

## 記憶提醒（給新 chat session）

- 不是 Day 1，**今天 Day 2 深夜（5/26）**，比賽 5/28 12:00 截止
- **Sunny 放棄錄影焦慮**，重點 debug 工具一個個通；現在工具堆疊完整可以開始想 demo 鏡頭
- **Mac 開發 + Linux VM 跑真 NemoClaw**（macOS 沒 seccomp/Landlock）
- **`/sandbox/` 是 sandbox 內路徑，host VM 沒這條路徑**，都要走 `nemoclaw exec --`
- **nemoclaw exec args 不能有 newline**（grpc reject）
- **nemoclaw CLI stdout 不是 TTY 會 silent fail**（mirror server / email-bridge 都已 wrap script(1)）
- **dashboard chat 不能用**，HTML trigger 是唯一路徑
- **Gateway scope approval 是死胡同**，embedded fallback work 就 ship
- **Sandbox squid proxy 只認 HTTPS**——SMTP/IMAP 必須走 host email bridge
- **`__dirname.startsWith('/sandbox/')` 是最穩的「sandbox vs host」偵測**——不依賴 .env / env var
- **改 impl.js 後一定要 redeploy_skills_to_workspace.sh**——sandbox 副本不自動同步
- **Secret 永遠不 echo**：API key、LINE secret、Gmail App Password 一旦在 chat 出現要警告 + 撤銷
- **dummy data 不是真客戶名**：鴻碩電子 / 全鋼 / 大同 / 順興都是合成 persona

---

## 接手第一個動作建議

1. 讀這份文件（你正在做）
2. `cat ~/Desktop/projects/nvidia_hackathon/CLAUDE.md` 看比賽全貌
3. `cat ~/Desktop/projects/nvidia_hackathon/gatherease-quote-agent/docs/PLAN-A-ARCHITECTURE.md` 看 Plan A 細節
4. **攻 task #52** — webhook 注入 agent message。範本：webhook handler postback 後 spawn `nemoclaw exec openclaw agent --agent main -m "[LINE_CB] 老闆已決定 hold_id=X choice=N action=Y"` 注入 agent。範例：
   ```js
   const { spawn } = require('child_process');
   const child = spawn('nemoclaw', [
     'gatherease-quote-agent', 'exec', '--', 'openclaw', 'agent',
     '--agent', 'main', '-m',
     `[LINE_CB] 老闆已決定 hold_id=${hold_id} choice=${choice} action=${label}`
   ], { detached: true, stdio: 'ignore' });
   child.unref();
   ```
5. 跑 13-step e2e demo：HTML trigger「處理鴻碩電子的詢價 Anti-Static Silicone Roller × 200」
