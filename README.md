# 桐聚 GatherEase · AI 報價詢價 Agent

> **NVIDIA Agent Hackathon · 2026/05** — 用 **OpenClaw + Nemotron + NemoClaw** 打造的 AI 報價詢價 Agent。

**Slogan：流程交給 AI，決策留給老闆。**
*AI handles the process. You make the call.*

故事背景與市場切角請看 demo 影片；本 README 只談技術。

---

## 核心賣點：資料留在工廠，模型來工廠

製造業老闆一定會問：「我的成本表、圖面會不會被送上雲端、被拿去訓練？」答案是——**不會，而且「資料不出廠」正是這套架構的設計目的**。

**產品形態**：Nemotron 用 NVIDIA NIM 自架在工廠本地 GPU（on-prem），OpenClaw daemon 在本地，NemoClaw 的 egress policy 直接禁止成本／圖面對外連線。資料一步都不出廠。

**Demo 階段誠實說明**：因無本地 GPU，推理暫走雲端 Nemotron 端點；但 NemoClaw 的 egress policy 在 demo 裡**就真的在擋**對外資料外送——治理是真的，產品形態是本地 NIM。

> **不是資料去雲端，是模型來工廠。**

---

## 架構

```
                                        ┌──── Linux VM (NVIDIA Brev / 未來 DGX Spark on-prem) ────┐
                                        │                                                          │
┌─ 客戶 Gmail ─┐                         │  ┌─ Email Bridge (host) ─┐                              │
│              │◄────real SMTP/IMAP────►│  │  IMAP poll 新詢價       │                              │
└──────────────┘                         │  │  Outbox watcher SMTP   │                              │
                                        │  │  Auto-trigger agent    │                              │
┌─ 廠商 Gmail ─┐                         │  └────────┬───────────────┘                              │
│ (3 家代工廠) │◄────real SMTP/IMAP────►│           │ inject [EMAIL_IN] 訊息                       │
└──────────────┘                         │           ▼                                              │
                                        │  ┌──────────────────────────────────────────────┐        │
┌─ 廖老闆 LINE ┐                         │  │ NemoClaw sandbox (kernel: seccomp/Landlock/netns) │
│              │◄──── webhook ─────────►│  │  └─ OpenClaw agent (Nemotron Super 120B)           │
└──────────────┘                         │  │      └─ 10 skills（event-driven）                   │
                                        │  │          • order_store · inbox_watch · send_email   │
                                        │  │          • read_drawing · get_history_quote         │
                                        │  │          • check_schedule · calc_cost               │
                                        │  │          • compare_suppliers · line_notify          │
                                        │  │          • generate_quote_pdf                       │
                                        │  └──────────────────────────────────────────────┘        │
                                        │                                                          │
                                        │  推理：Nemotron Super 120B via NVIDIA NIM                │
                                        │  egress allowlist：NIM / Gmail SMTP/IMAP / LINE API     │
                                        │  稽核：每個 skill call + LINE 簽核都寫 audit_trail       │
                                        └──────────────────────────────────────────────────────────┘
```

### 架構演進：從 orchestrator 到 event-driven autonomous agent

**原計畫**：3 個 OpenClaw agent + Node.js orchestrator 寫死順序呼叫（求 deterministic）。

**實作後 pivot**：1 個 OpenClaw main agent + 10 個 skill。原因：
- OpenClaw native agent 跑在 NemoClaw sandbox 內，**治理是 kernel-level 真實**
- email-bridge 偵測新詢價 → 自動 inject `[EMAIL_IN]` user message → agent 醒過來自跑（**真 autonomous**、不靠外部 orchestrator）
- 每個 skill 有 `agent: 'engineer' | 'planner' | 'quote'` metadata → dashboard 視覺呈現「3 個 sub-agent 協作」效果

### Dashboard 視覺三角色（skill role 對應）

| 角色 | 對應 skill | 模型 |
|---|---|---|
| 🔧 **工程判讀 Agent** | `read_drawing` (vision)、`get_history_quote` | Nemotron Super 120B |
| 📅 **生管 Agent** | `check_schedule` | Nemotron Super 120B |
| 📊 **報價主 Agent** | `calc_cost`、`compare_suppliers`、`generate_quote_pdf`、`send_email`、`line_notify`、`order_store`、`inbox_watch` | Nemotron Super 120B |

