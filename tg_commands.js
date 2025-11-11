// tg_commands.js
import axios from "axios";
import CONFIG from "./config.js";

export async function setupTelegramBot() {
  // minimal — our bot uses sendTelegramMessage directly; this sets nothing now.
  console.log("Telegram bot initialized (dummy)");
}

export async function sendTelegramMessage(text, parse_mode="HTML") {
  const token = CONFIG.TELEGRAM.BOT_TOKEN;
  const chat = CONFIG.TELEGRAM.CHAT_ID;
  if (!token || !chat) return console.warn("Telegram credentials not set.");
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    await axios.post(url, {
      chat_id: chat,
      text,
      parse_mode,
      disable_web_page_preview: true
    }, { timeout: 8000 });
    console.log("Telegram message sent");
  } catch (e) {
    console.warn("Telegram send failed:", e.message || e);
  }
}