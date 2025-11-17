// ===============================
// tg_commands.js (FULL FILE PART 1/3)
// ===============================

// --------------------
// Telegram + helpers
// --------------------
import TelegramBot from "node-telegram-bot-api";
import ML from "./ml_module_v8_6.js";
import News from "./news_social.js";
import { analyzeElliott } from "./elliott_module.js";
import { fetchMultiTF, fetchMarketData } from "./utils.js";

const {
  runMLPrediction,
  runMicroPrediction,
  calculateAccuracy,
  recordOutcome,
  recordPrediction
} = ML;

// correct import usage (News is the default export object)
const { fetchNewsBundle } = News;

// Telegram bot
const bot = new TelegramBot(process.env.TG_BOT_TOKEN, { polling: true });

// --------------------
// Generic small helpers
// --------------------
const MAX_TG = 3800;
const CR = "\n";

const NF = (v, d = 2) =>
  (typeof v === "number" && Number.isFinite(v)) ? Number(v).toFixed(d) : "N/A";

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

const ellipsis = (s, n = 120) =>
  (s && s.length > n) ? s.slice(0, n - 1) + "…" : (s || "");

const nowIST = (iso) => {
  try {
    return (iso ? new Date(iso) : new Date()).toLocaleString(
      "en-IN",
      { hour12: true, timeZone: "Asia/Kolkata" }
    );
  } catch (e) {
    return String(iso || new Date());
  }
};

// --------------------
// Auto-split sender
// --------------------
async function safeSend(chatId, text) {
  if (!text) return;
  if (text.length <= MAX_TG) {
    return bot.sendMessage(chatId, text, { parse_mode: "HTML" });
  }
  let i = 0;
  while (i < text.length) {
    const chunk = text.slice(i, i + MAX_TG);
    await bot.sendMessage(chatId, chunk, { parse_mode: "HTML" });
    i += MAX_TG;
  }
}

// --------------------
// Multi-TF panel builder
// EXACT FORMAT: same as screenshot you saved
// --------------------
function renderTFblock(tf, obj) {
  // obj: { rsi, macd, volText, atr, ellPattern, ellConf, s, r, tps[], sl }
  const volIcon = (obj.volText || "").includes("🔼") ? "🔼" : (obj.volText || "").includes("🔽") ? "🔽" : "🔻";

  const tps =
    (obj.tps && obj.tps.length)
      ? obj.tps.map(t => `${NF(t)}`).join(" / ")
      : "N/A";

  return `
🕒 <b>${tf}</b> — ${obj.biasIcon || "⚪"}
RSI ${obj.rsi} | MACD ${obj.macd} | Vol ${volIcon} | ATR ${obj.atr}
Elliott: ${obj.ellPattern} | Conf ${obj.ellConf}%
S: ${obj.s} | R: ${obj.r}
TP 🎯: ${tps}    
SL: ${obj.sl}
  `.trim();
}

// --------------------
// Bias icon selector
// --------------------
function biasIconFrom(direction) {
  if (!direction) return "⚪";
  const d = String(direction).toLowerCase();
  if (d.includes("bull")) return "🟢 BUY";
  if (d.includes("bear")) return "🔴 SELL";
  return "🟡 NEUTRAL";
}

export {
  bot,
  safeSend,
  renderTFblock,
  biasIconFrom,
  NF,
  isNum,
  ellipsis,
  nowIST,
  runMLPrediction,
  runMicroPrediction,
  calculateAccuracy,
  recordOutcome,
  recordPrediction,
  fetchNewsBundle,
  fetchMultiTF,
  fetchMarketData
};

// ===============================
// tg_commands.js (FULL FILE PART 2/3)
// ===============================

