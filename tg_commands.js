// tg_commands.js — Option-B UI (per-TF compact blocks) + Elliott + ML integration
import TelegramBot from "node-telegram-bot-api";
import CONFIG from "./config.js";
import { fetchMultiTF } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";
// ML module (v8_6 as you named it)
import { runMLPrediction, runMicroPrediction, calculateAccuracy } from "./ml_module_v8_6.js";

// Telegram init
const BOT_TOKEN = CONFIG?.TELEGRAM?.BOT_TOKEN || process.env.BOT_TOKEN;
const CHAT_ID = CONFIG?.TELEGRAM?.CHAT_ID || process.env.CHAT_ID;
const bot = BOT_TOKEN ? new TelegramBot(BOT_TOKEN, { polling: false }) : null;

// Helper: safe number / readable
const nf = (v, d = 2) => (typeof v === "number" && Number.isFinite(v)) ? v.toFixed(d) : "N/A";
const bold = (s) => `<b>${s}</b>`;

// Fusion label mapping (Option B: Strong Buy / Buy / Neutral / Sell / Strong Sell)
function fusionLabel(score) {
  // score: -1 .. +1
  if (score >= 0.70) return { label: "Strong Buy", emoji: "🚀" };
  if (score >= 0.20) return { label: "Buy", emoji: "🟢" };
  if (score > -0.20 && score < 0.20) return { label: "Neutral", emoji: "⚪" };
  if (score <= -0.20 && score > -0.70) return { label: "Sell", emoji: "🔴" };
  return { label: "Strong Sell", emoji: "⛔" };
}

// Fusion scoring (simple normalized combination)
function computeFusionScore(indObj, ellObj) {
  // indObj: { RSI, MACD: {hist}, ATR, priceTrend, volumeTrend }
  // ellObj: { sentiment (-1..1) or scoring via analyzeElliott -> sentiment, confidence }
  let score = 0;
  let weight = 0;

  try {
    // RSI: bullish when >60, bearish <40, scale -1..1
    const rsi = Number(indObj?.RSI ?? 50);
    const rsiScore = ((rsi - 50) / 50); // -1..+1
    score += rsiScore * 0.4; weight += 0.4;

    // MACD hist sign: positive => bullish
    const macdh = Number(indObj?.MACD?.hist ?? 0);
    const macdScore = Math.tanh(macdh / Math.max(1, Math.abs(indObj?.ATR || 1))); // soft scale
    score += macdScore * 0.35; weight += 0.35;

    // Price trend small boost
    const pt = indObj?.priceTrend === "UP" ? 0.15 : indObj?.priceTrend === "DOWN" ? -0.15 : 0;
    score += pt; weight += 0.15;

    // Volume trend adjust
    const vt = (indObj?.volumeTrend === "INCREASING") ? 0.08 : (indObj?.volumeTrend === "DECREASING") ? -0.08 : 0;
    score += vt; weight += 0.08;

    // Elliott sentiment (from analyzeElliott -> sentiment: -1..1)
    const ellSent = Number(ellObj?.sentiment ?? 0);
    const ellConf = Math.min(1, Number(ellObj?.confidence ?? 0) / 100);
    score += ellSent * (0.25 * ellConf); weight += 0.25 * ellConf;

    // Normalize to -1..1
    const normalized = Math.max(-1, Math.min(1, score / Math.max(0.0001, weight)));
    return Number(normalized.toFixed(3));
  } catch (e) {
    return 0;
  }
}

// Compute overall fusion (weighted across timeframes)
function computeOverallFusion(mtf) {
  // assign weights by TF importance
  const weights = { "1m": 0.05, "5m": 0.1, "15m": 0.4, "30m": 0.2, "1h": 0.25 };
  let s = 0, wsum = 0;
  for (const m of mtf) {
    const score = Number(m.fusionScore ?? 0);
    const w = weights[m.tf] ?? 0.1;
    s += score * w;
    wsum += w;
  }
  const overall = wsum ? s / wsum : 0;
  return Number(Math.max(-1, Math.min(1, overall)).toFixed(3));
}

