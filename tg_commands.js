// tg_commands.js — v12 merged & hardened
// Exports: buildAIReport(symbol, opts), formatAIReport(report), sendSplitReport(report, sendTelegramFunc)
// Backwards-compatible with your existing imports and ML/News default export shapes.

import CONFIG from "./config.js";
import ML from "./ml_module_v8_6.js";     // default export object expected (defensive)
import News from "./news_social.js";      // default export object expected (defensive)

import { fetchMultiTF, fetchMarketData } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";

// defensive extraction of ML functions from default export
const {
  runMLPrediction,
  runMicroPrediction,
  calculateAccuracy,
  recordPrediction,
  recordOutcome
} = ML || {};

// defensive extraction of News function
const { fetchNewsBundle } = News || { fetchNewsBundle: async () => ({ ok:false, sentiment:0.5, impact:"low", items:[] }) };

// -------------------- Constants & small helpers --------------------
const MAX_TG_CHARS = 3800; // safe per Telegram (4096) with margin
const IS_INDIA = { locale: "en-IN", hour12: true, timeZone: "Asia/Kolkata" };

const nf = (v, d = 2) => (typeof v === "number" && Number.isFinite(v)) ? Number(v).toFixed(d) : "N/A";
const isNum = v => typeof v === "number" && Number.isFinite(v);
const clamp = (v, a = -Infinity, b = Infinity) => Math.max(a, Math.min(b, v));
const ellipsis = (s, n = 120) => (typeof s === "string" && s.length > n) ? s.slice(0,n-1) + "…" : (s || "");

function nowIST(iso) {
  try {
    const d = iso ? new Date(iso) : new Date();
    if (isNaN(d.getTime())) return new Date().toLocaleString("en-IN", IS_INDIA);
    return d.toLocaleString("en-IN", IS_INDIA);
  } catch (e) {
    return new Date().toString();
  }
}

// split long message into safe parts while keeping logical blocks together
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

