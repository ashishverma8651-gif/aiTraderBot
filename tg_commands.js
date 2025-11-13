// ===============================================
// 🤖 tg_commands.js — AI Trader v10.2 (Unified UI + Command Engine)
// Multi-TF Indicators + ML + Elliott + Fibonacci + News + TP/SL
// ===============================================

import TelegramBot from "node-telegram-bot-api";
import CONFIG from "./config.js";
import { fetchMarketData, keepAlive } from "./utils.js";
import * as core from "./core_indicators.js";
import { runMLPrediction } from "./ml_module_v8_6.js";
import { analyzeElliott } from "./elliott_module.js";
import { fetchNews } from "./news_social.js";

// ===============================================
// 🔐 Telegram Bot Setup
// ===============================================
const bot = new TelegramBot(CONFIG.TG.BOT_TOKEN, { polling: true });
const CHAT_ID = CONFIG.TG.CHAT_ID;

// ===============================================
// ⚙️ Utility Functions
// ===============================================
function highestHigh(candles, lookback = 100) {
  const slice = candles.slice(-lookback);
  return Math.max(...slice.map((c) => parseFloat(c.high)));
}
function lowestLow(candles, lookback = 100) {
  const slice = candles.slice(-lookback);
  return Math.min(...slice.map((c) => parseFloat(c.low)));
}
function computeFibLevels(lo, hi) {
  const range = hi - lo;
  return {
    retrace: {
      "0.236": hi - 0.236 * range,
      "0.382": hi - 0.382 * range,
      "0.5": hi - 0.5 * range,
      "0.618": hi - 0.618 * range,
    },
    extensions: {
      "1.272": hi + 0.272 * range,
      "1.618": hi + 0.618 * range,
    },
  };
}
function biasFromIndicators(rsi, macd) {
  if (rsi > 60 && macd > 0) return "Bullish";
  if (rsi < 40 && macd < 0) return "Bearish";
  return "Sideways";
}

// ===============================================
// 📊 Multi-Timeframe Data Fetcher
// ===============================================
async function fetchMultiTFData(symbol, timeframes = ["1m", "5m", "15m", "30m", "1h"]) {
  const results = [];
  for (const tf of timeframes) {
    try {
      const data = await fetchMarketData(symbol, tf, 200);
      const candles = data.data || data;
      const indicators = await core.calculateIndicators(candles);
      const rsi = indicators.RSI || 50;
      const macd = indicators.MACD?.hist ?? 0;
      const atr = indicators.ATR || 0;
      const fib = computeFibLevels(lowestLow(candles), highestHigh(candles));
      const bias = biasFromIndicators(rsi, macd);

      results.push({ tf, rsi, macd, atr, fib, bias });
    } catch (err) {
      results.push({ tf, error: err.message });
    }
  }
  return results;
}

// ===============================================
// 🧠 Build AI Report (core logic)
// ===============================================
async function buildAIReport(symbol = "BTCUSDT") {
  const mtf = await fetchMultiTFData(symbol);
  const tf15 = mtf.find((m) => m.tf === "15m");
  const price = tf15 ? tf15.fib.retrace["0.5"] : 0;

  // ML + Elliott + News
  const ml = await runMLPrediction(symbol);
  const ell = await analyzeElliott(await fetchMarketData(symbol, "15m", 200));
  const news = await fetchNews(symbol.replace("USDT", ""));

  // Bias + confidence
  const bullish = mtf.filter((t) => t.bias === "Bullish").length;
  const bearish = mtf.filter((t) => t.bias === "Bearish").length;
  const overallBias =
    bullish > bearish ? "Bullish" : bearish > bullish ? "Bearish" : "Sideways";

  const confidence = Math.round((Math.max(bullish, bearish) / mtf.length) * 100);

  // TP/SL calculation
  const atr = tf15?.atr || price * 0.005;
  const tpBuy = [price * 1.02, price * 1.04, price * 1.06].map((p) => p.toFixed(2));
  const tpSell = [price * 0.98, price * 0.96, price * 0.94].map((p) => p.toFixed(2));
  const slBuy = (price * 0.97).toFixed(2);
  const slSell = (price * 1.03).toFixed(2);

  // Reversal Watcher
  const reversal = [];
  if (ell?.wave?.includes("5")) reversal.push("⚠️ Possible Wave 5 exhaustion");
  if (ml.label === "Bearish" && ml.prob > 70) reversal.push("🔻 ML predicts downside move");
  if (!reversal.length) reversal.push("✅ No major reversals detected");

  // Final Report
  return {
    symbol,
    price,
    mtf,
    ell,
    ml,
    news,
    overallBias,
    confidence,
    tpBuy,
    tpSell,
    slBuy,
    slSell,
    reversal: reversal.join("\n"),
  };
}

