// =======================================================
// aiTraderBot.js — FINAL STABLE AI TRADER (No Import Issues)
// =======================================================

import TelegramBot from "node-telegram-bot-api";
import CONFIG from "./config.js";
import { fetchPrice, fetchMultiTF } from "./utils.js";
import {
  computeMultiTF,
  deriveSignal
} from "./core_indicators.js";

const bot = new TelegramBot(process.env.BOT_TOKEN, { polling: true });

// ===============================
// TELEGRAM BUTTONS
// ===============================
const keyboard = {
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

// ===============================
// ON /start
// ===============================
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    `🔥 *AI Trader Bot Started*\nSelect market below`,
    { parse_mode: "Markdown", ...keyboard }
  );
});

// ============================================================
// AUTO-REPORT TOGGLE
// ============================================================
let AUTO = false;

bot.on("message", async (msg) => {
  const t = msg.text;
  const chat = msg.chat.id;

  // ---------------- Market Switch ----------------
  const switchMarket = (m) => {
    CONFIG.ACTIVE_MARKET = m;
    CONFIG.ACTIVE_SYMBOL = CONFIG.DEFAULT_BY_MARKET[m];

    bot.sendMessage(
      chat,
      `🔄 Market switched to *${m}* \nSymbol: *${CONFIG.ACTIVE_SYMBOL}*`,
      { parse_mode: "Markdown" }
    );
  };

  if (t === "Crypto") return switchMarket("CRYPTO");
  if (t === "India") return switchMarket("INDIA");
  if (t === "Forex") return switchMarket("FOREX");
  if (t === "Commodities") return switchMarket("COMMODITIES");

  // ---------------- Auto Report ----------------
  if (t.includes("Auto-Report")) {
    AUTO = !AUTO;
    bot.sendMessage(
      chat,
      `⏱ Auto Report: *${AUTO ? "ON" : "OFF"}*`,
      { parse_mode: "Markdown", ...keyboard }
    );
    return;
  }

  // ----------------------------------------------------------
  // GENERATE SIGNAL
  // ----------------------------------------------------------
  if (t === "⚡ Generate Signal") {
    const market = CONFIG.ACTIVE_MARKET;
    const symbol = CONFIG.ACTIVE_SYMBOL;

    bot.sendMessage(chat, `📡 Fetching *${symbol}* (${market})...`, {
      parse_mode: "Markdown"
    });

    // 1) LIVE PRICE
    const price = await fetchPrice(symbol, market);

    // 2) MULTI-TF OHLC
    const tfData = await fetchMultiTF(symbol, market);

    // 3) APPLY INDICATOR ENGINE
    const indicatorsTF = computeMultiTF(tfData);

    // 4) FINAL SIGNAL (weighted)
    const finalSig = deriveSignal(indicatorsTF["5m"]); // base TF = 5m

    // ----------------------------------------------------------
    // BUILD SIGNAL REPORT
    // ----------------------------------------------------------
    let out = `🔥 *${symbol} — AI Market Intelligence*\n`;
    out += `Market: *${market}*\n`;
    out += `Price: *${price}*\n`;
    out += `━━━━━━━━━━━━━━\n`;

    for (const tf of ["1m", "5m", "15m", "30m", "1h"]) {
      const d = indicatorsTF[tf];
      if (!d) {
        out += `🕒 ${tf}: ❌ No data\n`;
        continue;
      }
      out += `🕒 *${tf}*\n`;
      out += `• RSI: ${d.RSI}\n`;
      out += `• ATR: ${d.ATR}\n`;
      out += `• MACD.hist: ${d.MACD.hist}\n`;
      out += `• Trend: ${d.priceTrend}\n`;
      out += `• Vol: ${d.volumeTrend}\n\n`;
    }

    out += `━━━━━━━━━━━━━━\n`;
    out += `📌 Final Signal: *${finalSig}*\n`;
    out += `🌐 Source: Binance / Yahoo / Forex / Proxies\n`;

    bot.sendMessage(chat, out, { parse_mode: "Markdown" });
  }
});

// ===============================================================
// OPTIONAL AUTO REPORT LOOP
// ===============================================================
setInterval(async () => {
  if (!AUTO) return;

  const symbol = CONFIG.ACTIVE_SYMBOL;
  const market = CONFIG.ACTIVE_MARKET;

  const price = await fetchPrice(symbol, market);
  const tfData = await fetchMultiTF(symbol, market);
  const ind = computeMultiTF(tfData);
  const sig = deriveSignal(ind["5m"]);

  bot.sendMessage(
    CONFIG.TELEGRAM.CHAT_ID,
    `⏱ Auto Report — *${symbol}*\nSignal: *${sig}*\nPrice: *${price}*`,
    { parse_mode: "Markdown" }
  );
}, 60_000); // every 1 min