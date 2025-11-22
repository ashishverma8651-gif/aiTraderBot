// tg_commands.js — ML v15.1 PRO integrated, Old UI intact (Node18+, ESM)

// ---------------- IMPORTS ----------------
import CONFIG from "./config.js";
import ML from "./ml_module_v8_6.js";   // <<-- updated to new ML module
import { fetchMultiTF, fetchMarketData } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";
import NewsModule from "./news_social.js";

/* ----------------- Extract ML v15.1 PRO Exports ----------------- */
const {
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
  buildAIReport: ml_buildAIReport,   // PRO internal builder
  streamingFetchMultiTF,
  batchFetchSymbols,
  registerExternalFetcher,
  enableStreamingMode,
  trimLogs,
  diagnostics
} = ML || {};

/* Safe News accessor */
const fetchNewsBundle =
  (NewsModule && (NewsModule.fetchNewsBundle || (NewsModule.default && NewsModule.default.fetchNewsBundle)))
    ? (NewsModule.fetchNewsBundle || NewsModule.default.fetchNewsBundle)
    : async () => ({ ok: false, sentiment: 0.5, impact: "low", items: [], headline: "No news" });

/* ----------------- Helpers ----------------- */
const MAX_TG_CHARS = 3800;
const IST = { locale: "en-IN", hour12: true, timeZone: "Asia/Kolkata" };
const nf = (v, d = 2) => (typeof v === "number" && Number.isFinite(v)) ? Number(v).toFixed(d) : "N/A";
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const clamp = (v, a = -1, b = 1) => Math.max(a, Math.min(b, v));

function nowIST(iso) {
  try {
    const d = iso ? new Date(iso) : new Date();
    return d.toLocaleString("en-IN", IST);
  } catch {
    return new Date().toString();
  }
}

