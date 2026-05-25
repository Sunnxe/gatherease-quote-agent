---
name: get_history_quote
description: 對 10,000 筆 GatherRoller 歷史訂單做加權相似度比對 (name 40% / date 30% / spec 20% / hardness 10%)，回 top-K 相似單 + 加權平均單價建議。純函數、無 LLM、可重現。
metadata:
  openclaw:
    emoji: 🔍
    os: [linux]
    requires:
      bins: [node, bash]
---

# get_history_quote — 歷史相似比對 skill

## 我什麼時候會用這個 skill

13 步驟流程的 **step 4**——`read_drawing` 抓出產品規格後，立刻 call 我找歷史相似單。輸出給後面 `calc_cost` 做定價參考、給廖老闆看「這 5 張類似的訂單我們之前怎麼報的」。

## 怎麼呼叫

```
exec bash skills/get_history_quote/cli.sh
```

**stdin**：

```json
{
  "new_order": {
    "ProductName": "Anti-Static Silicone Roller",
    "OrderDate": "2026-05-25",
    "Hardness": 55,
    "Spec": "25*35*600"
  },
  "k": 5
}
```

**stdout**（重點欄位）：

```json
{
  "matches": [
    {"OrderID": 9819, "OrderDate": "2024-10-19", "ProductName": "Anti-Static Silicone Roller", "Hardness": 49, "Spec": "29*50*578", "score": 0.784},
    ...
  ],
  "weighted_avg_unit_price": null,
  "method": "weighted similarity: name 40% + date 30% + spec 20% + hardness 10%",
  "_meta": {"historical_orders_scanned": 10000, "elapsed_ms": 110}
}
```

## 規矩

- **絕對不要把 10000 筆全 dump** 到 chat，只看 top-K
- 對廖老闆呈現只挑前 3 條（「最相似 3 張歷史單」），剩下 log 帶過
- 算法是 deterministic—— same input 永遠 same output，可重現性對 audit 重要
