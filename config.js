// config.js
import axios from "axios";
import fs from "fs";

const CONFIG = {
  SYMBOLS: {
    CRYPTO: "BTCUSDT",
    INDIA: "RELIANCE.NS",
    METAL: "XAUUSD"
  },
  SELF_PING_URL: "https://aitraderbot.onrender.com",
  CURRENCY: {
    CRYPTO: "USD",
    INDIA: "INR",
    METAL: "USD"
  },
  SOURCES: {
    CRYPTO: [
      "binance_main",
      "binance_alt",
      "coingecko",
      "kucoin",
      "yahoo_crypto"
    ],
    INDIA: ["yahoo_finance", "nse_api"],
    METAL: ["metalsapi", "yahoo_metals"]
  }
};

// =============== FETCH FUNCTION ===============
export async function fetchMarketData(market = "CRYPTO", symbol = CONFIG.SYMBOLS[market]) {
  const sources = CONFIG.SOURCES[market];
  let data = [];

  for (const src of sources) {
    try {
      console.log(`🌐 Trying ${market} source: ${src}`);

      // --- CRYPTO SOURCES ---
      if (src === "binance_main") {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&limit=96`;
        const res = await axios.get(url);
        data = res.data.map(d => ({
          time: d[0],
          open: +d[1],
          high: +d[2],
          low: +d[3],
          close: +d[4],
          volume: +d[5]
        }));
      } else if (src === "binance_alt") {
        const url = `https://api1.binance.com/api/v3/klines?symbol=${symbol}&interval=15m&limit=96`;
        const res = await axios.get(url);
        data = res.data.map(d => ({
          time: d[0],
          open: +d[1],
          high: +d[2],
          low: +d[3],
          close: +d[4],
          volume: +d[5]
        }));
      } else if (src === "coingecko") {
        const res = await axios.get(
          `https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=1`
        );
        data = res.data.prices.map(p => ({
          time: p[0],
          close: p[1]
        }));
      } else if (src === "kucoin") {
        const res = await axios.get(
          `https://api.kucoin.com/api/v1/market/candles?type=15min&symbol=${symbol}`
        );
        data = res.data.data.map(d => ({
          time: d[0],
          open: +d[1],
          close: +d[2],
          high: +d[3],
          low: +d[4],
          volume: +d[5]
        }));
      } else if (src === "yahoo_crypto") {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol.replace("USDT", "-USD")}?interval=15m&range=1d`;
        const res = await axios.get(url);
        const result = res.data.chart.result[0];
        data = result.timestamp.map((t, i) => ({
          time: t * 1000,
          open: result.indicators.quote[0].open[i],
          high: result.indicators.quote[0].high[i],
          low: result.indicators.quote[0].low[i],
          close: result.indicators.quote[0].close[i],
          volume: result.indicators.quote[0].volume[i]
        }));
      }

      // --- INDIAN MARKET SOURCES ---
      else if (src === "yahoo_finance") {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=15m&range=1d`;
        const res = await axios.get(url);
        const result = res.data.chart.result[0];
        data = result.timestamp.map((t, i) => ({
          time: t * 1000,
          open: result.indicators.quote[0].open[i],
          high: result.indicators.quote[0].high[i],
          low: result.indicators.quote[0].low[i],
          close: result.indicators.quote[0].close[i],
          volume: result.indicators.quote[0].volume[i]
        }));
      } else if (src === "nse_api") {
        const url = `https://www.nseindia.com/api/chart-databyindex?index=${symbol}`;
        const res = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" } });
        data = res.data.grapthData.map(p => ({
          time: p[0],
          close: p[1]
        }));
      }

      // --- METAL SOURCES ---
      else if (src === "metalsapi") {
        const url = `https://metals-api.com/api/timeseries?base=USD&symbols=XAU&start_date=2024-11-10&end_date=2024-11-11&access_key=demo`;
        const res = await axios.get(url);
        const metals = res.data.rates;
        data = Object.entries(metals).map(([date, val]) => ({
          time: new Date(date).getTime(),
          close: val.XAU
        }));
      } else if (src === "yahoo_metals") {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/XAUUSD=X?interval=15m&range=1d`;
        const res = await axios.get(url);
        const result = res.data.chart.result[0];
        data = result.timestamp.map((t, i) => ({
          time: t * 1000,
          open: result.indicators.quote[0].open[i],
          close: result.indicators.quote[0].close[i]
        }));
      }

      // ✅ SUCCESS
      if (data.length > 0) {
        console.log(`✅ ${market} data fetched successfully from ${src}`);
        fs.writeFileSync(`./cache_${market.toLowerCase()}.json`, JSON.stringify(data.slice(-96)));
        return { data };
      }

    } catch (err) {
      console.warn(`⚠️ ${src} failed for ${market}: ${err.message}`);
    }
  }

  // 🧩 Fallback: cached data
  try {
    const cached = JSON.parse(fs.readFileSync(`./cache_${market.toLowerCase()}.json`));
    console.log(`⚙️ Using cached ${market} data`);
    return { data: cached };
  } catch {
    throw new Error(`❌ No ${market} data from any source`);
  }
}

export default CONFIG;