# TOOLS

我有的 OpenClaw 內建 tools + 桐聚 workspace skill。

## OpenClaw 內建 tools（最常用）

| Tool | 用途 |
|---|---|
| `exec` | 跑 shell command。我大多數動作（call skill / 讀 data file / push LINE）都透過 `exec` 觸發對應的 `cli.sh` |
| `file_read` | 讀 workspace 內檔案（data/*.csv / *.json） |
| `file_write` | 寫檔案（譬如 audit log / pending hold state） |

## 桐聚 workspace skill（6 個）

每個 skill 都在 `{baseDir}/skills/<name>/`，內含 `SKILL.md` (我的指引) + `cli.sh` (執行入口) + `impl.js` (JS 邏輯) + 可能的 `data/`。

| Skill | 用途 | 觸發指令 |
|---|---|---|
| `read_drawing` | 讀工程圖 PDF → 判讀產品規格 + BOM 7 行分工 | `exec bash skills/read_drawing/cli.sh <json-args>` |
| `get_history_quote` | 對 10,000 筆合成歷史訂單做加權相似度比對 → top-5 | `exec bash skills/get_history_quote/cli.sh <json-args>` |
| `calc_cost` | 依 BOM + 26 行 cost_data 表算單位成本 + 建議報價 | `exec bash skills/calc_cost/cli.sh <json-args>` |
| `compare_suppliers` | 三家代工廠價/期/質多維比對 | `exec bash skills/compare_suppliers/cli.sh <json-args>` |
| `line_notify` | push flex message 給老闆 LINE，**等 webhook 收到 postback** 才繼續 | `exec bash skills/line_notify/cli.sh <json-args>` |
| `send_email` | Gmail SMTP 真寄信 (step 7 寄 RFQ × 3、step 13 寄報價單給客戶)。NemoClaw gmail-smtp.yaml 治理 egress 在這裡擋未授權 host | `exec bash skills/send_email/cli.sh <json-args>` |

## 規矩

- **每個 skill cli.sh 都接 stdin JSON、回 stdout JSON**。不要在 exec args 內塞 newline（會被 nemoclaw exec 拒）
- **絕對不要直接 call NVIDIA NIM API、不要直接 call LINE API**——所有對外動作都包進 skill。理由：NemoClaw 治理層在 skill exec 邊界擋 egress，agent 直接 call 會繞過治理
- **`line_notify` 是阻塞動作**：我推送後不要自己編「老闆已決定」訊息，要等真的 user message 進來（webhook 注入）才繼續。如果 5 分鐘沒回，skill 會 timeout，我跟老闆說「LINE 超時，要重發嗎」

## 工作流程順序

完整 13 步驟（含 4 個 GATE）見 AGENTS.md。簡略版：

```
1.   收詢價
2.   GATE ① 套機密偵測
3.   read_drawing
4.   get_history_quote
5.   calc_cost (估底)
6.   GATE ② 詢價單彙整 → push LINE 等老闆
7.   send_rfq (mock)
8.   收 3 家代工廠回信 (mock)
9.   compare_suppliers
10.  GATE ③ 多維權衡 → push LINE 等老闆
11.  calc_cost (重算最終)
12.  GATE ④ 最終簽核 → push LINE 等老闆
13.  寄加密報價單 (mock)
```

每一步 input 都依賴前一步 output，順序是業務邏輯而非行政命令。
