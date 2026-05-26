#!/usr/bin/env node
/**
 * skills/read_drawing/impl.js (OpenClaw skill version — VISION upgrade)
 *
 * PDF → PNG (pdf-to-png-converter 純 JS，第一頁 viewportScale 1.5 ≈ 150 dpi)
 *     → base64
 *     → Nemotron Vision (meta/llama-3.2-90b-vision-instruct via NVIDIA NIM)
 *     → 嚴格 JSON output
 *
 * Fallback：vision 不可達 → 文字推理 mock (knowledge.txt + customer name)
 *
 * NemoClaw egress preset 允許 integrate.api.nvidia.com (NVIDIA NIM API)。
 *
 * 注意：用 npm pdf-to-png-converter 取代 pdftoppm，避開 sandbox 沒
 * poppler-utils 的問題（sandbox apt-get 預期被治理擋）。
 * pdf-to-png-converter 內部用 pdfjs-dist + @napi-rs/canvas (prebuilt binary
 * 不需要 cairo/libpng 等 system library)。
 */

const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const crypto = require('crypto');

const SKILL_DIR = __dirname;
const KNOWLEDGE_PATH = path.join(SKILL_DIR, 'knowledge.txt');

// 走 NemoClaw managed inference route (inference.local)，不直連
// integrate.api.nvidia.com — sandbox squid proxy 擋外連 NIM 但 inference.local
// 是 NemoClaw 內部 transparent proxy，所有 NIM model 都過得了。
// API key 也不需要 — inference.local 走 NemoClaw 預設 key。
const NEMOTRON_BASE = process.env.NEMOCLAW_INFERENCE_BASE || 'https://inference.local/v1';

// Vision model — 用 NVIDIA Nemotron VL 家族 (demo 故事：
// 「Super 當大腦推理 + Nano VL 當眼睛看圖」全 NVIDIA Nemotron multi-agent 架構)
// 注意：必須在 openclaw.json 註冊，否則 inference-fix.js guard 強制 redirect
// 到主模型。跑 ./scripts/add-vision-model.sh 註冊。
const VISION_MODEL = process.env.READ_DRAWING_VISION_MODEL || 'nvidia/llama-3.1-nemotron-nano-vl-8b-v1';

async function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { buf += chunk; });
    process.stdin.on('end', () => {
      try { resolve(buf.trim() ? JSON.parse(buf) : {}); }
      catch (e) { reject(new Error(`stdin not valid JSON: ${e.message}`)); }
    });
    process.stdin.on('error', reject);
  });
}

let _knowledgeCache = null;
async function loadKnowledge() {
  if (_knowledgeCache) return _knowledgeCache;
  try {
    _knowledgeCache = await fs.readFile(KNOWLEDGE_PATH, 'utf8');
  } catch {
    _knowledgeCache = '(knowledge.txt missing)';
  }
  return _knowledgeCache;
}

async function hashFile(filePath) {
  try {
    const buf = await fs.readFile(filePath);
    return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  } catch { return 'unknown'; }
}

// ─── PDF → PNG buffer (純 JS — pdf-to-png-converter) ───
// 直接回 Buffer，不寫 tmp 檔（少一個 IO）
async function pdfFirstPageToPngBuffer(pdfPath) {
  if (!fsSync.existsSync(pdfPath)) {
    throw new Error(`PDF not found: ${pdfPath}`);
  }
  let pdfToPng;
  try {
    ({ pdfToPng } = require('pdf-to-png-converter'));
  } catch (e) {
    throw new Error(`pdf-to-png-converter not installed: ${e.message} — cli.sh 應該 lazy install`);
  }
  // viewportScale 1.5 ≈ 150 dpi（NVIDIA Vision <180KB base64 限制下取平衡）
  const pages = await pdfToPng(pdfPath, {
    viewportScale: 1.5,
    pagesToProcess: [1],
    disableFontFace: true,
    useSystemFonts: false
  });
  if (!pages || pages.length === 0 || !pages[0].content) {
    throw new Error('pdf-to-png-converter returned no pages');
  }
  return pages[0].content;  // Buffer
}

