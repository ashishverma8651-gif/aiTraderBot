// utils.js
import CONFIG from "./config.js";
import https from "https";

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
  });
}

export async function fetchPrice(market, symbol) {
  const map = CONFIG.SYMBOLS[market][symbol];

  const yahooSymbol = map.yahoo;
  const binanceSymbol = map.binance;

  // 1️⃣ Try Binance (crypto only)
  if (binanceSymbol) {
    for (const api of CONFIG.API.BINANCE) {
      try {
        const res = await fetchJSON(`${api}/api/v3/ticker/price?symbol=${binanceSymbol}`);
        if (res.price) return Number(res.price);
      } catch {}
    }
  }

  // 2️⃣ Try Yahoo (all markets)
  for (const base of CONFIG.API.YAHOO) {
    try {
      const url = `${base}/${yahooSymbol}?interval=1m&range=1d`;
      const data = await fetchJSON(url);

      const c = data.chart?.result?.[0]?.meta?.regularMarketPrice;
      if (c) return Number(c);
    } catch {}
  }

  throw new Error(`All sources failed: ${symbol}`);
}

export async function fetchMultiTF(market, symbol) {
  const price = await fetchPrice(market, symbol);
  return {
    price,
    time: new Date().toLocaleString()
  };
}