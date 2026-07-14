/**
 * glMexc.js — Universe + market data provider for the Gainers/Losers scanner.
 *
 * This is the Gainers/Losers scanner's OWN data provider (independent from the
 * Market Radar provider). Generic MEXC plumbing (ticker fetch, kline fetch,
 * symbol filtering) is reused from ../mexcCommon so there is no duplicated API
 * code. This file only owns the GL-specific policy:
 *   • timeframes: 1h / 4h / 1d
 *   • universe:   Top 30 Gainers + Top 30 Losers (by 24h riseFallRate)
 */

const {
  isCryptoOrCommodity,
  fetchAllTickers,
  fetchKlines: fetchKlinesRaw,
  fetchPrice,
} = require("../mexcCommon");

/** Supported timeframes for the gainers/losers module. */
const INTERVAL_MAP = {
  "1h": "Min60",
  "4h": "Hour4",
  "1d": "Day1",
};

const INTERVAL_SECONDS = {
  "1h": 60 * 60,
  "4h": 4 * 60 * 60,
  "1d": 24 * 60 * 60,
};

/**
 * Fetch all contract tickers and compute the Top N gainers / losers.
 *
 * @param {number} limit - how many gainers and how many losers (default 30 each).
 * @returns {Promise<{gainers: Array, losers: Array, universe: string[], rates: Object}>}
 */
async function getTopMovers(limit = 30) {
  const list = await fetchAllTickers();

  // Keep only valid USDT crypto/commodity perps with a usable change rate.
  const cleaned = list
    .filter(
      (t) =>
        t &&
        typeof t.symbol === "string" &&
        t.symbol.endsWith("_USDT") &&
        isCryptoOrCommodity(t.symbol) &&
        t.riseFallRate !== undefined &&
        t.riseFallRate !== null &&
        !isNaN(Number(t.riseFallRate))
    )
    .map((t) => ({
      symbol: t.symbol,
      // riseFallRate is a decimal fraction (0.0523 => +5.23%)
      rate: Number(t.riseFallRate) * 100,
      lastPrice: t.lastPrice !== undefined ? Number(t.lastPrice) : null,
    }));

  if (cleaned.length === 0) {
    throw new Error("No valid USDT perpetual tickers after filtering");
  }

  // Sort descending by % change.
  const sorted = [...cleaned].sort((a, b) => b.rate - a.rate);

  const gainers = sorted.slice(0, limit); // highest first
  const losers = sorted.slice(-limit).reverse(); // most negative first

  // De-duplicate into a unique scan universe preserving order.
  const seen = new Set();
  const universe = [];
  for (const item of [...gainers, ...losers]) {
    if (!seen.has(item.symbol)) {
      seen.add(item.symbol);
      universe.push(item.symbol);
    }
  }

  const rates = {};
  for (const item of cleaned) rates[item.symbol] = item.rate;

  return { gainers, losers, universe, rates };
}

/**
 * Fetch the last `limit` klines for a symbol + GL timeframe.
 * @param {string} symbol - e.g. "BTC_USDT"
 * @param {"1h"|"4h"|"1d"} tf
 * @param {number} limit  - number of candles (default 3)
 * @returns {Promise<Array|null>}
 */
async function fetchKlines(symbol, tf, limit = 3) {
  const interval = INTERVAL_MAP[tf];
  if (!interval) throw new Error(`Unknown timeframe: ${tf}`);
  return fetchKlinesRaw(symbol, interval, INTERVAL_SECONDS[tf], limit);
}

module.exports = {
  getTopMovers,
  fetchKlines,
  fetchPrice,
  isCryptoOrCommodity,
  INTERVAL_MAP,
  INTERVAL_SECONDS,
};