// ─── Nemotron Vision API ───
async function callNemotronVision({ pngBuf, customerName, drawingPdfPath }) {
  // inference.local 不需要 NVIDIA_API_KEY (走 NemoClaw managed route)
  // 但如果有 set 還是帶上，以防直連 fallback
  const apiKey = process.env.NVIDIA_API_KEY || 'unused';

  const pngB64 = pngBuf.toString('base64');
  // NVIDIA NIM 對單 image 限制 ~180 KB base64 (LLama vision)
  if (pngB64.length > 180_000) {
    // 太大重 rasterize at lower dpi? 暫不做，警告 + 截
    console.error(`[read_drawing] WARN: PNG base64 size ${pngB64.length} > 180KB, vision API 可能 reject`);
  }

  const knowledge = await loadKnowledge();
  const systemPrompt = `你是 GatherRoller (台灣中部 1989 創立的橡膠輪工廠) 的資深機械工程師。
依據公司產品知識庫對工程圖做判讀。所有規格從圖上抓，不要 hallucinate；不確定的就回 null。

公司知識庫（產業類別、硬度範圍、表面處理對應）：
${knowledge.slice(0, 8000)}`;

  const userPrompt = `請判讀附上的工程圖 PNG，抽出產品規格 / BOM / 品質要求。

客戶名稱：${customerName || '(未提供)'}

輸出嚴格 JSON（不要其他文字、不要 markdown fence）：
{
  "product_id": "<圖上產品名稱，譬如 矽膠抗靜電包膠輪 A1>",
  "product_name_zh": "<繁中產品名>",
  "product_name_en": "<英文產品名>",
  "drawing_version": "<圖上 A1 / A2 之類版本>",
  "industry_match": "<從 11 個產業中對應一個：PCB / Optoelectronic Panels / Packaging / Printing / ...>",
  "specs": {
    "outer_diameter_mm": <number>,
    "outer_diameter_tolerance": "<+0.250/-0.000 之類圖上文字>",
    "coating_length_mm": <number>,
    "shaft_total_length_mm": <number>,
    "between_shaft_length_mm": <number>,
    "coating_material": "<矽膠 / PU / NBR ...>",
    "hardness_shore_a": <number>,
    "hardness_tolerance": "<±5 之類>",
    "surface_finish_note": "<圖上備註>",
    "shaft_features": [
      {"label": "<UC/RB 之類>", "tolerance": "<圖上公差>", "part_no": "<圖上 part number>"}
    ]
  },
  "bom": [
    {"part_name": "Roller Core (Shaft)", "source": "Vendor", "qty_per_unit": 1, "material_spec": "S45C Carbon Steel"},
    {"part_name": "<Cover 對應 coating_material 的 compound name>", "source": "InHouse", "qty_per_unit": <kg 估>, "material_spec": "<同 coating_material + 硬度>"},
    {"part_name": "Adhesive (Bonding Agent)", "source": "InHouse", "qty_per_unit": <ml 估>},
    {"part_name": "End Caps", "source": "InHouse", "qty_per_unit": 2},
    {"part_name": "Bearings", "source": "InHouse", "qty_per_unit": 2},
    {"part_name": "Surface Finish (Grinding)", "source": "Outsource", "qty_per_unit": 1},
    {"part_name": "Packaging/Protection", "source": "InHouse", "qty_per_unit": 1}
  ],
  "quality_requirements": {
    "tolerance_mm": <number>,
    "certifications_required": [<陣列，譬如 ESD-S20.20 / ISO 9001 / 空陣列>],
    "anti_static_required": <boolean，從產品名含「抗靜電」或客戶為 PCB 業推斷>
  },
  "confidence": <0.0–1.0，越高越確定>,
  "notes": "<判讀理由：為何選這個 industry / 為何 anti_static>"
}`;

  const resp = await fetch(`${NEMOTRON_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify({
      model: VISION_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: userPrompt },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${pngB64}` } }
          ]
        }
      ],
      temperature: 0.1,
      max_tokens: 2500,
      stream: false
    })
  });

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    throw new Error(`Nemotron Vision call failed: HTTP ${resp.status} — ${errBody.slice(0, 300)}`);
  }
  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content ?? '{}';
  const match = text.match(/\{[\s\S]*\}/);
  const parsed = JSON.parse(match ? match[0] : text);
  parsed.vision_used = true;
  parsed.model = VISION_MODEL;
  return parsed;
}

