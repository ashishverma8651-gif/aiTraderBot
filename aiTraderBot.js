// aiTraderBot.js — Stable AI Trader Bot with keep-alive HTTP + Telegram + indicators
// Requires: node >=18, packages: node-telegram-bot-api, express, axios
// Files expected: ./config.js, ./utils.js, ./core_indicators.js

import fs from "fs";
import path from "path";
import express from "express";
import TelegramBot from "node-telegram-bot-api";
import CONFIG from "./config.js";
import { fetchPrice, fetchMultiTF } from "./utils.js";
import { computeMultiTF as indicatorsMultiTF, deriveSignal, computeIndicators } from "./core_indicators.js";

// -------------------- Basic runtime / PID lock (avoid double-run) --------------------
const LOCK_FILE = path.resolve(".aitraderbot.lock");
try { if (fs.existsSync(LOCK_FILE)) { const pid = Number(fs.readFileSync(LOCK_FILE, "utf8")||""); if (pid && pid>0) { try { process.kill(pid,0); console.log("Another instance running; exiting."); process.exit(0); } catch {} } } fs.writeFileSync(LOCK_FILE, String(process.pid)); } catch (e) { /* best-effort */ }
function clearLock(){ try{ if(fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE); }catch{} }
process.once("exit", clearLock);

// -------------------- Express keep-alive + health --------------------
const app = express();
const PORT = Number(process.env.PORT || process.env.HTTP_PORT || 10000);

app.get("/", (req,res) => res.send("AI Trader Bot running ✔"));
app.get("/ping", (req,res) => res.send("pong"));
app.get("/health", (req,res) => {
  res.json({
    pid: process.pid,
    uptime_s: Math.round(process.uptime()),
    active_market: CONFIG.ACTIVE_MARKET,
    active_symbol: CONFIG.ACTIVE_SYMBOL
  });
});

app.listen(PORT, () => {
  console.log(`HTTP keep-alive listening on port ${PORT}`);
});

// -------------------- Telegram init --------------------
const TELEGRAM_TOKEN = process.env.BOT_TOKEN || CONFIG?.TELEGRAM?.BOT_TOKEN;
const TELEGRAM_CHAT = process.env.CHAT_ID || CONFIG?.TELEGRAM?.CHAT_ID;
const botEnabled = Boolean(TELEGRAM_TOKEN && TELEGRAM_CHAT);

let bot = null;
if (TELEGRAM_TOKEN) {
  bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
  console.log("Telegram bot polling started.");
} else {
  console.warn("Telegram token not found. Bot disabled.");
}

// -------------------- UI keyboard --------------------
const keyboardOptions = {
  reply_markup: {
    keyboard: [
      ["⚡ Generate Signal"],
      ["Crypto", "India"],
      ["Forex", "Commodities"],
      ["Auto-Report: OFF"]
    ],
    resize_keyboard: true
  }
};

// -------------------- Bot state & watchdog --------------------
let lastGenerateAt = 0;
let lastGenerateId = null;
let consecutiveFailures = 0;
const HUNG_MS = Number(process.env.HUNG_TASK_MS || 90*1000);
const MAX_FAILURES = Number(process.env.MAX_CONSECUTIVE_FAILURES || 6);
let autoReportEnabled = false;
let autoReportTimer = null;

// -------------------- Utility helpers --------------------
function timeoutPromise(p, ms, msg = "timeout") {
  return Promise.race([p, new Promise((_, rej)=>setTimeout(()=>rej(new Error(msg)), ms))]);
}
function safeFmt(n, digits=2){ return (Number.isFinite(n) ? n.toFixed(digits) : "—"); }

