// merge_signals.js
export function mergeSignals(indicators, elliott, ml) {
  // indicators: { rsi, macd }
  // elliott: { structure, wave, confidence }
  // ml: { prob, label }
  let bias = "Neutral";
  let strength = 0;

  if (indicators && indicators.rsi) {
    if (indicators.rsi < 30) { bias = "Buy"; strength += 20; }
    else if (indicators.rsi > 70) { bias = "Sell"; strength += 20; }
  }
  if (indicators.macd) {
    if (indicators.macd.macd > indicators.macd.signal) { bias = bias === "Sell" ? "Neutral" : "Buy"; strength += 25; }
    else if (indicators.macd.macd < indicators.macd.signal) { bias = bias === "Buy" ? "Neutral" : "Sell"; strength += 25; }
  }
  if (ml && ml.prob) {
    if (ml.prob > 55) { bias = "Buy"; strength += (ml.prob - 50); }
    else if (ml.prob < 45) { bias = "Sell"; strength += (50 - ml.prob); }
  }
  if (elliott && elliott.confidence) {
    strength += Math.min(20, elliott.confidence / 10);
  }

  strength = Math.round(Math.min(100, strength));
  return { bias, strength, mlProb: ml.prob || 50 };
}