// Calculate buy/sell probabilities from fusion + ell signals
function computeBuySellProb(overallFusion, mtf) {
  // baseline from fusion: map -1..1 to 0..100 buy prob
  let buy = (overallFusion + 1) / 2 * 100; // 0..100
  let sell = 100 - buy;

  // boost from Elliott consensus: average ell.sentiment weighted by their confidences
  let ellSum = 0, ellW = 0;
  for (const m of mtf) {
    const ell = m.ell;
    if (ell && typeof ell.sentiment === "number" && typeof ell.confidence === "number") {
      const conf = Math.min(100, Math.max(0, ell.confidence));
      ellSum += ell.sentiment * (conf / 100);
      ellW += (conf / 100);
    }
  }
  const ellAvg = ellW ? (ellSum / ellW) : 0; // -1..1

  // nudge buy/sell by up to ±10% depending on ellAvg
  const nudge = ellAvg * 10; // -10 .. +10
  buy = buy + nudge;
  sell = 100 - buy;

  // also incorporate number of bullish vs bearish TFs (fusion sign majority)
  const bullishTFs = mtf.filter(m => (m.fusionScore ?? 0) > 0.2).length;
  const bearishTFs = mtf.filter(m => (m.fusionScore ?? 0) < -0.2).length;
  const biasDiff = bullishTFs - bearishTFs;
  if (biasDiff > 0) {
    buy += Math.min(8, biasDiff * 2); // small bonus
  } else if (biasDiff < 0) {
    sell += Math.min(8, Math.abs(biasDiff) * 2);
  }

  // clamp 0..100 and normalize
  buy = Math.max(0, Math.min(100, buy));
  sell = Math.max(0, Math.min(100, sell));
  // minor renormalize so sum=100
  const sum = buy + sell;
  if (sum > 0) {
    buy = Math.round((buy / sum) * 10000) / 100;
    sell = Math.round((sell / sum) * 10000) / 100;
  } else {
    buy = 50; sell = 50;
  }

  return { buy, sell, ellAvg: Number(ellAvg.toFixed(3)) };
}

// Build per-TF block string
function buildTFBlock(tf, price, ind, vol, ellSummary, fusionScore, fib) {
  const fusion = fusionLabel(fusionScore);
  const rsi = typeof ind.RSI === "number" ? ind.RSI.toFixed(1) : "N/A";
  const macd = typeof ind.MACD?.hist === "number" ? ind.MACD.hist.toFixed(4) : "N/A";
  const atr = typeof ind.ATR === "number" ? ind.ATR.toFixed(2) : "N/A";
  const volTxt = vol?.status || "N/A";

  // Trendlines compact (Option A): single-line resistance/support from pivots/ell
  const support = ellSummary?.support ? nf(ellSummary.support, 2) : (fib?.lo ? nf(fib.lo, 2) : "N/A");
  const resistance = ellSummary?.resistance ? nf(ellSummary.resistance, 2) : (fib?.hi ? nf(fib.hi, 2) : "N/A");

  return `
<b>【${tf.toUpperCase()}】 ${fusion.emoji} ${fusion.label}</b>
💰 Price: <b>${nf(price,2)}</b>  |  📊 Vol: ${volTxt}
RSI: <b>${rsi}</b> | MACD: <b>${macd}</b> | ATR: <b>${atr}</b>
Structure: support:${support} | resistance:${resistance}
Fusion Score: ${fusionScore}
`.trim();
}

// Build heatmap top row (compact)
function buildHeatmap(mtfData) {
  // Map per-tf fusion to color emoji
  const tfOrder = ["1m","5m","15m","30m","1h"];
  const mapEmoji = (s) => {
    if (s >= 0.7) return "🟩";
    if (s >= 0.2) return "🟦";
    if (s > -0.2 && s < 0.2) return "🟨";
    if (s <= -0.2 && s > -0.7) return "🟧";
    return "🟥";
  };
  const parts = tfOrder.map(tf => {
    const blk = mtfData.find(x => x.tf === tf);
    const score = blk ? blk.fusionScore ?? 0 : 0;
    return `${tf.toUpperCase()}:${mapEmoji(score)}`;
  });
  return `<b>Elliott MultiTF Heatmap</b>\n` + parts.join(" | ");
}

// Helper: safe call analyzeElliott and extract quick support/resistance from pivots
async function safeElliottForCandles(candles) {
  try {
    const ell = await analyzeElliott(candles);
    if (!ell || !ell.ok) return { ok:false, error: ell?.error || "elliott_err" };
    // build simple support/res from last pivots: use last wave pivots
    const pivots = ell.pivots || [];
    const lastHigh = pivots.filter(p=>p.type==='H').slice(-1)[0];
    const lastLow = pivots.filter(p=>p.type==='L').slice(-1)[0];
    const support = lastLow ? lastLow.price : null;
    const resistance = lastHigh ? lastHigh.price : null;
    return { ok:true, ell, support, resistance };
  } catch (e) {
    return { ok:false, error: e.message || String(e) };
  }
}

