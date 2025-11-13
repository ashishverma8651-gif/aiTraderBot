// ===============================================
// 🚀 aiTraderBot.js — AI Trader v10.1 (Integrated + Robust)
// Auto report (CONFIG.REPORT_INTERVAL_MS) | Multi-market ready
// Integrates: utils.fetchMarketData, merge_signals, news_social, tg_commands (if present)
// ===============================================

import CONFIG from "./config.js";
import express from "express";
import WebSocket from "ws";
import { fetchMarketData, nowLocal, keepAlive } from "./utils.js";
import * as News from "./news_social.js";
import * as MergeModule from "./merge_signals.js"; // defensive import (may export analyzeAndMerge or mergeSignals)
import { drawElliottWaves } from "./elliott_module.js";

// optional telegram helper (project may provide tg_commands)
let sendTelegramMessage = null;
try {
  // prefer project's tg_commands if it exists and exposes sendTelegramMessage
  // eslint-disable-next-line
  const tg = await import("./tg_commands.js").catch(() => null);
  if (tg && typeof tg.sendTelegramMessage === "function") {
    sendTelegramMessage = tg.sendTelegramMessage;
    console.log("🔌 Using project tg_commands.sendTelegramMessage");
  }
} catch (e) {
  /* ignore */
}

// fallback built-in telegram sender if project's helper not present
let botFallback = null;
let fallbackChatId = CONFIG.TELEGRAM?.CHAT_ID || null;
if (!sendTelegramMessage) {
  try {
    const { default: TelegramBot } = await import("node-telegram-bot-api");
    if (CONFIG.TELEGRAM?.BOT_TOKEN) {
      botFallback = new TelegramBot(CONFIG.TELEGRAM.BOT_TOKEN, { polling: false });
      console.log("🔌 Telegram fallback bot initialized");
    } else {
      console.warn("⚠️ Telegram token missing; will not send Telegram messages");
    }
  } catch (e) {
    console.warn("⚠️ node-telegram-bot-api not installed or failed to import:", e.message);
  }
}

// utility to send messages (uses project helper or fallback bot)
async function sendMsgToTelegram(text, options = {}) {
  try {
    if (sendTelegramMessage) {
      return await sendTelegramMessage(text, options);
    }
    if (botFallback && fallbackChatId) {
      return await botFallback.sendMessage(fallbackChatId, text, options);
    }
    console.log("🔔 Message (no-telegram):", text);
    return null;
  } catch (e) {
    console.warn("sendMsgToTelegram failed:", e.message);
    return null;
  }
}

// ---------------------- Express Keep-Alive ----------------------
const PORT = process.env.PORT || CONFIG.SERVER?.PORT || 10000;
const app = express();
app.get("/", (req, res) => res.send("✅ AI Trader Bot is alive and running"));
app.get("/ping", (req, res) => res.send({ ok: true, now: nowLocal() }));

