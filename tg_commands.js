// =====================================================
// tg_commands.js — TradingView Clean Format (Stable v11.4)
// =====================================================

import TelegramBot from "node-telegram-bot-api";
import CONFIG from "./config.js";
import { 
  fetchMarketData, 
  analyzeVolume, 
  computeFibLevels as _computeFibLevels 
} from "./utils.js";
import * as core from "./core_indicators.js";

// ===============================
// TELEGRAM INIT
// ===============================
const BOT_TOKEN = CONFIG?.TELEGRAM?.BOT_TOKEN || process.env.BOT_TOKEN;
const CHAT_ID  = CONFIG?.TELEGRAM?.CHAT_ID  || process.env.CHAT_ID;

const bot = BOT_TOKEN
  ? new TelegramBot(BOT_TOKEN, { polling: false })
  : null;

// ===============================
// SAFE FIB WRAPPER
// ===============================
function computeFibLevels(lo, hi) {
  try {
    if (typeof _computeFibLevels === "function") 
      return _computeFibLevels(lo, hi);
  } catch {}

  const range = hi - lo;
  return {
    retrace: {
      "0.236": hi - 0.236 * range,
      "0.382": hi - 0.382 * range,
      "0.5":   hi - 0.5 * range,
      "0.618": hi - 0.618 * range
    },
    extensions: {
      "1.272": hi + 0.272 * range,
      "1.618": hi + 0.618 * range
    },
    lo, hi
  };
}

// ===============================
// INDICATOR WRAPPER
// ===============================
async function calcIndicatorsSafe(candles) {
  try {
    if (core && typeof core.calculateIndicators === "function") {
      return await core.calculateIndicators(candles);
    }
  } catch {}

  return { RSI: null, MACD: { hist: null }, ATR: null };
}

// ===============================
// SAFE TELEGRAM SEND
// ===============================
async function safeSend(text) {
  if (!bot || !CHAT_ID) return text;

  // Escape problematic chars for MarkdownV2
  let safe = text
    .replace(/_/g, "\\_")
    .replace(/\*/g, "\\*")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/-/g, "\\-")
    .replace(/>/g, "\\>")
    .replace(/</g, "\\<")
    .replace(/!/g, "\\!");

  try {
    await bot.sendMessage(CHAT_ID, safe, {
      parse_mode: "MarkdownV2",
      disable_web_page_preview: true
    });
  } catch (err) {
    console.log("⚠ MarkdownV2 failed. Retrying as plain text...");
    try {
      await bot.sendMessage(CHAT_ID, text);   // raw fallback
    } catch (e) {
      console.error("❌ Telegram send final fail:", e.message);
    }
  }

  return text;
}

// ===============================
// BUILD AI REPORT
// ===============================
export async function buildAIReport(symbol = "BTCUSDT", context = null) {
  try {
    if (!context) {
      const c = await fetchMarketData(symbol, "15m", 200);
      const candles = c?.data || c || [];
      context = {
        price: candles.length ? parseFloat(candles.at(-1).close) : 0,
        candles,
        ml: null,
        ell: null,
        news: null,
        socketAlive: false
      };
    }

    const tfs = ["1m", "5m", "15m", "30m", "1h"];
    const mtf = [];

    for (const tf of tfs) {
      try {
        const resp = await fetchMarketData(symbol, tf, 200);
        const candles = resp?.data || resp || [];
        const last = candles.at(-1);

        const indicators = candles.length
          ? await calcIndicatorsSafe(candles)
          : { RSI: null, MACD: { hist: null }, ATR: null };

        const volTrend = analyzeVolume(candles);
        const hi = candles.length ? Math.max(...candles.map(c => +c.high)) : null;
        const lo = candles.length ? Math.min(...candles.map(c => +c.low)) : null;

        const bias =
          indicators?.RSI && indicators?.MACD?.hist
            ? indicators.RSI > 60 && indicators.MACD.hist > 0
              ? "Bullish"
              : indicators.RSI < 40 && indicators.MACD.hist < 0
                ? "Bearish"
                : "Neutral"
            : "N/A";

        mtf.push({
          tf,
          candles,
          last,
          indicators,
          volTrend,
          fib: hi && lo ? computeFibLevels(lo, hi) : null,
          bias
        });

      } catch (e) {
        mtf.push({ tf, error: String(e) });
      }
    }

    const tf15 = mtf.find(x => x.tf === "15m");

    return {
      symbol,
      price: context.price || (tf15?.last ? parseFloat(tf15.last.close) : 0),
      mtf,
      ell: context.ell,
      ml: context.ml,
      news: context.news,
      fib15: tf15?.fib || null,
      socketAlive: context.socketAlive,
      generatedAt: new Date().toISOString()
    };

  } catch (err) {
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
      error: err.message
    };
  }
}