// Helper: pick TP confidence for a target
function resolveTargetConfidence(target, ell) {
  // prefer explicit confidence reported by Elliott target or pattern
  if (target && typeof target.confidence === "number") return Math.max(0, Math.min(100, target.confidence));
  // fallback to ell global confidence
  if (ell && typeof ell.confidence === "number") return Math.max(0, Math.min(100, ell.confidence));
  // final heuristic: use 40 + (abs(fusionScore)*60) in caller when needed
  return null;
}

// ========== Public: buildAIReport ==========
export async function buildAIReport(symbol = "BTCUSDT", context = null) {
  try {
    // fetch multi-TF data
    const tfs = ["1m","5m","15m","30m","1h"];
    const mtfRaw = await fetchMultiTF(symbol, tfs);
    const mtf = [];

    // gather per-tf analysis
    for (const tf of tfs) {
      const entry = mtfRaw[tf] || { data: [], price: 0 };
      const candles = entry.data || [];
      const price = (typeof entry.price === "number" && entry.price) ? entry.price : (candles?.at(-1)?.close ?? 0);

      // indicators (use core_indicators API; ensure functions exist in your core_indicators)
      const ind = {
        RSI: indicators.computeRSI ? indicators.computeRSI(candles) : (indicators.computeRSI_fromCandles ? indicators.computeRSI_fromCandles(candles) : 50),
        MACD: indicators.computeMACD ? indicators.computeMACD(candles) : { hist: 0, line:0, signal:0 },
        ATR: indicators.computeATR ? indicators.computeATR(candles) : 0,
        priceTrend: (candles.length >= 2) ? (candles.at(-1).close > candles.at(-2).close ? "UP" : (candles.at(-1).close < candles.at(-2).close ? "DOWN" : "FLAT")) : "FLAT",
        volumeTrend: indicators.volumeTrend ? indicators.volumeTrend(candles) : "STABLE"
      };

      const vol = indicators.analyzeVolume ? indicators.analyzeVolume(candles) : { status: "UNKNOWN", strength: 0 };

      // elliott (safe)
      const ellRes = await safeElliottForCandles(candles);
      const ell = ellRes.ok ? ellRes.ell : null;

      // fibs (use computeFibLevels which expects candles) - safe fallback names
      let fib = null;
      try {
        if (typeof indicators.computeFibLevels === "function") fib = indicators.computeFibLevels(candles);
        else if (typeof indicators.computeFibLevelsFromCandles === "function") fib = indicators.computeFibLevelsFromCandles(candles);
        else fib = null;
      } catch (e) { fib = null; }

      // compute fusion score (indicators + ell)
      const fusionScore = computeFusionScore(ind, ell || { sentiment: 0, confidence: 0 });

      // quick targets from Elliott module (if available)
      const rawTargets = (ell && Array.isArray(ell.targets)) ? ell.targets.slice(0,5) : [];

      // annotate target confidences
      const targets = rawTargets.map(t => {
        const conf = resolveTargetConfidence(t, ell);
        return Object.assign({}, t, { confidence: conf });
      });

      mtf.push({
        tf, price, candles,
        indicators: ind, vol,
        ell, ellSummary: { support: ellRes?.support || null, resistance: ellRes?.resistance || null },
        fib, fusionScore, targets
      });
    }

    // compute overall fusion + buy/sell probabilities
    const overallFusion = computeOverallFusion(mtf);
    const probs = computeBuySellProb(overallFusion, mtf);

    // assemble top-level summary
    const generatedAt = new Date().toISOString();
    const price = mtf.find(x=>x.tf==="15m")?.price || mtf[0]?.price || 0;

    // aggregate top targets (dedupe by approximate price)
    const allTargets = mtf.flatMap(m => (m.targets || []).map(t => ({ ...t, tf: m.tf })));
    // dedupe by rounding
    const uniqMap = new Map();
    for (const t of allTargets) {
      const key = Math.round((t.tp || t.target || t?.price || 0));
      if (!uniqMap.has(key)) uniqMap.set(key, t);
      else {
        // merge confidences preferring higher
        const prev = uniqMap.get(key);
        const best = (t.confidence || 0) > (prev.confidence || 0) ? t : prev;
        uniqMap.set(key, best);
      }
    }
    const uniqTargets = Array.from(uniqMap.values()).slice(0, 6);

    // produce TP list with confidence: if missing, heuristicize via fusion+ell
    const annotatedTargets = uniqTargets.map(t => {
      let conf = t.confidence;
      if (conf == null) {
        // heuristic: base 40 + abs(overallFusion)*40 + (ell.confidence*0.2)
        const ellConfAvg = mtf.reduce((acc,m)=>acc + (m.ell?.confidence||0),0) / Math.max(1, mtf.length);
        conf = Math.round(Math.max(10, Math.min(99, 40 + Math.abs(overallFusion) * 40 + (ellConfAvg * 0.2))));
      }
      return Object.assign({}, t, { confidence: Math.round(conf) });
    });

    // === ML Integration: attempt to run ML predictions & micro watchers ===
    let mlMain = null;
    let mlMicro5 = null;
    let mlMicro1 = null;
    let mlAccuracy = null;
    try {
      if (typeof runMLPrediction === "function") {
        mlMain = await runMLPrediction(symbol);
      }
    } catch (e) {
      mlMain = { error: e?.message || String(e) };
    }
    try {
      if (typeof runMicroPrediction === "function") {
        mlMicro5 = await runMicroPrediction(symbol, "5m");
        mlMicro1 = await runMicroPrediction(symbol, "1m");
      }
    } catch (e) {
      // best-effort, swallow errors
      if (!mlMicro5) mlMicro5 = { error: e?.message || String(e) };
      if (!mlMicro1) mlMicro1 = { error: e?.message || String(e) };
    }
    try {
      if (typeof calculateAccuracy === "function") {
        mlAccuracy = await calculateAccuracy();
      }
    } catch (e) {
      mlAccuracy = { error: e?.message || String(e) };
    }

    return {
      ok: true,
      symbol,
      price,
      mtf,
      overallFusion,
      buyProb: probs.buy,
      sellProb: probs.sell,
      ellConsensus: probs.ellAvg,
      annotatedTargets,
      ml: { main: mlMain, micro5: mlMicro5, micro1: mlMicro1, accuracy: mlAccuracy },
      generatedAt
    };
  } catch (e) {
    return { ok:false, error: e.message || String(e) };
  }
}

