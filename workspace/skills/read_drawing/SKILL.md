---
name: read_drawing
description: 真讀工程圖 PDF — PDF→PNG→Nemotron Vision API (meta/llama-3.2-90b-vision-instruct) 真視覺判讀，抓出尺寸 / 硬度 / 包膠材質 / 公差 / part number。Demo 影片金鏡頭。
metadata:
  openclaw:
    emoji: 📐
    os: [linux]
    requires:
      bins: [node, bash, pdftoppm]
      env: [NVIDIA_API_KEY]
---

# read_drawing — 工程圖視覺判讀 skill

## 我什麼時候會用這個 skill

inbox_watch 收到客戶 email 抓出 PDF 附件、或 user 在 chat 給我工程圖路徑 → 我 call read_drawing 真讀 PDF 抓規格。

這是 demo 影片**最關鍵的鏡頭**——觀眾要看到「AI 真讀工程圖」，不是文字推理。

## 怎麼呼叫

```
exec bash skills/read_drawing/cli.sh
```

**stdin**：

```json
{
  "order_id": "QUO-2026-0001",
  "drawing_pdf_path": "data/orders/QUO-2026-0001/incoming-drawing.pdf",
  "customer_name": "昕叡電子有限公司 Shin Tech."
}
```

**stdout**（vision 真讀後）：

```json
{
  "order_id": "QUO-2026-0001",
  "vision_used": true,
  "model": "meta/llama-3.2-90b-vision-instruct",
  "product_id": "矽膠抗靜電包膠輪 A1",
  "product_name_zh": "矽膠抗靜電包膠輪",
  "product_name_en": "Anti-Static Silicone Rubber Roller",
  "drawing_version": "A1",
  "industry_match": "PCB / Optoelectronic Panels",
  "specs": {
    "outer_diameter_mm": 50.0,
    "outer_diameter_tolerance": "+0.250 / -0.000",
    "coating_length_mm": 598,
    "shaft_total_length_mm": 732,
    "between_shaft_length_mm": 665,
    "coating_material": "矽膠",
    "hardness_shore_a": 40,
    "hardness_tolerance": "±5",
    "surface_finish_note": "去銳角、毛邊",
    "shaft_features": [
      {"label": "UC", "tolerance": "+0.080 / -0.000", "part_no": "PJD8963*MH820"},
      {"label": "RB", "tolerance": "+0.050 / -0.030", "part_no": "PJD0027*MH083"}
    ]
  },
  "bom": [
    {"part_name": "Roller Core (Shaft)", "source": "Vendor", "qty_per_unit": 1, "material_spec": "S45C Carbon Steel"},
    {"part_name": "Anti-Static Silicone Cover", "source": "InHouse", "qty_per_unit": 0.6, "material_spec": "矽膠 Shore A 40 ± 5"},
    {"part_name": "Adhesive (Bonding Agent)", "source": "InHouse", "qty_per_unit": 50},
    {"part_name": "End Caps", "source": "InHouse", "qty_per_unit": 2},
    {"part_name": "Bearings", "source": "InHouse", "qty_per_unit": 2},
    {"part_name": "Surface Finish (Grinding)", "source": "Outsource", "qty_per_unit": 1},
    {"part_name": "Packaging/Protection", "source": "InHouse", "qty_per_unit": 1}
  ],
  "quality_requirements": {
    "tolerance_mm": 0.05,
    "certifications_required": [],
    "anti_static_required": true
  },
  "confidence": 0.92,
  "notes": "...判讀理由"
}
```

## 兩段流程

```
[1] PDF → PNG (用 pdftoppm 第一頁 150 dpi)
       ↓
[2] PNG base64 → Nemotron Vision (llama-3.2-90b-vision-instruct via NIM)
       prompt: 嚴格 JSON output schema
       ↓
[3] parse + 合理性檢查 → stdout
```

## 規矩

- **vision API endpoint = `integrate.api.nvidia.com/v1/chat/completions`**，NemoClaw 已套 NVIDIA NIM egress preset
- **model = `meta/llama-3.2-90b-vision-instruct`**（Nemotron Super text-only，要用這個 vision 才能讀圖）
- PDF rasterize 用 `pdftoppm` (poppler-utils 內建 in 多數 Ubuntu sandbox)
- 失敗 fallback：vision API 不可達 → 用文字推理 mock + `confidence: 0.5`
- **不要 hallucinate part number** — 圖內看不清楚就回 `null` 不亂編
- 公差 (tolerance) 直接複製圖上文字，不要簡化

## 失敗處理

- `pdftoppm not found` → 提示 sandbox 內裝 poppler-utils
- vision API 4xx/5xx → fallback text-only mock，stderr log 警告
- PDF 不存在 → exit 1 + 報錯
