#!/usr/bin/env node
/**
 * skills/compare_suppliers/impl.js (OpenClaw skill version)
 *
 * 讀 ./data/suppliers.json，3 家代工廠多維比對 + 評分 + 推薦。
 *
 * v2 (2026-05-26)：加 score / ranked / recommendation。
 * 設計原則：skill 做 deterministic scoring（給審核留 trace）；
 *           agent 拿 ranked + recommendation 寫 LINE summary 給老闆按按鈕。
 *           **老闆仍然做最終決定**（human-in-the-loop 不變）。
 */

const fs = require('fs/promises');
const path = require('path');
const { writebackToOrder } = require('../_lib/order_writeback');

const SKILL_DIR = __dirname;
const SUPPLIERS_JSON = path.join(SKILL_DIR, 'data', 'suppliers.json');

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

/**
 * 評分（0-100）：
 *   - 若客戶 requires_anti_static 但 supplier 沒抗靜電 → 0（disqualified）
 *   - 其他：價格 35% + 交期 35% + 良率 20% + 認證 10%
 */
function scoreSupplier(s, minPrice, minLead, requiresAntiStatic) {
  if (requiresAntiStatic && !s.anti_static) {
    return { score: 0, disqualified: true, disqualified_reason: '客戶要求抗靜電認證，但該供應商無此認證' };
  }
  const priceScore = (minPrice / s.price_twd) * 35;
  const leadScore  = (minLead  / s.lead_time_days) * 35;
  const yieldScore = (s.yield_rate_pct / 100) * 20;
  const certScore  = (s.certifications && s.certifications.length > 0 ? 1 : 0.5) * 10;
  return {
    score: Math.round((priceScore + leadScore + yieldScore + certScore) * 10) / 10,
    disqualified: false,
    breakdown: {
      price: Math.round(priceScore * 10) / 10,
      lead:  Math.round(leadScore  * 10) / 10,
      yield: Math.round(yieldScore * 10) / 10,
      cert:  Math.round(certScore  * 10) / 10
    }
  };
}

/**
 * 推薦理由（每家 supplier 的 key_reasons）
 */
function buildReasons(s, all, requiresAntiStatic, maxDays) {
  const reasons = [];
  const prices = all.map(x => x.price_twd);
  const leads  = all.map(x => x.lead_time_days);
  const minP = Math.min(...prices);
  const minL = Math.min(...leads);

  // 價格
  if (s.price_twd === minP) {
    reasons.push('✅ 價格最低');
  } else {
    const pct = Math.round((s.price_twd - minP) / minP * 100);
    reasons.push(`⚠️ 價格比最低貴 ${pct}%`);
  }

  // 交期
  if (s.lead_time_days === minL) {
    reasons.push('✅ 交期最短');
  } else {
    reasons.push(`⚠️ 交期比最快慢 ${s.lead_time_days - minL} 天`);
  }
  if (s.lead_time_days > maxDays) {
    reasons.push(`❌ 超過客戶要求的 ${maxDays} 天`);
  }

  // 認證
  if (requiresAntiStatic) {
    reasons.push(s.anti_static ? '✅ 有抗靜電認證（符合客戶硬性需求）' : '❌ 無抗靜電認證（不符客戶硬性需求）');
  } else if (s.anti_static) {
    reasons.push('✅ 有抗靜電認證（加分）');
  }

  // 良率
  if (s.yield_rate_pct >= 98) reasons.push(`✅ 良率高（${s.yield_rate_pct}%）`);
  else if (s.yield_rate_pct < 95) reasons.push(`⚠️ 良率偏低（${s.yield_rate_pct}%）`);
  else reasons.push(`良率 ${s.yield_rate_pct}%`);

  return reasons;
}

