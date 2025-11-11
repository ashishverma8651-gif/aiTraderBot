// news_social.js
import axios from "axios";

export async function fetchNews(symbol = "BTC") {
  // simple aggregator using CoinGecko trending or dummy array
  try {
    const url = `https://api.coingecko.com/api/v3/search/trending`;
    const r = await axios.get(url, { timeout: 6000 });
    const items = (r.data && r.data.coins) ? r.data.coins.map(c => c.item.name + ": " + (c.item.symbol || "")) : [];
    return { impact: "Low", score: 1, headlines: items.slice(0,6) };
  } catch (e) {
    return { impact: "Low", score: 0, headlines: [] };
  }
}