//merge_signals.js
// merge_signals.js
export function mergeSignals(rsi, macd, elliott, ml) {
  // Combine logic simply
  const score = (rsi / 100 + macd.macd + elliott.confidence + ml.confidence) / 4;
  const decision = score > 0.5 ? "BUY" : "SELL";
  return { decision, score };
}