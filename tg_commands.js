// ================= TG_COMMANDS.js — AI v12 FULL UPGRADE =================
// NO UI CHANGES — ONLY ENGINE UPGRADED
// Imports remain EXACT as your repo requires

import CONFIG from "./config.js";
import ML from "./ml_module_v8_6.js";    
import News from "./news_social.js";
import { fetchMultiTF, fetchMarketData } from "./utils.js";
import * as indicators from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";

// ---- Extract ML functions (v8.6 compatibility) ----
const {
  runMLPrediction,
  runMicroPrediction,
  calculateAccuracy,
  recordPrediction,
  recordOutcome
} = ML;

// ---- Extract News ----
const { fetchNewsBundle } = News;

// ================= Small Helpers =================
const MAX_TG = 3800;
const nf = (v,d=2)=> (Number.isFinite(v)? Number(v).toFixed(d):"N/A");
const clamp=(v,a=-1,b=1)=> Math.max(a,Math.min(b,v));
const isNum=v=>typeof v==="number"&&Number.isFinite(v);

const IST = { locale:"en-IN", hour12:true, timeZone:"Asia/Kolkata" };
const nowIST=(iso)=>{ try{ return new Date(iso||Date.now()).toLocaleString("en-IN",IST);}catch{ return new Date().toString(); }};

const ellipsis=(s,n=140)=> (typeof s==="string"&&s.length>n? s.slice(0,n-1)+"…":s||"");

// Split into telegram-safe parts
function splitSafe(arr,max=MAX_TG){
  const out=[],tmp=[];
  for(const block of arr){
    if(!block) continue;
    if(block.length<max){
      tmp.push(block);
      continue;
    }
    const chunk = block.match(new RegExp(".{1,"+(max-200)+"}","g"))||[];
    out.push(...chunk);
  }
  return [...tmp,...out];
}

// =======================
//   AI v12 CORE ENGINE
// =======================

// THIS IS THE UPGRADED PART — handles price sync, TF scoring,
// Elliott fusion, volatility normalization, and stable TP clusters.

// --- PRICE SYNC FIX ---
function resolvePrice(blocks){
  // prefer 15m close > market price consistency > fallback
  const p15 = blocks.find(b=>b.tf==="15m")?.price;
  if(isNum(p15)) return p15;
  const any = blocks.find(b=>isNum(b.price));
  return any?.price || 0;
}

// --- ADVANCED TP FUSION (v12 Multi-Layer Cluster Engine) ---
function buildTPClusters(blocks, price){
  const raw=[];
  for(const b of blocks){
    for(const t of (b.targets||[])){
      const tp = Number(t.tp);
      if(!isNum(tp)||tp<=0) continue;
      raw.push({
        tp, 
        conf: clamp(Number(t.confidence||40)/100,0,1),
        dist: Math.abs(tp-price),
        tf: b.tf,
        source: t.source||b.tf
      });
    }
  }
  if(!raw.length) return { longs:[], shorts:[], all:[] };

  // cluster tolerance scales with ATR (dynamic)
  const atr = blocks.find(x=>x.tf==="15m")?.indicators?.ATR || price*0.003;
  const tol = atr*0.4;

  const clusters=[];
  for(const r of raw){
    let c = clusters.find(c=>Math.abs(c.center-r.tp)<=tol);
    if(!c){
      c={ center:r.tp, items:[r] };
      clusters.push(c);
    } else {
      c.items.push(r);
      c.center = c.items.reduce((a,x)=>a+x.tp,0)/c.items.length;
    }
  }

  // compute final cluster confidence
  const final = clusters.map(c=>{
    const avgConf = c.items.reduce((a,x)=>a+x.conf,0)/c.items.length;
    const mainTP = c.items.reduce((best,x)=> x.conf>best.conf?x:best, c.items[0]).tp;
    return {
      tp: Number(mainTP.toFixed(8)),
      confidence: Math.round(avgConf*100),
      tfCount: c.items.length
    };
  });

  const longs = final.filter(x=>x.tp>price).sort((a,b)=>b.confidence-a.confidence).slice(0,4);
  const shorts = final.filter(x=>x.tp<price).sort((a,b)=>b.confidence-a.confidence).slice(0,4);

  return { longs, shorts, all: final };
}