// -------------------- Core: buildAIReport --------------------
export async function buildAIReport(symbol = CONFIG.SYMBOL || "BTCUSDT", opts = {}) {
  try {
    const tfs = Array.isArray(opts.tfs) && opts.tfs.length ? opts.tfs : ["1m","5m","15m","30m","1h"];

    // fetch multi-timeframe data
    const mtfRaw = await fetchMultiTF(symbol, tfs);

    const blocks = [];
    for (const tf of tfs) {
      const entry = mtfRaw[tf] || { data: [], price: 0 };
      const candles = Array.isArray(entry.data) ? entry.data : [];
      const price = isNum(entry.price) && entry.price > 0 ? entry.price : (candles?.at(-1)?.close ?? 0);

      // indicators (fallback safe defaults)
      const ind = {
        RSI: (typeof indicators.computeRSI === "function") ? indicators.computeRSI(candles) : 50,
        MACD: (typeof indicators.computeMACD === "function") ? indicators.computeMACD(candles) : { hist: 0 },
        ATR: (typeof indicators.computeATR === "function") ? indicators.computeATR(candles) : 0,
        priceTrend: (candles.length>=2) ? (candles.at(-1).close > candles.at(-2).close ? "UP" : (candles.at(-1).close < candles.at(-2).close ? "DOWN" : "FLAT")) : "FLAT",
        volumeTrend: (typeof indicators.volumeTrend === "function") ? indicators.volumeTrend(candles) : "STABLE",
      };

      // volume analysis
      const vol = (typeof indicators.analyzeVolume === "function") ? indicators.analyzeVolume(candles) : { status: "N/A", strength: 0 };

      // Elliott (safe)
      let ell = null;
      try { ell = await analyzeElliott(candles); } catch (e) { ell = null; }
      const ellSummary = (() => {
        try {
          const pivots = ell?.pivots || [];
          const lastLow = [...pivots].reverse().find(p=>p.type==="L") || null;
          const lastHigh = [...pivots].reverse().find(p=>p.type==="H") || null;
          return { support: lastLow?.price ?? null, resistance: lastHigh?.price ?? null, confidence: ell?.confidence ?? null, patterns: ell?.patterns ?? [] };
        } catch { return { support: null, resistance: null, confidence: null, patterns: [] }; }
      })();

      // targets (from ell or atr fallback)
      let targets = [];
      if (ell && Array.isArray(ell.targets) && ell.targets.length) {
        targets = ell.targets.map(t => ({
          tp: Number(t.tp ?? t.target ?? t.price ?? 0),
          confidence: Math.round(Number(t.confidence ?? ell.confidence ?? 40)),
          source: t.source || t.type || tf,
          ageDays: Number(t.ageDays ?? 0)
        })).filter(t => isNum(t.tp) && t.tp > 0);
      } else {
        const fallbackAtr = Math.max(ind.ATR || 0, price * 0.002 || 1);
        targets = [
          { tp: Number((price + fallbackAtr * 2).toFixed(8)), confidence: 30, source: "ATR_UP" },
          { tp: Number((price - fallbackAtr * 2).toFixed(8)), confidence: 30, source: "ATR_DOWN" }
        ];
      }

      // fib (if available)
      let fib = null;
      try { if (typeof indicators.computeFibLevelsFromCandles === "function") fib = indicators.computeFibLevelsFromCandles(candles); } catch(e){ fib = null; }

      blocks.push({ tf, price, candles, indicators: ind, vol, ell, ellSummary, targets, fib });
    }

    // fusion scoring per block
    const computeFusionScore = (indObj = {}, ellObj = {}) => {
      let s = 0, w = 0;
      const rsi = Number(indObj?.RSI ?? 50);
      s += ((rsi - 50) / 50) * 0.4; w += 0.4;
      const macdh = Number(indObj?.MACD?.hist ?? 0); const atr = Math.max(1, Number(indObj?.ATR ?? 1));
      s += (Math.tanh(macdh / atr) * 0.35); w += 0.35;
      s += (indObj?.priceTrend === "UP" ? 0.15 : indObj?.priceTrend === "DOWN" ? -0.15 : 0); w += 0.15;
      s += (indObj?.volumeTrend === "INCREASING" ? 0.08 : indObj?.volumeTrend === "DECREASING" ? -0.08 : 0); w += 0.08;
      const ellSent = Number(ellObj?.sentiment ?? 0); const ellConf = clamp(Number(ellObj?.confidence ?? 0) / 100, 0, 1);
      s += ellSent * (0.25 * ellConf); w += 0.25 * ellConf;
      if (w === 0) return 0;
      return Number(clamp(s / w, -1, 1).toFixed(3));
    };

    for (const b of blocks) {
      try { b.fusionScore = computeFusionScore(b.indicators, b.ell || { sentiment: 0, confidence: 0 }); } catch (e) { b.fusionScore = 0; }
    }

    // overall fusion weighted
    const TF_WEIGHTS = { "1m": 0.05, "5m": 0.1, "15m": 0.4, "30m": 0.2, "1h": 0.25 };
    let s = 0, ws = 0;
    for (const b of blocks) { const w = TF_WEIGHTS[b.tf] ?? 0.1; s += (b.fusionScore || 0) * w; ws += w; }
    let overallFusion = ws ? Number(clamp(s / ws, -1, 1).toFixed(3)) : 0;

    // collect unique targets across TFs (dedupe by rounded)
    const tgtMap = new Map();
    for (const b of blocks) {
      for (const t of (b.targets || [])) {
        const tp = Number(t.tp || 0); if (!isNum(tp) || tp <= 0) continue;
        const key = Math.round(tp);
        const conf = clamp(Number(t.confidence ?? 40), 0, 100);
        const existing = tgtMap.get(key);
        if (!existing) tgtMap.set(key, { tp, confidence: Math.round(conf), source: t.source || b.tf, ageDays: t.ageDays || 0 });
        else {
          if ((conf > existing.confidence) || ((t.ageDays || 0) < (existing.ageDays || 999) && conf >= existing.confidence)) {
            tgtMap.set(key, { tp, confidence: Math.round(conf), source: t.source || b.tf, ageDays: t.ageDays || 0 });
          }
        }
      }
    }
    const price = blocks.find(x => x.tf === "15m")?.price ?? blocks[0]?.price ?? 0;
    const allTargets = Array.from(tgtMap.values()).sort((a, b) => b.confidence - a.confidence || Math.abs(a.tp - price) - Math.abs(b.tp - price));

    const longs = allTargets.filter(t => t.tp > price).slice(0, 4);
    const shorts = allTargets.filter(t => t.tp < price).slice(0, 4);

    // ML predictions (prefer 15m)
    let mlMain = null;
    try { mlMain = (typeof runMLPrediction === "function") ? await runMLPrediction(symbol, opts.mlTF || "15m") : null; } catch (e) { mlMain = null; }
    let micro = null;
    try { micro = (typeof runMicroPrediction === "function") ? await runMicroPrediction(symbol, "1m") : null; } catch (e) { micro = null; }

    // nudge overallFusion using ML & News (small)
    let mlBoost = 0, newsBoost = 0;
    if (mlMain && mlMain.probs) {
      const bprob = Number(mlMain.probs.bull ?? mlMain.probs?.Bull ?? 0);
      const rprob = Number(mlMain.probs.bear ?? mlMain.probs?.Bear ?? 0);
      if (isNum(bprob) && isNum(rprob)) mlBoost = clamp((bprob - rprob) / 100, -1, 1);
    }
    let news = null;
    try { news = await fetchNewsBundle(symbol); } catch (e) { news = { ok:false, sentiment:0.5, impact:"low", items:[] }; }
    if (news && typeof news.sentiment === "number") {
      const raw = clamp((news.sentiment - 0.5) * 2, -1, 1);
      const impact = (news.impact || "low").toLowerCase();
      const mul = impact === "high" ? 1.0 : impact === "moderate" ? 0.6 : 0.25;
      newsBoost = clamp(raw * mul, -1, 1);
    }
    overallFusion = clamp(overallFusion + (mlBoost * 0.22) + (newsBoost * 0.18), -1, 1);

    // default SL suggestions using 15m ATR if present
    const primary = blocks.find(x => x.tf === "15m") || blocks[0] || null;
    const atr15 = primary?.indicators?.ATR ?? (price * 0.005 || 1);
    const defaultSLLong = isNum(price) ? Number((price - atr15 * 2).toFixed(2)) : null;
    const defaultSLShort = isNum(price) ? Number((price + atr15 * 2).toFixed(2)) : null;

    // ml accuracy
    let mlAcc = 0;
    try { mlAcc = (typeof calculateAccuracy === "function") ? (calculateAccuracy()?.accuracy ?? 0) : 0; } catch (e) { mlAcc = 0; }

    // Compose final report base
    const report = {
      ok: true,
      symbol,
      generatedAt: new Date().toISOString(),
      nowIST: nowIST(),
      blocks,         // array of per-tf blocks
      price,
      atr15,
      overallFusion,
      biasLabel: (() => {
        if (!isNum(overallFusion)) return { emoji: "⚪", label: "Neutral" };
        if (overallFusion >= 0.7) return { emoji: "🟩", label: "Strong Buy" };
        if (overallFusion >= 0.2) return { emoji: "🟦", label: "Buy" };
        if (overallFusion > -0.2 && overallFusion < 0.2) return { emoji: "⚪", label: "Neutral" };
        if (overallFusion <= -0.2 && overallFusion > -0.7) return { emoji: "🟧", label: "Sell" };
        return { emoji: "🟥", label: "Strong Sell" };
      })(),
      longs, shorts, allTargets,
      ml: mlMain, micro,
      mlAcc, news,
      buyProb: Number(((overallFusion + 1) / 2 * 100).toFixed(2)),
      sellProb: Number((100 - ((overallFusion + 1) / 2 * 100)).toFixed(2)),
      defaultSLLong, defaultSLShort
    };

    // --- Post-process ML: sanitize many shapes (old/new/mix) ---
    if (report.ml) {
      try {
        const ml = report.ml;

        // normalize probs if present
        const probs = ml.probs || ml.Probs || ml.P || null;
        const bprob = probs ? Number(probs.bull ?? probs.Bull ?? probs[0] ?? 0) : null;
        const rprob = probs ? Number(probs.bear ?? probs.Bear ?? probs[1] ?? 0) : null;

        // canonical direction
        ml.direction = ml.direction || ml.label || (bprob != null && rprob != null ? (bprob > rprob ? "Bullish" : (rprob > bprob ? "Bearish" : "Neutral")) : ml.direction || "Neutral");

        // candidates for primary TP: many possible keys across versions
        let mlPrimaryTP = (isNum(ml.tpEstimate) ? ml.tpEstimate : (isNum(ml.tp) ? ml.tp : (isNum(ml.tpSell) ? ml.tpSell : (isNum(ml.tpBuy) ? ml.tpBuy : null))));
        // fallback: older names
        mlPrimaryTP = mlPrimaryTP ?? (isNum(ml.tp_estimate) ? ml.tp_estimate : null);

        let mlPrimaryConf = ml.tpConfidence ?? ml.tp_conf ?? ml.tp_confidence ?? ml.tp_confidence_pct ?? ml.tp_conf_pct ?? null;
        mlPrimaryConf = mlPrimaryConf ?? (ml.maxProb ?? null) ?? (ml.confidence ?? null);

        // if primary exists but is on opposite side, ignore
        const dir = String((ml.direction||"Neutral")).toLowerCase();
        if (isNum(mlPrimaryTP)) {
          if (dir.includes("bull") && mlPrimaryTP <= price) mlPrimaryTP = null;
          if (dir.includes("bear") && mlPrimaryTP >= price) mlPrimaryTP = null;
        }

        // helper to pick nearest from report.longs/shorts
        const pickNearestTarget = (side) => {
          const pool = side === "bull" ? report.longs : (side === "bear" ? report.shorts : report.allTargets);
          if (!Array.isArray(pool) || pool.length === 0) return null;
          pool.sort((a,b) => b.confidence - a.confidence || Math.abs(a.tp - price) - Math.abs(b.tp - price));
          return pool[0];
        };

        if (!isNum(mlPrimaryTP)) {
          const pick = pickNearestTarget(dir.includes("bull") ? "bull" : dir.includes("bear") ? "bear" : "bull");
          if (pick) { mlPrimaryTP = pick.tp; mlPrimaryConf = mlPrimaryConf ?? pick.confidence; }
        }

        // pick hedge (opposite-side target)
        let mlHedgeTP = null;
        if (dir.includes("bull")) {
          const pickOpp = pickNearestTarget("bear");
          if (pickOpp) mlHedgeTP = pickOpp.tp;
        } else if (dir.includes("bear")) {
          const pickOpp = pickNearestTarget("bull");
          if (pickOpp) mlHedgeTP = pickOpp.tp;
        } else {
          // neutral: show best long and best short
          const longPick = pickNearestTarget("bull");
          const shortPick = pickNearestTarget("bear");
          if (longPick) mlPrimaryTP = mlPrimaryTP ?? longPick.tp;
          if (shortPick) mlHedgeTP = mlHedgeTP ?? shortPick.tp;
        }

        // Avoid identical Sell/Buy/hedge: if equal or nearly equal, nudge hedge using ATR
        if (isNum(mlPrimaryTP) && isNum(mlHedgeTP) && Math.abs(mlPrimaryTP - mlHedgeTP) < Math.max(1e-6, price * 1e-6)) {
          const offset = Math.max(1, report.atr15 || price * 0.002);
          if (dir.includes("bull")) mlHedgeTP = Number((price - offset * 1.5).toFixed(2));
          else if (dir.includes("bear")) mlHedgeTP = Number((price + offset * 1.5).toFixed(2));
          else mlHedgeTP = null;
        }

        // final sanitize: if primaryTP still null, attempt best available long or short
        if (!isNum(mlPrimaryTP)) {
          const fallbackPick = pickNearestTarget("bull") || pickNearestTarget("bear") || report.allTargets?.[0] || null;
          if (fallbackPick) mlPrimaryTP = fallbackPick.tp;
        }

        // attach sanitized result to ml
        ml.sanitized = {
          direction: ml.direction,
          primaryTP: isNum(mlPrimaryTP) ? Number(mlPrimaryTP) : null,
          primaryConf: isNum(mlPrimaryConf) ? Number(mlPrimaryConf) : null,
          hedgeTP: isNum(mlHedgeTP) ? Number(mlHedgeTP) : null,
          maxProb: ml.maxProb ?? (bprob != null || rprob != null ? Math.max(Number(bprob||0), Number(rprob||0)) : ml.maxProb ?? null)
        };
      } catch (e) {
        // ignore sanitization problems
      }
    }

    // --- Compute Overall TP ranges and Neutral SL robustly ---
    // Bullish TP range: smallest long TP .. largest long TP (all strictly > price)
    let bullRange = null, bearRange = null;
    try {
      const longsOnly = (report.longs || []).filter(t => isNum(t.tp) && t.tp > price).map(t => t.tp);
      const shortsOnly = (report.shorts || []).filter(t => isNum(t.tp) && t.tp < price).map(t => t.tp);

      if (longsOnly.length) bullRange = { lo: Math.min(...longsOnly), hi: Math.max(...longsOnly) };
      if (shortsOnly.length) bearRange = { lo: Math.min(...shortsOnly), hi: Math.max(...shortsOnly) };

      // If ranges missing or inverted, fallback to ATR-based conservative bands
      const fallbackAtr = Math.max(report.atr15 || 0, price * 0.002 || 1);
      if (!bullRange) bullRange = { lo: Number((price + fallbackAtr * 1.3).toFixed(2)), hi: Number((price + fallbackAtr * 3).toFixed(2)) };
      if (!bearRange) bearRange = { lo: Number((price - fallbackAtr * 3).toFixed(2)), hi: Number((price - fallbackAtr * 1.3).toFixed(2)) };

      // ensure bullRange.lo > price (if not, shift)
      if (bullRange.lo <= price) bullRange.lo = Number((price + fallbackAtr * 0.2).toFixed(2));
      if (bearRange.hi >= price) bearRange.hi = Number((price - fallbackAtr * 0.2).toFixed(2));
    } catch (e) {
      const fallbackAtr = Math.max(report.atr15 || 0, price * 0.002 || 1);
      bullRange = { lo: Number((price + fallbackAtr * 1.3).toFixed(2)), hi: Number((price + fallbackAtr * 3).toFixed(2)) };
      bearRange = { lo: Number((price - fallbackAtr * 3).toFixed(2)), hi: Number((price - fallbackAtr * 1.3).toFixed(2)) };
    }

    // Neutral invalidation SL: choose midpoint between default long SL and default short SL if both present,
    // otherwise use defaultSLLong or defaultSLShort or price +/- ATR
    let neutralSL = "N/A";
    if (isNum(report.defaultSLLong) && isNum(report.defaultSLShort)) {
      neutralSL = Number(((report.defaultSLLong + report.defaultSLShort) / 2).toFixed(2));
    } else if (isNum(report.defaultSLLong)) neutralSL = Number(report.defaultSLLong);
    else if (isNum(report.defaultSLShort)) neutralSL = Number(report.defaultSLShort);
    else if (isNum(report.atr15) && isNum(price)) neutralSL = Number((price - report.atr15).toFixed(2));

    // Attach computed ranges to report for formatter convenience
    report._computed = { bullRange, bearRange, neutralSL };

    return report;

  } catch (err) {
    return { ok:false, error: err?.message || String(err) };
  }
}

