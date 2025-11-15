// tg_commands.js — AI Trader (Option-B UI) + Elliott + Fusion + ML v3 (ML Bias + ML TP)

import TelegramBot from "node-telegram-bot-api";
import CONFIG from "./config.js";
import { fetchMultiTF } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";

// ML Module
import {
  runMLPrediction,
  runMicroPrediction,
  calculateAccuracy,
  recordPrediction,
  recordOutcome
} from "./ml_module_v8_6.js";


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
  typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : "N/A";

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
function computeFusionScore(ind, ell) {
  let score = 0,
    weight = 0;
  try {
    const rsi = Number(ind?.RSI ?? 50);
    const rsiScore = (rsi - 50) / 50;
    score += rsiScore * 0.4;
    weight += 0.4;

    const macdh = Number(ind?.MACD?.hist ?? 0);
    const macdScore = Math.tanh(macdh / Math.max(1, Math.abs(ind?.ATR || 1)));
    score += macdScore * 0.35;
    weight += 0.35;

    const pt =
      ind?.priceTrend === "UP"
        ? 0.15
        : ind?.priceTrend === "DOWN"
        ? -0.15
        : 0;
    score += pt;
    weight += 0.15;

    const vt =
      ind?.volumeTrend === "INCREASING"
        ? 0.08
        : ind?.volumeTrend === "DECREASING"
        ? -0.08
        : 0;
    score += vt;
    weight += 0.08;

    const ellSent = Number(ell?.sentiment ?? 0);
    const ellConf = Math.min(1, Number(ell?.confidence ?? 0) / 100);
    score += ellSent * (0.25 * ellConf);
    weight += 0.25 * ellConf;

    return Number(
      Math.max(-1, Math.min(1, score / Math.max(0.0001, weight))).toFixed(3)
    );
  } catch {
    return 0;
  }
}


// ==========================
// Compute overall fusion
// ==========================
function computeOverallFusion(mtf) {
  const weights = {
    "1m": 0.05,
    "5m": 0.1,
    "15m": 0.4,
    "30m": 0.2,
    "1h": 0.25
  };
  let s = 0,
    wsum = 0;

  for (const m of mtf) {
    const score = Number(m.fusionScore ?? 0);
    const w = weights[m.tf] ?? 0.1;
    s += score * w;
    wsum += w;
  }
  return Number(Math.max(-1, Math.min(1, s / wsum)).toFixed(3));
}


// ==========================
// Buy/Sell Probability
// ==========================
function computeBuySellProb(overallFusion, mtf) {
  let buy = ((overallFusion + 1) / 2) * 100;
  let sell = 100 - buy;

  let ellSum = 0,
    ellW = 0;
  for (const m of mtf) {
    const ell = m.ell;
    if (
      ell &&
      typeof ell.sentiment === "number" &&
      typeof ell.confidence === "number"
    ) {
      const conf = Math.min(100, Math.max(0, ell.confidence));
      ellSum += ell.sentiment * (conf / 100);
      ellW += conf / 100;
    }
  }

  const ellAvg = ellW ? ellSum / ellW : 0;
  buy += ellAvg * 10;
  sell = 100 - buy;

  buy = Math.max(0, Math.min(100, buy));
  sell = Math.max(0, Math.min(100, sell));

  return {
    buy,
    sell,
    ellAvg
  };
}


// ==========================
// TF Block Builder
// ==========================
function buildTFBlock(tf, price, ind, vol, ellSummary, fusionScore, fib) {
  const fusion = fusionLabel(fusionScore);
  return `
<b>【${tf.toUpperCase()}】 ${fusion.emoji} ${fusion.label}</b>
💰 Price: <b>${nf(price)}</b> | 📊 Vol: ${vol?.status || "N/A"}
RSI: <b>${nf(ind.RSI)}</b> | MACD: <b>${nf(ind.MACD?.hist, 4)}</b> | ATR: <b>${nf(ind.ATR)}</b>
Structure: support:${nf(ellSummary?.support || fib?.lo)} | resistance:${nf(ellSummary?.resistance || fib?.hi)}
Fusion Score: ${fusionScore}
`.trim();
}


// ==========================
// Heatmap
// ==========================
function buildHeatmap(mtfData) {
  const tfOrder = ["1m", "5m", "15m", "30m", "1h"];
  const map = s =>
    s >= 0.7
      ? "🟩"
      : s >= 0.2
      ? "🟦"
      : s > -0.2
      ? "🟨"
      : s > -0.7
      ? "🟧"
      : "🟥";

  return (
    "<b>Elliott MultiTF Heatmap</b>\n" +
    tfOrder
      .map(tf => {
        const m = mtfData.find(x => x.tf === tf);
        return `${tf.toUpperCase()}:${map(m?.fusionScore || 0)}`;
      })
      .join(" | ")
  );
}


