// aiTraderBot.js — FULL, PRODUCTION-READY Telegram panel + watchdog + live signals
// Requires: node >= 18, packages: telegraf, express, axios
// Files: ./config.js (default export), ./utils.js (named exports: fetchMultiTF, fetchPrice)

import fs from "fs";
import path from "path";
import express from "express";
import axios from "axios";
import { Telegraf, Markup } from "telegraf";

import CONFIG from "./config.js";
import { fetchMultiTF, fetchPrice } from "./utils.js";

// -------------------- Instance lock --------------------
const LOCK_FILE = path.resolve(".aitraderbot.lock");
function writeLock() { try { fs.writeFileSync(LOCK_FILE, String(process.pid)); } catch {} }
function clearLock() { try { if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE); } catch {} }
if (fs.existsSync(LOCK_FILE)) {
  try {
    const pid = Number(fs.readFileSync(LOCK_FILE, "utf8"));
    if (pid && pid > 0) { process.kill(pid, 0); console.log("Another instance running — exiting."); process.exit(0); }
  } catch {}
}
writeLock();
process.once("exit", clearLock);

// -------------------- Globals & tunables --------------------
const PORT = Number(process.env.PORT || 10000);
const KEEPALIVE_MS = Number(process.env.KEEPALIVE_INTERVAL_MS || 3 * 60 * 1000); // 3m
const HUNG_TASK_MS = Number(process.env.HUNG_TASK_MS || 90 * 1000); // 90s
const WATCHDOG_MS = Number(process.env.WATCHDOG_MS || 30 * 1000); // 30s
const MAX_CONSECUTIVE_FAILURES = Number(process.env.MAX_CONSECUTIVE_FAILURES || 6);

let lastGenerateAt = 0;
let lastGenerateId = null;
let consecutiveFailures = 0;
let autoReportEnabled = Boolean(process.env.AUTO_REPORT_ENABLED === "true");
let autoReportTimer = null;

// -------------------- Telegram bot init --------------------
const TELEGRAM_TOKEN = CONFIG?.TELEGRAM?.BOT_TOKEN || process.env.BOT_TOKEN || null;
const TELEGRAM_CHAT = CONFIG?.TELEGRAM?.CHAT_ID || process.env.CHAT_ID || null;
const TELEGRAM_ENABLED = Boolean(TELEGRAM_TOKEN && TELEGRAM_CHAT);

const bot = TELEGRAM_ENABLED ? new Telegraf(TELEGRAM_TOKEN) : null;

// safe send: try Telegraf then HTTP API fallback
async function safeTelegramSend(text, extra = {}) {
  try {
    if (!TELEGRAM_ENABLED) return false;
    const payload = String(text).slice(0, 4000);
    // prefer bot.telegram.sendMessage (works when bot launched)
    if (bot && bot.telegram) {
      await bot.telegram.sendMessage(TELEGRAM_CHAT, payload, { parse_mode: "HTML", disable_web_page_preview: true, ...extra });
      return true;
    }
    // fallback raw HTTP
    if (TELEGRAM_TOKEN) {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: TELEGRAM_CHAT,
        text: payload,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...extra
      }, { timeout: 6000 });
      return true;
    }
  } catch (e) {
    console.error("safeTelegramSend failed:", e?.message || e);
  }
  return false;
}

// -------------------- Express server & health --------------------
const app = express();
app.get("/", (req, res) => res.send("AI Trader Bot Running ✔"));
app.get("/ping", (req, res) => res.send("pong"));
app.get("/health", (req, res) => {
  res.json({
    pid: process.pid,
    uptime_s: Math.round(process.uptime()),
    lastGenerateAt,
    consecutiveFailures,
    autoReportEnabled
  });
});
app.listen(PORT, () => console.log("Server listening on", PORT));

