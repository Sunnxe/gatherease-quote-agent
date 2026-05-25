# 桐聚 AI 報價詢價 Agent

NVIDIA Agent Hackathon 2026 參賽專案

**Slogan：流程交給 AI，決策留給老闆。**
*AI handles the process. You make the call.*

---

## 為什麼這個 demo 對 NVIDIA 重要

NemoClaw 的存在目的，是拆掉企業「不敢讓 AI 自己跑」的心理障礙。本案例證明：**連最怕資料外洩的台灣傳統製造業，都能靠 NemoClaw 安全地導入 autonomous agent。** 我們幫 NVIDIA 把 agent 推進了一個它原本進不去、卻又是它硬體供應鏈根基的巨大市場——投資桐聚 ＝ 讓 GPU 進入下 100 個保守產業。

**核心架構承諾：資料留工廠，模型來工廠。** Production 形態整台 NVIDIA DGX Spark 放工廠，推理 / 資料 / 治理全部本地。Demo 階段走雲端 Nemotron 端點（無本地 GPU），但 NemoClaw 的 egress policy 在 demo 裡**就真的在擋**——治理是真的。

---

## 架構

```
┌─ 老闆 LINE ────┐     ┌─ Mac mini (always-on, 未來 DGX Spark) ─────┐
│                │◄──►│  NemoClaw (OpenShell 沙盒 + kernel egress)  │
└────────────────┘     │   └─ OpenClaw daemon                        │
                       │       └─ orchestrator.js (確定性流程)        │
                       │           ├─ engineer agent (工程判讀)        │
                       │           ├─ planner agent (生管)             │
                       │           └─ quote agent (報價主)             │
                       │       推理：Nemotron Nano + Super              │
┌─ 廠商 / 客戶 ──┐     │       資料：data/*.json（合成）              │
│  Gmail SMTP    │◄──►│       稽核：logs/audit.jsonl                  │
│  IMAP test     │     └────────────────────────────────────────────┘
└────────────────┘
```

### 為什麼用 Node.js orchestrator 不用 `sessions_spawn`？

OpenClaw 內建 `sessions_spawn` 是「LLM 自決何時 spawn」的非確定性機制，每次跑可能不一樣——對要錄影、要治理稽核的我們是風險。**改用 Node.js orchestrator 寫死順序呼叫三個 agent**：每次跑都一樣、demo 穩定、每個 HOLD 點都是真實人類把關。

### 三個 agent 對應工廠真實角色

| Agent | 角色 | 模型 | 職責 |
|---|---|---|---|
| `engineer` | 工程師 | Nemotron Super | 讀工程圖、判定 BOM/採購·代工·自製 |
| `planner` | 生管 | Nemotron Super | 查產線排程、評估交期可達性 |
| `quote` | 報價員 | Super (內呼 Nano) | 算成本、比價、產生報價、加密寄出 |

**雙模型分工**踩 NVIDIA AI-Q Open Agent Blueprint：Nano 處理輕任務（讀 PDF 抓欄位、分類），Super 做深度判斷（讀圖、權衡、套機密偵測）。

---

## Tool Calling 三分類（比賽硬性要求）

| 類別 | 性質 | 工具 |
|---|---|---|
| **INPUT** | 讀取、自動 | `read_drawing`、`get_purchase_price`、`get_material_price`、`get_history_quote`、`check_schedule` |
| **CONTROL** | 計算、可逆、受護欄 | `calc_cost`、`compare_suppliers`、`detect_secret_probe` |
| **OUTPUT** | 對外、不可逆、人類把關 | `send_rfq`、`encrypt_quote`、`send_quote`、`archive_quote` |

---

## NemoClaw 五道守門

**Demo 演 3 道（人話、有共鳴）：**

1. **擋下套機密的人** — 客戶/廠商來信打聽成本或廠商名單，agent 偵測後擋下不在報價單回答（agent 保護老闆）。
2. **多維權衡討論** — 價／期／質 trade-off 攤老闆討論，AI 算、人決定。
3. **最終報價真人簽核** — 對外送出前老闆親自確認（不可逆動作）。

**系統保留 2 道（log 一行帶過，計入治理佔比）：**

4. 對外發送圖面前確認廠商白名單。
5. 惡意郵件 prompt injection 防禦——`NemoClaw 在 OpenShell 沙盒外、kernel 層強制執行 egress policy`，agent 被 prompt injection 攻陷時無法改掉自己的規則。這是技術評審的加分點。

完整政策見 [`presets/gatherease-egress.yaml`](./presets/gatherease-egress.yaml)。

---

## 怎麼跑

### 環境分工：Mac 開發 + Linux VM 跑真 NemoClaw

NemoClaw 的隔離靠 **Linux kernel 三機制**（seccomp 過濾系統呼叫、Landlock LSM 限制檔案、network namespace 隔離流量），macOS 沒這些東西——只能用 Docker Desktop 模擬，不給同等隔離保證。所以採：

| 工作 | 在哪 |
|---|---|
| 寫 code / orchestrator / skill / HTML 介面 | **Mac** |
| 錄 demo 影片（HTML + 穿插 VM 終端機畫面） | **Mac** |
| OpenClaw + Nemotron + NemoClaw 真實運行 | **Linux VM** |
| `nemoclaw onboard` / egress policy / 沙盒 | **Linux VM** |

兩邊用 **Tailscale** 接。VM 可用便宜雲端 Ubuntu 或比賽提供的 Brev.dev（≥8GB RAM；沙盒映像約 2.4GB，RAM 不夠會被 OOM killer 砍）。

