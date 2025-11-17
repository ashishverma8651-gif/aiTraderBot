// tg_commands_v10_final.js
// Final production-ready AI Trader TG command (v10 final)
// Exports: buildAIReport(symbol, opts), formatAIReport(report, opts)
// Integrates: elliott_module_v1.3.js, ml_module_v9_0.js, core_indicators.js, utils.js, news_social.js

import CONFIG from "./config.js";
import { fetchMultiTF } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";
import {
  runMLPrediction,
  runMicroPrediction,
  calculateAccuracy,
  recordPrediction,
  recordOutcome
} from "./ml_module_v9_0.js";
import newsModule from "./news_social.js";

// -------------------- Utilities --------------------
const nowISO = () => new Date().toISOString();
const nf = (v, d = 2) => (typeof v === "number" && Number.isFinite(v)) ? Number(v).toFixed(d) : "N/A";
const isNum = n => typeof n === "number" && Number.isFinite(n);
const clamp = (v, lo = -Infinity, hi = Infinity) => Math.max(lo, Math.min(hi, v));
const pctFrom01 = (v) => (isNum(v) ? Math.round(v * 10000) / 100 : null);
const toPct = (v) => { // accept 0..1 or 0..100 -> return 0..100
  if (v == null || Number.isNaN(Number(v))) return null;
  const n = Number(v);
  if (n >= 0 && n <= 1) return Math.round(n * 10000) / 100;
  return Math.round(Math.max(0, Math.min(100, n)) * 100) / 100;
};
const safeObj = (x, fallback = {}) => (x && typeof x === "object") ? x : fallback;
const CR = "\n";

// default TFs & weights
const DEFAULT_TFS = ["1m", "5m", "15m", "30m", "1h"];
const TF_WEIGHTS = { "1m": 0.05, "5m": 0.1, "15m": 0.4, "30m": 0.2, "1h": 0.25 };

// -------------------- Safe indicator wrappers --------------------
function safeRSI(candles) {
  try { return (typeof indicators.computeRSI === "function") ? indicators.computeRSI(candles) : 50; } catch (e) { return 50; }
}
function safeMACD(candles) {
  try { return (typeof indicators.computeMACD === "function") ? indicators.computeMACD(candles) : { hist: 0 }; } catch (e) { return { hist: 0 }; }
}
function safeATR(candles) {
  try { return (typeof indicators.computeATR === "function") ? indicators.computeATR(candles) : 0; } catch (e) { return 0; }
}
function safeVolumeTrend(candles) {
  try { return (typeof indicators.volumeTrend === "function") ? indicators.volumeTrend(candles) : "STABLE"; } catch (e) { return "STABLE"; }
}
function safeFib(candles) {
  try {
    if (typeof indicators.computeFibLevels === "function") return indicators.computeFibLevels(candles);
    if (typeof indicators.computeFibLevelsFromCandles === "function") return indicators.computeFibLevelsFromCandles(candles);
    return null;
  } catch (e) { return null; }
}

// -------------------- Fusion scoring per TF --------------------
function computeFusionScore(indObj = {}, ellObj = {}) {
  try {
    let score = 0;
    let weight = 0;

    const rsi = Number(indObj?.RSI ?? 50);
    score += ((rsi - 50) / 50) * 0.4; weight += 0.4;

    const macdh = Number(indObj?.MACD?.hist ?? 0);
    const atr = Math.max(1, Number(indObj?.ATR ?? 1));
    const macdScore = Math.tanh(macdh / atr);
    score += macdScore * 0.35; weight += 0.35;

    const pt = indObj?.priceTrend === "UP" ? 0.15 : indObj?.priceTrend === "DOWN" ? -0.15 : 0;
    score += pt; weight += 0.15;

    const vt = (indObj?.volumeTrend === "INCREASING") ? 0.08 : (indObj?.volumeTrend === "DECREASING") ? -0.08 : 0;
    score += vt; weight += 0.08;

    const ellSent = Number(ellObj?.sentiment ?? 0);
    const ellConf = clamp(Number(ellObj?.confidence ?? 0) / 100, 0, 1);
    score += ellSent * (0.25 * ellConf);
    weight += 0.25 * ellConf;

    const normalized = Math.max(-1, Math.min(1, score / Math.max(1e-6, weight)));
    return Number(normalized.toFixed(3));
  } catch (e) {
    return 0;
  }
}