// keepalive ping to public url (if set)
const PUBLIC_URL = process.env.RENDER_EXTERNAL_URL || process.env.SELF_PING_URL || null;
if (PUBLIC_URL) {
  setInterval(async () => {
    try {
      await axios.get((PUBLIC_URL.replace(/\/+$/, "")) + "/ping", { timeout: 5000 });
      // console.log("Keepalive OK");
    } catch (e) {
      console.warn("Keepalive ping failed:", (e?.message || e));
    }
  }, KEEPALIVE_MS);
}

// -------------------- UI helpers --------------------
function marketKeyboard() {
  return Markup.inlineKeyboard([
    [ Markup.button.callback("⚡ Generate Signal", "GENERATE_SIGNAL") ],
    [
      Markup.button.callback("Crypto", "SET_MARKET_CRYPTO"),
      Markup.button.callback("India", "SET_MARKET_INDIA")
    ],
    [
      Markup.button.callback("Forex", "SET_MARKET_FOREX"),
      Markup.button.callback("Commodities", "SET_MARKET_COMMODITIES")
    ],
    [ Markup.button.callback(`Auto-Report: ${autoReportEnabled ? "ON" : "OFF"}`, "TOGGLE_AUTOREPORT") ]
  ]);
}

function symbolsKeyboardFor(market) {
  const list = CONFIG?.SYMBOLS?.[market] || {};
  const keys = Object.keys(list).slice(0, 8); // limit to 8
  const rows = [];
  for (let i = 0; i < keys.length; i += 2) {
    const a = keys[i];
    const b = keys[i+1];
    const row = [];
    if (a) row.push(Markup.button.callback(a, `SET_SYMBOL_${market}_${a}`));
    if (b) row.push(Markup.button.callback(b, `SET_SYMBOL_${market}_${b}`));
    rows.push(row);
  }
  rows.push([ Markup.button.callback("Back", "BACK_HOME") ]);
  return Markup.inlineKeyboard(rows);
}

// -------------------- state (mutable runtime) --------------------
if (!CONFIG.ACTIVE_MARKET) CONFIG.ACTIVE_MARKET = Object.keys(CONFIG.SYMBOLS || {})[0] || "CRYPTO";
if (!CONFIG.ACTIVE_SYMBOL) {
  const def = CONFIG.DEFAULT_BY_MARKET?.[CONFIG.ACTIVE_MARKET];
  if (def) CONFIG.ACTIVE_SYMBOL = def;
}

// -------------------- helper: compute simple indicators --------------------
function pct(a, b) { if (!Number.isFinite(a) || !Number.isFinite(b)) return 0; return ((b - a) / a) * 100; }

// simple slope: linear regression slope on close values (ms -> price)
function slopeOf(candles) {
  try {
    if (!Array.isArray(candles) || candles.length < 3) return 0;
    const n = candles.length;
    const xs = []; const ys = [];
    for (let i = 0; i < n; i++) { xs.push(i); ys.push(candles[i].close); }
    const xmean = xs.reduce((s,v)=>s+v,0)/n;
    const ymean = ys.reduce((s,v)=>s+v,0)/n;
    let num = 0, den = 0;
    for (let i=0;i<n;i++){ num += (xs[i]-xmean)*(ys[i]-ymean); den += (xs[i]-xmean)*(xs[i]-xmean); }
    if (den === 0) return 0;
    return num/den;
  } catch { return 0; }
}