// -------------------- Text builder using indicators --------------------
function buildReportText(symbol, market, multiTFRaw, livePrice){
  const when = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const lines = [];
  lines.push(`🔥 ${symbol} — AI Market Intelligence`);
  lines.push(`Time: ${when}`);
  lines.push(`Price: ${Number.isFinite(livePrice) ? livePrice.toFixed(2) : "N/A"}`);
  lines.push("━━━━━━━━━━━━━━━━━━");

  // multiTFRaw is expected: { "1m": [candles], "5m": [...], ... }
  // Normalize shape for indicatorsMultiTF which expects {tf: {data: candles} } or in your core, it expected allTF object with .data
  // We'll transform into {tf: { data: candles } }
  const prepared = {};
  for (const tf of Object.keys(multiTFRaw || {})) {
    const arr = multiTFRaw[tf] || [];
    prepared[tf] = { data: Array.isArray(arr) ? arr : (arr.data || []) };
  }

  // compute indicators (calls computeIndicators per tf)
  const ind = indicatorsMultiTF(prepared); // returns per-tf indicators as per core_indicators.js

  const tfs = Object.keys(prepared).length ? Object.keys(prepared) : CONFIG.INTERVALS || ["1m","5m","15m","30m","1h"];
  for (const tf of tfs) {
    const candles = (multiTFRaw[tf] && (Array.isArray(multiTFRaw[tf]) ? multiTFRaw[tf] : (multiTFRaw[tf].data||[]))) || [];
    const stats = ind[tf] || {};
    const rsi = (stats.RSI!==undefined && stats.RSI!==null) ? stats.RSI : null;
    const atr = (stats.ATR!==undefined && stats.ATR!==null) ? stats.ATR : null;
    const macdHist = (stats.MACD && stats.MACD.hist!==undefined) ? stats.MACD.hist : null;
    const vtrend = stats.volumeTrend || "STABLE";
    const derived = deriveSignal(stats);
    const lastClose = (candles.length ? (candles[candles.length-1].close ?? candles[candles.length-1].c ?? candles[candles.length-1][4]) : null);

    // choose emoji for derived
    const emoji = derived === "BUY" ? "🟦" : derived === "SELL" ? "🔴" : "⚪";

    lines.push(`🕒 ${tf} — ${emoji} ${derived}`);
    lines.push(`• RSI: ${rsi !== null ? rsi : "—"} | ATR: ${atr !== null ? safeFmt(atr,4) : "—"}`);
    lines.push(`• MACD.hist: ${macdHist !== null ? safeFmt(macdHist,6) : "—"} | Vol: ${vtrend}`);
    if (lastClose !== null) lines.push(`• Last: ${Number(lastClose).toFixed(4)}`);
    lines.push("");
  }

  lines.push("━━━━━━━━━━━━━━━━━━");
  lines.push(`🧭 Fusion: Live-first | Sources: Yahoo/Binance/Proxies`);
  return lines.join("\n");
}

// -------------------- Core signal generation --------------------
async function generateSignalFor(symbol = CONFIG.ACTIVE_SYMBOL, market = CONFIG.ACTIVE_MARKET, opts = { timeoutMs: 65_000 }) {
  lastGenerateId = `${symbol}_${market}_${Date.now()}`;
  lastGenerateAt = Date.now();

  // fetch price and multiTF in parallel with overall timeout
  const p = (async () => {
    const [price, multi] = await Promise.all([
      fetchPrice(symbol, market),
      fetchMultiTF(symbol, market, CONFIG.INTERVALS || ["1m","5m","15m","30m","1h"])
    ]);
    return { price, multi };
  })();

  try {
    const { price, multi } = await timeoutPromise(p, opts.timeoutMs || HUNG_MS, "generate timeout");
    consecutiveFailures = 0;
    const ui = buildReportText(symbol, market, multi, price);
    return { ok: true, text: ui, price, multi };
  } catch (e) {
    consecutiveFailures++;
    console.error("generateSignalFor error:", e?.message || e);
    throw e;
  }
}

// -------------------- Auto-report scheduler --------------------
function startAutoReport(chatId) {
  if (autoReportTimer) clearInterval(autoReportTimer);
  const ms = Number(process.env.REPORT_INTERVAL_MS || CONFIG.REPORT_INTERVAL_MS || 10*60*1000);
  autoReportTimer = setInterval(async () => {
    if (!autoReportEnabled) return;
    try {
      const res = await generateSignalFor(CONFIG.ACTIVE_SYMBOL, CONFIG.ACTIVE_MARKET, { timeoutMs: 65_000 });
      if (res && bot) await bot.sendMessage(chatId || TELEGRAM_CHAT, `<b>AutoReport</b>\n\n${res.text}`, { parse_mode: "HTML" });
    } catch (e) {
      console.warn("AutoReport error:", e?.message || e);
    }
  }, ms);
}