// --- ML x Fusion x News Blend Engine (v12 Smart Weights) ---
function computeOverallFusion(blocks, ml, news){
  const TF_W = { "1m":0.05,"5m":0.1,"15m":0.45,"30m":0.2,"1h":0.2 };
  let s=0,ws=0;
  for(const b of blocks){
    const w = TF_W[b.tf]||0.1;
    s+= (b.fusion||0)*w;
    ws+=w;
  }
  let f = ws?(s/ws):0;

  // ML impact
  if(ml && ml.probs){
    const bull = Number(ml.probs.bull||0)/100;
    const bear = Number(ml.probs.bear||0)/100;
    const mlShift = clamp((bull-bear)*0.45,-0.45,0.45);
    f += mlShift;
  }

  // NEWS impact
  if(news){
    const base = clamp((news.sentiment-0.5)*2,-1,1);
    const imp = String(news.impact||"low").toLowerCase();
    const mul = imp==="high"?0.3 : imp==="moderate"?0.18 : 0.1;
    f += base*mul;
  }

  return clamp(f,-1,1);
}

// --- SL ENGINE v12 (ATR + volatility stability) ---
function computeSL(price, atr){
  if(!isNum(price)||!isNum(atr)) return { longSL:"N/A", shortSL:"N/A" };
  const base = atr*2.2;   // tighter & more stable than v8
  return {
    longSL: Number((price - base).toFixed(8)),
    shortSL: Number((price + base).toFixed(8))
  };
}

// --- Reversal Detector (integrated in v12) ---
function detectReversal(blocks){
  const b15 = blocks.find(b=>b.tf==="15m");
  if(!b15) return "Weak/Unknown";

  const rsi = b15.indicators?.RSI;
  const macd = b15.indicators?.MACD?.hist;
  const ell = b15.ell?.sentiment||0;
  const slope = b15.indicators?.priceTrend;

  // exhaustion logic
  if(rsi>=72 && macd<0) return "Bearish Exhaustion";
  if(rsi<=28 && macd>0) return "Bullish Exhaustion";
  if(ell<-0.45 && slope==="UP") return "Top Reversal Risk";
  if(ell>0.45 && slope==="DOWN") return "Bottom Reversal Risk";

  return "Stable";
}

// ================= TG_COMMANDS.js — PART 2/5 =================
// buildAIReport + core merging logic (ML + News + TP clustering + SL & Hedge sanitization)

