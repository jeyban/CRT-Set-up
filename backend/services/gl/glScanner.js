/**
 * glScanner.js — Scan engine for the Gainers/Losers CRT module.
 *
 * Detection uses the SHARED confirmed closed-candle CRT engine (../crtLogic)
 * and the SHARED Quality Score engine (../crtQuality). The engine decides
 * validity; this module never weakens or overrides a CRT rule. It only layers
 * PRESENTATION metadata on top of a valid setup:
 *   • signal label (LONG/SHORT)
 *   • quality score (ranking only — shared crtQuality)
 *   • mover type (gainer/loser)
 *
 * Per-scan workflow (universe rules per spec):
 *   1. Fetch Top 30 Gainers + Top 30 Losers from MEXC futures.
 *   2. De-duplicate into a single scan universe.
 *   3. Scan that universe with detectCRT() — closed candles only.
 *   4. Score + sort valid setups (highest quality first), then persist.
 *
 * Each timeframe runs through its own call; a per-tf `running` guard ensures one
 * scanner can never disturb another.
 */

const { getTopMovers, fetchKlines } = require("./glMexc");
const { detectCRT, getConfirmedPair } = require("../crtLogic");
const { computeQuality } = require("../crtQuality");
const store = require("./glStore");

const DELAY_MS = 150;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Per-timeframe running guard — independent locks.
const running = { "1h": false, "4h": false, "1d": false };

/** Map the engine's direction to a trading signal label. */
function toSignal(direction) {
  return direction === "BULLISH" ? "LONG" : "SHORT";
}

/** MEXC futures quick chart link. */
function chartLink(symbol) {
  return "https://futures.mexc.com/exchange/" + symbol;
}

/**
 * Run a single scan for one timeframe.
 *
 * @param {"1h"|"4h"|"1d"} tf
 * @param {"auto"|"manual"} type
 * @returns {Promise<{results: Array, summary: Object}>}
 */
async function runScan(tf, type = "manual") {
  if (!store.isValidTf(tf)) throw new Error(`Invalid timeframe: ${tf}`);

  if (running[tf]) {
    store.appendLog(tf, "warn", `Scan already running for ${tf} — ignored duplicate trigger`);
    return { results: store.getResults(tf), summary: store.getState(tf), alreadyRunning: true };
  }
  running[tf] = true;

  const label = tf.toUpperCase();
  store.appendLog(tf, "info", `▶ ${type.toUpperCase()} scan started for ${label}`);

  let movers;
  try {
    movers = await getTopMovers(30);
  } catch (err) {
    store.appendLog(tf, "error", `Failed to fetch Top 30 gainers/losers: ${err.message}`);
    store.finishScan(tf, { error: err.message });
    running[tf] = false;
    return { results: store.getResults(tf), summary: store.getState(tf), error: err.message };
  }

  const universe = movers.universe;
  store.beginScan(tf, type, universe.length);
  store.appendLog(
    tf,
    "info",
    `Universe ready — ${movers.gainers.length} gainers + ${movers.losers.length} losers → ${universe.length} unique symbols`
  );

  // Lookup helpers for enrichment
  const gainerSet = new Set(movers.gainers.map((g) => g.symbol));
  const loserSet = new Set(movers.losers.map((l) => l.symbol));

  const results = [];
  let scanned = 0;
  let errors = 0;

  for (const symbol of universe) {
    try {
      const candles = await fetchKlines(symbol, tf, 3);
      if (!candles || candles.length < 2) {
        errors++;
        store.updateProgress(tf, { errors: 1 });
        await sleep(DELAY_MS);
        continue;
      }

      // Confirmed closed-candle CRT engine — detection only, no live price.
      const alert = detectCRT(symbol, tf, candles);

      scanned++;

      if (alert) {
        // Score ONLY setups that already passed detection (never rejected ones).
        // Reuse the engine's own confirmed pair so ranking and detection agree.
        const { C1, C2 } = getConfirmedPair(candles);
        const qualityScore = computeQuality(alert.direction, C1, C2);

        const moverType = gainerSet.has(symbol)
          ? "gainer"
          : loserSet.has(symbol)
          ? "loser"
          : "both";

        const enriched = {
          ...alert,                       // verbatim engine output (CRT details)
          signal: toSignal(alert.direction),
          qualityScore,
          moverType,
          changeRate: movers.rates[symbol] != null ? movers.rates[symbol] : null,
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
          `✅ CRT FOUND — ${symbol} ${enriched.signal} (${alert.direction}) • Q${qualityScore}`
        );
      } else {
        store.updateProgress(tf, { scanned: 1 });
      }
    } catch (err) {
      errors++;
      store.updateProgress(tf, { errors: 1 });
      store.appendLog(tf, "error", `${symbol} — ${err.message}`);
    }
    await sleep(DELAY_MS);
  }

  // Quality over quantity: results are exactly the valid CRTs, strongest first.
  results.sort((a, b) => b.qualityScore - a.qualityScore);

  // Persist: results stay visible until the next scan; history is appended.
  store.setResults(tf, results);
  store.appendHistory(tf, results);

  const summary = {
    symbolsScanned: scanned,
    gainersCount: movers.gainers.length,
    losersCount: movers.losers.length,
    universeSize: universe.length,
    crtFound: results.length,
    errors,
  };
  store.finishScan(tf, summary);

  store.appendLog(
    tf,
    "info",
    `■ Scan complete — ${scanned}/${universe.length} scanned, ${results.length} CRT found, ${errors} errors`
  );

  running[tf] = false;
  return { results, summary };
}

function isRunning(tf) {
  return !!running[tf];
}

module.exports = { runScan, isRunning, toSignal, chartLink };
