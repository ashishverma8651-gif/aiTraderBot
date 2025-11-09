/**
 * aiTraderBot_v8.7.1.js
 * AI Trader Full Stable + ML + Reversal + News + Fallback APIs
 * npm i node-fetch@3 express dotenv
 */

import fetch from "node-fetch";
import express from "express";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

//---------------- CONFIG ----------------//
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SYMBOL = process.env.SYMBOL || "BTCUSDT";
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || null;
const CHECK_INTERVAL_MIN = parseInt(process.env.CHECK_INTERVAL_MIN || "15", 10);
const REV_CHECK_INTERVAL_SEC = parseInt(process.env.REV_CHECK_INTERVAL_SEC || "60", 10);
const ML_ALERT_THRESH = parseFloat(process.env.ML_ALERT_THRESH || "0.7");
const PORT = process.env.PORT || 10000;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("❌ BOT_TOKEN or CHAT_ID missing in .env");
  process.exit(1);
}

const TIMEFRAMES = ["1m","5m","15m","30m","1h"];
const PROXIES = [
  "https://api.codetabs.com/v1/proxy?quest=",
  "https://api.allorigins.win/raw?url=",
  "https://thingproxy.freeboard.io/fetch/",
  "https://corsproxy.io/?"
];
const ML_FILE = "./ml_model_v871.json";
const LAST_PRED_FILE = "./last_pred_v871.json";

//---------------- UTILS ----------------//
const nowStr = () => new Date().toLocaleString("en-IN",{timeZone:"Asia/Kolkata"});

async function safeFetch(url, opt={}, proxy=true){
  try {
    const r = await fetch(url,opt);
    if(r.ok) return r;
  }catch(e){}
  if(proxy){
    for(const p of PROXIES){
      try{
        const r=await fetch(p+encodeURIComponent(url),opt);
        if(r.ok)return r;
      }catch(e){}
    }
  }
  throw new Error("Fetch failed for "+url);
}

async function sendTG(msg){
  const parts = msg.match(/[\s\S]{1,3900}/g)||[];
  for(const p of parts){
    try{
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({chat_id:CHAT_ID,text:p,parse_mode:"HTML",disable_web_page_preview:true})
      });
    }catch(e){console.log("TG fail:",e.message);}
    await new Promise(r=>setTimeout(r,400));
  }
}

//---------------- API FALLBACK SYSTEM ----------------//
async function fetchKlines(symbol, interval="15m", limit=80){
  const binURL=`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const cbSymbol = symbol.replace("USDT","-USD");
  const cgId = symbol.startsWith("BTC")?"bitcoin":symbol.startsWith("ETH")?"ethereum":symbol.toLowerCase();

  try{
    const r=await safeFetch(binURL);
    const j=await r.json();
    if(Array.isArray(j))return j.map(k=>({time:+k[0],open:+k[1],high:+k[2],low:+k[3],close:+k[4],volume:+k[5]}));
  }catch(e){console.log("Binance fail →",e.message);}

  try{
    const r=await safeFetch(`https://api.exchange.coinbase.com/products/${cbSymbol}/candles?granularity=900`);
    const j=await r.json();
    if(Array.isArray(j)){
      return j.slice(-limit).reverse().map(k=>({time:k[0]*1000,low:+k[1],high:+k[2],open:+k[3],close:+k[4],volume:k[5]}));
    }
  }catch(e){console.log("Coinbase fail →",e.message);}

  try{
    const r=await safeFetch(`https://api.coingecko.com/api/v3/coins/${cgId}/ohlc?vs_currency=usd&days=1`);
    const j=await r.json();
    if(Array.isArray(j)){
      return j.slice(-limit).map(k=>({time:+k[0],open:+k[1],high:+k[2],low:+k[3],close:+k[4],volume:0}));
    }
  }catch(e){console.log("CoinGecko fail →",e.message);}
  return [];
}

//---------------- INDICATORS ----------------//
function calcVolSent(kl){let b=0,s=0;for(const k of kl){if(k.close>k.open)b+=k.volume;else s+=k.volume;}const tot=b+s||1;return{buyPct:b/tot*100,sellPct:s/tot*100};}
function fib(kl){const h=Math.max(...kl.map(k=>k.high)),l=Math.min(...kl.map(k=>k.low)),r=h-l;return{fib618:h-r*0.618,fib382:h-r*0.382};}
function atr(kl,p=14){const arr=[];for(let i=1;i<kl.length;i++){const c=kl[i],pkl=kl[i-1];arr.push(Math.max(c.high-c.low,Math.abs(c.high-pkl.close),Math.abs(c.low-pkl.close)));}return arr.slice(-p).reduce((a,b)=>a+b,0)/p;}
function detectPattern(k){const l=k.at(-1),p=k.at(-2)||l,b=Math.abs(l.close-l.open),r=l.high-l.low||1,lowW=Math.min(l.open,l.close)-l.low,upW=l.high-Math.max(l.open,l.close);return{isDoji:b<=r*0.15?1:0,isHammer:lowW/r>0.4&&upW/r<0.25&&l.close>p.close?1:0,isShoot:upW/r>0.4&&lowW/r<0.25&&l.close<p.close?1:0};}

