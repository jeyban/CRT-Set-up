/**
 * radarScheduler.js — Three INDEPENDENT cron schedulers for the Market Radar module.
 *
 * All times are UTC. Radar scans higher timeframes only (1d / 1w / 1m), so its
 * schedules are deliberately infrequent — this keeps the app light enough for
 * Render Free (a 300–500 symbol scan is heavier than a 60 symbol GL scan, so we
 * never run it more than once per candle).
 *
 *   1D Scanner : 07:00 UTC daily (offset 1h after the GL daily scan at 06:00
 *                so the two heavy jobs never overlap on the free tier).
 *                cron: "0 7 * * *"
 *
 *   1W Scanner : Monday 08:00 UTC (weekly candle closes Monday 00:00 UTC).
 *                cron: "0 8 * * 1"
 *
 *   1M Scanner : 1st of month 09:00 UTC.
 *                cron: "0 9 1 * *"
 *
 * Each scanner is registered separately and calls radarScanner.runScan(tf,
 * "auto") independently — one schedule can never affect another.
 *
 * Startup scans are OFF by default (RADAR_STARTUP_SCAN != "true") to protect
 * the Render Free instance from a heavy broad-market scan on every boot/redeploy.
 */

const cron = require("node-cron");
const { runScan } = require("./radarScanner");
const store = require("./radarStore");

let started = false;
const tasks = {};

/** Cron expression per timeframe (UTC). */
const CRON = {
  "1d": "0 7 * * *",
  "1w": "0 8 * * 1",
  "1m": "0 9 1 * *",
};

/**
 * Compute the next scheduled scan time (ISO) for a timeframe, in UTC.
 * @param {"1d"|"1w"|"1m"} tf
 * @param {Date} [from]
 * @returns {string|null} ISO timestamp
 */
function computeNextScan(tf, from = new Date()) {
  const d = new Date(from.getTime());
  if (tf === "1d") {
    let cand = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 7, 0, 0, 0)
    );
    if (cand <= d) cand = new Date(cand.getTime() + 24 * 60 * 60 * 1000);
    return cand.toISOString();
  }
  if (tf === "1w") {
    // Next Monday 08:00 UTC (getUTCDay: 0=Sun .. 1=Mon).
    for (let addDay = 0; addDay <= 7; addDay++) {
      const cand = new Date(
        Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + addDay, 8, 0, 0, 0)
      );
      if (cand > d && cand.getUTCDay() === 1) return cand.toISOString();
    }
  }
  if (tf === "1m") {
    // 1st of a month at 09:00 UTC.
    let cand = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1, 9, 0, 0, 0));
    if (cand <= d) cand = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, 9, 0, 0, 0));
    return cand.toISOString();
  }
  return null;
}

/** Refresh the stored nextScan field for every timeframe. */
function refreshNextScans() {
  for (const tf of store.TFS) {
    store.setNextScan(tf, computeNextScan(tf));
  }
}

/**
 * Run an auto scan for a timeframe and then refresh its next-scan time.
 * Errors are logged but never thrown (so cron keeps running).
 */
async function autoScan(tf) {
  try {
    console.log(`\n📡 [RADAR CRON] ${tf.toUpperCase()} auto scan @ ${new Date().toISOString()}`);
    await runScan(tf, "auto");
  } catch (err) {
    console.error(`[RADAR CRON] ${tf} auto scan error:`, err.message);
    store.appendLog(tf, "error", `Auto scan failed: ${err.message}`);
  } finally {
    store.setNextScan(tf, computeNextScan(tf));
  }
}

/** Register all three independent cron jobs. */
function startRadarScheduler() {
  if (started) {
    console.log("📡 [RADAR] Scheduler already running — skipping duplicate registration");
    return;
  }
  started = true;

  console.log("📡 [RADAR] Starting Market Radar schedulers (UTC):");
  for (const tf of store.TFS) {
    tasks[tf] = cron.schedule(CRON[tf], () => autoScan(tf), { timezone: "UTC" });
    console.log(`  • ${tf.toUpperCase()}: ${CRON[tf]}`);
  }

  refreshNextScans();
  setInterval(refreshNextScans, 60 * 1000);

  // Optional startup scans — OFF by default to protect Render Free.
  if (process.env.RADAR_STARTUP_SCAN === "true") {
    runRadarStartupScans();
  }
}

/**
 * Fire one background startup scan per timeframe (opt-in). Non-blocking and
 * heavily staggered because each radar scan is broad-market and heavy.
 */
function runRadarStartupScans() {
  const order = ["1d", "1w", "1m"];
  order.forEach((tf, i) => {
    setTimeout(() => {
      autoScan(tf).catch((e) => console.error(`[RADAR startup ${tf}]`, e.message));
    }, i * 90000); // 0s, 90s, 180s — never overlap heavy scans
  });
}

module.exports = {
  startRadarScheduler,
  runRadarStartupScans,
  computeNextScan,
  refreshNextScans,
  CRON,
};
