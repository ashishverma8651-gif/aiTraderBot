// utils.js — Robust multi-source fetch + caching + synthetic fallback
import axios from "axios";
import fs from "fs";
import path from "path";
import CONFIG from "./config.js";

const CACHE_DIR = CONFIG.PATHS?.CACHE_DIR || path.resolve("./cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const DEFAULT_TIMEOUT = 12000;
const DEFAULT_RETRIES = CONFIG.FALLBACK?.MAX_RETRIES || 3;
const RETRY_DELAY = CONFIG.FALLBACK?.RETRY_DELAY_MS || 500;
const EXTERNAL_PROXY_SERVICES = [
  "https://api.codetabs.com/v1/proxy?quest=",
  "https://api.allorigins.win/raw?url=",
  "https://corsproxy.io/?"
];

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function safeNum(x,d=0){ const n=Number(x); return Number.isFinite(n)?n:d; }
function tfSafe(tf="15m"){ return String(tf).replace(/[^a-z0-9]/gi,"_"); }
function symSafe(s=""){ return String(s||"").toUpperCase().replace(/[^A-Z0-9_\-\.\^]/g,"_"); }
function cachePath(symbol, interval){ return path.join(CACHE_DIR, `${symSafe(symbol)}_${tfSafe(interval)}.json`); }
function readCache(symbol, interval){
  try{ const p=cachePath(symbol,interval); if(!fs.existsSync(p)) return null; return JSON.parse(fs.readFileSync(p,"utf8")||"null"); }catch(e){return null;}
}
function writeCache(symbol, interval, data){
  try{ fs.writeFileSync(cachePath(symbol,interval), JSON.stringify({ fetchedAt: Date.now(), data }, null, 2)); }catch {}
}
function lastGoodPrice(symbol){
  try{
    const s = symSafe(symbol);
    const files = fs.readdirSync(CACHE_DIR).filter(f => f.startsWith(s + "_"));
    files.sort((a,b)=>fs.statSync(path.join(CACHE_DIR,b)).mtimeMs - fs.statSync(path.join(CACHE_DIR,a)).mtimeMs);
    for(const f of files){
      try{ const obj=JSON.parse(fs.readFileSync(path.join(CACHE_DIR,f),"utf8")||"{}"); const arr=obj?.data; if(Array.isArray(arr)&&arr.length){ const last=arr.at(-1); if(last && Number.isFinite(+last.close)) return Number(last.close);} }catch{}
    }
  }catch{}
  return null;
}

function generateSyntheticCandles({ lastPrice=100, count=200, intervalMs=60_000 }){
  const out=[]; const base = safeNum(lastPrice,100); const atr = Math.max(base*0.002, base*0.005);
  let t = Date.now() - (count-1)*intervalMs; let prev = base;
  for(let i=0;i<count;i++){
    const noise = (Math.random()-0.5) * atr * (0.6 + Math.random()*1.4);
    const open = prev;
    const close = Math.max(0.0000001, prev + noise);
    const high = Math.max(open, close) + Math.abs(noise)*Math.random();
    const low = Math.min(open, close) - Math.abs(noise)*Math.random();
    const vol = Math.round(Math.abs(noise)*1000 + Math.random()*100);
    out.push({ t, open: +open, high: +high, low: +low, close: +close, vol });
    prev = close; t += intervalMs;
  }
  return out;
}

// normalizers
function normalizeKlineArray(arr){
  if(!Array.isArray(arr)) return [];
  if(Array.isArray(arr[0])){
    try{
      const out = arr.map(k=>({ t: Number(k[0]), open: safeNum(k[1]), high: safeNum(k[2]), low: safeNum(k[3]), close: safeNum(k[4]), vol: safeNum(k[5],0) }))
        .filter(c=>Number.isFinite(c.t) && Number.isFinite(c.close));
      out.sort((a,b)=>a.t-b.t);
      return out;
    }catch{}
  }
  if(arr.length && typeof arr[0] === "object"){
    const out = arr.map(c=>({
      t: Number(c.t||c.timestamp||c.time||0),
      open: safeNum(c.open??c.o),
      high: safeNum(c.high??c.h),
      low: safeNum(c.low??c.l),
      close: safeNum(c.close??c.c),
      vol: safeNum(c.vol??c.volume||0)
    })).filter(c=>Number.isFinite(c.t) && Number.isFinite(c.close)).sort((a,b)=>a.t-b.t);
    return out;
  }
  return [];
}

function normalizeYahooChart(res){
  try{
    if(!res || !res.chart || !Array.isArray(res.chart.result) || !res.chart.result[0]) return [];
    const r = res.chart.result[0];
    const ts = r.timestamp || [];
    const q = r.indicators?.quote?.[0] || {};
    const out=[];
    for(let i=0;i<ts.length;i++){
      const close = q.close?.[i];
      if(!Number.isFinite(close)) continue;
      out.push({ t: Number(ts[i])*1000, open: safeNum(q.open?.[i], close), high: safeNum(q.high?.[i], close), low: safeNum(q.low?.[i], close), close: safeNum(close), vol: safeNum(q.volume?.[i],0) });
    }
    out.sort((a,b)=>a.t-b.t);
    return out;
  }catch{ return []; }
}

// axios safeGet
async function safeGet(url, { timeout = DEFAULT_TIMEOUT, responseType = "json", mirrors = [], tryProxies = true } = {}){
  if(!url) return null;
  for(let attempt=0; attempt<Math.max(1,DEFAULT_RETRIES); attempt++){
    try{
      const r = await axios.get(url, { timeout, responseType, headers: { "User-Agent": "AI-Trader-Utils/1.0", Accept: "*/*" } });
      if(r?.data !== undefined && r?.data !== null) return r.data;
    }catch{}
    await sleep(RETRY_DELAY + Math.random()*100);
  }
  for(const base of mirrors || []){
    try{
      const u = new URL(url);
      const final = base.replace(/\/+$/,"") + u.pathname + u.search;
      for(let attempt=0; attempt<Math.max(1,DEFAULT_RETRIES); attempt++){
        try{
          const r = await axios.get(final, { timeout, responseType, headers: { "User-Agent": "AI-Trader-Utils/1.0" } });
          if(r?.data !== undefined && r?.data !== null) return r.data;
        }catch{}
        await sleep(RETRY_DELAY + Math.random()*100);
      }
    }catch{}
  }
  if(tryProxies){
    for(const pbase of EXTERNAL_PROXY_SERVICES){
      try{
        const prox = pbase + encodeURIComponent(url);
        for(let attempt=0; attempt<Math.max(1,DEFAULT_RETRIES); attempt++){
          try{
            const r = await axios.get(prox, { timeout: DEFAULT_TIMEOUT, responseType: "text", headers: { "User-Agent": "AI-Trader-Utils/1.0" } });
            if(r?.data !== undefined && r?.data !== null) return r.data;
          }catch{}
          await sleep(RETRY_DELAY + Math.random()*100);
        }
      }catch{}
    }
  }
  return null;
}

// interval ms
function intervalToMs(interval="15m"){
  const v = String(interval).toLowerCase();
  if(v.endsWith("m")) return Number(v.slice(0,-1)) * 60_000;
  if(v.endsWith("h")) return Number(v.slice(0,-1)) * 60*60_000;
  if(v.endsWith("d")) return Number(v.slice(0,-1)) * 24*60*60_000;
  return 60_000;
}

// --------------- Market-specific fetchers ---------------

// crypto (binance primary)
async function fetchCrypto(symbol, interval="15m", limit=500){
  const s = String(symbol||"").toUpperCase();
  if(!s) return { data: [], price: null };
  const sources = CONFIG.API?.BINANCE || ["https://api.binance.com"];
  const base = sources[0].replace(/\/+$/,"");
  const url = `${base}/api/v3/klines?symbol=${encodeURIComponent(s)}&interval=${encodeURIComponent(interval)}&limit=${Number(limit)}`;
  const mirrors = sources.slice(1);
  const cached = readCache(s, interval);
  try{
    const raw = await safeGet(url, { responseType: "json", mirrors });
    if(Array.isArray(raw) && raw.length){
      const k = normalizeKlineArray(raw);
      if(k.length){ writeCache(s, interval, k); return { data: k, price: k.at(-1)?.close ?? lastGoodPrice(s) }; }
    }
  }catch{}
  // try Yahoo by common mapping (BTC-USD etc)
  try{
    const yf = (CONFIG.API?.YAHOO?.[0]||"https://query1.finance.yahoo.com/v8/finance/chart").replace(/\/+$/,"");
    const tf = interval === "1m" ? "1m" : interval === "5m" ? "5m" : interval === "15m" ? "15m" : interval === "30m" ? "30m" : "60m";
    // try BTC-USD style
    const altSym = s.replace("USDT","-USD").replace("BTC","BTC");
    const yurl = `${yf}/${encodeURIComponent(altSym)}?interval=${tf}&range=7d`;
    const yraw = await safeGet(yurl, { responseType: "json" });
    const ky = normalizeYahooChart(yraw);
    if(ky.length){ writeCache(s, interval, ky); return { data: ky, price: ky.at(-1)?.close ?? lastGoodPrice(s) }; }
  }catch{}
  if(cached && Array.isArray(cached.data) && cached.data.length) return { data: cached.data, price: cached.data.at(-1)?.close ?? lastGoodPrice(s) };
  const synthetic = generateSyntheticCandles({ lastPrice: lastGoodPrice(s) || 100, count: Math.min(500, limit), intervalMs: intervalToMs(interval) });
  writeCache(s, interval, synthetic);
  return { data: synthetic, price: synthetic.at(-1)?.close ?? lastGoodPrice(s) };
}

// yahoo generic (stocks/indices/commodities/forex)
async function fetchYahoo(symbol, interval="15m"){
  const s = String(symbol||"").trim();
  if(!s) return { data: [], price: null };
  const base = (CONFIG.API?.YAHOO?.[0] || "https://query1.finance.yahoo.com/v8/finance/chart").replace(/\/+$/,"");
  const tfmap = { "1m":{interval:"1m",range:"1d"}, "5m":{interval:"5m",range:"5d"}, "15m":{interval:"15m",range:"5d"}, "30m":{interval:"30m",range:"1mo"}, "1h":{interval:"60m",range:"1mo"} }[interval] || {interval:"15m",range:"5d"};
  const url = `${base}/${encodeURIComponent(s)}?interval=${tfmap.interval}&range=${tfmap.range}`;
  const cached = readCache(s, interval);
  try{
    const res = await safeGet(url, { responseType:"json", mirrors: CONFIG.API?.YAHOO || [] });
    const k = normalizeYahooChart(res);
    if(k.length){ writeCache(s, interval, k); return { data: k, price: k.at(-1)?.close ?? lastGoodPrice(s) }; }
  }catch{}
  if(cached && Array.isArray(cached.data) && cached.data.length) return { data: cached.data, price: cached.data.at(-1)?.close ?? lastGoodPrice(s) };
  const synthetic = generateSyntheticCandles({ lastPrice: lastGoodPrice(s) || 100, count: 200, intervalMs: intervalToMs(interval) });
  writeCache(s, interval, synthetic);
  return { data: synthetic, price: synthetic.at(-1)?.close ?? lastGoodPrice(s) };
}

// exchangerate (for forex quick price)
async function fetchExchangeRatePair(symbol, interval="15m"){
  try{
    const s = String(symbol||"").replace("=","").replace("/","");
    if(!s || s.length < 6) return { data: [], price: null };
    const b = s.slice(0,3), q = s.slice(3,6);
    const base = CONFIG.API?.EXCHANGERATE || "https://api.exchangerate.host";
    const url = `${base}/latest?base=${encodeURIComponent(b)}&symbols=${encodeURIComponent(q)}`;
    const raw = await safeGet(url, { responseType: "json" });
    const rate = raw && raw.rates ? (raw.rates[q] || Object.values(raw.rates)[0]) : null;
    if(typeof rate === "number"){
      const now = Date.now();
      const candle = [{ t: now - 60000, open: rate, high: rate, low: rate, close: rate, vol: 0 }];
      writeCache(symbol, interval, candle);
      return { data: candle, price: rate };
    }
  }catch{}
  return { data: [], price: null };
}

// unified router
export async function fetchUniversal(inputSymbol, interval="15m"){
  try{
    const raw = String(inputSymbol||"").trim();
    if(!raw) return { data: [], price: null };
    // detect market via CONFIG.SYMBOLS maps
    const maps = CONFIG.SYMBOLS || {};
    const findIn = (market) => { const m = maps[market] || {}; return (m && (m[raw] || Object.keys(m).includes(raw))); };
    const isCrypto = !!(maps.CRYPTO && (maps.CRYPTO[raw] || Object.keys(maps.CRYPTO).includes(raw)));
    const isIndia = !!(maps.INDIA && (maps.INDIA[raw] || Object.keys(maps.INDIA).includes(raw)));
    const isForex = !!(maps.FOREX && (maps.FOREX[raw] || Object.keys(maps.FOREX).includes(raw)));
    const isCommodity = !!(maps.COMMODITIES && (maps.COMMODITIES[raw] || Object.keys(maps.COMMODITIES).includes(raw)));

    // forced active market
    const forced = (CONFIG.ACTIVE_MARKET || "").toUpperCase();

    if(forced === "CRYPTO" || isCrypto) return await fetchCrypto(raw, interval, CONFIG.DEFAULT_LIMIT || 500);
    if(forced === "INDIA" || isIndia){
      const mapping = (maps.INDIA && maps.INDIA[raw]) ? (maps.INDIA[raw].yahoo || raw) : raw;
      return await fetchYahoo(mapping, interval);
    }
    if(forced === "FOREX" || isForex){
      const mapping = (maps.FOREX && maps.FOREX[raw]) ? (maps.FOREX[raw].yahoo || raw) : raw;
      // try exchangerate quick
      const ex = await fetchExchangeRatePair(mapping, interval);
      if(ex && ex.price) return ex;
      return await fetchYahoo(mapping, interval);
    }
    if(forced === "COMMODITIES" || isCommodity){
      const mapping = (maps.COMMODITIES && maps.COMMODITIES[raw]) ? (maps.COMMODITIES[raw].yahoo || raw) : raw;
      return await fetchYahoo(mapping, interval);
    }
    // fallback: try crypto then yahoo
    const c = await fetchCrypto(raw, interval, CONFIG.DEFAULT_LIMIT || 200);
    if(c && c.data && c.data.length) return c;
    return await fetchYahoo(raw, interval);
  }catch(e){
    console.log("fetchUniversal error:", e?.message || e);
    const cached = readCache(inputSymbol, interval);
    if(cached && cached.data && cached.data.length) return { data: cached.data, price: cached.data.at(-1)?.close ?? lastGoodPrice(inputSymbol) };
    const synthetic = generateSyntheticCandles({ lastPrice: lastGoodPrice(inputSymbol) || 100, count: 200, intervalMs: intervalToMs(interval) });
    writeCache(inputSymbol, interval, synthetic);
    return { data: synthetic, price: synthetic.at(-1)?.close ?? null };
  }
}

// fetchMultiTF
export async function fetchMultiTF(symbol, tfs = ["1m","5m","15m","30m","1h"]){
  const out = {};
  const promises = tfs.map(tf => (async ()=>{
    try{ await sleep(Math.random()*120+20); out[tf] = await fetchUniversal(symbol, tf); }catch(e){ out[tf] = { data: [], price: null }; }
  })());
  await Promise.all(promises);
  return out;
}

// compatibility wrapper (legacy)
export async function fetchMarketData(symbol, interval="15m", limit=200){
  const r = await fetchUniversal(symbol, interval);
  return { data: r.data || [], price: r.price ?? lastGoodPrice(symbol) ?? null, updated: new Date().toISOString() };
}

export async function fetchPrice(symbol){
  try{
    const s = String(symbol||"").trim();
    if(!s) return null;
    // try fetchUniversal 1m
    const u = await fetchUniversal(s, "1m");
    if(u && u.price) return u.price;
    // last cached
    const last = lastGoodPrice(s);
    if(last) return last;
    return null;
  }catch{return null;}
}

// exports
export default {
  fetchMarketData, fetchUniversal, fetchMultiTF, fetchPrice
};

export { fetchMarketData, fetchUniversal, fetchMultiTF, fetchPrice };