---

## Tool Calling 三分類（比賽硬性要求）

10 個 skill 完整分類：

| 類別 | 性質 | Skill |
|---|---|---|
| **INPUT** | 讀取、解析、自動 | `read_drawing`（Nemotron VL 讀工程圖 PDF）、`inbox_watch`（IMAP 解析廠商回信 + auto-parse 報價）、`get_history_quote`（加權相似度從 10k 歷史訂單找 top-K）、`check_schedule`（查產線排程 vs 客戶交期） |
| **CONTROL** | 計算、權衡、受護欄 | `calc_cost`（BOM × 成本表 × overhead × markup）、`compare_suppliers`（價/期/質多維評分 + AI 業務策略建議）、`order_store`（訂單狀態 hub、所有 skill 結果寫回） |
| **OUTPUT** | 對外、不可逆、人類把關 | `send_email`（SMTP 真寄 RFQ 給廠商 + 加密報價單給客戶）、`line_notify`（推 LINE flex 給老闆簽核）、`generate_quote_pdf`（PDFKit + 中文字型 + 密碼保護） |

### Anti-Leak Triple Defense（三層機密外洩防護）

| 層 | 機制 | 例子 |
|---|---|---|
| **L1 Prompt** | AGENTS.md 規矩 + 業務模型教學 | 「不要把毛利率寫進客戶 email body」 |
| **L2 Skill** | send_email 偵測客戶報價 attachment → 自動 regex redact body 內機密欄位 | 「毛利率：32%」、「表面處理：大同精密表面（單件加工費 NT$ 420）」自動刪 |
| **L3 Kernel** | NemoClaw kernel-level egress allowlist + sandbox isolation | sandbox 內試 `curl evil.com` 直接被 kernel 擋 |

Agent prompt 可以被攻陷、skill 可以被誤用，但 **kernel 層 NemoClaw egress 改不到** —— 這才是工廠老闆敢用 AI agent 的關鍵。

---

## 工程圖面：demo 用的 vs 真實樣貌

這是 demo 評審該知道的最重要一個誠實揭露：**Nemotron VL 在乾淨 demo 圖面上跑得很好，但真實工廠進來的圖面比這混亂很多**。

| 維度 | Demo 用的圖面 | 桐聚 / 達洲精密實際收到的圖面 |
|---|---|---|
| **檔案來源** | AutoCAD / SolidWorks 直接匯出的乾淨 PDF（向量） | 客戶 LINE / Email 傳來的 **手機翻拍** 或低解析度 **掃描 PDF**（光柵、有摺痕、反光） |
| **語言混雜** | 中文 + 標準工程符號 | 中／英／日混雜（日商客戶很多）、簡繁混用、現場手寫繁體註記 |
| **頁數** | 單頁 A4，BOM + 三視圖 + Title block 都在一張 | 多頁（爆炸圖／組裝圖／公差表／材料表分頁），常常還缺頁、頁序亂 |
| **註記** | 機印標準字型 | 業務手寫批註：「這批改用 PU」「Shore A 70 不要 65」「客戶要 ESD」紅筆圈起來 |
| **Title block** | 固定右下角 | 每個客戶格式不同（左上／右下／橫式／直式），常被翻拍切掉 |
| **公差與表面符號** | 機印 ISO/CNS 標準符號（▽▽▽、Ra 1.6、±0.05） | 部分手寫、部分掃描糊掉、有些用客戶內部代號（要對照表） |
| **附件** | 一份 PDF | PDF + Excel BOM + 客戶內部 ERP 截圖 + 過往溝通的 LINE 截圖混在一個 zip |

**Demo 用乾淨圖面是合理的**——比賽要在 3 分鐘內證明 vision agent **能**讀工程圖。但要產品化進工廠，得正面處理上述每一條落差，這就是下一節 Roadmap 要強化的事。

---

## NemoClaw 五道守門

