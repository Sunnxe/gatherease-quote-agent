# Plan A 部署日誌 — sandbox agent 跑通到目前的完整紀錄

> 給新 chat session 接手用：讀完這份就有完整 context。
> Last updated: 2026-05-26 (Day 2 晚)

---

## 一句話現況

**Agent 已經在 sandbox 內真實跑起來，會 call skill、會解析 JSON、會回中文。**HTML mirror panel 已能即時看到 thinking / tool_call / tool_result。但 9 個 skill 只驗過 1.5 個（order_store 真 work；inbox_watch 卡 egress），13-step flow 還沒跑通，還有 7 個已知問題待解。

---

## 系統架構（5 層）

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
│   scripts/demo-mirror-server.js (Node Express :8000)     │
│   - GET  /api/status / skills / policies                 │
│   - GET  /api/sandbox-activity   (nemoclaw logs tail)    │
│   - GET  /api/agent-session      (parse session jsonl)   │
│   - POST /api/agent-trigger      (spawn openclaw agent)  │
│   - GET  /api/agent-trigger-log  (debug spawn stderr)    │
└──────────────────┬──────────────────────────────────────┘
                   │ nemoclaw <sandbox> exec --
                   ↓
┌─────────────────────────────────────────────────────────┐
│ NemoClaw sandbox "gatherease-quote-agent" (Linux)        │
│   - Landlock fs + seccomp + network namespace            │
│   - egress policy: nemoclaw-v10, line-messaging,         │
│     gmail-smtp, gmail-imap                               │
│   - OpenClaw gateway (ws://127.0.0.1:18789)              │
│     ⚠️ 目前 scope upgrade pending → fallback embedded    │
│   - Agent: main (Nemotron-3-Super-120B via NIM)          │
│     workspace: /sandbox/.openclaw/workspace/             │
│       - AGENTS.md / TOOLS.md / IDENTITY.md / SOUL.md /   │
│         USER.md / HEARTBEAT.md / .env                    │
│       - data/  (suppliers.json, history_orders.csv...)   │
│       - skills/ (10 個 cli.sh + SKILL.md)                │
└─────────────────────────────────────────────────────────┘
```

---

## 完整部署順序（成功復現步驟）

### Phase 1 — VM 環境
1. Brev provision Ubuntu **24.04**（22.04 glibc 2.35 跑 NemoClaw 會炸，已驗）
2. `curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash` 裝 NemoClaw（**不是 npm，npm 上是空殼**）
3. Tailscale 加入 tailnet
4. `nemoclaw onboard <sandbox-name>`
5. `nemoclaw <sandbox> policy-add presets/gatherease-egress.yaml` × 3 preset

### Phase 2 — Skills + workspace
1. `workspace/skills/` 寫 10 個 skill：order_store, inbox_watch, read_drawing, get_history_quote, check_schedule, calc_cost, compare_suppliers, line_notify, send_email, generate_quote_pdf
2. `workspace/` 寫 5 份 markdown：AGENTS, TOOLS, IDENTITY, SOUL, USER + .env
3. `scripts/deploy-skills-to-workspace.sh` — **base64 + nemoclaw exec single-line bash -c**
   - **不能用** `nemoclaw skill install` → 那會裝到 managed scope，agent exec 看不到
   - 必須直接寫 `/sandbox/.openclaw/workspace/skills/<name>/`

### Phase 3 — Mirror server + HTML
1. `scripts/demo-mirror-server.js` (Express + cache + 5 endpoints)
2. `showcase/factory-quote-demo.html` (LINE UI + 3 個 live panel + trigger 輸入框)
3. `scripts/start-demo-mirror.sh` → `nohup node ... > /tmp/mirror.log 2>&1 &`

### Phase 4 — Agent config fix（解 toolCount=1）
跑 `scripts/fix-agent-tools.sh` 改 `/sandbox/.openclaw/openclaw.json`：
```diff
agents.defaults:
- skipBootstrap: true       (→ agent 看不到 exec/file_read/file_write)
+ skipBootstrap: false
- timeoutSeconds: 60        (Nemotron 雲端會 timeout)
+ timeoutSeconds: 600
tools:
- toolSearch: true          (強制 tool_search_code wrapper)
+ toolSearch: false         (直接暴露所有 tool)
```
然後 `nemoclaw <sandbox> recover` 讓 gateway reload。

### Phase 5 — Mirror server TTY fix
mirror server execAsync wrap `script -qec 'cmd' /dev/null` 偽 TTY，strip `\r\r\n` → `\n`。
不包 nemoclaw 從 Node child_process exec 跑會 silent fail。

---

## 卡關全紀錄（按發現順序）

### A) `nemoclaw exec` 不接受 newline / CR 的 args
- **症狀**：`bash -c '<multi-line heredoc>'` → grpc reject "command argument 2 contains newline"
- **解法**：所有命令 single-line。Python 多行用 base64 encode 寫到 sandbox `/tmp/x.py` 再 `python3 /tmp/x.py`

### B) Agent `toolCount=1`，只有 `tool_search_code` wrapper
- **症狀**：trajectory 顯示 `capabilities=none, toolCount=1, clientToolCount=0`。Agent 拼命用 wrapper 寫 JS 模擬 `require('child_process')` / `openclaw.tools.call({skill, input})` 等等，鬼打牆 15+ 次
- **根因**：`agents.defaults.skipBootstrap=true` 跳過內建工具註冊 + `tools.toolSearch=true` 強制 wrapper
- **解法**：fix-agent-tools.sh 改三個 flag（見 Phase 4）

### C) Gateway scope upgrade pending approval
- **症狀**：改 skipBootstrap=false 後每次 `openclaw agent` 跑都出現 `scope upgrade pending approval (requestId: ...)`，gateway 拒接 → fallback embedded agent
- **嘗試解**：`openclaw devices approve <id>` → "unknown requestId"（每次 run 產生新 id，race condition）
- **現狀**：**接受 embedded fallback**。功能 100% work，session jsonl 也寫進標準路徑 `/sandbox/.openclaw/agents/main/sessions/`，HTML panel 抓得到
- **長期 TODO**：找 pre-approve scope 的方法

### D) Dashboard chat 連到 Mac local 不是 sandbox
- **症狀**：Mac OpenClaw dashboard chat 試 trigger，後台 log 是 Mac `~/.openclaw/` 不是 VM sandbox
- **解法**：放棄 dashboard chat，HTML 加 trigger 輸入框 + `POST /api/agent-trigger` 走 mirror server `spawn('nemoclaw', [SANDBOX, 'exec', '--', 'openclaw', 'agent', '--agent', 'main', '-m', message])`

### E) mirror server spawn 啞掉 debug 不到
- **症狀**：`/api/agent-trigger` 回 200 但 sandbox 沒新 session、stdout/stderr 都 `ignore` 看不到
- **解法**：spawn `stdio: ['ignore', logFd, logFd]` 寫 `/tmp/gatherease-agent-trigger.log`，加 `/api/agent-trigger-log` endpoint tail
- **狀態**：**已寫但還沒 push**（sandbox .git/HEAD.lock 卡住），Sunny 需 Mac `rm .git/HEAD.lock + commit + push`

### F) nemoclaw CLI 從 Node child_process exec 跑 silent fail（**最迷人的 bug**）
- **症狀**：terminal 跑 `nemoclaw exec -- ls /sandbox/...` work，**完全相同的命令**從 Node `child_process.exec` 跑 → exit non-zero、stdout/stderr 都空字串、沒任何錯誤訊息
- **隔離測試**：
  - terminal + stdin /dev/null → work (exit 0)
  - Node + `script -qec 'cmd' /dev/null` 包 → work
  - 結論：nemoclaw CLI detect **stdout 不是 TTY** 直接 abort，沒任何 error message
- **解法**：mirror server `execAsync` helper 包 `script(1)` 偽 TTY + strip `\r\r\n`
```js
const escaped = cmd.replace(/'/g, "'\\''");
const wrapped = `script -qec '${escaped}' /dev/null`;
exec(wrapped, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
  if (err) return reject(err);
  resolve(stdout.toString().replace(/\r\r?\n/g, '\n').replace(/\r/g, ''));
});
```

---

## ✅ 已驗證 work 的東西

1. **Sandbox kernel-level governance active**：Landlock + seccomp + netns + egress allowlist
2. **3 個 custom preset 真的套用**：nemoclaw-v10 + line-messaging + gmail-smtp + gmail-imap（policy-add 完看 nemoclaw status --json 確認）
3. **10 個 skill cli.sh 在 sandbox workspace/skills/**（部署用 deploy-skills-to-workspace.sh）
4. **5 份 .md 在 sandbox workspace/**（AGENTS 真的被 agent 讀進 prompt）
5. **mirror server `/api/agent-session` 真的 parse session jsonl** 給 HTML 顯示
6. **`/api/agent-trigger` POST 真的 spawn openclaw agent** 讓 sandbox agent 跑起來
7. **HTML Agent Thinking panel 顯示真實 thinking / tool_call / tool_result**（最新一次成功 trigger 顯示 agent 真的在 exec `bash cli.sh`）
8. **`order_store list` 真的回 `{"orders":[],"count":0}`** — agent 成功解析 + 回中文

---

## ⚠️ 已知未解問題（給新 chat 接手）

### P1 — Sandbox 出傳 DNS / IMAP / SMTP 被擋（**P0，最緊急**）
- **證據**：inbox_watch 跑得 `getaddrinfo EAI_AGAIN imap.gmail.com`
- **影響**：inbox_watch / send_email / line_notify 三個對外 skill 全死
- **要做**：
  - `nemoclaw <sandbox> status --json` 確認 policies 內含 `gmail-imap`/`gmail-smtp`/`line-messaging`
  - 看 `presets/gatherease-egress.yaml` 三個 preset 有沒有開 DNS resolver（`*.gmail.com` 之類）
  - 看 sandbox 內 `cat /etc/resolv.conf` DNS server 是不是被擋
  - 也可能要在 preset 加 `npm registry`（first run inbox_watch 試 `npm install imapflow mailparser pdf-parse`）

### P2 — Agent skill 第一次 exec 都不會 echo|pipe stdin
- **證據**：trajectory 顯示 agent 第 1、2 次 exec `bash cli.sh` 沒 stdin → cli.sh 回 "action required: create | get | update | append_audit | list"
- 第 3 次才寫對 `bash -c 'echo {"action":"list"} | bash cli.sh'`
- **要做**：
  - 改 `workspace/AGENTS.md` + 各 `workspace/skills/*/SKILL.md` 範例改寫成
    `exec bash -c 'echo INPUT | bash skills/X/cli.sh'`
  - 或者所有 cli.sh 加 argv fallback：沒 stdin 就 fail 改成 `--action list` 也接

### P3 — `/proc/self/oom_score_adj` Permission denied 警告
- 每個 exec 出現一次（無害但 ugly，trajectory 內到處都是）
- 解法：cli.sh 開頭加 `exec 2> >(grep -v oom_score_adj >&2)` 或忽略

### P4 — Heartbeat poll 重複觸發同一 user message
- 看 trajectory：「請列出當前所有訂單」連續被 deliver 3+ 次（包在 nemoclaw-runtime tag 內），每次都讓 agent 重新處理一次
- 中間混雜 `[OpenClaw heartbeat poll]` 也讓 agent 走 HEARTBEAT_OK 分支
- **不知道是 mirror server `/api/agent-trigger` 觸發多次，還是 sandbox 內 heartbeat reschedule，要查**

### P5 — Gateway scope upgrade approval 沒乾淨解
- 走 embedded fallback OK 但 stderr 有「scope upgrade pending」「EMBEDDED FALLBACK」雜訊
- 長 demo 可能 race condition
- 看 `openclaw devices` 其他 subcommand 或 NemoClaw `config` 是否能 pre-grant scope

### P6 — 8 個 skill 還沒驗證
- ✅ order_store: list work
- ⚠️ inbox_watch: cli.sh 跑起來但 IMAP DNS 被擋
- ❓ read_drawing / get_history_quote / check_schedule / calc_cost / compare_suppliers / generate_quote_pdf: 完全沒跑過
- ❓ line_notify / send_email: 需要 P1 解了才能測

### P7 — 13-step orchestrated flow 沒跑通
- AGENTS.md 內定的 event-driven flow：「處理鴻碩電子的詢價 Anti-Static Silicone Roller × 200」應該觸發 inbox → drawing → history → schedule → cost → compare → quote → email → line
- 需 P1/P2 解掉才能跑

### P8 — Pending commit 沒 push（mirror server TTY fix + agent-trigger-log）
- 我寫的 commit 在 sandbox 落地但 .git/HEAD.lock 卡住，Sunny 要 Mac 端：
  ```bash
  cd ~/Desktop/projects/nvidia_hackathon/gatherease-quote-agent
  rm -f .git/HEAD.lock .git/index.lock
  git status   # 應該看 scripts/demo-mirror-server.js modified
  git add -A
  git commit -m "fix(mirror): wrap nemoclaw exec with script(1) for TTY"
  git push
  ```

---

## 重要檔案地圖

| 路徑 | 用途 |
|---|---|
| `scripts/demo-mirror-server.js` | Express live mirror（5 endpoint，TTY fix 已套，stderr-log endpoint 已加） |
| `scripts/start-demo-mirror.sh` | nohup 啟動 mirror server |
| `scripts/deploy-skills-to-workspace.sh` | base64 寫 skill 到 sandbox workspace |
| `scripts/disable-tool-search.sh` (v2) | 改 tools.toolSearch=false |
| `scripts/fix-agent-tools.sh` | 改 skipBootstrap=false + toolSearch=false + timeout=600 |
| `scripts/inspect-agent-config.sh` | 撈 openclaw config schema |
| `scripts/inspect-agent-config-2.sh` | 撈 openclaw 各 --help 給 doc 用 |
| `scripts/debug-agent-session.sh` | 7 步診斷 Agent Thinking 面板 |
| `showcase/factory-quote-demo.html` | LINE UI + 3 panel + trigger 輸入框 |
| `workspace/AGENTS.md` | event-driven 13-step flow（在 sandbox 內 /sandbox/.openclaw/workspace/AGENTS.md） |
| `workspace/skills/<name>/cli.sh + SKILL.md` | 10 個 skill |
| `presets/gatherease-egress.yaml` | NemoClaw egress policy（line/gmail-smtp/gmail-imap） |
| `docs/PLAN-A-ARCHITECTURE.md` | Plan A 整體架構 + SVG |

---

## 常用 debug 命令參考

```bash
# 看 sandbox 狀態
nemoclaw status --json | python3 -m json.tool | head -50

# 看 sandbox 內 ls (記得 /sandbox/ 是 sandbox 內路徑，host 沒有)
nemoclaw gatherease-quote-agent exec -- ls -la /sandbox/.openclaw/agents/main/sessions/

# 看最新 session 內容（找最新的 .jsonl）
LATEST=$(nemoclaw gatherease-quote-agent exec -- ls -t /sandbox/.openclaw/agents/main/sessions/ | grep '\.jsonl$' | grep -v trajectory | head -1)
nemoclaw gatherease-quote-agent exec -- tail -50 /sandbox/.openclaw/agents/main/sessions/$LATEST

# 看 trajectory（runtime details）
LATEST_TRAJ=$(nemoclaw gatherease-quote-agent exec -- ls -t /sandbox/.openclaw/agents/main/sessions/ | grep 'trajectory.jsonl$' | head -1)
nemoclaw gatherease-quote-agent exec -- head -3 /sandbox/.openclaw/agents/main/sessions/$LATEST_TRAJ | grep -oE '"toolCount":[0-9]+|"capabilities":\[[^]]*\]'

# 手動跑 agent 一輪（debug 用）
nemoclaw gatherease-quote-agent exec -- openclaw agent --agent main -m "請列出當前所有訂單" 2>&1 | tail -50

# 手動跑單一 skill cli.sh（隔離 agent 變數）
nemoclaw gatherease-quote-agent exec -- bash -c 'echo {\"action\":\"list\"} | bash /sandbox/.openclaw/workspace/skills/order_store/cli.sh'

# Mirror server 重啟
pkill -f demo-mirror-server.js && sleep 2 && nohup ./scripts/start-demo-mirror.sh > /tmp/mirror.log 2>&1 &

# 測 mirror endpoint
curl -s http://localhost:8000/api/agent-session | python3 -m json.tool | head -60
curl -X POST http://localhost:8000/api/agent-trigger -H 'Content-Type: application/json' -d '{"message":"請列出當前所有訂單"}'
curl -s http://localhost:8000/api/agent-trigger-log
```

---

## 記憶提醒（給新 chat session）

- 不是 Day 1，**今天 Day 2 結束（5/26 晚上）**，比賽 5/28 12:00 截止
- **Sunny 已經放棄錄影焦慮**，現在重點是把工具一個一個 debug 通，不要再急著錄
- **Mac 開發 + Linux VM 跑真 NemoClaw**（macOS 沒 seccomp/Landlock）
- **`/sandbox/` 是 sandbox 內路徑，host VM 沒這條路徑**，都要走 `nemoclaw exec --`
- **nemoclaw exec args 不能有 newline**（grpc reject）
- **nemoclaw CLI stdout 不是 TTY 會 silent fail**（mirror server 已 wrap script(1)）
- **dashboard chat 不能用**（連 Mac local clawdbot 不是 VM sandbox），HTML trigger 是唯一路徑
- **Gateway scope approval 是死胡同**，embedded fallback work 就 ship 它
- **Secret 永遠不 echo**：API key、LINE secret、Gmail App Password 一旦在 chat 出現要警告 + 撤銷
- **dummy data 不是真客戶名**：鴻碩電子 / 全鋼 / 永鎵 / 新鎏鍍都是合成 persona

---

## 接手第一個動作建議

1. 讀這份文件（你正在做）
2. `cat ~/Desktop/projects/nvidia_hackathon/CLAUDE.md` 看比賽全貌
3. `cat ~/Desktop/projects/nvidia_hackathon/gatherease-quote-agent/docs/PLAN-A-ARCHITECTURE.md` 看 Plan A 細節
4. 攻 **P1 (egress DNS/IMAP)** — 不解這個 inbox/email/LINE 全死，13-step flow 走不到
5. 攻 **P2 (skill stdin 範例)** — 改 SKILL.md 範例，agent 第一次就會用
6. 順手做 **P8 (push pending commit)**
