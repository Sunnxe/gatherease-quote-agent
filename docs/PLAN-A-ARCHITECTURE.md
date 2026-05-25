# Plan A — 把 GatherEase Agent 真的跑進 OpenClaw

> 完整架構文件，基於 [docs.openclaw.ai](https://docs.openclaw.ai) + [docs.nvidia.com/nemoclaw](https://docs.nvidia.com/nemoclaw/latest/) + VM dashboard inspection。
> Last updated: 2026-05-25
> Status: 待 Sunny confirm 後動工

---

## 1. 三層架構（誰是誰）

我們現在裝的這套其實是**三個獨立但疊在一起的開源/官方產品**：

### NemoClaw（NVIDIA / curl 裝）
- 工具：`nemoclaw onboard` / `nemoclaw <name> policy-add` / `nemoclaw <name> skill install` 等 host CLI
- 工作：bootstrap **sandbox**（Docker container 跑 NVIDIA OpenShell）、設 inference route（NVIDIA NIM API endpoint）、套**網路 policy**（line-messaging.yaml / gmail-smtp.yaml 等都在這層）
- 治理在這層做：kernel-level egress 強制，sandbox 外面 agent 改不到
- Source: [github.com/NVIDIA/NemoClaw](https://github.com/NVIDIA/NemoClaw)

### OpenClaw（open-source agent runtime）
- 一個 sandbox 跑**一個 Gateway daemon** + **一個 embedded agent runtime**
- Workspace 在 `~/.openclaw/workspace/`（host 上，但裝在 sandbox 內 mount 進來）
- LLM tool calling loop **由 Gateway 自己跑**——不是我們 code 寫
- Source: [docs.openclaw.ai](https://docs.openclaw.ai), [github.com/openclaw/openclaw](https://github.com/openclaw/openclaw)

### Clawdbot Gateway dashboard
- OpenClaw Gateway 的 Web UI（內部 brand 叫 Clawdbot）
- 跑在 `http://127.0.0.1:18789`
- Tabs：Chat / Overview / Channels / Instances / Sessions / Cron Jobs / Skills / Nodes / Config
- 我們之前看到的就是這個

```
┌──── HOST (Brev Ubuntu 24.04 VM, glibc 2.39) ────────────────────────┐
│                                                                      │
│  nemoclaw CLI ────────► bootstraps ────────► Docker sandbox          │
│      │                                       │                       │
│      ▼                                       ▼                       │
│  policy-add: line-msg/gmail-smtp/gmail-imap  ┌─── OpenShell container ──┐
│  → kernel-level egress (NemoClaw 治理)        │                          │
│                                              │  OpenClaw Gateway daemon │
│                                              │  · port 18789 (WS + HTTP)│
│                                              │  · LLM tool-call loop    │
│                                              │  · session store         │
│                                              │  · skill loader          │
│                                              │  · Chat / Sessions / ... │
│                                              │                          │
│  ~/.openclaw/workspace/  ◄── mounted ───────►│  /sandbox/workspace/     │
│  · AGENTS.md / SOUL.md                       │  · agent reads from here │
│  · skills/                                   │                          │
│  · data/                                     │                          │
│                                              │  Nemotron Super (NIM API)│
│                                              │  · 透過 NemoClaw 內建路由 │
│                                              │  · 對外打整合.nvidia.com  │
│                                              └─────────────────────────┘
└──────────────────────────────────────────────────────────────────────┘
```

---

## 2. 四個關鍵概念（OpenClaw 自己的詞）

| 名詞 | 是什麼 | 我們現在的對應 |
|---|---|---|
| **Tool** | LLM 可呼叫的基本動作（`exec` 跑指令 / `web_fetch` 抓 URL / `browser` 開瀏覽器 / `image_generation` 等）| 我們現在的 4 個 skill function **都會變成 `exec` tool 的 args**（exec 跑 CLI script） |
| **Skill** | 一個資料夾 + 一個 `SKILL.md`（YAML frontmatter + markdown body）。**內容是給 LLM 看的指引**——告訴 agent「什麼情況下用哪個 tool 做什麼」 | 我們要寫 4 個 SKILL.md：read_drawing / get_history_quote / calc_cost / line_notify |
| **Session** | 一個 LLM 對話 thread（state 在 Gateway 內，transcript 寫 `~/.openclaw/agents/<id>/sessions/<sessionId>.jsonl`）| 我們的 demo 跑一個 `agent:main:main` session，user prompt 是「處理鴻碩詢價」 |
| **Workspace** | `~/.openclaw/workspace/` 是 agent 的 home directory + cwd。**Bootstrap files (AGENTS.md / SOUL.md / etc.) 在每個 session 開頭自動注入 system prompt** | 我們要寫 GatherEase 版的 AGENTS.md / SOUL.md / USER.md |

**核心 insight**：

```
Skill ≠ JS function。
Skill = markdown 教 LLM「當你看到 X，請用 exec tool 跑 Y 指令」
```

LLM tool calling 一直都是 OpenClaw 自己管的——**我們的 code 不用寫 LLM loop**。我們只要：

1. 寫 markdown 教 agent
2. 寫 CLI scripts 讓 `exec` tool 呼叫
3. 給 LLM 看的 system prompt 跟 prompt context（透過 AGENTS.md / SOUL.md）

---

## 3. 我們的新 file tree（refactor 後）

```
~/.openclaw/workspace/                         # OpenClaw 看的 workspace（host mount 進 sandbox）
├── AGENTS.md                                  # 規則：「你是 GatherEase 報價 agent，看到客戶詢價要依序執行...」
├── SOUL.md                                    # 桐聚精神：「流程交給 AI，決策留給老闆」
├── IDENTITY.md                                # 名字：「GatherEase 報價助手 🦞 v1」
├── USER.md                                    # Sunny / 桐聚 / 製造業背景
├── TOOLS.md                                   # exec 用法 + 4 個 skill 對應的 CLI 路徑
│
├── skills/                                    # ← OpenClaw 自動掃這裡
│   ├── read_drawing/
│   │   ├── SKILL.md                          # YAML frontmatter + 教 agent 何時呼叫
│   │   └── cli.sh                            # 包 node skills-impl/read_drawing/index.js
│   ├── get_history_quote/
│   │   ├── SKILL.md
│   │   └── cli.sh
│   ├── calc_cost/
│   │   ├── SKILL.md
│   │   └── cli.sh
│   ├── line_notify/                           # HOLD 點推 LINE 給老闆
│   │   ├── SKILL.md
│   │   └── cli.sh
│   └── compare_suppliers/                     # 把 orchestrator 內 mock function 也抽出來
│       ├── SKILL.md
│       └── cli.sh
│
├── skills-impl/                               # 真正的 JS code（CLI 包這層）
│   ├── read_drawing/index.js                  # ← 我們現在這個檔（小改）
│   ├── get_history_quote/index.js
│   ├── calc_cost/index.js
│   └── ...
│
└── data/                                      # 本地資料庫（agent 透過 exec/file tool 讀）
    ├── historical_orders.csv                  # 10,000 筆
    ├── bom_cost_data.csv
    ├── suppliers.json
    └── schedule.json
```

**~/.openclaw/openclaw.json**（OpenClaw 主 config）：

```json5
{
  agents: {
    defaults: {
      workspace: "~/.openclaw/workspace",
      model: {
        primary: "nvidia/nemotron-3-super-120b-a12b"
      },
      heartbeat: { every: "0m" }      // demo 不要 heartbeat 干擾
    }
  },

  // 用 OpenClaw hooks 接 LINE webhook（不是內建 channel）
  hooks: {
    enabled: true,
    token: "${OPENCLAW_HOOKS_TOKEN}",
    path: "/hooks",
    mappings: [{
      match: { path: "line" },
      action: "agent",
      agentId: "main",
      deliver: true                   // 把 LINE postback 注入 agent session 變 user message
    }]
  }
}
```

---

## 4. Demo Flow（end-to-end，全是真的）

```
[1] Sunny 在 Clawdbot Chat tab 輸入：
    「處理鴻碩電子的詢價：Anti-Static Silicone Roller × 200，10 天交，要 ESD 認證」
                          │
                          ▼
[2] OpenClaw Gateway 建 session，注入 AGENTS.md+SOUL.md 進 system prompt
                          │
                          ▼
[3] Nemotron Super 看到 user 訊息 + workspace context + skills 列表
    自己 LLM tool call：「先用 exec 跑 read_drawing skill 的 cli.sh」
                          │
                          ▼
[4] exec 觸發 → `bash skills/read_drawing/cli.sh` → 內部 require skills-impl/read_drawing/index.js
    → Nemotron Super 文字推理產出 BOM JSON → stdout → 回 LLM context
                          │
                          ▼
[5] LLM 看到 BOM，下一個 tool call exec get_history_quote
    → 10k CSV similarity 算完 → top 5 回 LLM
                          │
                          ▼
[6] LLM call exec calc_cost (用最便宜代工估底) → 成本 JSON 回 LLM
                          │
                          ▼
[7] LLM call exec line_notify --hold gate-pre-rfq --summary "..."
    → cli.sh 內部 push LINE flex message 給老闆 → 寫 `data/pending-holds.json`
    → **不阻塞**，cli.sh return immediately「等待中，hold_id=xxx」
                          │
                          ▼
[8] LLM 收到「等待中」訊息 → 自己決定回 Chat tab：「已推送給老闆審核，等回覆...」
                          │
                          ▼
[9] 老闆手機按「發詢價」
    → LINE 送 postback 到 cloudflared → https://xxx.trycloudflare.com/hooks/line
    → OpenClaw Gateway 的 hooks/line 收到
    → hooks action=agent → 把 postback payload 注入 session 變 user message
    → "老闆批准：發詢價 (hold_id=xxx, choice=0)"
                          │
                          ▼
[10] Nemotron 看到「老闆批准」訊息 → 接著 LLM tool call exec send_rfq → ...
                          │
                          ▼
[11] 重複 6→10 到 gate-2-tradeoff、gate-3-final-quote
                          │
                          ▼
[12] 最後 LLM call exec encrypt_quote + send_quote + archive_quote
    → 回 Chat tab：「✅ 流程完成，報價已寄出鴻碩電子」
```

**Demo 影片要拍的鏡頭**：

1. Clawdbot Chat tab 視窗，主畫面看 agent 跑（每個 tool call 都會印 trace）
2. 切到 Sessions tab 看 tokens / 跑了多少 tool
3. 切到 Skills tab 看 5 個 skill 註冊在那裡
4. 手機看 LINE flex message → 按按鈕
5. 回到 Chat tab 看 agent 接著跑（時序連貫）
6. 跑完看 audit log 跟 NemoClaw policy-list（治理證據）

---

## 5. 改造清單（具體任務）

### 階段 1：Workspace bootstrap files（30 分鐘）

- [ ] 寫 `workspace/AGENTS.md` — agent 規則 + 5 道守門
- [ ] 寫 `workspace/SOUL.md` — 桐聚精神
- [ ] 寫 `workspace/IDENTITY.md` — 名字 + emoji
- [ ] 寫 `workspace/USER.md` — Sunny 介紹
- [ ] 寫 `workspace/TOOLS.md` — exec/file 用法備註

### 階段 2：Skill markdown + CLI wrapper（1.5 小時）

對每個 skill (read_drawing / get_history_quote / calc_cost / line_notify / compare_suppliers)：

- [ ] 寫 `skills/<name>/SKILL.md`（YAML frontmatter + 教 LLM 用法）
- [ ] 寫 `skills/<name>/cli.sh`（接 stdin/argv → 呼叫 skills-impl/<name>/index.js → stdout JSON）
- [ ] 微調 `skills-impl/<name>/index.js`（從 module.exports.run 改成 main()→stdout JSON）

### 階段 3：HOLD 點機制（1 小時）

- [ ] 把現在 orchestrator.js 內 `pushToLINEAndWait` 邏輯拆兩半：
  - `line_notify push` skill：push flex → 寫 pending file → 立刻 return
  - LINE webhook → `/hooks/line` → action=agent → 注入 session 變新 user message「老闆已決定」
- [ ] AGENTS.md 教 agent：「你 call line_notify 後不要等，直接跟 chat 講『等老闆審核中』；之後 user 會丟『老闆已決定』訊息進來，你看到再繼續」

### 階段 4：openclaw.json + hooks 設定（30 分鐘）

- [ ] `nemoclaw onboard --from` 重建 sandbox or 直接編 `~/.openclaw/openclaw.json`
- [ ] 設 `hooks.enabled=true` + `hooks.mappings=[{path:line, action:agent}]`
- [ ] 把 cloudflared URL 路徑改成 `/hooks/line`（不是 `/webhook/line`）
- [ ] 用 LINE Channel webhook PUT API 自動更新

### 階段 5：跑通 + 錄影彩排（1 小時）

- [ ] 在 Clawdbot Chat tab 跑「處理鴻碩電子詢價」
- [ ] 截每個 tab 的畫面確認 demo 可拍
- [ ] 5/27 預錄影片

**總計：4.5 小時**（含 debug buffer）

---

## 6. 風險 + Mitigation

| 風險 | 機率 | 影響 | Mitigation |
|---|---|---|---|
| Nemotron Super 沒按順序跑 skill（LLM 自由意志） | 中 | 高（demo 影片時序錯亂）| AGENTS.md 寫死「**絕對依序**」+ 用 prompt engineering 把順序釘死 + 跑 3 次選最好錄 |
| LINE webhook 到 Clawdbot hooks 那段需要 cloudflared 還是要動態 URL | 高 | 低（同現在問題）| 已有 start-line-demo.sh 自動 PUT LINE Channel API |
| Skills tab 看不到我們的 skill | 中 | 中 | install via `nemoclaw <name> skill install ./skills/<name>` + 重啟 Gateway |
| Agent 跑進 LLM 來回 loop / hallucinate | 中 | 高 | 用 `tools.alsoAllow` 限制 tool 範圍只給 exec + file_read，不給 browser/web 干擾 |
| Nemotron 不熟我們的 skill exec 語法 | 中 | 中 | SKILL.md 每個都附明確 example：「正確：`exec bash skills/read_drawing/cli.sh '{...JSON...}'`」 |
| sandbox 內找不到 skills-impl/ 的 node_modules | 高 | 高 | 改用 `nemoclaw <name> skill install` 部署時把 dep 一起打包 |

**最大不確定性**：Nemotron Super 對「依序執行 12 步」的可靠度。**Mitigation**：

1. 用 thinking level=high
2. AGENTS.md 寫明確的 numbered checklist
3. 加 SKILL.md 內 "When to use this skill" + "When NOT to use" 兩段
4. 錄影前跑 3~5 次取最穩那次

---

## 7. 跟現有 code 的關係

**保留**：
- `skills-impl/*/index.js`（從現在 `skills/*/index.js` 改名來的，code 幾乎不動）
- `data/*.csv` / `data/*.json`（10k 歷史單、BOM 表）
- `factory-quote-demo.html`（plan B 視覺化，OpenClaw status panel 之後加）
- `presets/*.yaml`（NemoClaw policy 還是要套）

**淘汰**：
- `orchestrator.js`（被 OpenClaw LLM loop 取代）
- `skills/line_notify/webhook.js`（被 OpenClaw hooks 取代）
- `scripts/start-line-demo.sh` 改成 `scripts/start-openclaw-demo.sh`

**新增**：
- `workspace/` 全套（AGENTS.md 等）
- `skills/<name>/SKILL.md` + `cli.sh` 套
- `~/.openclaw/openclaw.json` 配 hooks + model

---

## 8. 不確定點（要在 VM 上 cli 補確認）

1. `nemoclaw gatherease-quote-agent skill install --help` 實際接受什麼 path 格式？單目錄還是要 `.skill` zip？
2. `nemoclaw inference get` 顯示 `nvidia/nemotron-3-super-120b-a12b` 是真的可呼叫的 model id 嗎？OpenClaw `agents.defaults.model.primary` 要不要 `nvidia/` 前綴？
3. Sandbox 內 `bash` / `node` / 我們的 `node_modules` 都有嗎？還是要走 `nemoclaw <name> connect` 進去裝 deps？
4. OpenClaw hooks `action: agent` 把 LINE postback 注入 session 後，agent 看到的 user message 長什麼樣？要不要 hooks 加 `transformer` 把 JSON 轉自然語言？

這四題要在動工前 cli 確認，**Sunny 你跑這幾條貼結果給我**：

```bash
# 1
nemoclaw gatherease-quote-agent skill install --help 2>&1 | tee /tmp/skill-install-help.txt

# 2
nemoclaw gatherease-quote-agent exec --workdir /tmp -- bash -c 'which node && node --version && which bash && ls /sandbox/workspace/ 2>/dev/null || echo "no sandbox workspace yet"'

# 3
cat ~/.openclaw/openclaw.json 2>/dev/null | head -50 || echo "openclaw.json not in default loc"
ls ~/.openclaw/

# 4
nemoclaw gatherease-quote-agent connect --probe-only
```

確認後我們開始動工。

---

## 9. References

- [OpenClaw Agent runtime](https://docs.openclaw.ai/concepts/agent)
- [OpenClaw Session management](https://docs.openclaw.ai/concepts/session)
- [OpenClaw Agent workspace](https://docs.openclaw.ai/concepts/agent-workspace)
- [OpenClaw Creating skills](https://docs.openclaw.ai/tools/creating-skills)
- [OpenClaw Sub-agents](https://docs.openclaw.ai/tools/subagents)
- [OpenClaw Gateway protocol (WS)](https://docs.openclaw.ai/gateway/protocol)
- [OpenClaw Tools Invoke HTTP API](https://docs.openclaw.ai/gateway/tools-invoke-http-api)
- [OpenClaw Hooks (webhooks in)](https://docs.openclaw.ai/automation/hooks)
- [OpenClaw Gateway configuration](https://docs.openclaw.ai/gateway/configuration)
- [NemoClaw CLI commands](https://docs.nvidia.com/nemoclaw/latest/reference/commands.html)
- [NemoClaw network policy schema](https://docs.nvidia.com/nemoclaw/latest/network-policy/customize-network-policy.html)
- [GitHub: NVIDIA/NemoClaw Issue #1844 – skill install](https://github.com/NVIDIA/NemoClaw/issues/1844)