// ─── Text-only fallback (沒 NVIDIA_API_KEY 或 vision 失敗) ───
function fallbackMock({ customerName }) {
  return {
    vision_used: false,
    model: 'mock',
    product_id: '矽膠抗靜電包膠輪 A1',
    product_name_zh: '矽膠抗靜電包膠輪',
    product_name_en: 'Anti-Static Silicone Rubber Roller',
    drawing_version: 'A1',
    industry_match: 'PCB / Optoelectronic Panels',
    specs: {
      outer_diameter_mm: 50,
      outer_diameter_tolerance: '+0.250 / -0.000',
      coating_length_mm: 598,
      shaft_total_length_mm: 732,
      between_shaft_length_mm: 665,
      coating_material: '矽膠',
      hardness_shore_a: 40,
      hardness_tolerance: '±5',
      surface_finish_note: '去銳角、毛邊',
      shaft_features: [
        { label: 'UC', tolerance: '+0.080 / -0.000', part_no: 'PJD8963*MH820' },
        { label: 'RB', tolerance: '+0.050 / -0.030', part_no: 'PJD0027*MH083' }
      ]
    },
    bom: [
      { part_name: 'Roller Core (Shaft)', source: 'Vendor', qty_per_unit: 1, material_spec: 'S45C Carbon Steel' },
      { part_name: 'Anti-Static Silicone Cover', source: 'InHouse', qty_per_unit: 0.6, material_spec: '矽膠 Shore A 40 ± 5' },
      { part_name: 'Adhesive (Bonding Agent)', source: 'InHouse', qty_per_unit: 50 },
      { part_name: 'End Caps', source: 'InHouse', qty_per_unit: 2 },
      { part_name: 'Bearings', source: 'InHouse', qty_per_unit: 2 },
      { part_name: 'Surface Finish (Grinding)', source: 'Outsource', qty_per_unit: 1 },
      { part_name: 'Packaging/Protection', source: 'InHouse', qty_per_unit: 1 }
    ],
    quality_requirements: {
      tolerance_mm: 0.05,
      certifications_required: [],
      anti_static_required: true
    },
    confidence: 0.5,
    notes: `[FALLBACK MOCK] vision 不可達，依客戶 ${customerName || 'n/a'} 與圖檔名稱猜，confidence 設低`
  };
}

async function main() {
  const input = await readStdin();
  const { order_id, drawing_pdf_path, customer_name } = input;

  if (!drawing_pdf_path) throw new Error('drawing_pdf_path required');
  const startedAt = new Date().toISOString();
  const drawingHash = await hashFile(drawing_pdf_path);

  let result;
  try {
    const pngBuf = await pdfFirstPageToPngBuffer(drawing_pdf_path);
    result = await callNemotronVision({
      pngBuf, customerName: customer_name, drawingPdfPath: drawing_pdf_path
    });
  } catch (err) {
    console.error(`[read_drawing] vision failed, fallback to mock: ${err.message}`);
    result = fallbackMock({ customerName: customer_name });
    result.fallback_reason = err.message;
  }

  const output = {
    order_id,
    ...result,
    _meta: {
      skill: 'read_drawing',
      agent: 'engineer',
      drawing_path: drawing_pdf_path,
      drawing_hash: drawingHash,
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
