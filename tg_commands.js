// tg_commands.js — FINAL PRODUCTION (integrates ML v9.0, Elliott v1.3, News v3.0)
// Exports: buildAIReport(symbol), formatAIReport(report)
// Helper: sendSplitReport(report, sendTelegramFunc)  -> sends split messages to Telegram safely
//
// Usage (recommended):
//   const report = await buildAIReport("BTCUSDT");
//   await sendSplitReport(report, sendTelegram);  // sendTelegram from aiTraderBot.js
//
// Backwards-compatible minimal usage (not recommended for long messages):
//   const parts = await formatAIReport(report);   // returns array of HTML strings (parts)
//   // if you MUST send single string you can join parts, but risk >3000 char limit.

import { fetchMultiTF, fetchMarketData } from "./utils.js";
import { analyzeElliott } from "./elliott_module.js";
import ML from "./ml_module_v8_6.js";
import News from "./news_social.js";
import * as indicators from "./core_indicators.js";

// ---------------------- Helpers ----------------------
const MAX_TG_CHARS = 3500; // safe ceiling per message (Telegram limit ~4096; leave margin)
const IS_INDIA = { locale: "en-IN", hour12: true, timeZone: "Asia/Kolkata" };

const nf = (v, d = 2) => (typeof v === "number" && Number.isFinite(v)) ? Number(v).toFixed(d) : "N/A";
const isNum = v => typeof v === "number" && Number.isFinite(v);
const clamp = (v, a = -Infinity, b = Infinity) => Math.max(a, Math.min(b, v));
const ellipsis = (s, n=120) => (typeof s === "string" && s.length > n) ? s.slice(0,n-1) + "…" : s;

function nowIST() { return new Date().toLocaleString("en-IN", { hour12: true, timeZone: "Asia/Kolkata" }); }

// safe pick of nested
const pick = (o, path, def = null) => {
  try {
    const parts = path.split(".");
    let cur = o;
    for (const p of parts) {
      if (!cur) return def;
      cur = cur[p];
    }
    return cur ?? def;
  } catch { return def; }
};

// pretty confidence bar
function confBar(pct) {
  const v = Math.max(0, Math.min(100, Math.round(pct)));
  const full = Math.round(v / 10);
  return "▮".repeat(full) + "▯".repeat(10 - full) + ` ${v}%`;
}

// color label by sign (returns emoji + label)
function biasLabel(score) {
  if (!isNum(score)) return { emoji: "⚪", label: "Neutral" };
  if (score >= 0.7) return { emoji: "🟩", label: "Strong Buy" };
  if (score >= 0.2) return { emoji: "🟦", label: "Buy" };
  if (score > -0.2 && score < 0.2) return { emoji: "⚪", label: "Neutral" };
  if (score <= -0.2 && score > -0.7) return { emoji: "🟧", label: "Sell" };
  return { emoji: "🟥", label: "Strong Sell" };
}

// split long HTML into logical sections (by provided blocks)
function splitIntoSafeParts(blocks, maxChars = MAX_TG_CHARS) {
  // blocks = array of strings (HTML). This will merge small blocks until near maxChars.
  const parts = [];
  let cur = "";
  for (const b of blocks) {
    if (!b) continue;
    // if single block itself too big, force-split by paragraphs
    if (b.length >= maxChars) {
      // break by double-newline paragraphs
      const paras = b.split("\n\n");
      for (const p of paras) {
        if ((cur + "\n\n" + p).length < maxChars) {
          cur = cur ? cur + "\n\n" + p : p;
        } else {
          if (cur) { parts.push(cur); cur = ""; }
          if (p.length < maxChars) cur = p;
          else {
            // hard chunk
            for (let i=0;i<p.length;i+=maxChars-100) {
              parts.push(p.slice(i, i + maxChars - 100));
            }
            cur = "";
          }
        }
      }
      continue;
    }

    if ((cur.length + b.length + 4) < maxChars) {
      cur = cur ? cur + "\n\n" + b : b;
    } else {
      if (cur) parts.push(cur);
      cur = b;
    }
  }
  if (cur) parts.push(cur);
  return parts;
}