function computeOverallFusion(blocks) {
  let s = 0, wsum = 0;
  for (const b of blocks) {
    const score = Number(b.fusionScore ?? 0);
    const w = TF_WEIGHTS[b.tf] ?? 0.1;
    s += score * w; wsum += w;
  }
  const overall = wsum ? s / wsum : 0;
  return Number(clamp(overall, -1, 1).toFixed(3));
}

// -------------------- Buy/Sell combining fusion + ell + ml + news --------------------
function computeBuySellProb(overallFusion, blocks, mlBoost = 0, newsBoost = 0) {
  // overallFusion (-1..1) -> base buy%
  let buy = ((overallFusion + 1) / 2) * 100;
  let sell = 100 - buy;

  // Elliott consensus (weighted)
  let ellSum = 0, ellW = 0;
  for (const b of blocks) {
    const ell = b.ell;
    if (ell && typeof ell.sentiment === "number" && typeof ell.confidence === "number") {
      const conf = clamp(Number(ell.confidence) / 100, 0, 1);
      ellSum += ell.sentiment * conf; ellW += conf;
    }
  }
  const ellAvg = ellW ? (ellSum / ellW) : 0;
  buy += ellAvg * 10;

  // apply mlBoost (range -1..1) scaled into percent space
  buy += (clamp(mlBoost, -1, 1) * 50 * 0.5); // smaller effective weight; tuned
  // apply newsBoost scaled by impact externally (newsBoost already scaled)
  buy += clamp(newsBoost, -1, 1) * 40 * 0.6;

  // re-normalize
  sell = 100 - buy;
  buy = clamp(buy, 0, 100);
  sell = clamp(sell, 0, 100);
  const sum = buy + sell || 1;
  buy = Math.round((buy / sum) * 10000) / 100;
  sell = Math.round((sell / sum) * 10000) / 100;
  return { buy, sell, ellAvg: Number(Number(ellAvg).toFixed(3)) };
}

// -------------------- Target aggregation & selection (TP-2) --------------------
function collectTargets(blocks) {
  const map = new Map(); // key=rounded price -> best candidate
  for (const b of blocks) {
    const tlist = Array.isArray(b.targets) ? b.targets : (b.ell && Array.isArray(b.ell.targets) ? b.ell.targets : []);
    for (const t of tlist) {
      const tp = Number(t.tp ?? t.target ?? t.price ?? 0);
      if (!isNum(tp) || tp <= 0) continue;
      const key = Math.round(tp);
      const conf = clamp(Number(t.confidence ?? b.ell?.confidence ?? 40), 0, 100);
      const existing = map.get(key);
      if (!existing || conf > (existing.confidence || 0)) {
        map.set(key, { tp, confidence: Math.round(conf), source: t.source || b.tf || "Elliott", tf: b.tf });
      }
    }
  }
  return Array.from(map.values()).sort((a, b) => b.confidence - a.confidence);
}

function pickTP2(price, targets, atr) {
  // returns up to 2 longs and 2 shorts (TP1 conservative TP2 aggressive)
  const longs = targets.filter(t => t.tp > price).slice(0, 4); // more candidates
  const shorts = targets.filter(t => t.tp < price).slice(0, 4);

  // prepare fallback ATR-based (conservative/aggressive)
  const fallbackLong = [
    { tp: Number((price + atr * 1.5).toFixed(8)), confidence: 30, source: "AUTO_ATR_CONSERV" },
    { tp: Number((price + atr * 3.0).toFixed(8)), confidence: 20, source: "AUTO_ATR_AGGR" }
  ];
  const fallbackShort = [
    { tp: Number((price - atr * 1.5).toFixed(8)), confidence: 30, source: "AUTO_ATR_CONSERV" },
    { tp: Number((price - atr * 3.0).toFixed(8)), confidence: 20, source: "AUTO_ATR_AGGR" }
  ];

  const pickTop = (arr, count) => {
    if (arr.length >= count) return arr.slice(0, count);
    const need = count - arr.length;
    const fallback = (arr === longs) ? fallbackLong : fallbackShort;
    return arr.concat(fallback.slice(0, need)).slice(0, count);
  };

  return {
    longs: pickTop(longs, 2),
    shorts: pickTop(shorts, 2)
  };
}

// -------------------- Risk / RR calculations & sizing --------------------
function computeRR(entry, tp, sl) {
  if (!isNum(entry) || !isNum(tp) || !isNum(sl)) return null;
  const reward = Math.abs(tp - entry);
  const risk = Math.abs(entry - sl);
  if (risk <= 0) return null;
  return Number((reward / risk).toFixed(3));
}

