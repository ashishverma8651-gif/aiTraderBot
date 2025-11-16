// ======================================================
// reversal_watcher_v3.js — FINAL STABLE VERSION
// ======================================================
import { fetchMultiTF } from "./utils.js";
import { runMLPrediction, runMicroPrediction, recordPrediction, recordOutcome } from "./ml_module_v8_6.js";
import * as indicators from "./core_indicators.js";

let RUNNING = false;
let LOOP = null;
let LAST_ALERT_TIME = 0;
let LAST_SENT = "";
let PENDING = null;

// ================================================
// Helper
// ================================================
function nowIST() {
  return new Date().toLocaleString("en-IN", {
    hour12: true,
    timeZone: "Asia/Kolkata"
  });
}

function fmt(n) {
  return Number(n).toFixed(2);
}

// ======================================================
// PATTERN DETECTOR (Lightweight)
// ======================================================
function detectReversalPattern(candles = []) {
  if (!candles || candles.length < 5) return { label: "None", score: 0 };

  const c1 = candles.at(-1);
  const c2 = candles.at(-2);
  const c3 = candles.at(-3);

  let score = 0;
  let label = "None";

  // Hammer
  const body = Math.abs(c1.close - c1.open);
  const lower = Math.min(c1.open, c1.close) - c1.low;
  if (lower > body * 2) {
    score += 20;
    label = "Hammer";
  }

  // Engulfing
  if (c1.close > c1.open && c2.close < c2.open && c1.close > c2.open && c1.open < c2.close) {
    score += 25;
    label = "Bullish Engulfing";
  }
  if (c1.close < c1.open && c2.close > c2.open && c1.close < c2.open && c1.open > c2.close) {
    score += 25;
    label = "Bearish Engulfing";
  }

  // Triple pivot
  if (c2.low < c1.low && c2.low < c3.low) {
    score += 15;
    label = "Pivot Reversal";
  }

  return { label, score: Math.min(100, score) };
}

// ======================================================
// FORMAT ALERT MESSAGE
// ======================================================
function buildAlertHTML(obj) {
  return `
<b>⚠ REVERSAL WATCHER v3</b>
Time: <b>${nowIST()}</b>

<b>Symbol:</b> ${obj.symbol}
<b>Direction:</b> ${obj.side}
Confidence: <b>${fmt(obj.conf)}%</b>

TF-weighted Bias: ${fmt(obj.bias)}
Pattern: <b>${obj.pattern}</b> (${obj.patternScore})

ML: <b>${obj.mlLabel}</b> (${fmt(obj.mlProb)}%)
MicroML: <b>${obj.microLabel}</b> (${fmt(obj.microProb)}%)

<b>Entry:</b> ${obj.entry}
<b>Est. TP:</b> ${obj.tp}
<b>SL Guide:</b> ${obj.sl}

ID: <code>${obj.predId}</code>
  `.trim();
}

// ======================================================
// MAIN RUNNER
// ======================================================
async function scan(symbol, cfg, onSend) {
  try {
    // FETCH MULTI TF ==========================
    const tfs = cfg.tfs;
    const multi = await fetchMultiTF(symbol, tfs);

    if (!multi["15m"]?.data?.length) return;

    const price = multi["1m"]?.price || multi["5m"]?.price || multi["15m"]?.price;

    // ===========================
    // PATTERN
    const pattern = detectReversalPattern(multi["15m"].data);

    // ===========================
    // ML
    const ml = await runMLPrediction(symbol);
    const micro = await runMicroPrediction(symbol, cfg.microLookback);

    const fusedBull =
      ml.probBull * cfg.weights["15m"] +
      micro.probBull * cfg.weights["1m"];

    const fusedBear =
      ml.probBear * cfg.weights["15m"] +
      micro.probBear * cfg.weights["1m"];

    const bias = fusedBull - fusedBear;

    let side = "Neutral";
    if (bias > 0) side = "Bullish";
    if (bias < 0) side = "Bearish";

    const conf = Math.abs(bias) * 100;

    // ==========================================
    // SEND ALERT WHEN CONFIDENCE HIGH
    if (conf >= cfg.minAlertConfidence) {
      const tp = (price * ml.tpMul).toFixed(2);
      const sl = side === "Bullish" ? (price * 0.995).toFixed(2) : (price * 1.005).toFixed(2);

      // record ML prediction for feedback learning
      const predId = await recordPrediction({
        featureVector: ml.featureVector,
        label: ml.label,
        priceAtDetect: price,
        createdAt: Date.now()
      });

      const html = buildAlertHTML({
        symbol,
        side,
        conf,
        pattern: pattern.label,
        patternScore: pattern.score,
        mlLabel: ml.label,
        mlProb: ml.prob,
        microLabel: micro.label,
        microProb: micro.prob,
        entry: price,
        tp,
        sl,
        bias,
        predId
      });

      if (html !== LAST_SENT) {
        LAST_SENT = html;
        await onSend(html);

        // set pending for outcome feedback
        PENDING = {
          predId,
          symbol,
          priceAtDetect: price,
          time: Date.now()
        };
      }
    }

    // FEEDBACK ====================================
    if (PENDING) {
      const age = (Date.now() - PENDING.time) / 1000;

      if (cfg.feedbackWindowsSec.includes(Math.floor(age))) {
        const cur = multi["1m"]?.price || price;
        const ret = (cur - PENDING.priceAtDetect) / PENDING.priceAtDetect;

        await recordOutcome(PENDING.predId, {
          realizedReturn: ret
        });
      }

      if (age > Math.max(...cfg.feedbackWindowsSec)) {
        PENDING = null;
      }
    }
  } catch (e) {
    console.log("RW error:", e.message);
  }
}

// ======================================================
// START / STOP
// ======================================================
export function startReversalWatcher(symbol, cfg, onSend) {
  if (RUNNING) return;
  RUNNING = true;

  LOOP = setInterval(() => scan(symbol, cfg, onSend), cfg.pollIntervalMs);

  console.log("⚡ ReversalWatcher v3 started");
}

export async function stopReversalWatcher() {
  RUNNING = false;
  if (LOOP) clearInterval(LOOP);
}