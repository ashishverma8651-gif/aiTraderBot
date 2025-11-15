// tg_commands.js — AI Trader (Option-B UI) + Elliott + Fusion + ML v3 (ML Bias + ML TP) + News (Adaptive Option D)

// PART 1 of 3
import TelegramBot from "node-telegram-bot-api";
import CONFIG from "./config.js";
import { fetchMultiTF } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";

// ML Module (v8_6)
import {
  runMLPrediction,
  runMicroPrediction,
  calculateAccuracy,
  recordPrediction,
  recordOutcome
} from "./ml_module_v8_6.js";

// News module (news_social.js — provides fetchNewsBundle(symbol))
import newsModule from "./news_social.js";

// ==========================
// Telegram Init
// ==========================
const BOT_TOKEN = CONFIG?.TELEGRAM?.BOT_TOKEN || process.env.BOT_TOKEN;
const CHAT_ID = CONFIG?.TELEGRAM?.CHAT_ID || process.env.CHAT_ID;
const bot = BOT_TOKEN ? new TelegramBot(BOT_TOKEN, { polling: false }) : null;

// ==========================
// Helpers
// ==========================
const nf = (v, d = 2) =>
  (typeof v === "number" && Number.isFinite(v)) ? v.toFixed(d) : "N/A";

function clamp(v, lo = -1, hi = 1) {
  return Math.max(lo, Math.min(hi, v));
}

// Fusion label mapping
function fusionLabel(score) {
  if (score >= 0.70) return { label: "Strong Buy", emoji: "🚀" };
  if (score >= 0.20) return { label: "Buy", emoji: "🟢" };
  if (score > -0.20 && score < 0.20) return { label: "Neutral", emoji: "⚪" };
  if (score <= -0.20 && score > -0.70) return { label: "Sell", emoji: "🔴" };
  return { label: "Strong Sell", emoji: "⛔" };
}

// ==========================
// Fusion Scoring (Indicators + Elliott)
// ==========================
function computeFusionScore(indObj, ellObj) {
  let score = 0;
  let weight = 0;
  try {
    const rsi = Number(indObj?.RSI ?? 50);
    const rsiScore = ((rsi - 50) / 50); // -1..1
    score += rsiScore * 0.4; weight += 0.4;

    const macdh = Number(indObj?.MACD?.hist ?? 0);
    const macdScore = Math.tanh(macdh / Math.max(1, Math.abs(indObj?.ATR || 1)));
    score += macdScore * 0.35; weight += 0.35;

    const pt = indObj?.priceTrend === "UP" ? 0.15 : indObj?.priceTrend === "DOWN" ? -0.15 : 0;
    score += pt; weight += 0.15;

    const vt = (indObj?.volumeTrend === "INCREASING") ? 0.08 : (indObj?.volumeTrend === "DECREASING") ? -0.08 : 0;
    score += vt; weight += 0.08;

    const ellSent = Number(ellObj?.sentiment ?? 0);
    const ellConf = Math.min(1, Number(ellObj?.confidence ?? 0) / 100);
    score += ellSent * (0.25 * ellConf); weight += 0.25 * ellConf;

    const normalized = Math.max(-1, Math.min(1, score / Math.max(0.0001, weight)));
    return Number(normalized.toFixed(3));
  } catch (e) {
    return 0;
  }
}