// ========== Public: formatAIReport ==========
export async function formatAIReport(report) {
  try {
    if (!report || !report.ok) {
      const txt = `Error building report: ${report?.error || "unknown"}`;
      if (bot && CHAT_ID) try { await bot.sendMessage(CHAT_ID, txt); } catch {}
      return txt;
    }

    const price = Number(report.price || 0);
    const mtf = report.mtf || [];

    // Heatmap
    const heat = buildHeatmap(mtf);

    // Per-TF blocks assembled into single body but per-TF (Option-B: one block per TF)
    const tfBlocks = mtf.map(m => {
      const block = buildTFBlock(m.tf, m.price, m.indicators || {}, m.vol || {}, m.ellSummary || {}, m.fusionScore || 0, m.fib || null);
      return block;
    }).join("\n\n──────────────\n\n");

    // Elliott summary
    let ellSummaryText = "Elliott: N/A (placeholder)";
    const firstEll = mtf.find(m => m.ell && (m.ell.patterns?.length || m.ell.targets?.length));
    if (firstEll && firstEll.ell) {
      const conf = firstEll.ell.confidence ?? firstEll.ell.conf ?? 0;
      ellSummaryText = `Elliott MultiTF (best): Conf ${conf}% | Patterns: ${firstEll.ell.patterns?.length || 0}`;
    }

    // TP/SL — combine annotated targets (show top 3 longs and top 3 shorts by confidence)
    const targets = report.annotatedTargets || [];

    // Extract numeric TP cleanly
function getTP(t) {
  return Number(t.tp || t.target || t.price || 0);
}

// LONG = TP > price AND pattern bullish
const longs = targets
  .filter(t => {
    const tp = getTP(t);
    return tp > price;
  })
  .sort((a,b)=> b.confidence - a.confidence);

// SHORT = TP < price OR Elliott pattern type is bearish
const shorts = targets
  .filter(t => {
    const tp = getTP(t);
    const type = (t.source || t.type || t.label || "").toLowerCase();

    if (tp < price) return true;
    if (type.includes("short") || type.includes("bear") || type.includes("down")) return true;

    return false;
  })
  .sort((a,b)=> b.confidence - a.confidence);



    // Overall bias / strength
    const overallFusion = Number(report.overallFusion ?? 0);
    const biasLabel = fusionLabel(overallFusion).label;
    const biasEmoji = fusionLabel(overallFusion).emoji;
    const buyProb = Number(report.buyProb ?? 0);
    const sellProb = Number(report.sellProb ?? 0);

    // ===== ML SUMMARY (placed immediately after targets) =====
    const ml = report.ml || {};
    let mlText = "ML: Placeholder (module not available)";
    try {
      const main = ml.main;
      const micro5 = ml.micro5;
      const micro1 = ml.micro1;
      const acc = ml.accuracy;

      const mainProb = main && typeof main.prob === "number" ? `${main.prob}%` : (main?.prob ?? "N/A");
      const mainLabel = main?.label || (main?.error ? "Error" : "Neutral");

      const micro5Prob = micro5 && typeof micro5.prob === "number" ? `${micro5.prob}%` : (micro5?.prob ?? "N/A");
      const micro1Prob = micro1 && typeof micro1.prob === "number" ? `${micro1.prob}%` : (micro1?.prob ?? "N/A");

      const accText = acc && typeof acc.accuracy === "number" ? `${acc.accuracy}% (last ${acc.total || "N/A"})` : (acc?.accuracy ?? "N/A");

      mlText = `
🤖 ML Prediction:
Label: <b>${mainLabel}</b>
ML Prob (15m): <b>${mainProb}</b>
Micro (5m): ${micro5Prob} | Micro (1m): ${micro1Prob}
Combined Confidence (heuristic): <b>${Math.round(((Number(main?.prob||0) + Number(micro5?.prob||0)*0.5 + Number(micro1?.prob||0)*0.3)/ ( (main?.prob?1:0) + (micro5?.prob?0.5:0) + (micro1?.prob?0.3:0) || 1) )*100)/100 || 0}%</b>
Accuracy (recorded): ${accText}
      `.trim();
    } catch (e) {
      mlText = "ML: error generating summary";
    }

    // Final HTML message (old-premium style but per-TF blocks)
    const html = `
🚀 <b>${report.symbol} — AI Trader (single-file, Option-B UI)</b>
${new Date(report.generatedAt).toLocaleString()}
Source: Multi (Binance Vision + Backups)
Price: <b>${nf(price,2)}</b>

${heat}

📈 <b>Elliott Overview</b>
${ellSummaryText}

────────────────────
<b>📊 Multi-Timeframe Analysis</b>

${tfBlocks}

────────────────────
🧠 <b>Fusion Summary</b>
Overall Bias: ${biasEmoji} <b>${biasLabel}</b> | Strength(Fusion): ${overallFusion}
Buy Prob: <b>${buyProb}%</b> | Sell Prob: <b>${sellProb}%</b>

🎯 <b>LONG Targets (confidence)</b>
${topLongs}

🎯 <b>SHORT Targets (confidence)</b>
${topShorts}

${mlText}

📐 Fib Zone (15m): ${ (mtf.find(x=>x.tf==='15m')?.fib) ? `${nf(mtf.find(x=>x.tf==='15m').fib.lo,2)} - ${nf(mtf.find(x=>x.tf==='15m').fib.hi,2)}` : "N/A" }

📰 News Impact: Placeholder (hook your news module)
ML: integrated above (hook your ml_module_v8_6 for live predictions)

<i>Data: Multi-source (Binance Vision + Binance + Bybit/KuCoin/CB) | vSingleFile | UI: Option-B per TF</i>
`.trim();

    // send to Telegram if configured
    if (bot && CHAT_ID) {
      try {
        await bot.sendMessage(CHAT_ID, html, { parse_mode: "HTML", disable_web_page_preview: true });
      } catch (e) {
        console.error("Telegram send failed:", e?.message || e);
      }
    }

    return html;
  } catch (e) {
    const err = `formatAIReport error: ${e?.message || e}`;
    console.error(err);
    return err;
  }
}

// exports

export default { buildAIReport, formatAIReport };