async function main() {
  const input = await readStdin();
  const { supplier_ids, customer_requirements = {}, order_id } = input;
  if (!Array.isArray(supplier_ids)) throw new Error('supplier_ids must be array');

  const raw = await fs.readFile(SUPPLIERS_JSON, 'utf8');
  const { suppliers } = JSON.parse(raw);

  const maxDays = customer_requirements.max_surface_treatment_days ?? Infinity;
  const requiresAntiStatic = !!customer_requirements.requires_anti_static;

  const candidates = supplier_ids
    .map(id => suppliers.find(s => s.id === id))
    .filter(Boolean)
    .map(s => ({
      supplier_id: s.id,
      name: s.name,
      price_twd: s.pricing.unit_price_twd,
      lead_time_days: s.lead_time_days,
      yield_rate_pct: s.quality.yield_rate_pct,
      anti_static: s.quality.anti_static_capable,
      certifications: s.quality.certifications || [],
      meets_lead_time: s.lead_time_days <= maxDays,
      meets_quality: !requiresAntiStatic || s.quality.anti_static_capable,
      notes: s.notes
    }));

  if (candidates.length === 0) {
    process.stdout.write(JSON.stringify({
      candidates: [], ranked: [], recommendation: null,
      customer_requirements,
      _meta: { skill: 'compare_suppliers', error: 'no matching suppliers', finished_at: new Date().toISOString() }
    }));
    return;
  }

  // 算分
  const minPrice = Math.min(...candidates.map(c => c.price_twd));
  const minLead  = Math.min(...candidates.map(c => c.lead_time_days));
  const scored = candidates.map(c => {
    const sc = scoreSupplier(c, minPrice, minLead, requiresAntiStatic);
    return {
      ...c,
      score: sc.score,
      disqualified: sc.disqualified,
      disqualified_reason: sc.disqualified_reason || null,
      score_breakdown: sc.breakdown || null,
      key_reasons: buildReasons(c, candidates, requiresAntiStatic, maxDays)
    };
  });

  // 排名（分數高 → 低；disqualified 一律排最後）
  const ranked = [...scored].sort((a, b) => {
    if (a.disqualified !== b.disqualified) return a.disqualified ? 1 : -1;
    return b.score - a.score;
  });

  // 推薦：取 ranked[0]（最高分且未 disqualify）
  const top = ranked[0];
  const recommendation = top.disqualified ? null : {
    supplier_id: top.supplier_id,
    name: top.name,
    score: top.score,
    key_reasons: top.key_reasons,
    headline: `建議選 ${top.name}（綜合分數 ${top.score}）`,
    // 簡短一行給 LINE summary 用
    one_liner: top.key_reasons.filter(r => r.startsWith('✅')).slice(0, 2).join('、') || top.key_reasons[0]
  };

  // Trade-off 表（agent 可以直接貼到 LINE summary）
  const trade_off_table = ranked.map(r => {
    const tag = r.disqualified ? '❌' : (r.supplier_id === top.supplier_id ? '🏆' : '  ');
    return `${tag} ${r.name}：$${r.price_twd}/件、${r.lead_time_days}天、良率${r.yield_rate_pct}%、${r.anti_static ? 'ESD✓' : 'ESD✗'}（分數 ${r.score}）`;
  }).join('\n');

  // ─── AI 策略建議 ───
  // 不只是「選 A 或選 B」，是「跟客戶協商爭取更划算的條件」
  // demo wow point：AI 像資深業務一樣思考，不只是比較表
  const qty = customer_requirements.qty || 200;  // 默認 demo qty
  const strategies = generateStrategies(ranked, candidates, customer_requirements, qty);

  const output = {
    candidates,
    ranked,
    recommendation,
    trade_off_table,
    strategies,
    customer_requirements,
    _meta: {
      skill: 'compare_suppliers',
      agent: 'quote',
      version: 'v3-strategic',
      finished_at: new Date().toISOString()
    }
  };

  // Auto-writeback
  let writebackResult = null;
  if (order_id) {
    writebackResult = writebackToOrder({
      order_id,
      patch: { comparison: output, status: 'awaiting_tradeoff' },
      audit: {
        level: 'INFO',
        msg: `compared ${ranked.length} suppliers; AI 推薦 ${recommendation?.name || 'none'}`,
        skill: 'compare_suppliers',
        ai_recommendation: recommendation?.supplier_id,
        ai_strategy: strategies[0]?.id
      }
    });
  }

  if (order_id && writebackResult && writebackResult.ok) {
    // Slim — 給 agent 看 ranked top 2 + 推薦 + 策略，方便構 line_notify
    const R = ranked;
    const S = strategies[0];
    process.stdout.write(JSON.stringify({
      order_id,
      writeback: writebackResult,
      recommendation: recommendation ? {
        supplier_id: recommendation.supplier_id,
        name: recommendation.name,
        score: recommendation.score,
        headline: recommendation.headline,
        one_liner: recommendation.one_liner
      } : null,
      ranked_top2: R.slice(0, 2).map(r => ({
        supplier_id: r.supplier_id, name: r.name, score: r.score, disqualified: r.disqualified
      })),
      strategy: S ? {
        id: S.id,
        short_label: S.short_label,
        headline: S.headline,
        alternative_supplier_id: S.alternative_supplier_id,
        estimated_total_savings_twd: S.estimated_total_savings_twd,
        estimated_savings_pct: S.estimated_savings_pct
      } : null,
      trade_off_table,
      // line_notify 用：3 個動態 options
      suggested_line_options: [
        R[0] && !R[0].disqualified ? `選 ${R[0].name}（AI 推薦）` : '取消',
        R[1] ? `改選 ${R[1].name}` : '取消',
        S ? S.short_label : '取消'
      ],
      suggested_line_extra: { ranked_supplier_ids: R.slice(0, 2).map(r => r.supplier_id), strategy: S || null },
      note: 'comparison 完整內容已寫回 order_store。要 push LINE gate-2，options/extra 已備妥。'
    }));
  } else {
    process.stdout.write(JSON.stringify({ ...output, writeback: writebackResult }));
  }
}

