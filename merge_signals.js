// ============================================================
// merge_signals.js — FINAL STABLE V3.1 (UI + Multi-TF + Elliott fixes)
// ============================================================

import {
    fetchUniversal,
    fetchMultiTF,
    fetchMarketData
} from "./utils.js";

import { runMLPrediction } from "./ml_module_v8_6.js";
import { analyzeElliott } from "./elliott_module.js";
import { fetchNewsBundle } from "./news_social.js";

const VERSION = "v3.1_FINAL_STABLE";

// ================= SYMBOL MAP =================
const symbolMap = {
    NIFTY50: "NSEI",
    BANKNIFTY: "NSEBANK",
    SENSEX: "BSESN",
    FINNIFTY: "NSE:FINNIFTY",  // यह बाद में fallback देगा

    GOLD: "GC=F",
    SILVER: "SI=F",
    CRUDE: "CL=F",
    NGAS: "NG=F",

    DXY: "DX-Y.NYB",
    XAUUSD: "GC=F",
    XAGUSD: "SI=F",

    EURUSD: "EURUSD=X",
    GBPUSD: "GBPUSD=X",
    USDJPY: "JPY=X"
};

// ================= HELPERS =================
function withHTML(kb) {
    return { ...kb, parse_mode: "HTML" };
}

function isCryptoLike(sym) {
    if (!sym) return false;
    const s = String(sym).toUpperCase();
    return s.endsWith("USDT") || s.endsWith("USD") || s.endsWith("BTC") || s.endsWith("ETH");
}

function safeNum(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function round(v, d = 4) {
    if (!Number.isFinite(v)) return v;
    return Math.round(v * 10 ** d) / 10 ** d;
}

// ================= KEYBOARDS =================
export const kbHome = withHTML({
    reply_markup: {
        inline_keyboard: [
            [
                { text: "💠 Crypto", callback_data: "menu_crypto" },
                { text: "📘 Indices", callback_data: "menu_indices" }
            ],
            [
                { text: "💱 Forex", callback_data: "menu_forex" },
                { text: "🛢 Commodities", callback_data: "menu_commodities" }
            ]
        ]
    }
});

export const kbCrypto = withHTML({
    reply_markup: {
        inline_keyboard: [
            [
                { text: "BTC", callback_data: "asset_BTCUSDT" },
                { text: "ETH", callback_data: "asset_ETHUSDT" }
            ],
            [
                { text: "SOL", callback_data: "asset_SOLUSDT" },
                { text: "XRP", callback_data: "asset_XRPUSDT" }
            ],
            [
                { text: "DOGE", callback_data: "asset_DOGEUSDT" },
                { text: "ADA", callback_data: "asset_ADAUSDT" }
            ],
            [{ text: "⬅ Back", callback_data: "back_home" }]
        ]
    }
});

export const kbIndices = withHTML({
    reply_markup: {
        inline_keyboard: [
            [
                { text: "NIFTY50", callback_data: "asset_NIFTY50" },
                { text: "BankNifty", callback_data: "asset_BANKNIFTY" }
            ],
            [
                { text: "Sensex", callback_data: "asset_SENSEX" },
                { text: "FinNifty", callback_data: "asset_FINNIFTY" }
            ],
            [{ text: "⬅ Back", callback_data: "back_home" }]
        ]
    }
});

export const kbForex = withHTML({
    reply_markup: {
        inline_keyboard: [
            [
                { text: "EURUSD", callback_data: "asset_EURUSD" },
                { text: "GBPUSD", callback_data: "asset_GBPUSD" }
            ],
            [
                { text: "USDJPY", callback_data: "asset_USDJPY" },
                { text: "XAUUSD", callback_data: "asset_XAUUSD" }
            ],
            [
                { text: "XAGUSD", callback_data: "asset_XAGUSD" },
                { text: "DXY", callback_data: "asset_DXY" }
            ],
            [{ text: "⬅ Back", callback_data: "back_home" }]
        ]
    }
});

export const kbCommodity = withHTML({
    reply_markup: {
        inline_keyboard: [
            [
                { text: "GOLD", callback_data: "asset_GOLD" },
                { text: "SILVER", callback_data: "asset_SILVER" }
            ],
            [
                { text: "CRUDE", callback_data: "asset_CRUDE" },
                { text: "NGAS", callback_data: "asset_NGAS" }
            ],
            [{ text: "⬅ Back", callback_data: "back_home" }]
        ]
    }
});

export function kbActions(symbol) {
    return withHTML({
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "🔄 Refresh", callback_data: `refresh_${symbol}` },
                    { text: "🕒 Timeframes", callback_data: `tfs_${symbol}` }
                ],
                [
                    { text: "📊 Elliott", callback_data: `ell_${symbol}` },
                    { text: "📰 News", callback_data: `news_${symbol}` }
                ],
                [{ text: "⬅ Back", callback_data: "back_assets" }]
            ]
        }
    });
}

