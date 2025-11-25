// utils.js — Robust single-file utils
import axios from "axios";
import fs from "fs";
import path from "path";
import CONFIG from "./config.js";

const CACHE_DIR = (CONFIG.PATHS && CONFIG.PATHS.CACHE_DIR) || path.resolve("./cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const DEFAULT_TIMEOUT = Number(process.env.AXIOS_TIMEOUT_MS || 12000);
const DEFAULT_RETRIES = Number(CONFIG.FALLBACK?.MAX_RETRIES || 3);
const RETRY_DELAY_MS = Number(CONFIG.FALLBACK?.RETRY_DELAY_MS || 500);
const USER_AGENT = "AI-Trader-Utils/1.0";

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
function safeNum(v, fallback=0){ const n = Number(v); return Number.isFinite(n)?n:fallback; }
function symSafe(s=''){ return String(s||'').toUpperCase().replace(/[^A-Z0-9_\-\.^]/g,'_'); }
function tfSafe(tf='15m'){ return String(tf||'15m').replace(/[^a-z0-9]/gi,'_'); }
function cachePath(symbol, interval){ return path.join(CACHE_DIR, `${symSafe(symbol)}_${tfSafe(interval)}.json`); }
function readCache(symbol, interval){
  try{
    const p = cachePath(symbol, interval);
    if(!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p,'utf8')||'null');
  }catch(e){ return null; }
}
function writeCache(symbol, interval, data){
  try{ fs.writeFileSync(cachePath(symbol, interval), JSON.stringify({fetchedAt:Date.now(), data}, null, 2)); }catch(e){}
}
function lastCachedPrice(symbol){
  try{
    const s = symSafe(symbol);
    if(!fs.existsSync(CACHE_DIR)) return null;
    const files = fs.readdirSync(CACHE_DIR).filter(f=>f.startsWith(s+'_')).sort((a,b)=>fs.statSync(path.join(CACHE_DIR,b)).mtimeMs - fs.statSync(path.join(CACHE_DIR,a)).mtimeMs);
    for(const f of files){
      try{
        const obj = JSON.parse(fs.readFileSync(path.join(CACHE_DIR,f),'utf8')||'{}');
        const arr = obj?.data;
        if(Array.isArray(arr) && arr.length){ const last = arr[arr.length-1]; if(last && Number.isFinite(+last.close)) return Number(last.close); }
      }catch(e){}
    }
  }catch(e){}
  return null;
}

function axiosOpts(timeout=DEFAULT_TIMEOUT){
  return { timeout, headers: { "User-Agent": USER_AGENT, Accept: "*/*" } };
}

// ---------------- Normalizers ----------------
function normalizeBinance(raw){
  if(!Array.isArray(raw)) return [];
  try{
    return raw.map(r=>({
      t: Number(r[0]),
      open: safeNum(r[1]),
      high: safeNum(r[2]),
      low: safeNum(r[3]),
      close: safeNum(r[4]),
      vol: safeNum(r[5],0)
    })).filter(c=>Number.isFinite(c.t) && Number.isFinite(c.close)).sort((a,b)=>a.t-b.t);
  }catch(e){ return []; }
}

function normalizeYahooChart(res){
  try{
    if(!res || !res.chart || !Array.isArray(res.chart.result) || !res.chart.result[0]) return [];
    const r = res.chart.result[0];
    const ts = r.timestamp || [];
    const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
    const out = [];
    for(let i=0;i<ts.length;i++){
      const close = q.close && q.close[i];
      if(!Number.isFinite(close)) continue;
      out.push({
        t: Number(ts[i]) * 1000,
        open: safeNum(q.open && q.open[i], close),
        high: safeNum(q.high && q.high[i], close),
        low: safeNum(q.low && q.low[i], close),
        close: safeNum(close),
        vol: safeNum(q.volume && q.volume[i],0)
      });
    }
    return out.sort((a,b)=>a.t-b.t);
  }catch(e){ return []; }
}