| Gate | 名稱 | 觸發時機 | 模式 |
|---|---|---|---|
| ① | `gate-1-secret-probe` | 客戶/廠商來信打聽成本結構或供應商名單 → agent 偵測、報價單 body 不洩漏 | LINE 簽核 |
| ② | `gate-pre-rfq` | 工程判讀 + 算成本完成、要寄 RFQ 給 3 家代工廠前 | LINE 簽核 |
| ③ | `gate-2-tradeoff-decision` | 3 家廠商回信、AI 比價完成、要老闆選誰 | LINE 簽核（含 AI 推薦 + AI 業務策略） |
| ④ | `gate-3-final-quote-signoff` | 最終報價單即將寄給客戶前 | LINE 簽核（老闆可直接 LINE 打字改價） |
| ⑤ | `gate-4-blueprint-egress` | 圖紙 PDF 對外送（含 RFQ + 報價單） | **Kernel 強制**（NemoClaw egress allowlist） |

**4 LINE 簽核 + 1 kernel egress = human-in-the-loop + machine-in-the-edge**。

### Gate ③ 的 AI 業務策略（demo wow point）

不只是比較三家數字，AI 像資深業務一樣思考：

```
⚖️ 多維權衡 · 廠商比價

🏆 AI 推薦：大同精密表面（NT$420 · 4 天 · ✅ ESD-S20.20）
理由：✅ 交期最短、✅ 有抗靜電認證（符合 PCB 客戶硬性需求）

💡 AI 策略：跟客戶談放寬 ESD 認證要求
若客戶 ESD 非硬性，改用順興（NT$370）省 12%、200 隻總省 NT$10,000
建議話術：「ESD 規格主要影響 X 製程，能否確認貴司產線是否真需要？」

[ 選 大同（AI 推薦） ] [ 改選 順興 ] [ 跟客戶談放寬 ESD 改用順興省 12% ]
```

第三個按鈕——**AI 主動提出「跟客戶協商」的策略**——是這套系統的差異化。AI 不只算術、它建議業務動作。

### 護城河是「整個治理架構」，不是單一守門

評審可能會說：「圖面／成本／簽核用 if-else 也能做。」差別不在能不能擋，在 **agent 被 prompt injection 攻陷時還擋不擋得住**。if-else 跟 agent 同程序、會一起被繞過；NemoClaw 在 OpenShell 沙盒**外**、kernel 層強制執行 egress policy（seccomp + Landlock + network namespace），agent 改不掉自己的規則。所有守門都防得住內部失控——這才是護城河。

完整政策見 [`presets/gatherease-egress.yaml`](./presets/gatherease-egress.yaml)。

### Deployment Note: NemoClaw 需要 Ubuntu 24.04（不是 22.04）

NemoClaw 的 `openshell-gateway` 二進位需要 **glibc 2.38+**。我們最初用 Brev 預配的 NemoClaw launchable（Ubuntu 22.04 / glibc 2.35）卡在 sandbox image build Step 18/62（NVIDIA Issue #3456 已記錄此 incompatibility）。**Pivot 到 Ubuntu 24.04（glibc 2.39）後一次過關**。

**Ubuntu 24.04 VM 上的完整驗證紀錄：**

```
[1/8] Preflight: ✓ Docker / OpenShell 0.0.44 / 4 vCPU / 15.6 GiB RAM
[2/8] OpenShell gateway: ✓ Docker-driver healthy
[3/8] Inference: ✓ NVIDIA Endpoints, Nemotron 3 Super 120B
[4/8] Provider nvidia-prod created · inference.local route active
[5/8] Messaging: skipped (LINE 用自訂 webhook、不走內建 channel)
[6/8] Sandbox image build: ✓ 74 of 74 steps in 383s
[7/8] OpenClaw gateway launched inside sandbox
[8/8] Policy presets applied (Balanced tier)
═══ NemoClaw is ready ═══
Sandbox: gatherease-quote-agent  ·  Phase: Ready  ·  Policy version: 10
```

**完整 enforced egress whitelist**（內建 + 我們自訂、`openshell policy get --full` 驗證）：

| 來源 | host | 用途 |
|---|---|---|
| 內建 `nvidia` | `integrate.api.nvidia.com:443` | Nemotron API（POST `/v1/chat/completions`、GET `/v1/models`） |
| 內建 `managed_inference` | `inference.local:443` | sandbox 經 OpenShell gateway 走 inference |
| 內建 `npm/pypi/brew/huggingface/brave` | 對應 registry 端點 | Balanced tier 預設 |
| **自訂 `line-messaging`** | `api.line.me:443`、`api-data.line.me:443` REST | LINE flex message push / webhook |
| **自訂 `gmail-smtp`** | `smtp.gmail.com:587/465` raw TCP | 對外發詢價信、加密報價單 |
| **自訂 `gmail-imap`** | `imap.gmail.com:993` raw TCP | 收代工廠回信 |

