// utils.js
import axios from "axios";

export function keepAlive(url) {
  if (!url) return;
  setInterval(() => {
    axios.get(url)
      .then(() => console.log("💗 Keep-alive ping sent"))
      .catch(() => {});
  }, 1000 * 60 * 4);
}

export function nowLocal() {
  return new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
}

export async function fetchMarketData(symbol = "BTCUSDT", interval = "15m") {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=50`;
    const res = await axios.get(url);
    const data = res.data.map(d => ({
      open: +d[1], high: +d[2], low: +d[3], close: +d[4]
    }));
    return { data, source: "binance" };
  } catch (err) {
    console.error("❌ Market fetch error:", err.message);
    return { data: [], source: "error" };
  }
}