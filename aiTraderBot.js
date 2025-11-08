import fetch from 'node-fetch';
import 'dotenv/config';

// --- Telegram Config ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SYMBOL = process.env.SYMBOL || 'BTCUSDT';

// --- Interval Settings (15 min update) ---
const CHECK_MS = 15 * 60 * 1000; // 15 minutes

// --- Binance Intervals to analyze ---
const INTERVALS = ['1m', '5m', '15m', '30m', '1h'];

// --- Send Telegram Message ---
async function sendTG(msg) {
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: msg,
        parse_mode: 'HTML'
      })
    });
  } catch (e) {
    console.error('❌ Telegram send failed:', e.message);
  }
}

// --- Fetch candle data from Binance ---
async function fetchKlines(symbol, interval, limit = 60) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance fetch failed ${res.status}`);
  const data = await res.json();
  return data.map(k => ({
    time: k[0],
    open: +k[1],
    high: +k[2],
    low: +k[3],
    close: +k[4],
    volume: +k[5]
  }));
}

// --- Simple divergence logic (mock) ---
function detectDivergence(data) {
  const len = data.length;
  const p1 = data[len - 2].close, p2 = data[len - 1].close;
  const v1 = data[len - 2].volume, v2 = data[len - 1].volume;
  if (p2 > p1 && v2 < v1) return { signal: 'Bearish Divergence', emoji: '🔻' };
  if (p2 < p1 && v2 > v1) return { signal: 'Bullish Divergence', emoji: '🚀' };
  return { signal: 'Neutral', emoji: '⚖️' };
}

// --- Convert UTC to India Time (Asia/Kolkata) ---
function formatIndiaTime(date = new Date()) {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(date);
}

// --- Main Analyzer ---
async function analyzeOnce() {
  try {
    let msg = `📊 <b>${SYMBOL}</b> — AI 24/7 Monitor\n\n`;
    let bull = 0, bear = 0;

    for (const tf of INTERVALS) {
      const data = await fetchKlines(SYMBOL, tf);
      const d = detectDivergence(data);
      msg += `${tf}: ${d.emoji} ${d.signal}\n`;
      if (d.signal.includes('Bullish')) bull++;
      if (d.signal.includes('Bearish')) bear++;
    }

    const bias =
      bull > bear
        ? 'Bullish 🚀'
        : bear > bull
        ? 'Bearish 📉'
        : 'Neutral ⚖️';

    msg += `\n🧠 <b>Overall Bias:</b> ${bias}\n⏰ ${formatIndiaTime()}`;
    await sendTG(msg);
    console.log('✅ Telegram alert sent:', formatIndiaTime());
  } catch (e) {
    console.error('analyzeOnce error:', e.message);
  }
}

// --- Run every 15 min ---
console.log('🤖 ai-trader-bot started...');
analyzeOnce();
setInterval(analyzeOnce, CHECK_MS);
