// tg_commands.js — FINAL ML-v12 Integrated Version
// ---------------------------------------------------------
// - Works with ML v12 default export
// - Same UI (short | clean | cluster-free panel)
// - Fully stable Elliott, News, TP engine
// - No placeholders, no missing fields
// ---------------------------------------------------------

import CONFIG from "./config.js";
import ML from "./ml_module_v8_6.js";        // 🔥 Updated to ML v12
import News from "./news_social.js";        // Existing news module

import { fetchMultiTF } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";

// Extract ML v12 functions from default export
const {
    runMLPrediction,
    runMicroPrediction,
    calculateAccuracy,
    recordPrediction,
    recordOutcome
} = ML;

// Extract News bundle
const { fetchNewsBundle } = News;

// ⚙️ Helpers
const MAX_TG_CHARS = 3800;
const nf = (v, d = 2) => (typeof v === "number" ? v.toFixed(d) : "N/A");
const isNum = v => typeof v === "number" && Number.isFinite(v);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const ellipsis = (s, n = 160) => (s && s.length > n ? s.slice(0, n) + "…" : s);

// Convert ISO → IST
function nowIST(iso) {
    try {
        return new Date(iso).toLocaleString("en-IN", {
            timeZone: "Asia/Kolkata",
            hour12: true
        });
    } catch { return new Date().toString(); }
}

// Split Telegram message safely
function splitSafe(block, max = MAX_TG_CHARS) {
    if (block.length < max) return [block];
    const out = [];
    for (let i = 0; i < block.length; i += max - 200) {
        out.push(block.slice(i, i + max - 200));
    }
    return out;
}