// --------------------
// Helper: compute fusion score per TF
// --------------------
function computeFusionScore(indObj = {}, ellObj = {}) {
  try {
    let score = 0, weight = 0;
    const rsi = Number(indObj?.RSI ?? 50);
    score += ((rsi - 50) / 50) * 0.4; weight += 0.4;

    const macdh = Number(indObj?.MACD?.hist ?? 0);
    const atr = Math.max(1, Number(indObj?.ATR ?? 1));
    score += Math.tanh(macdh / atr) * 0.35; weight += 0.35;

    const pt = indObj?.priceTrend === "UP" ? 0.15 : indObj?.priceTrend === "DOWN" ? -0.15 : 0;
    score += pt; weight += 0.15;

    const vt = indObj?.volumeTrend === "INCREASING" ? 0.08 : indObj?.volumeTrend === "DECREASING" ? -0.08 : 0;
    score += vt; weight += 0.08;

    const ellSent = Number(ellObj?.sentiment ?? 0);
    const ellConf = clamp(Number(ellObj?.confidence ?? 0) / 100, 0, 1);
    score += ellSent * (0.25 * ellConf); weight += 0.25 * ellConf;

    if (weight <= 0) return 0;
    return Number(clamp(score / weight, -1, 1).toFixed(3));
  } catch (e) {
    return 0;
  }
}

// --------------------
// collect unique targets across TFs (de-dupe by rounded tp)
// --------------------
function collectTargets(blocks = []) {
  const map = new Map();
  for (const b of blocks) {
    const tlist = Array.isArray(b.targets) ? b.targets : [];
    for (const t of tlist) {
      const tp = Number(t.tp ?? t.target ?? t.price ?? 0);
      if (!isNum(tp) || tp <= 0) continue;
      const key = Math.round(tp);
      const conf = clamp(Number(t.confidence ?? b.ell?.confidence ?? 40), 0, 100);
      const existing = map.get(key);
      if (!existing || conf > (existing.confidence || 0)) {
        map.set(key, { tp, confidence: Math.round(conf), source: t.source || b.tf });
      }
    }
  }
  return Array.from(map.values()).sort((a, b) => b.confidence - a.confidence);
}

// --------------------
// pick TP/SL plans (simple risk defaults)
// --------------------
function pickPlans(price = 0, targets = [], atr = 0, side = "long", maxCount = 2) {
  if (!isNum(price) || price <= 0) return [];
  const longs = targets.filter(t => t.tp > price).slice(0, maxCount);
  const shorts = targets.filter(t => t.tp < price).slice(0, maxCount);

  const chosen = (side === "long") ? longs : shorts;
  return chosen.map(t => {
    const entry = price;
    const tp = Number(t.tp);
    const sl = side === "long" ? Number((price - atr * 2).toFixed(8)) : Number((price + atr * 2).toFixed(8));
    const rr = computeRR(entry, tp, sl);
    return { tp, confidence: t.confidence, source: t.source, sl, rr };
  });
}

function computeRR(entry, tp, sl) {
  if (!isNum(entry) || !isNum(tp) || !isNum(sl)) return null;
  const reward = Math.abs(tp - entry);
  const risk = Math.abs(entry - sl);
  if (risk <= 0) return null;
  return Number((reward / risk).toFixed(3));
}

