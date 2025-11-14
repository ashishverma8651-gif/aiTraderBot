// tg_commands.js — A-Type Premium UI (Old Style)
import TelegramBot from "node-telegram-bot-api";
import CONFIG from "./config.js";
import { fetchMultiTF } from "./utils.js";
import * as indicators from "./core_indicators.js";

const BOT_TOKEN = CONFIG.TELEGRAM.BOT_TOKEN || process.env.BOT_TOKEN;
const CHAT_ID = CONFIG.TELEGRAM.CHAT_ID || process.env.CHAT_ID;
const bot = BOT_TOKEN ? new TelegramBot(BOT_TOKEN, { polling: false }) : null;

export async function buildAIReport(symbol = "BTCUSDT", context = null) {
  const tfs = ["1m","5m","15m","30m","1h"];
  const mtfRaw = await fetchMultiTF(symbol, tfs);
  const mtf = [];

  for (const tf of tfs) {
    const entry = mtfRaw[tf] || { data: [], price:0 };
    const candles = entry.data || [];

    const indicatorsObj = {
      RSI: indicators.computeRSI(candles),
      MACD: indicators.computeMACD(candles),
      ATR: indicators.computeATR(candles),
      priceTrend: candles.length >= 2
        ? (candles.at(-1).close > candles.at(-2).close ? "UP" :
           candles.at(-1).close < candles.at(-2).close ? "DOWN" : "FLAT")
        : "FLAT",
      volumeTrend: indicators.volumeTrend(candles)
    };

    const vol = indicators.analyzeVolume(candles);
    const fib = indicators.computeFibLevelsFromCandles(candles);
    const signal = indicators.deriveSignal(indicatorsObj);

    mtf.push({
      tf, candles, indicators: indicatorsObj, vol, fib, signal,
      price: entry.price || 0
    });
  }

  const basePrice = mtf.find(x => x.tf === "15m")?.price || mtf[0]?.price || 0;

  return {
    symbol,
    price: basePrice,
    mtf,
    generatedAt: new Date().toISOString()
  };
}

export async function formatAIReport(report) {

  const price = Number(report.price || 0);

  // --- build old-style multiTF block ---
  const tfBlock = report.mtf.map(m => {
    const RSI = m.indicators.RSI?.toFixed?.(1) || "N/A";
    const MACD = m.indicators.MACD?.hist?.toFixed?.(4) || "N/A";
    const ATR = m.indicators.ATR?.toFixed?.(2) || "N/A";
    const VOL = m.vol?.status || "N/A";

    let badge = "⚪";
    if (m.signal === "BUY") badge = "🟢";
    if (m.signal === "SELL") badge = "🔴";

    return `
<b>【${m.tf.toUpperCase()}】 ${badge} ${m.signal}</b>
💰 Price: <b>${m.price}</b>  |  📊 Vol: ${VOL}
RSI: <b>${RSI}</b> | MACD: <b>${MACD}</b> | ATR: <b>${ATR}</b>
`;
  }).join(`\n──────────────\n`);


  // ---- FIB 15m ----
  const fib15 = report.mtf.find(x => x.tf === "15m")?.fib;
  const fibText = fib15 ? `${fib15.lo} - ${fib15.hi}` : "N/A";


  // ==========================
  // OLD PREMIUM UI TEMPLATE
  // ==========================

  const text = `
🚀 <b>${report.symbol} — AI Trader v9.5</b>
${new Date(report.generatedAt).toLocaleString()}
Source: Binance
Price: <b>${price.toFixed(2)}</b>

📈 <b>Elliott Wave (15m)</b>
🔻⚠️ <i>Placeholder: Elliott module not loaded</i>

⚠️ <b>Possible Reversal Signal</b>
<i>Placeholder sentiment</i>

────────────────────
<b>📊 Multi-Timeframe Analysis</b>
${tfBlock}
────────────────────

<b>Bias:</b> Neutral | <b>Strength:</b> 10% | <b>ML Prob:</b> 20%
<b>Accuracy(last10):</b> 0%
<i>ML Placeholder — module not loaded</i>

🎯 <b>TP/SL (ATR-Based)</b>
TP1: n/a | TP2: n/a | TP3: n/a  
SL: n/a

📐 <b>Fib Zone (15m)</b>: ${fibText}

📰 <b>News Impact:</b> Low (placeholder)
• News module not active
• Headlines placeholder

<i>Data: Binance Vision + Binance + Bybit/KuCoin/CB | A-Type UI</i>
`.trim();


  if (!bot || !CHAT_ID) return text;

  try {
    await bot.sendMessage(CHAT_ID, text, {
      parse_mode: "HTML",
      disable_web_page_preview: true
    });
  } catch (err) {
    console.error("Telegram send failed:", err?.message || err);
  }

  return text;
}