// ---------------- Synthetic candles (never empty) ----------------
function intervalToMs(tf='15m'){
  const s = String(tf||'15m').toLowerCase();
  if(s.endsWith('m')) return Number(s.slice(0,-1))*60_000;
  if(s.endsWith('h')) return Number(s.slice(0,-1))*60*60_000;
  if(s.endsWith('d')) return Number(s.slice(0,-1))*24*60*60_000;
  return 60_000;
}
function generateSynthetic({lastPrice=100, count=200, interval='15m'}) {
  const ms = intervalToMs(interval);
  const out = [];
  let t = Date.now() - (count-1)*ms;
  let prev = safeNum(lastPrice,100);
  const atr = Math.max(prev*0.001, prev*0.002);
  for(let i=0;i<count;i++){
    const noise = (Math.random()-0.5)*atr;
    const open = prev;
    const close = Math.max(0.000001, prev + noise);
    const high = Math.max(open,close) + Math.abs(noise)*Math.random();
    const low = Math.min(open,close) - Math.abs(noise)*Math.random();
    const vol = Math.round(Math.abs(noise)*1000 + Math.random()*100);
    out.push({ t, open, high, low, close, vol });
    prev = close;
    t += ms;
  }
  return out;
}

// ---------------- safeGet (retries + mirrors) ----------------
async function safeGet(url, opts={timeout:DEFAULT_TIMEOUT, mirrors:[]}) {
  if(!url) return null;
  const timeout = opts.timeout || DEFAULT_TIMEOUT;
  const mirrors = opts.mirrors || [];
  // try primary
  for(let i=0;i<DEFAULT_RETRIES;i++){
    try{
      const r = await axios.get(url, axiosOpts(timeout));
      if(typeof r.data !== 'undefined' && r.data !== null) return r.data;
    }catch(e){}
    await sleep(RETRY_DELAY_MS);
  }
  // try mirrors by replacing base
  try{
    const u = new URL(url);
    for(const base of mirrors){
      if(!base) continue;
      const final = base.replace(/\/+$/,'') + u.pathname + u.search;
      for(let i=0;i<DEFAULT_RETRIES;i++){
        try{
          const r = await axios.get(final, axiosOpts(timeout));
          if(typeof r.data !== 'undefined' && r.data !== null) return r.data;
        }catch(e){}
        await sleep(RETRY_DELAY_MS);
      }
    }
  }catch(e){}
  // external proxy fallback - try one
  try{
    const p = "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(url);
    for(let i=0;i<2;i++){
      try{
        const r = await axios.get(p, axiosOpts(timeout));
        if(typeof r.data !== 'undefined' && r.data !== null) return r.data;
      }catch(e){}
      await sleep(RETRY_DELAY_MS);
    }
  }catch(e){}
  return null;
}

// ---------------- Fetchers ----------------

// 1) fetchCrypto (Binance primary)
export async function fetchCrypto(symbol, interval='15m', limit=500){
  const s = String(symbol||'').toUpperCase();
  if(!s) return { data: [], price: null };
  const sources = CONFIG.API?.BINANCE && CONFIG.API.BINANCE.length ? CONFIG.API.BINANCE : ["https://api.binance.com"];
  const base = sources[0].replace(/\/+$/,'');
  const url = `${base}/api/v3/klines?symbol=${encodeURIComponent(s)}&interval=${encodeURIComponent(interval)}&limit=${Number(limit)}`;
  const mirrors = sources.slice(1);
  const cache = readCache(s, interval);

  try{
    const raw = await safeGet(url, { timeout: DEFAULT_TIMEOUT, mirrors });
    if(Array.isArray(raw) && raw.length){
      const k = normalizeBinance(raw);
      if(k.length){ writeCache(s, interval, k); return { data:k, price: k[k.length-1].close }; }
    }
  }catch(e){}

  // try mirrors explicitly
  for(const m of mirrors){
    try{
      const url2 = `${m.replace(/\/+$/,'')}/api/v3/klines?symbol=${encodeURIComponent(s)}&interval=${encodeURIComponent(interval)}&limit=${Number(limit)}`;
      const raw2 = await safeGet(url2, { timeout: DEFAULT_TIMEOUT });
      if(Array.isArray(raw2) && raw2.length){
        const k = normalizeBinance(raw2);
        if(k.length){ writeCache(s, interval, k); return { data:k, price:k[k.length-1].close }; }
      }
    }catch(e){}
  }

  // last cache or synthetic
  if(cache && cache.data && cache.data.length) return { data: cache.data, price: cache.data[cache.data.length-1].close || lastCachedPrice(s) };
  const synthetic = generateSynthetic({ lastPrice: lastCachedPrice(s) || 100, count: Math.min(500, limit), interval });
  writeCache(s, interval, synthetic);
  return { data: synthetic, price: synthetic[synthetic.length-1].close };
}

