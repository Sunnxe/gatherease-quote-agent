---
name: compare_suppliers
description: 3 家代工廠價/期/質多維比對 + 評分 + 推薦。讀 ./data/suppliers.json，套客戶 max_surface_treatment_days + requires_anti_static 約束，回每家是否達標、各自分數、AI 推薦選哪家 + 理由。
metadata:
  openclaw:
    emoji: ⚖️
    os: [linux]
    requires:
      bins: [node, bash]
---

# compare_suppliers — 三家代工廠比價 skill

## 我什麼時候會用這個 skill

**情境 C 步驟 3**——廖老闆批准發詢價、3 家代工廠都回信後，我 call 這個 skill 整理「價 / 期 / 質」三維 + 算分排名 + 給 AI 推薦，輸出給 GATE ② 多維權衡 push LINE 給廖老闆。

Demo 內：3 家代工廠（全鋼表處 / 大同精密表面 / 順興電鍍工業）的回信是 mock 在 `data/suppliers.json`，我直接讀檔不真寄 RFQ。

## 怎麼呼叫

```
exec bash skills/compare_suppliers/cli.sh
```

**stdin**：

```json
{
  "supplier_ids": ["SUP-001", "SUP-002", "SUP-003"],
  "customer_requirements": {
    "max_surface_treatment_days": 5,
    "requires_anti_static": true
  }
}
```

**stdout**（v3 — score / ranked / recommendation + **AI 業務策略 strategies**）：

```json
{
  "candidates": [ ... 原始 3 家 raw data ... ],
  "ranked": [
    {
      "supplier_id": "SUP-002", "name": "大同精密表面",
      "price_twd": 420, "lead_time_days": 4, "yield_rate_pct": 99,
      "anti_static": true, "certifications": ["ISO 9001", "抗靜電 ESD-S20.20"],
      "meets_lead_time": true, "meets_quality": true,
      "score": 95.2,
      "score_breakdown": {"price": 26.7, "lead": 35.0, "yield": 19.8, "cert": 10.0},
      "key_reasons": [
        "⚠️ 價格比最低貴 31%",
        "✅ 交期最短",
        "✅ 有抗靜電認證（符合客戶硬性需求）",
        "✅ 良率高（99%）"
      ],
      "disqualified": false
    },
    { "supplier_id": "SUP-003", "name": "順興電鍍工業", "score": 60.5, ... },
    { "supplier_id": "SUP-001", "name": "全鋼表處", "score": 0, "disqualified": true,
      "disqualified_reason": "客戶要求抗靜電認證，但該供應商無此認證" }
  ],
  "recommendation": {
    "supplier_id": "SUP-002",
    "name": "大同精密表面",
    "score": 95.2,
    "headline": "建議選 大同精密表面（綜合分數 95.2）",
    "one_liner": "✅ 交期最短、✅ 有抗靜電認證（符合客戶硬性需求）",
    "key_reasons": [ ... ]
  },
  "trade_off_table": "🏆 大同精密表面：$420/件、4天、良率99%、ESD✓（分數 91.5）\n❌ 全鋼表處：$320/件、9天、良率95%、ESD✗（分數 0）\n❌ 順興電鍍工業：$370/件、7天、良率97%、ESD✗（分數 0）",

  "strategies": [
    {
      "id": "negotiate_quality_relaxation",
      "type": "customer_negotiation",
      "priority": 1,
      "short_label": "跟客戶談放寬 ESD，改用順興電鍍工業省 12%",
      "headline": "💡 AI 策略：跟客戶談放寬 ESD 認證要求",
      "rationale": "客戶要求 ESD 認證讓選項只剩 大同精密表面（$420/件）。若客戶 ESD 非硬性，改用 順興電鍍工業...\n• 單件省 NT$50（12%）\n• 200 隻總省 NT$10,000\n• 多 3 天\n• 仍有 ISO 9001、良率 97%\n\n建議話術：「ESD 規格主要影響 X 製程，能否確認貴司產線是否真需要？...」",
      "action": "reply_customer_with_negotiation",
      "alternative_supplier_id": "SUP-003",
      "alternative_supplier_name": "順興電鍍工業",
      "estimated_unit_savings_twd": 50,
      "estimated_total_savings_twd": 10000,
      "estimated_savings_pct": 12,
      "lead_time_delta_days": 3
    }
  ]
}
```

## AI 策略類型（生成邏輯）

skill 會自動算出 0~N 個策略，**agent 取 `strategies[0]` 當 LINE 第三個 option**：

| ID | 觸發條件 | 對應動作 |
|---|---|---|
| `negotiate_quality_relaxation` | 客戶 requires_anti_static 把便宜廠 disqualify | 跟客戶協商放寬規格 → 解鎖更便宜廠 |
| `negotiate_lead_extension` | qualified 中有「比 winner 慢但便宜」的廠 | 跟客戶談延 N 天交期 → 換更便宜 |
| `negotiate_price_down` | winner 比最低貴 15%+ 且沒其他選項 | 跟 winner 議價、出最低報價當談判籌碼 |

**為什麼是 wow point**：AI 不是死板比較數字，是像資深業務一樣看出「主動跟客戶談規格 / 交期 → 解鎖更划算的方案」。skill 還會附**建議話術**老闆可以直接照唸（或 agent 用 LLM 改寫成商業 email）。

## 評分公式

對未 disqualify 的供應商（meets_quality = true 才算）：

```
score = 35 * (min_price / supplier_price)        # 價格（越低分越高）
      + 35 * (min_lead  / supplier_lead_days)    # 交期（越短分越高）
      + 20 * (yield_rate_pct / 100)              # 良率
      + 10 * (has_cert ? 1 : 0.5)                # 認證加分
```

**Disqualify 條件**：客戶 `requires_anti_static: true` 但供應商沒抗靜電認證 → score = 0、排到 ranked 最後。

## 規矩

- **AI 可以推薦，但老闆做最終決定**：skill 給 `recommendation`（最高分那家），agent 把 `ranked[0]` / `ranked[1]` 動態填到 LINE options，不要寫死「選大同」這種 supplier name。
- **trade-off table 直接給老闆看**：包含所有 3 家的分數 + 標籤（🏆 推薦 / ❌ disqualified），讓老闆理解 AI 為何這樣推薦。
- **disqualified 也要顯示**：不要直接過濾掉，老闆需要知道「為什麼全鋼沒被選」。
- **可重現**：scoring 是 deterministic 公式，NemoClaw audit log 可重跑、不黑盒。
