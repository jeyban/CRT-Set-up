/**
 * crtLogic.js - SHARED Higher-Timeframe CRT detection engine.
 *
 * SINGLE SOURCE OF TRUTH. Both HTF scanners (Gainers & Losers and Market Radar)
 * and the legacy /api scanner import this exact module. It ONLY identifies
 * Higher-Timeframe opportunities - it contains NO Lower-Timeframe execution
 * logic (BOS / CHoCH / IFVG / Entry / SL / TP / RR). Those live in future,
 * separate modules that will CONSUME the rich CRT signals produced here.
 *
 * -- CRT structure (3 candles, closed-candle detection) ----------------------
 *   C1 = candles[len - 3]  Base / Displacement candle (closed)
 *   C2 = candles[len - 2]  Manipulation candle        (closed)
 *   C3 = candles[len - 1]  Current LIVE candle         (already forming)
 *
 * Validity is decided from the two CLOSED candles C1 + C2 only. C3 is already
 * live when the scan runs, so a confirmed C1+C2 CRT is returned IMMEDIATELY -
 * we never wait for C3 and never store "pending" CRTs awaiting activation.
 * C3 is reported (c3Time) purely as context for the consuming LTF modules.
 *
 * -- Validity rules ---------------------------------------------------
 *   Bullish CRT (ALL required):
 *     1. C2.high  > C1.high          (liquidity sweep above)
 *     2. C2.close < C1.high          (reclaim back inside C1)
 *     3. UpperWick(C2) > Body(C2)    (wick manipulation, not a body breakout)
 *     4. Body(C1) >= Body(C2) * 2    (strong displacement base candle)
 *   Bearish CRT mirrors it (sweep below C1.low, reclaim above C1.low, lower
 *   wick dominant, same body-dominance rule).
 *   Additionally, C1 must not be a weak displacement vs recent market
 *   conditions: Body(C1) >= Average Body(previous candles).
 *
 * For every valid CRT the engine computes ALL raw quality metrics ONCE and
 * asks crtQuality.js to rank them - there is no duplicate calculation anywhere
 * downstream. The returned object carries BOTH the final score AND every raw
 * metric (we never store only the score).
 */

const { computeQuality, clamp } = require("./crtQuality");

// -- Detection tuning (documented, tunable) -------------------------------
const RECENT_LOOKBACK = 10; // # candles before C1 used for Average Body / Impulse
const MIN_BODY_RATIO = 2; // Body(C1) >= Body(C2) * 2  (strong displacement)
const MIN_IMPULSE = 1.0; // reject weak displacement: Body(C1) >= Average Body
// Keep stored ratios finite even when Body(C2) ~ 0 (doji manipulation candle):
const BODY_RATIO_CAP = 50;
const WICK_RATIO_CAP = 50;

// -- Candle helpers (pure, reusable) -----------------------------------

/** Absolute body size of a candle: |close - open|. */
function body(c) {
  return Math.abs(c.close - c.open);
}

/** Upper wick length: distance from the body top to the high. */
function upperWick(c) {
  return c.high - Math.max(c.open, c.close);
}

/** Lower wick length: distance from the body bottom to the low. */
function lowerWick(c) {
  return Math.min(c.open, c.close) - c.low;
}

/** A usable closed candle has finite OHLC values. */
function isClosedCandle(c) {
  return (
    !!c &&
    Number.isFinite(c.open) &&
    Number.isFinite(c.high) &&
    Number.isFinite(c.low) &&
    Number.isFinite(c.close)
  );
}

/** Average body size across a set of candles (null when none are usable). */
function averageBody(candles) {
  const valid = (candles || []).filter(isClosedCandle);
  if (valid.length === 0) return null;
  return valid.reduce((sum, c) => sum + body(c), 0) / valid.length;
}

/** Round to `d` decimals; returns null for non-finite input (JSON-safe). */
function round(n, d = 2) {
  if (n == null || !Number.isFinite(n)) return null;
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}

/** Convert a MEXC contract openTime (SECONDS) to an ISO string, or null. */
function toIso(sec) {
  return Number.isFinite(sec) ? new Date(sec * 1000).toISOString() : null;
}

/** Ratio a/b, capped so a ~0 denominator can't produce Infinity/NaN. */
function safeRatio(a, b, cap) {
  if (!(b > 0)) return cap; // doji manipulation body -> treat as maximal dominance
  return Math.min(a / b, cap);
}

