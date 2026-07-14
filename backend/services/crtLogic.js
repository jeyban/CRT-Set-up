/**
 * crtLogic.js — CRT (Candle Range Theory) Detection Engine
 *
 * CONFIRMED, CLOSED-CANDLE CRT.
 *
 * Single responsibility: given recent candles, decide whether a valid Bullish
 * or Bearish CRT exists between two FULLY CLOSED candles (C1, C2).
 *
 * The engine:
 *   • never reads a live price,
 *   • never anticipates an unfinished candle,
 *   • contains no intrabar reclaim logic.
 *
 * It is intentionally decoupled from the scanners (Gainers & Losers / Market
 * Radar), the Quality Score, the UI, and API response formatting. Future phases
 * layer those concerns on top of this engine's output.
 *
 * ── Candle selection ─────────────────────────────────────────────────────────
 * Market-data feeds append the currently-forming candle as the LAST element of
 * the array. To guarantee we only ever evaluate completed candles, that final
 * candle is treated as in-progress and discarded. The two candles immediately
 * before it form the confirmed pair (see getConfirmedPair):
 *     C1 = earlier closed candle   (candles[len - 3])
 *     C2 = latest closed candle    (candles[len - 2])
 * At least 3 candles are therefore required; otherwise no evaluation is made.
 *
 * ── Validity rules (BODIES ONLY — wicks/total range are ignored) ─────────────
 * C1 Body = abs(C1.close - C1.open)
 * C2 Body = abs(C2.close - C2.open)
 *
 * Bullish CRT — valid only when ALL are true:
 *   • C2.high  > C1.high      (swept C1 high)
 *   • C2.close < C1.high      (closed back below it)
 *   • C1 Body  > C2 Body      (dominant prior body)
 *
 * Bearish CRT — valid only when ALL are true:
 *   • C2.low   < C1.low       (swept C1 low)
 *   • C2.close > C1.low       (closed back above it)
 *   • C1 Body  > C2 Body      (dominant prior body)
 */

/**
 * Select the two confirmed (fully closed) candles from a candle array.
 *
 * The final element is treated as the currently-forming candle and discarded,
 * so at least 3 candles are required. This is the single source of truth for
 * which candles count as C1/C2 — detection and any downstream ranking must use
 * the same pair.
 *
 * @param {Array} candles - ordered oldest -> newest; each { open, high, low, close }.
 * @returns {{C1: Object, C2: Object}|null}
 */
function getConfirmedPair(candles) {
  if (!Array.isArray(candles) || candles.length < 3) return null;

  const C1 = candles[candles.length - 3]; // earlier closed candle
  const C2 = candles[candles.length - 2]; // latest closed candle

  if (!isClosedCandle(C1) || !isClosedCandle(C2)) return null;
  return { C1, C2 };
}

/**
 * Analyze a symbol for a confirmed CRT setup.
 *
 * @param {string} symbol    - e.g. "BTC_USDT"
 * @param {string} timeframe - e.g. "1h"
 * @param {Array}  candles   - ordered oldest -> newest. The last element may be
 *                             the currently-forming candle and is discarded.
 *                             Each candle: { open, high, low, close }.
 * @returns {Object|null}    - Alert object if a confirmed CRT exists, else null.
 */
function detectCRT(symbol, timeframe, candles) {
  const pair = getConfirmedPair(candles);
  if (!pair) return null;
  const { C1, C2 } = pair;

  // Bodies only — wick size and total candle range are never considered.
  const c1Body = Math.abs(C1.close - C1.open);
  const c2Body = Math.abs(C2.close - C2.open);

  // Body dominance is mandatory for BOTH directions.
  if (!(c1Body > c2Body)) return null;

  // ── Bullish CRT ──────────────────────────────────────────────────────────
  if (C2.high > C1.high && C2.close < C1.high) {
    return buildAlert(symbol, timeframe, "BULLISH", C1, C2, C1.high);
  }

  // ── Bearish CRT ──────────────────────────────────────────────────────────
  if (C2.low < C1.low && C2.close > C1.low) {
    return buildAlert(symbol, timeframe, "BEARISH", C1, C2, C1.low);
  }

  return null; // No confirmed CRT.
}

/** True when a candle has finite OHLC values we can evaluate. */
function isClosedCandle(c) {
  return (
    !!c &&
    Number.isFinite(c.open) &&
    Number.isFinite(c.high) &&
    Number.isFinite(c.low) &&
    Number.isFinite(c.close)
  );
}

/**
 * Build the standardized alert object.
 *
 * Field names are kept backward-compatible with the previous engine so the
 * existing response structure (and the current frontend) keeps working without
 * changes:
 *   • `currentPrice` carries C2's CLOSE (the confirmed close price).
 *   • `reclaimPercent` is a CLOSED-candle measure (based on C2.close).
 */
function buildAlert(symbol, timeframe, direction, C1, C2, sweepLevel) {
  return {
    id: `${symbol}-${timeframe}-${direction}-${Date.now()}`,
    symbol,
    timeframe,
    direction, // "BULLISH" | "BEARISH"
    c1High: C1.high,
    c1Low: C1.low,
    c2High: C2.high,
    c2Low: C2.low,
    sweepLevel, // the C1 level that was swept then reclaimed on close
    currentPrice: C2.close, // confirmed close of C2
    reclaimPercent: calcReclaimPercent(direction, C1, C2),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Closed-candle reclaim percentage (display value): how far C2 CLOSED back past
 * the swept level, relative to the sweep depth. Uses only completed-candle data.
 */
function calcReclaimPercent(direction, C1, C2) {
  if (direction === "BULLISH") {
    const sweep = C2.high - C1.high;
    const reclaim = C1.high - C2.close;
    return sweep > 0 ? ((reclaim / sweep) * 100).toFixed(1) : "0.0";
  }
  const sweep = C1.low - C2.low;
  const reclaim = C2.close - C1.low;
  return sweep > 0 ? ((reclaim / sweep) * 100).toFixed(1) : "0.0";
}

module.exports = { detectCRT, getConfirmedPair };
