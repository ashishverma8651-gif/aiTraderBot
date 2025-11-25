// aiTraderBot.js — FINAL FIXED VERSION
import TelegramBot from "node-telegram-bot-api";
import CONFIG from "./config.js";
import { fetchPrice, fetchMultiTF } from "./utils.js";
import { calcRSI, calcATR, calcTrend } from "./indicators.js";

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// --------------------------------------------------
// STATIC TELEGRAM KEYBOARD
// --------------------------------------------------
const mainKeyboard = {
  reply_markup: {
    keyboard: [
      ["⚡ Generate Signal"],
      ["Crypto", "India"],
      ["Forex", "Commodities"],
      ["Auto-Report: OFF"]
    ],
    resize_keyboard: true
  }
};

// Auto report state
let autoReport = false;
let autoInterval = null;

// --------------------------------------------------
// START COMMAND
// --------------------------------------------------
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "🔥 *AI Trader Bot Ready*\nSelect a market or generate a signal!",
    { parse_mode: "Markdown", ...mainKeyboard }
  );
});

// --------------------------------------------------
// MARKET SWITCH
// --------------------------------------------------
const switchMarket = (chat, market) => {
  CONFIG.ACTIVE_MARKET = market;
  CONFIG.ACTIVE_SYMBOL = CONFIG.DEFAULT_BY_MARKET[market];
  bot.sendMessage(chat, `✅ Market switched to *${market}*`, { parse_mode: "Markdown" });
};

// --------------------------------------------------
// MAIN MESSAGE HANDLER
// --------------------------------------------------
bot.on("message", async (msg) => {
  const text = msg.text;
  const chat = msg.chat.id;

  // MARKET BUTTONS
  if (text === "Crypto") return switchMarket(chat, "CRYPTO");
  if (text === "India") return switchMarket(chat, "INDIA");
  if (text === "Forex") return switchMarket(chat, "FOREX");
  if (text === "Commodities") return switchMarket(chat, "COMMODITIES");

  // --------------------------------------------------
  // AUTO REPORT TOGGLE
  // --------------------------------------------------
  if (text.startsWith("Auto-Report")) {
    autoReport = !autoReport;

    if (autoReport) {
      bot.sendMessage(chat, "🟢 Auto-report enabled (every 10 min)");
      autoInterval = setInterval(() => generateSignal(chat, true), CONFIG.REPORT_INTERVAL_MS);
    } else {
      bot.sendMessage(chat, "🔴 Auto-report disabled");
      clearInterval(autoInterval);
    }

    bot.sendMessage(chat, "Updated!", { ...mainKeyboard });
    return;
  }

  // --------------------------------------------------
  // GENERATE SIGNAL BUTTON
  // --------------------------------------------------
  if (text === "⚡ Generate Signal") {
    return generateSignal(chat, false);
  }
});

// --------------------------------------------------
// MAIN SIGNAL GENERATION FUNCTION
// --------------------------------------------------
async function generateSignal(chat, isAutoReport = false) {
  const market = CONFIG.ACTIVE_MARKET;
  const symbol = CONFIG.ACTIVE_SYMBOL;

  if (!isAutoReport) {
    bot.sendMessage(chat, `📡 Fetching *${symbol}* (${market})...\nPlease wait 2–4 sec`, {
      parse_mode: "Markdown"
    });
  }

  // --------------------------------------------------
  // WATCHDOG SAFETY (FIXED VERSION)
  // --------------------------------------------------
  const watchdog = setTimeout(() => {
    bot.sendMessage(
      chat,
      "⚠ *AI Trader Watchdog* — Hung generate detected",
      { parse_mode: "Markdown" }
    );
  }, 25000); // 25 sec timeout

  try {
    // 1) PRICE FETCH
    const price = await fetchPrice(symbol, market);
    if (!price) {
      clearTimeout(watchdog);
      return bot.sendMessage(chat, "❌ Could not fetch live price.");
    }

    // 2) MULTI TIMEFRAME OHLC
    const multi = await fetchMultiTF(symbol, market);

    // CANCEL WATCHDOG (important)
    clearTimeout(watchdog);

    // --------------------------------------------------
    // BUILD FINAL REPORT
    // --------------------------------------------------
    let report = `🔥 *${symbol} — AI Market Intelligence*\n`;
    report += `Market: ${market}\n`;
    report += `Time: ${new Date().toLocaleString()}\n`;
    report += `Price: *${price}*\n`;
    report += `━━━━━━━━━━━━━━━━━━━━\n`;

    for (const tf of CONFIG.INTERVALS) {
      const data = multi[tf];
      if (!data || data.length < 20) {
        report += `🕒 ${tf}: ⚠ Not enough data\n`;
        continue;
      }

      const rsi = calcRSI(data);
      const atr = calcATR(data);
      const trend = calcTrend(data);

      report += `🕒 *${tf}* — ${trend.emoji} ${trend.signal}\n`;
      report += `• RSI: *${rsi.toFixed(1)}*\n`;
      report += `• ATR: *${atr.toFixed(2)}*\n`;
      report += `• Trend: *${trend.label}*\n\n`;
    }

    report += `━━━━━━━━━━━━━━━━━━━━\n`;
    report += `🌐 Fusion: Live-first | Sources: Yahoo/Binance/Proxy\n`;

    bot.sendMessage(chat, report, {
      parse_mode: "Markdown",
      ...mainKeyboard
    });

  } catch (err) {
    clearTimeout(watchdog);
    bot.sendMessage(chat, "❌ Error: " + err.message);
  }
}