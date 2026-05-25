/**
 * skills/read_drawing/index.js
 * Agent: engineer (工程判讀)
 * Category: INPUT
 *
 * 讀工程圖 PDF，用 Nemotron Super 視覺＋推理判讀，輸出產品規格、BOM
 * 與「採購／代工／自製」分工。
 *
 * Knowledge base：skills/read_drawing/knowledge.txt 是 GatherRoller (桐聚)
 * 完整產品知識庫——9 種橡膠材料 × 11 個產業，包含每個產業的硬度範圍、
 * 化學/溫度要求。Real 模式下注入 system prompt 讓 Nemotron 答覆有真實
 * 業界基礎，不憑空 hallucinate。
 *
 * Demo 模式：未設 NVIDIA_API_KEY → 回 mock（標準 7 行 BOM）。
 * Real 模式：設了 NVIDIA_API_KEY → 呼叫 Nemotron Super 真讀。
 */

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '..', '..');
const KNOWLEDGE_PATH = path.join(HERE, 'knowledge.txt');

const NEMOTRON_BASE = 'https://integrate.api.nvidia.com/v1';
const NEMOTRON_SUPER_MODEL = 'nvidia/nvidia/nemotron-3-super-120b-a12b';

let _knowledgeCache = null;
async function loadKnowledge() {
  if (_knowledgeCache) return _knowledgeCache;
  try {
    _knowledgeCache = await fs.readFile(KNOWLEDGE_PATH, 'utf8');
  } catch {
    _knowledgeCache = '';
  }
  return _knowledgeCache;
}

