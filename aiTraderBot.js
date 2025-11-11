// aiTraderBot.js
import CONFIG from "./config.js";
import { calculateRSI, calculateMACD } from "./core_indicators.js";
import { analyzeElliott } from "./elliott_module.js";
import { mergeSignals } from "./merge_signals.js";
import { runMLPrediction } from "./ml_module_v8_6.js";
import { fetchNews } from "./news_social.js";
import { setupTelegramBot } from "./tg_commands.js";
import { keepAlive, nowLocal, fetchMarketData } from "./utils.js";

// ===== INIT =====
console.log("🤖 AI Trader Bot Starting...");
keepAlive(CONFIG.SELF_PING_URL);
setupTelegramBot();

// ===== MAIN LOOP =====
async function runAnalysis() {
  console.log("⏳ Running analysis at:", nowLocal());
  const { data } = await fetchMarketData(CONFIG.SYMBOL, CONFIG.INTERVAL);
  if (!data.length) return console.warn("⚠️ No market data!");

  const rsi = calculateRSI(data);
  const macd = calculateMACD(data);
  const elliott = analyzeElliott(data);
  const ml = runMLPrediction(data);
  const merged = mergeSignals(rsi, macd, elliott, ml);

  const news = await fetchNews();

  console.log(`
  📊 Report:
  RSI: ${rsi.toFixed(2)}
  MACD: ${macd.macd.toFixed(2)}
  Elliott: ${elliott.trend} (${(elliott.confidence * 100).toFixed(1)}%)
  ML: ${ml.prediction} (${(ml.confidence * 100).toFixed(1)}%)
  🧠 Final Decision: ${merged.decision} (${(merged.score * 100).toFixed(1)}%)
  📰 News: ${news.join(", ")}
  `);
}

setInterval(runAnalysis, 1000 * 60 * 15);
runAnalysis();