export async function buildAIReport(symbol = CONFIG.SYMBOL || "BTCUSDT", opts = {}) {
  try {
    const tfs = Array.isArray(opts.tfs) && opts.tfs.length ? opts.tfs : ["1m","5m","15m","30m","1h"];
    // fetch candles for all tfs
    const mtfRaw = await fetchMultiTF(symbol, tfs);

    // build blocks with indicators, ell, targets
    const blocks = [];
    for (const tf of tfs) {
      const entry = mtfRaw[tf] || { data: [], price: 0 };
      const candles = Array.isArray(entry.data) ? entry.data : [];
      const price = isNum(entry.price) && entry.price > 0 ? entry.price : (candles?.at(-1)?.close ?? 0);

      // compute indicators with safe fallbacks
      const ind = {
        RSI: (typeof indicators.computeRSI === "function") ? indicators.computeRSI(candles) : 50,
        MACD: (typeof indicators.computeMACD === "function") ? indicators.computeMACD(candles) : { hist: 0 },
        ATR: (typeof indicators.computeATR === "function") ? indicators.computeATR(candles) : Math.max(price*0.002, 1),
        priceTrend: (candles.length >= 2) ? (candles.at(-1).close > candles.at(-2).close ? "UP" : (candles.at(-1).close < candles.at(-2).close ? "DOWN" : "FLAT")) : "FLAT",
        volumeTrend: (typeof indicators.volumeTrend === "function") ? indicators.volumeTrend(candles) : "STABLE"
      };

      const vol = (typeof indicators.analyzeVolume === "function") ? indicators.analyzeVolume(candles) : { status: "N/A", strength: 0 };

      // Elliott analysis (best effort)
      let ell = null;
      try { ell = await analyzeElliott(candles); } catch (e) { ell = null; }

      // targets from Elliott or ATR fallback
      let targets = [];
      if (ell && Array.isArray(ell.targets) && ell.targets.length) {
        targets = ell.targets.map(t => ({
          tp: Number(t.tp ?? t.target ?? t.price ?? 0),
          confidence: Math.round(Number(t.confidence ?? ell.confidence ?? 40)),
          source: t.source || t.type || tf,
          ageDays: Number(t.ageDays ?? 0)
        })).filter(t => isNum(t.tp) && t.tp > 0);
      } else {
        const fallbackAtr = Math.max(ind.ATR || 0, Math.max(price * 0.002, 1));
        targets = [
          { tp: Number((price + fallbackAtr * 2).toFixed(8)), confidence: 30, source: "ATR_UP" },
          { tp: Number((price - fallbackAtr * 2).toFixed(8)), confidence: 30, source: "ATR_DOWN" }
        ];
      }

      blocks.push({ tf, price, candles, indicators: ind, vol, ell, targets });
    }

    // compute per-block fusion (more robust weights)
    for (const b of blocks) {
      try {
        const rsi = Number(b.indicators?.RSI ?? 50);
        const macdh = Number(b.indicators?.MACD?.hist ?? 0);
        const atr = Math.max(1, Number(b.indicators?.ATR ?? 1));
        const priceTrendScore = b.indicators?.priceTrend === "UP" ? 0.18 : b.indicators?.priceTrend === "DOWN" ? -0.18 : 0;
        const volScore = (b.indicators?.volumeTrend === "INCREASING") ? 0.08 : (b.indicators?.volumeTrend === "DECREASING") ? -0.08 : 0;
        const rsiScore = ((rsi - 50) / 50) * 0.42;
        const macdScore = Math.tanh(macdh / atr) * 0.36;
        const ellSent = Number(b.ell?.sentiment ?? 0);
        const ellConf = clamp(Number(b.ell?.confidence ?? 0) / 100, 0, 1);
        const ellScore = ellSent * (0.22 * ellConf);

        const raw = rsiScore + macdScore + priceTrendScore + volScore + ellScore;
        b.fusion = Number(clamp(raw, -1, 1).toFixed(4));
      } catch (e) {
        b.fusion = 0;
      }
    }

    // Resolve canonical price (prefer 15m)
    const reportPrice = resolvePrice(blocks);

    // Cluster TPs across TFs
    const clusters = buildTPClusters(blocks, reportPrice);

    // Call ML module (best-effort) — prefer 15m
    let ml = null;
    try { if (typeof runMLPrediction === "function") ml = await runMLPrediction(symbol, opts.mlTF || "15m", opts.mlOpts || {}); } catch (e) { ml = null; }

    // Micro ML
    let micro = null;
    try { if (typeof runMicroPrediction === "function") micro = await runMicroPrediction(symbol, "1m"); } catch (e) { micro = null; }

    // Fetch news bundle
    let news = null;
    try { news = await fetchNewsBundle(symbol); } catch (e) { news = { ok:false, sentiment:0.5, impact:"low", items:[] }; }

    // overall fusion merge
    const overallFusion = computeOverallFusion(blocks, ml, news);

    // ATR selection (prefer 15m -> 5m -> 1m -> price*0.002)
    const atrFromTF = (() => {
      const p15 = blocks.find(x=>x.tf==="15m")?.indicators?.ATR;
      const p5 = blocks.find(x=>x.tf==="5m")?.indicators?.ATR;
      const p1 = blocks.find(x=>x.tf==="1m")?.indicators?.ATR;
      return Math.max(p15||0, p5||0, p1||0, reportPrice * 0.0008);
    })();

    // default SLs
    const sls = computeSL(reportPrice, atrFromTF);

    // sanitize ML output into sanitized structure (primaryTH, hedgeTP)
    let mlSanitized = null;
    if (ml) {
      try {
        const mlDir = String(ml.direction || ml.label || (ml.probs && (ml.probs.bull > ml.probs.bear ? "Bullish" : "Bearish")) || "Neutral").toLowerCase();
        // extract primary TP candidate from ml or clusters
        let primaryTP = (isNum(ml.tpEstimate) ? ml.tpEstimate : null) || (clusters.longs.length && mlDir.includes("bull") ? clusters.longs[0].tp : (clusters.shorts.length && mlDir.includes("bear") ? clusters.shorts[0].tp : null));
        const minTPdist = Math.max(reportPrice * 0.002, atrFromTF * 0.6, 1);
        if (isNum(primaryTP) && Math.abs(primaryTP - reportPrice) < minTPdist) {
          // push out
          primaryTP = mlDir.includes("bull") ? Number((reportPrice + minTPdist).toFixed(8)) : mlDir.includes("bear") ? Number((reportPrice - minTPdist).toFixed(8)) : null;
        }

        // hedge selection: prefer opposite cluster
        let hedgeTP = null;
        if (mlDir.includes("bull")) hedgeTP = clusters.shorts[0]?.tp ?? null;
        else if (mlDir.includes("bear")) hedgeTP = clusters.longs[0]?.tp ?? null;
        else hedgeTP = clusters.shorts[0]?.tp ?? clusters.longs[0]?.tp ?? null;

        // fallback hedge via ATR offset
        if (!isNum(hedgeTP) && isNum(primaryTP)) {
          const hedgeOffset = Math.max(minTPdist * 0.6, atrFromTF * 0.6);
          hedgeTP = mlDir.includes("bull") ? Number((reportPrice - hedgeOffset).toFixed(8)) : mlDir.includes("bear") ? Number((reportPrice + hedgeOffset).toFixed(8)) : null;
        }

        // compute calibrated confidence
        let baseConf = isNum(ml.tpConfidence) ? ml.tpConfidence : (isNum(ml.maxProb) ? ml.maxProb : 50);
        // penalize if contradicting fusion
        const fusionBias = overallFusion > 0.12 ? "bull" : overallFusion < -0.12 ? "bear" : "neutral";
        if ((fusionBias === "bull" && mlDir.includes("bear")) || (fusionBias === "bear" && mlDir.includes("bull"))) baseConf *= 0.55;
        if (news && String(news.impact || "").toLowerCase() === "high") baseConf *= 0.8;
        baseConf = Math.round(clamp(baseConf, 5, 99));

        mlSanitized = {
          direction: ml.direction || ml.label || "Neutral",
          primaryTP: isNum(primaryTP) ? Number(primaryTP) : null,
          primaryConf: baseConf,
          hedgeTP: isNum(hedgeTP) ? Number(hedgeTP) : null,
          hedgeConf: isNum(hedgeTP) ? Math.round(clamp(100 - baseConf, 10, 90)) : null
        };
      } catch (e) {
        mlSanitized = null;
      }
    }

    // final trade suggestions: pick top cluster TPs near price
    const pickRange = (arr)=> arr.length ? arr.slice(0,3).map(x=>({ tp: x.tp, conf: x.confidence })) : [];
    const finalLongs = pickRange(clusters.longs);
    const finalShorts = pickRange(clusters.shorts);

    // assemble final report
    const report = {
      ok: true,
      symbol,
      generatedAt: new Date().toISOString(),
      nowIST: nowIST(),
      price: reportPrice,
      blocks,
      atr15: atrFromTF,
      overallFusion,
      biasLabel: (() => {
        if (!isNum(overallFusion)) return { emoji: "⚪", label: "Neutral" };
        if (overallFusion >= 0.7) return { emoji: "🟩", label: "Strong Buy" };
        if (overallFusion >= 0.2) return { emoji: "🟦", label: "Buy" };
        if (overallFusion > -0.2 && overallFusion < 0.2) return { emoji: "⚪", label: "Neutral" };
        if (overallFusion <= -0.2 && overallFusion > -0.7) return { emoji: "🟧", label: "Sell" };
        return { emoji: "🟥", label: "Strong Sell" };
      })(),
      longs: finalLongs,
      shorts: finalShorts,
      allTargets: clusters.all,
      ml: ml || null,
      mlSanitized,
      micro,
      news,
      defaultSLLong: sls.longSL,
      defaultSLShort: sls.shortSL,
      mlAcc: (typeof calculateAccuracy === "function") ? calculateAccuracy()?.accuracy ?? 0 : 0
    };

    // best-effort persistence
    try { if (typeof recordPrediction === "function") recordPrediction({ id: `${symbol}_${Date.now()}`, symbol, ml: report.ml || null }); } catch (e) {}

    return report;

  } catch (err) {
    return { ok:false, error: err?.message || String(err) };
  }
}