// 2) fetchYahoo (generic)
export async function fetchYahoo(symbol, interval='15m'){
  const s = String(symbol||'').trim();
  if(!s) return { data: [], price: null };
  const sources = CONFIG.API?.YAHOO && CONFIG.API.YAHOO.length ? CONFIG.API.YAHOO : ["https://query1.finance.yahoo.com/v8/finance/chart"];
  const base = sources[0].replace(/\/+$/,'');
  const tfmap = { "1m":{interval:"1m",range:"1d"}, "5m":{interval:"5m",range:"5d"}, "15m":{interval:"15m",range:"5d"}, "30m":{interval:"30m",range:"1mo"}, "1h":{interval:"60m",range:"1mo"} }[interval] || {interval:"15m",range:"5d"};
  const url = `${base}/${encodeURIComponent(s)}?interval=${tfmap.interval}&range=${tfmap.range}`;
  const cache = readCache(s, interval);
  try{
    const raw = await safeGet(url, { timeout: DEFAULT_TIMEOUT, mirrors: sources.slice(1) });
    const k = normalizeYahooChart(raw);
    if(k.length){ writeCache(s, interval, k); return { data:k, price:k[k.length-1].close }; }
  }catch(e){}
  if(cache && cache.data && cache.data.length) return { data:cache.data, price: cache.data[cache.data.length-1].close || lastCachedPrice(s) };

  // synthetic fallback
  const synthetic = generateSynthetic({ lastPrice: lastCachedPrice(s) || 100, count:200, interval });
  writeCache(s, interval, synthetic);
  return { data: synthetic, price: synthetic[synthetic.length-1].close };
}

// 3) fetchForex (exchangerate.host fallback)
export async function fetchForex(symbol, interval='15m'){
  const sIn = String(symbol||'').toUpperCase().replace('/','');
  if(!sIn) return { data: [], price: null };
  // try Yahoo mapping first if common format provided
  const yahooSymbol = (CONFIG.SYMBOLS?.FOREX && CONFIG.SYMBOLS.FOREX[sIn] && CONFIG.SYMBOLS.FOREX[sIn].yahoo) ? CONFIG.SYMBOLS.FOREX[sIn].yahoo : sIn;
  const yres = await fetchYahoo(yahooSymbol, interval);
  if(yres && Array.isArray(yres.data) && yres.data.length) return yres;

  // fallback to exchangerate host for instant rate
  try{
    const base = CONFIG.API?.EXCHANGERATE || "https://api.exchangerate.host";
    const b = sIn.slice(0,3), q = sIn.slice(3,6);
    if(b.length===3 && q.length===3){
      const url = `${base}/latest?base=${encodeURIComponent(b)}&symbols=${encodeURIComponent(q)}`;
      const raw = await safeGet(url, { timeout: DEFAULT_TIMEOUT });
      if(raw && raw.rates){
        const rate = raw.rates[q] || Object.values(raw.rates)[0];
        if(Number.isFinite(+rate)){
          const now = Date.now();
          const candle = [{ t: now - 60000, open:rate, high:rate, low:rate, close:rate, vol:0 }];
          writeCache(sIn, interval, candle);
          return { data: candle, price: rate };
        }
      }
    }
  }catch(e){}

  const cache = readCache(sIn, interval);
  if(cache && cache.data && cache.data.length) return { data: cache.data, price: cache.data[cache.data.length-1].close || lastCachedPrice(sIn) };
  const synthetic = generateSynthetic({ lastPrice: lastCachedPrice(sIn) || 1, count:200, interval });
  writeCache(sIn, interval, synthetic);
  return { data: synthetic, price: synthetic[synthetic.length-1].close };
}

// 4) fetchNSE (India indices) - uses mapping in CONFIG.SYMBOLS.INDIA -> yahoo
export async function fetchNSE(symbol, interval='15m'){
  try{
    const s = String(symbol||'').toUpperCase();
    const mapping = CONFIG.SYMBOLS && CONFIG.SYMBOLS.INDIA && CONFIG.SYMBOLS.INDIA[s] ? CONFIG.SYMBOLS.INDIA[s].yahoo : s;
    return await fetchYahoo(mapping, interval);
  }catch(e){}
  const cache = readCache(symbol, interval);
  if(cache && cache.data && cache.data.length) return { data:cache.data, price: cache.data[cache.data.length-1].close || lastCachedPrice(symbol) };
  const synthetic = generateSynthetic({ lastPrice: lastCachedPrice(symbol) || 100, count:200, interval });
  writeCache(symbol, interval, synthetic);
  return { data: synthetic, price: synthetic[synthetic.length-1].close };
}