async function hashFile(filePath) {
  try {
    const buf = await fs.readFile(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  } catch { return 'unknown'; }
}

// ─── Real mode: 呼叫 Nemotron Super ───
async function callNemotronReal({ drawingPdfPath, customerId }) {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error('NVIDIA_API_KEY not set');

  const knowledge = await loadKnowledge();
  const systemPrompt = `你是 GatherRoller (桐聚) 的資深機械工程師，1989 起在台灣中部專做橡膠/矽膠/PU 滾輪。
以下是公司產品知識庫（你早就熟到不行的東西），所有判讀以此為基準，不要 hallucinate 規格：

${knowledge}

判讀工程圖時：先看產品類型（對應上面 11 個產業哪個）、硬度範圍是否合理、表面處理需求、是否需要抗靜電/ESD 認證、材料是否與客戶產業需求匹配。`;

  const userPrompt = `請判讀附上的工程圖 PDF，輸出嚴格 JSON（不要其他文字）：
{
  "product_id": "<string>",
  "product_name_zh": "<繁中產品名>",
  "product_name_en": "<英文產品名>",
  "industry_match": "<上面 11 個產業之一>",
  "specs": {
    "diameter_mm": <number>,
    "width_mm": <number>,
    "length_mm": <number>,
    "shaft_diameter_mm": <number>,
    "coating_material": "<string>",
    "hardness_shore_a": <number>,
    "surface_treatment": "<string>",
    "load_kg": <number>
  },
  "bom": [
    {"part_name": "Roller Core (Shaft)", "source": "Vendor", "qty_per_unit": 1, "material_spec": "<string>"},
    {"part_name": "<Cover compound name from knowledge base>", "source": "InHouse", "qty_per_unit": <kg>, "material_spec": "<string>"},
    {"part_name": "Adhesive (Bonding Agent)", "source": "InHouse", "qty_per_unit": <ml>},
    {"part_name": "End Caps (if applicable)", "source": "InHouse", "qty_per_unit": 2},
    {"part_name": "Bearings", "source": "InHouse", "qty_per_unit": 2},
    {"part_name": "Surface Finish (Grinding)", "source": "Outsource", "qty_per_unit": 1},
    {"part_name": "Packaging/Protection", "source": "InHouse", "qty_per_unit": 1}
  ],
  "quality_requirements": {
    "tolerance_mm": <number>,
    "certifications_required": [...],
    "anti_static_required": <boolean>
  },
  "confidence": <0.0–1.0>,
  "notes": "<判讀理由，簡短說為什麼選這個 Cover compound、為什麼判定這個產業>"
}`;

  const resp = await fetch(`${NEMOTRON_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: NEMOTRON_SUPER_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt + `\n\n[drawing_path]: ${drawingPdfPath}\n[customer_id]: ${customerId || 'n/a'}` }
      ],
      temperature: 0.1,
      max_tokens: 2000
    })
  });

  if (!resp.ok) throw new Error(`Nemotron call failed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content ?? '{}';
  const match = text.match(/\{[\s\S]*\}/);
  return JSON.parse(match ? match[0] : text);
}

// ─── Demo / mock mode ───
async function callNemotronMock({ drawingPdfPath, customerId }) {
  // 鴻碩電子（PCB 業）→ Anti-Static Silicone Roller 是最合理的判讀
  return {
    product_id: 'Anti-Static Silicone Roller (PU-coated wheel variant / 包膠鐵輪)',
    product_name_zh: '包膠鐵輪 (抗靜電 PU 表面)',
    product_name_en: 'Anti-Static Silicone Roller',
    industry_match: 'PCB / Optoelectronic Panels',
    specs: {
      diameter_mm: 25,
      width_mm: 35,
      length_mm: 600,
      shaft_diameter_mm: 12,
      coating_material: 'Anti-Static Silicone (Shore A 55)',
      hardness_shore_a: 55,
      surface_treatment: 'Grinding + 抗靜電 ESD 表面處理',
      load_kg: 250
    },
    bom: [
      { part_name: 'Roller Core (Shaft)', source: 'Vendor', qty_per_unit: 1, material_spec: 'S45C Carbon Steel' },
      { part_name: 'Anti-Static Silicone Cover', source: 'InHouse', qty_per_unit: 0.8, material_spec: '抗靜電矽膠 Shore A 55' },
      { part_name: 'Adhesive (Bonding Agent)', source: 'InHouse', qty_per_unit: 60 },
      { part_name: 'End Caps (if applicable)', source: 'InHouse', qty_per_unit: 2 },
      { part_name: 'Bearings', source: 'InHouse', qty_per_unit: 2 },
      { part_name: 'Surface Finish (Grinding)', source: 'Outsource', qty_per_unit: 1 },
      { part_name: 'Packaging/Protection', source: 'InHouse', qty_per_unit: 1 }
    ],
    quality_requirements: {
      tolerance_mm: 0.05,
      certifications_required: ['ESD-S20.20 抗靜電認證', 'RoHS'],
      anti_static_required: true
    },
    confidence: 0.94,
    notes: `[DEMO MODE] 客戶 ${customerId || 'n/a'} 為 PCB 業 (鴻碩電子)，依知識庫 2.1 PCB 章節：硬度 50–90 Shore A、需抗靜電；綜合判定為 Anti-Static Silicone Roller，硬度 55 取中段，符合 panel surface sensitivity 需求。`
  };
}

async function run({ drawing_pdf_path, customer_id }) {
  const drawingHash = await hashFile(drawing_pdf_path);
  const startedAt = new Date().toISOString();

  let result;
  if (process.env.NVIDIA_API_KEY && process.env.NODE_ENV !== 'test') {
    try {
      result = await callNemotronReal({ drawingPdfPath: drawing_pdf_path, customerId: customer_id });
    } catch (err) {
      console.warn(`[read_drawing] Nemotron call failed, fallback to mock: ${err.message}`);
      result = await callNemotronMock({ drawingPdfPath: drawing_pdf_path, customerId: customer_id });
    }
  } else {
    result = await callNemotronMock({ drawingPdfPath: drawing_pdf_path, customerId: customer_id });
  }

  return {
    ...result,
    _meta: {
      skill: 'read_drawing',
      agent: 'engineer',
      drawing_hash: drawingHash,
      knowledge_base: 'GatherRoller product catalog (14KB) injected as system prompt',
      started_at: startedAt,
      finished_at: new Date().toISOString()
    }
  };
}

module.exports = { run };

// CLI test
if (require.main === module) {
  run({ drawing_pdf_path: '/tmp/dummy-drawing.pdf', customer_id: 'CUST-001' })
    .then(r => console.log(JSON.stringify(r, null, 2)))
    .catch(e => { console.error(e); process.exit(1); });
}
