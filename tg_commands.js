// tg_commands.js — buildAIReport + formatAIReport (A-style UI)
import TelegramBot from "node-telegram-bot-api";
import CONFIG from "./config.js";
import { fetchMarketData, fetchMultiTF } from "./utils.js";
import * as indicators from "./core_indicators.js";

const BOT_TOKEN = CONFIG.TELEGRAM.BOT_TOKEN || process.env.BOT_TOKEN;
const CHAT_ID = CONFIG.TELEGRAM.CHAT_ID || process.env.CHAT_ID;
const bot = BOT_TOKEN ? new TelegramBot(BOT_TOKEN, { polling: false }) : null;

export async function buildAIReport(symbol = "BTCUSDT", context = null) {
  // only 15m context requested primarily, but we produce multi-TF data
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
      priceTrend: (candles.length >= 2) ? (candles.at(-1).close > candles.at(-2).close ? "UP" : (candles.at(-1).close < candles.at(-2).close ? "DOWN" : "FLAT")) : "FLAT",
      volumeTrend: indicators.volumeTrend(candles)
    };
    const vol = indicators.analyzeVolume(candles);
    const fib = indicators.computeFibLevelsFromCandles(candles);
    const signal = indicators.deriveSignal(indicatorsObj);

    mtf.push({
      tf, candles, indicators: indicatorsObj, vol, fib, signal, price: entry.price || 0
    });
  }

  const basePrice = mtf.find(x=>x.tf==="15m")?.price || mtf[0]?.price || 0;

  return {
    symbol,
    price: basePrice,
    mtf,
    generatedAt: new Date().toISOString()
  };
}

export async function formatAIReport(report) {
  const price = Number(report.price || 0);
  const mtfTxt = report.mtf.map(m => {
    const rsi = typeof m.indicators.RSI === "number" ? m.indicators.RSI.toFixed(1) : "N/A";
    const macd = typeof m.indicators.MACD?.hist === "number" ? m.indicators.MACD.hist.toFixed(4) : "N/A";
    const atr = typeof m.indicators.ATR === "number" ? m.indicators.ATR.toFixed(2) : "N/A";
    const vol = m.vol?.status || "N/A";
    const signal = m.signal || "HOLD";
    return `\n[${m.tf}] ${signal}\nRSI:${rsi} | MACD:${macd} | ATR:${atr}\nPrice: ${m.price || "N/A"} | Vol:${vol}\n`;
  }).join("\n-----------------\n");

  const fib15 = report.mtf.find(x=>x.tf==="15m")?.fib;
  const fibRange = fib15 ? `${fib15.lo} - ${fib15.hi}` : "N/A";

  const html = `
<b>${report.symbol} — AI Trader (single-file)</b>
${new Date(report.generatedAt).toLocaleString()}

Price: <b>${price.toFixed(2)}</b>

<b>📊 Multi-Timeframe Overview</b>
${mtfTxt}

🎯 TP/SL (ATR-based)
TP1: n/a | TP2: n/a | TP3: n/a
SL: n/a

Fib Zone (15m): ${fibRange}

<i>Data: Multi-source (Binance Vision + Binance + Bybit/KuCoin/CB) | vSingleFile</i>
  `.trim();

  if (!bot || !CONFIG.TELEGRAM.CHAT_ID) return html;

  try {
    await bot.sendMessage(CONFIG.TELEGRAM.CHAT_ID, html, { parse_mode: "HTML", disable_web_page_preview: true });
  } catch (e) {
    console.error("Telegram send failed:", e?.message || e);
  }

  return html;
}