function splitParts(blocks, lim = MAX_TG_CHARS) {
  const out = [];
  let buf = "";
  for (const b of blocks) {
    if (!b) continue;
    if ((buf + "\n\n" + b).length < lim) {
      buf += (buf ? "\n\n" : "") + b;
    } else {
      if (buf) out.push(buf);
      buf = b;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/* ----------------- stable target canonicalization ----------------- */
function canonicalizeStableTargets(clusterTargets = [], mlFusion = {}, price = 0, feats = {}) {
  try {
    if (typeof buildStableTargets === "function") {
      const out = buildStableTargets(clusterTargets, mlFusion, price, feats);
      if (out && out.primaryTP !== undefined) return out;
    }
  } catch (e) {}

  const priceNum = Number(price || 0);
  const sorted = Array.isArray(clusterTargets)
    ? clusterTargets.slice().sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
    : [];

  const bulls = sorted.filter((s) => s.tp > priceNum);
  const bears = sorted.filter((s) => s.tp < priceNum);
  const dir = (mlFusion?.direction || "Neutral").toLowerCase();

  let primary, hedge;

  if (dir.includes("bull")) {
    primary = bulls[0] || sorted[0];
    hedge = bears[0] || { tp: priceNum - (feats?.atr || priceNum * 0.002), confidence: 30, source: "HEDGE_FALLBACK" };
  } else if (dir.includes("bear")) {
    primary = bears[0] || sorted[0];
    hedge = bulls[0] || { tp: priceNum + (feats?.atr || priceNum * 0.002), confidence: 30, source: "HEDGE_FALLBACK" };
  } else {
    primary = sorted[0] || { tp: priceNum + (feats?.atr || priceNum * 0.002), confidence: 40, source: "FALLBACK" };
    hedge =
      sorted[1] ||
      (sorted[0]
        ? { tp: sorted[0].tp - (feats?.atr || priceNum * 0.002), confidence: 30, source: "HEDGE" }
        : { tp: priceNum - (feats?.atr || priceNum * 0.002), confidence: 30, source: "HEDGE" });
  }

  let primaryTP = Number(primary.tp);
  let hedgeTP = Number(hedge.tp);

  if (
    (primaryTP > priceNum && hedgeTP > priceNum) ||
    (primaryTP < priceNum && hedgeTP < priceNum)
  ) {
    const shift = Math.max(Math.abs(priceNum) * 0.002, feats?.atr || 1);
    if (primaryTP > priceNum) hedgeTP = priceNum - shift;
    else hedgeTP = priceNum + shift;
  }

  return {
    primaryTP,
    hedgeTP,
    primarySource: primary.source || "cluster",
    hedgeSource: hedge.source || "cluster",
    primaryConf: primary.confidence || mlFusion?.confidence || 50,
    direction: mlFusion?.direction || "Neutral"
  };
}

/* ----------------- MAIN: buildAIReport ----------------- */
export async function buildAIReport(symbol = CONFIG.SYMBOL || "BTCUSDT", opts = {}) {
  try {
    if (typeof ml_buildAIReport === "function") {
      try {
        return await ml_buildAIReport(symbol, opts);
      } catch {
        // fallback
      }
    }

    const tfs = opts.tfs?.length ? opts.tfs : ["1m", "5m", "15m", "30m", "1h"];
    const mtf = await fetchMultiTF(symbol, tfs).catch(() => ({}));

    const blocks = [];

    for (const tf of tfs) {
      const raw = mtf[tf] || { data: [], price: 0 };
      const candles = Array.isArray(raw.data) ? raw.data : [];
      const price = Number(raw.price || candles.at(-1)?.close || 0);

      const ind = {
        RSI: indicators.computeRSI?.(candles) ?? 50,
        MACD: indicators.computeMACD?.(candles) ?? { hist: 0 },
        ATR: indicators.computeATR?.(candles) ?? 0,
        priceTrend:
          candles.length >= 2
            ? candles.at(-1).close > candles.at(-2).close
              ? "UP"
              : candles.at(-1).close < candles.at(-2).close
              ? "DOWN"
              : "FLAT"
            : "FLAT",
        volumeTrend: indicators.volumeTrend?.(candles) ?? "STABLE"
      };

      let ell = null;
      try {
        ell = await analyzeElliott(candles);
      } catch {}

      const ellSummary = (() => {
        try {
          const piv = ell?.pivots || [];
          const L = [...piv].reverse().find((p) => p.type === "L");
          const H = [...piv].reverse().find((p) => p.type === "H");
          return {
            support: L?.price ?? null,
            resistance: H?.price ?? null,
            confidence: ell?.confidence ?? 0
          };
        } catch {
          return { support: null, resistance: null, confidence: 0 };
        }
      })();

      let targets = [];
      if (ell?.targets?.length) {
        targets = ell.targets
          .map((t) => ({
            tp: Number(t.tp ?? t.target ?? t.price ?? 0),
            confidence: Math.round(Number(t.confidence ?? ell.confidence ?? 40)),
            source: t.source || t.type || tf
          }))
          .filter((t) => isNum(t.tp) && t.tp > 0);
      } else {
        const fallback = Math.max(ind.ATR || 0, price * 0.002 || 1);
        targets = [
          { tp: price + fallback * 2, confidence: 30, source: "ATR_UP" },
          { tp: price - fallback * 2, confidence: 30, source: "ATR_DOWN" }
        ];
      }

      blocks.push({ tf, price, candles, indicators: ind, ell, ellSummary, targets });
    }

    // local fusion score
    const fusionScoreTF = (ind, ell) => {
      let s = 0,
        w = 0;
      s += ((ind.RSI - 50) / 50) * 0.4; w += 0.4;
      const macd = ind.MACD.hist ?? 0;
      const atr = ind.ATR || 1;
      s += Math.tanh(macd / atr) * 0.35; w += 0.35;
      s += ind.priceTrend === "UP" ? 0.15 : ind.priceTrend === "DOWN" ? -0.15 : 0; w += 0.15;
      s += ind.volumeTrend === "INCREASING" ? 0.08 : ind.volumeTrend === "DECREASING" ? -0.08 : 0; w += 0.08;
      s += ((ell?.confidence ?? 0) / 100) * 0.25 * (ell?.sentiment ?? 0); w += 0.25;
      return clamp(s / w, -1, 1);
    };

    for (const b of blocks) b.fusionScore = fusionScoreTF(b.indicators, b.ell || {});

    const WEIGHTS = { "1m": 0.05, "5m": 0.1, "15m": 0.4, "30m": 0.2, "1h": 0.25 };
    let fuseVal = 0,
      ws = 0;
    for (const b of blocks) {
      const w = WEIGHTS[b.tf] ?? 0.1;
      fuseVal += b.fusionScore * w;
      ws += w;
    }

    let overallFusion = clamp(fuseVal / ws, -1, 1);

    // cluster targets
    const tgtMap = new Map();
    for (const b of blocks) {
      for (const t of b.targets) {
        const k = Math.round(t.tp);
        if (!tgtMap.has(k) || t.confidence > tgtMap.get(k).confidence) tgtMap.set(k, t);
      }
    }
    const allTargets = [...tgtMap.values()].sort((a, b) => b.confidence - a.confidence);

    const price = blocks.find((x) => x.tf === "15m")?.price ?? blocks[0]?.price ?? 0;

    // ML per TF (15m/30m/1h)
    const stableTFs = ["15m", "30m", "1h"];
    const mlPerTF = [];
    for (const tf of stableTFs) {
      try {
        const out = await runMLPrediction(symbol, tf);
        if (out) mlPerTF.push(out);
      } catch {}
    }

    // fuse ML
    let mlFusion = {};
    try {
      if (typeof fuseMLTFs === "function") mlFusion = fuseMLTFs(mlPerTF);
      else {
        let bull = 0,
          bear = 0,
          neutral = 0;
        for (const m of mlPerTF) {
          const d = m.direction?.toLowerCase() || "";
          const p = m.maxProb ?? 50;
          if (d.includes("bull")) bull += p;
          else if (d.includes("bear")) bear += p;
          else neutral += p;
        }
        mlFusion = {
          direction: bull > bear ? "Bullish" : bear > bull ? "Bearish" : "Neutral",
          confidence: Math.round(Math.max(bull, bear, neutral) / (mlPerTF.length || 1))
        };
      }
    } catch {
      mlFusion = { direction: "Neutral", confidence: 0 };
    }

    // nudge fusion by ML
    overallFusion = clamp(overallFusion + (mlFusion.confidence / 100) * 0.2, -1, 1);

    // Stable targets (final)
    const feat15 = blocks.find((b) => b.tf === "15m") || {};
    const stable = canonicalizeStableTargets(allTargets, mlFusion, price, {
      atr: feat15?.indicators?.ATR || 0,
      candles: feat15?.candles
    });

    // pro meters
    const pro = {};
    pro.rebound = computeReboundProbability?.(symbol, blocks) ?? 0;
    pro.exhaustion = computeTrendExhaustion?.(symbol, blocks) ?? 0;
    pro.volCrush = computeVolatilityCrush?.(symbol, blocks) ?? 0;
    pro.pressure = compute30minPressure?.(symbol, blocks) ?? {};

    const mlAcc = calculateAccuracy?.() ?? { accuracy: 0 };
    const news = await fetchNewsBundle(symbol).catch(() => ({
      ok: false,
      sentiment: 0.5,
      impact: "low",
      items: [],
      headline: "No news"
    }));

    return {
      ok: true,
      symbol,
      generatedAt: new Date().toISOString(),
      nowIST: nowIST(),
      price,
      blocks,
      overallFusion,
      stable,
      mlPerTF,
      mlFusion,
      mlAcc,
      proMeters: pro,
      news,
      buyProb: Number((((overallFusion + 1) / 2) * 100).toFixed(2)),
      sellProb: Number((100 - ((overallFusion + 1) / 2) * 100).toFixed(2)),
      defaultSLLong: Number((price - (feat15?.indicators?.ATR || price * 0.005) * 2).toFixed(8)),
      defaultSLShort: Number((price + (feat15?.indicators?.ATR || price * 0.005) * 2).toFixed(8))
    };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/* ----------------- Formatter ----------------- */
export async function formatAIReport(r) {
  if (!r?.ok) return ["❌ ERROR: " + (r?.error || "Unknown")];

  const t = nowIST(r.generatedAt);
  const price = nf(r.price);

  const header = `
🔥 ${r.symbol} — AI Market Intelligence (v15.1 PRO)
🕒 ${t}
💰 Price: ${price}
━━━━━━━━━━━━━━━━━━`;

  function tfBlock(tf) {
    const b = r.blocks?.find((x) => x.tf === tf);
    if (!b) return `🕒 ${tf} — N/A`;

    const s = b.fusionScore;
    const sign =
      s >= 0.7 ? "🟩 STRONG BUY" :
      s >= 0.2 ? "🟦 BUY" :
      s <= -0.7 ? "🟥 STRONG SELL" :
      s <= -0.2 ? "🔴 SELL" :
      "⚪ NEUTRAL";

    const ell = b.ell?.patterns?.[0]?.type || b.ell?.pattern || "N/A";
    const tps = b.targets?.slice(0,3).map(t=>nf(t.tp)).join(" / ");

    return `
🕒 ${tf} — ${sign}
RSI:${nf(b.indicators?.RSI)} | MACD:${nf(b.indicators?.MACD?.hist)}
ATR:${nf(b.indicators?.ATR)} | Vol:${b.indicators?.volumeTrend}
Elliott: ${ell}
TP: ${tps || "N/A"}`;
  }

  const panel = `
📊 MULTI-TF PANEL
${tfBlock("1m")}
${tfBlock("5m")}
${tfBlock("15m")}
${tfBlock("30m")}
${tfBlock("1h")}
━━━━━━━━━━━━━━━━━━`;

  const stable = r.stable || {};

  const stableBlock = `
🎯 AI Stable Targets
Primary TP: ${nf(stable.primaryTP)} (${stable.primarySource})
Hedge TP: ${nf(stable.hedgeTP)} (${stable.hedgeSource})
Conf: ${stable.primaryConf}%
SL: ${r.stable?.direction === "Bullish" ? nf(r.defaultSLLong) : nf(r.defaultSLShort)}
━━━━━━━━━━━━━━━━━━`;

  const pro = r.proMeters || {};

  const proBlock = `
🪄 PRO METERS
Rebound: ${pro.rebound}
Exhaustion: ${pro.exhaustion}
Vol Crush: ${pro.volCrush}
30m Pressure: ${JSON.stringify(pro.pressure)}
━━━━━━━━━━━━━━━━━━`;

  const mlF = r.mlFusion || {};

  const mlBlock = `
🤖 ML Multi-TF (v15.1)
Direction: ${mlF.direction}
Confidence: ${mlF.confidence}%
Accuracy: ${nf(r.mlAcc?.accuracy,0)}%

ML per-TF:
${r.mlPerTF?.map(m => `• ${m.tf}: ${m.direction} | TP:${nf(m.tpEstimate)} | maxProb:${nf(m.maxProb)}`).join("\n") ?? "N/A"}
━━━━━━━━━━━━━━━━━━`;

  const news = r.news || {};

  const newsBlock = `
📰 NEWS
Impact: ${news.impact}
Sentiment: ${Math.round(news.sentiment*100)}%
Headline: “${news.items?.[0]?.title || news.headline || "No major news"}”
━━━━━━━━━━━━━━━━━━`;

  const full = [
    header,
    panel,
    stableBlock,
    proBlock,
    mlBlock,
    newsBlock
  ].join("\n");

  return splitParts([full]);
}

/* ----------------- Sender ----------------- */
export async function sendSplitReport(report, sendFunc) {
  const parts = await formatAIReport(report);
  for (const p of parts) await sendFunc(p);
  return true;
}

/* ----------------- Default Export ----------------- */
export default { buildAIReport, formatAIReport, sendSplitReport };