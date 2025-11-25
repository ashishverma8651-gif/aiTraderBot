// aiTraderBot.js — Multi-Market AI Trading Bot (Stable Edition)

import fs from "fs";
import path from "path";
import express from "express";
import axios from "axios";
import { Telegraf } from "telegraf";

import CONFIG from "./config.js";
import { fetchPrice, fetchMultiTF } from "./utils.js";
import { generateMergeSignal } from "./merge_signals.js";

// ----------------------------------------
// Prevent Double Instance
// ----------------------------------------
const LOCK = path.resolve(".aitraderbot.lock");
if (fs.existsSync(LOCK)) {
  const pid = Number(fs.readFileSync(LOCK, "utf8"));
  try {
    process.kill(pid, 0);
    console.log("⚠ Already running. Exiting...");
    process.exit(0);
  } catch {}
}
fs.writeFileSync(LOCK, String(process.pid));

// ----------------------------------------
// Telegram Bot Init
// ----------------------------------------
const bot = new Telegraf(CONFIG.TELEGRAM.BOT_TOKEN);

// Dynamic menu builder (changes based on market)
function buildSymbolKeyboard(market) {
  const symbols = CONFIG.SYMBOLS[market];
  const rows = [];

  Object.keys(symbols).forEach((sym) => {
    rows.push([{ text: sym, callback_data: `SET_SYMBOL_${sym}` }]);
  });

  rows.push([{ text: "⬅ Back", callback_data: "BACK_HOME" }]);

  return {
    reply_markup: { inline_keyboard: rows },
    parse_mode: "HTML"
  };
}

const homeKeyboard = {
  reply_markup: {
    inline_keyboard: [
      [{ text: "⚡ Generate Signal", callback_data: "GENERATE_SIGNAL" }],
      [
        { text: "Crypto", callback_data: "MARKET_CRYPTO" },
        { text: "India", callback_data: "MARKET_INDIA" }
      ],
      [
        { text: "Forex", callback_data: "MARKET_FOREX" },
        { text: "Commodities", callback_data: "MARKET_COMMODITIES" }
      ]
    ]
  },
  parse_mode: "HTML"
};

// ----------------------------------------
// Commands
// ----------------------------------------
bot.command("start", (ctx) =>
  ctx.reply("🏠 <b>AI Trader Control Panel</b>\nChoose an option:", homeKeyboard)
);

bot.command("panel", (ctx) =>
  ctx.reply("🏠 <b>AI Trader Control Panel</b>", homeKeyboard)
);

// ----------------------------------------
// Callback handler
// ----------------------------------------
bot.on("callback_query", async (ctx) => {
  try {
    const data = ctx.callbackQuery.data;

    // --------------------- MARKET SELECT --------------------
    if (data.startsWith("MARKET_")) {
      const mk = data.replace("MARKET_", "");
      CONFIG.ACTIVE_MARKET = mk.toUpperCase();

      // AUTO-SELECT DEFAULT SYMBOL
      CONFIG.ACTIVE_SYMBOL = CONFIG.DEFAULT_BY_MARKET[mk.toUpperCase()];

      return await ctx.editMessageText(
        `📂 <b>${mk} Market</b>\nChoose an asset:`,
        buildSymbolKeyboard(mk.toUpperCase())
      );
    }

    // --------------------- SYMBOL SELECT --------------------
    if (data.startsWith("SET_SYMBOL_")) {
      const sym = data.replace("SET_SYMBOL_", "");
      CONFIG.ACTIVE_SYMBOL = sym;

      return await ctx.editMessageText(
        `🔄 Market: <b>${CONFIG.ACTIVE_MARKET}</b>\nSymbol: <b>${CONFIG.ACTIVE_SYMBOL}</b>`,
        homeKeyboard
      );
    }

    if (data === "BACK_HOME") {
      return await ctx.editMessageText(
        "🏠 <b>AI Trader Control Panel</b>",
        homeKeyboard
      );
    }

    // --------------------- GENERATE SIGNAL --------------------
    if (data === "GENERATE_SIGNAL") {
      await ctx.editMessageText("⏳ Generating live signal…");

      const tfData = await fetchMultiTF(CONFIG.ACTIVE_SYMBOL);
      const result = await generateMergeSignal(
        CONFIG.ACTIVE_SYMBOL,
        tfData
      );

      return await ctx.editMessageText(result.uiText, homeKeyboard);
    }
  } catch (err) {
    await ctx.reply("❌ Error: " + err.message);
  }
});

// ----------------------------------------
// Launch bot
// ----------------------------------------
bot.launch({
  polling: { interval: 300, timeout: 50 }
})
  .then(() => console.log("🤖 Telegram Bot Running"))
  .catch((e) => console.log("Bot error:", e.message));

// ----------------------------------------
// KEEP ALIVE SERVER (Render Fix)
// ----------------------------------------
const app = express();
app.get("/", (req, res) => res.send("AI Trader Bot Running ✔"));
app.get("/ping", (req, res) => res.send("pong"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("🌍 Server on PORT", PORT));

// ----------------------------------------
// Auto Ping — prevents Render sleeping
// ----------------------------------------
setInterval(async () => {
  try {
    const url =
      (process.env.RENDER_EXTERNAL_URL ||
        `http://localhost:${PORT}`) + "/ping";

    await axios.get(url);
    console.log("💓 KeepAlive");
  } catch {
    console.log("⚠ KeepAlive failed");
  }
}, 170_000);

// ----------------------------------------
// Clean exit
// ----------------------------------------
process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

function cleanup() {
  console.log("🛑 Shutting Down...");
  try {
    bot.stop();
  } catch {}
  if (fs.existsSync(LOCK)) fs.unlinkSync(LOCK);
  process.exit(0);
}

export default {};