// -------------------- Telegram handlers --------------------
if (bot) {
  bot.onText(/\/start/, (msg) => {
    const chat = msg.chat.id;
    bot.sendMessage(chat, `🔥 <b>AI Trader Bot</b>\nMarket: <b>${CONFIG.ACTIVE_MARKET}</b>\nSymbol: <b>${CONFIG.ACTIVE_SYMBOL}</b>`, { parse_mode: "HTML", ...keyboardOptions });
  });

  bot.on("message", async (msg) => {
    try {
      const text = msg.text?.toString().trim();
      const chat = msg.chat.id;

      if (!text) return;

      // market switches
      if (text === "Crypto") { CONFIG.ACTIVE_MARKET = "CRYPTO"; CONFIG.ACTIVE_SYMBOL = CONFIG.DEFAULT_BY_MARKET?.CRYPTO || CONFIG.ACTIVE_SYMBOL; return bot.sendMessage(chat, `✅ Market set to CRYPTO (symbol ${CONFIG.ACTIVE_SYMBOL})`, keyboardOptions); }
      if (text === "India") { CONFIG.ACTIVE_MARKET = "INDIA"; CONFIG.ACTIVE_SYMBOL = CONFIG.DEFAULT_BY_MARKET?.INDIA || CONFIG.ACTIVE_SYMBOL; return bot.sendMessage(chat, `✅ Market set to INDIA (symbol ${CONFIG.ACTIVE_SYMBOL})`, keyboardOptions); }
      if (text === "Forex") { CONFIG.ACTIVE_MARKET = "FOREX"; CONFIG.ACTIVE_SYMBOL = CONFIG.DEFAULT_BY_MARKET?.FOREX || CONFIG.ACTIVE_SYMBOL; return bot.sendMessage(chat, `✅ Market set to FOREX (symbol ${CONFIG.ACTIVE_SYMBOL})`, keyboardOptions); }
      if (text === "Commodities") { CONFIG.ACTIVE_MARKET = "COMMODITIES"; CONFIG.ACTIVE_SYMBOL = CONFIG.DEFAULT_BY_MARKET?.COMMODITIES || CONFIG.ACTIVE_SYMBOL; return bot.sendMessage(chat, `✅ Market set to COMMODITIES (symbol ${CONFIG.ACTIVE_SYMBOL})`, keyboardOptions); }

      if (text === "Auto-Report: OFF" || text === "Auto-Report: ON") {
        autoReportEnabled = !autoReportEnabled;
        const label = autoReportEnabled ? "ON" : "OFF";
        if (autoReportEnabled) startAutoReport(chat);
        else { if (autoReportTimer) { clearInterval(autoReportTimer); autoReportTimer = null; } }
        return bot.sendMessage(chat, `Auto-report: ${label}`, keyboardOptions);
      }

      // Generate signal
      if (text === "⚡ Generate Signal") {
        await bot.sendMessage(chat, `⏳ Generating live signal for ${CONFIG.ACTIVE_SYMBOL} (${CONFIG.ACTIVE_MARKET})...`, { reply_markup: { remove_keyboard: false } });
        try {
          const { text: ui } = await generateSignalFor(CONFIG.ACTIVE_SYMBOL, CONFIG.ACTIVE_MARKET, { timeoutMs: 65_000 });
          // prefer HTML safe
          await bot.sendMessage(chat, `<pre>${escapeHtml(ui)}</pre>`, { parse_mode: "HTML" , disable_web_page_preview: true, ...keyboardOptions});
        } catch (e) {
          console.error("Generate error send:", e?.message || e);
          await bot.sendMessage(chat, `❌ Error: ${String(e?.message || e)}`, keyboardOptions);
        }
      }
    } catch (err) {
      console.error("bot message handler error:", err?.stack || err);
    }
  });
}

// small helper escape for HTML <pre>
function escapeHtml(s=""){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

// -------------------- Watchdog (simple) --------------------
setInterval(async () => {
  try {
    if (lastGenerateAt && (Date.now() - lastGenerateAt) > (HUNG_MS + 30_000)) {
      console.warn("Watchdog: hung generate detected");
      if (bot && TELEGRAM_CHAT) await bot.sendMessage(TELEGRAM_CHAT, `⚠️ AI Trader Watchdog — Hung generate detected\nPID: ${process.pid}\nTime: ${new Date().toLocaleString()}`);
      // do not force exit here on Render; let infra restart if needed
    }
    if (consecutiveFailures >= MAX_FAILURES) {
      if (bot && TELEGRAM_CHAT) await bot.sendMessage(TELEGRAM_CHAT, `⚠️ AI Trader Watchdog — Consecutive failures: ${consecutiveFailures}\nConsider restart.`);
      consecutiveFailures = 0; // reset to avoid spam
    }
  } catch (e) { console.error("watchdog error:", e?.message || e); }
}, 30*1000);

// -------------------- Graceful shutdown --------------------
async function shutdown(code=0){
  try{
    console.log("Shutdown called");
    if (bot) try { await bot.stopPolling(); } catch {}
    if (autoReportTimer) clearInterval(autoReportTimer);
    clearLock();
  } catch (e){ console.error("shutdown err", e); }
  process.exit(code);
}
process.on("SIGINT", ()=>shutdown(0));
process.on("SIGTERM", ()=>shutdown(0));
process.on("uncaughtException", async (err)=>{
  console.error("uncaughtException:", err?.stack || err);
  try { if (bot && TELEGRAM_CHAT) await bot.sendMessage(TELEGRAM_CHAT, `<b>UncaughtException</b>\n${escapeHtml(String(err?.stack||err).slice(0,1500))}`, { parse_mode: "HTML" }); } catch {}
  await shutdown(1);
});
process.on("unhandledRejection", async (reason)=>{
  console.error("unhandledRejection:", reason);
});

// Final ready log
console.log("aiTraderBot initialized. HTTP port bound, Telegram ready (if token set).");