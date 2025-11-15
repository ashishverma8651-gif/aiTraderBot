// tg_commands.js — AI Trader (Option-B UI) + Elliott + Fusion + ML v8.6 + News (Adaptive Option D)

// PART 1 of 3
import TelegramBot from "node-telegram-bot-api";
import CONFIG from "./config.js";
import { fetchMultiTF } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";

import {
  runMLPrediction,
  runMicroPrediction,
  calculateAccuracy
} from "./ml_module_v8_6.js";

import newsModule from "./news_social.js";

// ==========================
// Telegram Init
// ==========================
const BOT_TOKEN = CONFIG?.TELEGRAM?.BOT_TOKEN || process.env.BOT_TOKEN;
const CHAT_ID = CONFIG?.TELEGRAM?.CHAT_ID || process.env.CHAT_ID;
const bot = BOT_TOKEN ? new TelegramBot(BOT_TOKEN, { polling: false }) : null;

// helpers
const nf = (v, d = 2) =>
  (typeof v === "number" && Number.isFinite(v)) ? v.toFixed(d) : "N/A";

function clamp(v, lo = -1, hi = 1) { return Math.max(lo, Math.min(hi, v)); }

function fusionLabel(score) {
  if (score >= 0.70) return { label: "Strong Buy", emoji: "🚀" };
  if (score >= 0.20) return { label: "Buy", emoji: "🟢" };
  if (score > -0.20 && score < 0.20) return { label: "Neutral", emoji: "⚪" };
  if (score <= -0.20 && score > -0.70) return { label: "Sell", emoji: "🔴" };
  return { label: "Strong Sell", emoji: "⛔" };
}

// Fusion score using RSI, MACD, ATR, Elliott
function computeFusionScore(indObj, ellObj) {
  try {
    let score = 0, w = 0;

    const rsiScore = ((indObj.RSI - 50) / 50);
    score += rsiScore * 0.4; w += 0.4;

    const macdScore = Math.tanh((indObj.MACD.hist || 0) / Math.max(1, indObj.ATR || 1));
    score += macdScore * 0.35; w += 0.35;

    const pt = indObj.priceTrend === "UP" ? 0.15 :
               indObj.priceTrend === "DOWN" ? -0.15 : 0;
    score += pt; w += 0.15;

    const vt = indObj.volumeTrend === "INCREASING" ? 0.08 :
               indObj.volumeTrend === "DECREASING" ? -0.08 : 0;
    score += vt; w += 0.08;

    const conf = (ellObj.confidence || 0) / 100;
    score += (ellObj.sentiment || 0) * (0.25 * conf); 
    w += 0.25 * conf;

    return Number(Math.max(-1, Math.min(1, score / w)).toFixed(3));
  } catch { return 0; }
}

// combine TF fusion
function computeOverallFusion(mtf) {
  const weights = { "1m": 0.05, "5m": 0.1, "15m": 0.4, "30m": 0.2, "1h": 0.25 };
  let s = 0, w = 0;
  for (const m of mtf) {
    const fs = m.fusionScore || 0;
    const wt = weights[m.tf] || 0.1;
    s += fs * wt; w += wt;
  }
  return Number(Math.max(-1, Math.min(1, s / w)).toFixed(3));
}

// Buy/Sell probs
function computeBuySellProb(overallFusion, mtf) {
  let buy = (overallFusion + 1) / 2 * 100;
  let sell = 100 - buy;

  const sum = buy + sell;
  buy = (buy / sum) * 100;
  sell = 100 - buy;

  return {
    buy: Math.round(buy * 100) / 100,
    sell: Math.round(sell * 100) / 100,
    ellAvg: 0
  };
}

function buildTFBlock(tf, price, ind, vol, ellSummary, fusionScore, fib) {
  const f = fusionLabel(fusionScore);
  return `
<b>【${tf.toUpperCase()}】 ${f.emoji} ${f.label}</b>
💰 Price: <b>${nf(price)}</b> | 📊 Vol: ${vol.status || "N/A"}
RSI: <b>${nf(ind.RSI,1)}</b> | MACD: <b>${nf(ind.MACD.hist,4)}</b> | ATR: <b>${nf(ind.ATR)}</b>
Structure: support:${nf(ellSummary.support)} | resistance:${nf(ellSummary.resistance)}
Fusion Score: ${fusionScore}
`.trim();
}

function buildHeatmap(mtf) {
  const order = ["1m","5m","15m","30m","1h"];
  const map = s => s>=0.7?"🟩":s>=0.2?"🟦":s>-0.2?"🟨":s>-0.7?"🟧":"🟥";
  return `<b>Elliott MultiTF Heatmap</b>\n` +
         order.map(tf=>{
           const m = mtf.find(x=>x.tf===tf);
           return `${tf.toUpperCase()}:${map(m?.fusionScore||0)}`;
         }).join(" | ");
}

async function safeElliottForCandles(c) {
  try {
    const ell = await analyzeElliott(c);
    if (!ell || !ell.ok) return { ok:false };

    const highs = ell.pivots.filter(p=>p.type==="H");
    const lows  = ell.pivots.filter(p=>p.type==="L");

    return {
      ok:true,
      ell,
      support: lows.length ? lows.at(-1).price : null,
      resistance: highs.length ? highs.at(-1).price : null
    };

  } catch { return { ok:false }; }
}

