// ===============================
// tg_commands.js — FINAL WITH KEYBOARD
// ===============================

import { generateMergeSignal } from "./merge_signals.js";
import CONFIG from "./config.js";

// ------------------------
// MAIN HOME KEYBOARD
// ------------------------
export const kbHome = {
  reply_markup: {
    inline_keyboard: [
      [
        { text: "⚡ Generate Signal", callback_data: "gen_default" }
      ],
      [
        { text: "📈 Select Market", callback_data: "sel_market" }
      ],
      [
        { text: "🕒 Select Timeframe", callback_data: "sel_tf" }
      ]
    ]
  },
  parse_mode: "HTML"
};

// PREDEFINED MARKETS
const MARKETS = ["NIFTY", "BANKNIFTY", "FINNIFTY", "BTCUSDT", "ETHUSDT"];
const TIMEFRAMES = ["1m", "5m", "15m", "30m", "1h"];

// store user selections
const session = {}; // { chatId: { symbol, tf } }

function getSession(ctx) {
  if (!session[ctx.chat.id]) {
    session[ctx.chat.id] = {
      symbol: CONFIG.SYMBOL,
      tf: "15m"
    };
  }
  return session[ctx.chat.id];
}

// ------------------------
// BUILD REPORT
// ------------------------
export async function buildAIReport(symbol, tf = "15m") {
  try {
    const raw = await generateMergeSignal(symbol, { mainTF: tf });
    return raw;
  } catch (e) {
    console.log("buildAIReport error:", e.message);
    return null;
  }
}

// ------------------------
// FORMAT + SPLIT for Telegram
// ------------------------
export async function formatAIReport(reportObj) {
  if (!reportObj || !reportObj.uiText) return [];
  const txt = reportObj.uiText.trim();

  const LIMIT = 3800;

  if (txt.length <= LIMIT) return [txt];

  const parts = [];
  let buf = "";
  for (const line of txt.split("\n")) {
    if ((buf + "\n" + line).length > LIMIT) {
      parts.push(buf);
      buf = line;
    } else {
      buf += (buf ? "\n" : "") + line;
    }
  }
  if (buf.trim().length) parts.push(buf);

  return parts;
}

// -----------------------
// CALLBACK HANDLER
// -----------------------
export async function handleTGCallback(ctx, cb) {
  const chatId = ctx.chat.id;
  const state = getSession(ctx);

  // -------- Generate default --------
  if (cb === "gen_default") {
    const raw = await buildAIReport(state.symbol, state.tf);
    const parts = await formatAIReport(raw);

    for (const msg of parts) {
      await ctx.reply(msg, { parse_mode: "HTML" });
    }
    return;
  }

  // -------- Select market menu --------
  if (cb === "sel_market") {
    const rows = MARKETS.map(m => [{ text: m, callback_data: "m_" + m }]);
    await ctx.editMessageText("📈 Select Market", {
      reply_markup: { inline_keyboard: rows },
      parse_mode: "HTML"
    });
    return;
  }

  // set selected market
  if (cb.startsWith("m_")) {
    const sym = cb.replace("m_", "");
    state.symbol = sym;
    await ctx.editMessageText(
      `✔ Market Selected: <b>${sym}</b>\n\nNow choose timeframe`,
      {
        reply_markup: {
          inline_keyboard: TIMEFRAMES.map(tf => [
            { text: tf, callback_data: "t_" + tf }
          ])
        },
        parse_mode: "HTML"
      }
    );
    return;
  }

  // -------- Select TF menu --------
  if (cb === "sel_tf") {
    await ctx.editMessageText("🕒 Select Timeframe", {
      reply_markup: {
        inline_keyboard: TIMEFRAMES.map(tf => [
          { text: tf, callback_data: "t_" + tf }
        ])
      },
      parse_mode: "HTML"
    });
    return;
  }

  // set selected TF
  if (cb.startsWith("t_")) {
    const tf = cb.replace("t_", "");
    state.tf = tf;

    await ctx.editMessageText(
      `✔ Timeframe Selected: <b>${tf}</b>\n\nPress Generate Signal`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "⚡ Generate Signal", callback_data: "gen_default" }],
            [{ text: "🏠 Home", callback_data: "go_home" }]
          ]
        },
        parse_mode: "HTML"
      }
    );
    return;
  }

  // -------- HOME --------
  if (cb === "go_home") {
    await ctx.editMessageText("🏠 HOME PANEL", kbHome);
    return;
  }
}

// Default export
export default {
  kbHome,
  buildAIReport,
  formatAIReport,
  handleTGCallback
};