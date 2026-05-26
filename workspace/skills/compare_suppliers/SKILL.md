---
name: compare_suppliers
description: 3 家代工廠價/期/質多維比對。讀 ./data/suppliers.json，套客戶 max_surface_treatment_days + requires_anti_static 約束，回每家是否達標。
metadata:
  openclaw:
    emoji: ⚖️
    os: [linux]
    requires:
      bins: [node, bash]
---

# compare_suppliers — 三家代工廠比價 skill

## 我什麼時候會用這個 skill

**Step 9**——廖老闆批准發詢價、3 家代工廠回信後，我 call 我這個 skill 整理「價 / 期 / 質」三個維度，輸出給 GATE ③ 多維權衡 push LINE 給廖老闆決定。

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

**stdout**：

```json
[
  {
    "supplier_id": "SUP-001", "name": "全鋼表處",
    "price_twd": 320, "lead_time_days": 9,
    "yield_rate_pct": 92, "anti_static": false,
    "certifications": ["ISO-9001"],
    "meets_lead_time": false, "meets_quality": false,
    "notes": "..."
  },
  ...
]
```

## 規矩

- `meets_lead_time` = `lead_time_days <= max_surface_treatment_days`
- `meets_quality` = `!requires_anti_static || anti_static`
- 給廖老闆呈現時用表格：3 家 × 4 欄（價 / 期 / 認證 / 結論）
- 不要自己幫廖老闆判斷「選哪家」——只算 meet/no-meet，**讓老闆按按鈕決定**
