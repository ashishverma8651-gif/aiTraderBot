// =============================================================
// tg_commands.js — FINAL CLEAN OLD-STYLE VERSION
// Compatible With Your fetchMultiTF OLD Structure
// No Duplicate Imports — No Repeated buildAIReport
// =============================================================

// -------------------------
// OLD IMPORT STYLE
// -------------------------
import ML from "./ml_module_v8_6.js";
import News from "./news_social.js";

import CONFIG from "./config.js";
import { fetchMultiTF } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";

import TelegramBot from "node-telegram-bot-api";

// -------------------------
// Extract ML Functions
// -------------------------
const {
  runMLPrediction,
  runMicroPrediction,
  calculateAccuracy,
  recordOutcome,
  recordPrediction
} = ML;

// -------------------------
const { fetchNewsBundle } = News;


// =============================================================
// TELEGRAM BOT
// =============================================================
export const bot = new TelegramBot(CONFIG.TELEGRAM.BOT_TOKEN, {
  polling: true,
});


// =============================================================
// SAFE SENDER (AUTO SPLIT)
// =============================================================
async function safeSend(chatId, text) {
  if (!text) return;
  const MAX = 3800;

  if (text.length <= MAX) {
    return bot.sendMessage(chatId, text, {
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  }

  for (let i = 0; i < text.length; i += MAX) {
    await bot.sendMessage(chatId, text.slice(i, i + MAX), {
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  }
}


// =============================================================
// HELPERS
// =============================================================
const NF = (v, d = 2) =>
  typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : "N/A";

function IST() {
  return new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour12: true,
  });
}

function tfBlock(label, d) {
  if (!d) return "";

  return `
🕒 ${label} — ${d.sig}

RSI ${d.rsi} | MACD ${d.macd} | Vol ${d.vol} | ATR ${d.atr}
Elliott: ${d.ell} | Conf ${d.ellConf}%
S: ${d.s} | R: ${d.r}
TP 🎯: ${d.tpLine}
SL: ${d.sl}
`.trim();
}


// =============================================================
// BUILD AI REPORT (OLD fetchMultiTF STRUCTURE COMPATIBLE)
// =============================================================
export async function buildAIReport(symbol = "BTCUSDT") {
  try {
    const multi = await fetchMultiTF(symbol);

    // OLD STRUCTURE:
    // multi = { price, "1m", "5m", "15m", "30m", "1h" }

    const tfs = ["1m", "5m", "15m", "30m", "1h"];
    let tfObj = {};

    for (const tf of tfs) {
      const d = multi[tf];
      if (!d) continue;

      const rsi = indicators.calcRSI(d);
      const macd = indicators.calcMACD(d);
      const atr = indicators.calcATR(d);
      const vol = indicators.volSignal(d);
      const ell = analyzeElliott(d);

      tfObj[tf] = {
        sig: ell.signalIcon || "⚪",
        rsi: NF(rsi),
        macd: NF(macd),
        atr: NF(atr),
        vol: vol || "N/A",
        ell: ell.pattern || "-",
        ellConf: ell.confidence || 0,
        s: NF(d.support),
        r: NF(d.resistance),
        tps: d.tpList || [],
        sl: NF(d.sl || 0),
      };
    }

    const ml = await runMLPrediction(symbol);
    const micro = await runMicroPrediction(symbol);
    const news = await fetchNewsBundle(symbol);

    return {
      ok: true,
      symbol,
      price: multi.price,
      time: IST(),
      tf: tfObj,
      ml,
      micro,
      news,
    };
  } catch (e) {
    console.log("buildAIReport ERROR:", e.message);
    return { ok: false, error: e.message };
  }
}


// =============================================================
// FORMAT AI REPORT (YOUR EXACT UI)
// =============================================================
export async function formatAIReport(raw) {
  if (!raw || !raw.ok) return "❌ Report failed.";

  const { symbol, price, time, tf, ml, news } = raw;

  const joinTP = (t) => {
    if (!t || !t.length) return "N/A";
    return t.map((v) => NF(v)).join(" / ");
  };

  const block1m = tfBlock("1M", { ...tf["1m"], tpLine: joinTP(tf["1m"]?.tps) });
  const block5m = tfBlock("5M", { ...tf["5m"], tpLine: joinTP(tf["5m"]?.tps) });
  const block15m = tfBlock("15M", { ...tf["15m"], tpLine: joinTP(tf["15m"]?.tps) });
  const block30m = tfBlock("30M", { ...tf["30m"], tpLine: joinTP(tf["30m"]?.tps) });
  const block1h = tfBlock("1H", { ...tf["1h"], tpLine: joinTP(tf["1h"]?.tps) });

  const fusionScore =
    (["1m", "5m", "15m", "30m", "1h"].reduce(
      (a, x) => a + (tf[x]?.sig.includes("BUY") ? 1 : tf[x]?.sig.includes("SELL") ? -1 : 0),
      0
    ));

  const fuseLabel =
    fusionScore > 1 ? "🟢 BUY" :
    fusionScore < -1 ? "🔴 SELL" :
    "⚪ Neutral";

  const buyProb = ((fusionScore + 2.5) / 5) * 100;
  const sellProb = 100 - buyProb;

  return `
🔥 ${symbol} — AI Market Intelligence  
Time (IST): ${time}  
Price: ${NF(price)}
━━━━━━━━━━━━━━━━━━

📊 MULTI-TIMEFRAME PANEL

${block1m}

${block5m}

${block15m}

${block30m}

${block1h}
━━━━━━━━━━━━━━━━━━

🧭 OVERALL BIAS  
Bias: ${fuseLabel}  
Fusion Score: ${fusionScore}  
Buy ${NF(buyProb)}% | Sell ${NF(sellProb)}%
━━━━━━━━━━━━━━━━━━

🤖 MACHINE LEARNING  
Direction: ${ml.direction || "Neutral"}  
Confidence: ${NF(ml.confidence)}%

SELL TP: ${NF(ml.sell_tp)}  
BUY TP: ${NF(ml.buy_tp)}
━━━━━━━━━━━━━━━━━━

📰 NEWS  
Impact: ${news.impact || "Low"}  
Sentiment: ${NF(news.sentiment)}%  
Headline: “${news.headline}”
━━━━━━━━━━━━━━━━━━
`.trim();
}


// =============================================================
// TELEGRAM COMMANDS
// =============================================================
bot.onText(/\/report/, async (msg) => {
  const id = msg.chat.id;
  await safeSend(id, "⏳ Generating AI report...");

  const raw = await buildAIReport("BTCUSDT");
  const html = await formatAIReport(raw);

  await safeSend(id, html);
});

bot.onText(/\/ping/, (msg) => safeSend(msg.chat.id, "🏓 Pong!"));

bot.onText(/\/help/, (msg) =>
  safeSend(
    msg.chat.id,
    `
<b>📘 Commands</b>
/report — Full AI Report  
/ping — Bot Check  
/help — Help Menu  
`.trim()
  )
);


// =============================================================
// EXPORT
// =============================================================
export default {
  bot,
  buildAIReport,
  formatAIReport,
};