function getTPval(t) {
  return Number(t.tp || t.target || t.price || 0);
}

// ============================================================
// 🚀 MAIN ENGINE — buildAIReport()
// ============================================================
export async function buildAIReport(symbol="BTCUSDT") {
  try {
    const tfs = ["1m","5m","15m","30m","1h"];
    const mtfRaw = await fetchMultiTF(symbol, tfs);
    const mtf = [];

    for (const tf of tfs) {
      const entry = mtfRaw[tf] || { data:[], price:0 };
      const candles = entry.data || [];
      const price = entry.price || candles.at(-1)?.close || 0;

      const ind = {
        RSI: indicators.computeRSI(candles),
        MACD: indicators.computeMACD(candles),
        ATR: indicators.computeATR(candles),
        priceTrend: candles.length>=2 ? 
          (candles.at(-1).close > candles.at(-2).close ? "UP" :
          candles.at(-1).close < candles.at(-2).close ? "DOWN":"FLAT") : "FLAT",
        volumeTrend: indicators.volumeTrend(candles)
      };

      const vol = indicators.analyzeVolume(candles);
      const ell = await safeElliottForCandles(candles);

      let fib=null;
      try { fib = indicators.computeFibLevels(candles); } catch {}

      const fusionScore = computeFusionScore(ind, ell.ok?ell.ell:{sentiment:0,confidence:0});
      const rawTargets = ell.ok ? (ell.ell.targets||[]).slice(0,5) : [];

      mtf.push({
        tf, price, candles,
        indicators: ind, vol,
        ell: ell.ok?ell.ell:null,
        ellSummary: { support: ell.support, resistance: ell.resistance },
        fib, fusionScore,
        targets: rawTargets
      });
    }

    let overallFusion = computeOverallFusion(mtf);
    const probs = computeBuySellProb(overallFusion, mtf);

    const price = mtf.find(x=>x.tf==="15m")?.price || 0;
    const allTargets = mtf.flatMap(m=>m.targets||[]);

    let ml = {};
    try { ml = await runMLPrediction(symbol,"15m"); } catch {}

    let mlAcc = 0;
    try { mlAcc = calculateAccuracy().accuracy; } catch {}

    let news={ sentiment:0.5, impact:"Low", items:[] };
    try { news = await newsModule.fetchNewsBundle(symbol); } catch {}

    overallFusion = Number(overallFusion.toFixed(3));

    const uniq = new Map();
    for (const t of allTargets) {
      const key = Math.round(getTPval(t));
      if (!uniq.has(key)) uniq.set(key,t);
    }

    const targets = Array.from(uniq.values()).slice(0,6);

    const longs = targets.filter(t=>getTPval(t)>price);
    const shorts= targets.filter(t=>getTPval(t)<price);

    return {
      ok:true,
      symbol,
      price,
      mtf,
      overallFusion,
      buyProb: probs.buy,
      sellProb: probs.sell,
      annotatedTargets: targets,
      longs, shorts,
      ml,
      mlAcc,
      mlDirection: ml.label || "Neutral",
      news,
      generatedAt: new Date().toISOString()
    };

  } catch (e) {
    return { ok:false, error: e.message };
  }
}

// ============================================================
// 🚀 formatAIReport() — SINGLE-SEND SAFE VERSION
// ============================================================
export async function formatAIReport(report) {
  try {
    if (!report?.ok) return `Error building report: ${report?.error}`;

    const price = report.price;
    const mtf = report.mtf;

    const heat = buildHeatmap(mtf);

    const tfBlocks = mtf.map(m =>
      buildTFBlock(
        m.tf,
        m.price,
        m.indicators,
        m.vol,
        m.ellSummary,
        m.fusionScore,
        m.fib
      )
    ).join("\n\n──────────────\n\n");

    const html = `
🚀 <b>${report.symbol} — AI Trader (Option-B Premium)</b>
${new Date(report.generatedAt).toLocaleString()}
Price: <b>${nf(price)}</b>

${heat}

────────────────────
<b>📊 Multi-Timeframe Analysis</b>

${tfBlocks}

────────────────────
🤖 <b>ML Prediction</b>
Label: <b>${report.ml?.label}</b>
Probability: ${report.ml?.prob || 0}%
Accuracy: ${report.mlAcc}%

<i>AI Engine v3.0 — Elliott + Fusion + ML v8.6 + News AI v3</i>
`.trim();

    // Telegram SEND — SINGLE & SAFE
    if (bot && CHAT_ID) {
      try {
        await bot.sendMessage(CHAT_ID, html, {
          parse_mode: "HTML",
          disable_web_page_preview: true
        });
      } catch (e) {
        console.error("Telegram send failed:", e.message);
      }
    }

    return html;

  } catch (e) {
    console.error("formatAIReport error:", e.message);
    return `formatAIReport error: ${e.message}`;
  }
}

// EXPORTS
export default {
  buildAIReport,
  formatAIReport
};