// approximate quantity sizing (quote denominated)
// riskAmount = accountSize * (riskPct/100)
// quantity (asset units) = riskAmount / |entry - sl|
function computePositionSizing({ accountSize = 0, riskPercent = 1, entry, sl }) {
  if (!isNum(accountSize) || accountSize <= 0) return null;
  if (!isNum(entry) || !isNum(sl)) return null;
  const riskAmount = accountSize * (clamp(riskPercent, 0, 100) / 100);
  const pipRisk = Math.abs(entry - sl);
  if (pipRisk <= 0) return null;
  const qty = riskAmount / pipRisk;
  const exposure = qty * entry;
  return { qty, exposure: Number(exposure.toFixed(2)), riskAmount: Number(riskAmount.toFixed(2)) };
}

// -------------------- Fusion label / emojis --------------------
function fusionLabel(score) {
  if (score >= 0.70) return { label: "STRONG BUY", emoji: "🟩" };
  if (score >= 0.20) return { label: "BUY", emoji: "🟦" };
  if (score > -0.20 && score < 0.20) return { label: "NEUTRAL", emoji: "🟨" };
  if (score <= -0.20 && score > -0.70) return { label: "SELL", emoji: "🟧" };
  return { label: "STRONG SELL", emoji: "🟥" };
}

// -------------------- Confidence bar (10-block) --------------------
function confBar(pct) {
  const v = isNum(pct) ? Math.round(clamp(pct, 0, 100) / 10) : 0;
  const on = "▮".repeat(v);
  const off = "▯".repeat(10 - v);
  return `<code>${on}${off}</code>`;
}