// optional endpoint to trigger on-demand analysis
app.get("/analyze/:symbol?", async (req, res) => {
  const sym = (req.params.symbol || CONFIG.SYMBOL).toUpperCase();
  try {
    const out = await buildAndSendReport(sym);
    res.json({ ok: true, result: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

// ---------------------- Binance WebSocket (live price) ----------------------
let ws = null;
let socketAlive = false;
let lastPrice = null;
let wsReconnectTimer = null;
let wsUrlInUse = CONFIG.DATA_SOURCES?.CRYPTO?.SOCKETS?.MAIN || "wss://stream.binance.com:9443/ws";

function connectLiveSocket(symbol = CONFIG.SYMBOL) {
  try {
    const stream = `${symbol.toLowerCase()}@ticker`;
    const url =
      (CONFIG.DATA_SOURCES?.CRYPTO?.SOCKETS?.MAIN || wsUrlInUse).replace(/\/+$/, "") + `/${stream}`;
    wsUrlInUse = url;
    console.log("🔌 Connecting WS:", url);
    ws = new WebSocket(url);

    ws.on("open", () => {
      socketAlive = true;
      console.log(`📡 WebSocket connected for ${symbol}`);
      if (wsReconnectTimer) {
        clearTimeout(wsReconnectTimer);
        wsReconnectTimer = null;
      }
    });

    ws.on("message", (data) => {
      try {
        const json = JSON.parse(data.toString());
        if (json?.c) {
          lastPrice = parseFloat(json.c);
        } else if (json?.p) {
          // some streams use p for price
          lastPrice = parseFloat(json.p);
        }
      } catch (e) {
        // ignore parse errors
      }
    });

    ws.on("close", () => {
      socketAlive = false;
      console.warn("🔴 WebSocket closed — scheduling reconnect");
      scheduleReconnect(symbol);
    });

    ws.on("error", (err) => {
      socketAlive = false;
      console.warn("⚠️ WebSocket error:", err.message);
      try { ws.terminate(); } catch (e) {}
      scheduleReconnect(symbol);
    });
  } catch (err) {
    socketAlive = false;
    console.error("❌ WebSocket init failed:", err.message);
    scheduleReconnect(symbol);
  }
}

function scheduleReconnect(symbol = CONFIG.SYMBOL, delay = CONFIG.DATA_SOURCES?.CRYPTO?.SOCKETS?.RECONNECT_DELAY_MS || 10000) {
  if (wsReconnectTimer) return;
  wsReconnectTimer = setTimeout(() => {
    wsReconnectTimer = null;
    connectLiveSocket(symbol);
  }, delay);
}

connectLiveSocket(CONFIG.SYMBOL);

// ---------------------- Merge module resolver ----------------------
function resolveMergeFunction(moduleObj) {
  // try common names (backwards compatible)
  if (!moduleObj) return null;
  if (typeof moduleObj.analyzeAndMerge === "function") return moduleObj.analyzeAndMerge;
  if (typeof moduleObj.mergeSignals === "function") return moduleObj.mergeSignals;
  if (typeof moduleObj.default === "function") return moduleObj.default;
  // fallback to any exported function
  const fn = Object.values(moduleObj).find((v) => typeof v === "function");
  return fn || null;
}
const mergeFn = resolveMergeFunction(MergeModule);
if (!mergeFn) console.warn("⚠️ merge_signals module provides no callable export. Analysis will fallback.");

// ---------------------- Helpers ----------------------
function formatNumber(v, dp = 2) {
  if (v === null || v === undefined || Number.isNaN(v)) return "N/A";
  return Number(v).toFixed(dp);
}

// Build human-friendly message from merged result
function formatMergedMessage(result) {
  if (!result) return "⚠️ No result";
  // prefer `summary` if provided by merge_or analyzeAndMerge
  if (result.summary && typeof result.summary === "string") return result.summary;

  // otherwise compose
  const lines = [];
  lines.push(`🚀 <b>${result.symbol || CONFIG.SYMBOL} — AI Trader</b>`);
  lines.push(`🕒 ${nowLocal()}`);
  lines.push(`📡 Source: ${socketAlive ? "Binance (Live)" : "REST (Fallback)"}`);
  lines.push(`💰 <b>Bias:</b> ${result.final?.decision ?? result.bias ?? "N/A"} — <b>${result.final?.confidence ?? result.strength ?? result.score ?? "N/A"}%</b>`);
  lines.push(`━━━━━━━━━━━━━━━━━━━`);
  if (result.indicators) {
    const ind = result.indicators;
    lines.push(`📊 Multi-TF Decision: ${ind.decision || ind.tfSignal || "N/A"} (conf ${ind.confidence ?? "N/A"}%)`);
  }
  if (result.elliott) {
    const e = result.elliott;
    lines.push(`📐 Elliott: ${e.structure || e.summary || e.patternType || "N/A"} (${e.confidence ?? e.conf ?? 0}%)`);
  }
  if (typeof result.mlProb !== "undefined") {
    lines.push(`🤖 ML: ${result.mlLabel ?? result.ml?.label ?? "N/A"} (${formatNumber(result.mlProb,2)}%)`);
  }
  if (typeof result.newsImpact !== "undefined") {
    lines.push(`📰 News: ${result.newsPolarity ?? "N/A"} (${result.newsImpact ?? "N/A"})`);
  }
  if (result.alert) lines.push(`🚨 ${result.alert}`);
  lines.push(`━━━━━━━━━━━━━━━━━━━`);
  if (result.chart) lines.push(result.chart);
  return lines.join("\n");
}

// ---------------------- Build & Send single report ----------------------
export async function buildAndSendReport(symbol = CONFIG.SYMBOL, interval = "15m") {
  try {
    // Prefer using the unified merge function if available
    if (mergeFn) {
      // some variants expect (symbol, interval) and return full object
      const maybePromise = mergeFn(symbol, interval);
      const merged = (maybePromise instanceof Promise) ? await maybePromise : maybePromise;
      // if merged doesn't contain chart but has elliott.swings, add ascii chart
      if (!merged.chart && merged.elliott?.swings) {
        merged.chart = drawElliottWaves(merged.elliott.swings);
      }
      // send summary (if mergeFn provided full summary text, use that)
      const msg = formatMergedMessage(merged);
      await sendMsgToTelegram(msg, { parse_mode: "HTML" });
      return merged;
    }

    // fallback: build ad-hoc report using utils + news + elliott
    const candles = await fetchMarketData(symbol, interval, 300);
    const last = (candles && candles.length) ? candles.at(-1) : null;
    const price = lastPrice || (last?.close ?? null) || 0;

    const news = await News.fetchNews(symbol.startsWith("BTC") ? "BTC" : symbol);
    const ell = await import("./elliott_module.js").then(m => m.default ? m.default(candles) : m.analyzeElliott(candles));
    const chart = ell?.swings ? drawElliottWaves(ell.swings) : null;

    const text = [
      `🚀 <b>${symbol} — AI Trader</b>`,
      `🕒 ${nowLocal()}`,
      `💰 Price: ${formatNumber(price, 2)}`,
      `📡 Source: ${socketAlive ? "Binance (Live)" : "REST (Fallback)"}`,
      `📊 Elliott: ${ell?.structure ?? ell?.summary ?? "N/A"} (${ell?.confidence ?? 0}%)`,
      `📰 News: ${news?.polarity ?? "N/A"} (${news?.score ?? news?.newsImpact ?? 0})`,
      ``,
      chart || "",
    ].join("\n");

    await sendMsgToTelegram(text, { parse_mode: "HTML" });
    return { ok: true, price, ell, news };
  } catch (e) {
    console.error("buildAndSendReport error:", e && e.message);
    // inform admin chat if telegram available
    await sendMsgToTelegram(`❌ Report failed for ${symbol}: ${e.message}`, {});
    return { ok: false, error: e.message };
  }
}

// ---------------------- Auto loop ----------------------
const intervalMs = CONFIG.REPORT_INTERVAL_MS || 15 * 60 * 1000;
console.log(`⏱ Auto-report interval: ${intervalMs / 1000}s`);

let autoTimer = setInterval(async () => {
  try {
    await keepAlive(CONFIG.SELF_PING_URL);
    await buildAndSendReport(CONFIG.SYMBOL, "15m");
    console.log(`✅ Auto report executed at ${nowLocal()}`);
  } catch (e) {
    console.error("Auto report loop error:", e && e.message);
  }
}, intervalMs);

// run once at startup
(async () => {
  try {
    await buildAndSendReport(CONFIG.SYMBOL, "15m");
  } catch (e) { /* ignore */ }
})();

// ---------------------- Graceful shutdown ----------------------
function shutdown() {
  console.log("🛑 Shutting down...");
  if (ws) try { ws.close(); } catch (e) {}
  if (autoTimer) clearInterval(autoTimer);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ---------------------- Exports ----------------------
export default { buildAndSendReport, connectLiveSocket, shutdown };