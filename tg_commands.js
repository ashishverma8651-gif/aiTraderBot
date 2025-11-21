// tg_commands.js — Telegram formatting module (integrated with ml_module_v12_precision_pro.js V12 Precision Pro)
// Exports: buildAIReport, formatAIReport, sendSplitReport

import CONFIG from "./config.js";
import {
  runMLPrediction,
  runMicroPrediction,
  calculateAccuracy,
  recordPrediction,
  recordOutcome,
  markOutcome,
  getStats,
  trainAdaptive,
  resetStats,
  computeReboundProbability,
  computeTrendExhaustion,
  computeVolatilityCrush,
  compute30minPressure,
  fuseMLTFs,
  buildStableTargets,
  buildAIReport as mlBuildAIReport
} from "./ml_module_v8_6.js";
import News from "./news_social.js";
import { fetchMultiTF } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";

const fetchNewsBundle = (News && (News.fetchNewsBundle || (News.default && News.default.fetchNewsBundle)))
  ? (News.fetchNewsBundle || News.default.fetchNewsBundle)
  : async (s) => ({ ok:false, sentiment:0.5, impact:"low", items:[], headline:"No news" });

const MAX_TG_CHARS = 3800;
const IS_INDIA = { locale: "en-IN", hour12: true, timeZone: "Asia/Kolkata" };
const nf = (v,d=2) => (typeof v === "number" && Number.isFinite(v)) ? Number(v).toFixed(d) : "N/A";
const isNum = v => typeof v === "number" && Number.isFinite(v);
const clamp = (v,a=-Infinity,b=Infinity) => Math.max(a, Math.min(b, v));
const ellipsis = (s,n=120) => (typeof s === "string" && s.length > n) ? s.slice(0,n-1) + "…" : (s || "");

function nowIST(iso) {
  try {
    const d = iso ? new Date(iso) : new Date();
    return d.toLocaleString("en-IN", IS_INDIA);
  } catch (e) { return new Date().toString(); }
}