// --------------------
// MAIN: buildAIReport
// --------------------
export async function buildAIReport(symbol = "BTCUSDT", opts = {}) {
  try {
    const tfs = Array.isArray(opts.tfs) && opts.tfs.length ? opts.tfs : ["1m", "5m", "15m", "30m", "1h"];

    // fetch candles for all TFs
    const mtfRaw = await fetchMultiTF(symbol, tfs);

    // build per-TF blocks
    const blocks = [];
    for (const tf of tfs) {
      const entry = mtfRaw && mtfRaw[tf] ? mtfRaw[tf] : { data: [], price: 0 };
      const candles = Array.isArray(entry.data) ? entry.data : [];
      const price = (isNum(entry.price) && entry.price > 0) ? entry.price : (candles?.at(-1)?.close ?? 0);

      const indicatorsBlock = {
        RSI: (typeof indicators.computeRSI === "function") ? indicators.computeRSI(candles) : 50,
        MACD: (typeof indicators.computeMACD === "function") ? indicators.computeMACD(candles) : { hist: 0, line: 0, signal: 0 },
        ATR: (typeof indicators.computeATR === "function") ? indicators.computeATR(candles) : 0,
        priceTrend: (candles.length >= 2) ? (candles.at(-1).close > candles.at(-2).close ? "UP" : (candles.at(-1).close < candles.at(-2).close ? "DOWN" : "FLAT")) : "FLAT",
        volumeTrend: (typeof indicators.volumeTrend === "function") ? indicators.volumeTrend(candles) : "STABLE"
      };

      // analyze Elliott (safe)
      let ell = null;
      try { ell = await analyzeElliott(candles); } catch (e) { ell = null; }

      // collect targets from ell or fallback to ATR-based
      let targets = [];
      if (ell && Array.isArray(ell.targets) && ell.targets.length) {
        targets = ell.targets.map(t => ({ tp: Number(t.tp ?? t.target ?? t.price ?? 0), confidence: Math.round(Number(t.confidence ?? ell.confidence ?? 40)), source: t.source || t.type || tf }))
                             .filter(t => isNum(t.tp) && t.tp > 0);
      } else {
        const fallbackAtr = Math.max(indicatorsBlock.ATR || 0, price * 0.002 || 1);
        targets = [
          { tp: Number((price + fallbackAtr * 2).toFixed(8)), confidence: 30, source: "ATR_UP" },
          { tp: Number((price - fallbackAtr * 2).toFixed(8)), confidence: 30, source: "ATR_DOWN" }
        ];
      }

      // fib (if available)
      let fib = null;
      try { if (typeof indicators.computeFibLevelsFromCandles === "function") fib = indicators.computeFibLevelsFromCandles(candles); } catch (e) { fib = null; }

      // push block
      blocks.push({
        tf, price, candles, indicators: indicatorsBlock, ell, targets, fib
      });
    } // end TF loop

    // compute fusion scores for each block
    for (const b of blocks) {
      b.fusionScore = computeFusionScore(b.indicators, b.ell || { sentiment: 0, confidence: 0 });
    }

    // overall fusion (weighted)
    const TF_WEIGHTS = { "1m": 0.05, "5m": 0.1, "15m": 0.4, "30m": 0.2, "1h": 0.25 };
    let s = 0, wsum = 0;
    for (const b of blocks) {
      const w = TF_WEIGHTS[b.tf] ?? 0.1;
      s += (b.fusionScore || 0) * w; wsum += w;
    }
    let overallFusion = wsum ? Number(clamp(s / wsum, -1, 1).toFixed(3)) : 0;

    // ML prediction (prefer 15m unless opts.mlTF)
    const mlTF = opts.mlTF || "15m";
    let mlMain = null;
    try { mlMain = await runMLPrediction(symbol, mlTF); } catch (e) { mlMain = null; }

    // micro ML
    let micro = null;
    try { micro = await runMicroPrediction(symbol, "1m"); } catch (e) { micro = null; }

    // news
    let news = null;
    try { news = await fetchNewsBundle(symbol); } catch (e) { news = { ok: false, sentiment: 0.5, impact: "Low", items: [] }; }

    // apply small nudges from ML & news
    let mlBoost = 0, newsBoost = 0;
    if (mlMain && mlMain.probs) {
      const bprob = Number(mlMain.probs.bull ?? 0);
      const rprob = Number(mlMain.probs.bear ?? 0);
      if (isNum(bprob) && isNum(rprob)) mlBoost = clamp((bprob - rprob) / 100, -1, 1);
    }
    if (news && typeof news.sentiment === "number") {
      const raw = clamp((news.sentiment - 0.5) * 2, -1, 1);
      const impact = (news.impact || "low").toLowerCase();
      const mul = impact === "high" ? 1.0 : impact === "moderate" ? 0.6 : 0.25;
      newsBoost = clamp(raw * mul, -1, 1);
    }

    overallFusion = clamp(overallFusion + (mlBoost * 0.22) + (newsBoost * 0.18), -1, 1);

    // collect all unique targets
    const allTargets = collectTargets(blocks);

    // primary block & price selection (15m preferred)
    const primary = blocks.find(b => b.tf === "15m") || blocks[0] || null;
    const price = primary?.price ?? (blocks[0]?.price ?? 0);
    const atr15 = primary?.indicators?.ATR ?? (primary?.ell?.atr ?? (price * 0.005 || 1));

    // split longs & shorts
    const longs = allTargets.filter(t => t.tp > price).slice(0, 4);
    const shorts = allTargets.filter(t => t.tp < price).slice(0, 4);

    // integrate ML tpEstimate if aligned and valid
    if (mlMain && isNum(mlMain.tpEstimate)) {
      const dir = String(mlMain.direction || mlMain.label || "").toLowerCase();
      if ((dir.includes("bull") || dir.includes("long")) && Number(mlMain.tpEstimate) > price) {
        longs.unshift({ tp: Number(mlMain.tpEstimate), confidence: Math.round(mlMain.tpConfidence ?? mlMain.tp_conf ?? mlMain.maxProb ?? 50), source: "ML" });
      } else if ((dir.includes("bear") || dir.includes("short")) && Number(mlMain.tpEstimate) < price) {
        shorts.unshift({ tp: Number(mlMain.tpEstimate), confidence: Math.round(mlMain.tpConfidence ?? mlMain.tp_conf ?? mlMain.maxProb ?? 50), source: "ML" });
      }
    }

    // pick plan examples (top 2 each side)
    const longPlan = pickPlans(price, allTargets, atr15, "long", 2);
    const shortPlan = pickPlans(price, allTargets, atr15, "short", 2);

    // default SLs (2xATR)
    const defaultSLLong = isNum(price) ? Number((price - atr15 * 2).toFixed(8)) : null;
    const defaultSLShort = isNum(price) ? Number((price + atr15 * 2).toFixed(8)) : null;

    // historic ML accuracy
    let mlAcc = 0;
    try { mlAcc = calculateAccuracy()?.accuracy ?? 0; } catch (e) { mlAcc = 0; }

    // final report object
    const report = {
      ok: true,
      symbol,
      generatedAt: new Date().toISOString(),
      nowIST: nowIST(),
      blocks,
      primary,
      price,
      atr15,
      overallFusion,
      bias: fusionLabel(overallFusion),
      buyProb: Number(((overallFusion + 1) / 2 * 100).toFixed(2)),
      sellProb: Number((100 - ((overallFusion + 1) / 2 * 100)).toFixed(2)),
      ellConsensus: (() => {
        let sum = 0, w = 0;
        for (const b of blocks) {
          if (b.ell && typeof b.ell.sentiment === "number" && typeof b.ell.confidence === "number") {
            const conf = clamp(Number(b.ell.confidence) / 100, 0, 1);
            sum += b.ell.sentiment * conf; w += conf;
          }
        }
        return w ? Number((sum / w).toFixed(3)) : 0;
      })(),
      allTargets,
      longs, shorts, longPlan, shortPlan,
      ml: mlMain,
      micro,
      mlAcc,
      news,
      mlBoost,
      newsBoost
    };

    return report;
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

// --------------------
// small helper to produce bias label (same mapping used in saved UI)
// --------------------
function fusionLabel(score) {
  if (!isNum(score)) return { emoji: "⚪", label: "Neutral" };
  if (score >= 0.70) return { emoji: "🟩", label: "STRONG BUY" };
  if (score >= 0.20) return { emoji: "🟦", label: "BUY" };
  if (score > -0.20 && score < 0.20) return { emoji: "⚪", label: "NEUTRAL" };
  if (score <= -0.20 && score > -0.70) return { emoji: "🟧", label: "SELL" };
  return { emoji: "🟥", label: "STRONG SELL" };
}

// =========================================
// tg_commands.js — PART 3 / 3  (FINAL)
// =========================================


// -----------------------------------------
// FORMATTER — EXACT UI YOU SHARED
// -----------------------------------------
export function formatAIReport(report) {
  if (!report || !report.ok) return `❌ Error generating report:\n${report?.error || "Unknown error"}`;

  const {
    symbol, price, nowIST,
    blocks, overallFusion, bias,
    buyProb, sellProb,
    allTargets,
    longPlan, shortPlan,
    ml, micro, mlAcc,
    news
  } = report;

  // HEADER
  let out = `🔥 ${symbol} — AI Market Intelligence\n`;
  out += `Time (IST): ${nowIST}\n`;
  out += `Price: ${comma(price)}\n`;
  out += `━━━━━━━━━━━━━━━━━━\n\n`;

  // MULTI-TIMEFRAME PANEL
  out += `📊 MULTI-TIMEFRAME PANEL\n(Short | Clean | Cluster-Free)\n\n`;

  for (const b of blocks) {
    const ind = b.indicators;
    const ell = b.ell || {};

    const emoji =
      b.fusionScore >= 0.2 ? "🟢 BUY" :
      b.fusionScore <= -0.2 ? "🔴 SELL" :
      "🟡 NEUTRAL";

    out += `🕒 ${b.tf.toUpperCase()} — ${emoji}\n`;
    out += `RSI ${round(ind.RSI)} | MACD ${round(ind.MACD.hist)} | Vol ${volEmoji(ind.volumeTrend)} | ATR ${round(ind.ATR)}\n`;
    out += `Elliott: ${ell.pattern || "N/A"} | Conf ${round(ell.confidence || 0)}%\n`;

    if (ell.support || ell.resistance) {
      out += `S: ${comma(ell.support)} | R: ${comma(ell.resistance)}\n`;
    }

    // TP list (max 3)
    const tps = (b.targets || []).slice(0, 3);
    if (tps.length) {
      const tpStr = tps.map(t => comma(t.tp)).join(" / ");
      out += `TP 🎯: ${tpStr}\n`;
    }

    // SL (2 ATR fallback)
    const sl = ell.sl || b.price - ind.ATR * 2;
    out += `SL: ${comma(sl)}\n\n`;
  }

  out += "━━━━━━━━━━━━━━━━━━\n\n";

  // OVERALL BIAS
  out += `🧭 OVERALL BIAS\n`;
  out += `Bias: ${bias.emoji} ${bias.label}\n`;
  out += `Fusion Score: ${overallFusion}\n`;
  out += `Buy ${buyProb}% | Sell ${sellProb}%\n`;
  out += `━━━━━━━━━━━━━━━━━━\n\n`;

  // OVERALL TARGETS
  const bullishTP = allTargets.filter(t => t.tp > price).slice(0, 3);
  const bearishTP = allTargets.filter(t => t.tp < price).slice(0, 3);

  out += `🎯 OVERALL TP (AI Driven)\n`;
  out += `Bullish TP: ${bullishTP.length ? bullishTP.map(t => comma(t.tp)).join(" / ") : "—"}\n`;
  out += `Bearish TP: ${bearishTP.length ? bearishTP.map(t => comma(t.tp)).join(" / ") : "—"}\n`;
  out += `SL (Neutral Invalidation): ${comma(price)}\n`;
  out += `━━━━━━━━━━━━━━━━━━\n\n`;

  // MACHINE LEARNING BLOCK
  out += `🤖 MACHINE LEARNING FORECAST (AI TP Guarantee Mode)\n`;
  if (ml) {
    out += `Direction: ${dirEmoji(ml.direction)} ${capitalize(ml.direction)}\n`;
    out += `ML Confidence: ${round(ml.maxProb || ml.confidence || 0)}%\n\n`;

    out += `📌 ML Says:\n`;
    out += `"**${ml.maxProb || 0}% probability next target hit hoga**"\n\n`;

    out += `ML Targets:\n`;
    out += `• ML Sell TP: ${comma(ml?.tps?.bear || ml?.tpEstimate || price)}\n`;
    out += `• ML Buy TP (Hedge): ${comma(ml?.tps?.bull || ml?.hedge || price)}\n\n`;
  }

  out += `━━━━━━━━━━━━━━━━━━\n\n`;

  // NEWS IMPACT
  if (news) {
    out += `📰 NEWS IMPACT (Connected to ML)\n`;
    out += `Impact: ${news.impact}\n`;
    out += `Sentiment: ${round((news.sentiment || 0) * 100)}%\n`;

    if (news.items?.length) {
      out += `Headline: *"${news.items[0].title}"*\n`;
    }
    out += `━━━━━━━━━━━━━━━━━━\n\n`;
  }

  return out;
}


// -----------------------------------------
// SENDER — AUTO SPLIT LARGE MESSAGES
// -----------------------------------------
export async function sendSplitMessage(bot, chatId, text) {
  const MAX = 3900;

  if (text.length <= MAX) {
    return bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
  }

  const parts = [];
  for (let i = 0; i < text.length; i += MAX) {
    parts.push(text.substring(i, i + MAX));
  }

  for (const p of parts) {
    await bot.sendMessage(chatId, p, { parse_mode: "Markdown" });
  }
}


// -----------------------------------------
// MAIN BOT COMMANDS
// -----------------------------------------
export function registerTGCommands(bot) {

  // /ai BTCUSDT
  bot.onText(/^\/ai(?:@[\w_]+)?\s*([\w:.-]+)?/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const symbol = (match[1] || "BTCUSDT").toUpperCase();

    await bot.sendMessage(chatId, `⏳ Fetching AI Market Intelligence for **${symbol}** ...`);

    try {
      const report = await buildAIReport(symbol);
      const formatted = formatAIReport(report);
      await sendSplitMessage(bot, chatId, formatted);

      // RECORD ML OUTCOME (optional)
      if (report?.ml) {
        recordPrediction(symbol, report.ml);
      }

    } catch (err) {
      await bot.sendMessage(chatId, `❌ Error: ${err.message}`);
    }
  });


  // /mlstats
  bot.onText(/^\/mlstats/i, async msg => {
    const chatId = msg.chat.id;
    try {
      const acc = calculateAccuracy();
      await bot.sendMessage(chatId,
        `📈 ML Accuracy Stats\n` +
        `Total Predictions: ${acc.total}\n` +
        `Correct: ${acc.correct}\n` +
        `Accuracy: ${round(acc.accuracy * 100)}%`
      );
    } catch (e) {
      await bot.sendMessage(chatId, `❌ Error loading stats`);
    }
  });


  // /news BTC
  bot.onText(/^\/news(?:@[\w_]+)?\s*([\w:.-]+)?/i, async (msg, match) => {
    const chatId = msg.chat.id;
    const symbol = (match[1] || "BTC").toUpperCase();

    await bot.sendMessage(chatId, `⏳ Fetching news for ${symbol} ...`);

    try {
      const news = await fetchNewsBundle(symbol);
      if (!news || !news.items?.length)
        return bot.sendMessage(chatId, "No news found.");

      const n = news.items[0];
      const t = `📰 *${n.title}*\n${n.summary || ""}\nSentiment: ${round(news.sentiment * 100)}%`;
      await bot.sendMessage(chatId, t, { parse_mode: "Markdown" });

    } catch (err) {
      await bot.sendMessage(chatId, `❌ Error: ${err.message}`);
    }
  });
}


// -----------------------------------------
// Helpers
// -----------------------------------------
const comma = x => isNum(x) ? Number(x).toLocaleString("en-IN") : x;
const round = x => isNum(x) ? Math.round(Number(x)) : x;

function volEmoji(v) {
  if (!v) return "—";
  v = v.toUpperCase();
  return v.includes("INC") ? "🔼" :
         v.includes("DEC") ? "🔻" : "🔸";
}

function dirEmoji(d) {
  if (!d) return "⚪";
  d = d.toLowerCase();
  if (d.includes("bear")) return "🔴";
  if (d.includes("bull")) return "🟢";
  return "⚪";
}

const capitalize = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : s;

export default {
  buildAIReport,
  formatAIReport,
  sendSplitReport
};