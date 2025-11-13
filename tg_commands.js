// tg_commands.js — HTTP-only Telegram module (no polling)
import axios from "axios";
import CONFIG from "./config.js";

export async function setupTelegramBot() {
  console.log("📭 Telegram bot initialized (HTTP-only mode, polling disabled)");
  return true;
}

// HTTP-only sender
export async function sendTelegramMessage(msg, chatIdOverride) {
  const token = CONFIG.TELEGRAM?.BOT_TOKEN || process.env.BOT_TOKEN;
  const chatId = chatIdOverride || CONFIG.TELEGRAM?.CHAT_ID || process.env.CHAT_ID;

  if (!token || !chatId) {
    console.warn("⚠️ Missing BOT_TOKEN or CHAT_ID. Cannot send Telegram message.");
    return null;
  }

  try {
    const res = await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: msg,
      parse_mode: "HTML",
      disable_web_page_preview: false
    }, { timeout: 8000 });
    console.log("📨 Telegram message sent successfully");
    return res.data;
  } catch (e) {
    console.error("❌ Telegram HTTP send failed:", e.message || e);
    return null;
  }
}