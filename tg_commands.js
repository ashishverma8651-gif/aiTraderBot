// tg_commands.js — v4 Final with Feedback, Markets & Inline Menus
import TelegramBot from "node-telegram-bot-api";
import CONFIG from "./config.js";
import { buildReport } from "./aiTraderBot.js";
import { recordFeedback } from "./merge_signals.js";
import { nowLocal } from "./utils.js";

let bot;
const sessions = new Map();

export async function setupTelegramBot() {
  if (global.botInstance) return global.botInstance;

  if (!CONFIG.TELEGRAM?.BOT_TOKEN) {
    console.error("❌ No Telegram token found in config.js");
    return;
  }

  bot = new TelegramBot(CONFIG.TELEGRAM.BOT_TOKEN, { polling: true });
  global.botInstance = bot;

  console.log("📱 Telegram Bot connected");

  bot.onText(/\/start/, (msg) => {
    bot.sendMessage(
      msg.chat.id,
      `👋 Welcome <b>${msg.from.first_name}</b>!\n\nI’m your AI Trader Bot 🤖\nSelect a market to analyze:`,
      { parse_mode: "HTML", ...buildMarketMenu() }
    );
  });

  bot.onText(/\/help/, (msg) => {
    const helpText = `
<b>📘 AI Trader Help — Understanding Reports</b>
━━━━━━━━━━━━━━━
💰 Price — Current asset price  
📊 RSI — Momentum indicator  
📈 MACD — Trend strength  
💵 Volume — Trading activity  
🧠 AI Bias — Combined from ML + Elliott + Indicators  
📰 News Impact — Global sentiment score  
━━━━━━━━━━━━━━━
🕒 Time zone: ${nowLocal()}
`;
    bot.sendMessage(msg.chat.id, helpText, { parse_mode: "HTML" });
  });

  bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    try {
      if (data.startsWith("market_")) {
        const marketType = data.replace("market_", "");
        sessions.set(chatId, { market: marketType });
        return bot.sendMessage(chatId, `📊 Choose a symbol from ${marketType}:`, {
          parse_mode: "HTML",
          ...buildSymbolMenu(marketType),
        });
      }

      if (data.startsWith("symbol_")) {
        const symbol = data.replace("symbol_", "");
        sessions.set(chatId, { ...sessions.get(chatId), symbol });
        return bot.sendMessage(chatId, `⏱ Choose timeframe for <b>${symbol}</b>:`, {
          parse_mode: "HTML",
          ...buildTimeframeMenu(symbol),
        });
      }

      if (data.startsWith("analyze_")) {
        const [, symbol, tf] = data.split("_");
        bot.sendMessage(chatId, `⏳ Generating AI analysis for ${symbol} (${tf})...`);
        const { text } = await buildReport(symbol, tf);
        return bot.sendMessage(chatId, text, { parse_mode: "HTML" });
      }
    } catch (err) {
      console.error("⚠️ Callback error:", err.message);
      bot.sendMessage(chatId, "⚠️ Something went wrong, please try again.");
    }
  });

  return bot;
}

function buildMarketMenu() {
  const markets = CONFIG.MARKETS || {};
  const keyboard = Object.keys(markets).map((m) => [{ text: `📊 ${m}`, callback_data: `market_${m}` }]);
  return { reply_markup: { inline_keyboard: keyboard } };
}

function buildSymbolMenu(marketType) {
  const list = CONFIG.MARKETS?.[marketType] || [];
  const keyboard = list.map((sym) => [{ text: sym, callback_data: `symbol_${sym}` }]);
  keyboard.push([{ text: "⬅️ Back", callback_data: "back_markets" }]);
  return { reply_markup: { inline_keyboard: keyboard } };
}

function buildTimeframeMenu(symbol) {
  const tfs = CONFIG.INTERVALS || ["1m", "5m", "15m", "1h"];
  const keyboard = tfs.map((tf) => [{ text: tf, callback_data: `analyze_${symbol}_${tf}` }]);
  keyboard.push([{ text: "⬅️ Back", callback_data: "back_symbols" }]);
  return { reply_markup: { inline_keyboard: keyboard } };
}

export async function sendTelegramMessage(msg) {
  if (!bot || !CONFIG.TELEGRAM.CHAT_ID) {
    console.warn("⚠️ Telegram not initialized or chat ID missing");
    return;
  }
  return bot.sendMessage(CONFIG.TELEGRAM.CHAT_ID, msg, { parse_mode: "HTML" });
}