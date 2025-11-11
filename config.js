// config.js
import axios from "axios";
import fs from "fs";

// ✅ Auto create cache folder if missing
if (!fs.existsSync("./cache")) fs.mkdirSync("./cache");

const CONFIG = {
  SYMBOL: "BTCUSDT",
  SELF_PING_URL:
    process.env.SELF_PING_URL || "https://your-render-url.onrender.com",
  CACHE_FILE: "./cache/marketData.json",

  MARKETS: {
    CRYPTO: ["BTCUSDT", "ETHUSDT", "BNBUSDT"],
    FOREX: ["USDINR", "EURINR", "GBPUSD"],
    INDIAN: ["NIFTY", "SENSEX", "RELIANCE.NS"],
    METALS: ["GOLD", "SILVER"],
  },
};

// ✅ Binance main + alternates
const BINANCE_SOURCES = [
  "https://api.binance.com",
  "https://api1.binance.com",
  "https://api2.binance.com",
  "https://api3.binance.com",
];

// ✅ Alternate APIs (when Binance fails)
const FALLBACK_SOURCES = {
  COINGECKO: "https://api.coingecko.com/api/v3",
  KUCOIN: "https://api.kucoin.com",
  YAHOO: "https://query1.finance.yahoo.com",
};

// ✅ Fetch market data (auto multi-source)
async function fetchMarketData(symbol = "BTCUSDT") {
  const headers = { "User-Agent": "Mozilla/5.0 (compatible; AITraderBot/1.0)" };

  // 🔁 Try Binance APIs
  for (const base of BINANCE_SOURCES) {
    const url = `${base}/api/v3/klines?symbol=${symbol}&interval=1m&limit=500`;
    try {
      console.log("📡 Trying Binance:", base);
      const res = await axios.get(url, { headers, timeout: 8000 });

      if (res.data && res.data.length) {
        const formatted = res.data.map((d) => ({
          time: d[0],
          open: parseFloat(d[1]),
          high: parseFloat(d[2]),
          low: parseFloat(d[3]),
          close: parseFloat(d[4]),
          volume: parseFloat(d[5]),
        }));

        // ✅ Cache last 1440 entries (~1 day of 1m data)
        fs.writeFileSync(
          CONFIG.CACHE_FILE,
          JSON.stringify(formatted.slice(-1440), null, 2)
        );

        return formatted;
      }
    } catch (err) {
      console.warn(`❌ Binance failed: ${base} (${err.response?.status || err.message})`);
      continue;
    }
  }

  // 🔁 Fallback APIs
  for (const [name, base] of Object.entries(FALLBACK_SOURCES)) {
    try {
      console.log(`🌐 Trying fallback: ${name}`);

      if (name === "COINGECKO") {
        const res = await axios.get(
          `${base}/coins/bitcoin/market_chart?vs_currency=usd&days=1`,
          { headers }
        );
        if (res.data?.prices) {
          const formatted = res.data.prices.map(([time, price]) => ({
            time,
            open: price,
            high: price,
            low: price,
            close: price,
            volume: 0,
          }));
          fs.writeFileSync(CONFIG.CACHE_FILE, JSON.stringify(formatted, null, 2));
          return formatted;
        }
      }

      if (name === "KUCOIN") {
        const res = await axios.get(
          `${base}/api/v1/market/candles?symbol=BTC-USDT&type=1min`,
          { headers }
        );
        if (res.data?.data) {
          const formatted = res.data.data.map((d) => ({
            time: d[0],
            open: parseFloat(d[1]),
            close: parseFloat(d[2]),
            high: parseFloat(d[3]),
            low: parseFloat(d[4]),
            volume: parseFloat(d[5]),
          }));
          fs.writeFileSync(CONFIG.CACHE_FILE, JSON.stringify(formatted, null, 2));
          return formatted;
        }
      }

      if (name === "YAHOO") {
        const res = await axios.get(
          `${base}/v8/finance/chart/BTC-USD?interval=1m&range=1d`,
          { headers }
        );
        if (res.data?.chart?.result?.[0]?.indicators?.quote?.[0]) {
          const q = res.data.chart.result[0].indicators.quote[0];
          const times = res.data.chart.result[0].timestamp;
          const formatted = times.map((t, i) => ({
            time: t * 1000,
            open: q.open[i],
            high: q.high[i],
            low: q.low[i],
            close: q.close[i],
            volume: q.volume[i],
          }));
          fs.writeFileSync(CONFIG.CACHE_FILE, JSON.stringify(formatted, null, 2));
          return formatted;
        }
      }
    } catch (err) {
      console.warn(`⚠️ Fallback ${name} failed (${err.response?.status || err.message})`);
    }
  }

  // 💾 Cache fallback
  if (fs.existsSync(CONFIG.CACHE_FILE)) {
    console.log("💾 Using cached data");
    return JSON.parse(fs.readFileSync(CONFIG.CACHE_FILE, "utf8"));
  }

  console.error("🚨 All sources failed!");
  return [];
}

// ✅ Export for aiTraderBot.js
export { CONFIG, fetchMarketData };
export default CONFIG;