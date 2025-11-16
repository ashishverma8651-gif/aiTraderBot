// ============================================================
//  Reversal Watcher (Full Patched, No-Spam, ML-integrated)
// ============================================================

import { safeAxiosGet, sleep } from "./utils.js";
import { sendMessage } from "./telegram.js";

import {
  runMicroPrediction,
  runMLPrediction,
  recordPrediction,
  recordOutcome,
  calculateAccuracy
} from "./ml_module_v8_6.js";

// -----------------------------
// INTERNAL STATE
// -----------------------------
let _running = false;
let _timer = null;

// anti-spam memory
let _lastAlertAt = 0;
let _lastZoneAlert = new Map();      // symbol -> last entry zone alert time
let _lastSentPerSymbol = new Map();  // symbol -> last reversal alert time
let _wasInsideZone = new Map();      // symbol -> price was inside zone or not

// -----------------------------
// CONFIG
// -----------------------------
let _config = {
  symbol: "BTCUSDT",

  pollIntervalMs: 20 * 1000,

  minAlertConfidence: 55,
  zonePaddingPct: 0.0025,

  maxAlertsPerMinutePerSymbol: 6,
  globalRateLimitSec: 6,

  // Entry zone system ON
  entryZoneEnabled: true
};

// ------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------

// fetch OKX kline
async function fetchKline(symbol, tf, limit = 50) {
  try {
    const url = `https://www.okx.com/api/v5/market/candles?instId=${symbol}&bar=${tf}&limit=${limit}`;
    const r = await safeAxiosGet(url);
    if (!r || !r.data || !r.data.data) return null;

    return r.data.data.map(c => ({
      ts: Number(c[0]),
      open: Number(c[1]),
      high: Number(c[2]),
      low: Number(c[3]),
      close: Number(c[4]),
      volume: Number(c[5])
    })).reverse();
  } catch (e) {
    return null;
  }
}

// moving average
function sma(arr, len) {
  if (arr.length < len) return null;
  let s = 0;
  for (let i = arr.length - len; i < arr.length; i++) s += arr[i];
  return s / len;
}

// -----------------------------
// ENTRY ZONE ALERT
// -----------------------------
async function checkEntryZone(symbol, price, ML) {
  if (!_config.entryZoneEnabled) return;

  // fetch Tf candles
  const c1 = await fetchKline(symbol, "1m", 50);
  const c5 = await fetchKline(symbol, "5m", 50);
  const c15 = await fetchKline(symbol, "15m", 50);

  if (!c1 || !c5 || !c15) return;

  const last1 = c1.at(-1).close;
  const last5 = c5.at(-1).close;
  const last15 = c15.at(-1).close;

  const zoneLow = Math.min(last1, last5, last15) * (1 - _config.zonePaddingPct);
  const zoneHigh = Math.max(last1, last5, last15) * (1 + _config.zonePaddingPct);

  const inside = price >= zoneLow && price <= zoneHigh;
  const prev = _wasInsideZone.get(symbol) || false;

  if (!inside) {
    _wasInsideZone.set(symbol, false);
    return;
  }

  if (prev === true) {
    return; // already inside zone
  }

  _wasInsideZone.set(symbol, true);

  const now = Date.now();
  const last = _lastZoneAlert.get(symbol) || 0;
  if (now - last < 25000) return; // 25s cooldown
  _lastZoneAlert.set(symbol, now);

  // direction logic
  let direction = "Neutral";

  const closes15 = c15.map(x => x.close);
  const maFast = sma(closes15, 5);
  const maSlow = sma(closes15, 20);
  const rsi = computeRSI(c15) || 50;

  if (maFast && maSlow) {
    if (maFast > maSlow) direction = "Bullish";
    if (maFast < maSlow) direction = "Bearish";
  }

  if (rsi < 35) direction = "Bullish";
  if (rsi > 65) direction = "Bearish";

  if (ML && ML.label === "Bullish" && ML.prob > 55) direction = "Bullish";
  if (ML && ML.label === "Bearish" && ML.prob > 55) direction = "Bearish";

  await sendMessage(`
🔔 *ENTRY ZONE ALERT — ${direction}*
Symbol: ${symbol}
Zone: ${zoneLow.toFixed(2)} - ${zoneHigh.toFixed(2)}
Price: ${price}
ML: ${ML?.label || "N/A"} (${ML?.prob || "?"}%)
Instant entry zone touch
  `);
}

// -----------------------------
// SIMPLE RSI CALC
// -----------------------------
function computeRSI(candles, period = 14) {
  if (!candles || candles.length < period + 2) return null;

  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    let diff = candles[i].close - candles[i - 1].close;
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }

  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;

  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ============================================================
// MAIN LOOP
// ============================================================
async function poll() {
  const symbol = _config.symbol;

  const candles = await fetchKline(symbol, "1m", 50);
  if (!candles) return;

  const price = candles.at(-1).close;

  const ML = await runMicroPrediction(symbol);
  checkEntryZone(symbol, price, ML);

  const now = Date.now();
  if (now - _lastAlertAt < _config.globalRateLimitSec * 1000) return;

  const lastSymbolAlert = _lastSentPerSymbol.get(symbol) || 0;
  if (now - lastSymbolAlert < 10000) return;

  const prevClose = candles.at(-2).close;
  const changePct = ((price - prevClose) / prevClose) * 100;

  if (Math.abs(changePct) > 0.3) {
    _lastAlertAt = now;
    _lastSentPerSymbol.set(symbol, now);

    const mlFull = await runMLPrediction(symbol);

    await sendMessage(`
⚡ *REVERSAL DETECTED — ${changePct > 0 ? "Bullish" : "Bearish"}*
Symbol: ${symbol}
Price: ${price}
Change: ${changePct.toFixed(2)}%
ML: ${mlFull.label} (${mlFull.prob}%)
    `);
  }
}

// ============================================================
// PUBLIC START STOP
// ============================================================
export function startReversalWatcher(cfg = {}) {
  if (_running) return;

  _config = { ..._config, ...cfg };
  _running = true;

  console.log("⚡ Reversal Watcher STARTED");

  poll();
  _timer = setInterval(poll, _config.pollIntervalMs);
}

export function stopReversalWatcher() {
  _running = false;
  if (_timer) clearInterval(_timer);
  console.log("🛑 Reversal Watcher STOPPED");
}