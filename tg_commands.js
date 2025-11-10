/**
 * tg_commands.js
 */

import fs from "fs";
import path from "path";

export function initTelegramCommands(bot, opts={}) {
  const chatId = opts.chatId || process.env.CHAT_ID;

  bot.start(ctx => ctx.reply("AI Trader v9.2 — Running. Use /help"));
  bot.command("help", ctx => ctx.reply("/help\n/status\n/signal\n/reversal\n/trainsample - manual training (dev)"));
  bot.command("status", async ctx => {
    const msg = `AI Trader v9.2\nSymbol: ${process.env.SYMBOL || "BTCUSDT"}\nReporting every ${process.env.REPORT_INTERVAL_MIN || 15}m`;
    await ctx.reply(msg);
  });
  bot.command("signal", async ctx => {
    await ctx.reply("Manual signal requested.");
    fs.writeFileSync(path.resolve("./signal.request"), String(Date.now()));
  });
  bot.command("reversal", async ctx => {
    await ctx.reply("Manual reversal check requested.");
    fs.writeFileSync(path.resolve("./reversal.request"), String(Date.now()));
  });
  bot.command("trainsample", async ctx => {
    // developer trigger to add training file — not exposing training UI
    await ctx.reply("Training sample trigger created (developer).");
    fs.writeFileSync(path.resolve("./train.request"), String(Date.now()));
  });
}