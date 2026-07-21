/**
 * radarScanner.js - Scan engine for the Market Radar CRT module.
 *
 * Logically INDEPENDENT from the Gainers/Losers scanner (its own universe
 * provider, timeframe config, store and running guard), but it shares the exact
 * same BUSINESS LOGIC:
 *   • CRT detection  -> ../crtLogic   (detectCRT / getConfirmedPair)
 *   • Quality Score  -> ../crtQuality (computeQuality)
 * These are the identical modules the GL scanner imports - never duplicated.
 *
 * Per-scan workflow:
 *   1. Build the broad-market universe (Top 300-500 by turnover) EXCLUDING the
 *      current Top 30 Gainers + Top 30 Losers.
 *   2. Scan that universe with detectCRT() - closed candles only.
 *   3. Score + sort valid setups (highest quality first), then persist.
 *
 * The enriched result shape is IDENTICAL to the GL scanner's, so both scanners
 * render through the same frontend card with the same response format.
 */
​
const { getRadarUniverse, fetchKlines } = require("./radarMexc");
// The shared engine now returns the full quality metrics + Quality Score on
// the alert object itself, so the scanner never re-computes them (no duplicate
// calculation). We only need the detector here.
const { detectCRT } = require("../crtLogic");
​
// Fetch enough candles for the engine's C1/C2/C3 plus the recent baseline used
// for Average Body / Impulse Strength (RECENT_LOOKBACK = 10 -> 13 minimum).
const CANDLE_LIMIT = 15;
const store = require("./radarStore");
​
const DELAY_MS = 150;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
​
// Per-timeframe running guard - independent locks (1d / 1w / 1m).
const running = { "1d": false, "1w": false, "1m": false };
​
/** Map the engine's direction to a trading signal label. */
function toSignal(direction) {
  return direction === "BULLISH" ? "LONG" : "SHORT";
}
​
/** MEXC futures quick chart link. */
function chartLink(symbol) {
  return "https://futures.mexc.com/exchange/" + symbol;
}
​
/**
 * Run a single Market Radar scan for one timeframe.
 *
 * @param {"1d"|"1w"|"1m"} tf
 * @param {"auto"|"manual"} type
 * @returns {Promise<{results: Array, summary: Object}>}
 */
async function runScan(tf, type = "manual") {
  if (!store.isValidTf(tf)) throw new Error(`Invalid timeframe: ${tf}`);
​
  if (running[tf]) {
    store.appendLog(tf, "warn", `Scan already running for ${tf} - ignored duplicate trigger`);
    return { results: store.getResults(tf), summary: store.getState(tf), alreadyRunning: true };
  }
  running[tf] = true;
​
  const label = tf.toUpperCase();
  store.appendLog(tf, "info", `▶ ${type.toUpperCase()} Market Radar scan started for ${label}`);
​
  let uni;
  try {
    uni = await getRadarUniverse();
  } catch (err) {
    store.appendLog(tf, "error", `Failed to build radar universe: ${err.message}`);
    store.finishScan(tf, { error: err.message });
    running[tf] = false;
    return { results: store.getResults(tf), summary: store.getState(tf), error: err.message };
  }
​
  const universe = uni.universe;
  store.beginScan(tf, type, universe.length);
  store.appendLog(
    tf,
    "info",
    `Universe ready - ${universe.length} coins (top ${universe.length} by turnover, excl. ${uni.excluded.length} top movers)`
  );
​
  const results = [];
  let scanned = 0;
  let errors = 0;
​
  for (const symbol of universe) {
    try {
      const candles = await fetchKlines(symbol, tf, CANDLE_LIMIT);
      if (!candles || candles.length < 2) {
        errors++;
        store.updateProgress(tf, { errors: 1 });
        await sleep(DELAY_MS);
        continue;
      }
​
      // Shared confirmed closed-candle CRT engine - detection only.
      const alert = detectCRT(symbol, tf, candles);
​
      scanned++;
​
      if (alert) {
        // Score ONLY setups that passed detection (never rejected ones), using
        // the engine's own confirmed pair so ranking and detection agree.
        const enriched = {
          ...alert,                       // verbatim engine output (CRT details + metrics + score)
          signal: toSignal(alert.direction),
          qualityScore: alert.qualityScore,
          moverType: null,                // Radar universe excludes top movers
          changeRate: uni.rates[symbol] != null ? uni.rates[symbol] : null,
          chartUrl: chartLink(symbol),
          detectionTime: alert.timestamp,
          scanDate: new Date(alert.timestamp).toISOString().slice(0, 10),
          details: {
            c1High: alert.c1High,
            c1Low: alert.c1Low,
            c2High: alert.c2High,
            c2Low: alert.c2Low,
            sweepLevel: alert.sweepLevel,
            currentPrice: alert.currentPrice,
            reclaimPercent: alert.reclaimPercent,
          },
        };
        results.push(enriched);
        store.updateProgress(tf, { scanned: 1, found: 1 });
        store.appendLog(
          tf,
          "found",
          `✅ ${symbol} ${alert.direction === "BULLISH" ? "Bullish" : "Bearish"} CRT · ` +
            `Body ${alert.bodyRatio}x · Wick ${alert.wickRatio} · Sweep ${alert.sweepPercent}% · ` +
            `Reclaim ${alert.reclaimDepth}% · Impulse ${alert.impulsePercent != null ? alert.impulsePercent + "%" : "n/a"} · ` +
            `Quality ${alert.qualityScore}/100 · Current Candle: C3 LIVE`
        );
      } else {
        store.updateProgress(tf, { scanned: 1 });
      }
    } catch (err) {
      errors++;
      store.updateProgress(tf, { errors: 1 });
      store.appendLog(tf, "error", `${symbol} - ${err.message}`);
    }
    await sleep(DELAY_MS);
  }
​
  // Quality over quantity: results are exactly the valid CRTs, strongest first.
  results.sort((a, b) => b.qualityScore - a.qualityScore);
​
  store.setResults(tf, results);
  store.appendHistory(tf, results);
​
  const summary = {
    symbolsScanned: scanned,
    universeSize: universe.length,
    excludedMovers: uni.excluded.length,
    crtFound: results.length,
    errors,
  };
  store.finishScan(tf, summary);
​
  store.appendLog(
    tf,
    "info",
    `■ Scan complete - ${scanned}/${universe.length} scanned, ${results.length} CRT found, ${errors} errors`
  );
​
  running[tf] = false;
  return { results, summary };
}
​
function isRunning(tf) {
  return !!running[tf];
}
​
module.exports = { runScan, isRunning, toSignal, chartLink };
