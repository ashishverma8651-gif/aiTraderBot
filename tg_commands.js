// ===============================================
// tg_commands.js — Telegram UI builder (safe + real-data)
// Exports: buildAIReport, formatAIReport
// ===============================================

import TelegramBot from "node-telegram-bot-api";
import CONFIG from "./config.js";
import { fetchMarketData } from "./utils.js";
import * as core from "./core_indicators.js"; // expects calculateIndicators(candles)
import { computeFibLevels as _computeFibLevels } from "./utils.js"; // optional; fallback defined below

// Telegram setup
const BOT_TOKEN = CONFIG?.TELEGRAM?.BOT_TOKEN || process.env.BOT_TOKEN;
const CHAT_ID = CONFIG?.TELEGRAM?.CHAT_ID || process.env.CHAT_ID;
if (!BOT_TOKEN) console.warn("⚠️ TELEGRAM BOT TOKEN not set in config or env.");
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// safe fib compute fallback
function computeFibLevels(lo, hi) {
  if (typeof _computeFibLevels === "function") {
    try { return _computeFibLevels(lo, hi); } catch (_) {}
  }
  const range = hi - lo;
  return {
    retrace: {
      "0.236": hi - 0.236 * range,
      "0.382": hi - 0.382 * range,
      "0.5": hi - 0.5 * range,
      "0.618": hi - 0.618 * range,
      "0.786": hi - 0.786 * range
    },
    extensions: {
      "1.272": hi + 0.272 * range,
      "1.618": hi + 0.618 * range
    },
    hi, lo
  };
}

// helper to compute per-tf indicators (uses core.calculateIndicators if available)
async function calcIndicatorsSafe(candles) {
  try {
    if (core && typeof core.calculateIndicators === "function") {
      return await core.calculateIndicators(candles);
    }
  } catch (e) {
    // fall through
  }
  return { RSI: null, MACD: { hist: null }, ATR: null };
}

// Build AI report object (no formatting) — safe, uses live data when needed
export async function buildAIReport(symbol = "BTCUSDT", data = null) {
  try {
    // If data not passed, fetch minimal context
    let context = data;
    if (!context) {
      const candlesResp = await fetchMarketData(symbol, "15m", 200);
      const candles = (candlesResp && (candlesResp.data || candlesResp)) || [];
      context = {
        price: candles.length ? parseFloat(candles.at(-1).close) : 0,
        candles,
        ml: null,
        ell: null,
        news: null,
        socketAlive: false
      };
    }

    // Multi-timeframe fetch (1m,5m,15m,30m,1h) but non-blocking for performance
    const tfs = ["1m", "5m", "15m", "30m", "1h"];
    const mtfResults = [];
    for (const tf of tfs) {
      try {
        const resp = await fetchMarketData(symbol, tf, 200);
        const candles = resp?.data || resp || [];
        const indicators = candles.length ? await calcIndicatorsSafe(candles) : { RSI: null, MACD: { hist: null }, ATR: null };
        const hi = candles.length ? Math.max(...candles.map(c => parseFloat(c.high))) : null;
        const lo = candles.length ? Math.min(...candles.map(c => parseFloat(c.low))) : null;
        const fib = (hi !== null && lo !== null) ? computeFibLevels(lo, hi) : null;
        mtfResults.push({
          tf,
          candles,
          last: candles.length ? candles.at(-1) : null,
          indicators,
          fib,
          bias: (indicators?.RSI !== null && indicators?.MACD?.hist !== null)
            ? (indicators.RSI > 60 && indicators.MACD.hist > 0 ? "Bullish" : indicators.RSI < 40 && indicators.MACD.hist < 0 ? "Bearish" : "Sideways")
            : "N/A"
        });
      } catch (e) {
        mtfResults.push({ tf, error: String(e?.message || e) });
      }
    }

    // Ensure tf15 exists
    const tf15 = mtfResults.find(m => m.tf === "15m") || {};
    // Safe fib access
    const safeFib = tf15?.fib || null;

    // Build structured report object
    const report = {
      symbol,
      price: context.price ?? (tf15?.last ? parseFloat(tf15.last.close) : 0),
      mtf: mtfResults,
      ell: context.ell || null,
      ml: context.ml || null,
      news: context.news || null,
      fib15: safeFib,
      socketAlive: context.socketAlive || false,
      generatedAt: new Date().toISOString()
    };

    return report;
  } catch (err) {
    console.error("❌ buildAIReport error:", err?.message || err);
    // Return minimal safe object
    return {
      symbol,
      price: 0,
      mtf: [],
      ell: null,
      ml: null,
      news: null,
      fib15: null,
      socketAlive: false,
      generatedAt: new Date().toISOString(),
      error: err?.message || "unknown"
    };
  }
}