// -------------------- Formatter: produce the exact UI (no braces) --------------------
export async function formatAIReport(report = {}) {
  try {
    if (!report || !report.ok) return `<b>⚠️ Error building report</b>\n${report?.error || "no data"}`;

    const symbol = report.symbol || "SYMBOL";
    const time = nowIST(report.generatedAt || new Date().toISOString());
    const price = Number(report.price || 0);

    // helper to extract block for a tf
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
      const volTxt = b.vol?.status || (b.indicators?.volumeTrend || "N/A");
      const atr = isNum(b.indicators?.ATR) ? Number(b.indicators.ATR) : "N/A";

      const ellConf = b.ellSummary?.confidence ?? 0;
      const ellShow = (ellConf >= 12 && Array.isArray(b.ellSummary?.patterns) && b.ellSummary.patterns.length) ? b.ellSummary.patterns[0].type : (ellConf >= 12 && b.ell?.pattern ? b.ell.pattern : null);
      const ellText = ellShow ? ellShow : (b.ell && b.ell.pattern ? b.ell.pattern : "No clear wave");

      const S = b.ellSummary?.support ?? (b.fib?.lo ?? null) ?? "N/A";
      const R = b.ellSummary?.resistance ?? (b.fib?.hi ?? null) ?? "N/A";

      const tps = (b.targets || []).slice(0,3).map(t => nf(t.tp,2));
      const tpLine = tps.length ? tps.join(" / ") : "N/A";

      const sl = (b.targets && b.targets[0] && b.targets[0].suggestedSL) ? nf(b.targets[0].suggestedSL,2) : (b.sl ?? "N/A");
      const finalSL = (sl === "N/A") ? (tf === "15m" ? nf(report.defaultSLLong,2) : "N/A") : sl;

      return {
        sig: sigText, rsi, macd, vol: volTxt, atr: nf(atr,2), ell: ellText, ellConf: Math.round(ellConf || 0),
        s: (isNum(S) ? nf(S,2) : (S || "N/A")), r: (isNum(R) ? nf(R,2) : (R || "N/A")),
        tpLine, sl: finalSL, price: nf(b.price,2)
      };
    };

    const b1m = getBlock("1m") || {}, b5m = getBlock("5m") || {}, b15m = getBlock("15m") || {}, b30m = getBlock("30m") || {}, b1h = getBlock("1h") || {};

    // overall bias + fusion
    const finalBias = `${report.biasLabel?.emoji ?? "⚪"} ${report.biasLabel?.label ?? "Neutral"}`;
    const fusionScore = (report.overallFusion != null) ? String(report.overallFusion) : "0";
    const buyProb = nf(report.buyProb,2);
    const sellProb = nf(report.sellProb,2);

    // overall TP (AI Driven) - use computed ranges
    const bullTP1 = report._computed && report._computed.bullRange ? nf(report._computed.bullRange.lo,2) : "N/A";
    const bullTP2 = report._computed && report._computed.bullRange ? nf(report._computed.bullRange.hi,2) : "N/A";
    const bearTP1 = report._computed && report._computed.bearRange ? nf(report._computed.bearRange.lo,2) : "N/A";
    const bearTP2 = report._computed && report._computed.bearRange ? nf(report._computed.bearRange.hi,2) : "N/A";

    const neutralSL = report._computed && report._computed.neutralSL ? nf(report._computed.neutralSL,2) : nf(report.defaultSLLong,2);

    // ML block (sanitized)
    const ml = report.ml || {};
    const mlDir = (ml.sanitized && ml.sanitized.direction) ? ml.sanitized.direction : (ml.direction || ml.label || "Neutral");
    const mlConf = (() => {
      if (ml.sanitized && isNum(ml.sanitized.primaryConf)) return nf(ml.sanitized.primaryConf,0);
      if (ml.tpConfidence != null) return nf(ml.tpConfidence,0);
      if (ml.maxProb != null) return nf(ml.maxProb,0);
      // fallback to sanitized maxProb
      return nf((ml.sanitized && ml.sanitized.maxProb) ? ml.sanitized.maxProb : (ml.maxProb || 0), 0);
    })();

    // ML Targets lines (sanitized)
    const mlPrimaryTP = (ml.sanitized && isNum(ml.sanitized.primaryTP)) ? nf(ml.sanitized.primaryTP,2) : "N/A";
    const mlHedgeTP = (ml.sanitized && isNum(ml.sanitized.hedgeTP)) ? nf(ml.sanitized.hedgeTP,2) : null;

    // Determine how to show ML Sell/Buy TP
    // If direction bullish -> show Buy as primary, Sell as hedge (if available)
    // If direction bearish -> show Sell as primary, Buy as hedge
    let mlSellTP = "N/A", mlBuyTP = "N/A";
    if (String(mlDir || "").toLowerCase().includes("bull")) {
      mlBuyTP = mlPrimaryTP;
      mlSellTP = mlHedgeTP ?? (report.shorts && report.shorts[0] ? nf(report.shorts[0].tp,2) : "N/A");
    } else if (String(mlDir || "").toLowerCase().includes("bear")) {
      mlSellTP = mlPrimaryTP;
      mlBuyTP = mlHedgeTP ?? (report.longs && report.longs[0] ? nf(report.longs[0].tp,2) : "N/A");
    } else {
      // neutral: present best long and best short
      mlBuyTP = (report.longs && report.longs[0]) ? nf(report.longs[0].tp,2) : (mlPrimaryTP !== "N/A" ? mlPrimaryTP : "N/A");
      mlSellTP = (report.shorts && report.shorts[0]) ? nf(report.shorts[0].tp,2) : (mlHedgeTP ?? "N/A");
    }

    // avoid duplicate lines: if buy==sell show single line and hide hedge duplicate
    const duplicateTP = (mlBuyTP === mlSellTP) || (mlHedgeTP && (mlHedgeTP === mlPrimaryTP));
    const showHedge = mlHedgeTP && !duplicateTP;

    const mlQuote = ellipsis((ml.explanation || ml.reason || ml.summary || ml.quote || "AI forecast active"), 280);

    // News
    const news = report.news || {};
    const newsImpact = news.impact || (news.impact === 0 ? "Low" : "Low");
    const newsSentimentPct = (typeof news.sentiment === "number") ? Math.round(news.sentiment * 1000) / 10 : "N/A";
    const headline = (news.items && news.items.length) ? (news.items[0].title || news.items[0].text || news.items[0].link || "—") : (news.headline || "No major events");

    // Build UI exactly as requested (no curly braces)
    const partMain = `
🔥 ${symbol} — AI Market Intelligence
Time (IST): ${time}
Price: ${nf(price,2)}
━━━━━━━━━━━━━━━━━━

📊 MULTI-TIMEFRAME PANEL
(Short | Clean | Cluster-Free)

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

🎯 OVERALL TP (AI Driven)
Bullish TP: ${bullTP1} – ${bullTP2}  
Bearish TP: ${bearTP1} – ${bearTP2}  
SL (Neutral Invalidation): ${neutralSL}
━━━━━━━━━━━━━━━━━━

🤖 MACHINE LEARNING FORECAST (AI TP Guarantee Mode)
Direction: ${mlDir}  
ML Confidence: ${mlConf}%

📌 ML Says:  
“${mlQuote}”

ML Targets:
• ML Sell TP: <b>${mlSellTP}</b>  
• ML Buy TP (Hedge): <b>${mlBuyTP}</b>
${showHedge ? `\n• ML Hedge TP: ${mlHedgeTP}` : ""}
━━━━━━━━━━━━━━━━━━

📰 NEWS IMPACT (Connected to ML)
Impact: ${newsImpact}  
Sentiment: ${newsSentimentPct}%  
Headline: *“${ellipsis(headline,200)}”*
━━━━━━━━━━━━━━━━━━
`.trim();

    // Split into safe parts if too long
    const parts = splitIntoSafeParts([partMain], MAX_TG_CHARS);
    if (parts.length > 1) {
      return parts.map((p,i) => `<b>${symbol} — AI Market Intelligence (Part ${i+1}/${parts.length})</b>\n\n` + p);
    }
    return [partMain];

  } catch (e) {
    return [`<b>formatAIReport error</b>\n${e?.message || String(e)}`];
  }
}

// -------------------- sendSplitReport helper --------------------
// sendTelegramFunc must be async function(text) -> boolean/response
export async function sendSplitReport(report, sendTelegramFunc) {
  try {
    const parts = await formatAIReport(report);
    if (!parts || !parts.length) return false;
    for (let i = 0; i < parts.length; i++) {
      const text = parts[i];
      try {
        await sendTelegramFunc(text);
      } catch (e) {
        // retry once after short wait
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

// default export for aiTraderBot.js
export default {
  buildAIReport,
  formatAIReport,
  sendSplitReport
};