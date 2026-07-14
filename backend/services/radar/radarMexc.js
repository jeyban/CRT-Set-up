/**
 * radarMexc.js — Universe + market data provider for the Market Radar scanner.
 *
 * This is Market Radar's OWN data provider, fully independent from the
 * Gainers/Losers provider (services/gl/glMexc.js). Generic MEXC plumbing
 * (ticker fetch, kline fetch, symbol filtering) is reused from ../mexcCommon so
 * there is no duplicated API code. This file only owns the Radar-specific
 * policy:
 *   • timeframes: 1d / 1w / 1m
 *   • universe:   Top 300–500 coins (by 24h USDT turnover) EXCLUDING every
 *                symbol currently in the Top 30 Gainers or Top 30 Losers.
 *
 * Rationale for ranking by 24h turnover: MEXC's contract ticker does not expose
 * market cap, so quote-volume (amount24) is the best available proxy for "top
 * cryptocurrencies" / broad-market liquidity.
 */

const {
  isCryptoOrCommodity,
  fetchAllTickers,
  fetchKlines: fetchKlinesRaw,
  fetchPrice,
} = require("../mexcCommon");

/** Supported timeframes for the Market Radar module. */
const INTERVAL_MAP = {
  "1d": "Day1",
  "1w": "Week1",
  "1m": "Month1",
};

const INTERVAL_SECONDS = {
  "1d": 24 * 60 * 60,
  "1w": 7 * 24 * 60 * 60,
  "1m": 30 * 24 * 60 * 60,
};

// Universe policy constants.
const TOP_MAX = 500; // scan the top 500 coins by turnover ...
const MOVERS_EXCLUDE = 30; // ... minus the Top 30 gainers + Top 30 losers.

/** Numeric 24h turnover for ranking (prefer USDT amount, fallback base volume). */
function turnoverOf(t) {
  const amt = Number(t.amount24);
  if (!isNaN(amt) && amt > 0) return amt;
  const vol = Number(t.volume24);
  return !isNaN(vol) ? vol : 0;
}

/**
 * Build the Market Radar scan universe.
 *
 * One single /ticker call feeds BOTH the mover-exclusion set and the ranked
 * universe, so no duplicate API calls are made.
 *
 * @param {Object} [opts]
 * @param {number} [opts.topMax=500]        - max coins (by turnover) to consider
 * @param {number} [opts.moversExclude=30]  - how many gainers/losers to exclude
 * @returns {Promise<{
 *   universe: string[], excluded: string[], gainers: string[], losers: string[],
 *   rates: Object, totalCandidates: number
 * }>}
 */
async function getRadarUniverse(opts = {}) {
  const topMax = opts.topMax || TOP_MAX;
  const moversExclude = opts.moversExclude || MOVERS_EXCLUDE;

  const list = await fetchAllTickers();

  // Valid USDT crypto/commodity perps with a usable change rate.
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
      rate: Number(t.riseFallRate) * 100, // decimal fraction -> percent
      turnover: turnoverOf(t),
    }));

  if (cleaned.length === 0) {
    throw new Error("No valid USDT perpetual tickers after filtering");
  }

  // ── Exclusion set: Top 30 Gainers + Top 30 Losers (by 24h % change) ────────
  const byRate = [...cleaned].sort((a, b) => b.rate - a.rate);
  const gainers = byRate.slice(0, moversExclude).map((x) => x.symbol);
  const losers = byRate.slice(-moversExclude).map((x) => x.symbol);
  const excluded = new Set([...gainers, ...losers]);

  // ── Ranked broad-market universe: top N by turnover, movers removed ─────────
  const universe = [...cleaned]
    .sort((a, b) => b.turnover - a.turnover)
    .slice(0, topMax)
    .filter((x) => !excluded.has(x.symbol))
    .map((x) => x.symbol);

  const rates = {};
  for (const x of cleaned) rates[x.symbol] = x.rate;

  return {
    universe,
    excluded: [...excluded],
    gainers,
    losers,
    rates,
    totalCandidates: cleaned.length,
  };
}

/**
 * Fetch the last `limit` klines for a symbol + Radar timeframe.
 * @param {string} symbol
 * @param {"1d"|"1w"|"1m"} tf
 * @param {number} limit
 * @returns {Promise<Array|null>}
 */
async function fetchKlines(symbol, tf, limit = 3) {
  const interval = INTERVAL_MAP[tf];
  if (!interval) throw new Error(`Unknown timeframe: ${tf}`);
  return fetchKlinesRaw(symbol, interval, INTERVAL_SECONDS[tf], limit);
}

module.exports = {
  getRadarUniverse,
  fetchKlines,
  fetchPrice,
  INTERVAL_MAP,
  INTERVAL_SECONDS,
  TOP_MAX,
  MOVERS_EXCLUDE,
};
