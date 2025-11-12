// tg_commands.js — v3 Advanced Interactive Command System
import TelegramBot from "node-telegram-bot-api";
import CONFIG from "./config.js";
import { buildReport } from "./aiTraderBot.js"; // if exported separately
import { recordFeedback } from "./merge_signals.js";
import { nowLocal } from "./utils.js";

// Local in-memory session map
const sessions = new Map();
let bot;

// ----------------------
// 🧩 Menu Builders
// ----------------------
function buildMarketMenu() {
  const markets = CONFIG.MARKETS || {};
  const keyboard = [];

  Object.keys(markets).forEach((m) => {
    keyboard.push([{ text: `📊 ${m}`, callback_data: `market_${m}` }]);
  });

  return { reply_markup: { inline_keyboard: keyboard } };
}

function buildSymbolMenu(marketType) {
  const list = CONFIG.MARKETS?.[marketType] || [];
  const keyboard = list.map((sym) => [{ text: sym, callback_data: `symbol_${sym}` }]);
  keyboard.push([{ text: "⬅️ Back", callback_data: "back_markets" }]);
  return { reply_markup: { inline_keyboard: keyboard } };
}

function buildTimeframeMenu(symbol) {
  const intervals = CONFIG.INTERVALS || ["1m", "5m", "15m", "1h"];
  const keyboard = intervals.map((tf) => [{ text: `${tf}`, callback_data: `analyze_${symbol}_${tf}` }]);
  keyboard.push([{ text: "⬅️ Back", callback_data: "back_symbols" }]);
  return { reply_markup: { inline_keyboard: keyboard } };
}

// ----------------------
// 🤖 Command Setup
// ----------------------
export async function setupTelegramBot() {
  if (!CONFIG.TG_TOKEN) {
    console.error("❌ No Telegram token found in config.js");
    return;
  }

  bot = new TelegramBot(CONFIG.TG_TOKEN, { polling: true });
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
<b>📘 AI Trader Help — How to Read the Report</b>

Each report shows these metrics:
━━━━━━━━━━━━━━━
💰 <b>Price</b> — current asset price  
📊 <b>RSI</b> (Relative Strength Index) —  
 • Below 30 = Oversold (possible Buy)  
 • Above 70 = Overbought (possible Sell)  

📈 <b>MACD</b> — shows momentum  
 • Positive = Uptrend  
 • Negative = Downtrend  

💵 <b>Volume</b> — how much is being traded  
 • Rising volume = strong move  
 • Falling volume = weak move  

⚙️ <b>ATR</b> — volatility measure; large ATR means price swings  

🧭 <b>Overall Bias</b> = AI decision from RSI + MACD + Elliott + ML + News  

📰 <b>News Impact</b> — AI-scored sentiment of global headlines  
 • Positive = bullish  
 • Negative = bearish  

💬 Use <b>/start</b> to choose markets and symbols.  
💡 Tip: When Volume ⬆ and RSI in oversold zone → reversal likely!  
━━━━━━━━━━━━━━━
🕒 Time zone: ${nowLocal()}
`;
    bot.sendMessage(msg.chat.id, helpText, { parse_mode: "HTML" });
  });

  bot.onText(/\/feedback/, async (msg) => {
    const summary = recordFeedback("manual_" + Date.now(), true);
    bot.sendMessage(msg.chat.id, `✅ Feedback recorded!\nTotal: ${summary.total}\nAccuracy: ${summary.accuracy}%`);
  });

  // Error-safe command to manually request any symbol/timeframe
  bot.onText(/\/analyze (.+)/, async (msg, match) => {
    const parts = match[1].split(" ");
    const symbol = parts[0].toUpperCase();
    const tf = parts[1] || "15m";
    bot.sendMessage(msg.chat.id, `🔍 Analyzing <b>${symbol}</b> (${tf})...`, { parse_mode: "HTML" });
    try {
      const { text } = await buildReport(symbol, tf);
      bot.sendMessage(msg.chat.id, text, { parse_mode: "HTML" });
    } catch (e) {
      bot.sendMessage(msg.chat.id, `❌ Analysis failed: ${e.message}`);
    }
  });

  // ----------------------
  // 📱 Inline Menu Navigation
  // ----------------------
  bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    try {
      if (data.startsWith("market_")) {
        const marketType = data.replace("market_", "");
        sessions.set(chatId, { market: marketType });
        return bot.sendMessage(chatId, `📊 Choose a symbol from <b>${marketType}</b>:`, {
          parse_mode: "HTML",
          ...buildSymbolMenu(marketType),
        });
      }

      if (data === "back_markets") {
        return bot.sendMessage(chatId, "🔙 Back to markets:", buildMarketMenu());
      }

      if (data.startsWith("symbol_")) {
        const symbol = data.replace("symbol_", "");
        sessions.set(chatId, { ...sessions.get(chatId), symbol });
        return bot.sendMessage(chatId, `⏱ Choose timeframe for <b>${symbol}</b>:`, {
          parse_mode: "HTML",
          ...buildTimeframeMenu(symbol),
        });
      }

      if (data === "back_symbols") {
        const sess = sessions.get(chatId);
        if (sess?.market) {
          return bot.sendMessage(chatId, "🔙 Back to symbols:", buildSymbolMenu(sess.market));
        }
        return bot.sendMessage(chatId, "⬅️ Back to main:", buildMarketMenu());
      }

      if (data.startsWith("analyze_")) {
        const [, symbol, tf] = data.split("_");
        bot.sendMessage(chatId, `⏳ Generating AI analysis for ${symbol} (${tf})...`);
        try {
          const { text } = await buildReport(symbol, tf);
          return bot.sendMessage(chatId, text, { parse_mode: "HTML" });
        } catch (e) {
          return bot.sendMessage(chatId, `❌ Error: ${e.message}`);
        }
      }
    } catch (err) {
      console.error("Callback error:", err.message);
      bot.sendMessage(chatId, "⚠️ Something went wrong, please try again.");
    }
  });

  return bot;
}

// Utility for programmatic send
export async function sendTelegramMessage(msg) {
  if (!bot || !CONFIG.TG_CHAT_ID) {
    console.warn("⚠️ Telegram not initialized or chat ID missing");
    return;
  }
  return bot.sendMessage(CONFIG.TG_CHAT_ID, msg, { parse_mode: "HTML" });
}