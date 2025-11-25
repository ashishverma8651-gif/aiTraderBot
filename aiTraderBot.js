// aiTraderBot.js — FINAL STABLE PREMIUM VERSION (With Advanced Indicator Engine)

import TelegramBot from "node-telegram-bot-api";
import CONFIG from "./config.js";
import { fetchPrice, fetchMultiTF } from "./utils.js";

// IMPORT FULL INDICATOR ENGINE
import {
  computeIndicators,
  computeMultiTF
} from "./core_indicators.js";

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// --------------------------------------------------
// TELEGRAM KEYBOARD
// --------------------------------------------------
const keyboard = {
  reply_markup: {
    keyboard: [
      ["⚡ Generate Signal"],
      ["Crypto", "India"],
      ["Forex", "Commodities"]
    ],
    resize_keyboard: true
  }
};

// --------------------------------------------------
// /start
// --------------------------------------------------
bot.onText(/\/start/, async (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `🔥 *AI Trader Bot Started*\nSelect a market below 👇`,
    { parse_mode: "Markdown", ...keyboard }
  );
});

// --------------------------------------------------
// MARKET SWITCH
// --------------------------------------------------
bot.on("message", async (msg) => {
  const text = msg.text;
  const chat = msg.chat.id;

  const switchMarket = (market) => {
    CONFIG.ACTIVE_MARKET = market;
    CONFIG.ACTIVE_SYMBOL = CONFIG.DEFAULT_BY_MARKET[market];
    bot.sendMessage(chat, `✅ Market set to *${market}*`, { parse_mode: "Markdown" });
  };

  if (text === "Crypto") return switchMarket("CRYPTO");
  if (text === "India") return switchMarket("INDIA");
  if (text === "Forex") return switchMarket("FOREX");
  if (text === "Commodities") return switchMarket("COMMODITIES");

  // --------------------------------------------------
  // MAIN BUTTON: GENERATE SIGNAL
  // --------------------------------------------------
  if (text === "⚡ Generate Signal") {
    const market = CONFIG.ACTIVE_MARKET;
    const symbol = CONFIG.ACTIVE_SYMBOL;

    bot.sendMessage(
      chat,
      `📡 Fetching *${symbol}* (${market})...\nPlease wait 2–3 sec`,
      { parse_mode: "Markdown" }
    );

    // ---------- LIVE PRICE ----------
    const price = await fetchPrice(symbol, market);

    // ---------- MULTI-TF OHLC ----------
    const rawTF = await fetchMultiTF(symbol, market);

    if (!price) {
      return bot.sendMessage(chat, "❌ Could not fetch live price.");
    }

    // ---------- FULL INDICATOR ENGINE ----------
    const indicators = computeMultiTF(rawTF);

    // ------------------------------------------------
    // REPORT BUILDING
    // ------------------------------------------------
    let report = `🔥 *${symbol} — AI Market Intelligence*\n`;
    report += `Time: ${new Date().toLocaleString()}\n`;
    report += `Price: *${price}*\n`;
    report += `━━━━━━━━━━━━━━━━━━━━\n`;

    const order = ["1m", "5m", "15m", "30m", "1h"];

    for (const tf of order) {
      const ind = indicators[tf];

      if (!ind) {
        report += `🕒 ${tf}: ⚠️ Not enough data\n`;
        continue;
      }

      // SIGNAL
      const signal = ind ? ind.finalSignal || "HOLD" : "HOLD";
      let emoji = "⚪";
      if (signal === "BUY") emoji = "🟢";
      if (signal === "SELL") emoji = "🔴";

      report += `🕒 *${tf}* — ${emoji} ${signal}\n`;
      report += `• RSI: *${ind.RSI}*\n`;
      report += `• ATR: *${ind.ATR}*\n`;
      report += `• Trend: *${ind.priceTrend}*\n`;
      report += `• Volume: *${ind.volumeTrend}*\n`;
      report += `• MACD Hist: *${ind.MACD?.hist}*\n`;
      report += `\n`;
    }

    report += `━━━━━━━━━━━━━━━━━━━━\n`;
    report += `📡 Fusion Engine | Binance + Yahoo + Failover Mirrors`;

    bot.sendMessage(chat, report, { parse_mode: "Markdown" });
  }
});