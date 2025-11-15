// tg_commands.js — AI Trader (Option-C Minimal Clean) + Elliott + Fusion + ML v8.6 + News (Adaptive)
// Patched: safer guards, no auto-send, numeric safety, clean format

import TelegramBot from "node-telegram-bot-api";
import CONFIG from "./config.js";
import { fetchMultiTF } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";

import {
  runMLPrediction,
  calculateAccuracy
} from "./ml_module_v8_6.js";

import newsModule from "./news_social.js";

// Telegram Init (do NOT send auto here)
const BOT_TOKEN = CONFIG?.TELEGRAM?.BOT_TOKEN || process.env.BOT_TOKEN;
const CHAT_ID = CONFIG?.TELEGRAM?.CHAT_ID || process.env.CHAT_ID;
const bot = BOT_TOKEN ? new TelegramBot(BOT_TOKEN, { polling: false }) : null;

// Helper
const nf = (v, d = 2) =>
  (typeof v === "number" && Number.isFinite(v)) ? v.toFixed(d) : "N/A";

function clamp(v, lo = -1, hi = 1) {
  if (typeof v !== "number" || !Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, v));
}

function fusionLabel(score) {
  if (typeof score !== "number" || !Number.isFinite(score)) score = 0;
  if (score >= 0.70) return { label: "Strong Buy", emoji: "🚀" };
  if (score >= 0.20) return { label: "Buy", emoji: "🟢" };
  if (score > -0.20 && score < 0.20) return { label: "Neutral", emoji: "⚪" };
  if (score <= -0.20 && score > -0.70) return { label: "Sell", emoji: "🔴" };
  return { label: "Strong Sell", emoji: "⛔" };
}

// ==========================
// Fusion Scoring
// ==========================
function computeFusionScore(indObj = {}, ellObj = {}) {
  let score = 0, weight = 0;
  try {
    const rsi = Number(indObj?.RSI ?? 50);
    const rsiScore = Number.isFinite(rsi) ? ((rsi - 50) / 50) : 0;
    score += rsiScore * 0.4;
    weight += 0.4;

    const macdh = Number(indObj?.MACD?.hist ?? 0);
    const atr = Math.max(1, Math.abs(Number(indObj?.ATR ?? 1)));
    const macdScore = Number.isFinite(macdh) ? Math.tanh(macdh / atr) : 0;
    score += macdScore * 0.35;
    weight += 0.35;

    const pt = indObj?.priceTrend === "UP" ? 0.15 :
               indObj?.priceTrend === "DOWN" ? -0.15 : 0;
    score += pt;
    weight += 0.15;

    const vt = (indObj?.volumeTrend === "INCREASING") ? 0.08 :
               (indObj?.volumeTrend === "DECREASING") ? -0.08 : 0;
    score += vt;
    weight += 0.08;

    const ellSent = Number(ellObj?.sentiment ?? 0);
    const ellConf = Math.min(1, Math.max(0, Number(ellObj?.confidence ?? 0) / 100));
    const ellPart = (Number.isFinite(ellSent) ? ellSent : 0) * (0.25 * ellConf);
    score += ellPart;
    weight += 0.25 * ellConf;

    if (!weight || !Number.isFinite(weight) || Math.abs(weight) < 1e-9) return 0;
    const normalized = score / weight;
    if (!Number.isFinite(normalized)) return 0;
    return Number(Math.max(-1, Math.min(1, normalized)).toFixed(3));
  } catch (e) {
    return 0;
  }
}

// ==========================
// Overall Fusion
// ==========================
function computeOverallFusion(mtf) {
  const weights = { "1m": 0.05, "5m": 0.1, "15m": 0.4, "30m": 0.2, "1h": 0.25 };
  let s = 0, wsum = 0;
  for (const m of (mtf || [])) {
    const score = Number(m?.fusionScore ?? 0);
    const w = Number(weights[m?.tf] ?? 0.1);
    if (!Number.isFinite(score) || !Number.isFinite(w)) continue;
    s += score * w;
    wsum += w;
  }
  if (!wsum) return 0;
  const overall = s / wsum;
  if (!Number.isFinite(overall)) return 0;
  return Number(Math.max(-1, Math.min(1, overall)).toFixed(3));
}

