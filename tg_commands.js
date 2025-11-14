// tg_commands.js — Option-B UI (per-TF compact blocks) + Elliott integration (Fusion + TP Fix + Buy/Sell %)
import TelegramBot from "node-telegram-bot-api";
import CONFIG from "./config.js";
import { fetchMultiTF } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";

// Telegram init
const BOT_TOKEN = CONFIG?.TELEGRAM?.BOT_TOKEN || process.env.BOT_TOKEN;
const CHAT_ID = CONFIG?.TELEGRAM?.CHAT_ID || process.env.CHAT_ID;
const bot = BOT_TOKEN ? new TelegramBot(BOT_TOKEN, { polling: false }) : null;

// Helper: safe number
const nf = (v, d = 2) => (typeof v === "number" && Number.isFinite(v)) ? v.toFixed(d) : "N/A";

// Fusion label mapping
function fusionLabel(score) {
  if (score >= 0.70) return { label: "Strong Buy", emoji: "🚀" };
  if (score >= 0.20) return { label: "Buy", emoji: "🟢" };
  if (score > -0.20 && score < 0.20) return { label: "Neutral", emoji: "⚪" };
  if (score <= -0.20 && score > -0.70) return { label: "Sell", emoji: "🔴" };
  return { label: "Strong Sell", emoji: "⛔" };
}

// Fusion scoring
function computeFusionScore(indObj, ellObj) {
  let score = 0, weight = 0;
  try {
    const rsi = Number(indObj?.RSI ?? 50);
    const rsiScore = ((rsi - 50) / 50);
    score += rsiScore * 0.4; weight += 0.4;

    const macdh = Number(indObj?.MACD?.hist ?? 0);
    const macdScore = Math.tanh(macdh / Math.max(1, Math.abs(indObj?.ATR || 1)));
    score += macdScore * 0.35; weight += 0.35;

    const pt = indObj?.priceTrend === "UP" ? 0.15 : indObj?.priceTrend === "DOWN" ? -0.15 : 0;
    score += pt; weight += 0.15;

    const vt = (indObj?.volumeTrend === "INCREASING") ? 0.08 : (indObj?.volumeTrend === "DECREASING") ? -0.08 : 0;
    score += vt; weight += 0.08;

    const ellSent = Number(ellObj?.sentiment ?? 0);
    const ellConf = Math.min(1, Number(ellObj?.confidence ?? 0) / 100);
    score += ellSent * (0.25 * ellConf); weight += 0.25 * ellConf;

    return Number(Math.max(-1, Math.min(1, score / Math.max(0.0001, weight))).toFixed(3));
  } catch {
    return 0;
  }
}

// Overall fusion (weighted)
function computeOverallFusion(mtf) {
  const weights = { "1m": 0.05, "5m": 0.1, "15m": 0.4, "30m": 0.2, "1h": 0.25 };
  let s = 0, wsum = 0;
  for (const m of mtf) {
    const score = Number(m.fusionScore ?? 0);
    const w = weights[m.tf] ?? 0.1;
    s += score * w;
    wsum += w;
  }
  return Number(Math.max(-1, Math.min(1, s / wsum)).toFixed(3));
}

// Buy/Sell probability
function computeBuySellProb(overallFusion, mtf) {
  let buy = (overallFusion + 1) / 2 * 100;
  let sell = 100 - buy;

  let ellSum = 0, ellW = 0;
  for (const m of mtf) {
    const ell = m.ell;
    if (ell && typeof ell.sentiment === "number" && typeof ell.confidence === "number") {
      const conf = Math.min(100, Math.max(0, ell.confidence));
      ellSum += ell.sentiment * (conf / 100);
      ellW += (conf / 100);
    }
  }
  const ellAvg = ellW ? (ellSum / ellW) : 0;

  const nudge = ellAvg * 10;
  buy += nudge;
  sell = 100 - buy;

  const bullishTFs = mtf.filter(m => (m.fusionScore ?? 0) > 0.2).length;
  const bearishTFs = mtf.filter(m => (m.fusionScore ?? 0) < -0.2).length;
  const diff = bullishTFs - bearishTFs;
  if (diff > 0) buy += Math.min(8, diff * 2);
  else if (diff < 0) sell += Math.min(8, Math.abs(diff) * 2);

  buy = Math.max(0, Math.min(100, buy));
  sell = Math.max(0, Math.min(100, sell));

  const sum = buy + sell;
  if (sum > 0) {
    buy = Math.round((buy / sum) * 10000) / 100;
    sell = Math.round((sell / sum) * 10000) / 100;
  }

  return { buy, sell, ellAvg };
}

