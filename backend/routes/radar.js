/**
 * radar.js — API routes for the Market Radar CRT module.
 *
 * Mounted at /api/radar  (fully separate from /api and /api/gl).
 * Mirrors the Gainers/Losers routes exactly so both scanners expose the SAME
 * response format to the frontend.
 *
 *   GET  /api/radar/dashboard        -> dashboard summary (counts, last/next scan)
 *   GET  /api/radar/scanners         -> state for all timeframes
 *   GET  /api/radar/:tf/state        -> scanner state for one timeframe
 *   GET  /api/radar/:tf/results      -> latest CRT results for one timeframe
 *   GET  /api/radar/:tf/logs         -> scan logs for one timeframe
 *   GET  /api/radar/:tf/history      -> detection history (searchable/sortable)
 *   POST /api/radar/:tf/scan         -> trigger a manual scan (awaits completion)
 *   POST /api/radar/:tf/logs/clear   -> clear logs for one timeframe
 *   GET  /api/radar/health           -> module health
 *
 * tf ∈ { 1d, 1w, 1m }
 */

const express = require("express");
const router = express.Router();

const store = require("../services/radar/radarStore");
const { runScan, isRunning } = require("../services/radar/radarScanner");

function validTf(req, res, next) {
  if (!store.isValidTf(req.params.tf)) {
    return res.status(400).json({ success: false, error: "Use timeframe: 1d, 1w, or 1m" });
  }
  next();
}

// ── Dashboard ─────────────────────────────────
router.get("/dashboard", (req, res) => {
  try {
    res.json({ success: true, data: store.getDashboard(), serverTime: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── All scanner states ────────────────────────
router.get("/scanners", (req, res) => {
  res.json({ success: true, data: store.getAllStates() });
});

// ── Per-timeframe state ───────────────────────
router.get("/:tf/state", validTf, (req, res) => {
  const { tf } = req.params;
  res.json({ success: true, timeframe: tf, state: store.getState(tf), running: isRunning(tf) });
});

// ── Results (separate from logs) ────────────────────
router.get("/:tf/results", validTf, (req, res) => {
  const { tf } = req.params;
  const results = store.getResults(tf);
  res.json({ success: true, timeframe: tf, count: results.length, results, state: store.getState(tf) });
});

// ── Logs (separate from results) ────────────────────
router.get("/:tf/logs", validTf, (req, res) => {
  const { tf } = req.params;
  const limit = parseInt(req.query.limit, 10) || 300;
  res.json({ success: true, timeframe: tf, logs: store.getLogs(tf, limit) });
});

router.post("/:tf/logs/clear", validTf, (req, res) => {
  store.clearLogs(req.params.tf);
  res.json({ success: true, timeframe: req.params.tf, cleared: true });
});

// ── History (searchable + sortable) ────────────────────
router.get("/:tf/history", validTf, (req, res) => {
  const { tf } = req.params;
  const { search, direction, sort } = req.query;
  const limit = parseInt(req.query.limit, 10) || 500;
  const rows = store.getHistory(tf, { search, direction, sort, limit });
  res.json({ success: true, timeframe: tf, count: rows.length, history: rows });
});

// ── Manual scan trigger ──────────────────────
router.post("/:tf/scan", validTf, async (req, res) => {
  const { tf } = req.params;
  if (isRunning(tf)) {
    return res.json({
      success: true,
      scanning: true,
      message: `A ${tf} scan is already running`,
      state: store.getState(tf),
    });
  }
  try {
    const { results, summary, error } = await runScan(tf, "manual");
    if (error) {
      return res.status(502).json({ success: false, error, state: store.getState(tf) });
    }
    res.json({
      success: true,
      scanning: false,
      timeframe: tf,
      found: results.length,
      summary,
      results,
      message:
        results.length > 0
          ? `Scan complete — ${results.length} CRT setups found`
          : `Scan complete — no CRT setups found for ${tf}`,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Health ────────────────────────────────
router.get("/health", (req, res) => {
  res.json({
    success: true,
    module: "market-radar",
    status: "online",
    supabase: store.supabaseEnabled(),
    timeframes: store.TFS,
    serverTime: new Date().toISOString(),
    schedule: {
      "1d": "07:00 UTC daily",
      "1w": "Monday 08:00 UTC",
      "1m": "1st of month 09:00 UTC",
    },
  });
});

module.exports = router;
