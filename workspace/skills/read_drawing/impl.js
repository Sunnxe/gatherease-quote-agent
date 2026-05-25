#!/usr/bin/env node
/**
 * skills/read_drawing/impl.js  (OpenClaw skill version)
 *
 * 讀 stdin JSON {drawing_pdf_path, customer_id, product_request, spec, hardness}
 * 寫 stdout JSON 規格 + BOM 7 行分工 + 信心
 *
 * Real mode (NVIDIA_API_KEY 設了) → call Nemotron Super 文字推理
 * Demo mode → hardcode JSON
 *
 * Knowledge base: ./knowledge.txt (跟 skill 同 dir)
 */

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const SKILL_DIR = __dirname;
const KNOWLEDGE_PATH = path.join(SKILL_DIR, 'knowledge.txt');

const NEMOTRON_BASE = 'https://integrate.api.nvidia.com/v1';
// 注意 model name 只有一個 nvidia/ — 多打會 404
const NEMOTRON_SUPER_MODEL = 'nvidia/nemotron-3-super-120b-a12b';

// ─── 讀 stdin JSON ───
async function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { buf += chunk; });
    process.stdin.on('end', () => {
      try {
        resolve(buf.trim() ? JSON.parse(buf) : {});
      } catch (e) {
        reject(new Error(`stdin not valid JSON: ${e.message}`));
      }
    });
    process.stdin.on('error', reject);
  });
}

// ─── Helpers ───
let _knowledgeCache = null;
async function loadKnowledge() {
  if (_knowledgeCache) return _knowledgeCache;
  try {
    _knowledgeCache = await fs.readFile(KNOWLEDGE_PATH, 'utf8');
  } catch {
    _knowledgeCache = '(knowledge.txt not found in skill dir)';
  }
  return _knowledgeCache;
}

async function hashFile(filePath) {
  try {
    const buf = await fs.readFile(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  } catch { return 'unknown'; }
}

// ─── Real mode: 呼 Nemotron Super 文字推理 ───
async function callNemotronReal({ drawingPdfPath, customerId, productRequest, spec, hardness }) {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) throw new Error('NVIDIA_API_KEY not set');

  const knowledge = await loadKnowledge();
  const systemPrompt = `你是 GatherRoller (台灣中部 1989 創立的橡膠輪工廠) 的資深機械工程師。
以下是公司產品知識庫，所有判讀以此為基準，不要 hallucinate 規格：

${knowledge}

判讀工程圖時：先看產品類型（對應上面 11 個產業哪個）、硬度範圍是否合理、表面處理需求、是否需要抗靜電/ESD 認證、材料是否與客戶產業需求匹配。`;

  const userPrompt = `請判讀附上的工程圖 + 客戶背景，輸出嚴格 JSON（不要其他文字）：
{
  "product_id": "<string>",
  "product_name_zh": "<繁中產品名>",
  "product_name_en": "<英文產品名>",
  "industry_match": "<上面 11 個產業之一>",
  "specs": {
    "diameter_mm": <number>, "width_mm": <number>, "length_mm": <number>,
    "shaft_diameter_mm": <number>, "coating_material": "<string>",
    "hardness_shore_a": <number>, "surface_treatment": "<string>", "load_kg": <number>
  },
  "bom": [
    {"part_name": "Roller Core (Shaft)", "source": "Vendor", "qty_per_unit": 1, "material_spec": "<string>"},
    {"part_name": "<Cover compound from knowledge base>", "source": "InHouse", "qty_per_unit": <kg>, "material_spec": "<string>"},
    {"part_name": "Adhesive (Bonding Agent)", "source": "InHouse", "qty_per_unit": <ml>},
    {"part_name": "End Caps (if applicable)", "source": "InHouse", "qty_per_unit": 2},
    {"part_name": "Bearings", "source": "InHouse", "qty_per_unit": 2},
    {"part_name": "Surface Finish (Grinding)", "source": "Outsource", "qty_per_unit": 1},
    {"part_name": "Packaging/Protection", "source": "InHouse", "qty_per_unit": 1}
  ],
  "quality_requirements": {
    "tolerance_mm": <number>, "certifications_required": [...], "anti_static_required": <boolean>
  },
  "confidence": <0.0–1.0>,
  "notes": "<判讀理由>"
}

[drawing_path]: ${drawingPdfPath}
[customer_id]: ${customerId || 'n/a'}
[product_request]: ${productRequest || 'n/a'}
[spec]: ${spec || 'n/a'}
[hardness]: ${hardness || 'n/a'}`;

  const resp = await fetch(`${NEMOTRON_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: NEMOTRON_SUPER_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
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
function callNemotronMock({ customerId, productRequest }) {
  // 鴻碩電子 (PCB 業) → Anti-Static Silicone Roller 是最合理的判讀
  return {
    product_id: 'Anti-Static Silicone Roller (PU-coated wheel variant / 包膠鐵輪)',
    product_name_zh: '包膠鐵輪 (抗靜電 PU 表面)',
    product_name_en: 'Anti-Static Silicone Roller',
    industry_match: 'PCB / Optoelectronic Panels',
    specs: {
      diameter_mm: 25, width_mm: 35, length_mm: 600, shaft_diameter_mm: 12,
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
    notes: `[DEMO MODE] 客戶 ${customerId || 'n/a'} 為 PCB 業，依知識庫 2.1 PCB 章節：硬度 50–90 Shore A、需抗靜電；綜合判定為 Anti-Static Silicone Roller，硬度 55 取中段，符合 panel surface sensitivity 需求。${productRequest ? `\n[user 描述]: ${productRequest}` : ''}`
  };
}

// ─── main ───
async function main() {
  const input = await readStdin();
  const { drawing_pdf_path = '', customer_id = '', product_request = '', spec = '', hardness = '' } = input;
  const drawingHash = await hashFile(drawing_pdf_path);
  const startedAt = new Date().toISOString();

  let result;
  if (process.env.NVIDIA_API_KEY && process.env.NODE_ENV !== 'test') {
    try {
      result = await callNemotronReal({
        drawingPdfPath: drawing_pdf_path,
        customerId: customer_id,
        productRequest: product_request,
        spec, hardness
      });
    } catch (err) {
      console.error(`[read_drawing] Nemotron call failed, fallback to mock: ${err.message}`);
      result = callNemotronMock({ customerId: customer_id, productRequest: product_request });
    }
  } else {
    result = callNemotronMock({ customerId: customer_id, productRequest: product_request });
  }

  const output = {
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

  process.stdout.write(JSON.stringify(output));
}

main().catch(err => {
  console.error(`[read_drawing] fatal: ${err.message}`);
  process.exit(1);
});
