// tg_commands.js — A-Type Premium UI (Old Style) + Heatmap + Multi-TF Elliott + AutoTrend + SmartSignal + ML/Elliott fusion
import TelegramBot from "node-telegram-bot-api";
import CONFIG from "./config.js";
import { fetchMultiTF } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";
import { runMLPrediction } from "./ml_module_v8_6.js"; // best-effort import

const BOT_TOKEN = CONFIG.TELEGRAM.BOT_TOKEN || process.env.BOT_TOKEN;
const CHAT_ID = CONFIG.TELEGRAM.CHAT_ID || process.env.CHAT_ID;
const bot = BOT_TOKEN ? new TelegramBot(BOT_TOKEN, { polling: false }) : null;

// ------------------------
// Helpers
// ------------------------
function safeToFixed(v, d=2){ return (typeof v === 'number' && Number.isFinite(v)) ? v.toFixed(d) : "N/A"; }
function emojiHeat(score){
  // score -1..1 -> red/yellow/green
  if (score >= 0.35) return "🟩";
  if (score >= 0.1) return "🟨";
  return "🟥";
}
function sentimentLabel(score){
  if (score > 0.05) return `Bullish (${(score*100).toFixed(1)}%)`;
  if (score < -0.05) return `Bearish (${(score*100).toFixed(1)}%)`;
  return `Neutral (${(score*100).toFixed(1)}%)`;
}

// produce basic trendlines from pivots (pair consecutive highs or lows into lines)
function computeTrendlinesFromPivots(pivots){
  const highs = pivots.filter(p=>p.type==='H');
  const lows = pivots.filter(p=>p.type==='L');
  const lines = [];
  // take last 3 highs and lows
  if (highs.length >= 2){
    const lastHighs = highs.slice(-3);
    for (let i=0;i<lastHighs.length-1;i++){
      lines.push({ type: 'resistance', fromIdx: lastHighs[i].idx, toIdx: lastHighs[i+1].idx, y1: lastHighs[i].price, y2: lastHighs[i+1].price });
    }
  }
  if (lows.length >= 2){
    const lastLows = lows.slice(-3);
    for (let i=0;i<lastLows.length-1;i++){
      lines.push({ type: 'support', fromIdx: lastLows[i].idx, toIdx: lastLows[i+1].idx, y1: lastLows[i].price, y2: lastLows[i+1].price });
    }
  }
  return lines;
}

// Smart Signal: combine deterministic indicator score + Elliott sentiment + ML prob
function computeSmartSignal({indicatorSignal, ellSentiment=0, mlPrediction=null}){
  // indicatorSignal: "BUY"/"SELL"/"NEUTRAL"
  let score = 0;
  if (indicatorSignal === 'BUY') score += 30;
  if (indicatorSignal === 'SELL') score -= 30;
  // Elliott sentiment - range [-1,1] -> scale +/-40
  score += (ellSentiment || 0) * 40;
  // ML prediction: {label, prob} label "UP"/"DOWN"/"BUY"/"SELL" or "LONG"/"SHORT"
  if (mlPrediction && typeof mlPrediction.prob === 'number'){
    const p = mlPrediction.prob; // 0..1 or percentage
    const prob = p > 1 ? p/100 : p;
    const lab = (mlPrediction.label || "").toString().toUpperCase();
    if (lab.includes("BUY") || lab.includes("UP") || lab.includes("LONG")) score += prob * 40;
    if (lab.includes("SELL") || lab.includes("DOWN") || lab.includes("SHORT")) score -= prob * 40;
  }
  // scoring thresholds
  if (score >= 35) return { label: "STRONG BUY", score };
  if (score >= 10) return { label: "BUY", score };
  if (score <= -35) return { label: "STRONG SELL", score };
  if (score <= -10) return { label: "SELL", score };
  return { label: "NEUTRAL", score };
}

// Helper: try to run ML, fallback gracefully
async function tryRunML(symbol, candles15){
  try{
    // Many ML modules accept candles or symbol; try symbol first then candles
    if (typeof runMLPrediction === 'function'){
      // try symbol
      const r = await runMLPrediction(symbol).catch(()=>null);
      if (r && (r.prob !== undefined || r.confidence !== undefined)) return r;
      // fallback if pass candles supported
      const r2 = await runMLPrediction(candles15).catch(()=>null);
      if (r2 && (r2.prob !== undefined || r2.confidence !== undefined)) return r2;
    }
  } catch(e){}
  return null;
}

