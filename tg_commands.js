// ===============================================
// 🔥 Telegram Command Handler (Full AI + ML v15)
// ===============================================

import TelegramBot from "node-telegram-bot-api";
import {
  buildAIReport,
  runMLPrediction,
  runMicroPrediction,
  buildStableTargets,
  fuseMLTFs
} from "./ml_module_v15.js";

import { analyzeElliott } from "./elliott_module.js";
import { fetchNewsBundle } from "./news_social.js";
import { fetchMultiTF } from "./utils.js";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const SYMBOL = "BTCUSDT";

// ------------------------------------------------
// 🧩 Helper: Format AI Blocks
// ------------------------------------------------
function formatTFBlock(b) {
  const e = b.ellSummary || {};
  const ind = b.indicators || {};

  const color = b.fusionScore >= 0.2 ? "🟦 BUY"
              : b.fusionScore <= -0.2 ? "🟥 SELL"
              : "⚪ NEUTRAL";

  return `
🕒 ${b.tf} — ${color}
RSI ${ind.RSI} | MACD ${ind.MACD?.hist ?? 0} | ATR ${ind.ATR}
S: ${e.support ?? "N/A"} | R: ${e.resistance ?? "N/A"}
TP 🎯: ${b.targets?.slice(0,3).map(t=>t.tp).join(" / ") || "N/A"}
`;
}

// ------------------------------------------------
// 🧩 Helper — Pro Meters
// ------------------------------------------------
function formatProMeters(p) {
  return `
🪄 PRO METERS
Rebound probability: ${p.rebound}%
Trend exhaustion: ${p.exhaustion}%
Volatility crush: ${p.volCrush}%
30-min pressure:
• Sell Pressure: ${p.pressure.sellPressurePct}%
• Buy Ratio (1m): ${p.pressure.buyRatio1}
• Buy Ratio (5m): ${p.pressure.buyRatio5}
• CVD Score: ${p.pressure.cvdScore}
• EMA Bear Align: ${p.pressure.emaAlignBear}
• OB Pressure: ${p.pressure.obPressure}
`;
}

// ------------------------------------------------
// 🧩 Helper — ML Summary
// ------------------------------------------------
function formatML(ml) {
  const f = ml.fusion || {};
  const per = ml.perTF || [];

  return `
🤖 MACHINE LEARNING (v15)
Direction (fused): ${f.direction}
Confidence: ${f.confidence}%

${per.map(p=>`• ${p.tf}: ${p.direction} | TP:${p.tp} | conf:${p.maxProb}`).join("\n")}
`;
}

// ------------------------------------------------
// 🧩 Helper — Stable Targets
// ------------------------------------------------
function formatStable(st) {
  return `
🎯 STABLE TARGETS
Primary TP: ${st.primaryTP} (${st.primarySource})
Hedge TP: ${st.hedgeTP} (${st.hedgeSource})
Confidence: ${st.primaryConf}%
`;
}

// ------------------------------------------------
// 🧩 BASE COMMAND: /ai — Full AI Report
// ------------------------------------------------
bot.onText(/\/ai/, async (msg) => {
  const chatId = msg.chat.id;

  bot.sendMessage(chatId, "⏳ Generating full AI report...");

  try {
    const r = await buildAIReport(SYMBOL);

    // MAIN TF PANEL
    const panel = r.blocks.map(b => formatTFBlock(b)).join("\n");

    // STABLE TARGETS
    const stable = formatStable(r.stableTargets);

    // ML
    const ml = formatML(r.ml);

    // PRO
    const pro = formatProMeters(r.proMeters);

    // NEWS
    const n = r.news || {};
    const newsTxt = `
📰 NEWS IMPACT
Impact: ${n.impact ?? "Low"}
Sentiment: ${(n.sentiment*100).toFixed(1)}%
Headline: *${n.headline || "No news"}*
`;

    const txt = `
🔥 ${SYMBOL} — AI Market Intelligence
Time (IST): ${r.nowIST}
Price: ${r.price}
━━━━━━━━━━━━━━━━━━

📊 MULTI-TIMEFRAME PANEL
${panel}
━━━━━━━━━━━━━━━━━━

🧭 OVERALL BIAS
Bias: ${r.biasLabel.emoji} ${r.biasLabel.label}
Fusion Score: ${r.overallFusion}
Buy ${r.buyProb}% | Sell ${r.sellProb}%
━━━━━━━━━━━━━━━━━━

${stable}
${ml}
${pro}
${newsTxt}
`;

    bot.sendMessage(chatId, txt, { parse_mode: "Markdown" });

  } catch(e) {
    bot.sendMessage(chatId, `❌ Error\n${e.message}`);
  }
});