// ================= TG_COMMANDS.js — PART 3/3 =================
// Helpers (resolvePrice, cluster TPs, overall fusion), formatter, sender, default export

// ----- helper: resolve canonical price (prefer 15m) -----
function resolvePrice(blocks) {
  const by15 = blocks.find(b => b.tf === "15m");
  if (by15 && isNum(by15.price) && by15.price > 0) return by15.price;
  for (const b of blocks) if (isNum(b.price) && b.price > 0) return b.price;
  return 0;
}

// ----- helper: buildTPClusters (dedupe, separate longs/shorts, sort by confidence+proximity) -----
function buildTPClusters(blocks, price) {
  const raw = [];
  for (const b of blocks) {
    for (const t of (b.targets || [])) {
      const tp = Number(t.tp || 0);
      if (!isNum(tp) || tp <= 0) continue;
      const conf = clamp(Number(t.confidence ?? 40), 0, 100);
      raw.push({ tp, confidence: Math.round(conf), source: t.source || b.tf, tf: b.tf });
    }
  }
  // if none, use ATR fallback per-block
  if (!raw.length) {
    const fallbackAtr = Math.max(...blocks.map(b => b.indicators?.ATR || 0), price * 0.002 || 1);
    raw.push({ tp: Number((price + fallbackAtr * 2).toFixed(8)), confidence: 30, source: "ATR_UP" });
    raw.push({ tp: Number((price - fallbackAtr * 2).toFixed(8)), confidence: 30, source: "ATR_DOWN" });
  }

  // dedupe into buckets by rounding and keep best confidence
  const map = new Map();
  for (const r of raw) {
    const key = Math.round(r.tp);
    if (!map.has(key) || (r.confidence || 0) > (map.get(key).confidence || 0)) map.set(key, r);
  }
  let all = Array.from(map.values());

  // compute proximity score and sort by confidence then closeness
  all = all.map(a => ({ ...a, dist: Math.abs(a.tp - price) }))
           .sort((A,B) => (B.confidence - A.confidence) || (A.dist - B.dist));

  const longs = all.filter(x => x.tp > price).sort((a,b) => (b.confidence - a.confidence) || (a.dist - b.dist));
  const shorts = all.filter(x => x.tp < price).sort((a,b) => (b.confidence - a.confidence) || (a.dist - b.dist));

  return { all, longs, shorts };
}

