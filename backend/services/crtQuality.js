/**
 * crtQuality.js — SHARED CRT Quality Score engine (ranking metric).
 *
 * SINGLE SOURCE OF TRUTH. Both scanners (Gainers & Losers and Market Radar)
 * import this exact module — the Quality Score is never duplicated. Any future
 * change here automatically benefits both scanners.
 *
 * Ranks VALID CRT setups only. It NEVER invalidates a setup — a valid CRT is
 * valid regardless of its score; the score only determines ranking order.
 *
 * Deliberately decoupled from the CRT engine (crtLogic.js): the engine decides
 * validity, this module only ranks what the engine already accepted. It is a
 * pure, dependency-free function — no I/O, no loops, no live data.
 *
 * Final Score = BodyScore*0.60 + ReclaimScore*0.25 + SweepScore*0.15,
 * clamped to 1..100 and rounded to the nearest whole number.
 *
 * All three components are normalized to 0..100 from the two confirmed closed
 * candles (C1 = earlier, C2 = latest).
 */

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Body Dominance saturation point. A Body Ratio (C1Body / C2Body) at or above
 * this value earns the full body score of 100. Chosen because a 20:1 body
 * dominance is already an extreme, decisive prior candle; beyond it, extra
 * ratio should not keep inflating the score. This is the single tunable knob
 * for the body-score curve.
 */
const BODY_RATIO_CAP = 20;
const LOG_CAP = Math.log(BODY_RATIO_CAP); // precomputed norm:  log(cap)

/**
 * Normalize the Body Ratio into 0..100 with smooth, capped-logarithmic
 * diminishing returns.
 *
 *   bodyScore = 100 * log(ratio) / log(BODY_RATIO_CAP), clamped to [0, 100]
 *
 * Properties (exactly what the spec asks for):
 *   • Larger ratios -> higher scores          (log is monotonically increasing)
 *   • Smooth & predictable                    (continuous log curve)
 *   • Extreme ratios can't dominate           (clamped at 100 from ratio >= cap)
 *
 * Reference points (cap = 20):
 *   ratio 1  -> 0      ratio 2  -> ~23     ratio 4  -> ~46
 *   ratio 10 -> ~77    ratio 20 -> 100     ratio 1000 -> 100 (capped)
 *
 * @param {number} ratio - C1Body / C2Body (>= 1 for a valid CRT).
 * @returns {number} 0..100
 */
function normalizeBodyRatio(ratio) {
  if (!(ratio > 1)) return 0;            // ratio <= 1 (or NaN) -> no dominance
  if (!isFinite(ratio)) return 100;      // C2 body ~0 -> maximal dominance
  return clamp((Math.log(ratio) / LOG_CAP) * 100, 0, 100);
}

/**
 * Compute the 1..100 Quality Score for a VALID CRT setup.
 *
 * @param {"BULLISH"|"BEARISH"} direction
 * @param {Object} C1 - earlier closed candle { open, high, low, close }
 * @param {Object} C2 - latest closed candle { open, high, low, close }
 * @returns {number} integer in [1, 100]
 */
function computeQuality(direction, C1, C2) {
  const isBull = direction === "BULLISH";

  // ── Component 1 — Body Dominance (60%) ────────────────────────────────────
  // Explicitly RATIO-BASED: Body Ratio = C1Body / C2Body, normalized through a
  // capped-logarithmic curve (see normalizeBodyRatio). For a valid CRT,
  // C1Body > C2Body >= 0, so the ratio is >= 1 (C1Body > 0).
  const c1Body = Math.abs(C1.close - C1.open);
  const c2Body = Math.abs(C2.close - C2.open);
  const bodyRatio = c2Body > 0 ? c1Body / c2Body : Infinity;
  const bodyScore = normalizeBodyRatio(bodyRatio);

  // C1's own range is the natural, scale-free container for the reclaim depth
  // and the sweep size measurements below.
  const c1Range = C1.high - C1.low;

  // ── Component 2 — Reclaim Strength (25%) ─────────────────────────────────
  // How deeply C2 closed back inside C1 past the swept boundary.
  //   Bullish: distance C2.close sits below C1.high
  //   Bearish: distance C2.close sits above C1.low
  const reclaimDepth = isBull ? C1.high - C2.close : C2.close - C1.low;
  const reclaimScore =
    c1Range > 0 ? clamp((reclaimDepth / c1Range) * 100, 0, 100) : 0;

  // ── Component 3 — Sweep Strength (15%) ───────────────────────────────────
  //   Bullish: Sweep Size = C2.high - C1.high
  //   Bearish: Sweep Size = C1.low  - C2.low
  const sweepSize = isBull ? C2.high - C1.high : C1.low - C2.low;
  const sweepScore =
    c1Range > 0 ? clamp((sweepSize / c1Range) * 100, 0, 100) : 0;

  const finalScore =
    bodyScore * 0.6 + reclaimScore * 0.25 + sweepScore * 0.15;

  return clamp(Math.round(finalScore), 1, 100);
}

module.exports = { computeQuality, normalizeBodyRatio, BODY_RATIO_CAP };