### 0. 前置需求

**Mac（開發機）**
- Node.js LTS（建議 22+）
- 編輯器、git、Tailscale

**Linux VM（跑真治理）**
- Ubuntu、≥ 8GB RAM、Docker、Node.js 22+、Tailscale

**雲端服務**
- NVIDIA API Key — [build.nvidia.com](https://build.nvidia.com)
- 一個測試 Gmail 帳號（**不要**用主帳號）
- 一個 LINE Messaging API Channel — [developers.line.biz/console](https://developers.line.biz/console)

### 1a. 安裝 OpenClaw（Mac 開發測試 + Linux VM 都裝）

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

### 1b. 安裝 NemoClaw — **Linux VM 上**（Mac 跳過）

> ⚠️ **NemoClaw 不是 npm 套件。** npm 上同名的 `nemoclaw` 0.1.0 是別人佔名的 222 bytes 空殼，**跟 NVIDIA 無關**。
> 官方來源：[github.com/NVIDIA/NemoClaw](https://github.com/NVIDIA/NemoClaw)（Apache 2.0、2026/03/16 GTC 發表、early preview / alpha）

```bash
# 一行安裝（會自動裝 Node.js 缺項、然後跑 onboard 精靈建沙盒 / 設推理 / 套政策）
curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash

# 非互動 onboard
NEMOCLAW_POLICY_TIER=open nemoclaw onboard --non-interactive --yes-i-accept-third-party-software

# 套用本案的 egress 政策（白名單：Nemotron / LINE / Gmail）
nemoclaw gatherease-quote-agent policy-add --from-file ./presets/gatherease-egress.yaml
```

**kernel 強制是真的**：政策引擎在 agent 行程之外，agent 被 prompt injection 攻陷也改不掉自己的限制。這是回答老闆「資料會不會外流」的技術答案。

### 2. 設環境變數

```bash
cp .env.example .env
# 編輯 .env，填入 NVIDIA_API_KEY、LINE token、Gmail App Password
```

### 3. 安裝 Node 相依

```bash
npm install
```

### 4. 跑 demo（不用任何外部憑證）

```bash
# 端到端跑一次，所有 HOLD 點老闆 mock approve
npm run demo

# 帶套機密信件，演 gate-1 攔截
npm run demo:secret

# 個別 skill 測試
npm run test:read-drawing
npm run test:calc-cost
npm run test:send-rfq
```

### 5. 看治理稽核軌跡

```bash
cat logs/audit.jsonl | jq '.'
```

---

## Repo 結構

```
nvidia_hackathon/
├─ README.md                      # 你正在讀的這份
├─ CLAUDE.md                      # Claude Code session 的上下文
├─ orchestrator.js                # Node.js 確定性流程主腳本
├─ package.json
├─ openclaw.json.template         # OpenClaw 設定範本（真實版不進 git）
├─ skills/                        # 各能力 skill 模組
│  ├─ read_drawing/               # engineer agent · 讀圖判讀
│  ├─ calc_cost/                  # quote agent · 算成本（純函數，可重現）
│  └─ send_rfq/                   # quote agent · 發詢價（OUTPUT，觸發守門）
├─ data/                          # 合成資料（synthetic data）
│  ├─ products.json               # 包膠鐵輪 BOM
│  ├─ suppliers.json              # 全鋼 / 永鎵 / 新鎏鍍
│  ├─ customers.json              # 鴻碩電子等
│  ├─ cost_rates.json             # 成本費率表
│  ├─ history_quotes.json         # 歷史報價（定價參考）
│  └─ schedule.json               # 產線排程
├─ presets/
│  └─ gatherease-egress.yaml      # NemoClaw 政策（顯眼擺，這是護城河）
├─ logs/
│  └─ audit.jsonl                 # 治理稽核軌跡（demo 跑完看這個）
├─ factory-quote-demo.html        # 互動式 demo 原型（錄影主畫面）
├─ slide-data-sovereignty.html    # 「模型來工廠」投影片
├─ 桐聚_AI報價Agent_專案藍圖.docx
├─ 桐聚_AI報價Agent_建置計畫.docx
└─ gstack-review-report.md        # gstack 四角色 review
```

---

## 合成資料聲明

本 repo 所有資料（產品 BOM、客戶、供應商、報價、排程）**皆為合成示意，非桐聚 GatherEase 或達洲精密的真實企業資料**。產品類型（包膠鐵輪）真實存在於台灣中部精密機械業，數字與名稱皆為虛構。

---

## 金鑰安全

- `.env`、`openclaw.json` 已在 `.gitignore`，**絕對不要 commit 真實金鑰**。
- Gmail 務必用「專門測試帳號」，不要用主帳號（agent 自動收發會被 Google 濫用偵測標記）。

---

## Demo 影片

📹 **3 分鐘 demo 影片**：（待 Day 4 錄製、上傳後填入連結）

---

## 致謝

- **NVIDIA**：Nemotron 模型、NemoClaw 治理參考堆疊、AI-Q Open Agent Blueprint
- **Peter Steinberger / OpenClaw**：編排框架
- **桐聚 GatherEase 團隊**：產品與市場洞察
- **Garry Tan / gstack**：CEO / Eng Manager / Designer / QA 多角色 review 流程

> 本案由桐聚科技以「一個人 + 多個 AI agent」協作完成——不只做 agent demo，是親身在用這套方法工作。

---

**License：** MIT