// ----- helper: compute overall fusion (blocks + ml + news nudges) -----
function computeOverallFusion(blocks, ml=null, news=null) {
  const TF_WEIGHTS = { "1m":0.05, "5m":0.1, "15m":0.4, "30m":0.2, "1h":0.25 };
  let s=0, ws=0;
  for (const b of blocks) {
    const w = TF_WEIGHTS[b.tf] ?? 0.1;
    s += (b.fusion || 0) * w;
    ws += w;
  }
  let overall = ws ? Number(clamp(s/ws, -1, 1).toFixed(4)) : 0;

  // ML nudge
  if (ml && ml.probs) {
    const bprob = Number(ml.probs.bull ?? ml.probs?.Bull ?? 0);
    const rprob = Number(ml.probs.bear ?? ml.probs?.Bear ?? 0);
    if (isNum(bprob) && isNum(rprob)) {
      const mlBoost = clamp((bprob - rprob) / 100, -1, 1);
      overall = clamp(overall + mlBoost * 0.22, -1, 1);
    }
  }

  // News nudge
  if (news && typeof news.sentiment === "number") {
    const raw = clamp((news.sentiment - 0.5) * 2, -1, 1);
    const impact = (news.impact || "low").toString().toLowerCase();
    const mul = impact === "high" ? 1.0 : impact === "moderate" ? 0.6 : 0.25;
    const newsBoost = clamp(raw * mul, -1, 1);
    overall = clamp(overall + newsBoost * 0.18, -1, 1);
  }

  return overall;
}

