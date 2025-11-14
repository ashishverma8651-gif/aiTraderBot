// tg_commands.js — Option-B UI + Elliott + Fusion + ML v16 integrated
import TelegramBot from "node-telegram-bot-api";
import CONFIG from "./config.js";
import { fetchMultiTF } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";

// ML integration (correct imports)
import {
  runMLPrediction,
  calculateAccuracy
} from "./ml_module_v8_6.js";

// Telegram init
const BOT_TOKEN = CONFIG?.TELEGRAM?.BOT_TOKEN || process.env.BOT_TOKEN;
const CHAT_ID = CONFIG?.TELEGRAM?.CHAT_ID || process.env.CHAT_ID;
const bot = BOT_TOKEN ? new TelegramBot(BOT_TOKEN, { polling: false }) : null;

// helper
const nf = (v, d = 2) =>
  typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : "N/A";
const bold = (x) => `<b>${x}</b>`;

// ---------- Fusion Label ----------
function fusionLabel(score) {
  if (score >= 0.7) return { label: "Strong Buy", emoji: "🚀" };
  if (score >= 0.2) return { label: "Buy", emoji: "🟢" };
  if (score > -0.2 && score < 0.2) return { label: "Neutral", emoji: "⚪" };
  if (score <= -0.2 && score > -0.7) return { label: "Sell", emoji: "🔴" };
  return { label: "Strong Sell", emoji: "⛔" };
}

// ---------- Fusion Score ----------
function computeFusionScore(indObj, ellObj) {
  let score = 0, weight = 0;

  try {
    const rsi = indObj?.RSI ?? 50;
    const rsiScore = (rsi - 50) / 50;
    score += rsiScore * 0.4;
    weight += 0.4;

    const macdh = indObj?.MACD?.hist ?? 0;
    const atr = Math.max(1, indObj?.ATR || 1);
    const macdScore = Math.tanh(macdh / atr);
    score += macdScore * 0.35;
    weight += 0.35;

    const pt =
      indObj?.priceTrend === "UP"
        ? 0.15
        : indObj?.priceTrend === "DOWN"
        ? -0.15
        : 0;
    score += pt;
    weight += 0.15;

    const vt =
      indObj?.volumeTrend === "INCREASING"
        ? 0.08
        : indObj?.volumeTrend === "DECREASING"
        ? -0.08
        : 0;
    score += vt;
    weight += 0.08;

    const ellSent = ellObj?.sentiment ?? 0;
    const ellConf = (ellObj?.confidence ?? 0) / 100;
    score += ellSent * (0.25 * ellConf);
    weight += 0.25 * ellConf;

    return Number(Math.max(-1, Math.min(1, score / weight)).toFixed(3));
  } catch (e) {
    return 0;
  }
}

// ---------- Overall Fusion ----------
function computeOverallFusion(mtf) {
  const weights = {
    "1m": 0.05,
    "5m": 0.1,
    "15m": 0.4,
    "30m": 0.2,
    "1h": 0.25
  };

  let s = 0,
    w = 0;
  for (const m of mtf) {
    const sc = m.fusionScore || 0;
    const wt = weights[m.tf] || 0.1;
    s += sc * wt;
    w += wt;
  }

  return Number(Math.max(-1, Math.min(1, s / w)).toFixed(3));
}

// ---------- Buy/Sell Probabilities ----------
function computeBuySellProb(overallFusion, mtf) {
  let buy = ((overallFusion + 1) / 2) * 100;
  let sell = 100 - buy;

  let ellSum = 0,
    ellW = 0;
  for (const m of mtf) {
    const ell = m.ell;
    if (ell?.sentiment !== undefined) {
      const c = (ell.confidence || 0) / 100;
      ellSum += ell.sentiment * c;
      ellW += c;
    }
  }
  const ellAvg = ellW ? ellSum / ellW : 0;

  buy += ellAvg * 10;
  sell = 100 - buy;

  const bullish = mtf.filter((m) => m.fusionScore > 0.2).length;
  const bearish = mtf.filter((m) => m.fusionScore < -0.2).length;
  const diff = bullish - bearish;

  if (diff > 0) buy += Math.min(8, diff * 2);
  else sell += Math.min(8, Math.abs(diff) * 2);

  buy = Math.max(0, Math.min(100, buy));
  sell = 100 - buy;

  return {
    buy: Math.round(buy * 100) / 100,
    sell: Math.round(sell * 100) / 100,
    ellAvg
  };
}

// ---------- Safe Elliott ----------
async function safeElliottForCandles(candles) {
  try {
    const ell = await analyzeElliott(candles);
    if (!ell || !ell.ok) return { ok: false };

    const pivots = ell.pivots || [];
    const lastH = pivots.filter((p) => p.type === "H").slice(-1)[0];
    const lastL = pivots.filter((p) => p.type === "L").slice(-1)[0];

    return {
      ok: true,
      ell,
      support: lastL?.price || null,
      resistance: lastH?.price || null
    };
  } catch {
    return { ok: false };
  }
}

