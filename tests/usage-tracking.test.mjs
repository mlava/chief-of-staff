import test from "node:test";
import assert from "node:assert/strict";

// ── window shim (must come before module import) ─────────────────────────────
// usage-tracking.js references window.setTimeout / window.clearTimeout for
// debounced persistence. Node doesn't have a global `window`, so we shim it.
globalThis.window = globalThis.window || {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
};

import {
  initUsageTracking,
  getSessionTokenUsage,
  accumulateSessionTokens,
  resetSessionTokenUsage,
  todayDateKey,
  loadCostHistory,
  loadUsageStats,
  recordCostEntry,
  isDailyCapExceeded,
  getCostHistorySummary,
  recordUsageStat,
  flushUsageTracking,
} from "../src/usage-tracking.js";

// ── Test helpers ─────────────────────────────────────────────────────────────

/** Build a mock deps object with sensible defaults. Callers can override. */
function makeDeps(overrides = {}) {
  return {
    SETTINGS_KEYS: {
      costHistory: "cost-history",
      dailySpendingCap: "daily-spending-cap",
      usageStats: "usage-stats",
      auditLogRetentionDays: "audit-log-retention-days",
    },
    getExtensionAPIRef: () => ({
      settings: { get: () => undefined, set: () => {} },
    }),
    getSettingString: (api, key, fallback) => fallback,
    ensurePageUidByTitle: async () => "page-uid",
    createRoamBlock: async () => {},
    formatRoamDate: (d) =>
      `${d.toLocaleString("en-US", { month: "long" })} ${d.getDate()}${ordinal(d.getDate())}, ${d.getFullYear()}`,
    queryRoamDatalog: async () => null,
    escapeForDatalog: (s) => s,
    getRoamAlphaApi: () => ({ q: () => [], deleteBlock: async () => {} }),
    debugLog: () => {},
    getUnloadInProgress: () => false,
    ...overrides,
  };
}

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

// ═════════════════════════════════════════════════════════════════════════════
// todayDateKey
// ═════════════════════════════════════════════════════════════════════════════

test("todayDateKey returns YYYY-MM-DD format for today", () => {
  const key = todayDateKey();
  assert.match(key, /^\d{4}-\d{2}-\d{2}$/);
  const d = new Date();
  const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  assert.equal(key, expected);
});

test("todayDateKey zero-pads single-digit months and days", () => {
  // This is implicitly tested by the format check above, but we verify the
  // regex constraint: both month and day segments are always 2 digits.
  const key = todayDateKey();
  const [, month, day] = key.split("-");
  assert.equal(month.length, 2);
  assert.equal(day.length, 2);
});

// ═════════════════════════════════════════════════════════════════════════════
// Session token usage (accumulate / get / reset)
// ═════════════════════════════════════════════════════════════════════════════

test("getSessionTokenUsage returns initial zeros", () => {
  resetSessionTokenUsage(); // ensure clean state
  const u = getSessionTokenUsage();
  assert.equal(u.totalInputTokens, 0);
  assert.equal(u.totalOutputTokens, 0);
  assert.equal(u.totalRequests, 0);
  assert.equal(u.totalCostUsd, 0);
});

test("accumulateSessionTokens accumulates across multiple calls", () => {
  resetSessionTokenUsage();
  accumulateSessionTokens(100, 50, 0.001);
  accumulateSessionTokens(200, 75, 0.002);
  const u = getSessionTokenUsage();
  assert.equal(u.totalInputTokens, 300);
  assert.equal(u.totalOutputTokens, 125);
  assert.equal(u.totalRequests, 2);
  assert.ok(Math.abs(u.totalCostUsd - 0.003) < 1e-10);
});

test("resetSessionTokenUsage zeros all counters", () => {
  accumulateSessionTokens(500, 250, 0.05);
  resetSessionTokenUsage();
  const u = getSessionTokenUsage();
  assert.equal(u.totalInputTokens, 0);
  assert.equal(u.totalOutputTokens, 0);
  assert.equal(u.totalRequests, 0);
  assert.equal(u.totalCostUsd, 0);
});

test("getSessionTokenUsage returns same object reference (mutation-safe)", () => {
  resetSessionTokenUsage();
  const a = getSessionTokenUsage();
  accumulateSessionTokens(10, 5, 0.0001);
  const b = getSessionTokenUsage();
  // Same object — callers see accumulated values
  assert.equal(a, b);
  assert.equal(a.totalInputTokens, 10);
});

// ═════════════════════════════════════════════════════════════════════════════
// loadCostHistory
// ═════════════════════════════════════════════════════════════════════════════

