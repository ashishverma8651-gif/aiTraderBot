// tg_commands.js — ML v15.1 PRO integrated, single-file safe implementation (Node18+, ESM)

// ---------------- IMPORTS ----------------
import CONFIG from "./config.js";
import ML from "./ml_module_v8_6.js";   // <- uses the ml_module_v15_1 you provided
import { fetchMultiTF, fetchMarketData } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";
import NewsModule from "./news_social.js";

/* ----------------- Extract ML v15.1 PRO Exports ----------------- */
const {
  runMLPrediction,
  runMicroPrediction,
  calculateAccuracy,
  recordPrediction,
  recordOutcome,
  markOutcome,
  getStats,
  trainAdaptive,
  resetStats,
  computeReboundProbability,
  computeTrendExhaustion,
  computeVolatilityCrush,
  compute30minPressure,
  fuseMLTFs,
  buildStableTargets,
  buildAIReport: ml_buildAIReport,
  aggregateAndScoreTPs,
  clusterTPCandidates,
  scoreTPCluster,
  finalizePrimaryHedgeFromScored
} = ML || {};

/* Safe News accessor */
const fetchNewsBundle =
  (NewsModule && (NewsModule.fetchNewsBundle || (NewsModule.default && NewsModule.default.fetchNewsBundle)))
    ? (NewsModule.fetchNewsBundle || NewsModule.default.fetchNewsBundle)
    : async () => ({ ok: false, sentiment: 0.5, impact: "low", items: [], headline: "No news" });

/* ----------------- Helpers ----------------- */
const MAX_TG_CHARS = 3800;
const IST = { locale: "en-IN", hour12: true, timeZone: "Asia/Kolkata" };
const nf = (v, d = 2) => (typeof v === "number" && Number.isFinite(v)) ? Number(v).toFixed(d) : (v === null || v === undefined ? "N/A" : String(v));
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const clamp = (v, a = -1, b = 1) => Math.max(a, Math.min(b, v));

function nowIST(iso) {
  try {
    const d = iso ? new Date(iso) : new Date();
    return d.toLocaleString("en-IN", IST);
  } catch {
    return new Date().toString();
  }
}

function splitParts(blocks, lim = MAX_TG_CHARS) {
  const out = [];
  let buf = "";
  for (const b of blocks) {
    if (!b) continue;
    if ((buf + "\n\n" + b).length < lim) buf += (buf ? "\n\n" : "") + b;
    else { if (buf) out.push(buf); buf = b; }
  }
  if (buf) out.push(buf);
  return out;
}

/* ----------------- Safe ML wrapper helpers ----------------- */
async function safeRunMLPrediction(symbol, tf) {
  try {
    if (typeof runMLPrediction === "function") {
      const res = await runMLPrediction(symbol, tf);
      return res || null;
    }
    return null;
  } catch (e) {
    // don't throw; return null to let caller fall back
    return null;
  }
}