// ------------------------------------------------
// /ml — ML-only fused prediction
// ------------------------------------------------
bot.onText(/\/ml/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "⏳ Running ML v15 prediction...");

  try {
    const r15 = await runMLPrediction(SYMBOL, "15m");
    const r30 = await runMLPrediction(SYMBOL, "30m");
    const r1h = await runMLPrediction(SYMBOL, "1h");

    const fusion = fuseMLTFs([r15, r30, r1h]);

    const txt = `
🤖 ML FUSED PREDICTION — v15

Direction: *${fusion.direction}*
Confidence: *${fusion.confidence}%*

15m: ${r15.direction} | TP ${r15.tpEstimate}
30m: ${r30.direction} | TP ${r30.tpEstimate}
1h: ${r1h.direction} | TP ${r1h.tpEstimate}
`;

    bot.sendMessage(chatId, txt, { parse_mode: "Markdown" });

  } catch(e) {
    bot.sendMessage(chatId, `ML ERROR: ${e.message}`);
  }
});

// ------------------------------------------------
// /micro — 1m micro ML
// ------------------------------------------------
bot.onText(/\/micro/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const r = await runMicroPrediction(SYMBOL, "1m");

    const txt = `
⚡ MICRO ML (1m)
Direction: *${r.label}*
Confidence: *${r.prob}%*
Bull: ${r.probBull}% | Bear: ${r.probBear}%
`;

    bot.sendMessage(chatId, txt, { parse_mode: "Markdown" });

  } catch(e) {
    bot.sendMessage(chatId, "Micro ML Error: " + e.message);
  }
});

// ------------------------------------------------
// /tp — Stable Targets only
// ------------------------------------------------
bot.onText(/\/tp/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "⏳ Calculating stable TP...");

  try {
    const r = await buildAIReport(SYMBOL);
    bot.sendMessage(chatId, formatStable(r.stableTargets));
  } catch(e) {
    bot.sendMessage(chatId, e.message);
  }
});

// ------------------------------------------------
// /news — News sentiment
// ------------------------------------------------
bot.onText(/\/news/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const n = await fetchNewsBundle(SYMBOL);

    const txt = `
📰 NEWS
Impact: ${n.impact}
Sentiment: ${(n.sentiment*100).toFixed(1)}%
Headline: *${n.headline}*
`;

    bot.sendMessage(chatId, txt, { parse_mode:"Markdown" });

  } catch(e) {
    bot.sendMessage(chatId, "News Error: " + e.message);
  }
});

// ------------------------------------------------
// /elliott — Elliott pivots
// ------------------------------------------------
bot.onText(/\/ell/i, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const mtf = await fetchMultiTF(SYMBOL, ["15m"]);
    const candles = mtf["15m"].data;
    const ell = await analyzeElliott(candles);

    bot.sendMessage(chatId,
`📐 Elliott
Pattern: ${ell.pattern}
Confidence: ${ell.confidence}%
Targets: ${ell.targets?.map(t=>t.tp).join(" / ")}
`);

  } catch(e) {
    bot.sendMessage(chatId, "Elliott Error: " + e.message);
  }
});

// ------------------------------------------------
// /pro — Pro meters only
// ------------------------------------------------
bot.onText(/\/pro/, async (msg) => {
  const chatId = msg.chat.id;

  try {
    const r = await buildAIReport(SYMBOL);
    bot.sendMessage(chatId, formatProMeters(r.proMeters));
  } catch(e) {
    bot.sendMessage(chatId, "Pro Meter Error: " + e.message);
  }
});

console.log("🔥 tg_commands.js loaded successfully!");