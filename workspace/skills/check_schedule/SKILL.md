---
name: check_schedule
description: 生管 (planner) — 查 GatherRoller 自家產線排程，算出「最快交期 N 天 vs 客戶要 X 天」+ gap_days + 是否達得到。讀 data/schedule.json (as_of 2026-05-25)。
metadata:
  openclaw:
    emoji: 📅
    os: [linux]
    requires:
      bins: [node, bash]
---

# check_schedule — 生管排程 skill

## 我什麼時候會用這個 skill

新詢價進來、`read_drawing` 抓到產品 + 數量後，我用這個 skill 算「**自家產線排得進嗎、最快幾天能交**」。

典型情境：

- 客戶要 10 天交，我先 call `check_schedule` 看自家最快幾天 → 通常會差 N 天 → 那 N 天差距要靠選最快代工廠或跟客戶談延期
- step 4 之後、step 5 (`calc_cost`) 之前用最合理
- step 11 重算成本前也可以再 call 一次 (帶老闆選的代工廠 lead time)

## 怎麼呼叫

```
exec bash skills/check_schedule/cli.sh
```

**stdin**：

```json
{
  "product_id": "Anti-Static Silicone Roller",
  "qty": 200,
  "customer_desired_lead_days": 10,
  "surface_treatment_lead_days": 4
}
```

`surface_treatment_lead_days` 可選——若不指定預設用最快代工 (4 天)；若已知廠商 (譬如老闆選了大同 4 天 / 全鋼 9 天) 就帶進去。

**stdout**：

```json
{
  "earliest_start_date": "2026-05-31",
  "days_to_earliest_start": 6,
  "purchase_steel_wheel_days": 3,
  "surface_treatment_days": 4,
  "in_house_pu_coating_days": 6,
  "qc_pack_days": 1,
  "total_lead_time_days": 20,
  "customer_desired_lead_days": 10,
  "gap_days": 10,
  "achievable": false,
  "note": "差 10 天 — 需要選最快代工廠或跟客戶談延期",
  "schedule_basis": {
    "as_of": "2026-05-25",
    "line": "包膠線 A",
    "current_backlog_units": 240,
    "next_window": "2026-05-31"
  }
}
```

## 規矩

- **as_of_date = `data/schedule.json` 的 `as_of_date`** (現在 = 2026-05-25)，不要用 `new Date()`——demo 要可重現
- **不要 hallucinate 排程數字**——全部從 `data/schedule.json` 讀
- 對廖老闆呈現 trade-off 時清楚講「差 N 天」+ 「靠選最快代工 (大同 4 天) 才有機會」+ 「不然要跟客戶談延期」
- `achievable: false` 不代表「不接這張單」，是「要 trade-off」——下一步 GATE ③ 多維權衡推老闆決定