/* ----------------- stable target canonicalization (safe) ----------------- */
function canonicalizeStableTargets(clusterTargets = [], mlFusion = {}, price = 0, feats = {}) {
  try {
    if (typeof buildStableTargets === "function") {
      const out = buildStableTargets(clusterTargets, mlFusion, price, feats);
      if (out && (out.primaryTP !== undefined || out.primary !== undefined)) {
        return {
          primaryTP: (out.primaryTP !== undefined ? out.primaryTP : out.primary),
          hedgeTP: (out.hedgeTP !== undefined ? out.hedgeTP : out.hedge),
          primarySource: out.primarySource || out.primarySource || out.primarySrc || "ML",
          hedgeSource: out.hedgeSource || out.hedgeSource || out.hedgeSrc || "ML",
          primaryConf: Math.round(out.primaryConf ?? out.confidence ?? 50),
          direction: out.direction || mlFusion?.direction || "Neutral"
        };
      }
    }
  } catch (e) { /* fallback below */ }

  const priceNum = Number(price || 0);
  const sorted = Array.isArray(clusterTargets) ? clusterTargets.slice().sort((a,b)=> (b.confidence||0)-(a.confidence||0)) : [];
  const bulls = sorted.filter(s => Number(s.tp) > priceNum);
  const bears = sorted.filter(s => Number(s.tp) < priceNum);
  const dir = (mlFusion && mlFusion.direction) ? String(mlFusion.direction) : "Neutral";

  let primary = null, hedge = null;
  if (dir.toLowerCase().includes("bull")) {
    primary = bulls[0] || sorted[0] || { tp: priceNum + (feats?.atr || priceNum*0.002), source: "fallback", confidence:40 };
    hedge = bears[0] || { tp: priceNum - (feats?.atr || priceNum*0.002), source: "HEDGE_FALLBACK", confidence:30 };
  } else if (dir.toLowerCase().includes("bear")) {
    primary = bears[0] || sorted[0] || { tp: priceNum - (feats?.atr || priceNum*0.002), source: "fallback", confidence:40 };
    hedge = bulls[0] || { tp: priceNum + (feats?.atr || priceNum*0.002), source: "HEDGE_FALLBACK", confidence:30 };
  } else {
    primary = sorted[0] || { tp: priceNum + (feats?.atr || priceNum*0.002), source: "FALLBACK", confidence:40 };
    hedge = sorted[1] || { tp: priceNum - (feats?.atr || priceNum*0.002), source: "HEDGE_FALLBACK", confidence:30 };
  }

  let primaryTP = Number(primary.tp ?? primary.tpEstimate ?? primary.center ?? primary);
  let hedgeTP = Number(hedge.tp ?? hedge.tpEstimate ?? hedge.center ?? hedge);

  if (isNaN(primaryTP) || !isFinite(primaryTP)) primaryTP = priceNum + (feats?.atr || priceNum*0.005);
  if (isNaN(hedgeTP) || !isFinite(hedgeTP)) hedgeTP = priceNum - (feats?.atr || priceNum*0.005);

  // ensure opposite sides
  if ((primaryTP > priceNum && hedgeTP > priceNum) || (primaryTP < priceNum && hedgeTP < priceNum)) {
    const shift = Math.max(Math.abs(priceNum) * 0.002, (feats?.atr || 1));
    if (primaryTP > priceNum) hedgeTP = priceNum - shift;
    else hedgeTP = priceNum + shift;
  }

  return {
    primaryTP,
    hedgeTP,
    primarySource: primary.source || primary.source || "cluster",
    hedgeSource: hedge.source || hedge.source || "cluster",
    primaryConf: Math.round(primary.confidence || primary.score || 40),
    direction: dir
  };
}