// ---------------------- Build AI Report (data gatherer) ----------------------
export async function buildAIReport(symbol = "BTCUSDT", opts = {}) {
  try {
    const tfs = Array.isArray(opts.tfs) && opts.tfs.length ? opts.tfs : ["1m","5m","15m","30m","1h"];
    // fetch multi tf data (parallel)
    const mtfRaw = await fetchMultiTF(symbol, tfs);

    const blocks = [];
    for (const tf of tfs) {
      const entry = mtfRaw[tf] || { data: [], price: 0 };
      const candles = Array.isArray(entry.data) ? entry.data : [];
      const price = (isNum(entry.price) && entry.price>0) ? entry.price : (candles?.at(-1)?.close ?? 0);

      const indicatorsBlock = {
        RSI: (typeof indicators.computeRSI === "function") ? indicators.computeRSI(candles) : 50,
        MACD: (typeof indicators.computeMACD === "function") ? indicators.computeMACD(candles) : { hist: 0 },
        ATR: (typeof indicators.computeATR === "function") ? indicators.computeATR(candles) : 0,
        priceTrend: (candles.length>=2) ? (candles.at(-1).close > candles.at(-2).close ? "UP" : (candles.at(-1).close < candles.at(-2).close ? "DOWN" : "FLAT")) : "FLAT",
        volumeTrend: (typeof indicators.volumeTrend === "function") ? indicators.volumeTrend(candles) : "STABLE",
        candles
      };

      // ell
      let ell = null;
      try { ell = await analyzeElliott(candles); } catch (e) { ell = null; }

      // collect targets - module returns ell.targets as {tp,confidence,source}
      let targets = [];
      if (ell && Array.isArray(ell.targets) && ell.targets.length) {
        targets = ell.targets.map(t => ({ tp: Number(t.tp ?? t.target ?? t.price ?? null), confidence: Math.round(Number(t.confidence ?? ell.confidence ?? 40)), source: t.source || t.type || tf }));
      }

      blocks.push({
        tf, price, candles, indicators: indicatorsBlock, ell, targets, fib: pick(ell, "fib", null)
      });
    }

    // compute fusion per tf (simple combination of indicators + ell.sentiment)
    const fuseScore = (ind, ell) => {
      let s = 0, w = 0;
      const rsi = Number(ind?.RSI ?? 50);
      s += ((rsi-50)/50) * 0.4; w += 0.4;
      const macdh = Number(ind?.MACD?.hist ?? 0); const atr = Math.max(1, Number(ind?.ATR ?? 1));
      s += (Math.tanh(macdh/atr) * 0.35); w += 0.35;
      s += (ind?.priceTrend==="UP"?0.15:ind?.priceTrend==="DOWN"?-0.15:0); w += 0.15;
      s += (ind?.volumeTrend==="INCREASING"?0.08:ind?.volumeTrend==="DECREASING"?-0.08:0); w += 0.08;
      const ellSent = Number(ell?.sentiment ?? 0); const ellConf = clamp(Number(ell?.confidence ?? 0)/100,0,1);
      s += ellSent * (0.25 * ellConf); w += 0.25 * ellConf;
      if (w===0) return 0; return Number(clamp(s / w, -1, 1).toFixed(3));
    };

    for (const b of blocks) {
      b.fusionScore = fuseScore(b.indicators, b.ell);
    }

    // overall fusion (weighted)
    const weights = { "1m":0.05, "5m":0.1, "15m":0.4, "30m":0.2, "1h":0.25 };
    let s=0, ws=0;
    for (const b of blocks) { const w = weights[b.tf] ?? 0.1; s += (b.fusionScore || 0) * w; ws += w; }
    const overallFusion = ws ? Number(clamp(s/ws, -1, 1).toFixed(3)) : 0;

    // ML: prefer 15m (but allow opts.tf)
    const mlTF = opts.mlTF || "15m";
    let ml = null;
    try { ml = await ML.runMLPrediction(symbol, mlTF); } catch (e) { ml = null; }

    // micro
    let micro = null;
    try { micro = await ML.runMicroPrediction(symbol, "1m"); } catch (e) { micro = null; }

    // news
    let news = null;
    try { news = await News.fetchNewsBundle(symbol); } catch (e) { news = { ok:false, sentiment:0.5, impact:"Low", items:[] }; }

    // collect global targets from all blocks (de-dup by rounded tp)
    const tgtMap = new Map();
    for (const b of blocks) {
      const tlist = Array.isArray(b.targets) ? b.targets : [];
      for (const tt of tlist) {
        const tp = Number(tt.tp || 0);
        if (!isNum(tp) || tp<=0) continue;
        const key = Math.round(tp);
        const conf = clamp(Number(tt.confidence ?? 40), 0, 100);
        if (!tgtMap.has(key) || conf > (tgtMap.get(key).confidence||0)) {
          tgtMap.set(key, { tp, confidence: Math.round(conf), source: tt.source || b.tf });
        }
      }
    }
    const allTargets = Array.from(tgtMap.values()).sort((a,b)=>b.confidence - a.confidence);

    // split longs/shorts around primary 15m price
    const primary = blocks.find(x => x.tf === "15m") || blocks[0];
    const price = primary?.price ?? 0;
    const longs = allTargets.filter(t => t.tp > price).slice(0, 4);
    const shorts = allTargets.filter(t => t.tp < price).slice(0, 4);

    // compute preferred ML TP insertion if aligned and valid
    if (ml && isNum(ml.tpEstimate)) {
      const dir = (ml.direction || ml.label || "").toString().toLowerCase();
      if ((dir.includes("bull") || dir.includes("long")) && Number(ml.tpEstimate) > price) {
        longs.unshift({ tp: Number(ml.tpEstimate), confidence: Math.round(ml.tpConfidence || ml.tp_conf || ml.maxProb || 50), source: "ML" });
      } else if ((dir.includes("bear") || dir.includes("short")) && Number(ml.tpEstimate) < price) {
        shorts.unshift({ tp: Number(ml.tpEstimate), confidence: Math.round(ml.tpConfidence || ml.tp_conf || ml.maxProb || 50), source: "ML" });
      }
    }

    // entry & risk default SL using 15m atr if present (or primary indicators)
    const atr15 = primary?.indicators?.ATR || primary?.ell?.atr || (price * 0.005 || 1);
    const defaultSLLong = isNum(price) ? Number((price - atr15 * 2).toFixed(8)) : null;
    const defaultSLShort = isNum(price) ? Number((price + atr15 * 2).toFixed(8)) : null;

    // ml accuracy historic
    let mlAcc = 0;
    try { mlAcc = ML.calculateAccuracy()?.accuracy ?? 0; } catch (e) { mlAcc = 0; }

    // compose final object
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
      biasLabel: biasLabel(overallFusion),
      longs, shorts,
      allTargets,
      ml,
      micro,
      mlAcc,
      news
    };

    return report;
  } catch (err) {
    return { ok:false, error: err?.message || String(err) };
  }
}


