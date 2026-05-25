---
name: calc_cost
description: 依 BOM 7 行查 bom_cost_data.csv (26 行) 算單位成本 + 套 overhead 12% + tier markup → 建議單價。可選 surface_treatment_supplier_id 覆寫某行外購價（多維權衡用）。
metadata:
  openclaw:
    emoji: 💰
    os: [linux]
    requires:
      bins: [node, bash]
---

# calc_cost — 算成本 + 建議單價 skill

## 我什麼時候會用這個 skill

兩處：

1. **Step 5**（估底價）—— `read_drawing` 給 BOM 後立刻 call，用最便宜代工估底
2. **Step 11**（重算最終）—— 廖老闆在 GATE ③ 選了代工廠後，帶 `surface_treatment_supplier_id` 重新算

## 怎麼呼叫

```
exec bash skills/calc_cost/cli.sh
```

**stdin**：

```json
{
  "product_id": "Anti-Static Silicone Roller",
  "bom": [
    {"part_name": "Roller Core (Shaft)", "qty_per_unit": 1},
    {"part_name": "Anti-Static Silicone Cover", "qty_per_unit": 0.8},
    ...
  ],
  "qty": 200,
  "surface_treatment_supplier_id": "SUP-002",
  "customer_tier": "tier_A"
}
```

`surface_treatment_supplier_id` 可選——沒給就用最便宜估底。

**stdout**：

```json
{
  "unit_direct_cost_twd": 750.40,
  "unit_cost_with_overhead_twd": 840.45,
  "overhead_pct": 12,
  "markup_pct_applied": 32,
  "unit_cost_twd": 840.45,
  "suggested_unit_price_twd": 1109,
  "suggested_revenue_twd": 221800,
  "bom_breakdown": [...],
  "unknown_parts": [],
  "surface_treatment_supplier_used": null
}
```

## 規矩

- **單位都是台幣 TWD**，金額對廖老闆呈現時加千分位
- markup 表：tier_A=32% / tier_B=24% / tier_C=18%（從 demo 客戶輪廓推；不要 hallucinate）
- 若 `unknown_parts` 非空 → 跟廖老闆 flag 出來「這幾項 cost table 沒收錄，用 vendor-default $650 估」
- BOM 內每行 `qty_per_unit` 是「每支產品用幾單位」（kg / ml / 個）