// ==========================
// Compute overall fusion
// ==========================
function computeOverallFusion(mtf) {
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

// ==========================
// Buy/Sell Probability
// ==========================
function computeBuySellProb(overallFusion, mtf) {
  let buy = (overallFusion + 1) / 2 * 100; // 0..100
  let sell = 100 - buy;

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

  const nudge = ellAvg * 10; // -10..10
  buy = buy + nudge;
  sell = 100 - buy;

  // TF bias
  const bullishTFs = mtf.filter(m => (m.fusionScore ?? 0) > 0.2).length;
  const bearishTFs = mtf.filter(m => (m.fusionScore ?? 0) < -0.2).length;
  const biasDiff = bullishTFs - bearishTFs;
  if (biasDiff > 0) buy += Math.min(8, biasDiff * 2);
  else if (biasDiff < 0) sell += Math.min(8, Math.abs(biasDiff) * 2);

  buy = Math.max(0, Math.min(100, buy));
  sell = Math.max(0, Math.min(100, sell));

  // normalize
  const sum = buy + sell;
  if (sum > 0) {
    buy = Math.round((buy / sum) * 10000) / 100;
    sell = Math.round((sell / sum) * 10000) / 100;
  } else { buy = 50; sell = 50; }

  return { buy, sell, ellAvg: Number(ellAvg.toFixed(3)) };
}

// ==========================
// TF Block Builder
// ==========================
function buildTFBlock(tf, price, ind, vol, ellSummary, fusionScore, fib) {
  const fusion = fusionLabel(fusionScore);
  const rsi = typeof ind.RSI === "number" ? ind.RSI.toFixed(1) : "N/A";
  const macd = typeof ind.MACD?.hist === "number" ? ind.MACD.hist.toFixed(4) : "N/A";
  const atr = typeof ind.ATR === "number" ? ind.ATR.toFixed(2) : "N/A";
  const volTxt = vol?.status || "N/A";
  const support = ellSummary?.support ? nf(ellSummary.support, 2) : (fib?.lo ? nf(fib.lo, 2) : "N/A");
  const resistance = ellSummary?.resistance ? nf(ellSummary.resistance, 2) : (fib?.hi ? nf(fib.hi, 2) : "N/A");

  return `
<b>【${tf.toUpperCase()}】 ${fusion.emoji} ${fusion.label}</b>
💰 Price: <b>${nf(price,2)}</b> | 📊 Vol: ${volTxt}
RSI: <b>${rsi}</b> | MACD: <b>${macd}</b> | ATR: <b>${atr}</b>
Structure: support:${support} | resistance:${resistance}
Fusion Score: ${fusionScore}
`.trim();
}

// ==========================
// Heatmap
// ==========================
function buildHeatmap(mtfData) {
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

// ==========================
// Elliott support/resistance extractor
// ==========================
async function safeElliottForCandles(candles) {
  try {
    const ell = await analyzeElliott(candles);
    if (!ell || !ell.ok) return { ok:false, error: ell?.error || "elliott_err" };
    const pivots = ell.pivots || [];
    const lastHigh = pivots.filter(p=>p.type==='H').slice(-1)[0];
    const lastLow = pivots.filter(p=>p.type==='L').slice(-1)[0];
    const support = lastLow ? lastLow.price : null;
    const resistance = lastHigh ? lastHigh.price : null;
    return { ok:true, ell, support, resistance };
  } catch (e) {
    return { ok:false, error: e?.message || String(e) };
  }
}

// ==========================
// resolve target confidence
// ==========================
function resolveTargetConfidence(t, ell) {
  if (t && typeof t.confidence === "number") return Math.max(0, Math.min(100, t.confidence));
  if (ell && typeof ell.confidence === "number") return Math.max(0, Math.min(100, ell.confidence));
  return null;
}

// ==========================
// helper: getTP numeric
// ==========================
function getTPval(t) {
  return Number(t.tp || t.target || t.price || 0);
}

// PART 2 of 3
// ============================================================
// 🚀 MAIN ENGINE — buildAIReport()
// ============================================================
export async function buildAIReport(symbol = "BTCUSDT") {
  try {
    const tfs = ["1m","5m","15m","30m","1h"];
    const mtfRaw = await fetchMultiTF(symbol, tfs);
    const mtf = [];

    // per-TF analysis
    for (const tf of tfs) {
      const entry = mtfRaw[tf] || { data: [], price: 0 };
      const candles = entry.data || [];
      const price = (typeof entry.price === "number" && entry.price) ? entry.price : (candles?.at(-1)?.close ?? 0);

      const ind = {
        RSI: indicators.computeRSI ? indicators.computeRSI(candles) : (indicators.computeRSI_fromCandles ? indicators.computeRSI_fromCandles(candles) : 50),
        MACD: indicators.computeMACD ? indicators.computeMACD(candles) : { hist: 0, line:0, signal:0 },
        ATR: indicators.computeATR ? indicators.computeATR(candles) : 0,
        priceTrend: (candles.length >= 2) ? (candles.at(-1).close > candles.at(-2).close ? "UP" : (candles.at(-1).close < candles.at(-2).close ? "DOWN" : "FLAT")) : "FLAT",
        volumeTrend: indicators.volumeTrend ? indicators.volumeTrend(candles) : "STABLE"
      };

      const vol = indicators.analyzeVolume ? indicators.analyzeVolume(candles) : { status: "UNKNOWN", strength: 0 };

      const ellRes = await safeElliottForCandles(candles);
      const ell = ellRes.ok ? ellRes.ell : null;

      let fib = null;
      try {
        if (typeof indicators.computeFibLevels === "function") fib = indicators.computeFibLevels(candles);
        else if (typeof indicators.computeFibLevelsFromCandles === "function") fib = indicators.computeFibLevelsFromCandles(candles);
        else fib = null;
      } catch (e) { fib = null; }

      const fusionScore = computeFusionScore(ind, ell || { sentiment: 0, confidence: 0 });

      const rawTargets = (ell && Array.isArray(ell.targets)) ? ell.targets.slice(0,5) : [];
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
    let overallFusion = computeOverallFusion(mtf);
    const probs = computeBuySellProb(overallFusion, mtf);

    const price = mtf.find(x=>x.tf==="15m")?.price || mtf[0]?.price || 0;

    // aggregate targets
    const allTargets = mtf.flatMap(m => (m.targets || []).map(t => ({ ...t, tf: m.tf })));

    // ML Prediction (15m)
    let ml = null;
    try { ml = await runMLPrediction(symbol, "15m"); } catch (e) { ml = { error: e?.message || "ml_error" }; }

    // ML accuracy
    let mlAcc = 0;
    try { const acc = calculateAccuracy(); mlAcc = acc?.accuracy ?? 0; } catch (e) { mlAcc = 0; }

    // News fetch (news_social.fetchNewsBundle)
    let news = null;
    try { news = await newsModule.fetchNewsBundle(symbol); } catch (e) { news = { ok: false, sentiment: 0.5, impact: "Low", items: [] }; }

    // =====================================================
    // Adaptive weighting (Option D)
    // - ML weight stays (0.25)
    // - News weight: High=>0.40, Moderate=>0.25, Low=>0.10
    // - news sentiment: 0..1 => convert to -1..1 via (sentiment-0.5)*2
    // =====================================================
    const mlWeight = 0.25;
    let newsWeight = 0.10;
    const impact = (news && news.impact) ? (""+news.impact).toLowerCase() : "low";
    if (impact === "high") newsWeight = 0.40;
    else if (impact === "moderate") newsWeight = 0.25;
    else newsWeight = 0.10;

    // ml bias from label
    let mlBias = 0;
    if (ml?.label === "Bullish") mlBias = +1;
    else if (ml?.label === "Bearish") mlBias = -1;

    // apply ML boost
    let boosted = clamp(overallFusion + mlBias * mlWeight, -1, 1);

    // news bias
    const newsSent = (news && typeof news.sentiment === "number") ? news.sentiment : 0.5; // 0..1
    const newsBias = ((newsSent - 0.5) * 2); // -1..1
    boosted = clamp(boosted + newsBias * newsWeight, -1, 1);

    overallFusion = Number(boosted.toFixed(3));

    // recompute buy/sell using boosted fusion (we'll keep original mtf for TF counts)
    const probsBoosted = computeBuySellProb(overallFusion, mtf);

    // dedupe targets by rounded price
    const uniqMap = new Map();
    for (const t of allTargets) {
      const key = Math.round(getTPval(t));
      if (!uniqMap.has(key)) uniqMap.set(key, t);
      else {
        const prev = uniqMap.get(key);
        const best = (t.confidence || 0) > (prev.confidence || 0) ? t : prev;
        uniqMap.set(key, best);
      }
    }
    const uniqTargets = Array.from(uniqMap.values()).slice(0, 6);

    // annotate confidences if missing
    const annotatedTargets = uniqTargets.map(t => {
      let conf = t.confidence;
      if (conf == null) {
        const ellConfAvg = mtf.reduce((acc,m)=>acc + (m.ell?.confidence||0),0) / Math.max(1, mtf.length);
        conf = Math.round(Math.max(10, Math.min(99, 40 + Math.abs(overallFusion) * 40 + (ellConfAvg * 0.2))));
      }
      return Object.assign({}, t, { confidence: Math.round(conf) });
    });

    // longs/shorts using TP logic (TP numeric compared to price)
    const longs = annotatedTargets.filter(t => getTPval(t) > price).sort((a,b)=>b.confidence - a.confidence);
    const shorts = annotatedTargets.filter(t => getTPval(t) < price).sort((a,b)=>b.confidence - a.confidence);

    // ML-driven TP selection (highest confidence matching side)
    function pickMLTP(list, mode) {
      if (!Array.isArray(list) || !list.length) return null;
      if (mode === "long") return list.filter(t => getTPval(t) > price).sort((a,b)=>b.confidence - a.confidence)[0] || null;
      if (mode === "short") return list.filter(t => getTPval(t) < price).sort((a,b)=>b.confidence - a.confidence)[0] || null;
      return null;
    }
    const mlLongTP = pickMLTP(annotatedTargets, "long");
    const mlShortTP = pickMLTP(annotatedTargets, "short");

    // final assembled report
    return {
      ok: true,
      symbol,
      price,
      mtf,
      overallFusion,
      buyProb: probsBoosted.buy,
      sellProb: probsBoosted.sell,
      ellConsensus: probsBoosted.ellAvg,
      annotatedTargets,
      longs,
      shorts,
      ml,
      mlAcc,
      mlDirection: ml?.label || "Neutral",
      mlLongTP,
      mlShortTP,
      news,          // include news bundle
      newsWeight,
      mlWeight,
      generatedAt: new Date().toISOString()
    };

  } catch (e) {
    return { ok:false, error: e?.message || String(e) };
  }
}

// PART 3 of 3
// ============================================================
// 🚀 formatAIReport()
// ============================================================
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

    // TF Blocks
    const tfBlocks = mtf
      .map(m =>
        buildTFBlock(
          m.tf,
          m.price,
          m.indicators || {},
          m.vol || {},
          m.ellSummary || {},
          m.fusionScore || 0,
          m.fib || null
        )
      )
      .join("\n\n──────────────\n\n");

    // Elliott Summary
    let ellSummaryText = "Elliott: N/A";
    const firstEll = mtf.find(
      m =>
        m.ell &&
        ((m.ell.patterns && m.ell.patterns.length) ||
          (m.ell.targets && m.ell.targets.length))
    );
    if (firstEll && firstEll.ell) {
      const conf = firstEll.ell.confidence ?? firstEll.ell.conf ?? 0;
      ellSummaryText = `Elliott MultiTF (best): Conf ${conf}% | Patterns: ${
        firstEll.ell.patterns?.length || 0
      } | Targets: ${firstEll.ell.targets?.length || 0}`;
    }

    // Target Lists
    const topLongs =
      (report.longs || [])
        .slice(0, 3)
        .map(
          (t, i) =>
            `TP${i + 1}: ${nf(getTPval(t), 2)} (${
              t.source || t.tf || "Elliott"
            }) [${t.confidence}%]`
        )
        .join(" | ") || "n/a";

    const topShorts =
      (report.shorts || [])
        .slice(0, 3)
        .map(
          (t, i) =>
            `TP${i + 1}: ${nf(getTPval(t), 2)} (${
              t.source || t.tf || "Elliott"
            }) [${t.confidence}%]`
        )
        .join(" | ") || "n/a";

    // ML TP Text
    let mlTPtxt = "n/a";
    if (report.mlDirection?.toLowerCase().includes("bull")) {
      mlTPtxt = report.mlLongTP
        ? `${nf(getTPval(report.mlLongTP), 2)} [${
            report.mlLongTP.confidence
          }%]`
        : "n/a";
    } else if (report.mlDirection?.toLowerCase().includes("bear")) {
      mlTPtxt = report.mlShortTP
        ? `${nf(getTPval(report.mlShortTP), 2)} [${
            report.mlShortTP.confidence
          }%]`
        : "n/a";
    }

    // News Section
    let newsTxt = "News: N/A";
    if (report.news) {
      const n = report.news;
      const sentPct = (typeof n.sentiment === "number")
        ? Math.round(n.sentiment * 1000) / 10
        : "N/A";
      newsTxt = `📰 <b>News</b> | Impact: ${n.impact} | Sentiment: ${sentPct}% | Items: ${n.items?.length || 0}
Top: ${
        n.items && n.items[0]
          ? n.items[0].title ||
            n.items[0].text ||
            n.items[0].link ||
            "—"
          : "—"
      }`;
    }

    // SL using ATR(15m)
    const tf15 = mtf.find(x => x.tf === "15m");
    const atr15 = tf15?.indicators?.ATR || (tf15?.price ? Number(tf15.price) * 0.005 : null);
    let slLong = "n/a",
      slShort = "n/a";
    if (atr15) {
      slLong = nf(price - atr15 * 2, 2);
      slShort = nf(price + atr15 * 2, 2);
    }

    // Fusion Label
    const overallFusion = Number(report.overallFusion ?? 0);
    const fusionLbl = fusionLabel(overallFusion);

    // Main Output HTML (Premium UI)
    const html = `
🚀 <b>${report.symbol} — AI Trader (Option-B Premium)</b>
${new Date(report.generatedAt).toLocaleString()}
Price: <b>${nf(price, 2)}</b>

${heat}

📈 <b>Elliott Overview</b>
${ellSummaryText}

────────────────────
<b>📊 Multi-Timeframe Analysis</b>

${tfBlocks}

────────────────────
🧠 <b>Fusion Summary</b>
Overall Bias: ${fusionLbl.emoji} <b>${fusionLbl.label}</b>
Fusion Score: ${overallFusion}
Buy Prob: <b>${report.buyProb}%</b> | Sell Prob: <b>${report.sellProb}%</b>
ML Weight: ${report.mlWeight} | News Weight: ${report.newsWeight}

${newsTxt}

────────────────────
🎯 <b>LONG Targets</b>
${topLongs}
SL (long): ${slLong}

🎯 <b>SHORT Targets</b>
${topShorts}
SL (short): ${slShort}

📐 Fib Zone (15m): ${
      tf15?.fib
        ? nf(tf15.fib.lo, 2) + " - " + nf(tf15.fib.hi, 2)
        : "N/A"
    }

────────────────────
🤖 <b>ML Prediction</b>
Label: <b>${report.ml?.label || "N/A"}</b>
Probability: ${report.ml?.prob || 0}%
Direction: <b>${report.mlDirection}</b>
ML Target: ${mlTPtxt}
Accuracy: ${report.mlAcc}%


<i>AI Engine v3.0 — Elliott + Fusion + ML v8.6 + News AI v3 (Adaptive)</i>
`.trim();

  

// return html;
} catch (e) {
    const err = `formatAIReport error: ${e.message}`;
    console.error(err);
    return err;
}
}

export default { buildAIReport, formatAIReport };


  

