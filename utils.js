// utils.js — HEAVY single-file utils
import axios from "axios";
import fs from "fs";
import path from "path";
import CONFIG from "./config.js";

// --- Setup
const CACHE_DIR = (CONFIG && CONFIG.PATHS && CONFIG.PATHS.CACHE_DIR) || path.resolve("./cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const DEFAULT_TIMEOUT = Number(process.env.AXIOS_TIMEOUT_MS || 12000);
const DEFAULT_RETRIES = Number(CONFIG.FALLBACK?.MAX_RETRIES || 3);
const RETRY_DELAY = Number(CONFIG.FALLBACK?.RETRY_DELAY_MS || 500);
const USER_AGENT = "AI-Trader-Utils/1.0";
const EXTERNAL_PROXY_SERVICES = [
  "https://api.codetabs.com/v1/proxy?quest=",
  "https://api.allorigins.win/raw?url=",
  "https://corsproxy.io/?"
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function safeNum(v, d=0){ const n=Number(v); return Number.isFinite(n)?n:d; }
function symSafe(s=''){ return String(s||'').toUpperCase().replace(/[^A-Z0-9_\-\.\^]/g,'_'); }
function tfSafe(tf='15m'){ return String(tf||'15m').replace(/[^a-z0-9]/gi,'_'); }
function cachePath(symbol, interval){ return path.join(CACHE_DIR, `${symSafe(symbol)}_${tfSafe(interval)}.json`); }
function readCache(symbol, interval){ try{ const p=cachePath(symbol,interval); if(!fs.existsSync(p)) return null; return JSON.parse(fs.readFileSync(p,'utf8')||'null'); }catch(e){return null;} }
function writeCache(symbol, interval, data){ try{ fs.writeFileSync(cachePath(symbol,interval), JSON.stringify({ fetchedAt: Date.now(), data }, null, 2)); }catch(e){} }

// convert interval to ms
function intervalToMs(interval='15m'){
  if(!interval) return 60000;
  const v = String(interval).toLowerCase();
  if(v.endsWith('m')) return Number(v.slice(0,-1))*60000;
  if(v.endsWith('h')) return Number(v.slice(0,-1))*3600*1000;
  if(v.endsWith('d')) return Number(v.slice(0,-1))*24*3600*1000;
  return 60000;
}

// generate synthetic candles (guarantee)
function generateSyntheticCandles(lastPrice=100, count=200, intervalMs=60000){
  lastPrice = safeNum(lastPrice, 100);
  const atr = Math.max( Math.abs(lastPrice)*0.002, Math.abs(lastPrice)*0.005, 0.01 );
  const out = [];
  let t = Date.now() - (count-1)*intervalMs;
  let prev = lastPrice;
  for(let i=0;i<count;i++){
    const noise = (Math.random()-0.5)*atr;
    const open = prev;
    const close = Math.max(0.0000001, prev + noise);
    const high = Math.max(open, close) + Math.abs(noise)*Math.random();
    const low = Math.min(open, close) - Math.abs(noise)*Math.random();
    const vol = Math.round(Math.abs(noise)*1000 + Math.random()*100);
    out.push({ t, open, high, low, close, vol });
    prev = close;
    t += intervalMs;
  }
  return out;
}

// normalizers
function normalizeKlineArray(arr){
  if(!Array.isArray(arr)) return [];
  if(Array.isArray(arr[0])){
    const out = arr.map(k => {
      return { t: Number(k[0]), open: safeNum(k[1]), high: safeNum(k[2]), low: safeNum(k[3]), close: safeNum(k[4]), vol: safeNum(k[5],0) };
    }).filter(c => Number.isFinite(c.t) && Number.isFinite(c.close));
    out.sort((a,b)=>a.t-b.t);
    return out;
  }
  if(typeof arr[0] === 'object'){
    const out = arr.map(c => ({
      t: Number(c.t || c.timestamp || c.time || 0),
      open: safeNum(c.open ?? c.o),
      high: safeNum(c.high ?? c.h),
      low: safeNum(c.low ?? c.l),
      close: safeNum(c.close ?? c.c),
      vol: safeNum(c.vol ?? c.volume ?? 0)
    })).filter(c => Number.isFinite(c.t) && Number.isFinite(c.close));
    out.sort((a,b)=>a.t-b.t);
    return out;
  }
  return [];
}

function normalizeYahooChart(res){
  try{
    if(!res || !res.chart || !Array.isArray(res.chart.result) || !res.chart.result[0]) return [];
    const r = res.chart.result[0];
    const ts = r.timestamp || [];
    const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) ? r.indicators.quote[0] : {};
    const out = [];
    for(let i=0;i<ts.length;i++){
      const close = q.close && q.close[i];
      if(!Number.isFinite(close)) continue;
      out.push({
        t: Number(ts[i])*1000,
        open: safeNum(q.open?.[i], close),
        high: safeNum(q.high?.[i], close),
        low: safeNum(q.low?.[i], close),
        close: safeNum(close),
        vol: safeNum(q.volume?.[i], 0)
      });
    }
    out.sort((a,b)=>a.t-b.t);
    return out;
  }catch(e){ return []; }
}

// safe GET: direct -> mirrors -> external proxies
async function safeGet(url, { timeout=DEFAULT_TIMEOUT, responseType='json', mirrors=[] } = {}){
  if(!url) return null;
  // direct attempts
  for(let attempt=0; attempt<Math.max(1, DEFAULT_RETRIES); attempt++){
    try{
      const r = await axios.get(url, { timeout, headers: { 'User-Agent': USER_AGENT, Accept: '*/*' } , responseType });
      if(r && (r.data !== undefined)) return r.data;
    }catch(e){}
    await sleep(RETRY_DELAY + Math.random()*200);
  }
  // mirrors (replace origin)
  for(const base of (mirrors||[])){
    try{
      const u = new URL(url);
      const final = base.replace(/\/+$/,'') + u.pathname + u.search;
      for(let attempt=0; attempt<Math.max(1, DEFAULT_RETRIES); attempt++){
        try{
          const r = await axios.get(final, { timeout, headers: { 'User-Agent': USER_AGENT, Accept: '*/*' }, responseType });
          if(r && (r.data !== undefined)) return r.data;
        }catch(e){}
        await sleep(RETRY_DELAY + Math.random()*200);
      }
    }catch(e){}
  }
  // external public proxies (text)
  for(const pbase of EXTERNAL_PROXY_SERVICES){
    try{
      const proxied = pbase + encodeURIComponent(url);
      for(let attempt=0; attempt<Math.max(1, DEFAULT_RETRIES); attempt++){
        try{
          const r = await axios.get(proxied, { timeout, headers: { 'User-Agent': USER_AGENT, Accept: '*/*' }, responseType: 'text' });
          if(r && (r.data !== undefined)) return r.data;
        }catch(e){}
        await sleep(RETRY_DELAY + Math.random()*200);
      }
    }catch(e){}
  }
  return null;
}

// ---------- MARKET-SPECIFIC FETCHERS ----------

// 1) Crypto (Binance primary)
async function fetchCrypto(symbol, interval='15m', limit=500){
  if(!symbol) return { data: [], price: null };
  const s = String(symbol).toUpperCase();
  const sources = CONFIG.API.BINANCE || ["https://api.binance.com"];
  const base = sources[0].replace(/\/+$/,'');
  const url = `${base}/api/v3/klines?symbol=${encodeURIComponent(s)}&interval=${encodeURIComponent(interval)}&limit=${Number(limit)}`;
  const mirrors = sources.slice(1);

  const cached = readCache(s, interval);
  try{
    const raw = await safeGet(url, { responseType: 'json', mirrors });
    if(Array.isArray(raw) && raw.length){
      const k = normalizeKlineArray(raw);
      if(k.length){ writeCache(s, interval, k); return { data: k, price: k.at(-1).close }; }
    }
  }catch(e){}

  // try yahoo fallback
  try{
    const yfSymbol = (CONFIG.SYMBOLS && CONFIG.SYMBOLS.CRYPTO && CONFIG.SYMBOLS.CRYPTO[s] && CONFIG.SYMBOLS.CRYPTO[s].yahoo) ? CONFIG.SYMBOLS.CRYPTO[s].yahoo : s.replace('USDT','-USD');
    const yurl = `${(CONFIG.API.YAHOO||['https://query1.finance.yahoo.com/v8/finance/chart'])[0].replace(/\/+$/,'')}/${encodeURIComponent(yfSymbol)}?interval=${interval==='1m'?'1m':interval==='5m'?'5m':interval==='15m'?'15m':interval==='30m'?'30m':interval==='1h'?'60m':'1d'}&range=7d`;
    const yraw = await safeGet(yurl, { responseType:'json' });
    const ky = normalizeYahooChart(yraw);
    if(ky.length){ writeCache(s, interval, ky); return { data: ky, price: ky.at(-1).close }; }
  }catch(e){}

  if(cached && cached.data && cached.data.length) return { data: cached.data, price: cached.data.at(-1).close };
  const synthetic = generateSyntheticCandles(lastGoodPrice(s) || 100, Math.min(500, Number(limit||200)), intervalToMs(interval));
  writeCache(s, interval, synthetic);
  return { data: synthetic, price: synthetic.at(-1).close };
}

// 2) Yahoo generic (stocks, forex, commodities)
async function fetchYahoo(symbol, interval='15m'){
  if(!symbol) return { data: [], price: null };
  const s = String(symbol).trim();
  const baseUrl = (CONFIG.API && CONFIG.API.YAHOO && CONFIG.API.YAHOO[0]) ? CONFIG.API.YAHOO[0].replace(/\/+$/,'') : "https://query1.finance.yahoo.com/v8/finance/chart";
  const tf = (interval==='1m')?{interval:'1m',range:'1d'}:(interval==='5m')?{interval:'5m',range:'5d'}:(interval==='15m')?{interval:'15m',range:'5d'}:(interval==='30m')?{interval:'30m',range:'1mo'}:(interval==='1h')?{interval:'60m',range:'1mo'}:{interval:'1d',range:'6mo'};
  const url = `${baseUrl}/${encodeURIComponent(s)}?interval=${tf.interval}&range=${tf.range}`;
  const cached = readCache(s, interval);
  try{
    const res = await safeGet(url, { responseType:'json', mirrors: CONFIG.API?.YAHOO?.slice(1) || [] });
    const k = normalizeYahooChart(res);
    if(k.length){ writeCache(s, interval, k); return { data: k, price: k.at(-1).close }; }
  }catch(e){}
  if(cached && cached.data && cached.data.length) return { data: cached.data, price: cached.data.at(-1).close };
  const synthetic = generateSyntheticCandles(lastGoodPrice(s) || 100, 200, intervalToMs(interval));
  writeCache(s, interval, synthetic);
  return { data: synthetic, price: synthetic.at(-1).close };
}

// 3) FinancialModelingPrep (best-effort)
async function fetchFMP(symbol, interval='15m'){
  try{
    const base = CONFIG.API?.FMP || "https://financialmodelingprep.com/api/v3";
    // fmp path for historical-chart: /historical-chart/{interval}/{symbol}
    const url = `${base.replace(/\/+$/,'')}/historical-chart/${encodeURIComponent(interval)}/${encodeURIComponent(symbol)}`;
    const raw = await safeGet(url, { responseType:'json' });
    if(Array.isArray(raw) && raw.length){
      const out = raw.map(r => ({ t: new Date(r.date).getTime(), open: safeNum(r.open), high: safeNum(r.high), low: safeNum(r.low), close: safeNum(r.close), vol: safeNum(r.volume||0) })).sort((a,b)=>a.t-b.t);
      if(out.length) return { data: out, price: out.at(-1).close };
    }
  }catch(e){}
  return { data: [], price: null };
}

// 4) NSE / INDIA via TradingView proxy or Moneycontrol then Yahoo fallback
async function fetchNSE(symbol, interval='15m'){
  if(!symbol) return { data: [], price: null };
  const s = String(symbol).toUpperCase();
  const mapping = CONFIG.SYMBOLS?.INDIA || {};
  const mapped = (mapping && mapping[s] && (mapping[s].tv || mapping[s].yahoo || mapping[s].moneycontrol)) ? mapping[s] : s;
  // prefer TradingView proxy (tvc...) using tv symbol
  try{
    const tvSym = mapping && mapping[s] && mapping[s].tv ? mapping[s].tv : null;
    if(tvSym){
      // many TV proxies are HTML/JS; best-effort: attempt forexfeed endpoints (some proxies return json)
      for(const proxyBase of (CONFIG.API?.TRADINGVIEW_PROXY || [])){
        try{
          const url = `${proxyBase.replace(/\/+$/,'')}/symbols/${encodeURIComponent(tvSym)}.json`;
          const raw = await safeGet(url, { responseType:'json' });
          // raw might not be directly kline; best-effort parse
          if(raw && raw.length && Array.isArray(raw)){
            const k = normalizeKlineArray(raw);
            if(k.length) { writeCache(s, interval, k); return { data: k, price: k.at(-1).close }; }
          }
        }catch(e){}
      }
    }
  }catch(e){}
  // Moneycontrol (API expects sc_id etc) — best-effort using mapping.moneycontrol
  try{
    const mcSym = mapping && mapping[s] && mapping[s].moneycontrol ? mapping[s].moneycontrol : null;
    if(mcSym){
      // Moneycontrol history endpoint (techCharts) usage:
      // https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/history?symbol=RELIANCE&resolution=15&from=1630000000&to=1630100000
      const now = Math.floor(Date.now()/1000);
      const from = now - 7*24*3600;
      const mcBase = (CONFIG.API.MONEYCONTROL && CONFIG.API.MONEYCONTROL[0]) || null;
      if(mcBase){
        const url = `${mcBase}?symbol=${encodeURIComponent(mcSym)}&resolution=${intervalToResolution(interval)}&from=${from}&to=${now}`;
        const raw = await safeGet(url, { responseType:'json' });
        // Moneycontrol returns { t:[], c:[], h:[], l:[], o:[], v:[] } style — adapt
        if(raw && raw.t && Array.isArray(raw.t) && raw.t.length){
          const out = [];
          for(let i=0;i<raw.t.length;i++){
            const ts = Number(raw.t[i])*1000;
            const close = safeNum(raw.c && raw.c[i], NaN);
            if(!Number.isFinite(close)) continue;
            out.push({ t: ts, open: safeNum(raw.o[i], close), high: safeNum(raw.h[i], close), low: safeNum(raw.l[i], close), close, vol: safeNum(raw.v[i],0) });
          }
          if(out.length){ writeCache(s, interval, out); return { data: out, price: out.at(-1).close }; }
        }
      }
    }
  }catch(e){}
  // Yahoo fallback
  const yahooSym = (mapping && mapping[s] && mapping[s].yahoo) ? mapping[s].yahoo : s;
  const yahooRes = await fetchYahoo(yahooSym, interval);
  if(yahooRes && yahooRes.data && yahooRes.data.length) return yahooRes;
  // cache or synthetic fallback
  const cached = readCache(s, interval);
  if(cached && cached.data && cached.data.length) return { data: cached.data, price: cached.data.at(-1).close };
  const synthetic = generateSyntheticCandles(lastGoodPrice(s) || 100, 200, intervalToMs(interval));
  writeCache(s, interval, synthetic);
  return { data: synthetic, price: synthetic.at(-1).close };
}

function intervalToResolution(interval){
  if(!interval) return 15;
  if(typeof interval !== 'string') return 15;
  if(interval.endsWith('m')) return Number(interval.slice(0,-1)) || 15;
  if(interval.endsWith('h')) return Number(interval.slice(0,-1))*60;
  return 15;
}

// 5) Commodity
async function fetchCommodity(symbol, interval='15m'){
  const s = String(symbol||'').toUpperCase();
  const map = CONFIG.SYMBOLS?.COMMODITIES || {};
  const mapped = (map && map[s] && map[s].yahoo) ? map[s].yahoo : s;
  return await fetchYahoo(mapped, interval);
}

// 6) Forex
async function fetchForex(symbol, interval='15m'){
  if(!symbol) return { data: [], price: null };
  const s = String(symbol||'').toUpperCase().replace('/','');
  const map = CONFIG.SYMBOLS?.FOREX || {};
  const mapped = (map && map[s] && map[s].yahoo) ? map[s].yahoo : (s.endsWith('USD') ? `${s}=X` : s);
  // first try yahoo
  try{
    const res = await fetchYahoo(mapped, interval);
    if(res && res.data && res.data.length) return res;
  }catch(e){}
  // then exchangerate.host simple quote (no candles)
  try{
    const base = (CONFIG.API && CONFIG.API.EXCHANGERATE) ? CONFIG.API.EXCHANGERATE : "https://api.exchangerate.host";
    const b = mapped.slice(0,3), q = mapped.slice(3,6);
    const url = `${base.replace(/\/+$/,'')}/latest?base=${encodeURIComponent(b)}&symbols=${encodeURIComponent(q)}`;
    const raw = await safeGet(url, { responseType:'json' });
    if(raw && raw.rates){
      const rate = (raw.rates && raw.rates[q]) ? safeNum(raw.rates[q], null) : (Object.values(raw.rates || {})[0] || null);
      if(Number.isFinite(rate)){
        const now = Date.now();
        const candle = [{ t: now - 60000, open: rate, high: rate, low: rate, close: rate, vol: 0 }];
        writeCache(symbol, interval, candle);
        return { data: candle, price: rate };
      }
    }
  }catch(e){}
  // fallback
  const cached = readCache(symbol, interval);
  if(cached && cached.data && cached.data.length) return { data: cached.data, price: cached.data.at(-1).close };
  const synthetic = generateSyntheticCandles(lastGoodPrice(symbol) || 1.0, 200, intervalToMs(interval));
  writeCache(symbol, interval, synthetic);
  return { data: synthetic, price: synthetic.at(-1).close };
}

// lastGoodPrice scans cache
function lastGoodPrice(symbol){
  try{
    const s = symSafe(symbol || '');
    const files = fs.readdirSync(CACHE_DIR).filter(f => f.startsWith(s + "_"));
    files.sort((a,b)=>fs.statSync(path.join(CACHE_DIR,b)).mtimeMs - fs.statSync(path.join(CACHE_DIR,a)).mtimeMs);
    for(const f of files){
      try{
        const obj = JSON.parse(fs.readFileSync(path.join(CACHE_DIR,f),'utf8')||'{}');
        const arr = obj && obj.data ? obj.data : null;
        if(Array.isArray(arr) && arr.length){
          const last = arr.at(-1);
          if(last && Number.isFinite(+last.close)) return Number(last.close);
        }
      }catch(e){}
    }
  }catch(e){}
  return null;
}

// ---------- High-level router: fetchUniversal ----------
export async function fetchUniversal(inputSymbol, interval='15m'){
  try{
    const symbol = String(inputSymbol || '').trim();
    if(!symbol) return { data: [], price: null };
    const s = symbol.toUpperCase();

    const isCrypto = /(USDT|USD|BTC|ETH)$/.test(s) || (s.length>3 && /[A-Z]{3,6}(USDT|USD|BTC)?$/.test(s));
    const isForex = /^[A-Z]{6}$/.test(s) && (s.endsWith('USD') || s.includes('JPY'));
    const isCommodity = /^(GC=F|CL=F|NG=F|SI=F|XAU|XAG|GOLD|OIL)$/i.test(s);
    const isIndia = (CONFIG.SYMBOLS && CONFIG.SYMBOLS.INDIA && (CONFIG.SYMBOLS.INDIA[s] || Object.keys(CONFIG.SYMBOLS.INDIA).includes(s)));
    const isUs = (CONFIG.SYMBOLS && CONFIG.SYMBOLS.US_STOCKS && (CONFIG.SYMBOLS.US_STOCKS[s] || Object.keys(CONFIG.SYMBOLS.US_STOCKS).includes(s)));

    const forced = (CONFIG.ACTIVE_MARKET || '').toUpperCase();

    if(forced === 'CRYPTO' || isCrypto){
      return await fetchCrypto(s, interval, CONFIG.DEFAULT_LIMIT);
    }
    if(forced === 'INDIA' || isIndia){
      return await fetchNSE(s, interval);
    }
    if(forced === 'COMMODITIES' || isCommodity){
      return await fetchCommodity(s, interval);
    }
    if(forced === 'FOREX' || isForex){
      return await fetchForex(s, interval);
    }
    if(forced === 'US_STOCKS' || isUs){
      // prefer yahoo -> fmp -> tv
      const map = CONFIG.SYMBOLS?.US_STOCKS || {};
      const mapped = (map && map[s] && map[s].yahoo) ? map[s].yahoo : s;
      const res = await fetchYahoo(mapped, interval);
      if(res && res.data && res.data.length) return res;
      const fmp = await fetchFMP(mapped, interval);
      if(fmp && fmp.data && fmp.data.length) return fmp;
      const cached = readCache(s, interval);
      if(cached && cached.data && cached.data.length) return { data: cached.data, price: cached.data.at(-1).close };
      const synthetic = generateSyntheticCandles(lastGoodPrice(s) || 100, 200, intervalToMs(interval));
      writeCache(s, interval, synthetic);
      return { data: synthetic, price: synthetic.at(-1).close };
    }

    // default -> try yahoo
    return await fetchYahoo(s, interval);
  }catch(e){
    return { data: [], price: null };
  }
}

// fetchMultiTF (concurrent but limited)
function pLimit(concurrency=2){
  const queue = [];
  let active = 0;
  const next = () => {
    if(!queue.length || active>=concurrency) return;
    active++;
    const item = queue.shift();
    item.fn().then(v=>{ active--; item.resolve(v); next(); }).catch(err=>{ active--; item.reject(err); next(); });
  };
  return fn => new Promise((resolve,reject)=>{ queue.push({ fn, resolve, reject }); next(); });
}

export async function fetchMultiTF(inputSymbol, tfs = ['1m','5m','15m','30m','1h']){
  const symbol = String(inputSymbol || '').trim();
  if(!symbol){
    const empty = {};
    for(const tf of tfs) empty[tf] = { data: [], price: null };
    return empty;
  }
  const out = {};
  const limit = pLimit(3);
  const tasks = tfs.map(tf => limit(async ()=>{
    await sleep(20 + Math.random()*120);
    out[tf] = await fetchUniversal(symbol, tf);
  }));
  await Promise.all(tasks);
  return out;
}

// fetchPrice: tries multiple fast sources
export async function fetchPrice(inputSymbol){
  try{
    const s = String(inputSymbol || '').trim();
    if(!s) return null;

    // Try fetchUniversal 1m (fast)
    try{
      const r = await fetchUniversal(s, '1m');
      if(r && Array.isArray(r.data) && r.data.length){
        const p = r.data.at(-1).close;
        if(Number.isFinite(p)) return p;
      }
    }catch(e){}

    // try read cache
    const cached = readCache(s, '1m') || readCache(s, '15m');
    if(cached && cached.data && cached.data.length){
      const p = cached.data.at(-1).close;
      if(Number.isFinite(p)) return p;
    }

    // lastGoodPrice fallback
    const lg = lastGoodPrice(s);
    if(Number.isFinite(lg)) return lg;

    // give up -> null
    return null;
  }catch(e){ return null; }
}

// fetchMarketData (legacy compatibility)
export async function fetchMarketData(inputSymbol, interval='15m', limit = CONFIG.DEFAULT_LIMIT || 200){
  try{
    const symbol = String(inputSymbol || '').trim();
    if(!symbol) return { data: [], price: null, updated: new Date().toISOString() };
    const res = await fetchUniversal(symbol, interval);
    return { data: res.data || [], price: res.price || null, updated: new Date().toISOString() };
  }catch(e){
    return { data: [], price: null, updated: new Date().toISOString() };
  }
}

export default { fetchUniversal, fetchMultiTF, fetchPrice, fetchMarketData };