// ===============================
// FORMAT + SEND  (NO HTML — SAFE)
// ===============================
export async function formatAIReport(r) {
  const price = Number(r.price || 0);

  const ell = r.ell
    ? `${r.ell.wave || "N/A"} | Conf ${(r.ell.confidence || 0).toFixed(1)}%`
    : "N/A";

  const mlLabel = r.ml?.label || "Neutral";
  const mlProb = Number(r.ml?.prob ?? r.ml?.confidence ?? 0).toFixed(1);

  const block = r.mtf
    .map(m => {
      if (m.error) return `[${m.tf}] Error: ${m.error}`;

      const rsi  = m.indicators?.RSI ? m.indicators.RSI.toFixed(1) : "N/A";
      const macd = m.indicators?.MACD?.hist ? m.indicators.MACD.hist.toFixed(3) : "N/A";
      const atr  = m.indicators?.ATR ? m.indicators.ATR.toFixed(2) : "N/A";
      const vol  = m.volTrend === "up" ? "Rising" 
                : m.volTrend === "down" ? "Falling" 
                : "Stable";

      const emoji =
        m.bias === "Bullish" ? "🟢" :
        m.bias === "Bearish" ? "🔴" :
        "⚪";

      return `
[${m.tf}] ${emoji} ${m.bias}
RSI ${rsi} | MACD ${macd} | ATR ${atr}
Price: ${m.last?.close || "N/A"} | Vol: ${vol}
Signal: ${m.bias === "Bullish" ? "BUY" : m.bias === "Bearish" ? "SELL" : "HOLD"}
      `.trim();
    })
    .join("\n--------------------------------\n");

  const atr15 = r.mtf.find(x => x.tf === "15m")?.indicators?.ATR || price * 0.005;

  const tp1 = (price + atr15 * 1.5).toFixed(2);
  const tp2 = (price + atr15 * 3).toFixed(2);
  const tp3 = (price + atr15 * 5).toFixed(2);
  const sl  = (price - atr15 * 2).toFixed(2);

  const fib = r.fib15;
  const fibRange = fib ? `${fib.lo} – ${fib.hi}` : "N/A";

  const sentiment = r.news?.sentiment || 0;
  const sentTxt =
    sentiment > 0 ? "Bullish 🟢" :
    sentiment < 0 ? "Bearish 🔴" :
    "Neutral";

  const headlines = (r.news?.headlines || [])
    .slice(0, 4)
    .map(h => `• ${h}`)
    .join("\n") || "N/A";

  // FINAL TEXT (NO HTML)
  const msg = `
${r.symbol} — AI Trader Report
${new Date(r.generatedAt).toLocaleString()}

Price: ${price.toFixed(2)}

AI: ${mlLabel} (${mlProb}%)
Elliott: ${ell}

📊 Multi-Timeframe
${block}

🎯 TP/SL
TP1: ${tp1}
TP2: ${tp2}
TP3: ${tp3}
SL: ${sl}

Fib Zone (15m): ${fibRange}

📰 News Impact: ${sentTxt}
${headlines}

v11.4 — TradingView Clean UI
  `.trim();

  await safeSend(msg);
  return msg;
}