// RSI 14
function rsiOf(candles, period = 14) {
  try {
    const closes = candles.map(c => c.close).filter(Number.isFinite);
    if (closes.length < period + 1) return null;
    let gains = 0, losses = 0;
    for (let i = closes.length - period; i < closes.length; i++) {
      const diff = closes[i] - closes[i-1];
      if (diff > 0) gains += diff;
      else losses += Math.abs(diff);
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
  } catch { return null; }
}

// ATR (approx) using high/low/close
function atrOf(candles, period = 14) {
  try {
    if (candles.length < 2) return null;
    const trs = [];
    for (let i = 1; i < candles.length; i++) {
      const cur = candles[i];
      const prev = candles[i-1];
      const tr = Math.max(
        cur.high - cur.low,
        Math.abs(cur.high - prev.close),
        Math.abs(cur.low - prev.close)
      );
      trs.push(tr);
    }
    if (trs.length === 0) return null;
    // simple avg of last 'period' TRs
    const last = trs.slice(-Math.min(period, trs.length));
    return last.reduce((s,v)=>s+v,0) / last.length;
  } catch { return null; }
}

// -------------------- UI text builder --------------------
function buildUIText(symbol, market, multiTFData, livePrice) {
  const when = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  let lines = [];
  lines.push(`🔥 ${symbol} — AI Market Intelligence`);
  lines.push(`Time: ${when}`);
  lines.push(`Price: ${Number.isFinite(livePrice) ? livePrice.toFixed(2) : "N/A"}`);
  lines.push("━━━━━━━━━━━━━━━━━━");
  const tfs = Object.keys(multiTFData || {});
  for (const tf of tfs) {
    const batch = multiTFData[tf];
    const arr = batch?.data || batch?.map?.(x=>x) || [];
    const last = Array.isArray(arr) && arr.length ? arr[arr.length - 1] : null;
    const rsi = last ? rsiOf(arr, 14) : null;
    const atr = last ? atrOf(arr, 14) : null;
    const slp = last ? slopeOf(arr) : 0;
    const trend = slp > 0 ? "UP" : (slp < 0 ? "DOWN" : "FLAT");
    lines.push(`🕒 ${tf} — ${last ? (last.close > (arr[arr.length-2]?.close||last.close) ? "🟦 BUY" : "🔴 SELL") : "⚪ HOLD"}`);
    lines.push(`• RSI: ${rsi !== null ? rsi.toFixed(2) : "—"} | ATR: ${atr !== null ? atr.toFixed(4) : "—"}`);
    lines.push(`• Trend: ${trend}`);
    if (last) lines.push(`• Last: ${Number(last.close).toFixed(4)}`);
    lines.push("");
  }
  lines.push("━━━━━━━━━━━━━━━━━━");
  lines.push(`🧭 Fusion: Live-first | Sources: ${CONFIG.API ? "Yahoo/Binance/Proxies" : "N/A"}`);
  return lines.join("\n");
}

// -------------------- Generate signal function --------------------
async function generateSignalFor(symbol, market, opts = { timeoutMs: 70_000 }) {
  const id = `${symbol}_${market}_${Date.now()}`;
  lastGenerateId = id;
  lastGenerateAt = Date.now();

  // promise race: do fetchMultiTF and fetchPrice in parallel with timeout
  const p = (async () => {
    const [multi, price] = await Promise.all([
      fetchMultiTF(symbol, Object.keys(CONFIG.INTERVALS || { "15m":1 }).length ? CONFIG.INTERVALS : ["1m","5m","15m","30m","1h"]),
      fetchPrice(symbol, market)
    ]);
    return { multi, price };
  })();

  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("generateSignal timeout")), opts.timeoutMs || HUNG_TASK_MS));
  try {
    const { multi, price } = await Promise.race([p, timeout]);
    consecutiveFailures = 0;
    lastGenerateAt = Date.now();
    const ui = buildUIText(symbol, market, multi, price);
    return { ok: true, uiText: ui, price, multi };
  } catch (e) {
    consecutiveFailures++;
    console.error("generateSignalFor error:", e?.message || e);
    throw e;
  }
}