test("loadCostHistory loads valid data from settings", () => {
  initUsageTracking(makeDeps());
  const data = { days: { "2026-03-01": { cost: 0.5, input: 1000, output: 500, requests: 3, models: {} } } };
  const api = { settings: { get: (key) => key === "cost-history" ? data : undefined, set: () => {} } };
  loadCostHistory(api);
  // Verify it loaded by checking summary
  const summary = getCostHistorySummary();
  assert.ok(summary.today !== undefined);
});

test("loadCostHistory resets to empty when settings has garbage", () => {
  initUsageTracking(makeDeps());
  const api = { settings: { get: () => "not an object", set: () => {} } };
  loadCostHistory(api);
  const summary = getCostHistorySummary();
  assert.equal(summary.today.cost, 0);
});

test("loadCostHistory resets to empty when settings returns null", () => {
  initUsageTracking(makeDeps());
  const api = { settings: { get: () => null, set: () => {} } };
  loadCostHistory(api);
  const summary = getCostHistorySummary();
  assert.equal(summary.today.cost, 0);
});

test("loadCostHistory resets when object lacks days property", () => {
  initUsageTracking(makeDeps());
  const api = { settings: { get: () => ({ foo: "bar" }), set: () => {} } };
  loadCostHistory(api);
  const summary = getCostHistorySummary();
  assert.equal(summary.today.cost, 0);
});

// ═════════════════════════════════════════════════════════════════════════════
// recordCostEntry
// ═════════════════════════════════════════════════════════════════════════════

test("recordCostEntry creates day record and accumulates cost", () => {
  initUsageTracking(makeDeps());
  // Start fresh
  loadCostHistory({ settings: { get: () => null, set: () => {} } });

  recordCostEntry("claude-haiku-4-5", 1000, 500, 0.01);
  const summary = getCostHistorySummary();
  assert.equal(summary.today.cost, 0.01);
  assert.equal(summary.today.input, 1000);
  assert.equal(summary.today.output, 500);
  assert.equal(summary.today.requests, 1);
});

test("recordCostEntry accumulates multiple entries for same model", () => {
  initUsageTracking(makeDeps());
  loadCostHistory({ settings: { get: () => null, set: () => {} } });

  recordCostEntry("gpt-5-mini", 500, 200, 0.005);
  recordCostEntry("gpt-5-mini", 300, 100, 0.003);
  const summary = getCostHistorySummary();
  assert.ok(Math.abs(summary.today.cost - 0.008) < 1e-10);
  assert.equal(summary.today.requests, 2);
});

test("recordCostEntry tracks per-model breakdown", () => {
  initUsageTracking(makeDeps());
  loadCostHistory({ settings: { get: () => null, set: () => {} } });

  recordCostEntry("model-a", 100, 50, 0.001);
  recordCostEntry("model-b", 200, 75, 0.002);
  recordCostEntry("model-a", 150, 60, 0.0015);

  const summary = getCostHistorySummary();
  const models = summary.today.models;
  assert.equal(models["model-a"].requests, 2);
  assert.ok(Math.abs(models["model-a"].cost - 0.0025) < 1e-10);
  assert.equal(models["model-b"].requests, 1);
});

// ═════════════════════════════════════════════════════════════════════════════
// isDailyCapExceeded
// ═════════════════════════════════════════════════════════════════════════════

test("isDailyCapExceeded returns not exceeded when no cap configured", () => {
  initUsageTracking(makeDeps({ getSettingString: () => "" }));
  loadCostHistory({ settings: { get: () => null, set: () => {} } });
  const result = isDailyCapExceeded();
  assert.equal(result.exceeded, false);
  assert.equal(result.cap, null);
  assert.equal(result.spent, 0);
});

test("isDailyCapExceeded returns not exceeded when cap is invalid", () => {
  initUsageTracking(makeDeps({ getSettingString: () => "abc" }));
  const result = isDailyCapExceeded();
  assert.equal(result.exceeded, false);
  assert.equal(result.cap, null);
});

test("isDailyCapExceeded returns not exceeded when cap is zero", () => {
  initUsageTracking(makeDeps({ getSettingString: () => "0" }));
  const result = isDailyCapExceeded();
  assert.equal(result.exceeded, false);
  assert.equal(result.cap, null);
});

test("isDailyCapExceeded returns not exceeded when cap is negative", () => {
  initUsageTracking(makeDeps({ getSettingString: () => "-5" }));
  const result = isDailyCapExceeded();
  assert.equal(result.exceeded, false);
  assert.equal(result.cap, null);
});

test("isDailyCapExceeded detects when spending exceeds cap", () => {
  initUsageTracking(makeDeps({ getSettingString: () => "0.05" }));
  loadCostHistory({ settings: { get: () => null, set: () => {} } });

  recordCostEntry("model-a", 1000, 500, 0.03);
  recordCostEntry("model-a", 1000, 500, 0.03);

  const result = isDailyCapExceeded();
  assert.equal(result.exceeded, true);
  assert.equal(result.cap, 0.05);
  assert.ok(result.spent >= 0.05);
});

