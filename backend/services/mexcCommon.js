/**
 * mexcCommon.js — SHARED MEXC Futures data helpers.
 *
 * Generic, scanner-agnostic infrastructure reused by BOTH data providers
 * (services/gl/glMexc.js and services/radar/radarMexc.js) so there is no
 * duplicated MEXC plumbing. This module intentionally contains NO business
 * logic (no CRT rules, no scoring, no universe policy) — only raw data access
 * and generic symbol filtering.
 *
 * MEXC contract v1 endpoints (https://contract.mexc.com/api/v1/contract):
 *   All tickers : GET /ticker             -> data[]  { symbol, lastPrice, riseFallRate, volume24, amount24, ... }
 *   Single tick : GET /ticker?symbol=...  -> data    { lastPrice, ... }
 *   Kline       : GET /kline/{symbol}?interval=Min60|Hour4|Day1|Week1|Month1&start=<sec>&end=<sec>
 *
 * Interval strings: Min1 Min5 Min15 Min30 Min60 Hour4 Hour8 Day1 Week1 Month1
 */

const axios = require("axios");

const BASE = "https://contract.mexc.com/api/v1/contract";

// ── Symbol universe filtering (crypto + gold/silver/oil, reject stock perps) ──
const COMMODITY_SYMBOLS = new Set(["XAU_USDT", "XAG_USDT", "OIL_USDT"]);

const STOCK_SYMBOLS = new Set([
  "AAPL_USDT","AMZN_USDT","TSLA_USDT","GOOGL_USDT","MSFT_USDT","META_USDT",
  "NVDA_USDT","NFLX_USDT","AMD_USDT","INTC_USDT","BABA_USDT","UBER_USDT",
  "COIN_USDT","MSTR_USDT","PLTR_USDT","SHOP_USDT","SQ_USDT","PYPL_USDT",
  "SNAP_USDT","TWTR_USDT","SPOT_USDT","ABNB_USDT","RBLX_USDT","HOOD_USDT",
  "GME_USDT","AMC_USDT","BBY_USDT","F_USDT","GM_USDT","BA_USDT",
  "DIS_USDT","V_USDT","MA_USDT","JPM_USDT","GS_USDT","BAC_USDT",
  "WMT_USDT","PFE_USDT","JNJ_USDT","XOM_USDT","CVX_USDT",
  "700_USDT","9988_USDT","1810_USDT","3690_USDT","9618_USDT","2318_USDT",
  "941_USDT","388_USDT","1299_USDT","2628_USDT","3988_USDT","1398_USDT",
  "XAUUSD_USDT",
]);

/**
 * @param {string} symbol
 * @returns {boolean} true if the symbol is a crypto perpetual (or allowed commodity).
 */
function isCryptoOrCommodity(symbol) {
  if (typeof symbol !== "string") return false;
  if (COMMODITY_SYMBOLS.has(symbol)) return true;
  if (STOCK_SYMBOLS.has(symbol)) return false;

  const base = symbol.replace(/_USDT$/, "");
  if (/^\d+$/.test(base)) return false;       // HK numeric tickers
  if (base.endsWith("STOCK")) return false;   // MEXC stock perps
  if (base.endsWith("ETF")) return false;
  if (base.endsWith("INDEX")) return false;
  return true;
}

/**
 * Fetch ALL contract tickers in a single request. Both scanners derive their
 * universes from this one payload, so callers can avoid duplicate API calls.
 *
 * @returns {Promise<Array>} raw ticker objects
 */
async function fetchAllTickers() {
  const res = await axios.get(`${BASE}/ticker`, { timeout: 12000 });
  const list = (res.data && res.data.data) || [];
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error("MEXC ticker response empty or malformed");
  }
  return list;
}

/**
 * Fetch the last `limit` klines for a symbol at a raw MEXC interval.
 *
 * @param {string} symbol          - e.g. "BTC_USDT"
 * @param {string} interval        - MEXC interval string (e.g. "Day1", "Week1")
 * @param {number} intervalSeconds - seconds per candle (for the start-time window)
 * @param {number} limit           - number of candles to return (default 3)
 * @returns {Promise<Array|null>} array of { openTime, open, high, low, close } or null
 */
async function fetchKlines(symbol, interval, intervalSeconds, limit = 3) {
  if (!interval) throw new Error("Missing MEXC interval");

  const end = Math.floor(Date.now() / 1000);
  const start = end - (limit + 2) * intervalSeconds; // +2 buffer

  try {
    const res = await axios.get(`${BASE}/kline/${symbol}`, {
      params: { interval, start, end },
      timeout: 8000,
    });

    const d = res.data && res.data.data;
    if (!d || !d.time || !Array.isArray(d.time) || d.time.length === 0) {
      return null;
    }

    const len = d.time.length;
    const from = Math.max(0, len - limit);
    const candles = [];
    for (let i = from; i < len; i++) {
      candles.push({
        openTime: d.time[i],
        open: parseFloat(d.open[i]),
        high: parseFloat(d.high[i]),
        low: parseFloat(d.low[i]),
        close: parseFloat(d.close[i]),
      });
    }
    return candles.length >= 2 ? candles : null;
  } catch (err) {
    if (!err.response || err.response.status !== 404) {
      console.error(`  [MEXC] kline ${symbol} ${interval}: ${err.message}`);
    }
    return null;
  }
}

/**
 * Fetch the live price for a perpetual symbol.
 * @param {string} symbol
 * @returns {Promise<number|null>}
 */
async function fetchPrice(symbol) {
  try {
    const res = await axios.get(`${BASE}/ticker`, {
      params: { symbol },
      timeout: 5000,
    });
    const d = res.data && res.data.data;
    if (!d) return null;
    const price = parseFloat(d.lastPrice);
    return isNaN(price) ? null : price;
  } catch (err) {
    return null;
  }
}

module.exports = {
  BASE,
  COMMODITY_SYMBOLS,
  STOCK_SYMBOLS,
  isCryptoOrCommodity,
  fetchAllTickers,
  fetchKlines,
  fetchPrice,
};
