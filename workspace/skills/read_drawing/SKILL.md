---
name: read_drawing
description: 讀工程圖 PDF + 客戶背景 → 推斷產品規格 / BOM 7 行 (Vendor/InHouse/Outsource) / 信心分數。GatherRoller 工程判讀 agent。
metadata:
  openclaw:
    emoji: 📐
    os: [linux]
    requires:
      bins: [node, bash]
      env: [NVIDIA_API_KEY]
---

# read_drawing — 工程判讀 skill

## 我什麼時候會用這個 skill

**任何時候 user 給我「客戶詢價」**——包含產品描述、規格、硬度、數量、交期——我就要 call 這個 skill 把客戶要的東西轉成具體 BOM。

這是 13 步驟流程的 **step 3**，所有後續 step（找歷史、估成本、發詢價）都依賴它的輸出。

## 怎麼呼叫

```
exec bash skills/read_drawing/cli.sh
```

**stdin** 傳 JSON：

```json
{
  "drawing_pdf_path": "/sandbox/.openclaw/workspace/data/dummy-drawing-鴻碩-anti-static.pdf",
  "customer_id": "CUST-001",
  "product_request": "Anti-Static Silicone Roller (PCB 用)",
  "spec": "25*35*600",
  "hardness": 55
}
```

**stdout** 拿 JSON：

```json
{
  "product_id": "Anti-Static Silicone Roller (PU-coated wheel variant / 包膠鐵輪)",
  "product_name_zh": "包膠鐵輪 (抗靜電 PU 表面)",
  "product_name_en": "Anti-Static Silicone Roller",
  "industry_match": "PCB / Optoelectronic Panels",
  "specs": {
    "diameter_mm": 25, "width_mm": 35, "length_mm": 600,
    "shaft_diameter_mm": 12, "coating_material": "Anti-Static Silicone (Shore A 55)",
    "hardness_shore_a": 55,
    "surface_treatment": "Grinding + 抗靜電 ESD 表面處理",
    "load_kg": 250
  },
  "bom": [
    {"part_name": "Roller Core (Shaft)", "source": "Vendor", "qty_per_unit": 1, "material_spec": "S45C Carbon Steel"},
    {"part_name": "Anti-Static Silicone Cover", "source": "InHouse", "qty_per_unit": 0.8, "material_spec": "抗靜電矽膠 Shore A 55"},
    {"part_name": "Adhesive (Bonding Agent)", "source": "InHouse", "qty_per_unit": 60},
    {"part_name": "End Caps", "source": "InHouse", "qty_per_unit": 2},
    {"part_name": "Bearings", "source": "InHouse", "qty_per_unit": 2},
    {"part_name": "Surface Finish (Grinding)", "source": "Outsource", "qty_per_unit": 1},
    {"part_name": "Packaging/Protection", "source": "InHouse", "qty_per_unit": 1}
  ],
  "quality_requirements": {
    "tolerance_mm": 0.05,
    "certifications_required": ["ESD-S20.20 抗靜電認證", "RoHS"],
    "anti_static_required": true
  },
  "confidence": 0.94,
  "notes": "..."
}
```

## 重要說明：不是視覺真讀 PDF

**Real 模式**：skill 真的 call NVIDIA Nemotron Super 120B，但**輸入是文字**（customer_id + drawing_pdf_path 字串 + 14KB GatherRoller knowledge.txt），**不是 vision 真讀 PDF**。Nemotron 根據 knowledge.txt 內 11 個產業章節（PCB / 光電 / 印刷等）對應客戶背景，文字推理出 BOM 跟規格。

Demo 用合成 customer / product 配對（鴻碩電子 → PCB → Anti-Static Silicone Roller），輸出穩定可重現。

**Demo 模式**（無 NVIDIA_API_KEY 時）：直接回 hardcode JSON。

## 失敗處理

- exit code != 0 → 我 catch，跟 user 說「讀圖失敗，請確認 drawing_pdf_path 或重試」
- 輸出不是 valid JSON → 同上
- Nemotron API 回 4xx/5xx → impl.js 內 fallback 到 mock，stderr log 警告

## 我絕對不會做

- 把 knowledge.txt 內容 dump 到 chat（14KB 太大、不必要）
- 自己編規格（譬如客戶沒指定材料，我**不要** hallucinate「Shore A 70」之類數字，要回 confidence 低 + 主動列「需要釐清的點」給廖老闆）