// ------------------------
// Build Report (multi-TF + ell per TF)
// ------------------------
export async function buildAIReport(symbol = "BTCUSDT", context = null){
  const tfs = ["1m","5m","15m","30m","1h"];
  const mtfRaw = await fetchMultiTF(symbol, tfs).catch(()=> ({}));
  const mtf = [];

  for (const tf of tfs){
    const entry = mtfRaw[tf] || { data: [], price:0 };
    const candles = entry.data || [];
    const indicatorsObj = {
      RSI: indicators.computeRSI ? indicators.computeRSI(candles) : null,
      MACD: indicators.computeMACD ? indicators.computeMACD(candles) : { hist: 0 },
      ATR: indicators.calculateATR ? indicators.calculateATR(candles) : (indicators.computeATR ? indicators.computeATR(candles) : 0),
      priceTrend: candles.length >=2 ? (candles.at(-1).close > candles.at(-2).close ? "UP" : (candles.at(-1).close < candles.at(-2).close ? "DOWN" : "FLAT")) : "FLAT",
      volumeTrend: indicators.volumeTrend ? indicators.volumeTrend(candles) : "STABLE"
    };
    const vol = indicators.analyzeVolume ? indicators.analyzeVolume(candles) : { status: "N/A" };

    // run Elliott per TF if module present
    let ell = null;
    try{ ell = await analyzeElliott(candles, { atrPeriod:14 }).catch(()=>null); }catch(e){ ell = null; }

    // build
    mtf.push({
      tf,
      candles,
      price: entry.price || 0,
      indicators: indicatorsObj,
      vol,
      ell
    });
  }

  // quick ML run for symbol using 15m candles if available (fusion)
  const candles15 = mtf.find(x=>x.tf==="15m")?.candles || [];
  const ml = await tryRunML(symbol, candles15);

  return {
    symbol,
    price: mtf.find(x=>x.tf==="15m")?.price || mtf[0]?.price || 0,
    mtf,
    ml,
    generatedAt: new Date().toISOString()
  };
}

