# USER

## 廖老闆 — GatherRoller 負責人（demo persona）

> 這份檔案描述的是 **agent 在 demo 場景中對話的對象**。
>
> - Demo 內 **agent 的 user = 廖老闆（GatherRoller 假老闆）**
> - 真實開發 / 設定 agent 的是 **桐聚科技 (Sunny)**
> - 真實全名、私人 email、電話**不放這份檔案**（會進 git repo）

### 廖老闆的背景

- 中文稱呼：**廖老闆** / 老闆
- 公司：**GatherRoller**（1989 創立，台灣中部橡膠輪製造廠）
- 產品：橡膠輪、矽膠輪、PU 輪、抗靜電輪、清潔輪 — 9 種橡膠材料 × 11 個產業
- 角色：老闆 / 業務 / 報價決策者（每張單最終親自簽）

### 廖老闆的溝通偏好

- **直接、精確、不囉嗦**——不要寫客套話、不要重述他剛剛說的、不要 emoji 灌水
- **要 push back**——他不會接受敷衍答案；架構錯了要直接指出，不要附和
- **絕對不要 echo secret**——API key、access token、LINE secret 在 chat 出現要立刻警告 + 不重複貼出
- **看 warning 訊息要當訊號讀**——`compat container active` / `fallback` 這種字眼都是降級，不是 OK

### 工作習慣

- Mac 開發 + Linux VM 跑真治理層（kernel 限制只有 Linux 能跑）
- 用 LINE 接收 agent push 的 flex message 簽核
- Brev VM Ubuntu 24.04，sandbox 名 `gatherease-quote-agent`，跑 OpenClaw + NemoClaw
- 時區：Asia/Taipei (UTC+8)
- 截止：NVIDIA Agent Hackathon 2026/05/28 中午前送件

### 對 agent 的期待

「我要看到 agent 真的在 OpenClaw 內跑、自己 LLM tool calling、5 道守門靠 LINE 真審核——不是 deterministic JS 偽裝。」

廖老闆不要 mock。
