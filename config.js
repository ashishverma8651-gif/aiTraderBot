// ===============================
//   AI TRADER — HEAVY CONFIG (FINAL)
//   Works with: Single-file Heavy utils.js
//   Author: ChatGPT Custom Build
// ===============================

import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const CACHE_DIR = path.join(ROOT, "cache");

if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// ===============================
// MARKETS & SYMBOL MAPPING
// ===============================

export const CONFIG = {
  MODE: process.env.NODE_ENV || "production",

  ACTIVE_MARKET: process.env.ACTIVE_MARKET || "CRYPTO",
  ACTIVE_SYMBOL: process.env.ACTIVE_SYMBOL || "BTCUSDT",

  // ------------------------------------------
  // MARKET SYMBOL MAPS (HEAVY VERSION)
  // ------------------------------------------
  SYMBOLS: {
    CRYPTO: {
      BTCUSDT: {
        binance: "BTCUSDT",
        coinbase: "BTC-USD",
        okx: "BTC-USDT",
        yahoo: "BTC-USD",
        tv: "BINANCE:BTCUSDT",
      },
      ETHUSDT: {
        binance: "ETHUSDT",
        coinbase: "ETH-USD",
        okx: "ETH-USDT",
        yahoo: "ETH-USD",
        tv: "BINANCE:ETHUSDT",
      },
      BNBUSDT: {
        binance: "BNBUSDT",
        okx: "BNB-USDT",
        yahoo: "BNB-USD",
        tv: "BINANCE:BNBUSDT",
      },
      SOLUSDT: {
        binance: "SOLUSDT",
        okx: "SOL-USDT",
        yahoo: "SOL-USD",
        tv: "BINANCE:SOLUSDT",
      },
    },

    INDIA: {
      // TradingView primary, Yahoo alt
      NIFTY50: { tv: "NSE:NIFTY", yahoo: "^NSEI" },
      BANKNIFTY: { tv: "NSE:BANKNIFTY", yahoo: "^NSEBANK" },
      FINNIFTY: { tv: "NSE:FINNIFTY", yahoo: "^CNXFIN" },
      SENSEX: { tv: "BSE:SENSEX", yahoo: "^BSESN" },
      RELIANCE: { tv: "NSE:RELIANCE", yahoo: "RELI.NS" },
      TCS: { tv: "NSE:TCS", yahoo: "TCS.NS" },
    },

    FOREX: {
      EURUSD: { yahoo: "EURUSD=X", tv: "FX:EURUSD" },
      GBPUSD: { yahoo: "GBPUSD=X", tv: "FX:GBPUSD" },
      USDJPY: { yahoo: "JPY=X", tv: "FX:USDJPY" },
      AUDUSD: { yahoo: "AUDUSD=X", tv: "FX:AUDUSD" },
    },

    US_STOCKS: {
      AAPL: { yahoo: "AAPL", tv: "NASDAQ:AAPL" },
      TSLA: { yahoo: "TSLA", tv: "NASDAQ:TSLA" },
      NVDA: { yahoo: "NVDA", tv: "NASDAQ:NVDA" },
      MSFT: { yahoo: "MSFT", tv: "NASDAQ:MSFT" },
      AMZN: { yahoo: "AMZN", tv: "NASDAQ:AMZN" },
    },

    COMMODITIES: {
      GOLD: { yahoo: "GC=F", tv: "COMEX:GC1!" },
      SILVER: { yahoo: "SI=F", tv: "COMEX:SI1!" },
      CRUDEOIL: { yahoo: "CL=F", tv: "NYMEX:CL1!" },
      NATGAS: { yahoo: "NG=F", tv: "NYMEX:NG1!" },
    },
  },

  // Default symbol per market
  DEFAULT_BY_MARKET: {
    CRYPTO: "BTCUSDT",
    INDIA: "NIFTY50",
    FOREX: "EURUSD",
    US_STOCKS: "AAPL",
    COMMODITIES: "GOLD",
  },

  // ===============================
  // TIMEFRAMES
  // ===============================
  INTERVALS: ["1m", "5m", "15m", "30m", "1h"],
  DEFAULT_LIMIT: Number(process.env.DEFAULT_LIMIT || 500),

  // ===============================
  // MULTI-SOURCE PRIORITIES
  // ===============================
  SOURCES: {
    CRYPTO: [
      "binance",
      "coinbase",
      "okx",
      "yahoo",
      "tv",         // TradingView
      "cache",
      "synthetic",
    ],

    INDIA: [
      "tv",
      "moneycontrol",
      "yahoo",
      "cache",
      "synthetic",
    ],

    US_STOCKS: [
      "yahoo",
      "fmp",
      "tv",
      "cache",
      "synthetic",
    ],

    FOREX: [
      "yahoo",
      "exchangerate",
      "tv",
      "cache",
      "synthetic",
    ],

    COMMODITIES: [
      "yahoo",
      "tv",
      "cache",
      "synthetic",
    ],
  },

  // ===============================
  // API BASE URLS
  // ===============================
  API: {
    BINANCE: [
      "https://api.binance.com",
      "https://api1.binance.com",
      "https://api2.binance.com",
      "https://data-api.binance.vision",
    ],

    COINBASE: "https://api.exchange.coinbase.com",

    OKX: "https://www.okx.com",

    YAHOO: [
      "https://query1.finance.yahoo.com/v8/finance/chart",
      "https://query2.finance.yahoo.com/v8/finance/chart",
    ],

    TRADINGVIEW_PROXY: [
      "https://tvc4.forexfeed.net",
      "https://tvc5.forexfeed.net",
    ],

    MONEYCONTROL: [
      "https://priceapi.moneycontrol.com/techCharts/indianMarket/stock/history",
    ],

    EXCHANGERATE: "https://api.exchangerate.host",
    FMP: "https://financialmodelingprep.com/api/v3",
  },

  // ===============================
  // FALLBACK CONFIG
  // ===============================
  FALLBACK: {
    MAX_RETRIES: 4,
    RETRY_DELAY_MS: 600,
    ALWAYS_SYNTHETIC_IF_ALL_FAIL: true,
  },

  // ===============================
  // TELEGRAM
  // ===============================
  TELEGRAM: {
    BOT_TOKEN: process.env.BOT_TOKEN || null,
    CHAT_ID: process.env.CHAT_ID || null,
    ENABLED: Boolean(process.env.BOT_TOKEN && process.env.CHAT_ID),
  },

  // ===============================
  // Keep Alive
  // ===============================
  SELF_PING_URL: process.env.SELF_PING_URL || null,

  PATHS: { CACHE_DIR },
};

export default CONFIG;