// ------------------------
// Format + Send (old UI + new sections)
// ------------------------
export async function formatAIReport(report){
  const price = Number(report.price || 0);

  // --- Multi-TF block (old UI) ---
  const tfBlock = report.mtf.map(m => {
    const RSI = (m.indicators.RSI !== null && m.indicators.RSI !== undefined) ? Number(m.indicators.RSI).toFixed(1) : "N/A";
    const MACD = (m.indicators.MACD && m.indicators.MACD.hist !== undefined) ? Number(m.indicators.MACD.hist).toFixed(4) : "N/A";
    const ATR = (m.indicators.ATR !== null && m.indicators.ATR !== undefined) ? Number(m.indicators.ATR).toFixed(2) : "N/A";
    const VOL = m.vol?.status || "N/A";

    // derive simple indicator signal
    let signal = "HOLD";
    if (m.indicators.RSI && m.indicators.MACD && typeof m.indicators.MACD.hist === 'number') {
      if (m.indicators.RSI < 35 && m.indicators.MACD.hist > 0) signal = "BUY";
      else if (m.indicators.RSI > 65 && m.indicators.MACD.hist < 0) signal = "SELL";
    }

    let badge = "⚪";
    if (signal === "BUY") badge = "🟢";
    if (signal === "SELL") badge = "🔴";

    return `
<b>【${m.tf.toUpperCase()}】 ${badge} ${signal}</b>
💰 Price: <b>${m.price}</b>  |  📊 Vol: ${VOL}
RSI: <b>${RSI}</b> | MACD: <b>${MACD}</b> | ATR: <b>${ATR}</b>
`;
  }).join(`\n──────────────\n`);

  // --- Multi-TF Elliott: collect sentiment per TF and trendlines ---
  const ellSummaries = [];
  const heatScores = [];
  const trendlineSummaries = [];
  for (const m of report.mtf){
    const ell = m.ell;
    if (ell && ell.ok){
      ellSummaries.push({ tf: m.tf, sentiment: ell.sentiment, confidence: ell.confidence, patterns: ell.patterns.length });
      heatScores.push({ tf: m.tf, score: ell.sentiment || 0 });
      // compute trendlines from pivots
      const lines = computeTrendlinesFromPivots(ell.pivots || []);
      const tSumm = lines.slice(0,3).map(l => `${l.type}:${safeToFixed(l.y1,2)}->${safeToFixed(l.y2,2)}`).join(", ") || "n/a";
      trendlineSummaries.push({ tf: m.tf, lines: tSumm });
    } else {
      heatScores.push({ tf: m.tf, score: 0 });
      trendlineSummaries.push({ tf: m.tf, lines: "n/a" });
    }
  }

  // build heatmap string row
  const heatRow = heatScores.map(h => `${h.tf.toUpperCase()}:${emojiHeat(h.score)}`).join("  ");

  // Compact Elliott text
  const ellText = ellSummaries.length
    ? ellSummaries.map(e => `${e.tf.toUpperCase()}: ${sentimentLabel(e.sentiment)} | Conf:${e.confidence}% | P:${e.patterns}`).join("\n")
    : "<i>No Elliott data</i>";

  // trendlines summary
  const trendText = trendlineSummaries.map(t => `${t.tf.toUpperCase()}: ${t.lines}`).join("\n");

  // Smart Signals: compute per TF using indicators+Elliott+ML
  const ml = report.ml || null;
  const smartPerTF = report.mtf.map(m=>{
    const indicatorSignal = (()=>{
      if (m.indicators.RSI && m.indicators.MACD && typeof m.indicators.MACD.hist === 'number') {
        if (m.indicators.RSI < 35 && m.indicators.MACD.hist > 0) return "BUY";
        if (m.indicators.RSI > 65 && m.indicators.MACD.hist < 0) return "SELL";
      }
      return "NEUTRAL";
    })();
    const ellSent = (m.ell && m.ell.ok) ? (m.ell.sentiment || 0) : 0;
    const fused = computeSmartSignal({ indicatorSignal, ellSentiment: ellSent, mlPrediction: ml });
    return { tf: m.tf, indicator: indicatorSignal, ell: ellSent, ml: (ml ? (ml.label || "N/A") : "N/A"), smart: fused };
  });

  const smartText = smartPerTF.map(s => `${s.tf.toUpperCase()}: ${s.smart.label} (score:${Math.round(s.smart.score)})`).join("\n");

  // ML fusion summary
  const mlText = ml ? `ML: ${ml.label || "N/A"} | Prob: ${ (ml.prob!==undefined? ( (ml.prob>1)? `${ml.prob}%` : (ml.prob*100).toFixed(1)+"%") : (ml.confidence? `${ml.confidence}%` : "N/A")) }` : "ML: not available";

  // TP/SL: combine 15m ell targets + fallback ATR * multiples
  const ell15 = report.mtf.find(x=>x.tf==="15m")?.ell;
  let tpsText = "TP: n/a";
  let slText = "SL: n/a";
  if (ell15 && ell15.ok){
    const ts = (ell15.targets || []).slice(0,3).map((t,i)=>`TP${i+1}:${safeToFixed(t.tp,2)} (${t.source})`).join(" | ");
    const ss = (ell15.stops || []).slice(0,1).map(s=>`SL:${safeToFixed(s.sl,2)} (${s.source})`).join(" | ");
    if (ts) tpsText = ts;
    if (ss) slText = ss;
  } else {
    // fallback using ATR 15m
    const atr15 = report.mtf.find(x=>x.tf==="15m")?.indicators?.ATR || 0;
    if (atr15){
      tpsText = `TP1:${safeToFixed(price + atr15*1.5,2)} | TP2:${safeToFixed(price + atr15*3,2)} | TP3:${safeToFixed(price + atr15*5,2)}`;
      slText = `SL:${safeToFixed(price - atr15*2,2)}`;
    }
  }

  const fib15 = report.mtf.find(x => x.tf === "15m")?.fib;
  const fibText = fib15 ? `${fib15.lo} - ${fib15.hi}` : "N/A";

  // Final UI text (old style but extended)
  const text = `
🚀 <b>${report.symbol} — AI Trader v11 (A-Type + Fusion)</b>
${new Date(report.generatedAt).toLocaleString()}
Source: Multi (Binance Vision + backups)
Price: <b>${price.toFixed(2)}</b>

📈 <b>Elliott MultiTF Heatmap</b>
${heatRow}

<b>Elliott Details (per-TF)</b>
${ellText}

<b>Trendlines (auto from pivots)</b>
${trendText}

────────────────────
<b>📊 Multi-Timeframe Analysis</b>
${tfBlock}
────────────────────

<b>Smart Signals (Indicator+Elliott+ML Fusion)</b>
${smartText}

${mlText}

🎯 <b>TP/SL (Elliott+ATR fusion)</b>
${tpsText}
${slText}

📐 <b>Fib Zone (15m)</b>: ${fibText}

📰 <b>News Impact:</b> Low (placeholder)
• News module not active / placeholders

<i>vSingleFile — Heatmap + AutoTrend + SmartSignal + ML/Elliott fusion</i>
`.trim();

  // send to telegram
  if (!bot || !CHAT_ID) return text;
  try{
    await bot.sendMessage(CHAT_ID, text, { parse_mode: "HTML", disable_web_page_preview: true });
  }catch(e){
    console.error("Telegram send failed:", e?.message || e);
  }
  return text;
}