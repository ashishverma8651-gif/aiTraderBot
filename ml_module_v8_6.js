// ml_module_v8_6.js
export async function runMLPrediction(klines) {
  // Placeholder ML: returns probability (0-100)
  // In future replace with actual model inference
  if (!klines || !klines.length) return { prob: 50.0, label: "neutral" };
  // quick features: last close up/down
  const last = klines.slice(-3).map(k => k.close);
  const trend = last[2] > last[0] ? 1 : -1;
  const prob = 50 + trend * (Math.min(40, Math.abs((last[2]-last[0]) / last[0] * 100)));
  const label = prob > 55 ? "buy" : (prob < 45 ? "sell" : "neutral");
  return { prob: Number(Math.max(0, Math.min(100, prob)).toFixed(1)), label };
}