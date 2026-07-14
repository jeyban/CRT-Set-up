/**
 * radarStore.js — Persistence for the Market Radar scanner.
 *
 * Thin configuration wrapper around the SHARED store factory
 * (../scannerStore) — the exact same persistence engine used by the
 * Gainers/Losers store, with no duplicated code.
 *
 * Timeframes: 1d / 1w / 1m
 * Data file : backend/data/radar-data.json
 * Supabase  : radar_history / radar_state
 */

const { createScannerStore } = require("../scannerStore");

module.exports = createScannerStore({
  tfs: ["1d", "1w", "1m"],
  dataFileName: "radar-data.json",
  supabasePrefix: "radar",
  logTag: "Radar-Store",
});