function splitIntoSafeParts(blocks, maxChars = MAX_TG_CHARS) {
  const parts = [];
  let cur = "";
  for (const b of blocks) {
    if (!b) continue;
    if (b.length >= maxChars) {
      const paras = b.split("\n\n");
      for (const p of paras) {
        if ((cur.length + p.length + 2) < maxChars) {
          cur = cur ? cur + "\n\n" + p : p;
        } else {
          if (cur) { parts.push(cur); cur = ""; }
          if (p.length < maxChars) cur = p;
          else {
            for (let i = 0; i < p.length; i += (maxChars - 200)) {
              parts.push(p.slice(i, i + maxChars - 200));
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

// Reuse helper fuseMLTFs & buildStableTargets from ML module if you want to override; otherwise, we imported them.

// -----------------------------
// Build AI Report (wrapper around ML's buildAIReport with extra meters)
// -----------------------------
export async function buildAIReport(symbol = CONFIG.SYMBOL || "BTCUSDT", opts = {}) {
  try {
    // Prefer the ML module's buildAIReport if available
    if (typeof mlBuildAIReport === "function") {
      const report = await mlBuildAIReport(symbol, opts);
      // compute meters from blocks if possible (meters return objects)
      try {
        const b15 = (report.blocks || []).find(b => b.tf === "15m") || null;
        const b5 = (report.blocks || []).find(b => b.tf === "5m") || null;
        const b1 = (report.blocks || []).find(b => b.tf === "1m") || null;
        const snapshot = {
          symbol,
          tfs: {
            "1m": b1 ? b1.candles : [],
            "5m": b5 ? b5.candles : [],
            "15m": b15 ? b15.candles : []
          },
          orderbook: opts.orderbook || null,
          tickerPrice: report.price || (b15?.price || b5?.price || b1?.price || 0),
          news: report.news || null
        };
        // compute meters using ML exports (they're synchronous)
        try { report.reboundMeter = computeReboundProbability(snapshot); } catch (e) { report.reboundMeter = null; }
        try { report.trendExhaustion = computeTrendExhaustion({ candles15m: snapshot.tfs["15m"], candles30m: (report.blocks||[]).find(b=>b.tf==="30m")?.candles || [] }); } catch (e) { report.trendExhaustion = null; }
        try { report.volCrush = computeVolatilityCrush({ candles30m: (report.blocks||[]).find(b=>b.tf==="30m")?.candles || [], candles15m: snapshot.tfs["15m"] }); } catch (e) { report.volCrush = null; }
        try { report.pressure30m = compute30minPressure({ candles1m: snapshot.tfs["1m"], candles5m: snapshot.tfs["5m"], candles30m: (report.blocks||[]).find(b=>b.tf==="30m")?.candles || [], orderflow: opts.orderflow || null, orderbook: opts.orderbook || null }); } catch (e) { report.pressure30m = null; }
      } catch (e) {
        // non-fatal; continue
      }
      return report;
    }

    // Fallback: if mlBuildAIReport not available, build report using local logic + runMLPrediction
    // (This fallback mirrors previous tg_commands behavior)
    const tfs = Array.isArray(opts.tfs) && opts.tfs.length ? opts.tfs : ["1m","5m","15m","30m","1h"];
    const mtfRaw = await fetchMultiTF(symbol, tfs);
    const blocks = [];

    for (const tf of tfs) {
      const entry = mtfRaw[tf] || { data: [], price: 0 };
      const candles = Array.isArray(entry.data) ? entry.data : [];
      const price = isNum(entry.price) && entry.price > 0 ? entry.price : (candles?.at(-1)?.close ?? 0);
      const ind = {
        RSI: (typeof indicators.computeRSI === "function") ? indicators.computeRSI(candles) : 50,
        MACD: (typeof indicators.computeMACD === "function") ? indicators.computeMACD(candles) : { hist: 0 },
        ATR: (typeof indicators.computeATR === "function") ? indicators.computeATR(candles) : 0,
        priceTrend: (candles.length >= 2) ? (candles.at(-1).close > candles.at(-2).close ? "UP" : (candles.at(-1).close < candles.at(-2).close ? "DOWN" : "FLAT")) : "FLAT",
        volumeTrend: (typeof indicators.volumeTrend === "function") ? indicators.volumeTrend(candles) : "STABLE"
      };
      let ell = null;
      try { ell = await analyzeElliott(candles); } catch (e) { ell = null; }
      const ellSummary = (() => {
        try {
          const pivots = ell?.pivots || [];
          const lastLow = [...pivots].reverse().find(p => p.type === "L") || null;
          const lastHigh = [...pivots].reverse().find(p => p.type === "H") || null;
          return { support: lastLow?.price ?? null, resistance: lastHigh?.price ?? null, confidence: ell?.confidence ?? null };
        } catch { return { support: null, resistance: null, confidence: null }; }
      })();

      let targets = [];
      if (ell && Array.isArray(ell.targets) && ell.targets.length) {
        targets = ell.targets.map(t => ({ tp: Number(t.tp ?? t.target ?? t.price ?? 0), confidence: Math.round(Number(t.confidence ?? ell.confidence ?? 40)), source: t.source || t.type || tf })).filter(t => isNum(t.tp) && t.tp > 0);
      } else {
        const fallbackAtr = Math.max(ind.ATR || 0, price * 0.002 || 1);
        targets = [
          { tp: Number((price + fallbackAtr * 2).toFixed(8)), confidence: 30, source: "ATR_UP" },
          { tp: Number((price - fallbackAtr * 2).toFixed(8)), confidence: 30, source: "ATR_DOWN" }
        ];
      }
      blocks.push({ tf, price, candles, indicators: ind, ell, ellSummary, targets });
    }

    // run ML for 15m/30m/1h
    const mlTFs = ["15m","30m","1h"];
    const mlResults = [];
    for (const mt of mlTFs) {
      try { const mlr = await runMLPrediction(symbol, mt); if (mlr) mlResults.push(mlr); } catch (e) {}
    }
    let micro1m = null, micro5m = null;
    try { micro1m = await runMicroPrediction(symbol, "1m"); } catch {}
    try { micro5m = await runMicroPrediction(symbol, "5m"); } catch {}

    const mlFusion = fuseMLTFs(mlResults);
    const feat15 = blocks.find(b => b.tf === "15m") ? { atr: blocks.find(b => b.tf === "15m").indicators.ATR, candles: blocks.find(b => b.tf === "15m").candles } : {};
    const tgtMap = new Map();
    for (const b of blocks) for (const t of (b.targets||[])) { const tp = Number(t.tp||0); if (!isNum(tp)||tp<=0) continue; const key=Math.round(tp); const conf=clamp(Number(t.confidence||40),0,100); if(!tgtMap.has(key)||conf>(tgtMap.get(key).confidence||0)) tgtMap.set(key,{tp,confidence:Math.round(conf),source:t.source||b.tf}); }
    const allTargets = Array.from(tgtMap.values()).sort((a,b)=>b.confidence-a.confidence);
    const price = blocks.find(x=>x.tf==="15m")?.price ?? blocks[0]?.price ?? 0;
    const stableTargets = buildStableTargets(allTargets, mlFusion, price, feat15);

    // compute news
    let news = null;
    try { news = await fetchNewsBundle(symbol); } catch (e) { news = { ok:false, sentiment:0.5, impact:"low", items:[], headline:"No news" }; }
    const rawNewsSent = typeof news.sentiment === "number" ? news.sentiment : 0.5;
    const newsBoost = clamp((rawNewsSent - 0.5) * 2, -1, 1) * (String((news.impact||"low")).toLowerCase() === "high" ? 1.0 : 0.4);

    // compute overallFusion (simple)
    const TF_WEIGHTS = { "1m":0.05, "5m":0.08, "15m":0.4, "30m":0.22, "1h":0.25 };
    let sTotal=0, ws=0;
    for (const b of blocks) { const fusion = (()=>{ const rsi = Number(b.indicators?.RSI||50); const macdh = Number(b.indicators?.MACD?.hist||0); const atr = Math.max(1, Number(b.indicators?.ATR||1)); let s=0; s += ((rsi-50)/50)*0.4; s += (Math.tanh(macdh/atr)*0.35); s += (b.indicators?.priceTrend==="UP"?0.15:(b.indicators?.priceTrend==="DOWN"?-0.15:0)); s += (b.indicators?.volumeTrend==="INCREASING"?0.08:(b.indicators?.volumeTrend==="DECREASING"?-0.08:0)); return clamp(s, -1, 1); })(); const w = TF_WEIGHTS[b.tf] ?? 0.1; sTotal += fusion * w; ws += w; }
    let overallFusion = ws ? Number(clamp(sTotal/ws + (mlFusion?.confidence ? (mlFusion.confidence/100)*0.18 : 0) + newsBoost*0.12, -1, 1).toFixed(3)) : 0;

    // meters (fallback compute using imported meters)
    const snapshot = {
      symbol,
      tfs: {
        "1m": blocks.find(b=>b.tf==="1m")?.candles || [],
        "5m": blocks.find(b=>b.tf==="5m")?.candles || [],
        "15m": blocks.find(b=>b.tf==="15m")?.candles || []
      },
      orderbook: opts.orderbook || null,
      tickerPrice: price,
      news
    };
    let reboundMeter = null, exhaustion = null, volCrush = null, pressure30m = null;
    try { reboundMeter = computeReboundProbability({ candles1m: snapshot.tfs["1m"], candles5m: snapshot.tfs["5m"], candles15m: snapshot.tfs["15m"], orderbook: snapshot.orderbook, tickerPrice: snapshot.tickerPrice, news: snapshot.news }); } catch (e) {}
    try { exhaustion = computeTrendExhaustion({ candles15m: snapshot.tfs["15m"], candles30m: blocks.find(b=>b.tf==="30m")?.candles || [] }); } catch (e) {}
    try { volCrush = computeVolatilityCrush({ candles30m: blocks.find(b=>b.tf==="30m")?.candles || [], candles15m: snapshot.tfs["15m"] }); } catch (e) {}
    try { pressure30m = compute30minPressure({ candles1m: snapshot.tfs["1m"], candles5m: snapshot.tfs["5m"], candles30m: blocks.find(b=>b.tf==="30m")?.candles || [], orderflow: opts.orderflow || null, orderbook: snapshot.orderbook || null }); } catch (e) {}

    const mlAccObj = calculateAccuracy();
    const report = {
      ok: true,
      symbol,
      generatedAt: new Date().toISOString(),
      nowIST: nowIST(),
      blocks,
      price,
      atr15: blocks.find(x=>x.tf==="15m")?.indicators?.ATR ?? (price*0.005||1),
      overallFusion,
      biasLabel: (() => {
        if (!isNum(overallFusion)) return { emoji:"⚪", label:"Neutral" };
        if (overallFusion >= 0.7) return { emoji:"🟩", label:"Strong Buy" };
        if (overallFusion >= 0.2) return { emoji:"🟦", label:"Buy" };
        if (overallFusion > -0.2 && overallFusion < 0.2) return { emoji:"⚪", label:"Neutral" };
        if (overallFusion <= -0.2 && overallFusion > -0.7) return { emoji:"🟧", label:"Sell" };
        return { emoji:"🟥", label:"Strong Sell" };
      })(),
      longs: allTargets.filter(t=>t.tp>price).slice(0,4),
      shorts: allTargets.filter(t=>t.tp<price).slice(0,4),
      allTargets,
      ml: { perTF: mlResults, fusion: mlFusion },
      micro: { "1m": micro1m, "5m": micro5m },
      stableTargets,
      mlAcc: mlAccObj,
      news,
      buyProb: Number(((overallFusion + 1)/2 * 100).toFixed(2)),
      sellProb: Number((100 - ((overallFusion + 1)/2 * 100)).toFixed(2)),
      defaultSLLong: isNum(price) ? Number((price - (blocks.find(x=>x.tf==="15m")?.indicators?.ATR ?? price*0.005)*2).toFixed(8)) : null,
      defaultSLShort: isNum(price) ? Number((price + (blocks.find(x=>x.tf==="15m")?.indicators?.ATR ?? price*0.005)*2).toFixed(8)) : null,
      // meters
      reboundMeter, trendExhaustion: exhaustion, volCrush, pressure30m
    };

    return report;

  } catch (err) {
    return { ok:false, error: err?.message || String(err) };
  }
}

// -----------------------------
// Format AI Report into Telegram-ready pieces
// -----------------------------
export async function formatAIReport(report = {}) {
  try {
    if (!report || !report.ok) return `<b>⚠️ Error building report</b>\n${report?.error || "no data"}`;

    const symbol = report.symbol || "SYMBOL";
    const time = nowIST(report.generatedAt || new Date().toISOString());
    const price = Number(report.price || 0);

    const getBlock = (tf) => {
      const b = (report.blocks || []).find(x => x.tf === tf);
      if (!b) return null;
      const fusion = Number(b.fusionScore ?? 0);
      let sigText = "⚪ NEUTRAL";
      if (fusion >= 0.7) sigText = "🟩 STRONG BUY";
      else if (fusion >= 0.2) sigText = "🟦 BUY";
      else if (fusion <= -0.2 && fusion > -0.7) sigText = "🔴 SELL";
      else if (fusion <= -0.7) sigText = "🔴🔴 STRONG SELL";
      const rsi = isNum(b.indicators?.RSI) ? Math.round(b.indicators.RSI) : "N/A";
      const macd = isNum(b.indicators?.MACD?.hist) ? Math.round(b.indicators.MACD.hist) : 0;
      const volTxt = b.indicators?.volumeTrend || "N/A";
      const atr = isNum(b.indicators?.ATR) ? Number(b.indicators.ATR) : "N/A";
      const ellPat = (b.ell && Array.isArray(b.ell.patterns) && b.ell.patterns.length) ? b.ell.patterns[0].type : (b.ell?.pattern || "No major");
      const ellConf = (b.ell && (b.ell.confidence != null)) ? Math.round(b.ell.confidence) : (b.ellSummary?.confidence != null ? Math.round(b.ellSummary.confidence) : 0);
      const S = b.ellSummary?.support ?? "N/A";
      const R = b.ellSummary?.resistance ?? "N/A";
      const tps = (b.targets || []).slice(0,3).map(t => nf(t.tp,2));
      const tpLine = tps.length ? tps.join(" / ") : "N/A";
      const sl = "N/A";
      return { sig: sigText, rsi, macd, vol: volTxt, atr, ell: ellPat, ellConf, s: (isNum(S) ? nf(S,2) : (S || "N/A")), r: (isNum(R) ? nf(R,2) : (R || "N/A")), tpLine, sl, price: nf(b.price,2) };
    };

    const b1m = getBlock("1m") || {}, b5m = getBlock("5m") || {}, b15m = getBlock("15m") || {}, b30m = getBlock("30m") || {}, b1h = getBlock("1h") || {};

    const finalBias = `${report.biasLabel?.emoji ?? "⚪"} ${report.biasLabel?.label ?? "Neutral"}`;
    const fusionScore = (report.overallFusion != null) ? String(report.overallFusion) : "0";
    const buyProb = nf(report.buyProb, 2);
    const sellProb = nf(report.sellProb, 2);

    const stable = report.stableTargets || {};
    const stablePrimary = isNum(stable.primaryTP) ? nf(stable.primaryTP, 2) : "N/A";
    const stableHedge = isNum(stable.hedgeTP) ? nf(stable.hedgeTP, 2) : "N/A";
    const stableConf = stable.primaryConf ?? (report.ml?.fusion?.confidence ?? 0);

    const ml = report.ml || {};
    const mlPerTF = ml.perTF || [];
    const mlFusion = ml.fusion || {};
    const mlDir = mlFusion.direction || "Neutral";
    const mlConf = mlFusion.confidence ?? (mlPerTF[0]?.maxProb ?? 0);
    const mlAccObj = report.mlAcc || 0;
    const mlAcc = (typeof mlAccObj === "object") ? (mlAccObj.accuracy ?? 0) : (isNum(mlAccObj) ? mlAccObj : 0);

    const news = report.news || {};
    const newsImpact = news.impact || "Low";
    const newsSentimentPct = (typeof news.sentiment === "number") ? Math.round(news.sentiment * 1000) / 10 : "N/A";
    const headline = (news.items && news.items.length) ? (news.items[0].title || news.items[0].text || news.items[0].link || "—") : (news.headline || "No major events");

    // meters formatting
    const rebound = report.reboundMeter ? `${report.reboundMeter.reboundProb}%` : "N/A";
    const reboundBreak = report.reboundMeter ? JSON.stringify(report.reboundMeter.breakdown) : "";
    const exhaustion = report.trendExhaustion ? `${report.trendExhaustion.exhaustionPct}%` : "N/A";
    const exhaustionBreak = report.trendExhaustion ? JSON.stringify(report.trendExhaustion.breakdown) : "";
    const volCrush = report.volCrush ? `${report.volCrush.volCrush}%` : "N/A";
    const volCrushBreak = report.volCrush ? JSON.stringify(report.volCrush.breakdown) : "";
    const pressure = report.pressure30m ? (report.pressure30m.sellPct ? `Sell:${Math.round(report.pressure30m.sellPct)}%` : JSON.stringify(report.pressure30m)) : "N/A";

    // ML textual summary (slope/mom3/rsi) if present
    const mlQuote = (() => {
      const best = mlPerTF.find(x => x && x.explanation && x.explanation.features);
      if (best) {
        const f = best.explanation.features || {};
        return `slope:${nf(f.slope,4)} | mom3:${nf(f.mom3,4)} | rsi:${nf(f.rsi,2)}`;
      }
      return "AI forecast active";
    })();

    const partMain = `
🔥 ${symbol} — AI Market Intelligence
Time (IST): ${time}
Price: ${nf(price,2)}
━━━━━━━━━━━━━━━━━━

📊 MULTI-TIMEFRAME PANEL
(Short | Clean | Cluster-Fusion)

🕒 1M — ${b1m.sig || "N/A"}
RSI ${b1m.rsi || "N/A"} | MACD ${b1m.macd || "N/A"} | Vol ${b1m.vol || "N/A"} | ATR ${b1m.atr || "N/A"}
Elliott: ${b1m.ell || "N/A"} | Conf ${b1m.ellConf || 0}%
S: ${b1m.s || "N/A"} | R: ${b1m.r || "N/A"}
TP 🎯: ${b1m.tpLine || "N/A"}  
SL: ${b1m.sl || "N/A"}

🕒 5M — ${b5m.sig || "N/A"}
RSI ${b5m.rsi || "N/A"} | MACD ${b5m.macd || "N/A"} | Vol ${b5m.vol || "N/A"} | ATR ${b5m.atr || "N/A"}
Elliott: ${b5m.ell || "N/A"} | Conf ${b5m.ellConf || 0}%
S: ${b5m.s || "N/A"} | R: ${b5m.r || "N/A"}
TP 🎯: ${b5m.tpLine || "N/A"}  
SL: ${b5m.sl || "N/A"}

🕒 15M — ${b15m.sig || "N/A"}
RSI ${b15m.rsi || "N/A"} | MACD ${b15m.macd || "N/A"} | Vol ${b15m.vol || "N/A"} | ATR ${b15m.atr || "N/A"}
Elliott: ${b15m.ell || "N/A"} | ${b15m.ellConf || 0}%
S: ${b15m.s || "N/A"} | R: ${b15m.r || "N/A"}
TP 🎯: ${b15m.tpLine || "N/A"}  
SL: ${b15m.sl || "N/A"}

🕒 30M — ${b30m.sig || "N/A"}
RSI ${b30m.rsi || "N/A"} | MACD ${b30m.macd || "N/A"} | Vol ${b30m.vol || "N/A"} | ATR ${b30m.atr || "N/A"}
Elliott: ${b30m.ell || "N/A"} | ${b30m.ellConf || 0}%
S: ${b30m.s || "N/A"} | R: ${b30m.r || "N/A"}
TP 🎯: ${b30m.tpLine || "N/A"}

🕒 1H — ${b1h.sig || "N/A"}
RSI ${b1h.rsi || "N/A"} | MACD ${b1h.macd || "N/A"} | Vol ${b1h.vol || "N/A"} | ATR ${b1h.atr || "N/A"}
Elliott: ${b1h.ell || "N/A"} | ${b1h.ellConf || 0}%
S: ${b1h.s || "N/A"} | R: ${b1h.r || "N/A"}
TP 🎯: ${b1h.tpLine || "N/A"}
━━━━━━━━━━━━━━━━━━

🧭 OVERALL BIAS
Bias: ${finalBias}  
Fusion Score: ${fusionScore}  
Buy ${buyProb}% | Sell ${sellProb}%
━━━━━━━━━━━━━━━━━━

🎯 STABLE AI TP (Fused 15m+30m+1h)
Primary TP: <b>${stablePrimary}</b> (src:${stable.primarySource || "Cluster/ML"})  
Hedge TP: <b>${stableHedge}</b> (src:${stable.hedgeSource || "Cluster/ML"})  
Confidence: ${stableConf}%
Suggested SL: ${report.stableTargets && report.stableTargets.direction === "Bullish" ? (report.defaultSLLong ? nf(report.defaultSLLong,2) : "N/A") : (report.defaultSLShort ? nf(report.defaultSLShort,2) : "N/A")}
━━━━━━━━━━━━━━━━━━

🧪 PRO METERS
Rebound probability: ${rebound}  
Trend exhaustion: ${exhaustion}  
Volatility crush: ${volCrush}  
30-min pressure: ${pressure}
━━━━━━━━━━━━━━━━━━

🤖 MACHINE LEARNING (per-TF + fused)
Direction (fused): ${mlDir}  
ML fused confidence: ${mlConf}%  
ML accuracy (history): ${nf(mlAcc,0)}%

ML quick summary:
“${mlQuote}”

ML per-TF snapshot:
${(mlPerTF.length ? mlPerTF.map(m => `${m.tf}: ${m.direction||m.label||"N"} | TP:${isNum(m.tpEstimate)?nf(m.tpEstimate,2):"N/A"} | maxProb:${nf(m.maxProb,0)}`).join("\n") : "No ML outputs")}
━━━━━━━━━━━━━━━━━━

📰 NEWS IMPACT
Impact: ${newsImpact}  
Sentiment: ${newsSentimentPct}%  
Headline: *“${ellipsis(headline,200)}”*
━━━━━━━━━━━━━━━━━━
`.trim();

    const parts = splitIntoSafeParts([partMain], MAX_TG_CHARS);
    if (parts.length > 1) {
      return parts.map((p,i) => `<b>${symbol} — AI Market Intelligence (Part ${i+1}/${parts.length})</b>\n\n` + p);
    }
    return [partMain];

  } catch (e) {
    return [`<b>formatAIReport error</b>\n${e?.message || String(e)}`];
  }
}

// -----------------------------
// Send split report via provided send function
// -----------------------------
export async function sendSplitReport(report, sendTelegramFunc) {
  try {
    const parts = await formatAIReport(report);
    if (!parts || !parts.length) return false;
    for (let i=0;i<parts.length;i++) {
      const text = parts[i];
      try { await sendTelegramFunc(text); } catch (e) {
        await new Promise(r => setTimeout(r, 600));
        try { await sendTelegramFunc(text); } catch {}
      }
      if (i < parts.length - 1) await new Promise(r => setTimeout(r, 650));
    }
    return true;
  } catch (e) {
    return false;
  }
}

export default { buildAIReport, formatAIReport, sendSplitReport };