// TF Block builder
function buildTFBlock(tf, price, ind, vol, ellSummary, fusionScore, fib) {
  const fusion = fusionLabel(fusionScore);
  const rsi = typeof ind.RSI === "number" ? ind.RSI.toFixed(1) : "N/A";
  const macd = typeof ind.MACD?.hist === "number" ? ind.MACD.hist.toFixed(4) : "N/A";
  const atr = typeof ind.ATR === "number" ? ind.ATR.toFixed(2) : "N/A";

  const support = ellSummary?.support ? nf(ellSummary.support, 2) : (fib?.lo ? nf(fib.lo, 2) : "N/A");
  const resistance = ellSummary?.resistance ? nf(ellSummary.resistance, 2) : (fib?.hi ? nf(fib.hi, 2) : "N/A");

  return `
<b>【${tf.toUpperCase()}】 ${fusion.emoji} ${fusion.label}</b>
💰 Price: <b>${nf(price,2)}</b> | 📊 Vol: ${vol?.status || "N/A"}
RSI: <b>${rsi}</b> | MACD: <b>${macd}</b> | ATR: <b>${atr}</b>
Structure: support:${support} | resistance:${resistance}
Fusion Score: ${fusionScore}
`.trim();
}

// Heatmap
function buildHeatmap(mtfData) {
  const tfOrder = ["1m","5m","15m","30m","1h"];
  const mapEmoji = (s) => {
    if (s >= 0.7) return "🟩";
    if (s >= 0.2) return "🟦";
    if (s > -0.2 && s < 0.2) return "🟨";
    if (s <= -0.2 && s > -0.7) return "🟧";
    return "🟥";
  };
  const parts = tfOrder.map(tf => {
    const blk = mtfData.find(x => x.tf === tf);
    const score = blk ? blk.fusionScore ?? 0 : 0;
    return `${tf.toUpperCase()}:${mapEmoji(score)}`;
  });
  return `<b>Elliott MultiTF Heatmap</b>\n` + parts.join(" | ");
}

// Elliott → support/resistance extraction
async function safeElliottForCandles(candles) {
  try {
    const ell = await analyzeElliott(candles);
    if (!ell || !ell.ok) return { ok:false };

    const pivots = ell.pivots || [];
    const lastHigh = pivots.filter(p=>p.type==='H').slice(-1)[0];
    const lastLow = pivots.filter(p=>p.type==='L').slice(-1)[0];

    return {
      ok:true,
      ell,
      support: lastLow ? lastLow.price : null,
      resistance: lastHigh ? lastHigh.price : null
    };
  } catch {
    return { ok:false };
  }
}

// Target confidence resolver
function resolveTargetConfidence(t, ell) {
  if (t && typeof t.confidence === "number") return Math.max(0, Math.min(100, t.confidence));
  if (ell && typeof ell.confidence === "number") return Math.max(0, Math.min(100, ell.confidence));
  return null;
}

