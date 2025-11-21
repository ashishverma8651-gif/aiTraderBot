// tg_commands.js — FINAL (ML v13 Integrated, Old UI intact, Node18-safe)

// ------------------- Imports -------------------
import CONFIG from "./config.js";
import ML from "./ml_module_v13.js";      // <<<<<< ML v13 Ultra Precision
import News from "./news_social.js";

import { fetchMultiTF, fetchMarketData } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";

// ML v13 exports
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
  buildStableTargets
} = ML;

// News export
const { fetchNewsBundle } = News;

// ------------------- Helpers -------------------
const MAX_TG_CHARS = 3800;
const IST = { locale: "en-IN", hour12: true, timeZone: "Asia/Kolkata" };

const nf = (v, d = 2) =>
  typeof v === "number" && Number.isFinite(v) ? Number(v).toFixed(d) : "N/A";

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
    if ((buf + "\n\n" + b).length < lim) buf += (buf ? "\n\n" : "") + b;
    else {
      if (buf) out.push(buf);
      buf = b;
    }
  }
  if (buf) out.push(buf);
  return out;
}

// ------------------- MAIN: Build AI Report -------------------
export async function buildAIReport(symbol = CONFIG.SYMBOL || "BTCUSDT", opts = {}) {
  try {
    const tfs = opts.tfs?.length ? opts.tfs : ["1m", "5m", "15m", "30m", "1h"];

    const mtf = await fetchMultiTF(symbol, tfs);

    const blocks = [];

    for (const tf of tfs) {
      const raw = mtf[tf] || { data: [], price: 0 };
      const candles = raw.data || [];
      const price = raw.price || candles.at(-1)?.close || 0;

      const ind = {
        RSI: indicators.computeRSI?.(candles) ?? 50,
        MACD: indicators.computeMACD?.(candles) ?? { hist: 0 },
        ATR: indicators.computeATR?.(candles) ?? 0,
        priceTrend:
          candles.length > 1
            ? candles.at(-1).close > candles.at(-2).close
              ? "UP"
              : candles.at(-1).close < candles.at(-2).close
              ? "DOWN"
              : "FLAT"
            : "FLAT",
        volumeTrend: indicators.volumeTrend?.(candles) ?? "STABLE"
      };

      const vol = indicators.analyzeVolume?.(candles) ?? { status: "N/A" };

      let ell = null;
      try {
        ell = await analyzeElliott(candles);
      } catch {}

      const ellSummary = {
        support: ell?.pivots?.filter((p) => p.type === "L").at(-1)?.price ?? null,
        resistance: ell?.pivots?.filter((p) => p.type === "H").at(-1)?.price ?? null,
        confidence: ell?.confidence ?? 0
      };

      let targets = [];
      if (ell?.targets?.length) {
        targets = ell.targets.map((t) => ({
          tp: +t.tp || +t.target || 0,
          confidence: Math.round(t.confidence ?? ell.confidence ?? 40),
          source: t.source || tf
        }));
      } else {
        const atr = ind.ATR || price * 0.002;
        targets = [
          { tp: price + atr * 2, confidence: 30, source: "ATR_UP" },
          { tp: price - atr * 2, confidence: 30, source: "ATR_DOWN" }
        ];
      }

      blocks.push({
        tf,
        price,
        candles,
        indicators: ind,
        vol,
        ell,
        ellSummary,
        targets
      });
    }

    // -------------- Fusion Score per TF --------------
    const fusionScoreTF = (ind, ell) => {
      let s = 0,
        w = 0;
      const rsi = ind?.RSI ?? 50;
      s += ((rsi - 50) / 50) * 0.4;
      w += 0.4;

      const macd = ind?.MACD?.hist ?? 0;
      const atr = ind?.ATR || 1;
      s += Math.tanh(macd / atr) * 0.35;
      w += 0.35;

      s +=
        ind.priceTrend === "UP"
          ? 0.15
          : ind.priceTrend === "DOWN"
          ? -0.15
          : 0;
      w += 0.15;

      s +=
        ind.volumeTrend === "INCREASING"
          ? 0.08
          : ind.volumeTrend === "DECREASING"
          ? -0.08
          : 0;
      w += 0.08;

      const elC = (ell?.confidence ?? 0) / 100;
      s += 0.25 * elC * (ell?.sentiment ?? 0);
      w += 0.25 * elC;

      return +clamp(s / w).toFixed(3);
    };

    for (const b of blocks)
      b.fusionScore = fusionScoreTF(b.indicators, b.ell);

    const WEIGHTS = { "1m": 0.05, "5m": 0.1, "15m": 0.4, "30m": 0.2, "1h": 0.25 };
    let fuseVal = 0,
      ws = 0;
    for (const b of blocks) {
      const w = WEIGHTS[b.tf] ?? 0.1;
      fuseVal += b.fusionScore * w;
      ws += w;
    }
    let overallFusion = clamp(fuseVal / ws);

    // ----------------- ML (v13) ---------------------
    let ml = null,
      micro = null,
      mlFusion = null;
    try {
      ml = await runMLPrediction(symbol, "15m");
      micro = await runMicroPrediction(symbol, "1m");
      mlFusion = fuseMLTFs({
        "15m": ml,
        "30m": await runMLPrediction(symbol, "30m"),
        "1h": await runMLPrediction(symbol, "1h")
      });
    } catch {}

    // ML nudge
    if (mlFusion?.score)
      overallFusion = clamp(
        overallFusion + (mlFusion.score / 100) * 0.22
      );

    // ---------------- New STABLE TARGETS (ML v13) -----------------
    const price = blocks.find((x) => x.tf === "15m")?.price || 0;

    const featureObj = {
      rsi: blocks.find((x) => x.tf === "15m")?.indicators?.RSI ?? 50,
      macd: blocks.find((x) => x.tf === "15m")?.indicators?.MACD?.hist ?? 0,
      atr: blocks.find((x) => x.tf === "15m")?.indicators?.ATR ?? 0
    };

    const stable = buildStableTargets(
      blocks.flatMap((b) => b.targets),
      mlFusion || { direction: "Neutral", score: 0 },
      price,
      featureObj
    );

    // ----------------- SL suggestion ---------------
    const atr15 =
      blocks.find((x) => x.tf === "15m")?.indicators?.ATR || price * 0.005;

    // ----------------- ML Accuracy -----------------
    let mlAcc = 0;
    try {
      mlAcc = calculateAccuracy()?.accuracy ?? 0;
    } catch {}

    // ---------------- Output ----------------
    return {
      ok: true,
      symbol,
      generatedAt: new Date().toISOString(),
      nowIST: nowIST(),
      price,
      blocks,
      overallFusion,
      stable,
      ml,
      micro,
      mlFusion,
      mlAcc,
      news: await fetchNewsBundle(symbol)
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ------------------- FORMATTER (Old UI intact) -------------------
export async function formatAIReport(r) {
  if (!r?.ok) return ["⚠ ERROR: " + r?.error];

  const time = nowIST(r.generatedAt);
  const price = nf(r.price, 2);

  // ML Confidence FIXED (no syntax error)
  const mlConf =
    r.mlFusion?.confidence ??
    r.mlFusion?.score ??
    r.ml?.maxProb ??
    r.ml?.probs?.max ??
    0;

  const mlDir = r.mlFusion?.direction || r.ml?.direction || "Neutral";

  const stableTP = r.stable || {
    primaryTP: "N/A",
    hedgeTP: "N/A",
    primarySource: "—",
    hedgeSource: "—",
    primaryConf: 0
  };

  const header = `
🔥 ${r.symbol} — AI Market Intelligence
Time (IST): ${time}
Price: ${price}
━━━━━━━━━━━━━━━━━━
`;

  // per-tf block builder (same as old UI)
  const tf = (tag) => {
    const b = r.blocks.find((x) => x.tf === tag);
    if (!b) return `🕒 ${tag} — N/A\nN/A\n`;

    let sig = "⚪ NEUTRAL";
    if (b.fusionScore >= 0.7) sig = "🟩 STRONG BUY";
    else if (b.fusionScore >= 0.2) sig = "🟦 BUY";
    else if (b.fusionScore <= -0.7) sig = "🟥 STRONG SELL";
    else if (b.fusionScore <= -0.2) sig = "🔴 SELL";

    const ell = b.ell?.patterns?.[0]?.type || b.ell?.pattern || "N/A";
    const conf = Math.round(b.ellSummary?.confidence || 0);

    const tps = b.targets.slice(0, 3).map((t) => nf(t.tp)).join(" / ");

    return `
🕒 ${tag} — ${sig}
RSI ${Math.round(b.indicators?.RSI || 0)} | MACD ${Math.round(
      b.indicators?.MACD?.hist || 0
    )} | Vol ${b.vol?.status || "N/A"} | ATR ${Math.round(
      b.indicators?.ATR || 0
    )}
Elliott: ${ell} | Conf ${conf}%
S: ${nf(b.ellSummary?.support)} | R: ${nf(b.ellSummary?.resistance)}
TP 🎯: ${tps || "N/A"}
SL: N/A
`;
  };

  const panel = `
📊 MULTI-TIMEFRAME PANEL
(Short | Clean | Cluster-Fusion)

${tf("1m")}
${tf("5m")}
${tf("15m")}
${tf("30m")}
${tf("1h")}
━━━━━━━━━━━━━━━━━━
`;

  const overall = `
🧭 OVERALL BIAS
Bias: ⚪ Neutral
Fusion Score: ${nf(r.overallFusion, 3)}
Buy ${nf((r.overallFusion + 1) * 50)}% | Sell ${nf(
    100 - (r.overallFusion + 1) * 50
  )}%
━━━━━━━━━━━━━━━━━━
`;

  const stableBlock = `
🎯 STABLE AI TP (Fused 15m+30m+1h)
Primary TP: ${nf(stableTP.primaryTP)} (src:${stableTP.primarySource})
Hedge TP: ${nf(stableTP.hedgeTP)} (src:${stableTP.hedgeSource})
Confidence: ${stableTP.primaryConf}%
Suggested SL: ${nf(r.price + 2 * (r.blocks[2]?.indicators?.ATR || 0))}
━━━━━━━━━━━━━━━━━━
`;

  const mlBlock = `
🤖 MACHINE LEARNING (per-TF + fused)
Direction (fused): ${mlDir}
ML fused confidence: ${nf(mlConf, 0)}%
ML accuracy (history): ${nf(r.mlAcc, 0)}%

ML quick summary:
“AI forecast active”
━━━━━━━━━━━━━━━━━━
`;

  const news = r.news || {};
  const newsBlock = `
📰 NEWS IMPACT
Impact: ${news.impact || "Low"}
Sentiment: ${Math.round((news.sentiment || 0) * 100)}%
Headline: *“${news.items?.[0]?.title || news.headline || "No major news"}”*
━━━━━━━━━━━━━━━━━━
`;

  const full = header + panel + overall + stableBlock + mlBlock + newsBlock;

  return splitParts([full]);
}

// ------------------- Sender -------------------
export async function sendSplitReport(report, sendFunc) {
  const parts = await formatAIReport(report);
  for (const p of parts) await sendFunc(p);
  return true;
}

export default {
  buildAIReport,
  formatAIReport,
  sendSplitReport
};