// =========================================================
// tg_commands.js — Telegram Command + Message Handler
// Render Safe Version (Webhook + Polling Fallback)
// =========================================================

// 🩵 Fix Telegram polling conflict
process.env.NTBA_FIX_319 = "1";

import TelegramBot from "node-telegram-bot-api";
import CONFIG from "./config.js";

// =========================================================
// 🔧 Telegram Setup — Webhook for Render / Polling for Local
// =========================================================
const token = CONFIG.TELEGRAM?.BOT_TOKEN || process.env.BOT_TOKEN;
const chatId = CONFIG.TELEGRAM?.CHAT_ID || process.env.CHAT_ID;
const appUrl = CONFIG.APP_URL || process.env.APP_URL; // https://aitraderbot.onrender.com

if (!token) {
  console.error("❌ Telegram BOT_TOKEN missing in config.js or env!");
}

let bot;
try {
  const isRender = !!process.env.RENDER || !!appUrl;
  if (isRender && appUrl) {
    // Webhook mode for Render
    bot = new TelegramBot(token, { webHook: true });
    bot.setWebHook(`${appUrl}/bot${token}`);
    console.log("🚀 Telegram bot initialized in Webhook mode");
  } else {
    // Polling mode (Local or Dev)
    bot = new TelegramBot(token, { polling: true });
    console.log("⚡ Telegram bot initialized in Polling mode");
  }
} catch (err) {
  console.error("💥 Telegram setup failed:", err);
}

// =========================================================
// 🧩 Command Handlers (Customise as per your project)
// =========================================================
export function setupTelegramBot() {
  if (!bot) {
    console.warn("⚠️ Bot instance not available");
    return;
  }

  // /start command
  bot.onText(/\/start/, (msg) => {
    bot.sendMessage(
      msg.chat.id,
      "👋 Hey Buddy! AI Trader Bot is online and ready 🚀\nUse /report to get latest market data."
    );
  });

  // /report command
  bot.onText(/\/report/, async (msg) => {
    const chatId = msg.chat.id;
    try {
      // Import the report builder dynamically
      const { buildReport } = await import("./aiTraderBot.js");
      const report = await buildReport("BTCUSDT");
      await sendTelegramMessage(report, chatId);
    } catch (err) {
      console.error("❌ Error generating report:", err);
      bot.sendMessage(chatId, "⚠️ Error generating report. Please try again later.");
    }
  });

  // Generic message
  bot.on("message", (msg) => {
    console.log(`💬 Message received from ${msg.chat.id}: ${msg.text}`);
  });
}

// =========================================================
// ✉️ Safe Telegram Send Function
// =========================================================
export async function sendTelegramMessage(msg, chatIdOverride) {
  const token = CONFIG.TELEGRAM?.BOT_TOKEN || process.env.BOT_TOKEN || "";
  const chat = chatIdOverride || CONFIG.TELEGRAM?.CHAT_ID || process.env.CHAT_ID;

  if (!chat) {
    console.warn("⚠️ Telegram chat ID missing. Message not sent.");
    return null;
  }

  // 1️⃣ Try standard bot.sendMessage (if initialized)
  if (bot) {
    try {
      return await bot.sendMessage(chat, msg, { parse_mode: "HTML" });
    } catch (err) {
      console.warn("⚠️ bot.sendMessage failed, will try HTTP fallback:", err.message);
    }
  }

  // 2️⃣ HTTP fallback (direct API call)
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: msg, parse_mode: "HTML" }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.description);
    return data;
  } catch (err) {
    console.error("💥 HTTP fallback failed:", err.message);
  }

  return null;
}

// =========================================================
// 🧠 Utility to stop polling safely on shutdown
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
// ✅ Exports
// =========================================================
export default {
  setupTelegramBot,
  sendTelegramMessage,
  stopTelegramBot,
};