/**
 * Backward-compatible confirmed-pair accessor.
 * Returns the two CLOSED candles used for detection: { C1, C2 }.
 * (C3 = candles[len-1] is the live candle and is intentionally excluded.)
 */
function getConfirmedPair(candles) {
  if (!Array.isArray(candles) || candles.length < 3) return null;
  const n = candles.length;
  const C1 = candles[n - 3];
  const C2 = candles[n - 2];
  if (!isClosedCandle(C1) || !isClosedCandle(C2)) return null;
  return { C1, C2 };
}

/**
 * Legacy reclaim measure (kept for API/UI backward compatibility): how far C2
 * reclaimed back past the swept level, as a percentage of the sweep size.
 * Distinct from the new `reclaimDepth` (measured against C1's full range).
 */
function legacyReclaimPercent(direction, C1, C2) {
  if (direction === "BULLISH") {
    const sweep = C2.high - C1.high;
    const reclaim = C1.high - C2.close;
    return sweep > 0 ? ((reclaim / sweep) * 100).toFixed(1) : "0.0";
  }
  const sweep = C1.low - C2.low;
  const reclaim = C2.close - C1.low;
  return sweep > 0 ? ((reclaim / sweep) * 100).toFixed(1) : "0.0";
}

/**
 * Detect a CRT on the given candles.
 *
 * @param {string} symbol
 * @param {string} timeframe
 * @param {Array<{openTime?:number,open:number,high:number,low:number,close:number}>} candles
 *        Chronological; last element is the current LIVE candle (C3).
 * @returns {Object|null} A rich CRT alert (see buildAlert), or null if no valid
 *          CRT is present on C1+C2.
 */
function detectCRT(symbol, timeframe, candles) {
  if (!Array.isArray(candles) || candles.length < 3) return null;

  const n = candles.length;
  const C1 = candles[n - 3]; // Base / Displacement (closed)
  const C2 = candles[n - 2]; // Manipulation        (closed)
  const C3 = candles[n - 1]; // Current LIVE candle
  if (!isClosedCandle(C1) || !isClosedCandle(C2)) return null;

  const bodyC1 = body(C1);
  const bodyC2 = body(C2);

  // Rule 4 (both directions): displacement candle must be at least 2x the
  // manipulation candle's body. (A doji C2 with bodyC2 == 0 trivially passes.)
  if (!(bodyC1 >= bodyC2 * MIN_BODY_RATIO)) return null;

  // Recent baseline = the RECENT_LOOKBACK closed candles immediately before C1.
  const recent = candles.slice(Math.max(0, n - 3 - RECENT_LOOKBACK), n - 3);
  const avgBody = averageBody(recent);
  const impulseStrength = avgBody && avgBody > 0 ? bodyC1 / avgBody : null;

  // Reject weak displacement vs recent market conditions (only when we actually
  // have a baseline to compare against - keeps short-history callers working).
  if (impulseStrength != null && impulseStrength < MIN_IMPULSE) return null;

  const upWick = upperWick(C2);
  const loWick = lowerWick(C2);

  let direction;
  let sweepLevel;
  let manipulationWick;

  if (C2.high > C1.high && C2.close < C1.high && upWick > bodyC2) {
    // Bullish: swept above C1.high, reclaimed back inside, upper-wick dominant.
    direction = "BULLISH";
    sweepLevel = C1.high;
    manipulationWick = upWick;
  } else if (C2.low < C1.low && C2.close > C1.low && loWick > bodyC2) {
    // Bearish: swept below C1.low, reclaimed back inside, lower-wick dominant.
    direction = "BEARISH";
    sweepLevel = C1.low;
    manipulationWick = loWick;
  } else {
    return null;
  }

  return buildAlert({
    symbol,
    timeframe,
    direction,
    C1,
    C2,
    C3,
    sweepLevel,
    bodyC1,
    bodyC2,
    manipulationWick,
    avgBody,
    impulseStrength,
  });
}

/**
 * Assemble the enriched CRT alert: every raw quality metric + the ranking
 * score. All pre-existing fields are preserved for backward compatibility;
 * new fields are purely additive.
 */
