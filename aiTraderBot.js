// aiTraderBot.js — CLEAN FINAL VERSION
// Single file handles: Telegram Commands + Buttons + Signal Calls

import fs from "fs";
import path from "path";
import express from "express";
import axios from "axios";
import { Telegraf } from "telegraf";

import CONFIG from "./config.js";
import { generateMergeSignal } from "./merge_signal.js";

// --------------------------------------
//  INSTANCE LOCK
// --------------------------------------
const LOCK = path.resolve(".aitraderbot.lock");
if (fs.existsSync(LOCK)) {
  const pid = Number(fs.readFileSync(LOCK, "utf8"));
  try { process.kill(pid, 0); console.log("⚠ Already running"); process.exit(0); } catch {}
}
fs.writeFileSync(LOCK, String(process.pid));

// --------------------------------------
//  TELEGRAM BOT
// --------------------------------------
const bot = new Telegraf(CONFIG.TELEGRAM.BOT_TOKEN);

const homeKeyboard = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "⚡ Generate Signal", callback_data: "GENERATE_SIGNAL" }],
      [
        { text: "Crypto", callback_data: "SET_MARKET_CRYPTO" },
        { text: "India", callback_data: "SET_MARKET_INDIA" }
      ],
      [
        { text: "Forex", callback_data: "SET_MARKET_FOREX" },
        { text: "US Stocks", callback_data: "SET_MARKET_US" }
      ]
    ]
  },
  parse_mode: "HTML"
};

// --------------------------------------
// START & PANEL
// --------------------------------------
bot.command("start", (ctx) =>
  ctx.reply("🏠 <b>AI Trader Control Panel</b>\nChoose an option:", homeKeyboard)
);
bot.command("panel", (ctx) =>
  ctx.reply("🏠 <b>AI Trader Control Panel</b>", homeKeyboard)
);

// --------------------------------------
// CALLBACK HANDLING
// --------------------------------------
bot.on("callback_query", async (ctx) => {
  try {
    const data = ctx.callbackQuery.data;

    // ----- MARKET SELECT -----
    if (data.startsWith("SET_MARKET_")) {
      const mk = data.replace("SET_MARKET_", "");
      if (mk === "CRYPTO") CONFIG.ACTIVE_MARKET = "CRYPTO";
      if (mk === "INDIA") CONFIG.ACTIVE_MARKET = "INDIA";
      if (mk === "FOREX") CONFIG.ACTIVE_MARKET = "FOREX";
      if (mk === "US") CONFIG.ACTIVE_MARKET = "US_STOCKS";

      CONFIG.ACTIVE_SYMBOL = CONFIG.DEFAULT_BY_MARKET[CONFIG.ACTIVE_MARKET];

      return await ctx.editMessageText(
        `🔄 Market switched to <b>${CONFIG.ACTIVE_MARKET}</b>\nSymbol: <b>${CONFIG.ACTIVE_SYMBOL}</b>`,
        homeKeyboard
      );
    }

    // ----- GENERATE SIGNAL -----
    if (data === "GENERATE_SIGNAL") {
      await ctx.editMessageText("⏳ Generating signal...");
      const { uiText } = await generateMergeSignal(CONFIG.ACTIVE_SYMBOL);

      return await ctx.editMessageText(uiText, homeKeyboard);
    }
  } catch (e) {
    await ctx.reply("❌ Error: " + e.message);
  }
});

// --------------------------------------
//  BOT LAUNCH
// --------------------------------------
bot.launch({ polling: { interval: 300, timeout: 50 } })
  .then(() => console.log("🤖 Bot running"))
  .catch((e) => console.log("Bot error:", e.message));

// --------------------------------------
// KEEP ALIVE (Render Fix)
// --------------------------------------
const app = express();
app.get("/", (req, res) => res.send("AI Trader Bot Running ✔"));
app.get("/ping", (req, res) => res.send("pong"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("🌍 Server on PORT", PORT));

setInterval(async () => {
  try {
    const url = (process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`) + "/ping";
    await axios.get(url);
    console.log("💓 KeepAlive OK");
  } catch {
    console.log("⚠ KeepAlive fail");
  }
}, 3 * 60 * 1000);

// --------------------------------------
// CLEAN EXIT
// --------------------------------------
process.on("SIGINT", () => cleanup());
process.on("SIGTERM", () => cleanup());

function cleanup() {
  console.log("🛑 Shutting Down...");
  try { bot.stop(); } catch {}
  if (fs.existsSync(LOCK)) fs.unlinkSync(LOCK);
  process.exit(0);
}

export default {};