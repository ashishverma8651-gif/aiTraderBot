// aiTraderBot.js — FINAL BOT + PANEL + SYMBOL Menus + Watchdog
import fs from "fs";
import path from "path";
import express from "express";
import axios from "axios";
import { Telegraf } from "telegraf";

import CONFIG from "./config.js";
import { generateMergeSignal } from "./merge_signals.js"; // adjust path if different

// instance lock
const LOCK_FILE = path.resolve(process.cwd(), ".aitraderbot.lock");
function writeLock(){ try{ fs.writeFileSync(LOCK_FILE, String(process.pid)); }catch{} }
function clearLock(){ try{ if(fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE); }catch{} }
if(fs.existsSync(LOCK_FILE)){
  try{
    const pid = Number(fs.readFileSync(LOCK_FILE,'utf8'));
    if(pid && pid>0){ try{ process.kill(pid,0); console.log("Another instance running — exiting."); process.exit(0);}catch{} }
  }catch(e){}
}
writeLock();
process.once("exit", clearLock);

// simple symbol lists (4 each)
const SYMBOLS_LIST = {
  CRYPTO: ["BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT"],
  INDIA: ["NIFTY50","BANKNIFTY","RELIANCE","TCS"],
  FOREX: ["EURUSD","GBPUSD","USDJPY","XAUUSD"],
  COMMODITY: ["GOLD","SILVER","CRUDEOIL","NATGAS"]
};

// Telegram bot init
const TELE_TOKEN = CONFIG.TELEGRAM?.BOT_TOKEN || process.env.BOT_TOKEN || "";
const TELE_CHAT = CONFIG.TELEGRAM?.CHAT_ID || process.env.CHAT_ID || "";
const bot = new Telegraf(TELE_TOKEN || "");

// safe telegram send (best-effort)
async function safeTelegramSend(text){
  try{
    if(TELE_TOKEN && TELE_CHAT){
      await bot.telegram.sendMessage(TELE_CHAT, String(text).slice(0,4000), { parse_mode: "HTML", disable_web_page_preview: true });
      return true;
    }
  }catch(e){ console.log("Telegram send failed:", e?.message || e); }
  // fallback HTTP attempt
  try{
    if(TELE_TOKEN && TELE_CHAT){
      await axios.post(`https://api.telegram.org/bot${TELE_TOKEN}/sendMessage`, { chat_id: TELE_CHAT, text: String(text).slice(0,4000), parse_mode:"HTML", disable_web_page_preview:true }, { timeout:5000 });
      return true;
    }
  }catch(e){}
  return false;
}

// Express server + health
const app = express();
const PORT = process.env.PORT || 10000;
app.get("/", (req,res)=>res.send("AI Trader Bot Running ✔"));
app.get("/ping", (req,res)=>res.send("pong"));
app.listen(PORT, ()=>console.log("Server listening on", PORT));

// Keepalive URL detection
function detectPublicUrl(){ return (process.env.RENDER_EXTERNAL_URL || process.env.SELF_PING_URL || `http://localhost:${PORT}`).replace(/\/+$/,''); }
const PUBLIC_URL = detectPublicUrl();

// UI keyboards
let autoReportEnabled = false;
function buildHomeKeyboard(){
  return {
    reply_markup: {
      inline_keyboard: [
        [{ text:"⚡ Generate Signal", callback_data: "GENERATE_SIGNAL" }],
        [{ text:"Market: Crypto", callback_data:"SET_MARKET_CRYPTO" }, { text:"Market: India", callback_data:"SET_MARKET_INDIA" }],
        [{ text:"Forex", callback_data:"SET_MARKET_FOREX" }, { text:"Commodity", callback_data:"SET_MARKET_COMMODITY" }],
        [{ text: `Auto-Report: ${autoReportEnabled ? "ON":"OFF"}`, callback_data: "TOGGLE_AUTOREPORT"}]
      ]
    },
    parse_mode: "HTML"
  };
}
function buildSymbolKeyboard(market){
  const arr = (SYMBOLS_LIST[market] || []).map(sym => [{ text: sym, callback_data: "SET_SYMBOL_"+sym }]);
  arr.push([{ text: "⬅ Back", callback_data: "BACK_HOME" }]);
  return { reply_markup: { inline_keyboard: arr }, parse_mode: "HTML" };
}

// Bot handlers
bot.command("start", ctx => ctx.reply("🏠 <b>AI Trader Control Panel</b>\nChoose an option:", buildHomeKeyboard()));
bot.command("panel", ctx => ctx.reply("🏠 <b>AI Trader Control Panel</b>", buildHomeKeyboard()));

// Track generate state and guard
let lastGenerateAt = 0;
const HUNG_MS = Number(process.env.HUNG_TASK_MS || 120000);