// -------------------- Telegram handlers --------------------
if (bot) {

  // Start/panel
  bot.start(async (ctx) => {
    try {
      const text = `🏠 <b>AI Trader Control Panel</b>\nMarket: <b>${CONFIG.ACTIVE_MARKET}</b>\nSymbol: <b>${CONFIG.ACTIVE_SYMBOL}</b>`;
      await ctx.reply(text, marketKeyboard());
    } catch (e) { console.error("start error", e?.message || e); }
  });

  // callback queries
  bot.on("callback_query", async (ctx) => {
    try {
      const data = ctx.callbackQuery?.data;
      if (!data) { await ctx.answerCbQuery(); return; }

      // market switch
      if (data === "SET_MARKET_CRYPTO" || data === "SET_MARKET_INDIA" || data === "SET_MARKET_FOREX" || data === "SET_MARKET_COMMODITIES") {
        const map = {
          "SET_MARKET_CRYPTO": "CRYPTO",
          "SET_MARKET_INDIA": "INDIA",
          "SET_MARKET_FOREX": "FOREX",
          "SET_MARKET_COMMODITIES": "COMMODITIES"
        };
        CONFIG.ACTIVE_MARKET = map[data] || CONFIG.ACTIVE_MARKET;
        // set default symbol for that market
        const def = CONFIG.DEFAULT_BY_MARKET?.[CONFIG.ACTIVE_MARKET] || Object.keys(CONFIG.SYMBOLS?.[CONFIG.ACTIVE_MARKET]||{})[0];
        if (def) CONFIG.ACTIVE_SYMBOL = def;
        await ctx.editMessageText(`🔄 Market set to <b>${CONFIG.ACTIVE_MARKET}</b>\nChoose symbol:`, symbolsKeyboardFor(CONFIG.ACTIVE_MARKET));
        return;
      }

      // back
      if (data === "BACK_HOME") {
        await ctx.editMessageText(`🏠 <b>AI Trader Control Panel</b>\nMarket: <b>${CONFIG.ACTIVE_MARKET}</b>\nSymbol: <b>${CONFIG.ACTIVE_SYMBOL}</b>`, marketKeyboard());
        return;
      }

      // toggle auto-report
      if (data === "TOGGLE_AUTOREPORT") {
        autoReportEnabled = !autoReportEnabled;
        if (autoReportEnabled) startAutoReport(); else stopAutoReport();
        await ctx.answerCbQuery(`Auto-report ${autoReportEnabled ? "enabled" : "disabled"}`);
        await ctx.editMessageText(`Auto-report is now <b>${autoReportEnabled ? "ON" : "OFF"}</b>`, marketKeyboard());
        return;
      }

      // generate
      if (data === "GENERATE_SIGNAL") {
        // immediate UI update
        await ctx.editMessageText("⏳ Generating live signal...");
        try {
          const { uiText } = await generateSignalFor(CONFIG.ACTIVE_SYMBOL, CONFIG.ACTIVE_MARKET, { timeoutMs: 70_000 });
          await ctx.editMessageText(uiText, marketKeyboard());
        } catch (e) {
          await ctx.editMessageText(`❌ Error: ${String(e?.message || e)}`, marketKeyboard());
        }
        return;
      }

      // symbol set callbacks look like SET_SYMBOL_<MARKET>_<SYMBOL>
      if (data.startsWith("SET_SYMBOL_")) {
        const parts = data.split("_");
        // parts: ["SET","SYMBOL","MARKET","SYMBOLNAME..."]
        if (parts.length >= 4) {
          const market = parts[2];
          const symbol = parts.slice(3).join("_");
          if (CONFIG.SYMBOLS?.[market] && CONFIG.SYMBOLS[market][symbol]) {
            CONFIG.ACTIVE_MARKET = market;
            CONFIG.ACTIVE_SYMBOL = symbol;
            await ctx.editMessageText(`✅ Selected ${symbol} on ${market}\nUse Generate Signal.`, marketKeyboard());
            return;
          }
        }
        await ctx.answerCbQuery("Invalid symbol");
        return;
      }

      await ctx.answerCbQuery("Unknown action");
    } catch (err) {
      console.error("callback_query error:", err?.message || err);
      try { await ctx.reply("❌ Error: " + String(err?.message || err)); } catch {}
    }
  });

  // commands
  bot.command("panel", async (ctx) => {
    await ctx.reply(`🏠 <b>AI Trader Control Panel</b>\nMarket: <b>${CONFIG.ACTIVE_MARKET}</b>\nSymbol: <b>${CONFIG.ACTIVE_SYMBOL}</b>`, marketKeyboard());
  });

  // Launch bot (polling)
  (async () => {
    try {
      await bot.launch({ polling: { interval: 300, timeout: 60 } });
      console.log("Telegram bot launched (polling)");
    } catch (e) {
      console.error("Bot launch failed:", e?.message || e);
    }
  })();
}