function buildAlert(ctx) {
  const {
    symbol,
    timeframe,
    direction,
    C1,
    C2,
    C3,
    sweepLevel,
    bodyC1,
    bodyC2,
    manipulationWick,
    avgBody,
    impulseStrength,
  } = ctx;

  const isBull = direction === "BULLISH";
  const c1Range = C1.high - C1.low;

  // -- Raw quality metrics (computed ONCE here) -------------------------

  // Body Ratio: displacement dominance = Body(C1) / Body(C2). Capped for storage.
  const bodyRatio = round(safeRatio(bodyC1, bodyC2, BODY_RATIO_CAP), 2);

  // Wick Ratio: manipulation wick / Body(C2). Bigger = cleaner wick manipulation.
  const wickRatio = round(safeRatio(manipulationWick, bodyC2, WICK_RATIO_CAP), 2);

  // Sweep Distance: how far C2 pierced beyond the swept C1 level (price + %).
  const sweepDistance = isBull ? C2.high - C1.high : C1.low - C2.low;
  const sweepRef = isBull ? C1.high : C1.low;
  const sweepPercent = round(sweepRef > 0 ? (sweepDistance / sweepRef) * 100 : 0, 3);

  // Reclaim Depth: how deep C2 CLOSED back inside C1, as % of C1's full range.
  // Deeper reclaim = stronger rejection. Clamped to 0..100.
  const reclaimRaw = isBull ? C1.high - C2.close : C2.close - C1.low;
  const reclaimDepth = round(c1Range > 0 ? clamp((reclaimRaw / c1Range) * 100, 0, 100) : 0, 1);

  // Impulse Strength: Body(C1) vs Average Body(previous candles), plus a % view.
  const impulseStrengthR = round(impulseStrength, 2);
  const impulsePercent = impulseStrength != null ? Math.round(impulseStrength * 100) : null;

  // -- Ranking, grade & strengths (delegated to the shared quality module) --
  const { qualityScore, qualityGrade, breakdown, strengths } = computeQuality({
    bodyRatio,
    wickRatio,
    sweepPercent,
    reclaimDepth,
    impulseStrength: impulseStrengthR,
  });

  const now = new Date().toISOString();
  const detectedAtSec = Math.floor(Date.now() / 1000);

  return {
    // -- Identity --
    // Deterministic, human-readable, unique per pair+timeframe+scan-second,
    // e.g. "BTC_USDT-1H-1753094400". Ready to become a DB primary key later.
    id: `${symbol}-${String(timeframe).toUpperCase()}-${detectedAtSec}`,
    symbol,
    pair: symbol, // alias requested by the spec / consumed by future modules
    timeframe,
    direction, // "BULLISH" | "BEARISH"

    // -- Pre-existing fields (preserved for API / UI / history compatibility) --
    c1High: C1.high,
    c1Low: C1.low,
    c2High: C2.high,
    c2Low: C2.low,
    sweepLevel,
    currentPrice: C2.close, // confirmed close of the manipulation candle
    reclaimPercent: legacyReclaimPercent(direction, C1, C2),
    timestamp: now,

    // -- Candle timing (C3 = current LIVE candle) --
    detectedAt: now,
    c1Time: toIso(C1.openTime),
    c2Time: toIso(C2.openTime),
    c3Time: toIso(C3 && C3.openTime),

    // -- Enriched raw quality metrics (NOT just the score) --
    bodyRatio,
    wickRatio,
    manipulationWick: round(manipulationWick, 8),
    sweepDistance: round(sweepDistance, 8),
    sweepPercent,
    reclaimDepth,
    impulseStrength: impulseStrengthR,
    impulsePercent,
    averageBody: round(avgBody, 8),

    // -- Ranking / grading --
    qualityScore,
    qualityGrade, // "A+" | "A" | "B" | "C" | "D" | "F"
    scoreBreakdown: breakdown, // per-dimension contribution in points
    strengths, // human-readable reasons this setup scored well

    // -- Future trading fields (placeholders for the LTF execution module) --
    // This HTF scanner ONLY identifies opportunities and NEVER computes these.
    // They are intentionally null so a future Lower-Timeframe module (BOS /
    // CHoCH / IFVG / Entry / SL / TP / RR) can fill them in, and so the object
    // already matches the eventual database row shape (no persistence added).
    status: "OPEN",
    entryPrice: null,
    stopLoss: null,
    takeProfit: null,
    riskReward: null,
    tradeResult: null,
    tradeDuration: null,
    notes: null,
  };
}

module.exports = {
  detectCRT,
  getConfirmedPair,
  // Helpers exported for reuse / unit testing and future modules:
  body,
  upperWick,
  lowerWick,
  averageBody,
  isClosedCandle,
  RECENT_LOOKBACK,
  MIN_BODY_RATIO,
  MIN_IMPULSE,
};
