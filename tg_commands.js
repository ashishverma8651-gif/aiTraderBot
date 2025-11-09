/**
 * tg_commands.js
 * Telegram command handler for AI_Trader_v8.x
 * Connects with main bot through internal API functions
 */

import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ BOT_TOKEN or CHAT_ID missing in .env — aborting Telegram command handler.");
  process.exit(1);
}

/**
 * Initialize Telegram command polling
 * @param {Object} deps - injected dependencies from main bot
 */
export function initTelegramCommands({
  SYMBOL,
  analyzeAndReport,
  fetchHeadlines,
  reversalWatcherOnce
}) {
  console.log("🤖 Telegram Command System active...");

  // ---- HELP COMMAND LIST ----
  const helpText = `
🤖 <b>AI Trader Commands</b>

/start - Activate bot
/help - List all commands
/news - Latest crypto headlines
/predict - Generate AI analysis report instantly
/reversal - Manually trigger 1-min reversal check
/status - Check system health
/symbol - Show current trading pair
  `;

  // ---- MAIN POLLER ----
  let offset = 0;

  async function poll() {
    try {
      const url = `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates?offset=${offset + 1}`;
      const res = await fetch(url);
      const data = await res.json();

      if (data?.result?.length) {
        for (const upd of data.result) {
          offset = upd.update_id;
          const msg = upd.message;
          const chatId = msg.chat.id;
          const text = (msg.text || "").trim().toLowerCase();

          // 🧠 Handle commands
          if (text === "/start") {
            await sendText(chatId, "🤖 AI Trader is online.\nUse /help for command list.", "HTML");
          }
          else if (text === "/help") {
            await sendText(chatId, helpText, "HTML");
          }
          else if (text === "/news") {
            const news = await fetchHeadlines();
            const msgOut = news && news.length
              ? news.map(n => `• ${n.title}`).join("\n")
              : "No crypto headlines found.";
            await sendText(chatId, `📰 <b>Top Headlines:</b>\n${msgOut}`, "HTML");
          }
          else if (text === "/predict") {
            await sendText(chatId, "⚙️ Running AI analysis, please wait...");
            await analyzeAndReport();
          }
          else if (text === "/reversal") {
            await sendText(chatId, "🔍 Checking for reversal patterns (1m)...");
            await reversalWatcherOnce();
          }
          else if (text === "/status") {
            await sendText(chatId, "✅ System active.\nML + Reversal + News are running fine.");
          }
          else if (text === "/symbol") {
            await sendText(chatId, `📈 Current Symbol: <b>${SYMBOL}</b>`, "HTML");
          }
          else {
            await sendText(chatId, "❓ Unknown command.\nType /help for available commands.");
          }
        }
      }
    } catch (err) {
      console.warn("⚠️ Telegram poll error:", err.message);
    }
    setTimeout(poll, 7000); // poll every 7s
  }

  // ---- SENDER ----
  async function sendText(chatId, text, parseMode = "Markdown") {
    try {
      const sendUrl = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
      await fetch(sendUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: parseMode,
          disable_web_page_preview: true
        })
      });
    } catch (e) {
      console.warn("sendText error:", e.message);
    }
  }

  poll(); // start background polling
}