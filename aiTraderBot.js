// aiTraderBot_v7.js
// AI Trader v7 — Multi-TF divergence + Elliott heuristic + Fib(0.618) + Smart Alerts + Self-Ping
// Usage: node aiTraderBot_v7.js
import fetch from "node-fetch";
import express from "express";
import "dotenv/config";

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const SYMBOL = process.env.SYMBOL || "BTCUSDT";
const CHECK_INTERVAL_MIN = parseInt(process.env.CHECK_INTERVAL_MIN || "5", 10); // run every X minutes
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("Missing BOT_TOKEN or CHAT_ID in env — exiting");
  process.exit(1);
}

function nowIndia() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: true });
}

// ----- helpers -----
async function tgSend(text, parse_mode = "HTML") {
  // split into safe chunks to avoid 'message is too long' 400 error
  const MAX = 3800;
  const parts = text.match(new RegExp(`.{1,${MAX}}`, "gs")) || [text];
  for (const p of parts) {
    try {
      await fetch(`${TELEGRAM_API}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: CHAT_ID, text: p, parse_mode }),
      });
      // small gap so Telegram doesn't reject as flood
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      console.warn("tgSend err:", err.message);
    }
  }
}

// proxies for CORS/public-hosting fallback
const PROXIES = [
  "https://api.codetabs.com/v1/proxy?quest=",
  "https://api.allorigins.win/raw?url=",
  "https://thingproxy.freeboard.io/fetch/",
  "https://corsproxy.io/?",
];

// fetch klines with proxy fallback
async function fetchKlines(symbol = SYMBOL, interval = "15m", limit = 80) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  for (const p of PROXIES) {
    try {
      const res = await fetch(p + encodeURIComponent(url), { timeout: 12000 });
      if (!res.ok) throw new Error(`proxy fail ${res.status}`);
      const json = await res.json();
      if (!Array.isArray(json) || !json.length) throw new Error("empty klines");
      return json.map((k) => ({
        time: +k[0],
        open: +k[1],
        high: +k[2],
        low: +k[3],
        close: +k[4],
        volume: +k[5],
      }));
    } catch (err) {
      // console.warn("proxy fetch fail", p, err.message);
      continue;
    }
  }
  // last attempt without proxy
  try {
    const res = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
    if (!res.ok) throw new Error("direct binance fail");
    const json = await res.json();
    return json.map((k) => ({
      time: +k[0],
      open: +k[1],
      high: +k[2],
      low: +k[3],
      close: +k[4],
      volume: +k[5],
    }));
  } catch (err) {
    throw new Error("All kline fetch attempts failed: " + err.message);
  }
}

// simple fib calc using high/low range
function fibLevels(klines) {
  if (!klines || !klines.length) return null;
  const highs = klines.map((k) => k.high);
  const lows = klines.map((k) => k.low);
  const high = Math.max(...highs);
  const low = Math.min(...lows);
  const range = high - low || 1;
  const fib618 = high - range * 0.618;
  const fib382 = high - range * 0.382;
  const fib236 = high - range * 0.236;
  return { high, low, fib618, fib382, fib236 };
}

// very lightweight Elliott heuristic (pattern name + confidence percent)
// NOTE: this is heuristic-only (not full wave detection)
function elliottHeuristic(klines) {
  // slope and volatility heuristic to decide "correction" vs "impulse" vs "sideways"
  if (!klines || klines.length < 5) return { name: "Unknown", conf: 30 };
  const start = klines[0].close;
  const end = klines[klines.length - 1].close;
  const slopePct = ((end - start) / start) * 100;
  const highs = klines.map((k) => k.high);
  const lows = klines.map((k) => k.low);
  const volRange = (Math.max(...highs) - Math.min(...lows)) / start * 100;

  if (Math.abs(slopePct) < 0.5 && volRange < 2) return { name: "Sideways", conf: 55 };
  if (slopePct > 0.8 && volRange > 2) return { name: "Impulse (5-wave likely)", conf: Math.min(90, 50 + volRange) };
  if (slopePct < -0.8 && volRange > 2) return { name: "Impulse Down", conf: Math.min(90, 50 + volRange) };
  // correction detection: bounce + smaller amplitude
  if (Math.abs(slopePct) > 0.2 && volRange > 1 && volRange < 5) return { name: "Correction (ABC?)", conf: 60 + Math.min(30, volRange) };
  return { name: "Unclear", conf: 40 };
}

// divergence analyzer (price vs volume)
function divergenceAnalysis(klines) {
  if (!klines || klines.length < 2) return { type: "Insufficient", dp: 0, dv: 0, strength: 0 };
  const last = klines[klines.length - 1];
  const prev = klines[klines.length - 2];
  const dp = ((last.close - prev.close) / (prev.close || 1)) * 100;
  const dv = ((last.volume - prev.volume) / (prev.volume || 1)) * 100;
  let type = "Neutral";
  if (dp > 0 && dv < 0) type = "Bearish Divergence";
  if (dp < 0 && dv > 0) type = "Bullish Divergence";
  const strength = Math.min(100, Math.abs(dp) + Math.abs(dv));
  return { type, dp: dp.toFixed(2), dv: dv.toFixed(2), strength: Math.round(strength) };
}

// quick ATR (simple)
function simpleATR(klines, period = 14) {
  if (!klines || klines.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < klines.length; i++) {
    const cur = klines[i], prev = klines[i - 1];
    const tr = Math.max(cur.high - cur.low, Math.abs(cur.high - prev.close), Math.abs(cur.low - prev.close));
    trs.push(tr);
  }
  const slice = trs.slice(-period);
  const atr = slice.reduce((a, b) => a + b, 0) / slice.length;
  return atr;
}

// targets & breakout zone generator
function targetsAndZones(lastPrice, bias) {
  if (!lastPrice) return null;
  const step = lastPrice * 0.004; // 0.4% step
  if (bias === "Bullish") {
    const tp1 = lastPrice + step;
    const tp2 = lastPrice + step * 2;
    const tp3 = lastPrice + step * 3;
    const sl = lastPrice - step;
    const zoneLow = (lastPrice - step * 0.5).toFixed(2);
    const zoneHigh = (lastPrice + step * 0.5).toFixed(2);
    return { tp1: tp1.toFixed(2), tp2: tp2.toFixed(2), tp3: tp3.toFixed(2), sl: sl.toFixed(2), breakout: `${zoneLow} - ${zoneHigh}` };
  } else if (bias === "Bearish") {
    const tp1 = lastPrice - step;
    const tp2 = lastPrice - step * 2;
    const tp3 = lastPrice - step * 3;
    const sl = lastPrice + step;
    const zoneLow = (lastPrice - step * 0.5).toFixed(2);
    const zoneHigh = (lastPrice + step * 0.5).toFixed(2);
    return { tp1: tp1.toFixed(2), tp2: tp2.toFixed(2), tp3: tp3.toFixed(2), sl: sl.toFixed(2), breakout: `${zoneLow} - ${zoneHigh}` };
  } else {
    return { tp1: "N/A", tp2: "N/A", tp3: "N/A", sl: "N/A", breakout: "N/A" };
  }
}

// news fetch (CoinDesk via codetabs/allorigins)
async function fetchHeadlines(limit = 4) {
  try {
    // try codetabs-proxy coindesk rss
    const proxy = "https://api.codetabs.com/v1/proxy/?quest=" + encodeURIComponent("https://www.coindesk.com/arc/outboundfeeds/rss/");
    const r = await fetch(proxy, { timeout: 10000 });
    if (!r.ok) throw new Error("codetabs coindesk failed");
    const txt = await r.text();
    const items = txt.split("<item>").slice(1, limit + 1);
    const titles = items.map(it => {
      const t = (it.match(/<title>(.*?)<\/title>/i) || [null, ""])[1] || "";
      return t.replace(/<!\[CDATA\[|\]\]>/g, "");
    }).filter(Boolean);
    return titles.length ? titles : ["No news fetched"];
  } catch (e) {
    // fallback to cointelegraph via allorigins
    try {
      const r2 = await fetch("https://api.allorigins.win/get?url=" + encodeURIComponent("https://cointelegraph.com/rss"), { timeout: 10000 });
      const j = await r2.json();
      const items = j.contents.split("<item>").slice(1, limit + 1);
      const titles = items.map(it => (it.match(/<title>(.*?)<\/title>/i) || [null, ""])[1].replace(/<!\[CDATA\[|\]\]>/g, ""));
      return titles.length ? titles : ["No news fetched"];
    } catch (err) {
      return ["No news fetched"];
    }
  }
}

// simple news sentiment (keyword)
function newsSentiment(headlines = []) {
  const pos = ["rise","gain","bull","surge","approval","soar","positive","up","rally"];
  const neg = ["fall","drop","bear","crash","selloff","liquidation","ban","lawsuit","negative","dump"];
  let score = 0;
  for (const t of headlines) {
    const l = (t || "").toLowerCase();
    pos.forEach(k => { if (l.includes(k)) score++; });
    neg.forEach(k => { if (l.includes(k)) score--; });
  }
  if (score > 1) return { label: "Positive", score };
  if (score < -1) return { label: "Negative", score };
  return { label: "Neutral", score };
}

// accuracy store (simple file-free using process.env fallback is not persistent across runs in Render — local dev you can switch to JSON file)
// We'll store in memory + write to small local file "acc_v7.json" when possible
import fs from "fs";
const ACC_FILE = "./acc_v7.json";
let accArr = [];
try {
  if (fs.existsSync(ACC_FILE)) {
    accArr = JSON.parse(fs.readFileSync(ACC_FILE, "utf8"));
  }
} catch (e) { accArr = []; }
function pushAccuracy(ok) {
  accArr.push(ok ? 1 : 0);
  if (accArr.length > 100) accArr.shift();
  try { fs.writeFileSync(ACC_FILE, JSON.stringify(accArr)); } catch (e) { /* ignore */ }
}
function getAcc(lastN = 10) {
  const arr = accArr.slice(-lastN);
  if (!arr.length) return "N/A";
  const pct = (arr.reduce((a, b) => a + b, 0) / arr.length) * 100;
  return `${pct.toFixed(1)}%`;
}

// smart alert threshold config
const ALERT_CONF = {
  minConfidencePct: 65, // overall confidence to trigger Smart Alert
  requireNewsConfirm: false, // require news sentiment to match bias
  cooldownMin: 8, // don't spam alerts; cooldown minutes between smart alerts
};
let lastSmartAlertAt = 0;

// main analyzer & reporter
async function analyzeAndReport() {
  try {
    const TIMEFRAMES = ["1m","5m","15m","30m","1h"];
    const results = [];
    let bulls = 0, bears = 0;
    let lastPrice = null;

    for (const tf of TIMEFRAMES) {
      const kl = await fetchKlines(SYMBOL, tf, 80).catch(err => { console.warn("kl fetch err", tf, err.message); return []; });
      if (!kl || !kl.length) {
        results.push({ tf, ok: false, msg: "no data" });
        continue;
      }
      const div = divergenceAnalysis(kl);
      const ell = elliottHeuristic(kl);
      const fib = fibLevels(kl);
      const atr = simpleATR(kl, 14);
      lastPrice = kl[kl.length - 1].close;
      const slopePct = ((kl[kl.length - 1].close - kl[0].close) / kl[0].close) * 100;
      const slopeLabel = Math.abs(slopePct) < 0.2 ? "Flat" : slopePct > 0 ? "Uptrend" : "Downtrend";
      // aggregate
      if (div.type.includes("Bullish")) bulls++;
      if (div.type.includes("Bearish")) bears++;
      results.push({
        tf, div, ell, fib, atr, slopePct: slopePct.toFixed(2), slopeLabel
      });
    }

    // news
    const headlines = await fetchHeadlines(6);
    const ns = newsSentiment(headlines);

    // decide overall bias
    const bias = bulls > bears ? "Bullish" : bears > bulls ? "Bearish" : "Neutral";
    const rawConfidence = Math.abs(bulls - bears) / TIMEFRAMES.length; // 0..1
    const confidencePct = Math.round((rawConfidence * 100) + 20); // base 20% to 100%
    // compute final last price targets
    const targs = targetsAndZones(lastPrice, bias);

    // accuracy check: compare previous prediction (stored in last_pred_v7.json)
    let prevPred = null;
    try {
      if (fs.existsSync("./last_pred_v7.json")) {
        const p = JSON.parse(fs.readFileSync("./last_pred_v7.json", "utf8"));
        prevPred = p.pred;
        const prevKline = p.prevClose || null;
        // check last movement only if prevKline exists
        if (prevKline && lastPrice) {
          const actual = lastPrice > prevKline ? "Bullish" : lastPrice < prevKline ? "Bearish" : "Neutral";
          pushAccuracy(prevPred === actual);
        }
      }
    } catch (e) { /* ignore */ }

    // store current pred for next cycle
    try {
      fs.writeFileSync("./last_pred_v7.json", JSON.stringify({ pred: bias, prevClose: lastPrice }));
    } catch (e) { /* ignore */ }

    // build message
    let msg = `🤖 <b>${SYMBOL} — AI Trader v7</b>\n🕒 ${nowIndia()}\n\n`;
    for (const r of results) {
      if (!r.div) { msg += `⏱ ${r.tf} | No data\n`; continue; }
      msg += `⏱ ${r.tf} | ${r.div.type} | ΔP ${r.div.dp}% | ΔV ${r.div.dv}% | Strength ${r.div.strength}%\n`;
      msg += `     Elliott: ${r.ell.name} (${r.ell.conf}%) | Fib0.618: ${r.fib?.fib618 ? r.fib.fib618.toFixed(2) : "N/A"}\n`;
    }
    msg += `\n🎯 Targets:\nTP1: ${targs.tp1} | TP2: ${targs.tp2} | TP3: ${targs.tp3}\nSL: ${targs.sl}\n📊 Breakout Range: ${targs.breakout}\n\n`;
    msg += `🧠 Overall Bias: <b>${bias}</b> | Confidence: ${confidencePct}%\n💰 Last Price: ${lastPrice}\n📈 Accuracy(Last10): ${getAcc(10)}\n📰 News Sentiment: ${ns.label} (${ns.score})\n\n🗞 Headlines:\n${headlines.map(h => "• " + h).join("\n")}\n`;

    // smart alert decision
    const nowTs = Date.now();
    if ((confidencePct >= ALERT_CONF.minConfidencePct) && ((nowTs - lastSmartAlertAt) / 60000 > ALERT_CONF.cooldownMin)) {
      // optional news confirm
      if (!ALERT_CONF.requireNewsConfirm || (ALERT_CONF.requireNewsConfirm && ns.label !== "Neutral" && ns.label.includes(bias === "Bullish" ? "Positive" : "Negative"))) {
        msg += `\n🚨 <b>Smart Alert:</b> ${bias === "Bullish" ? "Bullish breakout candidate" : bias === "Bearish" ? "Bearish breakdown candidate" : "No strong alert"} (Conf ${confidencePct}%)\n`;
        lastSmartAlertAt = nowTs;
      }
    }

    await tgSend(msg, "HTML");
    console.log("Report sent", nowIndia());

  } catch (err) {
    console.error("analyzeAndReport err:", err.message);
    await tgSend(`⚠️ AI Trader v7: error: ${err.message}\n${nowIndia()}`);
  }
}

// self-ping for Render keepalive (safe)
async function selfPing() {
  const url = process.env.RENDER_EXTERNAL_URL ? (process.env.RENDER_EXTERNAL_URL.startsWith("http") ? process.env.RENDER_EXTERNAL_URL : `https://${process.env.RENDER_EXTERNAL_URL}`) : null;
  if (!url) return;
  try {
    const r = await fetch(url);
    console.log("selfPing status", r.status);
  } catch (e) {
    console.warn("selfPing fail", e.message);
  }
}

// express server (keeps instance alive and handles Telegram webhook optional)
const app = express();
app.use(express.json());
app.get("/", (_, res) => res.send("AI Trader v7 running"));
app.post("/webhook", async (req, res) => {
  const text = req.body?.message?.text || "";
  if (text === "/help") {
    await tgSend(`<b>AI Trader v7 — Help</b>\n/now - run now\n/status - accuracy\n/help - this message`);
  } else if (text === "/now") {
    await analyzeAndReport();
  } else if (text === "/status") {
    await tgSend(`Accuracy(Last10): ${getAcc(10)}\nLast smart alert: ${lastSmartAlertAt ? new Date(lastSmartAlertAt).toLocaleString() : "never"}`);
  }
  res.sendStatus(200);
});

// start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening ${PORT}`));
console.log("AI Trader v7 starting...");

// schedule
(async () => {
  await analyzeAndReport(); // initial
  setInterval(analyzeAndReport, CHECK_INTERVAL_MIN * 60 * 1000);
  // self-ping every 3 minutes if URL set
  setInterval(selfPing, 3 * 60 * 1000);
})();