// ----- helper: compute default SLs -----
function computeSL(price, atr) {
  const safeAtr = Math.max(atr || 0, Math.max(price * 0.0008, 0.0001), 1);
  const longSL = isNum(price) ? Number((price - safeAtr * 2).toFixed(8)) : null;
  const shortSL = isNum(price) ? Number((price + safeAtr * 2).toFixed(8)) : null;
  return { longSL, shortSL };
}

// -------------------- Formatter: produce Telegram UI (full) --------------------
export async function formatAIReport(report = {}) {
  try {
    if (!report || !report.ok) return `<b>⚠️ Error building report</b>\n${report?.error || "no data"}`;

    const symbol = report.symbol || "SYMBOL";
    const time = nowIST(report.generatedAt || new Date().toISOString());
    const price = Number(report.price || 0);

    // helper to build per-TF block text
    const getBlock = (tf) => {
      const b = (report.blocks || []).find(x => x.tf === tf);
      if (!b) return null;
      const fusion = Number(b.fusion ?? 0);
      let sigText = "⚪ NEUTRAL";
      if (fusion >= 0.7) sigText = "🟩 STRONG BUY";
      else if (fusion >= 0.2) sigText = "🟦 BUY";
      else if (fusion <= -0.2 && fusion > -0.7) sigText = "🔴 SELL";
      else if (fusion <= -0.7) sigText = "🔴🔴 STRONG SELL";

      const rsi = isNum(b.indicators?.RSI) ? Math.round(b.indicators.RSI) : "N/A";
      const macd = isNum(b.indicators?.MACD?.hist) ? Math.round(b.indicators.MACD.hist) : "N/A";
      const volTxt = b.vol?.status || (b.indicators?.volumeTrend || "N/A");
      const atr = isNum(b.indicators?.ATR) ? Number(b.indicators.ATR) : "N/A";

      const ellConf = (b.ell && isNum(b.ell.confidence)) ? Math.round(b.ell.confidence) : (b.ellSummary?.confidence ? Math.round(b.ellSummary.confidence) : 0);
      const ellShow = (b.ell && Array.isArray(b.ell.patterns) && b.ell.patterns.length) ? b.ell.patterns[0].type : (b.ell?.pattern || "No clear wave");
      const S = b.ellSummary?.support ?? "N/A";
      const R = b.ellSummary?.resistance ?? "N/A";
      const tps = (b.targets || []).slice(0,3).map(t => nf(t.tp,2));
      const tpLine = tps.length ? tps.join(" / ") : "N/A";
      const sl = (b.targets && b.targets[0] && b.targets[0].suggestedSL) ? nf(b.targets[0].suggestedSL,2) : "N/A";

      return {
        sig: sigText, rsi, macd, vol: volTxt, atr: nf(atr,2), ell: ellShow, ellConf,
        s: (isNum(S) ? nf(S,2) : (S || "N/A")), r: (isNum(R) ? nf(R,2) : (R || "N/A")),
        tpLine, sl, price: nf(b.price,2)
      };
    };

    const b1m = getBlock("1m") || {}, b5m = getBlock("5m") || {}, b15m = getBlock("15m") || {}, b30m = getBlock("30m") || {}, b1h = getBlock("1h") || {};

    const finalBias = `${report.biasLabel?.emoji ?? "⚪"} ${report.biasLabel?.label ?? "Neutral"}`;
    const fusionScore = (report.overallFusion != null) ? String(report.overallFusion) : "0";
    const buyProb = nf(report.buyProb,2);
    const sellProb = nf(report.sellProb,2);

    const longs = report.longs || [];
    const shorts = report.shorts || [];
    const bullTP1 = longs.length ? nf(Math.min(...longs.map(x=>x.tp)),2) : (b1h.r || "N/A");
    const bullTP2 = longs.length ? nf(Math.max(...longs.map(x=>x.tp)),2) : (b30m.r || "N/A");
    const bearTP1 = shorts.length ? nf(Math.min(...shorts.map(x=>x.tp)),2) : (b1m.s || "N/A");
    const bearTP2 = shorts.length ? nf(Math.max(...shorts.map(x=>x.tp)),2) : (b5m.s || "N/A");

    const neutralSL = (report.atr15 != null && isNum(report.price)) ? nf(Number((report.price - report.atr15).toFixed(2)),2) : nf(report.defaultSLLong,2);

    // ML sanitized / raw
    const ml = report.ml || {};
    const mlSan = report.mlSanitized || {};
    const mlDir = mlSan.direction || ml.direction || ml.label || "Neutral";
    const mlConf = (() => {
      if (mlSan && isNum(mlSan.primaryConf)) return nf(mlSan.primaryConf,0);
      if (ml.tpConfidence != null) return nf(ml.tpConfidence,0);
      if (ml.maxProb != null) return nf(ml.maxProb,0);
      return nf((ml.probs && (ml.probs.bull || ml.probs.bear || ml.probs.neutral)) ? Math.max(Number(ml.probs.bull||0), Number(ml.probs.bear||0), Number(ml.probs.neutral||0)) : (ml.maxProb || 0), 0);
    })();

    const mlPrimaryTP = (mlSan && isNum(mlSan.primaryTP)) ? nf(mlSan.primaryTP,2) : (ml && isNum(ml.tpEstimate) ? nf(ml.tpEstimate,2) : "N/A");
    const mlHedgeTP = (mlSan && isNum(mlSan.hedgeTP)) ? nf(mlSan.hedgeTP,2) : (ml && isNum(ml.hedgeTP) ? nf(ml.hedgeTP,2) : "N/A");

    const mlQuote = ellipsis((ml.explanation || ml.reason || ml.summary || ml.quote || "AI forecast active"), 280);

    const news = report.news || {};
    const newsImpact = news.impact || (news.impact === 0 ? "Low" : "Low");
    const newsSentimentPct = (typeof news.sentiment === "number") ? Math.round(news.sentiment * 1000) / 10 : "N/A";
    const headline = (news.items && news.items.length) ? (news.items[0].title || news.items[0].text || news.items[0].link || "—") : (news.headline || "No major events");

    const topSection = `
🔥 ${symbol} — AI Market Intelligence
Time (IST): ${time}
Price: ${nf(price,2)}
━━━━━━━━━━━━━━━━━━

📊 MULTI-TIMEFRAME PANEL
(Short | Clean | Cluster-Free)
`.trim();

    const tfBlocks = `
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
`.trim();

    const summary = `
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
`.trim();

    const mlSection = `
🤖 MACHINE LEARNING FORECAST (AI TP Guarantee Mode)
Direction: ${mlDir}
ML Confidence: ${mlConf}%

📌 ML Says:
“${mlQuote}”

ML Targets:
• ML Primary TP: <b>${mlPrimaryTP}</b>
• ML Hedge TP: ${mlHedgeTP}
━━━━━━━━━━━━━━━━━━
`.trim();

    const newsSection = `
📰 NEWS IMPACT (Connected to ML)
Impact: ${newsImpact}
Sentiment: ${newsSentimentPct}%
Headline: *“${ellipsis(headline,200)}”*
━━━━━━━━━━━━━━━━━━`.trim();

    const full = [topSection, tfBlocks, summary, mlSection, newsSection].join("\n\n");
    const parts = splitIntoSafeParts([full], MAX_TG_CHARS);
    if (parts.length > 1) return parts.map((p,i) => `<b>${symbol} — AI Market Intelligence (Part ${i+1}/${parts.length})</b>\n\n` + p);
    return [full];

  } catch (e) {
    return [`<b>formatAIReport error</b>\n${e?.message || String(e)}`];
  }
}

// -------------------- sendSplitReport helper --------------------
export async function sendSplitReport(report, sendTelegramFunc) {
  try {
    const parts = await formatAIReport(report);
    if (!parts || !parts.length) return false;
    for (let i=0;i<parts.length;i++) {
      const text = parts[i];
      try {
        await sendTelegramFunc(text);
      } catch (e) {
        // retry once after short delay
        await new Promise(r=>setTimeout(r,600));
        try { await sendTelegramFunc(text); } catch (err) { /* ignore */ }
      }
      // slight pacing between parts
      if (i < parts.length - 1) await new Promise(r=>setTimeout(r,650));
    }
    return true;
  } catch (e) {
    return false;
  }
}

// default export (compat)
export default {
  buildAIReport,
  formatAIReport,
  sendSplitReport
};