// ==========================
// Elliott support/resistance extractor
// ==========================
async function safeElliottForCandles(candles) {
  try {
    const ell = await analyzeElliott(candles);
    if (!ell || !ell.ok) return { ok: false };

    const pivots = ell.pivots || [];
    const lastHigh = pivots.filter(p => p.type === "H").slice(-1)[0];
    const lastLow = pivots.filter(p => p.type === "L").slice(-1)[0];

    return {
      ok: true,
      ell,
      support: lastLow ? lastLow.price : null,
      resistance: lastHigh ? lastHigh.price : null
    };
  } catch {
    return { ok: false };
  }
}


// ==========================
// resolve target confidence
// ==========================
function resolveTargetConfidence(t, ell) {
  if (t?.confidence) return t.confidence;
  if (ell?.confidence) return ell.confidence;
  return 40;
}


// ============================================================
// 🚀 MAIN ENGINE — buildAIReport()
// ============================================================
export async function buildAIReport(symbol = "BTCUSDT") {
  try {
    const tfs = ["1m", "5m", "15m", "30m", "1h"];
    const mtfRaw = await fetchMultiTF(symbol, tfs);
    const mtf = [];

    // ----------------------------------
    // Per TF Analysis
    // ----------------------------------
    for (const tf of tfs) {
      const entry = mtfRaw[tf] || { data: [], price: 0 };
      const candles = entry.data || [];
      const price =
        typeof entry.price === "number" && entry.price
          ? entry.price
          : candles.at(-1)?.close || 0;

      const ind = {
        RSI:
          indicators.computeRSI?.(candles) ||
          indicators.computeRSI_fromCandles?.(candles) ||
          50,
        MACD: indicators.computeMACD?.(candles) || { hist: 0 },
        ATR: indicators.computeATR?.(candles) || 0,
        priceTrend:
          candles.length >= 2
            ? candles.at(-1).close > candles.at(-2).close
              ? "UP"
              : candles.at(-1).close < candles.at(-2).close
              ? "DOWN"
              : "FLAT"
            : "FLAT",
        volumeTrend: indicators.volumeTrend?.(candles) || "STABLE"
      };

      const vol =
        indicators.analyzeVolume?.(candles) ||
        ({
          status: "UNKNOWN",
          strength: 0
        });

      const ellRes = await safeElliottForCandles(candles);
      const ell = ellRes?.ok ? ellRes.ell : null;

      // FIB
      let fib = null;
      try {
        fib =
          indicators.computeFibLevels?.(candles) ||
          indicators.computeFibLevelsFromCandles?.(candles);
      } catch {}

      const fusionScore = computeFusionScore(ind, ell);

      const rawTargets = ell?.targets?.slice(0, 5) || [];

      const targets = rawTargets.map(t => ({
        ...t,
        confidence: resolveTargetConfidence(t, ell)
      }));

      mtf.push({
        tf,
        price,
        candles,
        indicators: ind,
        vol,
        ell,
        ellSummary: {
          support: ellRes?.support || null,
          resistance: ellRes?.resistance || null
        },
        fib,
        fusionScore,
        targets
      });
    }

    // ----------------------------------
    // Fusion + Probability
    // ----------------------------------
    let overallFusion = computeOverallFusion(mtf);
    const probs = computeBuySellProb(overallFusion, mtf);

    const price =
      mtf.find(x => x.tf === "15m")?.price || mtf[0]?.price || 0;

    const allTargets = mtf.flatMap(m =>
      (m.targets || []).map(t => ({ ...t, tf: m.tf }))
    );

    // ----------------------------------
    // ML Prediction (15m)
    // ----------------------------------
    let ml = null;
    try {
      ml = await runMLPrediction(symbol, "15m");
    } catch (e) {
      ml = { error: e.message || "ml_error" };
    }

    // ML accuracy
    let mlAcc = 0;
    try {
      const acc = calculateAccuracy();
      mlAcc = acc?.accuracy || 0;
    } catch {}

    // =====================================================
    // 🔥 ML → Fusion Boost
    // =====================================================
    let mlDirection = "neutral";
    let mlBias = 0;

    if (ml?.label === "Bullish") (mlDirection = "long"), (mlBias = +1);
    else if (ml?.label === "Bearish") (mlDirection = "short"), (mlBias = -1);

    const mlWeight = 0.25;
    const boostedFusion = Math.max(
      -1,
      Math.min(1, overallFusion + mlBias * mlWeight)
    );
    overallFusion = boostedFusion;

    // ====================================================
    // 🔥 ML TP Selection
    // ====================================================
    function getTP(t) {
      return Number(t.tp || t.target || t.price || 0);
    }

    function pickMLTP(list, mode) {
      if (!list.length) return null;

      if (mode === "long")
        return list
          .filter(t => getTP(t) > price)
          .sort((a, b) => b.confidence - a.confidence)[0];

      if (mode === "short")
        return list
          .filter(t => getTP(t) < price)
          .sort((a, b) => b.confidence - a.confidence)[0];

      return null;
    }

    const uniqMap = new Map();
    for (const t of allTargets) {
      const key = Math.round(getTP(t));
      if (!uniqMap.has(key)) uniqMap.set(key, t);
      else {
        const prev = uniqMap.get(key);
        uniqMap.set(
          key,
          (t.confidence || 0) > (prev.confidence || 0) ? t : prev
        );
      }
    }
    const annotatedTargets = Array.from(uniqMap.values()).slice(0, 6);

    const longs = annotatedTargets
      .filter(t => getTP(t) > price)
      .sort((a, b) => b.confidence - a.confidence);

    const shorts = annotatedTargets
      .filter(t => getTP(t) < price)
      .sort((a, b) => b.confidence - a.confidence);

    const mlLongTP = pickMLTP(annotatedTargets, "long");
    const mlShortTP = pickMLTP(annotatedTargets, "short");

    return {
      ok: true,
      symbol,
      price,
      mtf,
      overallFusion,
      buyProb: probs.buy,
      sellProb: probs.sell,
      annotatedTargets,
      longs,
      shorts,
      ml,
      mlAcc,
      mlDirection,
      mlLongTP,
      mlShortTP,
      generatedAt: new Date().toISOString()
    };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}


// ============================================================
// 🚀 formatAIReport()
// ============================================================
export async function formatAIReport(report) {
  try {
    if (!report || !report.ok) {
      const msg = `Error: ${report?.error || "unknown"}`;
      if (bot && CHAT_ID) bot.sendMessage(CHAT_ID, msg);
      return msg;
    }

    const price = report.price;
    const mtf = report.mtf;

    const heat = buildHeatmap(mtf);

    const tfBlocks = mtf
      .map(m =>
        buildTFBlock(
          m.tf,
          m.price,
          m.indicators,
          m.vol,
          m.ellSummary,
          m.fusionScore,
          m.fib
        )
      )
      .join("\n\n──────────────\n\n");

    const fusionLbl = fusionLabel(report.overallFusion);

    const topLongs = report.longs
      .slice(0, 3)
      .map(
        (t, i) =>
          `TP${i + 1}: ${nf(
            t.tp || t.target
          )} (${t.source || t.tf}) [${t.confidence}%]`
      )
      .join(" | ") || "n/a";

    const topShorts = report.shorts
      .slice(0, 3)
      .map(
        (t, i) =>
          `TP${i + 1}: ${nf(
            t.tp || t.target
          )} (${t.source || t.tf}) [${t.confidence}%]`
      )
      .join(" | ") || "n/a";

    const mlTPtxt =
      report.mlDirection === "long"
        ? report.mlLongTP
          ? `${nf(report.mlLongTP.tp)} [${report.mlLongTP.confidence}%]`
          : "n/a"
        : report.mlDirection === "short"
        ? report.mlShortTP
          ? `${nf(report.mlShortTP.tp)} [${report.mlShortTP.confidence}%]`
          : "n/a"
        : "n/a";

    const html = `
🚀 <b>${report.symbol} — AI Trader v3</b>
${new Date(report.generatedAt).toLocaleString()}
Price: <b>${nf(price)}</b>

${heat}

────────────────────
<b>📊 Multi-Timeframe Analysis</b>
${tfBlocks}

────────────────────
🧠 <b>Fusion</b>
Bias: ${fusionLbl.emoji} <b>${fusionLbl.label}</b>
Fusion Score: ${report.overallFusion}
Buy Prob: <b>${report.buyProb}%</b> | Sell Prob: <b>${report.sellProb}%</b>

────────────────────
🎯 <b>LONG TPs</b>
${topLongs}

🎯 <b>SHORT TPs</b>
${topShorts}

────────────────────
🤖 <b>ML Prediction</b>
Label: <b>${report.ml?.label}</b>
Prob: ${report.ml?.prob}%
Direction: <b>${report.mlDirection}</b>
ML Target: ${mlTPtxt}
Accuracy: ${report.mlAcc}%

<i>AI Engine v3 — Elliott + ML + Fusion Unified</i>
`.trim();

    if (bot && CHAT_ID)
      await bot.sendMessage(CHAT_ID, html, {
        parse_mode: "HTML",
        disable_web_page_preview: true
      });

    return html;
  } catch (e) {
    return `formatAIReport error: ${e.message}`;
  }
}

export default { buildAIReport, formatAIReport };