// aiTraderBot.js — FINAL WITH FULL INDICATORS

import { fetchPrice, fetchMultiTF } from "./utils.js";
import CONFIG from "./config.js";

import {
  computeMultiTF,
  deriveSignal
} from "./core_indicators.js";

export async function generateSignal(symbol, market) {
  const price = await fetchPrice(symbol, market);
  const tfCandles = await fetchMultiTF(symbol, market);

  const ind = computeMultiTF(tfCandles);

  let msg = `🔥 *${symbol} — AI Market Intelligence*\n`;
  msg += `Time: ${new Date().toLocaleString()}\n`;
  msg += `Price: ${price}\n`;
  msg += `------------------------------------\n`;

  for (const tf in ind) {
    const d = ind[tf];

    const signal = deriveSignal(d);

    msg += `🕒 *${tf}* — ${signal}\n`;
    msg += `• RSI: ${d.RSI}\n`;
    msg += `• ATR: ${d.ATR}\n`;
    msg += `• Trend: ${d.priceTrend}\n`;
    msg += `• Vol: ${d.volumeTrend}\n`;
    msg += `• MACD: ${d.MACD.hist}\n`;
    msg += `------------------------------------\n`;
  }

  return msg;
}