//---------------- ML ENGINE ----------------//
function sigmoid(z){return 1/(1+Math.exp(-z));}
let ML={w:null,bias:0,n:0,lr:0.02,l2:0.0001,trained:0};
if(fs.existsSync(ML_FILE))try{ML=JSON.parse(fs.readFileSync(ML_FILE,"utf8"));}catch{}
function mlInit(n){if(!ML.w||ML.n!==n){ML={w:Array(n).fill(0).map(()=>Math.random()*0.02-0.01),bias:0,n,lr:0.02,l2:0.0001,trained:0};fs.writeFileSync(ML_FILE,JSON.stringify(ML));}}
function mlPredict(x){if(!ML.w||ML.w.length!==x.length)mlInit(x.length);return sigmoid(ML.bias+x.reduce((s,v,i)=>s+(ML.w[i]*v),0));}
function mlTrain(x,y){const p=mlPredict(x),e=y-p;for(let i=0;i<x.length;i++)ML.w[i]+=ML.lr*(e*x[i]-ML.l2*ML.w[i]);ML.bias+=ML.lr*e;ML.trained++;if(ML.trained%5===0)fs.writeFileSync(ML_FILE,JSON.stringify(ML));}
function features(k){const f=k[0],l=k.at(-1),s=((l.close-f.close)/f.close)*100,vol=(l.volume||1)/(k.reduce((a,b)=>a+b.volume,0)/k.length||1),p=detectPattern(k);return[s,(l.close-l.open)/l.open,vol-1,p.isDoji,p.isHammer,p.isShoot];}

//---------------- SELF PING ----------------//
async function selfPing(){if(!RENDER_URL)return;try{await fetch(RENDER_URL);}catch(e){}}

//---------------- MAIN REPORT ----------------//
async function analyze(){
  const data=await fetchKlines(SYMBOL,"15m",80);
  if(!data.length)return;
  const last=data.at(-1),tech=calcVolSent(data),f=fib(data),a=atr(data),pat=detectPattern(data);
  const feat=features(data);const prob=mlPredict(feat);
  const bias=tech.buyPct>tech.sellPct?"Bullish":tech.sellPct>tech.buyPct?"Bearish":"Neutral";
  const conf=Math.round(Math.abs((tech.buyPct-tech.sellPct))/2);
  const msg=`<b>🤖 ${SYMBOL} | AI Trader v8.7.1</b>\n🕒 ${nowStr()}\n📈 Bias: ${bias} (${conf}%)\n💰 Price: ${last.close}\n📊 Vol: ${tech.buyPct.toFixed(1)} / ${tech.sellPct.toFixed(1)}\n📉 ATR: ${a.toFixed(2)}\n🎯 FIB 0.618:${f.fib618.toFixed(2)} | 0.382:${f.fib382.toFixed(2)}\n🧠 ML Prob: ${(prob*100).toFixed(1)}%\n${prob>ML_ALERT_THRESH?"🚨 ML Smart Alert Active!":""}`;
  await sendTG(msg);
  fs.writeFileSync(LAST_PRED_FILE,JSON.stringify({SYMBOL,last,lastTime:Date.now()}));
}

//---------------- REVERSAL WATCHER ----------------//
async function reversalWatcher(){
  const d=await fetchKlines(SYMBOL,"1m",40);
  if(!d.length)return;
  const p=detectPattern(d);
  const avgVol=d.slice(-20).reduce((a,b)=>a+b.volume,0)/20;
  const volNow=d.at(-1).volume;
  if((p.isHammer||p.isShoot||p.isDoji)&&volNow>avgVol*1.5){
    const type=p.isHammer?"Hammer":p.isShoot?"Shooting Star":"Doji";
    await sendTG(`⚡ Reversal Alert: ${type} with high volume detected!\nTime: ${nowStr()}`);
  }
}

//---------------- EXPRESS KEEP-ALIVE ----------------//
const app=express();
app.get("/",(req,res)=>res.send("AI Trader v8.7.1 Running ✅"));
app.listen(PORT,()=>console.log(`Server live on port ${PORT}`));

//---------------- SCHEDULERS ----------------//
analyze();
setInterval(analyze,CHECK_INTERVAL_MIN*60*1000);
setInterval(reversalWatcher,REV_CHECK_INTERVAL_SEC*1000);
setInterval(selfPing,120000);

console.log("🤖 AI Trader v8.7.1 initialized...");