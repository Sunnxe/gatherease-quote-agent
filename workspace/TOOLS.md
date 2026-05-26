# TOOLS

我有的 OpenClaw 內建 tools + 桐聚 workspace skill (10 個)。

## OpenClaw 內建 tools

來自 `tools.profile: "coding"`（group:runtime + group:fs + group:web + group:sessions + group:memory）。

| Tool | 用途 |
|---|---|
| `exec` | 跑 shell command（`bash` 是它的 alias）。我大多數動作（call skill / 讀 data file）都透過 `exec` 觸發對應 `cli.sh` |
| `read` | 讀 workspace 內檔案 |
| `write` | 寫檔案 (audit log / 中間狀態) |
| `edit` | 改檔案某個區段 |
| `apply_patch` | 對檔案套 diff patch |

## 桐聚 workspace skills (10 個)

每個 skill 在 `{baseDir}/skills/<name>/`，內含 `SKILL.md` + `cli.sh` + `impl.js` + 可能的 `data/` 或 `node_modules/`。

| Skill | 角色 | 觸發指令 | 何時用 |
|---|---|---|---|
| `order_store` | 📒 state CRUD | `exec bash skills/order_store/cli.sh` | 每筆新詢價 create；每個 skill output 後 update；GATE 後 append_audit |
| `inbox_watch` | 📥 收信 | `exec bash skills/inbox_watch/cli.sh` | poll s778906@gmail.com 收新詢價 / 廠商回信，解析 PDF |
| `read_drawing` | 📐 工程 | `exec bash skills/read_drawing/cli.sh` | inbox_watch 抓到 PDF 後，vision 真讀規格 / BOM |
| `get_history_quote` | 🔍 報價助理 | `exec bash skills/get_history_quote/cli.sh` | 10k 歷史訂單加權 similarity 找 top-5 |
| `check_schedule` | 📅 生管 | `exec bash skills/check_schedule/cli.sh` | 算自家產線最快交期 vs 客戶要的差 |
| `calc_cost` | 💰 報價員 | `exec bash skills/calc_cost/cli.sh` | BOM × cost_data × overhead 12% + tier markup |
| `compare_suppliers` | ⚖️ 比較 | `exec bash skills/compare_suppliers/cli.sh` | 3 家代工廠多維比對 (價/期/質) |
| `line_notify` | 📱 LINE | `exec bash skills/line_notify/cli.sh` | 4 個 GATE 推老闆 LINE，**非阻塞**等回覆 |
| `send_email` | 📧 寄信 | `exec bash skills/send_email/cli.sh` | Gmail SMTP 真寄 (支援 PDF 附件) |
| `generate_quote_pdf` | 📄 出文件 | `exec bash skills/generate_quote_pdf/cli.sh` | 老闆簽核後產生報價單 PDF |

## 規矩

- **每個 skill cli.sh 都接 stdin JSON、回 stdout JSON**，沒有 newline 在 exec args
- **絕對不要直接 call NVIDIA NIM / LINE / Gmail API** — 一律透過 skill。理由：NemoClaw 治理層在 skill exec 邊界擋 egress，agent 繞過 skill 直接 call 會破壞治理
- **每個 skill call 都帶 `order_id`**（除了 `inbox_watch poll` 跟 `order_store create`）
- **line_notify push 完不阻塞** — 我等下個 user message 進來才繼續（webhook 注入「老闆已決定 hold_id=xxx choice=N」）
- **lazy install dep**：`inbox_watch` 首次跑會 install imapflow + mailparser + pdf-parse@1.1.1（~10s）；`generate_quote_pdf` 首次裝 pdfkit（~5s）。後續呼叫秒回。

## 業務情境 → 觸發順序

詳細看 `AGENTS.md`，這裡簡略：

```
新詢價 (inbox_watch 或 user chat)
  → order_store create
  → read_drawing (vision PDF)
  → get_history_quote
  → check_schedule
  → calc_cost (估底)
  → line_notify GATE② → 等老闆批准發詢價
  → send_email RFQ × 3 → 廠商
  → inbox_watch poll 廠商回信 (loop)
  → compare_suppliers
  → line_notify GATE③ → 等老闆權衡
  → calc_cost (重算最終)
  → line_notify GATE④ → 等老闆簽
  → generate_quote_pdf
  → send_email 報價單 → 客戶
```

額外 GATE①：客戶套機密偵測，read_drawing 後檢查 email body / PDF text 有沒有套機密語句 → push GATE① 警告。