export function kbTimeframes(symbol) {
    return withHTML({
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "5m", callback_data: `tf_${symbol}_5m` },
                    { text: "15m", callback_data: `tf_${symbol}_15m` }
                ],
                [
                    { text: "30m", callback_data: `tf_${symbol}_30m` },
                    { text: "1h", callback_data: `tf_${symbol}_1h` }
                ],
                [
                    { text: "4h", callback_data: `tf_${symbol}_4h` },
                    { text: "1D", callback_data: `tf_${symbol}_1d` }
                ],
                [{ text: "⬅ Back", callback_data: `asset_${symbol}` }]
            ]
        }
    });
}

// ================= ELLIOTT FIX =================
function extractTopPatterns(ell, max = 3) {
    if (!ell || !Array.isArray(ell.patterns)) return { list: [], conf: 50, primarySentiment: "Neutral" };

    const score = safeNum(ell.sentiment, 0);
    const overallSent = score > 0.15 ? "Bullish" : score < -0.15 ? "Bearish" : "Neutral";

    let bulls = 0, bears = 0;
    for (const p of ell.patterns) {
        if (p.side === "Bullish") bulls++;
        if (p.side === "Bearish") bears++;
    }

    const dom = bulls > bears ? "Bullish" : bears > bulls ? "Bearish" : overallSent;

    const map = new Map();
    for (const p of ell.patterns) {
        if (dom !== "Neutral" && p.side !== dom) continue;

        const t = p.type;
        const c = safeNum(p.confidence ?? p.conf ?? 50);
        if (!map.has(t) || c > map.get(t).conf) {
            map.set(t, { type: t, conf: c });
        }
    }

    const arr = [...map.values()].sort((a, b) => b.conf - a.conf).slice(0, max);
    return {
        list: arr.map(a => `${a.type}(${Math.round(a.conf)}%)`),
        conf: arr[0]?.conf ?? 50,
        primarySentiment: arr.length ? dom : overallSent
    };
}

// ================= FORMATTER =================
function formatPremiumReport(r) {
    return `
🔥 <b>${r.symbol}</b> — PREMIUM AI SIGNAL (${r._meta.tfUsed})
━━━━━━━━━━━━━━━━━━
📍 <b>Price:</b> ${r.price}
🧭 <b>Trend:</b> ${r.biasEmoji} ${r.direction}
📰 <b>News:</b> ${r.newsImpact} (${r.newsScore}%)
⚡ <b>Elliott:</b> ${r.elliottPattern} (${r.elliottConf}%)

🎯 <b>TARGETS</b>
Primary TP: <b>${r.tp1}</b>
Hedge TP: <b>${r.tp2}</b>
Confidence: <b>${r.tpConf}%</b>

🤖 <b>ML Probability:</b> ${r.maxProb}%
━━━━━━━━━━━━━━━━━━
<small>Source: ${r._meta.fetchSource} | Candles: ${r._meta.candlesFound} | Ver: ${VERSION}</small>
`;
}

// ================= PRICE RESOLVER =================
async function resolvePriceAndCandles(symbol, tf) {
    try {
        const tryFetch = async (sym, timeframe) => {
            const r = await fetchUniversal(sym, timeframe);
            const data = r?.data ?? r?.candles ?? [];
            const price = safeNum(r?.price || data.at(-1)?.close);
            if (price && data.length) return { data, price };
            return null;
        };

        let p = await tryFetch(symbol, tf);
        if (p) return { ...p, source: "universal" };

        if (isCryptoLike(symbol)) {
            const m = await fetchMarketData(symbol, tf);
            if (m?.price && Array.isArray(m.data))
                return { data: m.data, price: safeNum(m.price), source: "marketData" };
        }

        const multi = await fetchMultiTF(symbol, [tf]);
        if (multi?.[tf]) {
            const d = multi[tf].data || [];
            const pr = safeNum(multi[tf].price || d.at(-1)?.close);
            if (pr) return { data: d, price: pr, source: "multiTF" };
        }

        if (tf !== "15m") {
            let p2 = await tryFetch(symbol, "15m");
            if (p2) return { ...p2, source: "universal-15m" };
        }

        return { data: [], price: 0, source: "none" };

    } catch (e) {
        return { data: [], price: 0, source: "error" };
    }
}