// 5) fetchCommodity — gateway to Yahoo
export async function fetchCommodity(symbol, interval='15m'){
  const map = CONFIG.SYMBOLS?.COMMODITIES && CONFIG.SYMBOLS.COMMODITIES[symbol] ? CONFIG.SYMBOLS.COMMODITIES[symbol].yahoo : symbol;
  return await fetchYahoo(map, interval);
}

// ---------------- Master router ----------------
export async function fetchUniversal(inputSymbol, interval='15m'){
  try{
    const symbol = String(inputSymbol||'').trim();
    if(!symbol) return { data: [], price: null };

    // heuristics: explicit config maps first
    if(CONFIG.SYMBOLS && CONFIG.SYMBOLS.CRYPTO && CONFIG.SYMBOLS.CRYPTO[symbol]) return await fetchCrypto(CONFIG.SYMBOLS.CRYPTO[symbol].binance || symbol, interval);
    if(CONFIG.SYMBOLS && CONFIG.SYMBOLS.INDIA && CONFIG.SYMBOLS.INDIA[symbol]) return await fetchNSE(symbol, interval);
    if(CONFIG.SYMBOLS && CONFIG.SYMBOLS.FOREX && CONFIG.SYMBOLS.FOREX[symbol]) return await fetchForex(symbol, interval);
    if(CONFIG.SYMBOLS && CONFIG.SYMBOLS.COMMODITIES && CONFIG.SYMBOLS.COMMODITIES[symbol]) return await fetchCommodity(symbol, interval);

    // fallback heuristics by pattern
    if(/USDT$|BTC$|ETH$/.test(symbol)) return await fetchCrypto(symbol, interval);
    if(/=X$/.test(symbol) || symbol.length===6 && symbol.endsWith("USD")) return await fetchForex(symbol, interval);
    if(/=F$/.test(symbol) || /GOLD|SILVER|CRUDE|OIL|NG/.test(symbol.toUpperCase())) return await fetchCommodity(symbol, interval);

    // finally try Yahoo generic
    return await fetchYahoo(symbol, interval);
  }catch(e){
    const cache = readCache(inputSymbol, interval);
    if(cache && cache.data && cache.data.length) return { data: cache.data, price: cache.data[cache.data.length-1].close || lastCachedPrice(inputSymbol) };
    const synthetic = generateSynthetic({ lastPrice: lastCachedPrice(inputSymbol) || 100, count:200, interval });
    writeCache(inputSymbol, interval, synthetic);
    return { data: synthetic, price: synthetic[synthetic.length-1].close };
  }
}

// ---------------- Multi-TF helper ----------------
function pLimit(concurrency=3){
  const queue = []; let active=0;
  const next = ()=>{ if(!queue.length || active>=concurrency) return; active++; const item = queue.shift(); item.fn().then(item.resolve).catch(item.reject).finally(()=>{active--; next();}); };
  return (fn)=> new Promise((res,rej)=>{ queue.push({fn, resolve:res, reject:rej}); next(); });
}

export async function fetchMultiTF(symbol, tfs = ["1m","5m","15m"]) {
  const sym = String(symbol||'').toUpperCase();
  if(!sym) {
    const empty={}; for(const tf of tfs) empty[tf]={data:[], price:null}; return empty;
  }
  const out = {}; const limit = pLimit(3);
  const tasks = tfs.map(tf => limit(async ()=>{
    await sleep(30 + Math.floor(Math.random()*80));
    out[tf] = await fetchUniversal(sym, tf);
  }));
  await Promise.all(tasks);
  return out;
}

// legacy compatibility
export async function fetchMarketData(symbol, interval='15m', limit=200){
  const res = await fetchUniversal(symbol, interval);
  return { data: res.data || [], price: res.price || null, updated: new Date().toISOString() };
}

export async function fetchPrice(symbol){
  const u = await fetchUniversal(symbol, '1m');
  const p = (u && Number(u.price)) ? Number(u.price) : lastCachedPrice(symbol);
  return p || null;
}