/**
 * crtQuality.js - SHARED CRT Quality scoring module (ranking + grading).
 *
 * SINGLE SOURCE OF TRUTH. Both Higher-Timeframe scanners (Gainers & Losers and
 * Market Radar) and the legacy /api scanner import this exact module - the
 * Quality Score / Grade / Strengths are never duplicated elsewhere.
 *
 * Responsibility boundary (unchanged):
 *   • crtLogic.js  decides VALIDITY (is this a CRT at all?).
 *   • crtQuality.js only RANKS + GRADES a setup the engine already accepted.
 * Pure and dependency-free - no I/O, no live data, no persistence.
 *
 * -- Score model (0..100) -------------------------------------------------
 * Each raw metric produced by the engine is normalized to a 0..100 sub-score,
 * then combined with the spec weights:
 *
 *   Body Ratio        30%   (displacement dominance: Body(C1) / Body(C2))
 *   Wick Ratio        20%   (manipulation quality: sweep wick / Body(C2))
 *   Sweep Distance    15%   (how far C2 swept beyond C1, in %)
 *   Reclaim Depth     20%   (how deep C2 closed back inside C1, in %)
 *   Impulse Strength  15%   (Body(C1) vs average body of previous candles)
 *
 * The exposed `scoreBreakdown` reports each dimension's CONTRIBUTION in points
 * (sub-score x weight), e.g. { body: 28, wick: 19, sweep: 14, reclaim: 18,
 * impulse: 13 }. With every metric present these sum to the final score; when
 * a metric is unavailable (e.g. no candle history for Impulse) its weight is
 * dropped and the remaining weights are renormalized so the score stays 0..100.
 */
​
function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
​
/** Component weights (as points out of 100). MUST sum to 100. */
const WEIGHTS = {
  body: 30,
  wick: 20,
  sweep: 15,
  reclaim: 20,
  impulse: 15,
};
​
/**
 * Saturation points. A metric at or above its "full" value earns the full 100
 * for that component; beyond it, extra magnitude does not keep inflating the
 * score (prevents any single outlier from dominating the ranking).
 */
const BODY_RATIO_FULL = 6; // Body(C1)/Body(C2) >= 6   -> full body score
const WICK_RATIO_FULL = 3; // wick/Body(C2)     >= 3   -> full wick score
const SWEEP_PCT_FULL = 1.0; // sweep percent    >= 1.0% -> full sweep score
const IMPULSE_FULL = 2.5; // Body(C1)/avgBody   >= 2.5 -> full impulse score
// Reclaim Depth is already expressed as a 0..100 percentage.
​
function normBodyRatio(r) {
  return r == null ? null : clamp((r / BODY_RATIO_FULL) * 100, 0, 100);
}
function normWickRatio(r) {
  return r == null ? null : clamp((r / WICK_RATIO_FULL) * 100, 0, 100);
}
function normSweepPct(p) {
  return p == null ? null : clamp((p / SWEEP_PCT_FULL) * 100, 0, 100);
}
function normReclaimDepth(d) {
  return d == null ? null : clamp(d, 0, 100);
}
function normImpulse(r) {
  return r == null ? null : clamp((r / IMPULSE_FULL) * 100, 0, 100);
}
​
/**
 * Map a 0..100 Quality Score to a letter grade.
 *   A+ >= 90 | A >= 80 | B >= 70 | C >= 60 | D >= 50 | F < 50
 */
function gradeForScore(score) {
  if (score >= 90) return "A+";
  if (score >= 80) return "A";
  if (score >= 70) return "B";
  if (score >= 60) return "C";
  if (score >= 50) return "D";
  return "F";
}
​
/**
 * Human-readable reasons a setup scored well. Each rule fires ONLY when the
 * corresponding raw metric clears a "genuinely good" threshold, so the returned
 * array explains WHY this specific CRT is strong (empty when nothing stands out).
 */
const STRENGTH_RULES = [
  { test: (m) => m.bodyRatio != null && m.bodyRatio >= 3, label: "Strong displacement" },
  { test: (m) => m.wickRatio != null && m.wickRatio >= 2, label: "Excellent manipulation wick" },
  { test: (m) => m.sweepPercent != null && m.sweepPercent >= 0.3, label: "Clean liquidity sweep" },
  { test: (m) => m.reclaimDepth != null && m.reclaimDepth >= 50, label: "Deep reclaim" },
  { test: (m) => m.impulseStrength != null && m.impulseStrength >= 1.5, label: "Above-average impulse" },
];
​
function deriveStrengths(metrics) {
  return STRENGTH_RULES.filter((r) => r.test(metrics)).map((r) => r.label);
}
​
/**
 * Compute the Quality Score, Grade, per-dimension breakdown and Strengths for a
 * VALID CRT setup from its raw metrics.
 *
 * @param {Object} m
 * @param {number}      m.bodyRatio       - Body(C1) / Body(C2)
 * @param {number}      m.wickRatio       - manipulation wick / Body(C2)
 * @param {number}      m.sweepPercent    - sweep distance beyond C1 level (%)
 * @param {number}      m.reclaimDepth    - how deep C2 closed inside C1 (%)
 * @param {number|null} m.impulseStrength - Body(C1) / avgBody (null if unknown)
 * @returns {{ qualityScore:number, qualityGrade:string, breakdown:Object, strengths:string[] }}
 */
function computeQuality(m) {
  const components = [
    { key: "body", weight: WEIGHTS.body, score: normBodyRatio(m.bodyRatio) },
    { key: "wick", weight: WEIGHTS.wick, score: normWickRatio(m.wickRatio) },
    { key: "sweep", weight: WEIGHTS.sweep, score: normSweepPct(m.sweepPercent) },
    { key: "reclaim", weight: WEIGHTS.reclaim, score: normReclaimDepth(m.reclaimDepth) },
    { key: "impulse", weight: WEIGHTS.impulse, score: normImpulse(m.impulseStrength) },
  ];
​
  let weightedPoints = 0; // sum of (subScore/100 * weightPoints)
  let weightAvailable = 0; // sum of weightPoints actually used
  const breakdown = {};
​
  for (const c of components) {
    if (c.score == null) {
      breakdown[c.key] = null; // metric not available for this setup
      continue;
    }
    const contribution = (c.score / 100) * c.weight; // points out of c.weight
    breakdown[c.key] = Math.round(contribution);
    weightedPoints += contribution;
    weightAvailable += c.weight;
  }
​
  // Renormalize by available weight so a missing metric can't deflate the score.
  const finalScore = weightAvailable > 0 ? (weightedPoints / weightAvailable) * 100 : 0;
  const qualityScore = clamp(Math.round(finalScore), 0, 100);
​
  return {
    qualityScore,
    qualityGrade: gradeForScore(qualityScore),
    breakdown,
    strengths: deriveStrengths(m),
  };
}
​
module.exports = {
  computeQuality,
  gradeForScore,
  deriveStrengths,
  clamp,
  WEIGHTS,
  BODY_RATIO_FULL,
  WICK_RATIO_FULL,
  SWEEP_PCT_FULL,
  IMPULSE_FULL,
};
