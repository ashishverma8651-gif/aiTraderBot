// tg_commands.js — robust Telegram helpers (polling-safe + REST fallback)
import TelegramBot from "node-telegram-bot-api";
import CONFIG from "./config.js";
import { nowLocal } from "./utils.js";
import { buildReport } from "./aiTraderBot.js"; // circular-safe: aiTraderBot exports buildReport at bottom (ensure file order/resolution ok)

let bot = null;
let pollingActive = false;
let pollingFailed = false;

// Try to init polling; if 409 conflict or other polling error -> fallback to REST sends
export async function setupTelegramBot() {
  const token = CONFIG.TELEGRAM?.BOT_TOKEN || process.env.BOT_TOKEN || "";
  if (!token) {
    console.warn("❌ Telegram BOT token missing (CONFIG.TELEGRAM.BOT_TOKEN)");
    return null;
  }

  try {
    // Attempt to create bot with polling
    bot = new TelegramBot(token, { polling: true });

    bot.on("polling_error", (err) => {
      // If 409 conflict, log and disable polling mode (we'll fallback)
      console.error("Telegram polling_error:", err && err.message ? err.message : err);
      if (err && typeof err === "object" && err.code === 409) {
        console.warn("⚠️ Telegram polling conflict (409). Disabling polling, using REST fallback for sendMessage.");
        pollingFailed = true;
        pollingActive = false;
        try {
          bot.stopPolling();
        } catch (e) { /* ignore */ }
      }
    });

    bot.on("webhook_error", (err) => {
      console.warn("Telegram webhook_error:", err && err.message ? err.message : err);
    });

    // Basic command handlers — keep minimal and safe
    bot.onText(/\/start/, (msg) => {
      const chatId = msg.chat.id;
      const name = msg.from?.first_name || "Trader";
      bot.sendMessage(chatId,
        `👋 Hi <b>${name}</b>!\nI am AI Trader Bot.\nUse /help or choose menus (if enabled).`,
        { parse_mode: "HTML" }
      );
    });

    bot.onText(/\/help/, (msg) => {
      const chatId = msg.chat.id;
      const helpText =
`<b>AI Trader Help</b>
• /start — welcome
• /analyze SYMBOL [TF] — immediate analysis (ex: /analyze BTCUSDT 15m)
• Use inline menus if available.
Time: ${nowLocal()}`;
      bot.sendMessage(chatId, helpText, { parse_mode: "HTML" });
    });

    // manual analyze command
    bot.onText(/\/analyze (.+)/, async (msg, match) => {
      const chatId = msg.chat.id;
      const rest = match[1].trim().split(/\s+/);
      const symbol = rest[0].toUpperCase();
      const tf = rest[1] || "15m";
      bot.sendMessage(chatId, `⏳ Generating analysis for ${symbol} (${tf})...`);
      try {
        // buildReport is imported (ensure aiTraderBot exported it)
        const result = await buildReport(symbol, tf);
        if (result && result.text) {
          bot.sendMessage(chatId, result.text, { parse_mode: "HTML" });
        } else {
          bot.sendMessage(chatId, `⚠️ No data for ${symbol} (${tf})`);
        }
      } catch (e) {
        bot.sendMessage(chatId, `❌ Analysis failed: ${e && e.message ? e.message : String(e)}`);
      }
    });

    pollingActive = true;
    pollingFailed = false;
    console.log("📱 Telegram bot initialized with polling");
    return bot;
  } catch (err) {
    console.warn("Telegram polling initialization failed:", err && err.message ? err.message : err);
    // fallback mode: create bot object without polling (we'll still use REST for send)
    try {
      bot = new TelegramBot(token, { polling: false });
    } catch (e) {
      bot = null;
    }
    pollingActive = false;
    pollingFailed = true;
    return null;
  }
}

// Programmatic send: prefer bot.sendMessage if polling active; otherwise HTTP fallback to Telegram API
export async function sendTelegramMessage(msg, chatIdOverride) {
  const token = CONFIG.TELEGRAM?.BOT_TOKEN || process.env.BOT_TOKEN || "";
  const chatId = chatIdOverride || CONFIG.TELEGRAM?.CHAT_ID || process.env.CHAT_ID;
  if (!chatId) {
    console.warn("⚠️ Telegram chat id missing. Not sending message.");
    return null;
  }

  if (bot && pollingActive && !pollingFailed) {
    try {
      return await bot.sendMessage(chatId, msg, { parse_mode: "HTML" });
    } catch (e) {
      console.warn("bot.sendMessage failed, will try HTTP fallback:", e && e.message ? e.message : e);
      // fall through to HTTP fallback
    }
  }

  // HTTP fallback using native fetch (Node 18+ has global fetch)
  if (!token) {
    console.warn("⚠️ Telegram token missing for HTTP fallback.");
    return null;
  }
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const body = { chat_id: chatId, text: msg, parse_mode: "HTML", disable_web_page_preview: false };
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await res.json();
    if (!j.ok) {
      console.warn("Telegram HTTP fallback failed:", j);
    }
    return j;
  } catch (err) {
    console.error("Telegram HTTP fallback error:", err && err.message ? err.message : err);
    return null;
  }
}