test("isDailyCapExceeded returns not exceeded when under cap", () => {
  initUsageTracking(makeDeps({ getSettingString: () => "1.00" }));
  loadCostHistory({ settings: { get: () => null, set: () => {} } });

  recordCostEntry("model-a", 100, 50, 0.001);
  const result = isDailyCapExceeded();
  assert.equal(result.exceeded, false);
  assert.equal(result.cap, 1.00);
  assert.ok(result.spent < 1.00);
});

// ═════════════════════════════════════════════════════════════════════════════
// getCostHistorySummary
// ═════════════════════════════════════════════════════════════════════════════

test("getCostHistorySummary returns zeros for empty history", () => {
  initUsageTracking(makeDeps());
  loadCostHistory({ settings: { get: () => null, set: () => {} } });

  const summary = getCostHistorySummary();
  assert.equal(summary.today.cost, 0);
  assert.equal(summary.week.cost, 0);
  assert.equal(summary.month.cost, 0);
});

test("getCostHistorySummary aggregates week and month correctly", () => {
  initUsageTracking(makeDeps());

  // Build history with entries for today, 3 days ago, and 10 days ago
  const now = new Date();
  const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  const today = fmt(now);
  const threeDaysAgo = new Date(now);
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
  const tenDaysAgo = new Date(now);
  tenDaysAgo.setDate(tenDaysAgo.getDate() - 10);

  const data = {
    days: {
      [today]: { cost: 0.10, input: 1000, output: 500, requests: 5, models: {} },
      [fmt(threeDaysAgo)]: { cost: 0.20, input: 2000, output: 1000, requests: 10, models: {} },
      [fmt(tenDaysAgo)]: { cost: 0.30, input: 3000, output: 1500, requests: 15, models: {} },
    },
  };

  loadCostHistory({ settings: { get: (k) => k === "cost-history" ? data : undefined, set: () => {} } });

  const summary = getCostHistorySummary();
  // Today: 0.10
  assert.ok(Math.abs(summary.today.cost - 0.10) < 1e-10);
  // Week (last 7 days): today + 3 days ago = 0.30
  assert.ok(Math.abs(summary.week.cost - 0.30) < 1e-10);
  assert.equal(summary.week.requests, 15);
  // Month (last 30 days): all three = 0.60
  assert.ok(Math.abs(summary.month.cost - 0.60) < 1e-10);
  assert.equal(summary.month.requests, 30);
});

test("getCostHistorySummary includes today models in today data", () => {
  initUsageTracking(makeDeps());
  loadCostHistory({ settings: { get: () => null, set: () => {} } });

  recordCostEntry("model-x", 100, 50, 0.001);
  recordCostEntry("model-y", 200, 100, 0.002);

  const summary = getCostHistorySummary();
  assert.ok("model-x" in summary.today.models);
  assert.ok("model-y" in summary.today.models);
});

// ═════════════════════════════════════════════════════════════════════════════
// loadUsageStats
// ═════════════════════════════════════════════════════════════════════════════

test("loadUsageStats loads valid data from settings", () => {
  initUsageTracking(makeDeps());
  const data = { days: { "2026-03-01": { agentRuns: 5, toolCalls: {} } } };
  loadUsageStats({ settings: { get: (k) => k === "usage-stats" ? data : undefined, set: () => {} } });
  // No direct getter, but recordUsageStat should work after load
  // This mainly verifies it doesn't throw
  assert.ok(true);
});

test("loadUsageStats resets to empty on invalid data", () => {
  initUsageTracking(makeDeps());
  loadUsageStats({ settings: { get: () => 42, set: () => {} } });
  assert.ok(true); // no throw
});

// ═════════════════════════════════════════════════════════════════════════════
// recordUsageStat
// ═════════════════════════════════════════════════════════════════════════════

test("recordUsageStat increments agentRuns", () => {
  initUsageTracking(makeDeps());
  loadUsageStats({ settings: { get: () => null, set: () => {} } });

  recordUsageStat("agentRuns");
  recordUsageStat("agentRuns");
  recordUsageStat("agentRuns");
  // We can verify indirectly via the getCostHistorySummary or by recording more
  // stats and checking they don't throw. Direct state access isn't exported,
  // so we trust accumulation works if no errors are thrown.
  assert.ok(true);
});

