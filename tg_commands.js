// tg_commands.js — FINAL FIX (100% compatible with ml_module_v8_6.js V12 Ultra)

import CONFIG from "./config.js";
import ML from "./ml_module_v8_6.js";    // V12 Ultra (kept filename per request)
import News from "./news_social.js";

import { fetchMultiTF } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";

const { runMLPrediction, runMicroPrediction, calculateAccuracy } = ML;
const { fetchNewsBundle } = News;

const MAX_TG_CHARS = 3800;
const IS_INDIA = { locale: "en-IN", hour12: true, timeZone: "Asia/Kolkata" };

const nf = (v, d = 2) => (typeof v === "number" && Number.isFinite(v)) ? Number(v).toFixed(d) : "N/A";
const isNum = v => typeof v === "number" && Number.isFinite(v);
const clamp = (v, a = -1, b = 1) => Math.max(a, Math.min(b, v));
const ellipsis = (s, n = 120) => (typeof s === "string" && s.length > n ? s.slice(0, n - 1) + "…" : (s || ""));

function nowIST(iso) {
  try {
    const d = iso ? new Date(iso) : new Date();
    return d.toLocaleString("en-IN", IS_INDIA);
  } catch {
    return new Date().toString();
  }
}

// Safe splitting for Telegram
function splitIntoSafeParts(blocks, maxChars = MAX_TG_CHARS) {
  const parts = [];
  let cur = "";
  for (const b of blocks) {
    if (!b) continue;
    if (b.length >= maxChars) {
      const paras = b.split("\n\n");
      for (const p of paras) {
        if ((cur.length + p.length + 2) < maxChars) {
          cur = cur ? cur + "\n\n" + p : p;
        } else {
          if (cur) { parts.push(cur); cur = ""; }
          if (p.length < maxChars) cur = p;
          else {
            for (let i = 0; i < p.length; i += (maxChars - 200)) {
              parts.push(p.slice(i, i + maxChars - 200));
            }
            cur = "";
          }
        }
      }
      continue;
    }
    if ((cur.length + b.length + 4) < maxChars) {
      cur = cur ? cur + "\n\n" + b : b;
    } else {
      if (cur) parts.push(cur);
      cur = b;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}



// ============================================================================
//                   BUILD AI REPORT  — MAIN ENGINE
// ============================================================================

export async function buildAIReport(symbol = CONFIG.SYMBOL || "BTCUSDT", opts = {}) {
  try {
    const tfs = opts.tfs?.length ? opts.tfs : ["1m", "5m", "15m", "30m", "1h"];
    const mtfRaw = await fetchMultiTF(symbol, tfs);

    const blocks = [];

    // TF block builder
    for (const tf of tfs) {
      const entry = mtfRaw[tf] || { data: [], price: 0 };
      const candles = Array.isArray(entry.data) ? entry.data : [];

      const price = isNum(entry.price) ? entry.price : (candles?.at(-1)?.close ?? 0);

      const ind = {
        RSI: indicators.computeRSI?.(candles) ?? 50,
        MACD: indicators.computeMACD?.(candles) ?? { hist: 0 },
        ATR: indicators.computeATR?.(candles) ?? 0,
        priceTrend:
          candles.length >= 2
            ? candles.at(-1).close > candles.at(-2).close
              ? "UP"
              : candles.at(-1).close < candles.at(-2).close
                ? "DOWN"
                : "FLAT"
            : "FLAT",
        volumeTrend: indicators.volumeTrend?.(candles) ?? "STABLE",
      };

      const vol = indicators.analyzeVolume?.(candles) ?? { status: "N/A", strength: 0 };

      // Elliott
      let ell = null;
      try { ell = await analyzeElliott(candles); } catch { ell = null; }

      const ellSummary = (() => {
        try {
          const pivots = ell?.pivots || [];
          const lastLow = [...pivots].reverse().find(p => p.type === "L");
          const lastHigh = [...pivots].reverse().find(p => p.type === "H");
          return {
            support: lastLow?.price ?? null,
            resistance: lastHigh?.price ?? null,
            confidence: ell?.confidence ?? 0
          };
        } catch {
          return { support: null, resistance: null, confidence: 0 };
        }
      })();

      // TP extraction
      let targets = [];
      if (ell?.targets?.length) {
        targets = ell.targets
          .map(t => ({
            tp: Number(t.tp ?? t.price ?? 0),
            confidence: Number(t.confidence ?? ell.confidence ?? 40),
            source: t.source || tf
          }))
          .filter(t => isNum(t.tp) && t.tp > 0);
      } else {
        const fallbackAtr = Math.max(ind.ATR || 0, price * 0.002);
        targets = [
          { tp: price + fallbackAtr * 2, confidence: 30, source: "ATR_UP" },
          { tp: price - fallbackAtr * 2, confidence: 30, source: "ATR_DOWN" },
        ];
      }

      let fib = null;
      try { fib = indicators.computeFibLevelsFromCandles?.(candles) ?? null; } catch { }

      blocks.push({ tf, price, candles, indicators: ind, vol, ell, ellSummary, targets, fib });
    }


    // =====================================================================
    // FUSION SCORE (same weights, fully stable)
    // =====================================================================

    const computeFusionScore = (indObj = {}, ellObj = {}) => {
      let s = 0, w = 0;

      // RSI
      const rsi = Number(indObj.RSI ?? 50);
      s += ((rsi - 50) / 50) * 0.4; w += 0.4;

      // MACD
      const macdh = Number(indObj.MACD?.hist ?? 0);
      const atr = Math.max(1, Number(indObj.ATR ?? 1));
      s += Math.tanh(macdh / atr) * 0.35;
      w += 0.35;

      // Price trend
      s += indObj.priceTrend === "UP" ? 0.15 : indObj.priceTrend === "DOWN" ? -0.15 : 0;
      w += 0.15;

      // Volume trend
      s += indObj.volumeTrend === "INCREASING" ? 0.08 : indObj.volumeTrend === "DECREASING" ? -0.08 : 0;
      w += 0.08;

      // Elliott sentiment
      const ellSent = Number(ellObj.sentiment ?? 0);
      const ellConf = clamp((ellObj.confidence ?? 0) / 100, 0, 1);
      s += ellSent * 0.25 * ellConf;
      w += 0.25 * ellConf;

      return w ? Number(clamp(s / w, -1, 1).toFixed(3)) : 0;
    };

    // block fusion
    for (const b of blocks)
      b.fusionScore = computeFusionScore(b.indicators, b.ell || { sentiment: 0, confidence: 0 });


    // weighted fusion
    const TF_WEIGHTS = {
      "1m": 0.05,
      "5m": 0.1,
      "15m": 0.4,
      "30m": 0.2,
      "1h": 0.25
    };

    let total = 0, ws = 0;
    for (const b of blocks) {
      const w = TF_WEIGHTS[b.tf] ?? 0.1;
      total += b.fusionScore * w;
      ws += w;
    }

    let overallFusion = ws ? Number(clamp(total / ws, -1, 1).toFixed(3)) : 0;


    // =====================================================================
    // TARGET FUSION
    // =====================================================================

    const tgtMap = new Map();
    for (const b of blocks) {
      for (const t of b.targets || []) {
        const key = Math.round(t.tp);
        const conf = clamp(t.confidence ?? 40, 0, 100);
        if (!tgtMap.has(key) || conf > tgtMap.get(key).confidence) {
          tgtMap.set(key, { ...t, confidence: Math.round(conf) });
        }
      }
    }

    const allTargets = [...tgtMap.values()].sort((a, b) => b.confidence - a.confidence);

    const price = blocks.find(x => x.tf === "15m")?.price ?? blocks[0]?.price ?? 0;

    const longs = allTargets.filter(t => t.tp > price).slice(0, 4);
    const shorts = allTargets.filter(t => t.tp < price).slice(0, 4);


    // =====================================================================
    // MACHINE LEARNING
    // =====================================================================

    let mlMain = null, micro = null;
    try { mlMain = await runMLPrediction(symbol, opts.mlTF || "15m"); } catch { }
    try { micro = await runMicroPrediction(symbol, "1m"); } catch { }

    // ML Boost
    let mlBoost = 0;
    if (mlMain?.probs) {
      const b = mlMain.probs.bull ?? 0;
      const r = mlMain.probs.bear ?? 0;
      mlBoost = clamp((b - r) / 100);
    }

    // NEWS
    let news = null;
    try { news = await fetchNewsBundle(symbol); }
    catch {
      news = { sentiment: 0.5, impact: "Low", items: [] };
    }

    let newsBoost = 0;
    if (typeof news.sentiment === "number") {
      const raw = clamp((news.sentiment - 0.5) * 2);
      const mul =
        news.impact?.toLowerCase() === "high" ? 1.0 :
          news.impact?.toLowerCase() === "moderate" ? 0.6 :
            0.25;
      newsBoost = clamp(raw * mul);
    }

    overallFusion = clamp(overallFusion + mlBoost * 0.22 + newsBoost * 0.18);


    // =====================================================================
    // SL defaults
    // =====================================================================

    const primary = blocks.find(x => x.tf === "15m") || blocks[0];
    const atr15 = primary.indicators.ATR ?? price * 0.005;

    const defaultSLLong = price - atr15 * 2;
    const defaultSLShort = price + atr15 * 2;


    // =====================================================================
    // ML ACCURACY
    // =====================================================================

    let mlAcc = 0;
    try {
      const r = calculateAccuracy();
      mlAcc = r?.accuracy ?? 0;
    } catch { }


    // FINAL REPORT OBJECT
    return {
      ok: true,
      symbol,
      generatedAt: new Date().toISOString(),
      nowIST: nowIST(),
      blocks,
      price,
      atr15,
      overallFusion,
      buyProb: Number(((overallFusion + 1) / 2 * 100).toFixed(2)),
      sellProb: Number((100 - ((overallFusion + 1) / 2 * 100)).toFixed(2)),
      longs,
      shorts,
      allTargets,
      ml: mlMain,
      micro,
      mlAcc,
      news,
      defaultSLLong,
      defaultSLShort,
      biasLabel: (() => {
        if (overallFusion >= 0.7) return { emoji: "🟩", label: "Strong Buy" };
        if (overallFusion >= 0.2) return { emoji: "🟦", label: "Buy" };
        if (overallFusion > -0.2) return { emoji: "⚪", label: "Neutral" };
        if (overallFusion > -0.7) return { emoji: "🟧", label: "Sell" };
        return { emoji: "🟥", label: "Strong Sell" };
      })(),
    };
  } catch (err) {
    return { ok: false, error: err?.message };
  }
}



// ============================================================================
// FORMAT AI REPORT (Telegram Message Builder)
// ============================================================================

export async function formatAIReport(report = {}) {
  try {
    if (!report.ok) return [`<b>Error building report</b>\n${report.error}`];

    const symbol = report.symbol;
    const time = nowIST(report.generatedAt);
    const price = nf(report.price, 2);

    // Helper for block extraction
    const getBlock = (tf) => {
      const b = report.blocks.find(x => x.tf === tf);
      if (!b) return null;

      const fusion = Number(b.fusionScore ?? 0);
      let sig = "⚪ NEUTRAL";
      if (fusion >= 0.7) sig = "🟩 STRONG BUY";
      else if (fusion >= 0.2) sig = "🟦 BUY";
      else if (fusion <= -0.2 && fusion > -0.7) sig = "🔴 SELL";
      else if (fusion <= -0.7) sig = "🟥 STRONG SELL";

      return {
        sig,
        rsi: nf(b.indicators.RSI, 0),
        macd: nf(b.indicators.MACD?.hist, 0),
        vol: b.vol?.status ?? b.indicators.volumeTrend,
        atr: nf(b.indicators.ATR, 0),
        ell: b.ell?.pattern || "No Major",
        ellConf: nf(b.ellSummary?.confidence ?? 0, 0),
        s: isNum(b.ellSummary?.support) ? nf(b.ellSummary.support) : "N/A",
        r: isNum(b.ellSummary?.resistance) ? nf(b.ellSummary.resistance) : "N/A",
        tpLine: b.targets.slice(0, 3).map(t => nf(t.tp)).join(" / ") || "N/A",
        sl: nf(report.defaultSLLong, 2),
      };
    };

    const b1m = getBlock("1m");
    const b5m = getBlock("5m");
    const b15 = getBlock("15m");
    const b30 = getBlock("30m");
    const b1h = getBlock("1h");

    // ML Section safety
    const ml = report.ml || {};
    const mlDir = ml.direction || "Neutral";
    const mlConf = nf(ml.maxProb ?? ml.tpConfidence ?? 0, 0);

    const mlFeat = ml.explanation?.features || {};
    const mlExplain = ellipsis(
      ml.explanation?.summary ??
      ml.explanation?.reason ??
      `slope:${mlFeat.slope ?? "?"} | mom3:${mlFeat.mom3 ?? "?"} | rsi:${mlFeat.rsi ?? "?"}`,
      200
    );

    const news = report.news || {};
    const headline = ellipsis(news.items?.[0]?.title ?? "No major events", 120);

    // MAIN TELEGRAM TEXT
    const partMain = `
🔥 ${symbol} — AI Market Intelligence
Time (IST): ${time}
Price: ${price}
━━━━━━━━━━━━━━━━━━

📊 MULTI-TIMEFRAME PANEL

🕒 1M — ${b1m.sig}
RSI ${b1m.rsi} | MACD ${b1m.macd} | Vol ${b1m.vol} | ATR ${b1m.atr}
S: ${b1m.s} | R: ${b1m.r}
TP 🎯: ${b1m.tpLine}

🕒 5M — ${b5m.sig}
RSI ${b5m.rsi} | MACD ${b5m.macd} | Vol ${b5m.vol} | ATR ${b5m.atr}
S: ${b5m.s} | R: ${b5m.r}
TP 🎯: ${b5m.tpLine}

🕒 15M — ${b15.sig}
RSI ${b15.rsi} | MACD ${b15.macd} | Vol ${b15.vol} | ATR ${b15.atr}
S: ${b15.s} | R: ${b15.r}
TP 🎯: ${b15.tpLine}

🕒 30M — ${b30.sig}
RSI ${b30.rsi} | MACD ${b30.macd} | Vol ${b30.vol} | ATR ${b30.atr}
S: ${b30.s} | R: ${b30.r}
TP 🎯: ${b30.tpLine}

🕒 1H — ${b1h.sig}
RSI ${b1h.rsi} | MACD ${b1h.macd} | Vol ${b1h.vol} | ATR ${b1h.atr}
S: ${b1h.s} | R: ${b1h.r}
TP 🎯: ${b1h.tpLine}
━━━━━━━━━━━━━━━━━━

🧭 OVERALL BIAS
Bias: ${report.biasLabel.emoji} ${report.biasLabel.label}
Fusion Score: ${report.overallFusion}
Buy ${report.buyProb}% | Sell ${report.sellProb}%
━━━━━━━━━━━━━━━━━━

🎯 AI TP CLUSTER
Long Targets: ${report.longs.map(x => nf(x.tp)).join(" / ") || "N/A"}
Short Targets: ${report.shorts.map(x => nf(x.tp)).join(" / ") || "N/A"}
━━━━━━━━━━━━━━━━━━

🤖 MACHINE LEARNING FORECAST (V12 Ultra)
Direction: ${mlDir}
Confidence: ${mlConf}%
Accuracy: ${nf(report.mlAcc, 0)}%

📌 ML Summary:
“${mlExplain}”
━━━━━━━━━━━━━━━━━━

📰 NEWS IMPACT
Impact: ${news.impact ?? "Low"}
Sentiment: ${nf(news.sentiment * 100, 1)}%
Headline: “${headline}”
━━━━━━━━━━━━━━━━━━
`.trim();


    return splitIntoSafeParts([partMain], MAX_TG_CHARS);

  } catch (e) {
    return [`<b>formatAIReport error</b>\n${e.message}`];
  }
}



// ============================================================================
// SEND FINAL REPORT
// ============================================================================

export async function sendSplitReport(report, sendTelegramFunc) {
  try {
    const parts = await formatAIReport(report);
    if (!parts.length) return false;

    for (let i = 0; i < parts.length; i++) {
      try {
        await sendTelegramFunc(parts[i]);
      } catch {
        await new Promise(r => setTimeout(r, 600));
        try { await sendTelegramFunc(parts[i]); } catch { }
      }
      if (i < parts.length - 1) await new Promise(r => setTimeout(r, 600));
    }

    return true;
  } catch {
    return false;
  }
}

export default { buildAIReport, formatAIReport, sendSplitReport };