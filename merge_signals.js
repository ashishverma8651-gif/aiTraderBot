// merge_signals.js (tolerant)
export function mergeSignals(indicators = {}, elliott = {}, ml = {}) {
  // indicators: { rsi, macd } where rsi might be {value,summary} or number
  let bias = "Neutral";
  let strength = 0;

  // handle rsi that can be object
  const rsiVal = (() => {
    if (!indicators || indicators.rsi == null) return null;
    if (typeof indicators.rsi === "number") return indicators.rsi;
    if (typeof indicators.rsi === "object") return indicators.rsi.value ?? null;
    return null;
  })();

  if (rsiVal != null) {
    if (rsiVal < 30) { bias = "Buy"; strength += 20; }
    else if (rsiVal > 70) { bias = "Sell"; strength += 20; }
  }

  if (indicators.macd) {
    // macd may contain arrays; compare latest values
    const macdLatest = Array.isArray(indicators.macd.macd)
      ? indicators.macd.macd[indicators.macd.macd.length - 1]
      : indicators.macd.macd;
    const sigLatest = Array.isArray(indicators.macd.signal)
      ? indicators.macd.signal[indicators.macd.signal.length - 1]
      : indicators.macd.signal;

    if (typeof macdLatest === "number" && typeof sigLatest === "number") {
      if (macdLatest > sigLatest) { bias = bias === "Sell" ? "Neutral" : "Buy"; strength += 25; }
      else if (macdLatest < sigLatest) { bias = bias === "Buy" ? "Neutral" : "Sell"; strength += 25; }
    }
  }

  if (ml && typeof ml.prob === "number") {
    if (ml.prob > 55) { bias = "Buy"; strength += (ml.prob - 50); }
    else if (ml.prob < 45) { bias = "Sell"; strength += (50 - ml.prob); }
  }

  if (elliott && typeof elliott.confidence === "number") {
    strength += Math.min(20, elliott.confidence / 10);
  }

  strength = Math.round(Math.min(100, strength));
  return { bias, strength, mlProb: ml.prob || 50 };
}