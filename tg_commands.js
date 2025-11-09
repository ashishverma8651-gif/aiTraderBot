/**
 * tg_commands.js
 * Telegram Command Controller for AI Trader v8.9
 *
 * Usage:
 *  - npm i node-fetch@3 dotenv
 *  - set .env: BOT_TOKEN, CHAT_ID, AI_BASE_URL (e.g. http://localhost:3000)
 *  - node tg_commands.js
 *
 * Commands:
 *  /start, /help, /status, /predict, /news, /reversal, /ping, /mlstats, /chart
 */

import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID; // optional default chat id for admin messages
const AI_BASE = process.env.AI_BASE_URL || "http://localhost:3000"; // main bot server

if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN in .env");
  process.exit(1);
}

const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;
let offset = 0; // update offset for getUpdates polling

// Helper: send to specific chat
async function sendTG(text, chat = CHAT_ID, parse_mode = "HTML") {
  if (!chat) {
    console.warn("No chat id provided to sendTG");
    return;
  }
  try {
    await fetch(`${API_BASE}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text, parse_mode, disable_web_page_preview: true }),
    });
  } catch (e) {
    console.warn("sendTG error:", e.message);
  }
}

// Helper: send photo by URL
async function sendPhoto(url, caption = "", chat = CHAT_ID) {
  if (!chat) return;
  try {
    await fetch(`${API_BASE}/sendPhoto`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, photo: url, caption, parse_mode: "HTML" }),
    });
  } catch (e) {
    console.warn("sendPhoto error:", e.message);
  }
}

// Utility: fetch main bot endpoint (with timeout)
async function fetchAI(path, opts = {}) {
  const url = (AI_BASE + path);
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), 15000);
  try {
    const r = await fetch(url, { signal: controller.signal, ...opts });
    clearTimeout(id);
    return r;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

// Help text
const HELP_TEXT = `
🤖 <b>AI Trader Bot Assistant</b>

Available commands:
/start — Intro
/help — This help
/status — Last AI report summary
/predict — Force new analysis (runs analyzeAndReport on main)
/news — Latest headlines
/reversal — Show last reversal watcher detection
/ping — Bot assistant alive
/mlstats — Show ML model status & accuracy (from main)
/chart [tf] — Get small chart image (tf default 15m). Example: /chart 1h
`;

// GET updates and process commands
async function pollUpdates() {
  try {
    const res = await fetch(`${API_BASE}/getUpdates?offset=${offset + 1}&timeout=20`);
    const j = await res.json().catch(() => ({}));
    if (!j.result || !Array.isArray(j.result)) return;
    for (const upd of j.result) {
      offset = Math.max(offset, upd.update_id);
      if (!upd.message) continue;
      const chatId = upd.message.chat.id;
      const text = (upd.message.text || "").trim();
      if (!text) continue;
      const args = text.split(" ");
      const cmd = args[0].toLowerCase();

      console.log(`[CMD] ${cmd} from ${chatId}`);

      if (cmd === "/start" || cmd === "/help") {
        await sendTG(HELP_TEXT, chatId);
      } else if (cmd === "/status") {
        try {
          const r = await fetchAI("/last-report");
          if (r.ok) {
            const txt = await r.text();
            // if main returns JSON or plain text, send
            await sendTG(`<b>Last report (from AI):</b>\n\n${txt}`, chatId);
          } else {
            await sendTG("⚠️ Unable to get status from main bot.", chatId);
          }
        } catch (e) {
          await sendTG("⚠️ Error contacting AI server: " + e.message, chatId);
        }
      } else if (cmd === "/predict") {
        try {
          await sendTG("🔍 Triggering analysis on AI server...", chatId);
          const r = await fetchAI("/force-run");
          if (r.ok) {
            await sendTG("✅ Analysis triggered. Check channel for report.", chatId);
          } else {
            await sendTG("⚠️ Could not trigger analysis (main returned non-OK).", chatId);
          }
        } catch (e) {
          await sendTG("⚠️ Error contacting AI server: " + e.message, chatId);
        }
      } else if (cmd === "/news") {
        try {
          const r = await fetchAI("/news");
          if (r.ok) {
            const txt = await r.text();
            await sendTG(`<b>News (AI)</b>\n\n${txt}`, chatId);
          } else {
            await sendTG("⚠️ News endpoint failed.", chatId);
          }
        } catch (e) {
          await sendTG("⚠️ Error fetching news: " + e.message, chatId);
        }
      } else if (cmd === "/reversal") {
        try {
          const r = await fetchAI("/reversal-last");
          if (r.ok) {
            const txt = await r.text();
            await sendTG(`<b>Reversal watcher (last):</b>\n\n${txt}`, chatId);
          } else {
            await sendTG("⚠️ Reversal info not available.", chatId);
          }
        } catch (e) {
          await sendTG("⚠️ Error: " + e.message, chatId);
        }
      } else if (cmd === "/ping") {
        await sendTG(`✅ Bot assistant active\nAI base: ${AI_BASE}\nTime: ${new Date().toLocaleString("en-IN")}`, chatId);
      } else if (cmd === "/mlstats") {
        try {
          const r = await fetchAI("/mlstats");
          if (r.ok) {
            const txt = await r.text();
            await sendTG(`<b>ML Stats (AI)</b>\n\n${txt}`, chatId);
          } else {
            await sendTG("⚠️ ML stats endpoint failed.", chatId);
          }
        } catch (e) {
          await sendTG("⚠️ Error contacting AI server: " + e.message, chatId);
        }
      } else if (cmd === "/chart") {
        // optional parameter: timeframe
        const tf = args[1] || "15m";
        try {
          // request main to return an image URL (or PNG). We support two behaviors:
          //  - main returns JSON { url:"..." } or plain URL text -> send as photo
          //  - or main returns binary PNG at /chart.png?tf=...
          const r = await fetchAI(`/chart?tf=${encodeURIComponent(tf)}`);
          if (r.ok) {
            // try json
            const ct = r.headers.get("content-type") || "";
            if (ct.includes("application/json")) {
              const j = await r.json();
              if (j.url) {
                await sendPhoto(j.url, `Chart ${tf}`, chatId);
              } else if (j.data) {
                await sendTG("Chart returned JSON but no URL.", chatId);
              } else {
                await sendTG("Chart endpoint responded with JSON without url.", chatId);
              }
            } else if (ct.startsWith("image/")) {
              // Telegram sendPhoto supports URL; but since we got binary, store temp? easier: ask main for public URL.
              // fallback: ask main for /chart-url
              try {
                const r2 = await fetchAI(`/chart-url?tf=${encodeURIComponent(tf)}`);
                if (r2.ok) {
                  const urlTxt = await r2.text();
                  await sendPhoto(urlTxt.trim(), `Chart ${tf}`, chatId);
                } else {
                  await sendTG("Chart available but no public url. Contact admin.", chatId);
                }
              } catch (e) {
                await sendTG("Chart binary returned; but cannot forward. Ask admin.", chatId);
              }
            } else {
              const txt = await r.text();
              // if plain URL
              if (txt.startsWith("http")) {
                await sendPhoto(txt.trim(), `Chart ${tf}`, chatId);
              } else {
                await sendTG("Chart response:\n" + txt, chatId);
              }
            }
          } else {
            await sendTG("⚠️ Chart endpoint failed on AI server.", chatId);
          }
        } catch (e) {
          await sendTG("⚠️ Chart error: " + e.message, chatId);
        }
      } else {
        // unknown command
        await sendTG("Unknown command. Type /help", chatId);
      }
    }
  } catch (e) {
    console.warn("pollUpdates error:", e.message);
  }
}

console.log("📡 Telegram Command Handler started. Polling...");
setInterval(pollUpdates, 2500);

// also run immediately
pollUpdates().catch(e => console.warn(e));