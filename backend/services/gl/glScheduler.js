/**
 * glScheduler.js - Three INDEPENDENT cron schedulers for the Gainers/Losers module.
 *
 * All times are UTC. The current user's exchange (MEXC) daily candle closes at
 * 00:00 UTC, which corresponds to the 8:00 AM example given (UTC+8).
 *
 *   1H Scanner   : 1 minute after each 1H candle close (candles close at :00).
 *                  cron: "1 * * * *"
 *
 *   4H Scanner   : 1 minute after each 4H candle close.
 *                  4H candles close at 00,04,08,12,16,20 UTC -> scan at
 *                  00:01,04:01,08:01,12:01,16:01,20:01 UTC.
 *                  cron: "1 0,4,8,12,16,20 * * *"
 *
 *   Daily Scanner: 1 minute after the daily candle close (00:00 UTC) -> 00:01 UTC.
 *                  Exactly one scan per daily candle.
 *                  cron: "1 0 * * *"
 *
 * Each scanner is registered separately and calls glScanner.runScan(tf, "auto")
 * independently - one schedule can never affect another.
 */
​
const cron = require("node-cron");
const { runScan } = require("./glScanner");
const store = require("./glStore");
​
let started = false;
const tasks = {};
​
/** Cron expression per timeframe (UTC). */
const CRON = {
  "1h": "1 * * * *",
  "4h": "1 0,4,8,12,16,20 * * *",
  "1d": "1 0 * * *",
};
​
/**
 * Compute the next scheduled scan time (ISO) for a timeframe, in UTC.
 * @param {"1h"|"4h"|"1d"} tf
 * @param {Date} [from]
 * @returns {string} ISO timestamp
 */
function computeNextScan(tf, from = new Date()) {
  const d = new Date(from.getTime());
  if (tf === "1h") {
    const next = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), 1, 0, 0)
    );
    if (next <= d) next.setUTCHours(next.getUTCHours() + 1);
    return next.toISOString();
  }
  if (tf === "4h") {
    const hours = [0, 4, 8, 12, 16, 20];
    for (let addDay = 0; addDay <= 1; addDay++) {
      for (const h of hours) {
        const cand = new Date(
          Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + addDay, h, 1, 0, 0)
        );
        if (cand > d) return cand.toISOString();
      }
    }
  }
  if (tf === "1d") {
    let cand = new Date(
      Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 1, 0, 0)
    );
    if (cand <= d) cand = new Date(cand.getTime() + 24 * 60 * 60 * 1000);
    return cand.toISOString();
  }
  return null;
}
​
/** Refresh the stored nextScan field for every timeframe. */
function refreshNextScans() {
  for (const tf of store.TFS) {
    store.setNextScan(tf, computeNextScan(tf));
  }
}
​
/**
 * Run an auto scan for a timeframe and then refresh its next-scan time.
 * Errors are logged but never thrown (so cron keeps running).
 */
async function autoScan(tf) {
  try {
    console.log(`\n⏰ [GL CRON] ${tf.toUpperCase()} auto scan @ ${new Date().toISOString()}`);
    await runScan(tf, "auto");
  } catch (err) {
    console.error(`[GL CRON] ${tf} auto scan error:`, err.message);
    store.appendLog(tf, "error", `Auto scan failed: ${err.message}`);
  } finally {
    store.setNextScan(tf, computeNextScan(tf));
  }
}
​
/** Register all three independent cron jobs. */
function startGlScheduler() {
  if (started) {
    console.log("⏰ [GL] Scheduler already running - skipping duplicate registration");
    return;
  }
  started = true;
​
  console.log("⏰ [GL] Starting Gainers/Losers schedulers (UTC):");
  for (const tf of store.TFS) {
    tasks[tf] = cron.schedule(CRON[tf], () => autoScan(tf), { timezone: "UTC" });
    console.log(`  • ${tf.toUpperCase()}: ${CRON[tf]}`);
  }
​
  refreshNextScans();
  // Keep nextScan fresh even if the process stays up across a boundary.
  setInterval(refreshNextScans, 60 * 1000);
}
​
/**
 * Fire one background startup scan per timeframe so the dashboard is never
 * empty on first boot. Non-blocking and staggered to avoid hammering the API.
 */
function runGlStartupScans() {
  const order = ["1h", "4h", "1d"];
  order.forEach((tf, i) => {
    setTimeout(() => {
      autoScan(tf).catch((e) => console.error(`[GL startup ${tf}]`, e.message));
    }, i * 5000); // 0s, 5s, 10s
  });
}
​
module.exports = {
  startGlScheduler,
  runGlStartupScans,
  computeNextScan,
  refreshNextScans,
  CRON,
};
​