// Format + send to Telegram (keeps screenshot-style UI)
// This function both builds final message and sends it via bot.
export async function formatAIReport(reportObj) {
  try {
    const symbol = reportObj.symbol || "BTCUSDT";
    const price = Number(reportObj.price || 0);

    // Elliott
    const ellText = reportObj.ell ? `${reportObj.ell.wave || "N/A"} | Conf: ${(reportObj.ell.confidence || 0).toFixed(1)}%` : "N/A";

    // ML
    const mlLabel = reportObj.ml?.label || "Neutral";
    const mlProb = Number(reportObj.ml?.prob ?? reportObj.ml?.confidence ?? 0);

    // multi-tf summary formatting (screenshot style)
    const tfLines = reportObj.mtf.map((m) => {
      if (m.error) return `${m.tf.padEnd(4)} | Error: ${m.error}`;
      const rsi = (m.indicators?.RSI !== null && m.indicators?.RSI !== undefined) ? m.indicators.RSI.toFixed(1) : "N/A";
      const macd = (m.indicators?.MACD?.hist !== null && m.indicators?.MACD?.hist !== undefined) ? m.indicators.MACD.hist.toFixed(2) : "N/A";
      const vol = m.last?.volume ?? m.last?.vol ?? "N/A";
      const emoji = m.bias === "Bullish" ? "🟢" : m.bias === "Bearish" ? "🔴" : "⚪";
      return `📈 ${m.tf} | ${emoji} RSI:${rsi} | MACD:${macd} | Vol:${vol}`;
    }).join("\n");

    // Safe fib and TP/SL
    const fib = reportObj.fib15 || {};
    const fib05 = fib?.retrace?.["0.5"] ?? null;
    const fibRangeText = fib?.lo && fib?.hi ? `${fib.lo} - ${fib.hi}` : "N/A";

    // TP/SL: ATR-based fallback (use 15m ATR or percent)
    const atr15 = reportObj.mtf.find(x => x.tf === "15m")?.indicators?.ATR ?? null;
    const atrValue = atr15 || Math.max(price * 0.005, 1);
    const tp1 = (price + atrValue * 1.5).toFixed(2);
    const tp2 = (price + atrValue * 3).toFixed(2);
    const tp3 = (price + atrValue * 5).toFixed(2);
    const sl = (price - atrValue * 2).toFixed(2);

    // Bias aggregation
    const bullish = reportObj.mtf.filter(m => m.bias === "Bullish").length;
    const bearish = reportObj.mtf.filter(m => m.bias === "Bearish").length;
    const neutral = reportObj.mtf.filter(m => m.bias === "Sideways" || m.bias === "N/A").length;
    const biasText = bullish > bearish ? "Bullish" : bearish > bullish ? "Bearish" : "Neutral";
    const strength = Math.round((Math.abs(bullish - bearish) / Math.max(1, reportObj.mtf.length)) * 100);

    // Headline snippet
    const headlines = (reportObj.news?.headlines || []).slice(0, 4).map(h => `• ${h}`).join("\n") || "N/A";

    // Build final HTML (match screenshot style)
    const html = `
🚀 <b>${symbol} — AI Trader</b>
🕒 ${new Date(reportObj.generatedAt).toLocaleString()}
📡 Source: ${reportObj.socketAlive ? "Binance (Live WS)" : "REST (Fallback)"}
💰 <b>Price:</b> ${price.toFixed(2)}

📊 <b>Elliott Wave (15m)</b>
${ellText}

🧠 <b>AI Prediction:</b> ${mlLabel} (${mlProb.toFixed(1)}%)
━━━━━━━━━━━━━━━━━━━
${tfLines}
━━━━━━━━━━━━━━━━━━━
Bias: <b>${biasText}</b> | Strength: ${strength}% | ML Prob: ${mlProb.toFixed(1)}%
🎯 TP1: ${tp1} | TP2: ${tp2} | TP3: ${tp3}  | 🛑 SL: ${sl}
Breakout zone (low-high): ${fibRangeText}
━━━━━━━━━━━━━━━━━━━
📰 <b>News Impact:</b> ${reportObj.news?.sentiment > 0 ? "Bullish 🟢" : reportObj.news?.sentiment < 0 ? "Bearish 🔴" : "Neutral"}
🗞️ <b>Headlines:</b>
${headlines}
━━━━━━━━━━━━━━━━━━━
<i>Data: Binance + ML + Elliott | v10.2</i>
`.trim();

    // Send message (safe)
    if (!BOT_TOKEN || !CHAT_ID) {
      console.warn("⚠️ Telegram token or chat id missing — skipping send");
      return html;
    }

    try {
      await bot.sendMessage(CHAT_ID, html, { parse_mode: "HTML", disable_web_page_preview: true });
      return html;
    } catch (err) {
      console.error("❌ Telegram send failed:", err?.message || err);
      // still return the message string so callers may log it
      return html;
    }
  } catch (err) {
    console.error("❌ formatAIReport error:", err?.message || err);
    // return fallback simple message
    const fallback = `⚠️ Error building report for ${reportObj?.symbol || "BTCUSDT"}`;
    try { if (BOT_TOKEN && CHAT_ID) await bot.sendMessage(CHAT_ID, fallback); } catch (_) {}
    return fallback;
  }
}

// Keep named exports exactly as expected