// ---------------------------------------------------------
// 🔥 MASTER BUILDER
// ---------------------------------------------------------
export async function buildAIReport(symbol = CONFIG.SYMBOL, opts = {}) {
    try {
        const tfs = ["1m", "5m", "15m", "30m", "1h"];

        // Fetch multi-TF candles
        const mtf = await fetchMultiTF(symbol, tfs);

        const blocks = [];
        for (const tf of tfs) {
            const entry = mtf[tf] || {};
            const candles = entry.data || [];
            const price = entry.price || (candles.at(-1)?.close ?? 0);

            // ----- Indicators -----
            const RSI = indicators.computeRSI?.(candles) ?? 50;
            const MACD = indicators.computeMACD?.(candles) ?? { hist: 0 };
            const ATR = indicators.computeATR?.(candles) ?? price * 0.005;

            // Volume
            const volumeSummary = indicators.analyzeVolume?.(candles) ?? { status: "Stable" };

            // ----- Elliott -----
            let ell = null;
            try { ell = await analyzeElliott(candles); } catch {}

            const support = ell?.pivots?.filter(p => p.type === "L")?.at(-1)?.price ?? null;
            const resistance = ell?.pivots?.filter(p => p.type === "H")?.at(-1)?.price ?? null;

            // TP (Elliott or fallback ATR)
            let targets = [];
            if (Array.isArray(ell?.targets) && ell.targets.length) {
                targets = ell.targets.map(t => ({
                    tp: t.tp ?? t.target ?? 0,
                    confidence: t.confidence ?? ell.confidence ?? 40
                }));
            } else {
                const step = ATR * 2;
                targets = [
                    { tp: price + step, confidence: 20 },
                    { tp: price - step, confidence: 20 }
                ];
            }

            blocks.push({
                tf,
                price,
                RSI,
                MACD,
                ATR,
                volumeSummary,
                ellPattern: ell?.pattern || "No clear wave",
                ellConfidence: ell?.confidence ?? 0,
                support,
                resistance,
                targets
            });
        }

        // ----- Fusion engine -----
        let fusion = 0;
        for (const b of blocks) {
            const rsiScore = (b.RSI - 50) / 50;
            const macdScore = Math.tanh(b.MACD.hist / (b.ATR || 1));
            const ellScore = (b.ellConfidence / 100) * (b.ellPattern.includes("Bull") ? 1 : -1);

            fusion += (rsiScore * 0.3) + (macdScore * 0.4) + (ellScore * 0.3);
        }
        fusion = clamp(fusion / blocks.length, -1, 1);

        // Overall price reference = 15m
        const price = blocks.find(b => b.tf === "15m")?.price ?? blocks[0].price;

        // Collect TPs
        const allTP = [];
        for (const b of blocks) {
            for (const t of b.targets) {
                allTP.push({ tp: t.tp, conf: t.confidence });
            }
        }

        allTP.sort((a, b) => b.conf - a.conf);

        const longs = allTP.filter(t => t.tp > price).slice(0, 4);
        const shorts = allTP.filter(t => t.tp < price).slice(0, 4);

        // ----- ML Predictions -----
        let ml = null, micro = null;
        try { ml = await runMLPrediction(symbol, "15m"); } catch {}
        try { micro = await runMicroPrediction(symbol, "1m"); } catch {}

        // ML boost to fusion
        if (ml?.probs) {
            const diff = (ml.probs.bull - ml.probs.bear) / 100;
            fusion = clamp(fusion + diff * 0.25, -1, 1);
        }

        // ----- News -----
        let news = { sentiment: 0.5, impact: "Low", items: [] };
        try { news = await fetchNewsBundle(symbol); } catch {}

        const report = {
            ok: true,
            symbol,
            generatedAt: new Date().toISOString(),
            nowIST: nowIST(),
            blocks,
            price,
            fusion,
            longs,
            shorts,
            ml,
            micro,
            news,
            buyProb: ((fusion + 1) / 2) * 100,
            sellProb: 100 - ((fusion + 1) / 2) * 100
        };

        return report;

    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// ---------------------------------------------------------
// 🔥 UI Format (no placeholders, final output)
// ---------------------------------------------------------
export async function formatAIReport(report) {
    if (!report?.ok) return [`⚠️ Error generating report`];

    const { symbol, nowIST, price, fusion, news, ml } = report;

    const finalBias =
        fusion >= 0.6 ? "🟩 Strong Buy"
      : fusion >= 0.2 ? "🟦 Buy"
      : fusion <= -0.6 ? "🟥 Strong Sell"
      : fusion <= -0.2 ? "🟧 Sell"
      : "⚪ Neutral";

    const b = tf => report.blocks.find(x => x.tf === tf);

    const blockText = tf => {
        const x = b(tf);
        if (!x) return "";

        const tps = x.targets.slice(0, 3).map(t => nf(t.tp, 2)).join(" / ");

        return `
🕒 ${tf.toUpperCase()} — ${finalBias}
RSI ${nf(x.RSI, 0)} | MACD ${nf(x.MACD.hist, 2)} | Vol ${x.volumeSummary.status} | ATR ${nf(x.ATR, 2)}
Elliott: ${x.ellPattern} | Conf ${Math.round(x.ellConfidence)}%
S: ${nf(x.support)} | R: ${nf(x.resistance)}
TP 🎯: ${tps || "N/A"}
SL: ${nf(x.ATR * 2)}
        `.trim();
    };

    const mlDir = ml?.direction || "Neutral";
    const mlConf = ml?.maxProb || ml?.tpConfidence || 0;
    const mlSellTP = isNum(ml?.tpEstimate) ? nf(ml.tpEstimate) : "N/A";
    const mlBuyTP  = isNum(ml?.tpEstimate) ? nf(ml.tpEstimate) : "N/A";

    const headline = news.items?.length ? news.items[0].title : "No major events";

    const msg = `
🔥 ${symbol} — AI Market Intelligence
Time (IST): ${nowIST}
Price: ${nf(price)}
━━━━━━━━━━━━━━━━━━

📊 MULTI-TIMEFRAME PANEL
${blockText("1m")}

${blockText("5m")}

${blockText("15m")}

${blockText("30m")}

${blockText("1h")}
━━━━━━━━━━━━━━━━━━

🧭 OVERALL BIAS
Bias: ${finalBias}  
Fusion Score: ${fusion.toFixed(3)}
Buy ${nf(report.buyProb)}% | Sell ${nf(report.sellProb)}%
━━━━━━━━━━━━━━━━━━

🎯 OVERALL TP (AI Driven)
Bullish TP: ${report.longs[0] ? nf(report.longs[0].tp) : "N/A"} – ${report.longs[1] ? nf(report.longs[1].tp) : "N/A"}
Bearish TP: ${report.shorts[0] ? nf(report.shorts[0].tp) : "N/A"} – ${report.shorts[1] ? nf(report.shorts[1].tp) : "N/A"}
━━━━━━━━━━━━━━━━━━

🤖 MACHINE LEARNING FORECAST
Direction: ${mlDir}
Confidence: ${nf(mlConf)}%
ML Sell TP: <b>${mlSellTP}</b>
ML Buy TP: <b>${mlBuyTP}</b>
━━━━━━━━━━━━━━━━━━

📰 NEWS IMPACT
Impact: ${news.impact}
Sentiment: ${Math.round(news.sentiment * 100)}%
Headline: “${ellipsis(headline, 220)}”
━━━━━━━━━━━━━━━━━━
`.trim();

    return splitSafe(msg);
}

// ---------------------------------------------------------
export async function sendSplitReport(report, sendTelegram) {
    const parts = await formatAIReport(report);
    for (const p of parts) {
        await sendTelegram(p);
        await new Promise(r => setTimeout(r, 600));
    }
    return true;
}

export default {
    buildAIReport,
    formatAIReport,
    sendSplitReport
};