/* ----------------- MAIN: buildAIReport (uses ML if available, otherwise local builder) ----------------- */
export async function buildAIReport(symbol = CONFIG.SYMBOL || "BTCUSDT", opts = {}) {
  try {
    // prefer ML's own buildAIReport if available
    if (typeof ml_buildAIReport === "function") {
      try {
        const r = await ml_buildAIReport(symbol, opts);
        // ensure fields exist and normalize
        if (r && typeof r === "object") return r;
      } catch (e) {
        // fallback to local builder below
      }
    }

    // Local builder
    const tfs = Array.isArray(opts.tfs) && opts.tfs.length ? opts.tfs : ["1m","5m","15m","30m","1h"];
    const mtf = await fetchMultiTF(symbol, tfs).catch(()=> ({}));

    const blocks = [];
    for (const tf of tfs) {
      const raw = mtf[tf] || { data: [], price: 0 };
      const candles = Array.isArray(raw.data) ? raw.data : [];
      const price = (typeof raw.price === "number" && isFinite(raw.price) && raw.price > 0) ? raw.price : (candles?.at(-1)?.close ?? 0);

      const ind = {
        RSI: typeof indicators.computeRSI === "function" ? indicators.computeRSI(candles) : (candles.length ? 50 : 50),
        MACD: typeof indicators.computeMACD === "function" ? indicators.computeMACD(candles) : { hist: 0 },
        ATR: typeof indicators.computeATR === "function" ? indicators.computeATR(candles) : 0,
        priceTrend: candles.length >= 2 ? (candles.at(-1).close > candles.at(-2).close ? "UP" : (candles.at(-1).close < candles.at(-2).close ? "DOWN" : "FLAT")) : "FLAT",
        volumeTrend: typeof indicators.volumeTrend === "function" ? indicators.volumeTrend(candles) : "STABLE"
      };

      let ell = null;
      try { ell = await analyzeElliott(candles); } catch (e) { ell = null; }

      const ellSummary = (() => {
        try {
          const pivots = ell?.pivots || [];
          const lastLow = [...pivots].reverse().find(p => p.type === "L") || null;
          const lastHigh = [...pivots].reverse().find(p => p.type === "H") || null;
          return { support: lastLow?.price ?? null, resistance: lastHigh?.price ?? null, confidence: ell?.confidence ?? 0 };
        } catch { return { support:null, resistance:null, confidence:0 }; }
      })();

      let targets = [];
      if (ell && Array.isArray(ell.targets) && ell.targets.length) {
        targets = ell.targets.map(t => ({ tp: Number(t.tp ?? t.target ?? t.price ?? 0), confidence: Math.round(Number(t.confidence ?? ell.confidence ?? 40)), source: t.source || t.type || tf }))
          .filter(t => (typeof t.tp === "number" && isFinite(t.tp) && t.tp > 0));
      } else {
        const fallbackAtr = Math.max(ind.ATR || 0, price * 0.002 || 1);
        targets = [
          { tp: Number((price + fallbackAtr*2).toFixed(8)), confidence:30, source:"ATR_UP" },
          { tp: Number((price - fallbackAtr*2).toFixed(8)), confidence:30, source:"ATR_DOWN" }
        ];
      }

      blocks.push({ tf, price, candles, indicators: ind, ell, ellSummary, targets });
    }

    // per-block fusion score
    const computeFusionScore = (ind, ell) => {
      let s=0,w=0;
      const rsi = Number(ind?.RSI ?? 50);
      s += ((rsi - 50)/50) * 0.4; w += 0.4;
      const macdh = Number(ind?.MACD?.hist ?? 0); const atr = Math.max(1, Number(ind?.ATR ?? 1));
      s += (Math.tanh(macdh/atr) * 0.35); w += 0.35;
      s += (ind.priceTrend==="UP"?0.15:ind.priceTrend==="DOWN"?-0.15:0); w += 0.15;
      s += (ind.volumeTrend==="INCREASING"?0.08:ind.volumeTrend==="DECREASING"?-0.08:0); w += 0.08;
      const ellSent = Number(ell?.sentiment ?? 0); const ellConf = clamp(Number(ell?.confidence ?? 0)/100, 0, 1);
      s += ellSent * (0.25 * ellConf); w += 0.25 * ellConf;
      if (w===0) return 0;
      return Number(clamp(s/w, -1, 1).toFixed(3));
    };

    for (const b of blocks) b.fusionScore = computeFusionScore(b.indicators, b.ell || { sentiment:0, confidence:0 });

    // overall fusion
    const TF_WEIGHTS = { "1m":0.05, "5m":0.08, "15m":0.4, "30m":0.22, "1h":0.25 };
    let s = 0, ws = 0;
    for (const b of blocks) { const w = TF_WEIGHTS[b.tf] ?? 0.1; s += (b.fusionScore||0)*w; ws += w; }
    const overallFusion = ws ? Number(clamp(s/ws, -1, 1).toFixed(3)) : 0;

    // cluster targets across TFs (dedupe by rounded)
    const tgtMap = new Map();
    for (const b of blocks) {
      for (const t of (b.targets || [])) {
        const tp = Number(t.tp || 0);
        if (!(tp > 0) || !isFinite(tp)) continue;
        const key = Math.round(tp);
        const conf = clamp(Number(t.confidence ?? 40), 0, 100);
        if (!tgtMap.has(key) || conf > (tgtMap.get(key).confidence || 0)) {
          tgtMap.set(key, { tp, confidence: Math.round(conf), source: t.source || b.tf });
        }
      }
    }
    const allTargets = Array.from(tgtMap.values()).sort((a,b) => b.confidence - a.confidence);
    const price = blocks.find(x=>x.tf==="15m")?.price ?? blocks[0]?.price ?? 0;

    // ML per-TF (stable TFs)
    const stableTFs = ["15m","30m","1h"];
    const mlPerTF = [];
    for (const mt of stableTFs) {
      const m = await safeRunMLPrediction(symbol, mt);
      if (m) mlPerTF.push(m);
    }

    // fuse ML outputs
    let mlFusion = { direction: "Neutral", confidence: 0 };
    try {
      if (typeof fuseMLTFs === "function") mlFusion = fuseMLTFs(mlPerTF || []);
      else {
        let bull=0,bear=0,neutral=0;
        for (const m of mlPerTF) {
          const d = (m.direction || "").toString().toLowerCase();
          const p = Number(m.maxProb ?? (m.probs ? Math.max(m.probs.bull||0,m.probs.bear||0) : 50));
          if (d.includes("bull")) bull += p;
          else if (d.includes("bear")) bear += p;
          else neutral += p;
        }
        mlFusion = { direction: (bull>bear? "Bullish": bear>bull? "Bearish":"Neutral"), confidence: Math.round(Math.max(bull,bear,neutral)/(mlPerTF.length||1)) };
      }
    } catch (e) { mlFusion = { direction:"Neutral", confidence:0 }; }

    // stable targets
    const feat15 = blocks.find(b=>b.tf==="15m") ? { atr: blocks.find(b=>b.tf==="15m").indicators.ATR, candles: blocks.find(b=>b.tf==="15m").candles } : {};
    const stable = canonicalizeStableTargets(allTargets, mlFusion || {}, price, feat15);

    // pro meters
    const proMeters = {
      rebound: (typeof computeReboundProbability === "function") ? computeReboundProbability(symbol, blocks) : 0,
      exhaustion: (typeof computeTrendExhaustion === "function") ? computeTrendExhaustion(symbol, blocks) : 0,
      volCrush: (typeof computeVolatilityCrush === "function") ? computeVolatilityCrush(symbol, blocks) : 0,
      pressure: (typeof compute30minPressure === "function") ? compute30minPressure(symbol, blocks) : {}
    };

    const mlAcc = (typeof calculateAccuracy === "function") ? calculateAccuracy() : { accuracy: 0 };
    const news = await fetchNewsBundle(symbol).catch(()=>({ ok:false, sentiment:0.5, impact:"low", items:[], headline:"No news" }));

    const report = {
      ok: true,
      symbol,
      generatedAt: new Date().toISOString(),
      nowIST: nowIST(),
      price,
      blocks,
      overallFusion,
      biasLabel: (() => {
        if (!isNum(overallFusion)) return { emoji:"⚪", label:"Neutral" };
        if (overallFusion >= 0.7) return { emoji:"🟩", label:"Strong Buy" };
        if (overallFusion >= 0.2) return { emoji:"🟦", label:"Buy" };
        if (overallFusion > -0.2 && overallFusion < 0.2) return { emoji:"⚪", label:"Neutral" };
        if (overallFusion <= -0.2 && overallFusion > -0.7) return { emoji:"🟧", label:"Sell" };
        return { emoji:"🟥", label:"Strong Sell" };
      })(),
      longs: allTargets.filter(t => t.tp > price).slice(0,4),
      shorts: allTargets.filter(t => t.tp < price).slice(0,4),
      allTargets,
      ml: { perTF: mlPerTF, fusion: mlFusion },
      stableTargets: stable,
      proMeters,
      mlAcc,
      news,
      buyProb: Number((((overallFusion + 1) / 2) * 100).toFixed(2)),
      sellProb: Number((100 - (((overallFusion + 1) / 2) * 100)).toFixed(2)),
      defaultSLLong: isNum(price) ? Number((price - (feat15?.atr || price*0.005) * 2).toFixed(8)) : null,
      defaultSLShort: isNum(price) ? Number((price + (feat15?.atr || price*0.005) * 2).toFixed(8)) : null
    };

    return report;
  } catch (e) {
    return { ok:false, error: e?.message || String(e) };
  }
}

