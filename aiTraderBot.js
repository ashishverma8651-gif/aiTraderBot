import fetch from 'node-fetch';
import 'dotenv/config';

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID   = process.env.CHAT_ID;
const SYMBOL    = process.env.SYMBOL || 'BTCUSDT';
const CHECK_MS  = parseInt(process.env.CHECK_INTERVAL_MS || '60000', 10);
const INTERVALS = (process.env.INTERVALS || '1m,5m,15m,1h').split(',');

if(!BOT_TOKEN || !CHAT_ID){
  console.error('ERROR: BOT_TOKEN or CHAT_ID not set in environment variables.');
  process.exit(1);
}

async function sendTG(msg){
  try{
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ chat_id: CHAT_ID, text: msg, parse_mode:'HTML' })
    });
    console.log('Telegram message sent');
  }catch(e){
    console.error('Telegram send failed', e.message || e);
  }
}

async function fetchKlines(symbol, interval='1m', limit=60){
  // Use proxy to bypass Binance region restriction
const proxy = "https://api.allorigins.win/raw?url=";
const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
const r = await fetch(proxy + encodeURIComponent(url));
if(!r.ok) throw new Error(`Binance fetch failed ${r.status}`);
  const data = await r.json();
  return data.map(k=>({
    open:+k[1], high:+k[2], low:+k[3], close:+k[4], volume:+k[5]
  }));
}

function detectDivergenceSimple(data){
  if(!data || data.length < 10) return {signal:'Neutral', emoji:'⚖️'};
  const len = data.length;
  const p1 = data[len - 8].close;
  const p2 = data[len - 1].close;
  const v1 = data[len - 8].volume;
  const v2 = data[len - 1].volume;
  if(p2 > p1 && v2 < v1) return {signal:'Bearish Divergence', emoji:'🔻'};
  if(p2 < p1 && v2 > v1) return {signal:'Bullish Divergence', emoji:'🚀'};
  return {signal:'Neutral', emoji:'⚖️'};
}

async function analyzeOnce(){
  try{
    let msg = `📊 <b>${SYMBOL} — AI 24/7 Monitor</b>\n`;
    let bull=0, bear=0;

    for(const tf of INTERVALS){
      const data = await fetchKlines(SYMBOL, tf.trim(), 60);
      const d = detectDivergenceSimple(data);
      msg += `${d.emoji} ${tf}: ${d.signal}\n`;
      if(d.signal.includes('Bullish')) bull++;
      if(d.signal.includes('Bearish')) bear++;
    }

    const bias = bull > bear ? 'Bullish 📈' : bear > bull ? 'Bearish 📉' : 'Neutral ⚖️';
    msg += `\n🧠 Overall Bias: <b>${bias}</b>\n🕒 ${new Date().toLocaleString()}`;
    await sendTG(msg);
  }catch(e){
    console.error('analyzeOnce error', e.message || e);
  }
}

console.log('🚀 ai-trader-bot starting...');
analyzeOnce();
setInterval(analyzeOnce, CHECK_MS);
