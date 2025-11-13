// =========================================================
// tg_commands.js — Telegram Command Handler (Stable Polling)
// Works on Render + Local (No Webhook, No Conflict)
// =========================================================

process.env.NTBA_FIX_319 = "1"; // Telegram internal fix

import TelegramBot from "node-telegram-bot-api";
import CONFIG from "./config.js";

const token = CONFIG.TELEGRAM?.BOT_TOKEN || process.env.BOT_TOKEN;
const chatId = CONFIG.TELEGRAM?.CHAT_ID || process.env.CHAT_ID;

if (!token) {
  console.error("❌ TELEGRAM BOT TOKEN not found in config or environment.");
}

export let bot;

try {
  // ✅ Simple polling mode
  bot = new TelegramBot(token, { polling: true });
  console.log("🤖 Telegram bot initialized with polling...");
} catch (error) {
  console.error("💥 Failed to initialize Telegram bot:", error.message);
}

// =========================================================
// 🚀 Setup Commands
// =========================================================
export function setupTelegramBot() {
  if (!bot) {
    console.error("⚠️ Telegram bot not initialized!");
    return;
  }

  bot.onText(/\/start/, (msg) => {
    const text = `
👋 Hey ${msg.chat.first_name || "Trader"}!
AI Trader Bot is live and ready 🚀
Use /report to get the latest market analysis.
`;
    bot.sendMessage(msg.chat.id, text);
  });

  bot.onText(/\/report/, async (msg) => {
    const chat = msg.chat.id;
    try {
      const { buildReport } = await import("./aiTraderBot.js");
      const report = await buildReport("BTCUSDT");
      await sendTelegramMessage(report, chat);
    } catch (err) {
      console.error("⚠️ Report generation error:", err.message);
      bot.sendMessage(chat, "⚠️ Error generating report. Please try again later.");
    }
  });

  bot.on("message", (msg) => {
    console.log(`📩 Message received: ${msg.text}`);
  });
}

// =========================================================
// ✉️ Safe Send Telegram Message
// =========================================================
export async function sendTelegramMessage(message, chatIdOverride) {
  const chat = chatIdOverride || chatId;
  if (!chat) {
    console.error("⚠️ Missing CHAT_ID — cannot send Telegram message.");
    return;
  }

  try {
    await bot.sendMessage(chat, message, { parse_mode: "HTML" });
    console.log("✅ Message sent to Telegram");
  } catch (err) {
    console.error("💥 Failed to send message:", err.message);
  }
}

// =========================================================
// 🧩 Stop Polling (For graceful shutdowns if needed)
// =========================================================
export function stopTelegramBot() {
  try {
    if (bot && bot.isPolling()) {
      bot.stopPolling();
      console.log("🛑 Telegram bot polling stopped safely.");
    }
  } catch (err) {
    console.error("⚠️ Error stopping bot:", err.message);
  }
}

// =========================================================
// 🧠 Default Export
// =========================================================
export default {
  setupTelegramBot,
  sendTelegramMessage,
  stopTelegramBot,
};