**Whitelist 外**：sandbox 內試 `curl https://evil-data-exfil.example.com/` 回 `CONNECT tunnel failed, response 403` — NemoClaw kernel-level 真的擋。這個是 demo 影片裡「治理是真的」的 2-3 秒 b-roll 鏡頭素材。

**自訂 preset YAML 位置**：[`presets/`](./presets/) 三個檔（[`line-messaging.yaml`](./presets/line-messaging.yaml) / [`gmail-smtp.yaml`](./presets/gmail-smtp.yaml) / [`gmail-imap.yaml`](./presets/gmail-imap.yaml)），格式對齊 [NVIDIA NemoClaw 官方 schema](https://docs.nvidia.com/nemoclaw/latest/network-policy/customize-network-policy.html)。

**部署一鍵指令**（給未來重現用，假設 Ubuntu 24.04 host + Docker + Node 22）：

```bash
curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
# 接互動 prompts：NVIDIA Endpoints → Nemotron Super 120B → 貼 API key
# → 沙盒名 gatherease-quote-agent → Brave/messaging 都 N → Apply Y
sudo ufw allow from 172.18.0.0/16 to 172.18.0.1 port 8080 proto tcp
nemoclaw gatherease-quote-agent policy-add --from-dir ./presets/ --yes
```

---

## 怎麼跑

### 環境分工：Mac 開發 + Linux VM 跑真 NemoClaw

NemoClaw 的隔離靠 **Linux kernel 三機制**（seccomp、Landlock LSM、network namespace），macOS 沒這些 API——只能用 Docker Desktop 模擬，不給同等隔離保證。所以採：

| 工作 | 在哪 |
|---|---|
| 寫 code / skill / bridge / HTML 介面 | **Mac** |
| 錄 demo 影片（HTML + 穿插 VM 終端機） | **Mac** |
| OpenClaw + Nemotron + NemoClaw 真實運行 | **Linux VM**（本案用 NVIDIA Brev 提供的 launchable） |

### 0. 前置需求

**Mac（開發機）**
- Node.js LTS（建議 22+）
- 編輯器、git

**Linux VM（跑真治理）**
- Ubuntu 22.04+、≥ 8GB RAM、Docker、Node.js 22+
- 推薦：[NVIDIA Brev NemoClaw launchable](https://brev.nvidia.com/launchable/deploy/now?launchableID=env-3Azt0aYgVNFEuz7opyx3gscmowS)（NemoClaw + OpenShell 預裝）

**雲端服務**
- NVIDIA API Key — [build.nvidia.com](https://build.nvidia.com)
- 一個測試 Gmail 帳號（**不要**用主帳號）
- 一個 LINE Messaging API Channel — [developers.line.biz/console](https://developers.line.biz/console)

### 1. 在 Linux VM 上裝 NemoClaw（不是用 Brev launchable 的話）

> ⚠️ **NemoClaw 不是 npm 套件**——npm 上同名 `nemoclaw` 0.1.0 是別人佔名的 222 bytes 空殼，跟 NVIDIA 無關。
> 官方來源：[github.com/NVIDIA/NemoClaw](https://github.com/NVIDIA/NemoClaw)（Apache 2.0、2026/03/16 GTC 發表、early preview）

```bash
# 一行裝（自動裝 Node.js 缺項、跑 onboard 精靈建沙盒 / 設推理 / 套政策）
curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash

# 非互動 onboard
NEMOCLAW_POLICY_TIER=open nemoclaw onboard --non-interactive --yes-i-accept-third-party-software
```

### 2. 安裝 OpenClaw

```bash
sudo npm install -g openclaw@latest
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice apiKey \
  --gateway-port 18789 \
  --gateway-bind loopback \
  --install-daemon \
  --daemon-runtime node
```

### 3. 套用本案 egress 政策

```bash
nemoclaw gatherease-quote-agent policy-add --from-file ./presets/gatherease-egress.yaml
```

### 4. 設環境變數

```bash
cp .env.example .env
# 編輯 .env，填入 NVIDIA_API_KEY、LINE token、Gmail App Password
```

### 5. 一鍵啟動所有 service

```bash
bash scripts/start-all.sh                # 全套（deploy skill + 起 mirror + 起 bridge + 起 LINE webhook + 起 cloudflared）
bash scripts/start-all.sh --reset        # 順便清 sandbox 資料從零開始
bash scripts/start-all.sh --no-deploy    # 跳過 deploy 直接起 service
```

跑完 console 會印出：
- 🌐 Dashboard URL：`http://localhost:8000/factory-quote-demo.html`
- 📋 Cloudflared quick tunnel URL（貼到 LINE Console webhook 設定）
- ✅ 4 個 service health check

### 6. 觸發 e2e demo

從測試 Gmail 寄一封詢價信到 GatherRoller email（subject 含「詢價」+ 附 PDF）：

```
T+0     寄信
T+30s   bridge IMAP poll → 寫 inbox JSON → 自動 inject [EMAIL_IN] 給 agent
T+33s   agent 醒過來：order_store create → read_drawing → get_history_quote → check_schedule → calc_cost
T+45s   agent push LINE gate-pre-rfq 給老闆
T+??    老闆 LINE 按「發詢價」→ agent 寄 3 封 RFQ 給代工廠
T+??    廠商真回信 → bridge auto-trigger 再次喚醒 agent
T+??    inbox_watch auto-parse 報價 → compare_suppliers → push LINE gate-2
T+??    老闆選廠商（或直接 LINE 打字改價）→ generate_quote_pdf → send_email 客戶
```

### 7. 看治理稽核軌跡

```bash
# 看 sandbox 內 NemoClaw kernel log
nemoclaw gatherease-quote-agent logs --tail 100

# 看 agent session jsonl（內含每個 tool call + thinking + result）
nemoclaw gatherease-quote-agent exec -- ls /sandbox/.openclaw/agents/main/sessions/

# 看 order audit_trail（每個 skill 寫回 + 老闆 LINE 決定都記）
nemoclaw gatherease-quote-agent exec -- cat /sandbox/.openclaw/workspace/data/orders/QUO-2026-0001.json | jq .audit_trail
```

---

## Repo 結構

```
gatherease-quote-agent/
├─ README.md                      # 你正在讀的這份
├─ CLAUDE.md                      # Claude Code session 上下文
├─ package.json
├─ .env.example                   # 環境變數範本（真 .env 不進 git）
│
├─ workspace/                     # sandbox 內 agent 看到的 workspace（會被 deploy-skills.sh 同步進 sandbox）
│  ├─ AGENTS.md                   # agent operating manual（5 道 gate + 8 個情境 + 客戶 body 鐵律）
│  ├─ SOUL.md / IDENTITY.md / USER.md / TOOLS.md   # agent persona 設定
│  ├─ skills/                     # 10 個 skill + _lib helper
│  │  ├─ _lib/order_writeback.js     # 共用 helper：skill 自動寫回 order
│  │  ├─ order_store/              # CONTROL · 訂單 CRUD hub
│  │  ├─ inbox_watch/              # INPUT · IMAP 解析廠商回信 + auto-parse 報價
│  │  ├─ read_drawing/             # INPUT · Nemotron VL 讀工程圖（含 mock fallback）
│  │  ├─ get_history_quote/        # INPUT · 加權相似度 top-K 歷史單比對
│  │  ├─ check_schedule/           # INPUT · 產線排程評估
│  │  ├─ calc_cost/                # CONTROL · BOM × 成本 × overhead × markup
│  │  ├─ compare_suppliers/        # CONTROL · 3 家評分 + AI 業務策略
│  │  ├─ line_notify/              # OUTPUT · 推 LINE flex 給老闆
│  │  ├─ send_email/               # OUTPUT · SMTP 真寄 + auto-attach + auto-redact
│  │  └─ generate_quote_pdf/       # OUTPUT · PDFKit + CJK 字型 + 密碼保護
│  └─ data/                       # 合成資料
│     ├─ suppliers.json            # 全鋼 / 大同 / 順興 / 金鋼鐵輪
│     ├─ schedule.json             # 產線排程
│     └─ customers.json            # 鴻碩電子等
│
├─ scripts/                       # host 端服務 + 工具
│  ├─ start-all.sh                # ⭐ 一鍵啟動所有 service
│  ├─ email-bridge.js             # IMAP/SMTP bridge（host 端、繞過 NemoClaw 治理層擋的 SMTP）
│  ├─ demo-mirror-server.js       # Dashboard backend（port 8000）+ /api/order/latest 等 endpoint
│  ├─ deploy-skills-to-workspace.sh  # 把 skill + AGENTS.md 推進 sandbox
│  └─ restart-bridge.sh           # 單獨重啟 bridge（含 source .env）
│
├─ skills/line_notify/webhook.js  # LINE 收 postback webhook server（port 3000）+ inject agent message
│
├─ data/                          # host 端 reference 資料（會 sync 到 sandbox）
│  ├─ historical_orders.csv       # 10,000 筆合成歷史訂單
│  └─ bom_cost_data.csv           # 26 種 compound 單位成本表
│
├─ presets/
│  ├─ line-messaging.yaml         # NemoClaw egress allowlist
│  ├─ gmail-smtp.yaml
│  └─ gmail-imap.yaml
│
├─ showcase/
│  └─ factory-quote-demo.html     # ⭐ Dashboard 主畫面（5 步驟時間軸 + agent thinking + 3 agent 視覺 + 治理 panel）
│
└─ docs/
   ├─ PLAN-A-DEPLOY-JOURNAL.md    # 部署紀錄
   └─ GOVERNANCE-EVIDENCE.md      # 7 件 NemoClaw kernel-level 治理證據
```

---

## 合成資料聲明

本 repo 所有資料（產品 BOM、客戶、供應商、報價、排程、歷史訂單）**皆為合成示意，非桐聚 GatherEase 或達洲精密的真實企業資料**。`data/historical_orders.csv` 的 10,000 筆訂單是用 GatherEase 早期專案 `generate_orders.py` 腳本產生的合成資料；產品類型（包膠鐵輪／橡膠滾輪）真實存在於台灣中部精密機械業，數字與名稱皆為虛構。

---

## 金鑰安全

- `.env`、`openclaw.json` 已在 `.gitignore`，**絕對不要 commit 真實金鑰**。
- Gmail 務必用「專門測試帳號」，不要用主帳號（agent 自動收發會被 Google 濫用偵測標記）。

---

## Demo 影片

📹 **3 分鐘 demo 影片**：(https://youtu.be/aM2bWkP4HjM?si=-zS7L8Z2EYRVUksC)

**影片內 5 個 wow 鏡頭**：

1. **客戶寄詢價 → bridge auto-trigger**：完全無人介入、agent 自醒、開始跑（**真 autonomous**）
2. **AI 工程判讀 + 多廠商比價**：3 個 sub-agent 視覺化協作（dashboard 左側場景隨 skill 切換）
3. **AI 業務策略**：LINE gate-2 顯示「💡 跟客戶談放寬 ESD 改用順興省 12%」+ 建議話術（**業務直接照唸**）
4. **老闆 LINE 改價 human override**：AI 算 NT$1,638、老闆 LINE 打字「**單價改為 1700 簽核並寄出**」→ PDF 用 1700、audit log 記 `price_source: boss_override`
5. **客戶收到極簡 body + 密碼 PDF**：body 自動 redact 毛利率/供應商名、PDF 用 order_id 後 4 碼加密

---

## 技術 Roadmap：產品化前要強化的點

Demo 證明了端到端可行，但要進真實工廠日常使用，下面這些是已知必須補強的技術項目。按優先級排：

### P0 — 工程圖讀取（read_drawing）的真實化

| 項目 | 現況 | 要做到 |
|---|---|---|
| **掃描 / 翻拍圖** | 只測過向量 PDF | 加 image preprocessing pipeline：去摺痕、矯正透視、二值化、解像度提升（ESRGAN）後再丟 Nemotron VL |
| **多頁 PDF** | 只讀第一頁 | 分頁 OCR → 用 Nemotron 分類「總圖／爆炸圖／BOM 表／公差表」→ 各自走不同 prompt |
| **手寫註記** | 完全沒處理 | 對紅筆／藍筆批註區做 mask、丟手寫 OCR（PaddleOCR-handwritten + Nemotron 校正）|
| **Title block 變體** | 假設右下 | 用 layout-aware model（DocLayoutNet / LayoutLMv3）先定位 title block / BOM / 註記區，再分區丟 VL |
| **客戶內部代號對照** | 沒處理 | 每個客戶建一張「術語對照表」（如 ESD-S20.20 → IEC-61340），跟 historical_orders 共用 vector DB 查 |
| **三視圖→3D 重建** | 沒做 | 投產時若有 STEP 檔最好；否則用 multi-view → mesh inference 出近似體積、輔助算重量／材料費 |

### P1 — 推理與資料治理

| 項目 | 現況 | 要做到 |
|---|---|---|
| **On-prem NIM** | demo 走雲端 `integrate.api.nvidia.com` | 把 Nemotron Super 120B 部進 DGX Spark / H100，整條 inference 不出工廠 |
| **Skill version control** | 直接覆寫 sandbox 內檔案 | 加 skill manifest hash + rollback；某 skill 出包能秒退回上版 |
| **Audit log 不可竄改** | `audit_trail` 寫在 order JSON 裡，agent 理論上能改 | 改寫 append-only log（hash chain or WORM bucket），稽核時可被法務查 |
| **歷史報價檢索** | `get_history_quote` 用加權字串相似度跑 10k 筆 | 換 vector embedding（Nemotron Embed）+ pgvector / Milvus，能跑 100 萬筆 + 跨多維欄位 hybrid search |
| **Multi-tenant policy** | 一個 sandbox 一家客戶 | NemoClaw 每客戶獨立 namespace + egress policy；同一台 DGX 可同時跑多家工廠且互相隔離 |

### P2 — Bridge 與通訊

| 項目 | 現況 | 要做到 |
|---|---|---|
| **Email bridge 是 host 端 hack** | `scripts/email-bridge.js` 在 sandbox 外、繞過 NemoClaw 擋 SMTP/IMAP | 等 NemoClaw 官方支援「named-flow MCP egress」後，把 bridge 移進 sandbox 受治理 |
| **LINE webhook 走 cloudflared quick tunnel** | URL 每次重啟會變、要手動貼 | 改 LINE PUT API 自動更新 webhook URL（task #49）；或用 named tunnel + 固定 hostname |
| **Email body 只有中文模板** | hard-coded 中文 | i18n：客戶語系從 customers.json 帶、agent prompt 內生對應語言 body |
| **附件型別** | 只處理 PDF | 加 Excel BOM 解析、LINE 截圖 OCR、zip 自動解包 |

### P3 — Agent 行為與可觀測性

| 項目 | 現況 | 要做到 |
|---|---|---|
| **Streaming response** | gate-2 LINE 推播要等 agent 全跑完 | Nemotron stream → skill 階段性 flush 給 dashboard、LINE 推遞進式進度 |
| **AI 業務策略可解釋性** | 純 prompt 產 | 把「策略 → 預期省下金額」做成 deterministic skill（不靠 LLM 想），LLM 只負責話術包裝 |
| **報價同步進 ERP** | 沒做 | 加 `push_to_erp` skill 對接鼎新 / 正航 / Odoo |
| **自動學習客戶議價偏好** | 沒做 | gate-3 老闆改價的 delta 寫進 feedback loop → 下一次同客戶 markup 微調 |

---

## 結論：人機分工

| 計算 Calculation | 建議 Recommendation | 決斷 Judgment |
|---|---|---|
| AI 做：拆 BOM、算成本、彙整比價 | AI 輔助：這家可砍、這客戶建議讓利 | 人決定：砍不砍、報多少、送不送出 |

**資料留工廠、模型來工廠、人類最後把關**。

---

## 致謝

- **NVIDIA**：Nemotron 模型、NemoClaw 治理參考堆疊、AI-Q Open Agent Blueprint、Brev 雲端 VM
- **Peter Steinberger / OpenClaw**：agent 編排與 sandbox 框架
- **NVIDIA NemoClaw 團隊**：kernel-level 治理參考實作（seccomp / Landlock / netns）
- **桐聚 GatherEase 團隊**：產品與市場洞察、25.01 AI Agent 專案的合成 dummy data 與 `similarity_checker.py`

> 本案由桐聚科技以「一個人 + 多個 AI agent」協作完成——不只做 agent demo，是親身在用這套方法工作。

---

**License：** MIT
