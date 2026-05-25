---
name: send_email
description: 用 Gmail SMTP 真寄信 (STARTTLS + AUTH LOGIN, native Node net+tls 零依賴)。step 7 寄 3 封 RFQ 給代工廠、step 13 寄報價單給客戶都用我。NemoClaw 治理 gmail-smtp.yaml egress 在這邊真的會擋未授權 host。
metadata:
  openclaw:
    emoji: 📧
    os: [linux]
    requires:
      bins: [node, bash]
      env: [GMAIL_USER, GMAIL_APP_PASSWORD]
---

# send_email — Gmail SMTP 真發信 skill

## 我什麼時候會用這個 skill

兩處：

1. **Step 7** — 廖老闆批准「發詢價」後，寄 3 封 RFQ 給 3 家代工廠（SUP-001/002/003）
2. **Step 13** — 廖老闆 GATE ④ 簽核後，寄加密報價單給客戶

## 怎麼呼叫

```
exec bash skills/send_email/cli.sh
```

**stdin**：

```json
{
  "to": "supplier-or-customer@example.com",
  "subject": "【RFQ】Anti-Static Silicone Roller × 200 詢價",
  "body": "您好，\n\n附件報價需求如下：\n  產品：Anti-Static Silicone Roller\n  數量：200 支\n  規格：25×35×600 mm\n  硬度：Shore A 55\n  交期：10 天\n  認證：ESD-S20.20\n\n請於 24 小時內回覆貴司報價、交期、是否可達抗靜電認證。\n\n桐聚科技 GatherEase\n（此信由 GatherEase AI agent 寄出，老闆已親自批准）"
}
```

`to` 可以是單一字串或 array（多收件人）。

**stdout**（成功）：

```json
{
  "status": "sent",
  "to": "supplier@example.com",
  "subject": "【RFQ】...",
  "from": "gatherease.demo@gmail.com",
  "message_id": "<XXX@smtp.gmail.com>",
  "sent_at": "2026-05-25T14:00:00.000Z",
  "smtp_log": "MAIL OK / RCPT OK / DATA OK / QUIT OK"
}
```

**stdout**（失敗）：exit 1，stderr 印 `[send_email] fatal: <reason>`

## NemoClaw 治理鏡頭（demo 影片金礦）

NemoClaw 的 `gmail-smtp.yaml` egress preset 允許 `smtp.gmail.com:587`。**對任何其他 SMTP host 連接 → kernel 層擋**。

Demo 可以拍：
- 我正常寄到 `smtp.gmail.com:587` → ✅ 信寄出去、收件人收到
- 我（假裝被 prompt injection）試寄到 `smtp.evil-host.example.com:587` → ❌ NemoClaw `BLOCKED: egress denied to evil-host`
- audit log 紀錄這次嘗試

## 規矩

- **`from` 永遠用 `GMAIL_USER` env var**——不要讓 user 偽造 sender，防 phishing 攻擊
- **不附件**（v1）—— demo 用純文字 body 講清楚產品需求即可
- **subject 用繁體中文 UTF-8 base64 encode**（RFC 2047 標準）
- **body 用 UTF-8 base64 encode**（避免 7-bit transport 問題）
- 收件人**只寄 `data/suppliers.json` 或 user 明確指定**的 email，不接受 LLM hallucinate
- 寄完寫 audit log 紀錄 `{to, subject, message_id}`

## 失敗處理

- Gmail 認證失敗（535 error）→ skill exit 1，跟廖老闆說「Gmail App Password 過期，請重發」
- SMTP timeout → retry 1 次，再失敗才報錯
- NemoClaw 擋下（連線拒絕）→ skill exit 1，stderr 印 `egress denied by NemoClaw policy`，這正是治理鏡頭
