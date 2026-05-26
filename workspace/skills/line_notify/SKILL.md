---
name: line_notify
description: 推 NVIDIA-green flex message 到廖老闆 LINE 簽核 (5 道守門共用)。push 完立刻 return，agent 接著在 chat 等 user message「老闆已決定 hold_id=xxx choice=N action=...」進來才繼續。
metadata:
  openclaw:
    emoji: 📱
    os: [linux]
    requires:
      bins: [node, bash, curl]
    # LINE_CHANNEL_ACCESS_TOKEN + LINE_BOSS_USER_ID 由 cli.sh 從 workspace/.env source
---

# line_notify — 推 LINE flex 給廖老闆 + 等回覆 skill

## 我什麼時候會用這個 skill

**4 個 HOLD 點都用**：

- **GATE ①** `gate-1-secret-probe` — 客戶來信疑似套機密
- **GATE ②** `gate-pre-rfq` — 詢價單彙整，要不要發給 3 家代工廠
- **GATE ③** `gate-2-tradeoff-decision` — 多維權衡（價 / 期 / 質）選代工廠
- **GATE ④** `gate-3-final-quote-signoff` — 最終簽核寄出

## 怎麼呼叫

```
exec bash skills/line_notify/cli.sh
```

**stdin**：

```json
{
  "hold_id": "gate-pre-rfq-1779710149728-sshwmt",
  "gate": "gate-pre-rfq",
  "summary": "📋 詢價單彙整\n客戶：鴻碩電子 · ...",
  "options": ["發詢價", "修改名單", "取消"]
}
```

**stdout**（立刻 return，**不阻塞等老闆按按鈕**）：

```json
{
  "status": "pushed",
  "hold_id": "gate-pre-rfq-1779710149728-sshwmt",
  "gate": "gate-pre-rfq",
  "pushed_to_userid": "Ue07a...",
  "pushed_at": "2026-05-25T13:00:00.000Z",
  "waiting_for": "boss to tap a button on LINE flex; agent should wait for next user message «老闆已決定 hold_id=xxx choice=N action=...»"
}
```

## 行為流程（**關鍵：我推完不阻塞**）

```
我 (agent)              line_notify skill          LINE                老闆手機             webhook server          注入器
   │                          │                     │                     │                       │                    │
   ├─ call line_notify ──────►│                     │                     │                       │                    │
   │                          ├─ POST flex ────────►│                     │                       │                    │
   │                          │                     ├─ 推 flex msg ──────►│                       │                    │
   │                          ├◄ pushed             │                     │                       │                    │
   │◄─ stdout: {status:pushed}┤                     │                     │                       │                    │
   │                                                                       │                       │                    │
   ├─ 我跟 user 講「已推送給廖老闆，等回覆中...」                          │                       │                    │
   ├─ (sleep / pause for next user message)                                │                       │                    │
   │                                                                       │                       │                    │
   │                                                  ┌─ 廖老闆按「發詢價」                       │                    │
   │                                                  └─ LINE postback ──►├─ POST /webhook/line  │                    │
   │                                                                       │                       │                    │
   │                                                                       ├─ exec openclaw agent -m "..." ──►│        │
   │                                                                                               │                    │
   │◄── 新 user message: "老闆已決定 hold_id=xxx choice=0 action=發詢價" ─────────────────────────┤                    │
   │                                                                                                                    │
   ├─ 我看到訊息 → 知道該繼續下一個 step                                                                                  │
```

**我推完後在 chat 不要編老闆回什麼**——等真的 user message 進來才動。

## 規矩

- push 失敗（LINE API 4xx/5xx）→ skill exit 1，我跟 user 講「LINE 推送失敗，要重試嗎？」
- 5 分鐘還沒等到老闆回 → 我主動 send 一句「老闆是不是在忙？要重新推一次嗎？」
- **不要自己編內容**——summary 是 user 給我的，options 也是
- summary 用繁體中文 + 對應 emoji（📋⚖️✍️🚨📐），符合廖老闆視覺習慣
- altText 最多 80 字（LINE flex 限制），我會自動截
