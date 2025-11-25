// config.js — Heavy config (single source of truth)
import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const CACHE_DIR = path.join(ROOT, "cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

export const CONFIG = {
  MODE: process.env.NODE_ENV || "production",

  // runtime overrideable
  ACTIVE_MARKET: (process.env.ACTIVE_MARKET || "CRYPTO").toUpperCase(),
  ACTIVE_SYMBOL: process.env.ACTIVE_SYMBOL || "BTCUSDT",

  // --------------------------
  // SYMBOL MAPPINGS (4 each market)
  // --------------------------
  SYMBOLS: {
    CRYPTO: {
      BTCUSDT: { binance: "BTCUSDT", yahoo: "BTC-USD" },
      ETHUSDT: { binance: "ETHUSDT", yahoo: "ETH-USD" },
      BNBUSDT: { binance: "BNBUSDT", yahoo: "BNB-USD" },
      SOLUSDT: { binance: "SOLUSDT", yahoo: "SOL-USD" }
    },

    INDIA: {
      NIFTY50: { yahoo: "^NSEI", tv: "NSE:NIFTY" },
      BANKNIFTY: { yahoo: "^NSEBANK", tv: "NSE:BANKNIFTY" },
      RELIANCE: { yahoo: "RELI.NS", tv: "NSE:RELIANCE" },
      TCS: { yahoo: "TCS.NS", tv: "NSE:TCS" }
    },

    FOREX: {
      EURUSD: { yahoo: "EURUSD=X" },
      GBPUSD: { yahoo: "GBPUSD=X" },
      USDJPY: { yahoo: "JPY=X" },
      AUDUSD: { yahoo: "AUDUSD=X" }
    },

    COMMODITIES: {
      GOLD: { yahoo: "GC=F" },
      SILVER: { yahoo: "SI=F" },
      CRUDEOIL: { yahoo: "CL=F" },
      NATGAS: { yahoo: "NG=F" }
    }
  },

  DEFAULT_BY_MARKET: {
    CRYPTO: "BTCUSDT",
    INDIA: "NIFTY50",
    FOREX: "EURUSD",
    COMMODITIES: "GOLD"
  },

  INTERVALS: ["1m", "5m", "15m", "30m", "1h"],
  DEFAULT_LIMIT: Number(process.env.DEFAULT_LIMIT || 500),

  // multi-source endpoints (primary + mirrors)
  API: {
    BINANCE: [
      "https://api.binance.com",
      "https://api1.binance.com",
      "https://data-api.binance.vision"
    ],
    COINBASE: "https://api.exchange.coinbase.com",
    OKX: "https://www.okx.com",
    YAHOO: [
      "https://query1.finance.yahoo.com/v8/finance/chart",
      "https://query2.finance.yahoo.com/v8/finance/chart"
    ],
    EXCHANGERATE: "https://api.exchangerate.host",
    FMP: "https://financialmodelingprep.com/api/v3",
    TRADINGVIEW_PROXY: [
      "https://tvc4.forexfeed.net",
      "https://tvc5.forexfeed.net"
    ]
  },

  PATHS: { CACHE_DIR },

  PROXY: process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.PROXY || null,

  FALLBACK: {
    MAX_RETRIES: Number(process.env.MAX_RETRIES || 4),
    RETRY_DELAY_MS: Number(process.env.RETRY_DELAY_MS || 600),
    ALWAYS_SYNTHETIC_IF_ALL_FAIL: true
  },

  TELEGRAM: {
    BOT_TOKEN: process.env.BOT_TOKEN || null,
    CHAT_ID: process.env.CHAT_ID || null,
    ENABLED: Boolean(process.env.BOT_TOKEN && process.env.CHAT_ID)
  },

  REPORT_INTERVAL_MS: Number(process.env.REPORT_INTERVAL_MS || 15 * 60 * 1000)
};

export default CONFIG;