// ---------------------- Formatter ----------------------
// formatAIReport(report) => returns array of HTML parts (strings).
// You can join them or (prefer) use sendSplitReport(report, sendTelegramFunc)
export async function formatAIReport(report = {}) {
  try {
    if (!report || !report.ok) return [`<b>⚠️ Error building report</b>\n${report?.error || "no data"}`];

    const symbol = report.symbol;
    const when = (new Date(report.generatedAt)).toLocaleString('en-IN', IS_INDIA);
    const price = Number(report.price || 0);

    // Header block (Part 1)
    const header = `<b>🔥 ${symbol} — AI Market Intelligence</b>\nTime (IST): <b>${when}</b>\nPrice: <b>${nf(price,2)}</b>\n━━━━━━━━━━━━━━━━━━`;

    // Multi-TF block (compact)
    const tfLines = report.blocks.map(b => {
      const tf = b.tf.toUpperCase();
      const rsi = isNum(b.indicators.RSI) ? Math.round(b.indicators.RSI) : "N/A";
      const macdh = isNum(b.indicators.MACD?.hist) ? Math.round(b.indicators.MACD.hist) : 0;
      const vol = b.indicators.volumeTrend || "N/A";
      const atr = isNum(b.indicators.ATR) ? nf(b.indicators.ATR,2) : "N/A";
      const sR = (() => {
        const sup = (b.ell && b.ell.pivots && b.ell.pivots.slice().reverse().find(p=>p.type==="L"))?.price;
        const res = (b.ell && b.ell.pivots && b.ell.pivots.slice().reverse().find(p=>p.type==="H"))?.price;
        if (sup || res) return `S ${sup?nf(sup,2):"N/A"} | R ${res?nf(res,2):"N/A"}`;
        if (b.fib) return `Fib ${nf(b.fib.lo,2)}-${nf(b.fib.hi,2)}`;
        return "S/R N/A";
      })();
      // ell short summary
      const ellPat = (b.ell && b.ell.patterns && b.ell.patterns.length) ? `${b.ell.patterns[0].type} (${Math.round(b.ell.patterns[0].confidence||0)}%)` : "No major";
      const emoji = (b.fusionScore >= 0.7) ? "🔴" : (b.fusionScore >= 0.2) ? "🟩" : (b.fusionScore > -0.2) ? "⚪" : "🟦";

      return `<b>${tf}</b> ${emoji} | RSI ${rsi} | MACD ${macdh} | Vol ${vol} | ATR ${atr}\nPrice ${nf(b.price,2)} | ${sR}\nElliott: ${ellPat}`;
    }).join("\n\n");

    // Overall bias block
    const biasEmoji = report.biasLabel?.emoji || "⚪";
    const biasText = report.biasLabel?.label || "Neutral";
    const biasBlock = `\n━━━━━━━━━━━━━━━━━━\n<b>🧭 OVERALL BIAS</b>\nBias: ${biasEmoji} <b>${biasText}</b>\nFusion Score: <b>${report.overallFusion}</b>\n━━━━━━━━━━━━━━━━━━`;

    // Overall TPs (combined)
    const longTPs = (report.longs && report.longs.length) ? report.longs.map((t,i) => `• TP${i+1}: <b>${nf(t.tp,2)}</b>  (${t.source || "Elliott/ML"})`).join("\n") : "n/a";
    const shortTPs = (report.shorts && report.shorts.length) ? report.shorts.map((t,i) => `• TP${i+1}: <b>${nf(t.tp,2)}</b>  (${t.source || "Elliott/ML"})`).join("\n") : "n/a";
    const overallTPBlock = `<b>🎯 OVERALL TP (Both Sides)</b>\n<b>Bullish:</b>\n${longTPs}\n\n<b>Bearish:</b>\n${shortTPs}\nSL (Neutral invalidation): <b>${ nf(report.primary ? (report.primary.indicators?.ATR ? (report.price - (report.primary.indicators.ATR*2)) : (report.price - report.atr15*2)) : report.atr15,2) }</b>`;

    // ML Block
    const ml = report.ml || {};
    let mlProbs = "N/A";
    if (ml.probs) mlProbs = `Bull: ${nf(ml.probs.bull,2)}% | Bear: ${nf(ml.probs.bear,2)}% | Neutral: ${nf(ml.probs.neutral,2)}%`;
    else if (isNum(ml.maxProb)) mlProbs = `Max: ${nf(ml.maxProb,2)}%`;

    const mlDirEmoji = (String(ml.direction||"").toLowerCase().includes("bull")) ? "🔴" : (String(ml.direction||"").toLowerCase().includes("bear")) ? "🟦" : "⚪";
    const mlTP = isNum(ml.tpEstimate) ? `<b>${nf(ml.tpEstimate,2)}</b> (${ml.tpSource||"ML"})` : "N/A";
    const mlBlock = `<b>🤖 MACHINE LEARNING (15m)</b>\nDirection: ${mlDirEmoji} <b>${ml.direction||ml.label||"N/A"}</b>\nConfidence (historic): <b>${nf(report.mlAcc,2)}%</b>\nProbabilities: <code>${mlProbs}</code>\nML TP: ${mlTP}\nExplanation: ${ ellipsis(ml.explanation || (ml.reason || "—"), 300) }`;

    // News block
    const news = report.news || { sentiment:0.5, impact:"Low", items:[] };
    const newsPct = (typeof news.sentiment === "number") ? Math.round(news.sentiment*1000)/10 : "N/A";
    const newsTop = (news.items && news.items.length) ? (news.items[0].title || news.items[0].text || news.items[0].link || "—") : "—";
    const newsBlock = `<b>📰 NEWS IMPACT</b>\nImpact: <b>${news.impact || "Low"}</b> | Sentiment: <b>${newsPct}%</b>\nTop: ${ellipsis(newsTop, 200)}`;

    // Entry & risk plan block
    const slLong = report.longs && report.longs[0] ? (report.longs[0].sl ?? report.longs[0].sL ?? null) : null;
    const slShort = report.shorts && report.shorts[0] ? (report.shorts[0].sl ?? report.shorts[0].sL ?? null) : null;
    const entryRiskBlock = `<b>🎯 ENTRY & RISK PLAN</b>\nLONG (example) Entry: <b>${nf(price,2)}</b> | Invalidation SL: <b>${ nf(slLong ?? (price - report.atr15*2),2) }</b> (2×ATR)\nSHORT (example) Entry: <b>${nf(price,2)}</b> | Invalidation SL: <b>${ nf(slShort ?? (price + report.atr15*2),2) }</b> (2×ATR)\nPosition Sizing Mode: <b>Conservative</b> — Risk % per trade: <b>1%</b>\nSizing examples: (if account size provided call computePositionSizing)`;

    // Summary block
    const summaryBlock = `<b>📝 SUMMARY</b>\nAI Bias: ${report.biasLabel.emoji} <b>${report.biasLabel.label}</b>\nBuy: <b>${nf( ( (report.overallFusion+1)/2 )*100 ,2 )}%</b>  |  Sell: <b>${nf(100 - ( (report.overallFusion+1)/2 )*100,2)}%</b>\nML Adj. Confidence: <b>${nf(report.mlAcc,2)}%</b>`;

    // Build parts in logical order to allow clean splitting
    const parts = [
      header,
      `<b>📊 MULTI-TIMEFRAME PANEL</b>\n${tfLines}`,
      biasBlock,
      overallTPBlock,
      mlBlock,
      newsBlock,
      entryRiskBlock,
      summaryBlock,
      `<i>AI Engine — Elliott + Fusion + ML integrated</i>`
    ];

    // Use split helper to ensure each part <= MAX_TG_CHARS
    const safeParts = splitIntoSafeParts(parts, MAX_TG_CHARS);

    // Append part counters if multiple parts
    if (safeParts.length > 1) {
      return safeParts.map((p,i) => `<b>${symbol} — AI Market Intelligence (Part ${i+1}/${safeParts.length})</b>\n\n` + p);
    }
    return safeParts;

  } catch (e) {
    return [`<b>formatAIReport error</b>\n${e?.message || String(e)}`];
  }
}


