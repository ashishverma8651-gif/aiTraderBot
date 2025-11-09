/**
 * tg_commands.js
 * Telegram command handler for AI_Trader_v8.7
 * Connects with main bot through local HTTP endpoints
 */

import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const AI_BASE_URL = process.env.AI_BASE_URL || "http://localhost:3000";

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ BOT_TOKEN or CHAT_ID missing in .env — aborting.");
  process.exit(1);
}

const API_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;
const OFFSET_FILE = "./tg_offset.json";
import fs from "fs";

let offset = 0;
if (fs.existsSync(OFFSET_FILE)) {
  try {
    offset = JSON.parse(fs.readFileSync(OFFSET_FILE, "utf8")).offset || 0;
  } catch {}
}

// ------------------ Helper ------------------
async function sendTG(text) {
  try {
    await fetch(`${API_URL}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
  } catch (e) {
    console.error("Telegram send error:", e.message);
  }
}

async function getUpdates() {
  const r = await fetch(`${API_URL}/getUpdates?timeout=25&offset=${offset + 1}`);
  const j = await r.json();
  if (!j.result) return [];
  return j.result;
}

// ------------------ Command Handlers ------------------
async function handleCommand(cmd, args) {
  cmd = cmd.toLowerCase();

  if (cmd === "/start") {
    await sendTG(
      "🤖 <b>Welcome to AI Trader Bot!</b>\n\n" +
        "Available commands:\n" +
        "• /start — Show help\n" +
        "• /status — Last market summary\n" +
        "• /predict — Force new analysis\n" +
        "• /news — Latest crypto headlines\n" +
        "• /mlstats — ML model training info\n" +
        "• /chart [tf] — Get live chart (e.g. /chart 1h)"
    );
  }

  else if (cmd === "/status") {
    const res = await fetch(`${AI_BASE_URL}/last-report`);
    const txt = await res.text();
    await sendTG("📊 <b>Last Report</b>\n" + txt);
  }

  else if (cmd === "/predict") {
    await sendTG("⏳ Running fresh AI analysis...");
    const res = await fetch(`${AI_BASE_URL}/force-run`);
    const txt = await res.text();
    await sendTG("✅ " + txt);
  }

  else if (cmd === "/news") {
    const res = await fetch(`${AI_BASE_URL}/news`);
    const txt = await res.text();
    await sendTG("📰 <b>Crypto Headlines</b>\n" + txt);
  }

  else if (cmd === "/mlstats") {
    const res = await fetch(`${AI_BASE_URL}/mlstats`);
    const txt = await res.text();
    await sendTG("🧠 <b>ML Model Stats</b>\n" + txt);
  }

  else if (cmd.startsWith("/chart")) {
    const tf = args[0] || "15m";
    const res = await fetch(`${AI_BASE_URL}/chart?tf=${tf}`);
    const url = await res.text();
    await sendTG(`📈 <b>Chart (${tf})</b>\n${url}`);
  }

  else {
    await sendTG("⚠️ Unknown command. Type /start for help.");
  }
}

// ------------------ Polling Loop ------------------
async function loop() {
  try {
    const updates = await getUpdates();
    for (const u of updates) {
      offset = u.update_id;
      fs.writeFileSync(OFFSET_FILE, JSON.stringify({ offset }));
      const msg = u.message?.text || "";
      const [cmd, ...args] = msg.split(" ");
      console.log("📩 Command:", cmd);
      await handleCommand(cmd, args);
    }
  } catch (e) {
    console.error("loop error:", e.message);
  } finally {
    setTimeout(loop, 2500);
  }
}

console.log("🤖 Telegram command handler started...");
loop();