// -------------------- Auto-report scheduler --------------------
function startAutoReport() {
  if (autoReportTimer) clearInterval(autoReportTimer);
  const ms = Number(process.env.REPORT_INTERVAL_MS || CONFIG.REPORT_INTERVAL_MS || 15*60*1000);
  autoReportTimer = setInterval(async () => {
    if (!autoReportEnabled) return;
    try {
      const { uiText } = await generateSignalFor(CONFIG.ACTIVE_SYMBOL, CONFIG.ACTIVE_MARKET, { timeoutMs: 60_000 });
      await safeTelegramSend(`<b>AutoReport</b>\n${uiText}`);
    } catch (e) {
      console.warn("AutoReport error:", e?.message || e);
    }
  }, ms);
  // initial immediate
  setTimeout(async () => { if (autoReportEnabled) { try { const { uiText } = await generateSignalFor(CONFIG.ACTIVE_SYMBOL, CONFIG.ACTIVE_MARKET); await safeTelegramSend(`<b>AutoReport</b>\n${uiText}`); } catch(e){} } }, 3000);
}
function stopAutoReport() { if (autoReportTimer) clearInterval(autoReportTimer); autoReportTimer = null; }
if (autoReportEnabled) startAutoReport();

// -------------------- Watchdog --------------------
setInterval(async () => {
  try {
    // hung generate detection
    if (lastGenerateAt && (Date.now() - lastGenerateAt) > (HUNG_TASK_MS + 30_000)) {
      console.warn("Watchdog: possible hung generate");
      await safeTelegramSend(`<b>AI Trader Watchdog</b>\nHung generate detected\nPID: ${process.pid}\nTime: ${new Date().toLocaleString()}`);
      // attempt graceful restart
      await gracefulShutdownAndExit(1);
      return;
    }

    // consecutive failures
    if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      await safeTelegramSend(`<b>AI Trader Watchdog</b>\nConsecutive failures: ${consecutiveFailures}\nRestarting...`);
      await gracefulShutdownAndExit(1);
      return;
    }
  } catch (e) {
    console.error("watchdog error:", e?.message || e);
  }
}, WATCHDOG_MS);

// -------------------- Graceful shutdown --------------------
async function gracefulShutdownAndExit(code = 0) {
  try {
    console.log("Graceful shutdown...");
    try { if (autoReportTimer) clearInterval(autoReportTimer); } catch {}
    try { if (bot) await bot.stop(); } catch {}
    clearLock();
  } catch (e) { console.error("shutdown err:", e?.message || e); }
  process.exit(code);
}
process.on("SIGINT", () => gracefulShutdownAndExit(0));
process.on("SIGTERM", () => gracefulShutdownAndExit(0));
process.on("uncaughtException", async (err) => {
  console.error("uncaughtException:", err?.stack || err);
  await safeTelegramSend(`<b>UncaughtException</b>\n${String(err?.stack||err).slice(0,1500)}`);
  await gracefulShutdownAndExit(1);
});
process.on("unhandledRejection", async (reason) => {
  console.error("unhandledRejection:", reason);
  await safeTelegramSend(`<b>UnhandledRejection</b>\n${String(reason).slice(0,1500)}`);
  consecutiveFailures++;
});

// -------------------- Export for tests / external use --------------------
export default {
  generateSignalFor,
  startAutoReport,
  stopAutoReport
};

console.log("aiTraderBot initialized. Use /start in Telegram to open panel (if bot token configured).");