// ---------------------- Sending helper (recommended) ----------------------
/*
  sendSplitReport(report, sendTelegramFunc)

  - report: object returned by buildAIReport()
  - sendTelegramFunc: async function(text) { ... }  // must send HTML message to Telegram and return true/false

  Example (in aiTraderBot.js):
    const report = await buildAIReport(CONFIG.SYMBOL);
    await sendSplitReport(report, sendTelegram);

  This will:
   - call formatAIReport(report) to get array of HTML parts
   - send each part via sendTelegramFunc sequentially, with 600ms gap
*/
export async function sendSplitReport(report, sendTelegramFunc) {
  try {
    const parts = await formatAIReport(report);
    if (!parts || !parts.length) return false;
    for (let i=0;i<parts.length;i++) {
      const text = parts[i];
      try {
        await sendTelegramFunc(text);
      } catch (e) {
        // try once more after short sleep
        await new Promise(r => setTimeout(r, 600));
        try { await sendTelegramFunc(text); } catch {}
      }
      // small gap to avoid flood restrictions
      if (i < parts.length - 1) await new Promise(r => setTimeout(r, 600));
    }
    return true;
  } catch (e) {
    return false;
  }
}


// ---------------------- Exports ----------------------
export default {
  buildAIReport,
  formatAIReport,
  sendSplitReport
};