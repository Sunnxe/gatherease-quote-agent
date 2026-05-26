---
name: order_store
description: 訂單 CRUD hub — 整筆詢價的 state 集中管理。所有 GATE 決定 / skill 輸出 / 廠商回信都掛在同一個 order_id 下，agent 不會混單。
metadata:
  openclaw:
    emoji: 📒
    os: [linux]
    requires:
      bins: [node, bash]
---

# order_store — 訂單追蹤 CRUD skill

## 為什麼需要這個

廖老闆同時可能有好幾張詢價單在跑（昕叡電子的 A1 + 鴻碩電子的 B2 + ...）。**沒有 order_id 綁定，agent 會把不同訂單的 BOM / 廠商回信 / 老闆決定混在一起，整個亂掉**。

所以每筆新詢價我先 `order_store create` 建一個 `QUO-YYYY-NNNN` order，**後續每個 skill call 都帶這個 order_id**，state 全部寫進這個 order JSON。

## Order lifecycle (status 流轉)

```
pending_quote          ← 剛收到 email，還沒處理
   ↓
analyzing              ← read_drawing / get_history / calc_cost 跑中
   ↓
awaiting_rfq_approval  ← 推 LINE GATE ② 等老闆批准發詢價
   ↓
rfq_sent               ← 真寄 RFQ 給 3 家代工廠
   ↓
awaiting_replies       ← 等廠商 email 回報價
   ↓
comparing              ← 3 家都回了，compare_suppliers 跑中
   ↓
awaiting_tradeoff      ← 推 LINE GATE ③ 等老闆選代工廠
   ↓
recalculating          ← calc_cost 重算
   ↓
awaiting_signoff       ← 推 LINE GATE ④ 等老闆簽
   ↓
quoted_sent            ← generate_quote_pdf + send_email 寄客戶完成
```

也有失敗終止狀態：`cancelled`、`secret_probe_blocked`。

## 怎麼呼叫

```
exec bash skills/order_store/cli.sh
```

**Action: create**

```json
{
  "action": "create",
  "customer": {
    "name": "昕叡電子有限公司 Shin Tech.",
    "contact_email": "sunnxebusiness@gmail.com"
  },
  "incoming": {
    "email_subject": "【詢價】矽膠抗靜電包膠輪 A1 × 200 支",
    "email_body": "...",
    "drawing_attachment_path": "data/incoming/QUO-2026-0001-drawing.pdf"
  }
}
```

→ stdout：完整 order JSON，含 auto-gen `order_id` (`QUO-2026-0001` 等)、`status: pending_quote`、`received_at: <ISO>`。

**Action: get**

```json
{ "action": "get", "order_id": "QUO-2026-0001" }
```

→ stdout：完整 order JSON。

**Action: update** (merge patch)

```json
{
  "action": "update",
  "order_id": "QUO-2026-0001",
  "patch": {
    "status": "analyzing",
    "engineering_read": { "product_name_en": "...", "bom": [...] }
  }
}
```

→ stdout：updated 完整 order JSON。

**Action: append_audit**

```json
{
  "action": "append_audit",
  "order_id": "QUO-2026-0001",
  "entry": {
    "level": "ALLOW",
    "gate": "gate-2-tradeoff-decision",
    "msg": "老闆選大同",
    "skill": "line_notify"
  }
}
```

→ stdout：updated 完整 order JSON (audit_trail 多一筆，ts 自動填)。

**Action: list**

```json
{ "action": "list", "status": "rfq_sent", "limit": 10 }
```

→ stdout：summary array `[{order_id, status, customer.name, received_at, updated_at}, ...]`。

## 規矩

- order_id 格式 `QUO-YYYY-NNNN`，年份從 received_at 取，NNNN 從 `data/orders/` 內掃當年最大 + 1
- 每次 update / append_audit 都自動更新 `updated_at`
- audit_trail 自動加 `ts`（呼叫時間），其他 field 由 caller 帶
- 寫檔用 atomic (寫 .tmp + rename)，避免 partial write
- **沒 order_id 不要 call 其他 skill** — 先 create 一個再說

## 怎麼用（LLM 操作模式）

新詢價進來：

```
1. order_store create → 拿到 order_id
2. read_drawing → 結果 → order_store update {engineering_read}
3. get_history_quote → 結果 → order_store update {history_matches}
4. check_schedule → 結果 → order_store update {schedule_check}
5. calc_cost → 結果 → order_store update {cost_baseline}
6. order_store update {status: "awaiting_rfq_approval"}
7. line_notify → push 老闆 → order_store append_audit {gate: "gate-pre-rfq"}
8. ... user 訊息「老闆已決定」進來 → 繼續
```

每步都「skill output → order_store update」grow order state，整個流程可追溯。