// ==========================
// Buy/Sell probability
// ==========================
function computeBuySellProb(overallFusion, mtf) {
  let buy = (Number(overallFusion || 0) + 1) / 2 * 100;
  if (!Number.isFinite(buy)) buy = 50;
  let sell = 100 - buy;

  let ellSum = 0, ellW = 0;
  for (const m of (mtf || [])) {
    const ell = m?.ell;
    if (ell && Number.isFinite(ell.sentiment) && Number.isFinite(ell.confidence)) {
      const conf = Math.max(0, Math.min(100, ell.confidence));
      ellSum += ell.sentiment * (conf / 100);
      ellW += (conf / 100);
    }
  }
  const ellAvg = ellW ? (ellSum / ellW) : 0;
  buy += ellAvg * 10;
  sell = 100 - buy;

  const bull = (mtf || []).filter(m => Number(m?.fusionScore ?? 0) > 0.2).length;
  const bear = (mtf || []).filter(m => Number(m?.fusionScore ?? 0) < -0.2).length;
  buy += Math.min(8, (bull - bear) * 2);
  sell = 100 - buy;

  buy = Number.isFinite(buy) ? Math.max(0, Math.min(100, buy)) : 50;
  sell = Number.isFinite(sell) ? Math.max(0, Math.min(100, sell)) : 50;

  const sum = (buy + sell) || 1;
  buy = Math.round((buy / sum) * 10000) / 100;
  sell = Math.round((sell / sum) * 10000) / 100;

  return { buy, sell, ellAvg: Number((ellAvg || 0).toFixed(3)) };
}

// ==========================
// TF Block (NO separators)
// ==========================
function buildTFBlock(tf, price, ind = {}, vol = {}, ellSummary = {}, fusionScore = 0, fib = null) {
  const fusion = fusionLabel(Number(fusionScore) || 0);
  const rsi = Number.isFinite(ind?.RSI) ? ind.RSI.toFixed(1) : "N/A";
  const macd = Number.isFinite(ind?.MACD?.hist) ? ind.MACD.hist.toFixed(4) : "N/A";
  const atr = Number.isFinite(ind?.ATR) ? ind.ATR.toFixed(2) : "N/A";
  const support = ellSummary?.support ?? (fib?.lo ?? null);
  const resistance = ellSummary?.resistance ?? (fib?.hi ?? null);

  return `
<b>${tf.toUpperCase()} — ${fusion.emoji} ${fusion.label}</b>
Price: <b>${nf(price,2)}</b> | Vol: ${vol?.status || "N/A"}
RSI: <b>${rsi}</b> | MACD: <b>${macd}</b> | ATR: <b>${atr}</b>
Support: ${support ? nf(support,2) : "N/A"}
Resistance: ${resistance ? nf(resistance,2) : "N/A"}
Fusion Score: ${Number(fusionScore || 0)}
  `.trim();
}

// ==========================
// Heatmap (Clean)
// ==========================
function buildHeatmap(mtfData = []) {
  const order = ["1m","5m","15m","30m","1h"];
  const emoji = s => {
    s = Number(s || 0);
    if (!Number.isFinite(s)) s = 0;
    if (s >= 0.7) return "🟩";
    if (s >= 0.2) return "🟦";
    if (s > -0.2) return "🟨";
    if (s > -0.7) return "🟧";
    return "🟥";
  };
  return "<b>Elliott Heatmap</b>\n" +
    order.map(tf => {
      const x = mtfData.find(m => m.tf === tf);
      return `${tf}:${emoji(x?.fusionScore)}`;
    }).join(" | ");
}

// ==========================
// Elliott Wrapper
// ==========================
async function safeElliottForCandles(candles) {
  try {
    const ell = await analyzeElliott(candles);
    if (!ell || !ell.ok) return { ok:false };
    const pivots = ell.pivots || [];
    const H = pivots.filter(p => p.type === "H").at(-1);
    const L = pivots.filter(p => p.type === "L").at(-1);
    return {
      ok:true,
      ell,
      support: L?.price ?? null,
      resistance: H?.price ?? null
    };
  } catch {
    return { ok:false };
  }
}

