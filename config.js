// config.js
import axios from "axios";

const CONFIG = {
  SYMBOL: "BTCUSDT", // Default main pair
  SELF_PING_URL: "https://aitraderbot.onrender.com",
  SOURCES: {
    CRYPTO: ["binance", "kucoin", "coingecko", "yahoo"],
    INDIAN: ["yahoo", "nse"],
    METAL: ["yahoo", "metalsapi"]
  }
};

// ==================================================================
// 🔹 Multi-Source Market Data Fetcher (Crypto + Indian + Metals)
//    → Fetches ~1 day of data (for ML & AI Trader reports)
// ==================================================================
export async function fetchMarketData(symbol = CONFIG.SYMBOL) {
  let data = [];

  // ======== 1️⃣ Crypto Market Sources ========
  for (const src of CONFIG.SOURCES.CRYPTO) {
    try {
      if (src === "binance") {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&limit=96`; 
        // 96 candles = 1 day (24h * 4)
        const res = await axios.get(url);
        data = res.data.map(d => ({
          time: d[0],
          open: parseFloat(d[1]),
          high: parseFloat(d[2]),
          low: parseFloat(d[3]),
          close: parseFloat(d[4]),
          volume: parseFloat(d[5])
        }));
        console.log("✅ Data fetched from Binance");
        break;
      }

      if (src === "kucoin") {
        const url = `https://api.kucoin.com/api/v1/market/candles?type=15min&symbol=${symbol.replace("USDT", "-USDT")}`;
        const res = await axios.get(url);
        data = res.data.data.reverse().map(d => ({
          time: parseInt(d[0]) * 1000,
          open: parseFloat(d[1]),
          close: parseFloat(d[2]),
          high: parseFloat(d[3]),
          low: parseFloat(d[4]),
          volume: parseFloat(d[5])
        }));
        console.log("✅ Data fetched from KuCoin");
        break;
      }

      if (src === "coingecko") {
        const cgSymbol = symbol.toLowerCase().replace("usdt", "");
        const url = `https://api.coingecko.com/api/v3/coins/${cgSymbol}/market_chart?vs_currency=usd&days=1`;
        const res = await axios.get(url);
        data = res.data.prices.map(([time, price]) => ({
          time,
          open: price,
          high: price,
          low: price,
          close: price,
          volume: 0
        }));
        console.log("✅ Data fetched from CoinGecko");
        break;
      }

      if (src === "yahoo") {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}=X?interval=15m`;
        const res = await axios.get(url);
        const chart = res.data.chart.result[0];
        data = chart.timestamp.map((t, i) => ({
          time: t * 1000,
          open: chart.indicators.quote[0].open[i],
          high: chart.indicators.quote[0].high[i],
          low: chart.indicators.quote[0].low[i],
          close: chart.indicators.quote[0].close[i],
          volume: chart.indicators.quote[0].volume[i]
        }));
        console.log("✅ Data fetched from Yahoo Finance (crypto)");
        break;
      }
    } catch (err) {
      console.warn(`⚠️ ${src} fetch failed:`, err.response?.status || err.message);
    }
  }

  // ======== 2️⃣ Indian Market (fallback) ========
  if (!data.length) {
    for (const src of CONFIG.SOURCES.INDIAN) {
      try {
        if (src === "yahoo") {
          const url = `https://query1.finance.yahoo.com/v8/finance/chart/RELIANCE.NS?interval=15m`;
          const res = await axios.get(url);
          const chart = res.data.chart.result[0];
          data = chart.timestamp.map((t, i) => ({
            time: t * 1000,
            open: chart.indicators.quote[0].open[i],
            high: chart.indicators.quote[0].high[i],
            low: chart.indicators.quote[0].low[i],
            close: chart.indicators.quote[0].close[i],
            volume: chart.indicators.quote[0].volume[i]
          }));
          console.log("✅ Data fetched from Yahoo (Indian market)");
          break;
        }

        if (src === "nse") {
          const url = `https://www.nseindia.com/api/quote-equity?symbol=RELIANCE`;
          const res = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" } });
          data = [{
            time: Date.now(),
            open: res.data.priceInfo.open,
            high: res.data.priceInfo.intraDayHighLow.max,
            low: res.data.priceInfo.intraDayHighLow.min,
            close: res.data.priceInfo.lastPrice,
            volume: res.data.securityInfo?.totalTradedQuantity || 0
          }];
          console.log("✅ Data fetched from NSE API");
          break;
        }
      } catch (err) {
        console.warn(`⚠️ ${src} fetch failed:`, err.response?.status || err.message);
      }
    }
  }

  // ======== 3️⃣ Metals fallback ========
  if (!data.length) {
    for (const src of CONFIG.SOURCES.METAL) {
      try {
        if (src === "metalsapi") {
          const url = `https://metals-api.com/api/latest?base=USD&symbols=XAU,XAG`;
          const res = await axios.get(url);
          const rates = res.data.rates;
          data = Object.keys(rates).map(k => ({
            time: Date.now(),
            open: rates[k],
            high: rates[k],
            low: rates[k],
            close: rates[k],
            volume: 0
          }));
          console.log("✅ Data fetched from Metals API");
          break;
        }
      } catch (err) {
        console.warn(`⚠️ Metals fetch failed:`, err.response?.status || err.message);
      }
    }
  }

  // ======== 4️⃣ Final check ========
  if (!data.length) throw new Error("❌ No valid market data found from any source");

  return { data };
}

export default CONFIG;