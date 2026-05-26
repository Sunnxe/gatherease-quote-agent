---
name: inbox_watch
description: IMAP 抓 GatherRoller 信箱 (s778906@gmail.com) 未讀信。客戶詢價 + 廠商報價 PDF 附件都從這裡進。解析 multipart MIME → 抓 PDF → 用 pdf-parse 取文字 → regex heuristic 抓單價/交期/認證。
metadata:
  openclaw:
    emoji: 📥
    os: [linux]
    requires:
      bins: [node, bash]
    # GMAIL_USER + GMAIL_APP_PASSWORD 由 cli.sh 從 workspace/.env source
---

# inbox_watch — IMAP 收信 + PDF 解析 skill

## 我什麼時候會用這個 skill

兩個觸發點：

1. **新詢價偵測**：cron 或 user 主動 trigger，poll inbox 抓未讀客戶信。若 subject 含「詢價 / RFQ / Quote Request」+ 有 PDF 附件 → 視為新詢價，先 `order_store create` 再 call `read_drawing`。
2. **廠商報價回信**：寄完 RFQ 後 user 觸發或定期 poll，抓未讀廠商信。從 sender email 比對 `suppliers.json` 拿到 supplier_id，解析 PDF 報價內容，append 到 order 的 `supplier_replies`。

## 怎麼呼叫

```
exec bash skills/inbox_watch/cli.sh
```

**stdin**：

```json
{
  "action": "poll",
  "mode": "supplier_reply",
  "order_id": "QUO-2026-0001",
  "sender_contains": "supplier-",
  "max_messages": 10,
  "mark_seen": true,
  "save_attachments_to": "data/orders/QUO-2026-0001/incoming"
}
```

`mode`:
- `"new_inquiry"`: 抓客戶詢價（subject 含「詢價/Quote」，有 PDF 工程圖附件）
- `"supplier_reply"`: 抓廠商回信（sender 含 `supplier-` 或來自 suppliers.json email）
- `"any"`: 全抓

**stdout**：

```json
{
  "fetched_count": 3,
  "saved_attachments": [
    "data/orders/QUO-2026-0001/incoming/yongjia-quote.pdf",
    "data/orders/QUO-2026-0001/incoming/quan-gang-quote.pdf",
    "data/orders/QUO-2026-0001/incoming/shin-liu-quote.pdf"
  ],
  "messages": [
    {
      "uid": 1234,
      "from": "黃經理 <supplier-yongjia@test-gatherease.example>",
      "from_email": "supplier-yongjia@test-gatherease.example",
      "subject": "Re: 【RFQ】矽膠抗靜電包膠輪 A1 × 200 支",
      "received_at": "2026-05-26T01:30:00.000Z",
      "matched_supplier": { "id": "SUP-002", "name": "大同精密表面" },
      "attachments": [
        {
          "filename": "yongjia-quote.pdf",
          "saved_path": "data/orders/QUO-2026-0001/incoming/yongjia-quote.pdf",
          "size_bytes": 18432,
          "extracted_text_preview": "報價單 大同精密表面 ..."
        }
      ],
      "extracted": {
        "unit_price_twd": 420,
        "lead_days": 4,
        "moq": 30,
        "currency": "TWD",
        "certifications_mentioned": ["ESD-S20.20", "ISO 9001"],
        "anti_static_capable": true
      }
    }
  ]
}
```

## Heuristic 抓欄位 (從 PDF 文字)

| 欄位 | regex / 規則 |
|---|---|
| `unit_price_twd` | `NT\$\s*([\d,]+)` 或 `單價.*?([\d,]+)` 或 `unit price.*?([\d,]+)` |
| `lead_days` | `(\d+)\s*(?:天|days|工作天)` |
| `moq` | `MOQ\s*[:=]?\s*(\d+)` |
| `certifications_mentioned` | 找 keywords: `ESD-S20.20` / `ISO 9001` / `RoHS` 等 |
| `anti_static_capable` | text 含「抗靜電」/「anti-static」/「ESD」→ true |

抓不到的欄位回 `null`，**不要 hallucinate**。

## 規矩

- 連 imap.gmail.com:993 用 TLS direct (不是 STARTTLS)。NemoClaw gmail-imap.yaml policy 已允許
- `mark_seen: true` 後該信下次不會再被抓——避免重複處理
- PDF attachment 存到 `save_attachments_to`（自動 mkdir）
- 一封信多附件 → 全部存 + 全部 extract
- sender email 對應 `data/suppliers.json` 找 matched_supplier；找不到回 null
- 大附件 (>5 MB) 仍存但 stderr 警告（PDF 解析慢）
- 第一次跑會 lazy install `imapflow` + `mailparser` + `pdf-parse` 三個 npm package (~10s)

## 失敗處理

- IMAP 認證失敗 (535) → exit 1，提示檢查 GMAIL_USER / GMAIL_APP_PASSWORD
- IMAP timeout → retry 1 次再失敗
- PDF parse error → 仍存檔，extracted 設 null，stderr 警告
- 沒未讀信 → 正常 return `{fetched_count: 0, messages: []}`