// ==========================
// MAIN ENGINE
// ==========================
export async function buildAIReport(symbol="BTCUSDT") {
  try {
    const tfs = ["1m","5m","15m","30m","1h"];
    const raw = await fetchMultiTF(symbol, tfs);

    const mtf = [];
    for (const tf of tfs) {
      const entry = raw?.[tf] || { data: [] };
      const candles = entry.data || [];
      const price = (typeof entry.price === "number" && Number.isFinite(entry.price)) ? entry.price
                    : (candles?.at(-1)?.close ?? 0);

      // safe indicator calls (in case functions missing)
      const ind = {
        RSI: typeof indicators.computeRSI === "function" ? indicators.computeRSI(candles) : (typeof indicators.computeRSI_fromCandles === "function" ? indicators.computeRSI_fromCandles(candles) : 50),
        MACD: typeof indicators.computeMACD === "function" ? indicators.computeMACD(candles) : { hist: 0, line: 0, signal: 0 },
        ATR: typeof indicators.computeATR === "function" ? indicators.computeATR(candles) : 0,
        priceTrend: (candles.length > 1) ? ((candles.at(-1).close > candles.at(-2).close) ? "UP" : (candles.at(-1).close < candles.at(-2).close ? "DOWN" : "FLAT")) : "FLAT",
        volumeTrend: typeof indicators.volumeTrend === "function" ? indicators.volumeTrend(candles) : "STABLE"
      };

      const vol = typeof indicators.analyzeVolume === "function" ? indicators.analyzeVolume(candles) : { status: "UNKNOWN", strength: 0 };

      const ellWrap = await safeElliottForCandles(candles);
      const ell = ellWrap?.ell ?? null;

      let fib = null;
      try { if (typeof indicators.computeFibLevels === "function") fib = indicators.computeFibLevels(candles); } catch {}

      const fusionScore = computeFusionScore(ind, ell || {});

      const targets = Array.isArray(ell?.targets) ? ell.targets.slice(0,5) : [];

      mtf.push({
        tf,
        price,
        candles,
        indicators: ind,
        vol,
        ell,
        ellSummary: { support: ellWrap?.support ?? null, resistance: ellWrap?.resistance ?? null },
        fib,
        fusionScore,
        targets
      });
    }

    let overallFusion = computeOverallFusion(mtf);
    const probs = computeBuySellProb(overallFusion, mtf);

    // ML
    let ml = null;
    try { ml = await runMLPrediction(symbol, "15m"); } catch { ml = null; }

    let mlAcc = 0;
    try { const acc = calculateAccuracy?.(); mlAcc = acc?.accuracy ?? 0; } catch {}

    // News
    let news = null;
    try { news = await newsModule.fetchNewsBundle(symbol); } catch {}

    // Adaptive boost
    const mlWeight = 0.25;
    const mlBias = ml?.label === "Bullish" ? 1 : ml?.label === "Bearish" ? -1 : 0;
    let boosted = clamp(overallFusion + mlBias * mlWeight);

    let newsWeight = (String(news?.impact || "").toLowerCase() === "high") ? 0.40 :
                     (String(news?.impact || "").toLowerCase() === "moderate") ? 0.25 : 0.10;
    const newsBias = (((news?.sentiment ?? 0.5) - 0.5) * 2) || 0;
    boosted = clamp(boosted + newsBias * newsWeight);

    overallFusion = Number(clamp(boosted).toFixed(3));
    const probsBoosted = computeBuySellProb(overallFusion, mtf);

    return {
      ok: true,
      symbol,
      price: mtf.find(m => m.tf === "15m")?.price ?? mtf[0]?.price ?? 0,
      mtf,
      overallFusion,
      buyProb: probsBoosted.buy,
      sellProb: probsBoosted.sell,
      news,
      ml,
      mlAcc,
      mlDirection: ml?.label ?? null,
      generatedAt: new Date().toISOString()
    };

  } catch (e) {
    return { ok: false, error: (e && e.message) ? e.message : String(e) };
  }
}

// ==========================
// FORMAT REPORT (NO separators — Option C gaps only)
// ==========================
export async function formatAIReport(r) {
  if (!r?.ok) return "Error: " + (r?.error || "unknown");

  const tfBlocks = (r.mtf || [])
    .map(m => buildTFBlock(
      m.tf,
      m.price,
      m.indicators,
      m.vol,
      m.ellSummary,
      m.fusionScore,
      m.fib
    ))
    .join("\n\n\n");   // Option-C: triple newline gaps only

  const fusion = fusionLabel(Number(r.overallFusion) || 0);

  const newsTxt = r.news
    ? `News Impact: ${r.news.impact || "N/A"} | Sent: ${Number.isFinite(r.news.sentiment) ? Math.round(r.news.sentiment * 100) + "%" : "N/A"}`
    : "News: N/A";

  const html = `
<b>${r.symbol} — AI Trader Report</b>
${new Date(r.generatedAt).toLocaleString()}

Price: <b>${nf(r.price)}</b>

${buildHeatmap(r.mtf)}

<b>Multi-Timeframe Analysis</b>

${tfBlocks}

<b>Fusion Summary</b>
Bias: ${fusion.emoji} <b>${fusion.label}</b>
Fusion Score: <b>${r.overallFusion}</b>
Buy: <b>${r.buyProb}%</b> | Sell: <b>${r.sellProb}%</b>

<b>News Overview</b>
${newsTxt}

<b>ML Prediction</b>
Label: <b>${r.mlDirection ?? "N/A"}</b>
Accuracy: ${r.mlAcc ?? 0}%

<i>AI Engine v3.0 — Clean Format</i>
  `.trim();

  return html;
}

export default { buildAIReport, formatAIReport };