// ---------- Heatmap ----------
function buildHeatmap(mtf) {
  const order = ["1m", "5m", "15m", "30m", "1h"];
  const map = (s) =>
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
    order
      .map((tf) => {
        const x = mtf.find((m) => m.tf === tf);
        return `${tf.toUpperCase()}:${map(x?.fusionScore || 0)}`;
      })
      .join(" | ")
  );
}

// ---------- TF Block ----------
function buildTFBlock(tf, price, ind, vol, ellSum, fusionScore, fib) {
  const fusion = fusionLabel(fusionScore);

  return `
<b>【${tf.toUpperCase()}】 ${fusion.emoji} ${fusion.label}</b>
💰 Price: <b>${nf(price)}</b> | Vol: ${vol?.status || "N/A"}
RSI: <b>${nf(ind.RSI)}</b> | MACD: <b>${nf(ind.MACD?.hist, 4)}</b> | ATR: <b>${nf(ind.ATR)}</b>
Structure: support:${nf(ellSum.support || fib?.lo)} | resistance:${nf(ellSum.resistance || fib?.hi)}
Fusion Score: ${fusionScore}
`.trim();
}

// ====================================================================
//                   BUILD  +  FORMAT AI REPORT
// ====================================================================

export async function buildAIReport(symbol = "BTCUSDT") {
  try {
    const tfs = ["1m", "5m", "15m", "30m", "1h"];
    const raw = await fetchMultiTF(symbol, tfs);

    const mtf = [];

    for (const tf of tfs) {
      const entry = raw[tf] || {};
      const candles = entry.data || [];
      const price =
        entry.price || candles.at(-1)?.close || candles.at(-1)?.c || 0;

      const ind = {
        RSI: indicators.computeRSI?.(candles) || 50,
        MACD: indicators.computeMACD?.(candles) || { hist: 0 },
        ATR: indicators.computeATR?.(candles) || 0,
        priceTrend:
          candles.at(-1)?.close > candles.at(-2)?.close
            ? "UP"
            : candles.at(-1)?.close < candles.at(-2)?.close
            ? "DOWN"
            : "FLAT",
        volumeTrend: indicators.volumeTrend?.(candles) || "STABLE"
      };

      const vol = indicators.analyzeVolume?.(candles) || {
        status: "UNKNOWN"
      };

      const ellRes = await safeElliottForCandles(candles);
      const ell = ellRes.ok ? ellRes.ell : null;

      let fib = null;
      try {
        fib = indicators.computeFibLevels?.(candles) || null;
      } catch {}

      const fusionScore = computeFusionScore(ind, ell || {});

      mtf.push({
        tf,
        price,
        candles,
        indicators: ind,
        vol,
        ell,
        ellSummary: ellRes,
        fib,
        fusionScore
      });
    }

    const overallFusion = computeOverallFusion(mtf);
    const probs = computeBuySellProb(overallFusion, mtf);

    const mlPrediction = await runMLPrediction(symbol, "15m");
    let mlAcc = 0;
    try {
      mlAcc = calculateAccuracy()?.accuracy || 0;
    } catch {}

    return {
      ok: true,
      symbol,
      price: mtf.find((x) => x.tf === "15m")?.price || 0,
      mtf,
      overallFusion,
      buyProb: probs.buy,
      sellProb: probs.sell,
      ellConsensus: probs.ellAvg,
      ml: {
        lastPrediction: mlPrediction,
        lastAccuracy: mlAcc
      },
      generatedAt: new Date().toISOString()
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------- Format Report ----------
export async function formatAIReport(report) {
  if (!report?.ok) return "Error building report.";

  const mtf = report.mtf;
  const heat = buildHeatmap(mtf);

  const tfBlocks = mtf
    .map((m) =>
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

  const ml = report.ml;

  const html = `
🚀 <b>${report.symbol} — AI Trader (Option-B UI)</b>
${new Date(report.generatedAt).toLocaleString()}
Price: <b>${nf(report.price)}</b>

${heat}

────────────────────
<b>📊 Multi-Timeframe Analysis</b>

${tfBlocks}

────────────────────
🧠 <b>Fusion Summary</b>
Bias: <b>${fusionLabel(report.overallFusion).label}</b>
Strength: ${report.overallFusion}
Buy Prob: <b>${report.buyProb}%</b> | Sell Prob: <b>${report.sellProb}%</b>

────────────────────
🤖 <b>ML Prediction</b>
Prediction: <b>${ml?.lastPrediction?.label || "N/A"}</b> (${ml?.lastPrediction?.prob || 0}%)
Accuracy: <b>${ml?.lastAccuracy || 0}%</b>

<i>Engine: Elliott + Fusion + ML v16 | Multi-source data</i>
`.trim();

  if (bot && CHAT_ID) {
    try {
      await bot.sendMessage(CHAT_ID, html, {
        parse_mode: "HTML",
        disable_web_page_preview: true
      });
    } catch {}
  }

  return html;
}

export default { buildAIReport, formatAIReport };