bot.on("callback_query", async (ctx) => {
  try{
    const data = ctx.callbackQuery && ctx.callbackQuery.data;
    if(!data){ await ctx.answerCbQuery("No action"); return; }

    // Market buttons show symbol list
    if(data === "SET_MARKET_CRYPTO"){ await ctx.editMessageText("Select Crypto symbol:", buildSymbolKeyboard("CRYPTO")); return; }
    if(data === "SET_MARKET_INDIA"){ await ctx.editMessageText("Select India symbol:", buildSymbolKeyboard("INDIA")); return; }
    if(data === "SET_MARKET_FOREX"){ await ctx.editMessageText("Select Forex symbol:", buildSymbolKeyboard("FOREX")); return; }
    if(data === "SET_MARKET_COMMODITY"){ await ctx.editMessageText("Select Commodity:", buildSymbolKeyboard("COMMODITY")); return; }

    // Back
    if(data === "BACK_HOME"){ await ctx.editMessageText("🏠 Main Menu", buildHomeKeyboard()); return; }

    // Toggle auto
    if(data === "TOGGLE_AUTOREPORT"){ autoReportEnabled = !autoReportEnabled; await ctx.editMessageText(`Auto-report: <b>${autoReportEnabled ? "ON":"OFF"}</b>`, buildHomeKeyboard()); return; }

    // Symbol select
    if(data.startsWith("SET_SYMBOL_")){
      const sym = data.replace("SET_SYMBOL_","");
      CONFIG.ACTIVE_SYMBOL = sym;
      await ctx.editMessageText(`Selected <b>${sym}</b>\nPress Generate Signal to run.`, buildHomeKeyboard());
      return;
    }

    // Generate signal
    if(data === "GENERATE_SIGNAL"){
      await ctx.editMessageText("⏳ Generating signal...");
      try{
        lastGenerateAt = Date.now();
        // race with timeout
        const resPromise = generateMergeSignal(CONFIG.ACTIVE_SYMBOL);
        const timeout = new Promise((_,rej)=>setTimeout(()=>rej(new Error("generateSignal timeout")), HUNG_MS));
        const res = await Promise.race([resPromise, timeout]);
        lastGenerateAt = Date.now();
        if(res && res.uiText){
          await ctx.editMessageText(res.uiText, buildHomeKeyboard());
        } else {
          await ctx.editMessageText("❌ No result from generateMergeSignal", buildHomeKeyboard());
        }
      }catch(e){
        await ctx.editMessageText("❌ Failed to generate signal: " + (e?.message || e), buildHomeKeyboard());
      }
      return;
    }

    await ctx.answerCbQuery("Unknown action");
  }catch(e){
    console.log("Callback handler error:", e);
  }
});

// launch bot (polling)
(async ()=>{
  try{
    if(CONFIG.TELEGRAM?.ENABLED && CONFIG.TELEGRAM?.BOT_TOKEN){
      await bot.launch({ polling: { interval: 300, timeout: 50 } });
      console.log("Telegram bot running (polling)");
    } else {
      console.log("Telegram not enabled or BOT_TOKEN missing, bot not launched");
    }
  }catch(e){ console.log("Bot launch error", e); }
})();

// Auto-report scheduler
let autoTimer = null;
async function runAutoReport(){
  if(!autoReportEnabled) return;
  try{
    const { uiText } = await generateMergeSignal(CONFIG.ACTIVE_SYMBOL);
    await safeTelegramSend(`<b>AutoReport</b>\n${uiText}`);
  }catch(e){
    console.log("AutoReport error:", e?.message || e);
    await safeTelegramSend("⚠ AutoReport failed: " + (e?.message || e));
  }
}
function startAuto(intervalMs = Number(process.env.REPORT_INTERVAL_MS || 15*60*1000)){
  if(autoTimer) clearInterval(autoTimer);
  autoTimer = setInterval(runAutoReport, intervalMs);
  // small initial
  setTimeout(()=>runAutoReport(), 5000);
}
startAuto();

// Watchdog to detect hung generate
setInterval(()=> {
  try{
    if(lastGenerateAt && (Date.now() - lastGenerateAt) > (HUNG_MS + 30_000)){
      // notify
      safeTelegramSend(`<b>AI Trader Watchdog</b>\nHung generate detected\nPID: ${process.pid}\nTime: ${new Date().toLocaleString("en-IN", {timeZone:"Asia/Kolkata"})}`);
      // reset lastGenerateAt to avoid repeated spam
      lastGenerateAt = 0;
    }
  }catch(e){ console.log("Watchdog error", e); }
}, 30_000);

// graceful shutdown
async function shutdown(){
  console.log("Shutting down...");
  try{ await bot.stop(); }catch(e){}
  try{ if(autoTimer) clearInterval(autoTimer); }catch(e){}
  clearLock();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Export (optional)
export default { startAuto, shutdown };