// =============================
// START buildAIReport()
// =============================
export async function buildAIReport(symbol = "BTCUSDT") {
  try {
    const tfs = ["1m","5m","15m","30m","1h"];
    const mtfRaw = await fetchMultiTF(symbol, tfs);
    const mtf = [];
// per-TF analysis
    for (const tf of tfs) {
      const entry = mtfRaw[tf] || { data: [], price: 0 };
      const candles = entry.data || [];
      const price = (typeof entry.price === "number" && entry.price)
        ? entry.price
        : (candles?.at(-1)?.close ?? 0);

      // indicators
      const ind = {
        RSI: indicators.computeRSI ? indicators.computeRSI(candles)
             : (indicators.computeRSI_fromCandles ? indicators.computeRSI_fromCandles(candles) : 50),
        MACD: indicators.computeMACD ? indicators.computeMACD(candles)
              : { hist: 0, line:0, signal:0 },
        ATR: indicators.computeATR ? indicators.computeATR(candles) : 0,
        priceTrend:
          (candles.length >= 2)
            ? (candles.at(-1).close > candles.at(-2).close ? "UP"
              : (candles.at(-1).close < candles.at(-2).close ? "DOWN"
                : "FLAT"))
            : "FLAT",
        volumeTrend: indicators.volumeTrend ? indicators.volumeTrend(candles) : "STABLE"
      };

      const vol = indicators.analyzeVolume ? indicators.analyzeVolume(candles)
                 : { status: "UNKNOWN", strength: 0 };

      // elliott
      const ellRes = await safeElliottForCandles(candles);
      const ell = ellRes.ok ? ellRes.ell : null;

      // fib
      let fib = null;
      try {
        if (typeof indicators.computeFibLevels === "function")
          fib = indicators.computeFibLevels(candles);
        else if (typeof indicators.computeFibLevelsFromCandles === "function")
          fib = indicators.computeFibLevelsFromCandles(candles);
      } catch { fib = null; }

      // fusion
      const fusionScore =
        computeFusionScore(ind, ell || { sentiment: 0, confidence: 0 });

      // Elliott targets (raw)
      const rawTargets = (ell && Array.isArray(ell.targets))
        ? ell.targets.slice(0, 5)
        : [];

      // annotate confidence
      const targets = rawTargets.map(t => {
        const conf = resolveTargetConfidence(t, ell);
        return { ...t, confidence: conf };
      });

      mtf.push({
        tf, price, candles,
        indicators: ind, vol,
        ell, ellSummary: { support: ellRes?.support || null, resistance: ellRes?.resistance || null },
        fib, fusionScore, targets
      });
    }

    // overall fusion and probs
    const overallFusion = computeOverallFusion(mtf);
    const probs = computeBuySellProb(overallFusion, mtf);

    const price =
      mtf.find(x => x.tf === "15m")?.price || mtf[0]?.price || 0;

    // aggregate targets from all TFs
    const allTargets = mtf.flatMap(m =>
      (m.targets || []).map(t => ({ ...t, tf: m.tf }))
    );

    // Dedupe
    const uniqMap = new Map();
    for (const t of allTargets) {
      const key = Math.round((t.tp || t.target || t?.price || 0));
      if (!uniqMap.has(key)) uniqMap.set(key, t);
      else {
        const prev = uniqMap.get(key);
        uniqMap.set(key, (t.confidence || 0) > (prev.confidence || 0) ? t : prev);
      }
    }
    const uniqTargets = Array.from(uniqMap.values()).slice(0, 6);

    // final confidence fill
    const annotatedTargets = uniqTargets.map(t => {
      let conf = t.confidence;
      if (conf == null) {
        const ellConfAvg = mtf
          .reduce((a, m) => a + (m.ell?.confidence || 0), 0)
          / Math.max(1, mtf.length);
        conf = Math.round(
          Math.max(
            10,
            Math.min(99, 40 + Math.abs(overallFusion) * 40 + (ellConfAvg * 0.2))
          )
        );
      }
      return { ...t, confidence: Math.round(conf) };
    });

    // ======================
    // MERGED — Your TP fix logic
    // ======================

    function getTP(t) {
      return Number(t.tp || t.target || t.price || 0);
    }

    const longs = annotatedTargets
      .filter(t => {
        const tp = getTP(t);
        return tp > price;  // LONG if TP > price
      })
      .sort((a, b) => b.confidence - a.confidence);

    const shorts = annotatedTargets
      .filter(t => {
        const tp = getTP(t);
        const type = (t.source || t.type || t.label || "").toLowerCase();

        if (tp < price) return true;  // SHORT if TP < price
        if (type.includes("short") || type.includes("bear") || type.includes("down")) return true;

        return false;
      })
      .sort((a, b) => b.confidence - a.confidence);

    return {
      ok: true,
      symbol,
      price,
      mtf,
      overallFusion,
      buyProb: probs.buy,
      sellProb: probs.sell,
      ellConsensus: probs.ellAvg,
      annotatedTargets,
      longs,
      shorts,
      generatedAt: new Date().toISOString()
    };

  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}
// ======================
// PART 3: formatAIReport + exports
// ======================

export async function formatAIReport(report) {
  try {
    if (!report || !report.ok) {
      const txt = `Error building report: ${report?.error || "unknown"}`;
      if (bot && CHAT_ID) {
        try { await bot.sendMessage(CHAT_ID, txt); } catch (e) { /* ignore */ }
      }
      return txt;
    }

    const price = Number(report.price || 0);
    const mtf = report.mtf || [];

    // Heatmap
    const heat = buildHeatmap(mtf);

    // Per-TF blocks (reuse buildTFBlock)
    const tfBlocks = mtf.map(m => buildTFBlock(
      m.tf,
      m.price,
      m.indicators || {},
      m.vol || {},
      m.ellSummary || {},
      m.fusionScore || 0,
      m.fib || null
    )).join("\n\n──────────────\n\n");

    // Elliott summary (best available)
    let ellSummaryText = "Elliott: N/A (placeholder)";
    const firstEll = mtf.find(m => m.ell && ((m.ell.patterns && m.ell.patterns.length) || (m.ell.targets && m.ell.targets.length)));
    if (firstEll && firstEll.ell) {
      const conf = firstEll.ell.confidence ?? firstEll.ell.conf ?? 0;
      ellSummaryText = `Elliott MultiTF (best): Conf ${conf}% | Patterns: ${firstEll.ell.patterns?.length || 0} | Targets: ${firstEll.ell.targets?.length || 0}`;
    }

    // Targets: prefer report.longs/shorts if buildAIReport produced them, else compute from annotatedTargets
    let longs = report.longs || [];
    let shorts = report.shorts || [];
    const annotatedTargets = report.annotatedTargets || [];

    if ((!Array.isArray(longs) || !longs.length) && (!Array.isArray(shorts) || !shorts.length)) {
      // fallback partition logic (same as build step)
      function getTP(t) { return Number(t.tp || t.target || t.price || 0); }
      longs = annotatedTargets.filter(t => getTP(t) > price).sort((a,b)=>b.confidence - a.confidence);
      shorts = annotatedTargets.filter(t => getTP(t) < price).sort((a,b)=>b.confidence - a.confidence);
      // additionally include targets marked as 'bear'/'short' into shorts even if tp ~= price
      const extraShorts = annotatedTargets.filter(t => {
        const type = (t.source || t.type || t.label || "").toString().toLowerCase();
        return (type.includes("short") || type.includes("bear") || type.includes("down")) && getTP(t) <= price;
      });
      for (const es of extraShorts) {
        if (!shorts.find(s => Math.round(getTP(s)) === Math.round(getTP(es)))) shorts.push(es);
      }
    }

    // Format top 3 each side
    const topLongsTxt = (longs.slice(0,3).map((t,i)=> {
      const tpVal = Number(t.tp || t.target || t.price || 0);
      const src = t.source || t.type || t.tf || "Elliott";
      return `TP${i+1}: ${nf(tpVal,2)} (${src}) [${t.confidence ?? "N/A"}%]`;
    }).join(" | ")) || "n/a";

    const topShortsTxt = (shorts.slice(0,3).map((t,i)=> {
      const tpVal = Number(t.tp || t.target || t.price || 0);
      const src = t.source || t.type || t.tf || "Elliott";
      return `TP${i+1}: ${nf(tpVal,2)} (${src}) [${t.confidence ?? "N/A"}%]`;
    }).join(" | ")) || "n/a";

    // Overall fusion / probabilities
    const overallFusion = Number(report.overallFusion ?? 0);
    const fusionLbl = fusionLabel(overallFusion);
    const buyProb = Number(report.buyProb ?? 0);
    const sellProb = Number(report.sellProb ?? 0);

    // Build TP/SL fallback SL derivation (ATR-based from 15m if available)
    let slLong = "n/a", slShort = "n/a";
    const tf15 = mtf.find(x => x.tf === "15m");
    const atr15 = tf15?.indicators?.ATR || (tf15?.price ? Number(tf15.price) * 0.005 : null);
    if (atr15) {
      const slLongVal = price - (atr15 * 2);
      const slShortVal = price + (atr15 * 2);
      slLong = nf(slLongVal,2);
      slShort = nf(slShortVal,2);
    }

    // Compose HTML message
    const html = `
🚀 <b>${report.symbol} — AI Trader (Option-B, merged)</b>
${new Date(report.generatedAt || report.generatedAt || Date.now()).toLocaleString()}
Source: Multi (Binance Vision + Backups)
Price: <b>${nf(price,2)}</b>

${heat}

📈 <b>Elliott Overview</b>
${ellSummaryText}

────────────────────
<b>📊 Multi-Timeframe Analysis</b>

${tfBlocks}

────────────────────
🧠 <b>Fusion Summary</b>
Overall Bias: ${fusionLbl.emoji} <b>${fusionLbl.label}</b> | Fusion Score: ${overallFusion}
Buy Prob: <b>${buyProb}%</b> | Sell Prob: <b>${sellProb}%</b>
Strength (approx): ${Math.round(Math.abs(overallFusion) * 100)}%

🎯 <b>LONG Targets (confidence)</b>
${topLongsTxt}
SL (long): ${slLong}

🎯 <b>SHORT Targets (confidence)</b>
${topShortsTxt}
SL (short): ${slShort}

📐 Fib Zone (15m): ${ (tf15?.fib) ? `${nf(tf15.fib.lo,2)} - ${nf(tf15.fib.hi,2)}` : "N/A" }

//📰 News Impact: Placeholder (hook your news module)//
//ML: Placeholder (hook your ML module) — integrate your `ml_module_v8_6.js` runMLPrediction to replace//

<i>Data: Multi-source (Binance Vision + Binance + Bybit/KuCoin/CB) | UI: Option-B per TF | Engine: Elliott+Fusion</i>
`.trim();

    // Send to Telegram if available
    if (bot && CHAT_ID) {
      try {
        await bot.sendMessage(CHAT_ID, html, { parse_mode: "HTML", disable_web_page_preview: true });
      } catch (e) {
        console.error("Telegram send failed:", e?.message || e);
      }
    }

    return html;

  } catch (e) {
    const err = `formatAIReport error: ${e?.message || e}`;
    console.error(err);
    // notify in-chat if possible
    if (bot && CHAT_ID) {
      try { await bot.sendMessage(CHAT_ID, err); } catch {}
    }
    return err;
  }
}

// final exports (keep named + default for compatibility)

export default { buildAIReport, formatAIReport };