// ===============================================
// 🎨 Telegram UI Formatter
// ===============================================
function formatAIReport(report) {
  const { symbol, price, mtf, ell, ml, news, overallBias, confidence } = report;

  const emoji =
    overallBias === "Bullish" ? "🟢" : overallBias === "Bearish" ? "🔴" : "⚪";

  const tfSummary = mtf
    .map(
      (m) =>
        `${m.tf.padEnd(4)} → ${m.bias === "Bullish" ? "🟢" : m.bias === "Bearish" ? "🔴" : "⚪"} RSI:${m.rsi.toFixed(
          1
        )} | MACD:${m.macd.toFixed(2)}`
    )
    .join("\n");

  const headlines = (news.headlines || [])
    .slice(0, 3)
    .map((h) => `• ${h}`)
    .join("\n");

  return `
🚀 <b>${symbol}</b> — AI Trader v10.2
💰 <b>Price:</b> ${price.toFixed(2)} USDT
📊 <b>Overall Bias:</b> ${emoji} ${overallBias} (${confidence}%)
🧠 <b>ML Prediction:</b> ${ml.label} (${ml.prob.toFixed(1)}%)
🌀 <b>Elliott Wave:</b> ${ell.wave || "N/A"} | Conf: ${(ell.confidence || 0).toFixed(1)}%
━━━━━━━━━━━━━━━━━━━
⏱️ <b>Multi-Timeframe Summary</b>
${tfSummary}
━━━━━━━━━━━━━━━━━━━
🎯 <b>Take Profit (Buy):</b> ${report.tpBuy.join(" / ")}
💥 <b>Take Profit (Sell):</b> ${report.tpSell.join(" / ")}
🛑 <b>SL Buy:</b> ${report.slBuy} | <b>SL Sell:</b> ${report.slSell}
━━━━━━━━━━━━━━━━━━━
📈 <b>Reversal Watcher</b>
${report.reversal}
━━━━━━━━━━━━━━━━━━━
📰 <b>News Sentiment:</b> ${news.sentiment > 0 ? "🟢 Bullish" : "🔴 Bearish"} (${news.score})
🗞️ <b>Headlines:</b>
${headlines || "N/A"}
━━━━━━━━━━━━━━━━━━━
<i>Data: Binance + ML + News | AI Trader Pro v10.2</i>
  `.trim();
}

// ===============================================
// 🚀 Telegram Commands
// ===============================================
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `👋 Welcome to <b>AI Trader Bot v10.2</b>\nUse:\n/btc — BTC Report\n/eth — ETH Report\n/help — Command List`,
    { parse_mode: "HTML" }
  );
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `🧭 <b>Available Commands</b>\n
/btc — BTCUSDT AI Report
/eth — ETHUSDT AI Report
/reversal — Reversal Watcher
/news — Latest News Impact
/all — Summary of BTC + ETH
`,
    { parse_mode: "HTML" }
  );
});

bot.onText(/\/btc/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "⏳ Fetching BTCUSDT analysis...", { parse_mode: "HTML" });
  const report = await buildAIReport("BTCUSDT");
  bot.sendMessage(chatId, formatAIReport(report), { parse_mode: "HTML" });
});

bot.onText(/\/eth/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "⏳ Fetching ETHUSDT analysis...", { parse_mode: "HTML" });
  const report = await buildAIReport("ETHUSDT");
  bot.sendMessage(chatId, formatAIReport(report), { parse_mode: "HTML" });
});

bot.onText(/\/reversal/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "🔍 Scanning reversals (BTCUSDT)...", { parse_mode: "HTML" });
  const report = await buildAIReport("BTCUSDT");
  bot.sendMessage(chatId, `📉 <b>Reversal Watcher</b>\n${report.reversal}`, { parse_mode: "HTML" });
});

bot.onText(/\/news/, async (msg) => {
  const chatId = msg.chat.id;
  const news = await fetchNews("BTC");
  const headlines = news.headlines.slice(0, 5).map((h) => `• ${h}`).join("\n");
  bot.sendMessage(
    chatId,
    `🗞️ <b>BTC Market News</b>\nSentiment: ${
      news.sentiment > 0 ? "🟢 Bullish" : "🔴 Bearish"
    } (${news.score})\n${headlines}`,
    { parse_mode: "HTML" }
  );
});

// ===============================================
// 🔁 Auto 15m BTC Reports
// ===============================================
async function sendAutoReport() {
  const report = await buildAIReport("BTCUSDT");
  bot.sendMessage(CHAT_ID, formatAIReport(report), { parse_mode: "HTML" });
  console.log(`✅ Auto BTC report sent at ${new Date().toLocaleTimeString()}`);
}

setInterval(sendAutoReport, 15 * 60 * 1000);
sendAutoReport();

// ===============================================
// ♻️ Keep Alive Ping
// ===============================================
if (CONFIG.SERVER.KEEP_ALIVE) {
  setInterval(async () => {
    try {
      await keepAlive();
      console.log("✅ KeepAlive success ping");
    } catch (err) {
      console.warn("⚠️ KeepAlive ping failed:", err.message);
    }
  }, 5 * 60 * 1000);
}

export { buildAIReport, formatAIReport };