// ================= MAIN REPORT =================
export async function generateReport(symbolLabel, tf = "15m") {
    const mapped = symbolMap[symbolLabel] || symbolLabel;

    const { data: candles, price, source } = await resolvePriceAndCandles(mapped, tf);

    let ml = {};
    try { ml = await runMLPrediction(mapped, tf) || {}; } catch {}

    let ell = null;
    try {
        if (candles.length >= 8)
            ell = await analyzeElliott(candles.slice(-400), { left: 3, right: 3 });
    } catch {}

    let news = {};
    try { news = await fetchNewsBundle(mapped) || {}; } catch {}

    const patt = ell ? extractTopPatterns(ell, 3) : { list: [], conf: 50, primarySentiment: "Neutral" };
    const ellConf = Math.round(patt.conf);
    const ellSent = patt.primarySentiment;

    const mlProb = safeNum(ml.maxProb || ml.confidence || 50);
    const mlDir = ml.direction || "Neutral";

    let finalDir = "Neutral";
    if (mlProb > 60) finalDir = mlDir;
    else if (ellSent !== "Neutral" && ellConf >= 60) finalDir = ellSent;
    else if (news.sentiment > 70) finalDir = "Bullish";
    else if (news.sentiment < 30) finalDir = "Bearish";
    else finalDir = mlDir;

    const biasEmoji = finalDir === "Bullish" ? "📈" : finalDir === "Bearish" ? "📉" : "⚪";

    const out = {
        symbol: symbolLabel,
        price: round(price, 4),
        direction: finalDir,
        biasEmoji,
        tp1: ml.tp1 ?? ml.tpEstimate ?? "—",
        tp2: ml.tp2 ?? ml.tp2Estimate ?? "—",
        tpConf: ml.tpConfidence ?? 55,
        maxProb: round(mlProb, 2),
        elliottPattern: patt.list.join(" + ") || "N/A",
        elliottConf: ellConf,
        newsImpact: news.impact || "Neutral",
        newsScore: safeNum(news.sentiment, 50),
        _meta: {
            version: VERSION,
            mappedSymbol: mapped,
            fetchSource: source,
            candlesFound: candles.length,
            ellSentiment: ellSent,
            tfUsed: tf
        }
    };

    return {
        text: formatPremiumReport(out),
        keyboard: kbActions(symbolLabel)
    };
}

// ================= CALLBACK HANDLER (FINAL FIXED) =================
export async function handleCallback(q) {
    const d = q.data;

    if (d === "back_home") return { text: "🏠 HOME", keyboard: kbHome };
    if (d === "menu_crypto") return { text: "💠 Crypto Market", keyboard: kbCrypto };
    if (d === "menu_indices") return { text: "📘 Indices Market", keyboard: kbIndices };
    if (d === "menu_forex") return { text: "💱 Forex Market", keyboard: kbForex };
    if (d === "menu_commodities") return { text: "🛢 Commodities Market", keyboard: kbCommodity };
    if (d === "back_assets") return { text: "Choose Market", keyboard: kbHome };

    if (d.startsWith("asset_")) {
        const s = d.replace("asset_", "");
        return await generateReport(s);
    }

    if (d.startsWith("tfs_")) {
        const s = d.replace("tfs_", "");
        return { text: `🕒 Timeframes for <b>${s}</b>`, keyboard: kbTimeframes(s) };
    }

    // FINAL FIX
    if (d.startsWith("tf_")) {
        // format: tf_SYMBOL_TF
        // ex: tf_BTCUSDT_15m
        const parts = d.split("_");
        const symbol = parts[1];
        const tf = parts[2];
        return await generateReport(symbol, tf);
    }

    if (d.startsWith("refresh_")) {
        const s = d.replace("refresh_", "");
        return await generateReport(s);
    }

    if (d.startsWith("news_")) {
        const s = d.replace("news_", "");
        const mapped = symbolMap[s] || s;
        const n = await fetchNewsBundle(mapped);
        return {
            text: `📰 <b>News Report</b>\nImpact: ${n.impact}\nSentiment: ${n.sentiment}%`,
            keyboard: kbActions(s)
        };
    }

    if (d.startsWith("ell_")) {
        const s = d.replace("ell_", "");
        const mapped = symbolMap[s] || s;

        const { data } = await resolvePriceAndCandles(mapped, "15m");
        let ell = null;
        try { ell = await analyzeElliott(data.slice(-500)); } catch {}

        if (!ell?.patterns?.length)
            return {
                text: `📊 <b>Elliott Waves</b>\nPattern: N/A\nConfidence: ${ell?.confidence ?? 50}%`,
                keyboard: kbActions(s)
            };

        const det = ell.patterns
            .map(p => `${p.type}(${round(p.conf || p.confidence || 50, 0)}%)`)
            .slice(0, 6)
            .join("\n- ");

        const sc = safeNum(ell.sentiment, 0);
        const tr = sc > 0.15 ? "Bullish" : sc < -0.15 ? "Bearish" : "Neutral";

        return {
            text: `📊 <b>Elliott Waves (15m)</b>\nSentiment: ${tr}\nConfidence: ${Math.round(ell.confidence)}%\n\nPatterns:\n- ${det}`,
            keyboard: kbActions(s)
        };
    }

    return { text: "❌ Unknown command", keyboard: kbHome };
}