/**
 * 生 AI 策略建議
 *
 * 不只是「選 A vs 選 B」，而是「跟客戶協商可以解鎖更好的選項」
 *
 * 策略類型：
 *   - NEGOTIATE_QUALITY_RELAXATION: 客戶硬性需求 disqualify 了便宜廠 → 建議談放寬
 *   - NEGOTIATE_LEAD_EXTENSION: 推薦的最快最貴 → 建議談延期改用便宜廠
 *   - NEGOTIATE_PRICE_DOWN: 推薦的合格但偏貴 + 有長期合作關係 → 建議議價
 *   - SPLIT_ORDER: 量大 + 多家 meet → 建議拆單試新廠
 */
function generateStrategies(ranked, candidates, customerReq, qty) {
  const strategies = [];
  const qualified = ranked.filter(r => !r.disqualified);
  const disqualified = ranked.filter(r => r.disqualified);
  const winner = qualified[0];

  if (!winner) return strategies;

  // ── 策略 1: NEGOTIATE_QUALITY_RELAXATION ──
  // 客戶 requires_anti_static + 有便宜的廠被擋 → 算「若放寬可省多少」
  if (customerReq.requires_anti_static && disqualified.length > 0) {
    // 把 disqualified 全部重新算分（暫時忽略 ESD 約束）→ 找最佳替代
    const minPrice = Math.min(...candidates.map(c => c.price_twd));
    const minLead = Math.min(...candidates.map(c => c.lead_time_days));
    const rescored = disqualified.map(c => {
      const priceScore = (minPrice / c.price_twd) * 35;
      const leadScore = (minLead / c.lead_time_days) * 35;
      const yieldScore = (c.yield_rate_pct / 100) * 20;
      const certScore = (c.certifications && c.certifications.length > 0 ? 1 : 0.5) * 10;
      return { ...c, alt_score: Math.round((priceScore + leadScore + yieldScore + certScore) * 10) / 10 };
    }).sort((a, b) => b.alt_score - a.alt_score);

    const alt = rescored[0];
    if (alt) {
      const unitSaving = winner.price_twd - alt.price_twd;
      const totalSaving = unitSaving * qty;
      const savingPct = Math.round((unitSaving / winner.price_twd) * 100);
      const leadDelta = alt.lead_time_days - winner.lead_time_days;
      const leadStr = leadDelta === 0 ? '交期相同' : leadDelta > 0 ? `多 ${leadDelta} 天` : `快 ${-leadDelta} 天`;

      if (unitSaving > 0) {
        strategies.push({
          id: 'negotiate_quality_relaxation',
          type: 'customer_negotiation',
          priority: 1,
          short_label: `跟客戶談放寬 ESD，改用${alt.name}省 ${savingPct}%`,
          headline: `💡 AI 策略：跟客戶談放寬 ESD 認證要求`,
          rationale: `客戶要求 ESD 認證讓選項只剩 ${winner.name}（$${winner.price_twd}/件）。若客戶 ESD 非硬性，改用 ${alt.name}（$${alt.price_twd}/件）：\n` +
                     `• 單件省 NT$${unitSaving}（${savingPct}%）\n` +
                     `• 200 隻總省 NT$${totalSaving.toLocaleString()}\n` +
                     `• ${leadStr}\n` +
                     `• ${alt.certifications.length > 0 ? '仍有 ' + alt.certifications.join('/') : '無第三方認證'}、良率 ${alt.yield_rate_pct}%\n` +
                     `\n建議話術：「ESD 規格主要影響 X 製程，能否確認貴司產線是否真需要？若可放寬，我們可降本 ${savingPct}%」`,
          action: 'reply_customer_with_negotiation',
          alternative_supplier_id: alt.supplier_id,
          alternative_supplier_name: alt.name,
          estimated_unit_savings_twd: unitSaving,
          estimated_total_savings_twd: totalSaving,
          estimated_savings_pct: savingPct,
          lead_time_delta_days: leadDelta
        });
      }
    }
  }

  // ── 策略 2: NEGOTIATE_LEAD_EXTENSION ──
  // 在 qualified 裡找：比 winner 慢但便宜的 → 建議延期改省錢
  const slowerCheaper = qualified
    .filter(r => r.supplier_id !== winner.supplier_id && r.price_twd < winner.price_twd)
    .sort((a, b) => a.price_twd - b.price_twd)[0];
  if (slowerCheaper) {
    const unitSaving = winner.price_twd - slowerCheaper.price_twd;
    const totalSaving = unitSaving * qty;
    const savingPct = Math.round((unitSaving / winner.price_twd) * 100);
    const extraDays = slowerCheaper.lead_time_days - winner.lead_time_days;
    strategies.push({
      id: 'negotiate_lead_extension',
      type: 'customer_negotiation',
      priority: 2,
      short_label: `跟客戶談延 ${extraDays} 天交期，改用${slowerCheaper.name}省 ${savingPct}%`,
      headline: `💡 AI 策略：跟客戶談延 ${extraDays} 天交期`,
      rationale: `${winner.name} 交期最短但最貴。若客戶可延 ${extraDays} 天交期，改用 ${slowerCheaper.name}：\n` +
                 `• 單件省 NT$${unitSaving}（${savingPct}%）\n` +
                 `• 總省 NT$${totalSaving.toLocaleString()}\n` +
                 `• ${slowerCheaper.anti_static ? '同樣有 ESD 認證' : '無 ESD 認證'}`,
      action: 'reply_customer_with_negotiation',
      alternative_supplier_id: slowerCheaper.supplier_id,
      alternative_supplier_name: slowerCheaper.name,
      estimated_unit_savings_twd: unitSaving,
      estimated_total_savings_twd: totalSaving,
      estimated_savings_pct: savingPct,
      lead_time_delta_days: extraDays
    });
  }

  // ── 策略 3: NEGOTIATE_PRICE_DOWN ──
  // 推薦的廠長期合作（history_orders_count > 30）+ 還是貴 → 建議議價
  // 用 raw supplier data 找 history_orders_count
  const winnerRaw = candidates.find(c => c.supplier_id === winner.supplier_id);
  // candidates 沒帶 history_orders_count，從 ranked 找不到時 skip
  // (簡化：只在前兩個策略都沒生出來時 fallback 用)
  if (strategies.length === 0 && winner.price_twd > Math.min(...candidates.map(c => c.price_twd)) * 1.15) {
    strategies.push({
      id: 'negotiate_price_down',
      type: 'supplier_negotiation',
      priority: 3,
      short_label: `跟${winner.name}議價（比最低貴 15%+）`,
      headline: `💡 AI 策略：跟 ${winner.name} 議價`,
      rationale: `${winner.name} 是唯一符合品質的選項但價格偏高。建議：\n` +
                 `• 提出「同等 ESD 規格我們收到 $${Math.min(...candidates.map(c => c.price_twd))} 報價」\n` +
                 `• 目標：談到 $${Math.round(winner.price_twd * 0.93)}（降 7%）`,
      action: 'reply_supplier_with_negotiation',
      target_supplier_id: winner.supplier_id,
      target_supplier_name: winner.name,
      target_unit_price_twd: Math.round(winner.price_twd * 0.93)
    });
  }

  return strategies;
}

main().catch(err => {
  console.error(`[compare_suppliers] fatal: ${err.message}`);
  process.exit(1);
});
