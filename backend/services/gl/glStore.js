/**
 * glStore.js — Persistence for the Gainers/Losers scanner.
 *
 * Thin configuration wrapper around the SHARED store factory
 * (../scannerStore). All persistence behaviour (in-memory + local JSON file +
 * optional Supabase) lives in the factory and is never duplicated.
 *
 * Timeframes: 1h / 4h / 1d
 * Data file : backend/data/gl-data.json
 * Supabase  : gl_history / gl_state
 */

const { createScannerStore } = require("../scannerStore");

module.exports = createScannerStore({
  tfs: ["1h", "4h", "1d"],
  dataFileName: "gl-data.json",
  supabasePrefix: "gl",
  logTag: "GL-Store",
});