/* ----------------- Formatter (UI you want) ----------------- */
export async function formatAIReport(r) {
  if (!r || !r.ok) return ["⚠ ERROR: " + (r?.error || "no data")];

  const time = nowIST(r.generatedAt);
  const price = nf(r.price, 2);

  const header = `
🔥 ${r.symbol} — AI Market Intelligence (v15.1 PRO)
🕒 ${time}
💰 Price: ${price}
━━━━━━━━━━━━━━━━━━
`;

  function tfBlock(tag) {
    const b = (r.blocks || []).find(x => x.tf === tag);
    if (!b) return `🕒 ${tag} — N/A\nN/A\n`;
    let sig = "⚪ NEUTRAL";
    if (b.fusionScore >= 0.7) sig = "🟩 STRONG BUY";
    else if (b.fusionScore >= 0.2) sig = "🟦 BUY";
    else if (b.fusionScore <= -0.7) sig = "🟥 STRONG SELL";
    else if (b.fusionScore <= -0.2) sig = "🔴 SELL";

    const ellPat = b.ell?.patterns?.[0]?.type || b.ell?.pattern || "N/A";
    const conf = Math.round(b.ellSummary?.confidence || 0);
    const tps = (b.targets || []).slice(0,3).map(t => nf(Number(t.tp),2)).join(" / ");
    const sl = "N/A";

    return `
🕒 ${tag} — ${sig}
RSI ${Math.round(b.indicators?.RSI || 0)} | MACD ${Math.round(b.indicators?.MACD?.hist || 0)} | Vol ${b.indicators?.volumeTrend || "N/A"} | ATR ${Math.round(b.indicators?.ATR || 0)}
Elliott: ${ellPat} | Conf ${conf}%
S: ${nf(b.ellSummary?.support)} | R: ${nf(b.ellSummary?.resistance)}
TP 🎯: ${tps || "N/A"}
SL: ${sl}
`;
  }

  const panel = `
📊 MULTI-TIMEFRAME PANEL
(Short | Clean | Cluster-Fusion)

${tfBlock("1m")}
${tfBlock("5m")}
${tfBlock("15m")}
${tfBlock("30m")}
${tfBlock("1h")}
━━━━━━━━━━━━━━━━━━
`;

  const overall = `
🧭 OVERALL BIAS
Bias: ${r.biasLabel?.emoji ?? "⚪"} ${r.biasLabel?.label ?? "Neutral"}
Fusion Score: ${nf(r.overallFusion,3)}
Buy ${nf(((r.overallFusion+1)*50),2)}% | Sell ${nf(100 - ((r.overallFusion+1)*50),2)}%
━━━━━━━━━━━━━━━━━━
`;

  const stable = r.stable || {};
  const stableBlock = `
🎯 STABLE AI TP (Fused 15m+30m+1h)
Primary TP: ${nf(stable.primaryTP)} (src:${stable.primarySource || "Cluster/ML"})
Hedge TP: ${nf(stable.hedgeTP)} (src:${stable.hedgeSource || "Cluster/ML"})
Confidence: ${stable.primaryConf ?? 0}%
Suggested SL: ${r.stable && r.stable.direction === "Bullish" ? nf(r.defaultSLLong) : nf(r.defaultSLShort)}
━━━━━━━━━━━━━━━━━━
`;

  const pro = r.proMeters || {};
  const proBlock = `
🪄 PRO METERS
Rebound probability: ${pro.rebound ?? "N/A"}  
Trend exhaustion: ${pro.exhaustion ?? "N/A"}  
Volatility crush: ${pro.volCrush ?? "N/A"}  
30-min pressure: ${JSON.stringify(pro.pressure || {})}
━━━━━━━━━━━━━━━━━━
`;

  const mlFusion = r.ml?.fusion || {};
  const mlAcc = r.mlAcc || { accuracy: 0 };

  const mlPerTFText = (() => {
    try {
      if (!Array.isArray(r.ml?.perTF) || !r.ml.perTF.length) return "No ML outputs";
      return r.ml.perTF.map(m => {
        const tf = m.tf || "?";
        const dir = m.direction || m.label || "Neutral";
        // v15.1 uses tpEstimate, tpEstimate might be present
        const tp = (m.tpEstimate !== undefined && m.tpEstimate !== null) ? nf(Number(m.tpEstimate),2) : (m.tp ? nf(m.tp,2) : "N/A");
        const maxProb = (m.maxProb !== undefined && m.maxProb !== null) ? m.maxProb : (m.probs ? Math.max(m.probs.bull||0,m.probs.bear||0) : "N/A");
        return `• ${tf}: ${dir} | TP:${tp} | maxProb:${maxProb}`;
      }).join("\n");
    } catch (e) { return "ML output error"; }
  })();

  const mlBlock = `
🤖 MACHINE LEARNING (per-TF + fused)
Direction (fused): ${mlFusion.direction || "Neutral"}
ML fused confidence: ${nf(mlFusion.confidence ?? 0,0)}%
ML accuracy (history): ${nf(mlAcc?.accuracy ?? 0,0)}%

ML per-TF snapshot:
${mlPerTFText}
━━━━━━━━━━━━━━━━━━
`;

  const news = r.news || {};
  const newsBlock = `
📰 NEWS IMPACT
Impact: ${news.impact || "Low"}
Sentiment: ${Math.round((news.sentiment || 0)*100)}%
Headline: *“${(news.items && news.items[0] && (news.items[0].title || news.items[0].text)) || news.headline || "No major news"}”*
━━━━━━━━━━━━━━━━━━
`;

  const full = header + panel + overall + stableBlock + proBlock + mlBlock + newsBlock;
  return splitParts([full]);
}

/* ----------------- Sender (example sendFunc expects async function that sends string) ----------------- */
export async function sendSplitReport(report, sendFunc) {
  const parts = await formatAIReport(report);
  for (const p of parts) await sendFunc(p);
  return true;
}

/* ----------------- Default Export ----------------- */
export default { buildAIReport, formatAIReport, sendSplitReport };