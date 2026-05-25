# CLAUDE.md — 桐聚 × NVIDIA Agent Hackathon

> 給未來在這個 repo 開 Claude Code session 的人：先讀完這份再下 slash command。

## 專案一句話

桐聚科技為 NVIDIA Agent Hackathon 打造的「AI 報價詢價 Agent」demo + 提案，主打 **NemoClaw 治理層**讓最保守的台灣中小製造業敢用 autonomous agent。截止 **2026/05/28 12:00**（影片上限 3 分鐘）。

## Slogan

**流程交給 AI，決策留給老闆。**
AI handles the process. You make the call.

## 核心架構：3 agents + Node.js orchestrator

刻意**不用** OpenClaw 內建的 `sessions_spawn`（LLM 自決 spawn，非確定性）。改用 **Node.js orchestrator** 寫死順序呼叫三個 agent——錄影穩定、可治理、不黑盒。

| Agent | 對應角色 | 模型 | 職責 |
|---|---|---|---|
| `engineer` | 工程師 | Nemotron Super | 讀工程圖 PDF、定 BOM、分採購/代工/自製 |
| `planner` | 生管 | Nemotron Super | 查產線排程、評估交期可達性 |
| `quote` | 報價員 | Super (內呼 Nano) | 算成本、比價、產生報價、加密 |

雙模型分工踩 NVIDIA AI-Q Open Agent Blueprint：**Nano** 處理輕任務（讀 PDF 抓欄位、分類），**Super** 處理深度判斷（讀圖、權衡、套機密偵測）。

## 五層堆疊

| 層 | 元件 |
|---|---|
| 治理 | NemoClaw + OpenShell（沙盒、deny-by-default egress、kernel 層強制：seccomp + Landlock + network namespace） |
| 編排 | OpenClaw daemon（常駐、長記憶） |
| Orchestrator | `orchestrator.js`（Node.js 確定性流程） |
| 推理 | Nemotron Nano + Super（雲端 NIM API，未來 DGX Spark on-prem） |
| 介面 | LINE Messaging API（對內）+ Gmail SMTP/IMAP（對外） |

## 環境分工：Mac 開發 + Linux VM 跑真 NemoClaw

NemoClaw 的 kernel 強制（seccomp / Landlock / network namespace）只能在 Linux 跑；macOS 沒有對應 kernel API。**所以採 Mac 寫 code + Linux VM（Ubuntu，≥8GB RAM，Tailscale 接 Mac）跑真治理層**。

| 工作 | 在哪 |
|---|---|
| 寫 code / orchestrator / skill / HTML 介面 | Mac |
| 錄 demo 影片（HTML 主畫面 + 穿插 VM 終端機） | Mac |
| OpenClaw + Nemotron + NemoClaw 真實運行 | Linux VM |
| NemoClaw onboard / egress policy / 沙盒 | Linux VM |

**NemoClaw 安裝**：`curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash`（**不是 npm**——npm 上同名 0.1.0 是別人佔名的空殼）。官方來源 [github.com/NVIDIA/NemoClaw](https://github.com/NVIDIA/NemoClaw)，Apache 2.0、2026/03/16 GTC 發表、alpha/early preview。

## Tool Calling 三分類（比賽硬性要求）

- **INPUT**：讀單、讀圖、撈歷史報價、查鐵輪採購價、查膠料價、查產線排程、查廠商歷史
- **CONTROL**：算成本、多維度比價、權衡 trade-off、偵測套機密
- **OUTPUT**：發詢價＋圖面、寄加密報價單、報價單存檔

## NemoClaw 五道守門

**Demo 演 3 道（人話、有共鳴）：**
1. ① **擋下套機密的人**——客戶/廠商來信打聽成本/廠商名單，agent 擋下不回答（保護老闆）
2. ② **多維權衡討論**——價/期/質 trade-off 攤老闆討論（人在決策）
3. ③ **最終報價真人簽核**——對外送出前老闆親自確認（human-in-the-loop）

**系統保留 2 道（log 一行帶過，計入治理佔比）：**
4. ④ 對外發送圖面確認
5. ⑤ 惡意郵件 prompt injection 防禦（給技術評審加分）

## 評分軸對應

- **最高權重（NemoClaw 治理佔比 + 安全）**：5 道守門 + audit.jsonl
- **完整度**：tool 三分類、autonomous（orchestrator 自跑到 HOLD 才停）、persistent（OpenClaw daemon launchd）
- **創意**：題目本身（製造業客製化報價困境）

## 核心賣點：資料留工廠，模型來工廠

**Demo 階段**走雲端 Nemotron 端點（無本地 GPU）；**產品形態**整台 NVIDIA DGX Spark 放工廠：128GB 統一記憶體、可跑 200B 模型、推理/資料/治理全部本地。NemoClaw egress policy 在 demo 裡**就真的在擋**——治理是真的。

## Demo 主秀產品：包膠鐵輪（合成資料）

不是達洲機密配方。使用合成的鴻碩電子詢價單、3 家代工廠（全鋼 / 永鎵 / 新鎏鍍）、產線排程、歷史報價。**所有資料 README 標明「合成、非真實企業資料」。**

## 5 天 Sprint（今天是 Day 2，5/25）

| 天 | 重點 |
|---|---|
| Day 1 (5/24) ✅ | 定稿 demo、3 張投影片、架構圖 |
| **Day 2 (5/25)** | 裝 OpenClaw + Nemotron + NemoClaw、寫 egress YAML、建 3 agent、寫核心 skill |
| Day 3 (5/26) | 接 LINE + Gmail、orchestrator 串通端到端 |
| Day 4 (5/27) | 彩排 + 預錄 1080p 影片 (< 3 分鐘) |
| Day 5 (5/28) | 壓力測試、README/policy/.env 收尾、11:30 前送件 |

## gstack 使用指引

這個專案用 gstack 跑：
- `/office-hours` — 拷問提案核心（已跑過，見 `gstack-review-report.md`）
- `/plan-ceo-review` — CEO 視角壓力測試（已跑過）
- `/plan-eng-review` — 架構與 demo 腳本審查（已跑過）
- `/plan-design-review` — UI 審查（已跑過）
- `/autoplan` — 跑完整 review pipeline
- `/qa https://...` — 開瀏覽器測 factory-quote-demo.html
- `/ship` — 開 PR

## 檔案地圖

- `桐聚_AI報價Agent_專案藍圖.docx` — 完整提案藍圖（source of truth）
- `桐聚_AI報價Agent_建置計畫.docx` — Day 2 起的技術建置計畫（source of truth）
- `factory-quote-demo.html` — 互動式 demo 原型（3 agent 協作 + 治理面板）
- `slide-data-sovereignty.html` — 「模型來工廠」投影片
- `gstack-review-report.md` — gstack 四角色 review + sprint 計畫
- `orchestrator.js` — Node.js 確定性流程主腳本
- `openclaw.json` — OpenClaw 設定（含三 agent 定義；**不進 git**）
- `skills/` — 各能力 skill 模組
- `data/` — 合成資料 JSON
- `presets/gatherease-egress.yaml` — NemoClaw egress 政策
- `logs/audit.jsonl` — 治理稽核軌跡
- `.env.example` — 金鑰範本（真 .env **不進 git**）
- `CLAUDE.md` — 你正在讀的這份