// -------------------- Main builder --------------------
export async function buildAIReport(symbol = "BTCUSDT", opts = {}) {
  // opts: { tfs: [], tpCount: 2, accountSize: number (USD), riskMode: "Conservative"|"Balanced"|"Aggressive", riskPct }
  try {
    const tfs = Array.isArray(opts.tfs) && opts.tfs.length ? opts.tfs : DEFAULT_TFS;
    const tpCount = Number.isInteger(opts.tpCount) && opts.tpCount > 0 ? opts.tpCount : 2;
    const accountSize = (isNum(opts.accountSize) && opts.accountSize > 0) ? opts.accountSize : null;
    const riskMode = (opts.riskMode || "Conservative");
    const customRiskPct = isNum(opts.riskPct) ? clamp(opts.riskPct, 0.1, 20) : null;

    // fetch candles multi-TF
    const mtfRaw = await fetchMultiTF(symbol, tfs);

    // build per-TF blocks
    const blocks = [];
    for (const tf of tfs) {
      const entry = safeObj(mtfRaw[tf], { data: [], price: 0 });
      const candles = Array.isArray(entry.data) ? entry.data : [];
      const price = (isNum(entry.price) && entry.price > 0) ? entry.price : (candles?.at(-1)?.close ?? 0);

      const indicatorsBlock = {
        RSI: safeRSI(candles),
        MACD: safeMACD(candles),
        ATR: safeATR(candles),
        priceTrend: (candles.length >= 2) ? (candles.at(-1).close > candles.at(-2).close ? "UP" : (candles.at(-1).close < candles.at(-2).close ? "DOWN" : "FLAT")) : "FLAT",
        volumeTrend: safeVolumeTrend(candles)
      };

      // run Elliott (defensive)
      let ell = null;
      try { ell = await analyzeElliott(candles); } catch (e) { ell = null; }

      // targets: prefer ell.targets but fallback to computed targets in ell (if present)
      let targets = [];
      if (ell && Array.isArray(ell.targets) && ell.targets.length) {
        targets = ell.targets.map(t => ({ tp: Number(t.tp ?? t.target ?? t.price ?? 0), confidence: Math.round(Number(t.confidence ?? ell.confidence ?? 40)), source: t.source || t.type || tf }));
      } else {
        // allow generateTargets style fallback (ATR)
        const atr = safeATR(candles);
        targets = [
          { tp: Number((price + atr * 3).toFixed(8)), confidence: 30, source: "ATR_UP" },
          { tp: Number((price - atr * 3).toFixed(8)), confidence: 30, source: "ATR_DOWN" }
        ];
      }

      const fib = safeFib(candles);

      blocks.push({
        tf,
        price,
        candles,
        indicators: indicatorsBlock,
        ell: ell && ell.ok ? ell : null,
        targets,
        fib
      });
    }

    // compute fusion per TF
    for (const b of blocks) {
      b.fusionScore = computeFusionScore(b.indicators, b.ell || { sentiment: 0, confidence: 0 });
    }

    // overall fusion
    let overallFusion = computeOverallFusion(blocks);

    // ML predictions (15m + micro)
    let mlMain = null, mlMicro = null, mlAcc = 0;
    try { mlMain = await runMLPrediction(symbol, "15m"); } catch (e) { mlMain = null; }
    try { mlMicro = await runMicroPrediction(symbol, "1m"); } catch (e) { mlMicro = null; }
    try { mlAcc = calculateAccuracy()?.accuracy ?? 0; } catch (e) { mlAcc = 0; }

    // derive mlBoost from mlMain probabilities: bull-bear normalized (-1..1)
    let mlBoost = 0;
    if (mlMain && mlMain.probs) {
      const b = Number(mlMain.probs.bull ?? mlMain.probs.BULL ?? 0);
      const r = Number(mlMain.probs.bear ?? mlMain.probs.BEAR ?? 0);
      if (isNum(b) && isNum(r)) mlBoost = clamp(((b - r) / 100), -1, 1);
    }

    // News
    let news = null;
    try { news = await newsModule.fetchNewsBundle(symbol); } catch (e) { news = { ok: false, sentiment: 0.5, impact: "Low", items: [] }; }
    const newsSent = (news && typeof news.sentiment === "number") ? news.sentiment : 0.5; // 0..1
    const newsRawBoost = ((newsSent - 0.5) * 2); // -1..1
    const impact = (news && typeof news.impact === "string") ? news.impact.toLowerCase() : "low";
    const impactMul = impact === "high" ? 1.0 : impact === "moderate" ? 0.6 : 0.25;
    const newsBoost = clamp(newsRawBoost * impactMul, -1, 1);

    // apply ML & news nudges to overall fusion (weights tuned)
    overallFusion = clamp(overallFusion + mlBoost * 0.25 + newsBoost * 0.25, -1, 1);

    // buy/sell probabilities
    const probs = computeBuySellProb(overallFusion, blocks, mlBoost, newsBoost);

    // aggregate targets
    const allTargets = collectTargets(blocks);
    // use 15m price and ATR as primary
    const primary = blocks.find(b => b.tf === "15m") || blocks[0] || null;
    const price = primary?.price ?? (blocks[0]?.price ?? 0);
    const atr15 = primary?.indicators?.ATR ?? 0;

    const { longs, shorts } = pickTP2(price, allTargets, atr15 || (price * 0.002 || 1));

    // ML-proposed TP integration (take if direction aligned)
    if (mlMain && isNum(mlMain.tpEstimate)) {
      const dir = (mlMain.direction || mlMain.label || "").toString().toLowerCase();
      if (dir.includes("bull") && Number(mlMain.tpEstimate) > price) {
        // put ML TP at top of longs
        longs.unshift({ tp: Number(mlMain.tpEstimate), confidence: Number(mlMain.tpConfidence ?? mlMain.tp_conf ?? 40), source: "ML" });
      } else if (dir.includes("bear") && Number(mlMain.tpEstimate) < price) {
        shorts.unshift({ tp: Number(mlMain.tpEstimate), confidence: Number(mlMain.tpConfidence ?? mlMain.tp_conf ?? 40), source: "ML" });
      }
    }

    // ensure TP arrays length 2
    const sanitizedLongs = longs.slice(0, 2);
    const sanitizedShorts = shorts.slice(0, 2);

    // compute SL defaults (2xATR15) and RR and suggested sizing
    const defaultSLLong = isNum(price) && isNum(atr15) ? Number((price - atr15 * 2).toFixed(8)) : null;
    const defaultSLShort = isNum(price) && isNum(atr15) ? Number((price + atr15 * 2).toFixed(8)) : null;

    const longPlan = sanitizedLongs.map((t, idx) => {
      const entry = price;
      const tp = Number(t.tp);
      const sl = defaultSLLong;
      const rr = computeRR(entry, tp, sl);
      let sizing = null;
      const riskPctMode = customRiskPct ?? (riskMode === "Conservative" ? 1 : (riskMode === "Balanced" ? 1.5 : 2.5));
      if (accountSize && sl != null) sizing = computePositionSizing({ accountSize, riskPercent: riskPctMode, entry, sl });
      return { tp, confidence: t.confidence, source: t.source, rr, sl, sizing };
    });

    const shortPlan = sanitizedShorts.map((t, idx) => {
      const entry = price;
      const tp = Number(t.tp);
      const sl = defaultSLShort;
      const rr = computeRR(entry, tp, sl);
      let sizing = null;
      const riskPctMode = customRiskPct ?? (riskMode === "Conservative" ? 1 : (riskMode === "Balanced" ? 1.5 : 2.5));
      if (accountSize && sl != null) sizing = computePositionSizing({ accountSize, riskPercent: riskPctMode, entry, sl });
      return { tp, confidence: t.confidence, source: t.source, rr, sl, sizing };
    });

    // final bias label
    const bias = fusionLabel(overallFusion);

    // Build report
    const report = {
      ok: true,
      symbol,
      generatedAt: nowISO(),
      tfs: DEFAULT_TFS,
      blocks,
      primaryPrice: price,
      atr15,
      overallFusion,
      bias,
      buyProb: probs.buy,
      sellProb: probs.sell,
      ellConsensus: probs.ellAvg,
      longs: longPlan,
      shorts: shortPlan,
      ml: mlMain,
      micro: mlMicro,
      mlAccuracy: mlAcc,
      news,
      newsBoost,
      mlBoost,
      accountSize,
      riskMode,
      riskPct: customRiskPct ?? (riskMode === "Conservative" ? 1 : (riskMode === "Balanced" ? 1.5 : 2.5))
    };

    return report;
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

// -------------------- Formatter (Premium refined Style-C) --------------------
export async function formatAIReport(report = {}, opts = {}) {
  try {
    if (!report || !report.ok) return `Error generating report: ${report?.error || "invalid_report"}`;

    const price = report.primaryPrice ?? 0;
    const dateStr = new Date(report.generatedAt).toLocaleString('en-IN', { hour12: true });

    const bias = report.bias || { label: "N/A", emoji: "⚪" };

    // Multi TF grid rows
    const tfRows = report.blocks.map(b => {
      const tf = b.tf.padEnd(4);
      const score = (isNum(b.fusionScore) ? b.fusionScore.toFixed(2) : "N/A").toString().padStart(6);
      const rsi = isNum(b.indicators.RSI) ? String(Math.round(b.indicators.RSI)).padStart(3) : " N/A";
      const macdh = isNum(b.indicators.MACD?.hist) ? (b.indicators.MACD.hist > 0 ? "++" : (b.indicators.MACD.hist < 0 ? "--" : "0 ")) : " N/A";
      const trend = (b.indicators.priceTrend || "FLAT").padStart(4);
      const emoji = (b.fusionScore >= 0.7) ? "🟩" : (b.fusionScore >= 0.2) ? "🟦" : (b.fusionScore > -0.2) ? "🟨" : (b.fusionScore > -0.7) ? "🟧" : "🟥";
      const confBar = confBarInline(Math.round((b.fusionScore + 1) / 2 * 100));
      return `${tf} | ${score} | RSI ${rsi} | MACD ${macdh} | ${trend} | ${emoji} ${confBar}`;
    }).join(CR);

    // prepare TP display
    const formatPlan = (arr, side = "LONG") => {
      if (!Array.isArray(arr) || !arr.length) return "N/A";
      return arr.map((p, i) => {
        const tp = nf(p.tp, 2);
        const conf = (p.confidence != null) ? `${p.confidence}%` : "N/A";
        const source = p.source || "Elliott/Auto";
        const rr = p.rr != null ? p.rr : "N/A";
        const sizing = p.sizing ? `Qty:${p.sizing.qty.toFixed(6)} | Exposure:${p.sizing.exposure}` : "Sizing:N/A";
        return `TP${i + 1}: <b>${tp}</b> (${conf}) ${confBarInline(p.confidence)} — RR:${rr} — ${sizing} — src:${source}`;
      }).join(CR);
    };

    // short/long lines
    const longLines = formatPlan(report.longs, "LONG");
    const shortLines = formatPlan(report.shorts, "SHORT");

    // ML text
    let mlText = "N/A";
    if (report.ml && report.ml.probs) {
      const p = report.ml.probs;
      const b = toPct(p.bull ?? p.BULL ?? p.b ?? null);
      const r = toPct(p.bear ?? p.BEAR ?? p.r ?? null);
      const n = toPct(p.neutral ?? p.NEUTRAL ?? p.n ?? null);
      if (b != null && r != null && n != null) mlText = `Bull:${nf(b,2)}% | Bear:${nf(r,2)}% | Neutral:${nf(n,2)}%`;
      else if (isNum(report.ml?.maxProb)) mlText = `Max:${nf(report.ml.maxProb,2)}%`;
    } else if (report.ml && isNum(report.ml?.maxProb)) {
      mlText = `Max:${nf(report.ml.maxProb,2)}%`;
    }

    // news summary
    const news = report.news || { ok: false, sentiment: 0.5, impact: "Low", items: [] };
    const newsSentPct = isNum(news.sentiment) ? Math.round(news.sentiment * 1000) / 10 : "N/A";
    const newsTop = news.items && news.items.length ? (news.items[0].title || news.items[0].text || news.items[0].link || "—") : "—";

    // risk package
    const slLong = report.longs[0] ? report.longs[0].sl : null;
    const slShort = report.shorts[0] ? report.shorts[0].sl : null;

    // final built HTML
    const html = [
      `<b>🔥 ${report.symbol} — AI Market Intelligence (Premium)</b>`,
      `<i>Generated:</i> ${dateStr}`,
      ``,
      `<b>📌 OVERALL MARKET BIAS</b>`,
      `${bias.emoji} <b>${bias.label}</b> `,
      `<code>Bias Score: ${Number(report.overallFusion).toFixed(3)}</code>`,
      `Buy: <b>${report.buyProb}%</b>  |  Sell: <b>${report.sellProb}%</b>  |  Elliott avg: <b>${report.ellConsensus}</b>`,
      ``,
      `<b>📊 PRICE SNAPSHOT (15m)</b>`,
      `Price: <b>${nf(price, 2)}</b>`,
      `ATR(15m): <b>${nf(report.atr15, 4)}</b>  |  Volatility: <b>${report.blocks[0]?.indicators?.volumeTrend || "N/A"}</b>`,
      ``,
      `<b>🎯 TARGETS — LONG (TP-2)</b>`,
      longLines,
      ``,
      `<b>🎯 TARGETS — SHORT (TP-2)</b>`,
      shortLines,
      ``,
      `<b>🧭 MULTI-TIMEFRAME GRID</b>`,
      `<pre>TF   | Score  | RSI | MACD | Trend | Bias+Conf</pre>`,
      `<pre>${tfRows}</pre>`,
      ``,
      `<b>🤖 MACHINE LEARNING (15m)</b>`,
      `Direction: <b>${report.ml?.direction ?? report.ml?.label ?? "N/A"}</b>  |  Probs: <code>${mlText}</code>  |  Historic Acc: <b>${nf(report.mlAccuracy,2)}%</b>`,
      `Micro ML (1m): ${report.micro?.label ?? "N/A"} ${report.micro?.prob ? `(${nf(report.micro.prob,2)}%)` : ""}`,
      ``,
      `<b>📰 NEWS</b>`,
      `Impact: <b>${news.impact || "N/A"}</b>  |  Sentiment: <b>${newsSentPct}%</b>`,
      `Top: ${newsTop}`,
      ``,
      `<b>🎯 ENTRY & RISK PLAN</b>`,
      `LONG entry (example): <b>${nf(price,2)}</b> / Invalidation SL: <b>${nf(slLong,2)}</b> (2×ATR)`,
      `SHORT entry (example): <b>${nf(price,2)}</b> / Invalidation SL: <b>${nf(slShort,2)}</b> (2×ATR)`,
      `Position Sizing Mode: <b>${report.riskMode}</b> — Risk % per trade: <b>${report.riskPct}%</b>`,
      report.accountSize ? `Example sizing uses account: <b>${nf(report.accountSize,2)}</b>` : `To compute sizing pass opts.accountSize`,
      ``,
      `<i>Notes: Fusion = RSI+MACD+ATR+Vol + Elliott consensus. ML & News nudge final bias (ML ~25%, News scaled by impact).</i>`
    ].join(CR);

    return html;
  } catch (e) {
    return `formatAIReport error: ${e?.message || String(e)}`;
  }
}

// Inline conf bar generator used inside tfRows formatting (string-safe)
function confBarInline(pct) {
  const v = isNum(pct) ? Math.round(clamp(pct, 0, 100) / 10) : 0;
  const on = "▮".repeat(v);
  const off = "▯".repeat(10 - v);
  return `${on}${off}`;
}

export default { buildAIReport, formatAIReport };