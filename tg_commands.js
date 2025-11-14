// tg_commands.js — build + format + send (defensive)
import TelegramBot from "node-telegram-bot-api";
import CONFIG from "./config.js";
import { fetchMarketData, analyzeVolume, computeFibLevels as utilsFib } from "./utils.js";
import * as core from "./core_indicators.js";

const BOT_TOKEN = CONFIG?.TELEGRAM?.BOT_TOKEN || process.env.BOT_TOKEN;
const CHAT_ID = CONFIG?.TELEGRAM?.CHAT_ID || process.env.CHAT_ID;
const bot = BOT_TOKEN ? new TelegramBot(BOT_TOKEN, { polling: false }) : null;

function safeComputeFib(lo, hi) {
  try { if (typeof utilsFib === "function") return utilsFib([{ low: lo, high: hi }]); } catch {}
  const range = hi - lo; return { lo, hi, retrace: { "0.236": hi - range*0.236, "0.382": hi - range*0.382 } };
}

async function calcIndicatorsSafe(candles) {
  try {
    if (core && typeof core.calculateIndicators === "function") return await core.calculateIndicators(candles);
  } catch (e) { console.warn("calcIndicatorsSafe:", e?.message || e); }
  return { RSI: null, MACD: { hist: null }, ATR: null };
}

export async function buildAIReport(symbol="BTCUSDT", context=null) {
  try {
    if (!context) {
      const c = await fetchMarketData(symbol, "15m", 200);
      const candles = c?.data || c || [];
      context = { price: candles.length?Number(candles.at(-1).close):0, candles, ml:null, ell:null, news:null, socketAlive:false };
    }
    const tfs = ["1m","5m","15m","30m","1h"];
    const mtf = [];
    for (const tf of tfs) {
      try {
        const resp = await fetchMarketData(symbol, tf, 200);
        const candles = resp?.data || resp || [];
        const last = candles.at(-1) || {};
        const indicators = candles.length ? await calcIndicatorsSafe(candles) : (resp.indicators || { RSI:null, MACD:{hist:null}, ATR:null });
        const volTrend = analyzeVolume(candles);
        const hi = candles.length ? Math.max(...candles.map(c=>Number(c.high))) : null;
        const lo = candles.length ? Math.min(...candles.map(c=>Number(c.low))) : null;
        const bias = (indicators?.RSI && indicators?.MACD?.hist)
          ? indicators.RSI > 60 && indicators.MACD.hist > 0 ? "Bullish" : indicators.RSI < 40 && indicators.MACD.hist < 0 ? "Bearish" : "Neutral"
          : "N/A";
        mtf.push({ tf, candles, last, indicators, volTrend, fib: (hi && lo) ? safeComputeFib(lo, hi) : resp.fib || null, bias });
      } catch (e) { mtf.push({ tf, error: String(e) }); }
    }
    const tf15 = mtf.find(x=>x.tf==="15m");
    return { symbol, price: context.price || (tf15?.last ? Number(tf15.last.close) : 0), mtf, ell: context.ell, ml: context.ml, news: context.news, fib15: tf15?.fib||null, socketAlive: context.socketAlive, generatedAt: new Date().toISOString() };
  } catch (err) { return { symbol, price:0, mtf:[], ell:null, ml:null, news:null, fib15:null, socketAlive:false, generatedAt:new Date().toISOString(), error: err?.message || String(err) }; }
}

export async function formatAIReport(r) {
  const price = Number(r.price || 0);
  const mlLabel = r.ml?.label || "Neutral";
  const mlProb = Number(r.ml?.prob ?? r.ml?.confidence ?? 0).toFixed(1);
  const block = (r.mtf || []).map(m=>{
    if (m.error) return `[${m.tf}] Error: ${m.error}`;
    const rsi = m.indicators?.RSI ? m.indicators.RSI.toFixed(1) : "N/A";
    const macd = (m.indicators?.MACD?.hist !== undefined && m.indicators?.MACD?.hist !== null) ? Number(m.indicators.MACD.hist).toFixed(3) : "N/A";
    const atr = m.indicators?.ATR ? Number(m.indicators.ATR).toFixed(2) : "N/A";
    const volTxt = (m.volTrend?.status || m.volTrend) === "RISING" || m.volTrend === "INCREASING" ? "Rising" : (m.volTrend?.status || m.volTrend) === "FALLING" || m.volTrend === "DECREASING" ? "Falling":"Stable";
    const emoji = m.bias==="Bullish"?"🟢":m.bias==="Bearish"?"🔴":"⚪";
    return `[${m.tf}] ${emoji} ${m.bias}\nRSI ${rsi} | MACD ${macd} | ATR ${atr}\nPrice: ${m.last?.close || "N/A"} | Vol: ${volTxt}\nSignal: ${m.bias==="Bullish"?"BUY":m.bias==="Bearish"?"SELL":"HOLD"}`;
  }).join("\n---------------------------------------\n");

  const atr15 = (r.mtf.find(x=>x.tf==="15m")?.indicators?.ATR) || (price * 0.005) || 0;
  const tp1 = (price + atr15*1.5).toFixed(2), tp2 = (price + atr15*3).toFixed(2), tp3 = (price + atr15*5).toFixed(2);
  const sl = (price - atr15*2).toFixed(2);
  const fib = r.fib15; const fibRange = fib ? `${fib.lo} – ${fib.hi}` : "N/A";
  const sentiment = r.news?.sentiment || 0;
  const sentTxt = sentiment>0? "Bullish 🟢": sentiment<0? "Bearish 🔴":"Neutral";
  const headlines = (r.news?.headlines || []).slice(0,4).map(h=>`• ${h}`).join("\n") || "N/A";

  const html = `
<b>${r.symbol} — AI Trader</b>
${new Date(r.generatedAt).toLocaleString()}

Price: <b>${price.toFixed(2)}</b>

<b>AI Prediction:</b> ${mlLabel} (${mlProb}%)
<b>Elliott:</b> ${r.ell ? (r.ell.wave || "N/A")+" | Conf "+(Number(r.ell.confidence||0).toFixed(1)+"%") : "N/A"}

<b>📊 Multi-Timeframe Overview</b>
${block}

<b>🎯 TP/SL Levels</b>
TP1: ${tp1} | TP2: ${tp2} | TP3: ${tp3}
SL: ${sl}
Fib Zone (15m): ${fibRange}

<b>📰 News Impact:</b> ${sentTxt}
${headlines}

<i>v11 — TradingView Clean UI</i>
  `.trim();

  // Always return HTML even if bot not configured
  if (!BOT_TOKEN || !CHAT_ID) return html;

  try {
    await bot.sendMessage(CHAT_ID, html, { parse_mode: "HTML", disable_web_page_preview: true });
    return html;
  } catch (e) {
    console.error("Telegram send failed:", e?.message || e);
    return html;
  }
}