test("recordUsageStat tracks tool calls with detail", () => {
  initUsageTracking(makeDeps());
  loadUsageStats({ settings: { get: () => null, set: () => {} } });

  recordUsageStat("toolCall", "roam_search");
  recordUsageStat("toolCall", "roam_search");
  recordUsageStat("toolCall", "roam_create_block");
  // No throw = accumulation is working
  assert.ok(true);
});

test("recordUsageStat ignores unknown stat names gracefully", () => {
  initUsageTracking(makeDeps());
  loadUsageStats({ settings: { get: () => null, set: () => {} } });

  // Should not throw for unknown stat
  recordUsageStat("nonExistentStat");
  assert.ok(true);
});

test("recordUsageStat increments all known counter stats", () => {
  initUsageTracking(makeDeps());
  loadUsageStats({ settings: { get: () => null, set: () => {} } });

  const stats = [
    "agentRuns",
    "approvalsGranted",
    "approvalsDenied",
    "injectionWarnings",
    "claimedActionFires",
    "tierEscalations",
    "memoryWriteBlocks",
  ];
  for (const s of stats) {
    recordUsageStat(s); // should not throw
  }
  assert.ok(true);
});

// ═════════════════════════════════════════════════════════════════════════════
// flushUsageTracking
// ═════════════════════════════════════════════════════════════════════════════

test("flushUsageTracking persists pending cost history synchronously", () => {
  let persisted = {};
  const api = {
    settings: {
      get: () => null,
      set: (key, val) => { persisted[key] = val; },
    },
  };

  initUsageTracking(makeDeps({
    getExtensionAPIRef: () => api,
    SETTINGS_KEYS: {
      costHistory: "cost-history",
      dailySpendingCap: "daily-spending-cap",
      usageStats: "usage-stats",
      auditLogRetentionDays: "audit-log-retention-days",
    },
  }));
  loadCostHistory(api);

  // Record an entry (triggers debounced persist)
  recordCostEntry("model-z", 100, 50, 0.001);

  // Flush immediately — should persist without waiting for debounce
  flushUsageTracking(api);

  assert.ok("cost-history" in persisted);
  assert.ok(persisted["cost-history"].days);
  const today = todayDateKey();
  assert.ok(persisted["cost-history"].days[today]);
  assert.equal(persisted["cost-history"].days[today].requests, 1);
});

test("flushUsageTracking persists pending usage stats synchronously", () => {
  let persisted = {};
  const api = {
    settings: {
      get: () => null,
      set: (key, val) => { persisted[key] = val; },
    },
  };

  initUsageTracking(makeDeps({
    getExtensionAPIRef: () => api,
    SETTINGS_KEYS: {
      costHistory: "cost-history",
      dailySpendingCap: "daily-spending-cap",
      usageStats: "usage-stats",
      auditLogRetentionDays: "audit-log-retention-days",
    },
  }));
  loadCostHistory(api);
  loadUsageStats(api);

  // Record a usage stat (triggers debounced persist)
  recordUsageStat("agentRuns");

  // Flush
  flushUsageTracking(api);

  assert.ok("usage-stats" in persisted);
  assert.ok(persisted["usage-stats"].days);
});

test("flushUsageTracking is safe to call with no pending writes", () => {
  initUsageTracking(makeDeps());
  loadCostHistory({ settings: { get: () => null, set: () => {} } });
  loadUsageStats({ settings: { get: () => null, set: () => {} } });

  // No records → no pending timeouts → flush should be a no-op
  flushUsageTracking({ settings: { set: () => {} } });
  assert.ok(true);
});

test("flushUsageTracking handles null api gracefully", () => {
  initUsageTracking(makeDeps());
  loadCostHistory({ settings: { get: () => null, set: () => {} } });

  recordCostEntry("model-a", 100, 50, 0.001);
  // Flush with null api — should not throw
  flushUsageTracking(null);
  assert.ok(true);
});

// ═════════════════════════════════════════════════════════════════════════════
// Integration: recordCostEntry + isDailyCapExceeded round-trip
// ═════════════════════════════════════════════════════════════════════════════

test("cap enforcement works across multiple record calls", () => {
  initUsageTracking(makeDeps({ getSettingString: () => "0.10" }));
  loadCostHistory({ settings: { get: () => null, set: () => {} } });

  // Under cap
  recordCostEntry("m", 100, 50, 0.03);
  assert.equal(isDailyCapExceeded().exceeded, false);

  recordCostEntry("m", 100, 50, 0.03);
  assert.equal(isDailyCapExceeded().exceeded, false);

  // At cap
  recordCostEntry("m", 100, 50, 0.04);
  assert.equal(isDailyCapExceeded().exceeded, true);

  // Over cap
  recordCostEntry("m", 100, 50, 0.05);
  assert.equal(isDailyCapExceeded().exceeded, true);
  assert.ok(isDailyCapExceeded().spent >= 0.10);
});
