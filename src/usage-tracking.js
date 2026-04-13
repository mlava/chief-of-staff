/**
 * usage-tracking.js — Cost history, daily spending caps, audit log, usage stats accumulator.
 *
 * Extracted from index.js. All external dependencies are injected via initUsageTracking().
 */

let deps = {};

// ── Module-scoped state ──────────────────────────────────────────────
const sessionTokenUsage = {
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheReadTokens: 0,
  totalCacheCreationTokens: 0,
  totalRequests: 0,
  totalCostUsd: 0,
};

// Persistent cost history (daily cost records persisted to IndexedDB)
// Shape: { days: { "2026-02-27": { cost, input, output, requests, models: { "model-id": { cost, input, output, requests } } } } }
let costHistory = { days: {} };
let costHistoryPersistTimeoutId = null;
const COST_HISTORY_MAX_DAYS = 90;

// Usage stats accumulator (per-day counters for tool calls, approvals, etc.)
let usageStats = { days: {} };
let usageStatsPersistTimeoutId = null;
const USAGE_STATS_MAX_DAYS = 90;

let auditTrimInFlight = false;
const AUDIT_TRIM_BATCH_SIZE = 10;
const AUDIT_TRIM_BATCH_YIELD_MS = 50;

// Budget warning thresholds — tracks which thresholds have been shown this session
// to avoid repeat toasts. Resets when the day changes.
const BUDGET_WARNING_THRESHOLDS = [0.5, 0.8, 1.0]; // 50%, 80%, 100%
let budgetWarningsFiredToday = { dateKey: "", firedThresholds: new Set() };

// Firebase/Roam Depot keys cannot contain . # $ / [ ]
function sanitiseKey(k) {
  return typeof k === "string" ? k.replace(/[.#$/[\]]/g, "_") : k;
}

// ── Accessors ────────────────────────────────────────────────────────

export function getSessionTokenUsage() {
  return sessionTokenUsage;
}

export function accumulateSessionTokens(inputTokens, outputTokens, callCost, cacheReadTokens = 0, cacheCreationTokens = 0) {
  sessionTokenUsage.totalInputTokens += inputTokens;
  sessionTokenUsage.totalOutputTokens += outputTokens;
  sessionTokenUsage.totalCacheReadTokens += cacheReadTokens;
  sessionTokenUsage.totalCacheCreationTokens += cacheCreationTokens;
  sessionTokenUsage.totalRequests += 1;
  sessionTokenUsage.totalCostUsd += callCost;
}

export function resetSessionTokenUsage() {
  sessionTokenUsage.totalInputTokens = 0;
  sessionTokenUsage.totalOutputTokens = 0;
  sessionTokenUsage.totalCacheReadTokens = 0;
  sessionTokenUsage.totalCacheCreationTokens = 0;
  sessionTokenUsage.totalRequests = 0;
  sessionTokenUsage.totalCostUsd = 0;
}

// ── Cost History ─────────────────────────────────────────────────────

export function todayDateKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function loadCostHistory(extensionAPI) {
  const raw = extensionAPI?.settings?.get?.(deps.SETTINGS_KEYS.costHistory);
  if (raw && typeof raw === "object" && raw.days) {
    costHistory = raw;
  } else {
    costHistory = { days: {} };
  }
}

function persistCostHistory(extensionAPI) {
  const api = extensionAPI || deps.getExtensionAPIRef();
  if (costHistoryPersistTimeoutId) {
    window.clearTimeout(costHistoryPersistTimeoutId);
  }
  costHistoryPersistTimeoutId = window.setTimeout(() => {
    costHistoryPersistTimeoutId = null;
    pruneCostHistory();
    api?.settings?.set?.(deps.SETTINGS_KEYS.costHistory, costHistory);
  }, 3000); // 3s debounce
}

function pruneCostHistory() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - COST_HISTORY_MAX_DAYS);
  const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;
  for (const key of Object.keys(costHistory.days)) {
    if (key < cutoffKey) delete costHistory.days[key];
  }
}

export function recordCostEntry(model, inputTokens, outputTokens, callCost) {
  const key = todayDateKey();
  if (!costHistory.days[key]) {
    costHistory.days[key] = { cost: 0, input: 0, output: 0, requests: 0, models: {} };
  }
  const day = costHistory.days[key];
  day.cost += callCost;
  day.input += inputTokens;
  day.output += outputTokens;
  day.requests += 1;
  const safeModel = sanitiseKey(model);
  if (!day.models[safeModel]) {
    day.models[safeModel] = { cost: 0, input: 0, output: 0, requests: 0 };
  }
  const m = day.models[safeModel];
  m.cost += callCost;
  m.input += inputTokens;
  m.output += outputTokens;
  m.requests += 1;
  persistCostHistory();
}

/**
 * Checks whether the daily spending cap (if configured) has been exceeded.
 * Returns { exceeded: boolean, cap: number|null, spent: number }.
 */
export function isDailyCapExceeded() {
  const capStr = deps.getSettingString(deps.getExtensionAPIRef(), deps.SETTINGS_KEYS.dailySpendingCap, "");
  if (!capStr) return { exceeded: false, cap: null, spent: 0 };
  const cap = parseFloat(capStr);
  if (isNaN(cap) || cap <= 0) return { exceeded: false, cap: null, spent: 0 };
  const today = todayDateKey();
  const spent = costHistory.days[today]?.cost || 0;
  return { exceeded: spent >= cap, cap, spent };
}

/**
 * Checks if any budget warning thresholds (50%, 80%, 100%) have been newly
 * crossed since the last check. Returns the highest newly-crossed threshold
 * as a fraction (0.5, 0.8, 1.0) or null if no new threshold was crossed.
 * Each threshold fires at most once per session-day.
 */
export function checkBudgetThresholds() {
  const capStr = deps.getSettingString(deps.getExtensionAPIRef(), deps.SETTINGS_KEYS.dailySpendingCap, "");
  if (!capStr) return null;
  const cap = parseFloat(capStr);
  if (isNaN(cap) || cap <= 0) return null;
  const today = todayDateKey();
  const spent = costHistory.days[today]?.cost || 0;
  const ratio = spent / cap;

  // Reset tracking if the day changed
  if (budgetWarningsFiredToday.dateKey !== today) {
    budgetWarningsFiredToday = { dateKey: today, firedThresholds: new Set() };
  }

  let highestNew = null;
  for (const threshold of BUDGET_WARNING_THRESHOLDS) {
    if (ratio >= threshold && !budgetWarningsFiredToday.firedThresholds.has(threshold)) {
      budgetWarningsFiredToday.firedThresholds.add(threshold);
      highestNew = threshold;
    }
  }
  return highestNew ? { threshold: highestNew, spent, cap, pct: Math.round(highestNew * 100) } : null;
}

export function getCostHistorySummary() {
  const today = todayDateKey();
  const todayData = costHistory.days[today] || { cost: 0, input: 0, output: 0, requests: 0, models: {} };

  // Last 7 days
  let week = { cost: 0, input: 0, output: 0, requests: 0 };
  const now = new Date();
  for (let i = 0; i < 7; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const entry = costHistory.days[k];
    if (entry) {
      week.cost += entry.cost;
      week.input += entry.input;
      week.output += entry.output;
      week.requests += entry.requests;
    }
  }

  // Last 30 days
  let month = { cost: 0, input: 0, output: 0, requests: 0 };
  for (let i = 0; i < 30; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const entry = costHistory.days[k];
    if (entry) {
      month.cost += entry.cost;
      month.input += entry.input;
      month.output += entry.output;
      month.requests += entry.requests;
    }
  }

  return { today: todayData, week, month };
}

// ── Audit Log ────────────────────────────────────────────────────────

/**
 * Persists a compact audit log entry for the completed agent run.
 * Writes to "Chief of Staff/Audit Log" with newest entries first.
 * Non-fatal — errors are swallowed so audit logging never breaks the agent flow.
 */
export async function persistAuditLogEntry(trace, userPrompt, options = {}) {
  try {
    if (!trace || !trace.startedAt) return;
    const pageTitle = "Chief of Staff/Audit Log";
    const pageUid = await deps.ensurePageUidByTitle(pageTitle);
    if (!pageUid) return;

    const { skillName = null } = options;

    const dateStr = deps.formatRoamDate(new Date(trace.startedAt));
    const durationSec = trace.finishedAt
      ? ((trace.finishedAt - trace.startedAt) / 1000).toFixed(1)
      : "?";
    const toolCalls = trace.toolCalls || [];
    const toolSummary = toolCalls.length > 0
      ? toolCalls.map(tc => {
          const dur = tc.durationMs ? ` (${(tc.durationMs / 1000).toFixed(1)}s)` : "";
          const err = tc.error ? " ❌" : "";
          return `${tc.name}${dur}${err}`;
        }).join(", ")
      : "none";
    // Advisor consultation accounting (Anthropic beta) — combine executor and advisor
    // tokens into the displayed total, and surface the advisor in the model label so
    // the Activity tab doesn't misattribute Opus cost to the executor.
    const advisorCalls = trace.advisorCalls || 0;
    const advisorInputTokens = trace.advisorInputTokens || 0;
    const advisorOutputTokens = trace.advisorOutputTokens || 0;
    const tokens = (trace.totalInputTokens || 0) + (trace.totalOutputTokens || 0)
      + advisorInputTokens + advisorOutputTokens;
    const baseModel = trace.model || "unknown";
    const modelLabel = (advisorCalls > 0 && trace.advisorModel)
      ? `${baseModel} + ${trace.advisorModel} advisor ×${advisorCalls}`
      : baseModel;
    const cost = typeof trace.cost === "number" ? `$${trace.cost.toFixed(4)}` : "";
    const outcome = trace.capExceeded ? "cap-exceeded"
      : trace.error ? `error: ${String(trace.error).slice(0, 80).replace(/\[\[/g, "⟦").replace(/\]\]/g, "⟧").replace(/\{\{/g, "⦃⦃").replace(/\}\}/g, "⦄⦄").replace(/\(\(/g, "⦅⦅").replace(/\)\)/g, "⦆⦆")}`
      : "success";
    const prompt = String(userPrompt || trace.promptPreview || "").slice(0, 120)
      .replace(/\[\[/g, "⟦").replace(/\]\]/g, "⟧")
      .replace(/\{\{/g, "⦃⦃").replace(/\}\}/g, "⦄⦄")
      .replace(/\(\(/g, "⦅⦅").replace(/\)\)/g, "⦆⦆");

    const skillLine = skillName ? `\nSkill: ${String(skillName).slice(0, 60)}` : "";
    const block = `[[${dateStr}]] **${modelLabel}** `
      + `(${trace.iterations || 0} iter, ${durationSec}s, ${tokens} tok${cost ? ", " + cost : ""}) `
      + `— ${outcome}`
      + skillLine
      + `\nPrompt: ${prompt}`
      + `\nTools: ${toolSummary}`;

    const insertOrder = deps.getFirstContentOrder ? deps.getFirstContentOrder(pageUid) : 0;
    await deps.createRoamBlock(pageUid, block, insertOrder);
    deps.debugLog("[Chief flow] Audit log entry persisted");

    // Non-blocking trim of old entries (runs in background)
    trimAuditLog().catch(() => {});
  } catch (err) {
    deps.debugLog("[Chief flow] Audit log write failed (non-fatal):", err?.message || err);
  }
}

/**
 * Trims audit log entries older than the configured retention period.
 * Parses the Roam date reference at the start of each block (e.g. [[March 1st, 2026]])
 * and deletes blocks whose date is older than `retentionDays` from today.
 * Non-fatal — errors are swallowed so trimming never breaks the agent flow.
 */
async function trimAuditLog() {
  if (auditTrimInFlight) return;
  try {
    const retentionStr = deps.getSettingString(deps.getExtensionAPIRef(), deps.SETTINGS_KEYS.auditLogRetentionDays, "");
    const retentionDays = parseInt(retentionStr, 10);
    if (!retentionDays || retentionDays <= 0) return; // disabled or invalid

    auditTrimInFlight = true;
    const pageTitle = "Chief of Staff/Audit Log";
    const api = deps.getRoamAlphaApi();
    const safeTitle = deps.escapeForDatalog(pageTitle);
    const allBlocks = api.q(`
      [:find ?uid ?str
       :where [?p :node/title "${safeTitle}"]
              [?p :block/children ?b]
              [?b :block/string ?str]
              [?b :block/uid ?uid]]
    `);
    if (!allBlocks || allBlocks.length === 0) return;

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - retentionDays);
    cutoff.setHours(0, 0, 0, 0);

    // Parse "[[Month Dayth, Year]]" from the start of block text
    const MONTHS = {
      january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
      july: 6, august: 7, september: 8, october: 9, november: 10, december: 11
    };
    const dateRefRe = /^\[\[(\w+)\s+(\d+)\w{0,2},\s*(\d{4})\]\]/;

    // First pass: collect UIDs to delete (no API calls)
    const toDelete = [];
    for (const [uid, str] of allBlocks) {
      const m = String(str).match(dateRefRe);
      if (!m) continue;
      const monthIdx = MONTHS[m[1].toLowerCase()];
      if (monthIdx === undefined) continue;
      const blockDate = new Date(parseInt(m[3], 10), monthIdx, parseInt(m[2], 10));
      if (blockDate < cutoff) {
        toDelete.push(uid);
      }
    }

    // Second pass: delete serially with a yield every AUDIT_TRIM_BATCH_SIZE
    // deletes. Serial writes avoid tripping Roam's internal write-lock race
    // conditions; the periodic yield prevents blocking the UI thread.
    let deleted = 0;
    for (let i = 0; i < toDelete.length; i++) {
      try {
        await api.deleteBlock({ block: { uid: toDelete[i] } });
        deleted++;
      } catch (_) { /* individual delete failure is non-fatal */ }
      if ((i + 1) % AUDIT_TRIM_BATCH_SIZE === 0 && i + 1 < toDelete.length) {
        await new Promise(resolve => setTimeout(resolve, AUDIT_TRIM_BATCH_YIELD_MS));
      }
    }
    if (deleted > 0) {
      deps.debugLog(`[Audit Log] Trimmed ${deleted} entries older than ${retentionDays} days`);
    }
  } catch (err) {
    deps.debugLog("[Audit Log] Trim failed (non-fatal):", err?.message || err);
  } finally {
    auditTrimInFlight = false;
  }
}

// ── Usage Stats Accumulator ──────────────────────────────────────────

export function loadUsageStats(extensionAPI) {
  const raw = extensionAPI?.settings?.get?.(deps.SETTINGS_KEYS.usageStats);
  if (raw && typeof raw === "object" && raw.days) {
    usageStats = raw;
  } else {
    usageStats = { days: {} };
  }
}

function pruneUsageStats() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - USAGE_STATS_MAX_DAYS);
  const cutoffKey = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, "0")}-${String(cutoff.getDate()).padStart(2, "0")}`;
  for (const key of Object.keys(usageStats.days)) {
    if (key < cutoffKey) delete usageStats.days[key];
  }
}

function persistUsageStatsSettings(extensionAPI) {
  const api = extensionAPI || deps.getExtensionAPIRef();
  if (usageStatsPersistTimeoutId) {
    window.clearTimeout(usageStatsPersistTimeoutId);
  }
  usageStatsPersistTimeoutId = window.setTimeout(() => {
    usageStatsPersistTimeoutId = null;
    pruneUsageStats();
    api?.settings?.set?.(deps.SETTINGS_KEYS.usageStats, usageStats);
  }, 3000);
}

function ensureTodayUsageStats() {
  const key = todayDateKey();
  if (!usageStats.days[key]) {
    usageStats.days[key] = {
      agentRuns: 0, toolCalls: {}, approvalsGranted: 0, approvalsDenied: 0,
      injectionWarnings: 0, claimedActionFires: 0, tierEscalations: 0, memoryWriteBlocks: 0,
      evalRuns: 0, evalAvgScore: 0,
      intentClassifications: 0, intentSkipped: 0, intentAutoProceeded: 0,
      intentConfirmations: 0, intentClarifications: 0, intentUserOverrides: 0,
      toolUsage: {}, scopeUsage: {},
      guardOutcomes: {
        claimedAction: { truePositive: 0, falsePositive: 0 },
        fabrication: { truePositive: 0, falsePositive: 0 },
        liveData: { truePositive: 0, falsePositive: 0 },
        gathering: { truePositive: 0, falsePositive: 0 }
      }
    };
  }
  // Backfill for day records created before toolUsage/scopeUsage existed.
  const day = usageStats.days[key];
  if (!day.toolUsage) day.toolUsage = {};
  if (!day.scopeUsage) day.scopeUsage = {};
  return day;
}

// Cardinality caps for the new detailed tool/scope tracking.
// toolUsage is naturally bounded by the tool catalogue; scopeUsage can fan out
// per page UID, so it gets a larger budget.
const TOOL_USAGE_MAX_KEYS = 200;
const SCOPE_USAGE_MAX_KEYS = 300;
const toolUsageCapWarned = new Set(); // one-shot debug log per day
const scopeUsageCapWarned = new Set();

function nowIso() {
  return new Date().toISOString();
}

function upsertScopeUsage(day, approvalKey, scopeType) {
  if (!approvalKey) return null;
  const safeKey = sanitiseKey(approvalKey);
  let entry = day.scopeUsage[safeKey];
  if (entry) {
    entry.lastSeenAt = nowIso();
    // Defensive: preserve scopeType if caller didn't supply one
    if (!entry.scopeType && scopeType) entry.scopeType = scopeType;
    return entry;
  }
  if (Object.keys(day.scopeUsage).length >= SCOPE_USAGE_MAX_KEYS) {
    const capKey = todayDateKey();
    if (!scopeUsageCapWarned.has(capKey)) {
      scopeUsageCapWarned.add(capKey);
      deps.debugLog?.("[Usage] scopeUsage cap reached; dropping new keys for", capKey);
    }
    return null;
  }
  entry = {
    scopeType: scopeType || "tool",
    granted: 0, denied: 0, cached: 0,
    callsSuccess: 0, callsFailure: 0,
    firstSeenAt: nowIso(), lastSeenAt: nowIso(),
  };
  day.scopeUsage[safeKey] = entry;
  return entry;
}

/**
 * Records per-call tool usage and per-scope approval events for roadmap #82
 * Phase 1. Additive to the existing toolCalls/approvalsGranted counters.
 *
 * Accepts a discriminated union:
 *   { kind: "scopeEvent", approvalKey, scopeType, event: "granted"|"denied"|"cached" }
 *   { kind: "outcome", resolvedName, approvalKeys, scopeType, success, durationMs }
 *
 * Logging must never break dispatch — all paths swallow errors silently.
 */
export function recordToolUsage(entry) {
  if (!entry || typeof entry !== "object") return;
  try {
    const day = ensureTodayUsageStats();
    if (entry.kind === "scopeEvent") {
      const { approvalKey, scopeType, event } = entry;
      if (!approvalKey || !event) return;
      const scope = upsertScopeUsage(day, approvalKey, scopeType);
      if (!scope) { persistUsageStatsSettings(); return; }
      if (event === "granted") scope.granted += 1;
      else if (event === "denied") scope.denied += 1;
      else if (event === "cached") scope.cached += 1;
      persistUsageStatsSettings();
      return;
    }
    if (entry.kind === "outcome") {
      const { resolvedName, approvalKeys, scopeType, success, durationMs } = entry;
      if (resolvedName) {
        const safeName = sanitiseKey(resolvedName);
        let bucket = day.toolUsage[safeName];
        if (!bucket && Object.keys(day.toolUsage).length >= TOOL_USAGE_MAX_KEYS) {
          const capKey = todayDateKey();
          if (!toolUsageCapWarned.has(capKey)) {
            toolUsageCapWarned.add(capKey);
            deps.debugLog?.("[Usage] toolUsage cap reached; dropping new keys for", capKey);
          }
        } else {
          if (!bucket) {
            bucket = {
              total: 0, success: 0, failure: 0, totalDurationMs: 0,
              firstUsedAt: nowIso(), lastUsedAt: nowIso(),
            };
            day.toolUsage[safeName] = bucket;
          }
          bucket.total += 1;
          if (success) bucket.success += 1; else bucket.failure += 1;
          if (Number.isFinite(durationMs)) bucket.totalDurationMs += durationMs;
          bucket.lastUsedAt = nowIso();
        }
      }
      // Attribute the outcome to each scope key the call ran under.
      if (scopeType && scopeType !== "none" && Array.isArray(approvalKeys)) {
        for (const key of approvalKeys) {
          const scope = upsertScopeUsage(day, key, scopeType);
          if (!scope) continue;
          if (success) scope.callsSuccess += 1;
          else scope.callsFailure += 1;
        }
      }
      persistUsageStatsSettings();
    }
  } catch (_) { /* never break dispatch */ }
}

export function recordUsageStat(stat, detail) {
  const day = ensureTodayUsageStats();
  if (stat === "toolCall" && detail) {
    // Cap distinct tool names per day to prevent unbounded key growth from dynamic MCP tool names
    const safeName = sanitiseKey(detail);
    if (Object.keys(day.toolCalls).length < 200 || safeName in day.toolCalls) {
      day.toolCalls[safeName] = (day.toolCalls[safeName] || 0) + 1;
    }
  } else if (stat in day && typeof day[stat] === "number") {
    day[stat] += 1;
  }
  persistUsageStatsSettings();
}

/**
 * Records whether a guard firing was a true positive or false positive.
 * Called by eval-judge.js after scoring: all eval scores >= 4 → FP, any score <= 2 → TP.
 * @param {string} guardName - "claimedAction"|"fabrication"|"liveData"|"gathering"
 * @param {"tp"|"fp"} outcome
 */
export function recordGuardOutcome(guardName, outcome) {
  const day = ensureTodayUsageStats();
  if (!day.guardOutcomes) {
    day.guardOutcomes = {
      claimedAction: { truePositive: 0, falsePositive: 0 },
      fabrication: { truePositive: 0, falsePositive: 0 },
      liveData: { truePositive: 0, falsePositive: 0 },
      gathering: { truePositive: 0, falsePositive: 0 }
    };
  }
  if (!day.guardOutcomes[guardName]) {
    day.guardOutcomes[guardName] = { truePositive: 0, falsePositive: 0 };
  }
  if (outcome === "tp") day.guardOutcomes[guardName].truePositive += 1;
  else if (outcome === "fp") day.guardOutcomes[guardName].falsePositive += 1;
  persistUsageStatsSettings();
}

/**
 * Records a completed eval run and updates the running average score.
 * @param {number} avgScore - Average of the three dimension scores (1-5)
 */
export function recordEvalRun(avgScore) {
  const day = ensureTodayUsageStats();
  if (typeof day.evalRuns !== "number") { day.evalRuns = 0; day.evalAvgScore = 0; }
  const prevTotal = day.evalRuns * day.evalAvgScore;
  day.evalRuns += 1;
  day.evalAvgScore = (prevTotal + avgScore) / day.evalRuns;
  persistUsageStatsSettings();
}

/**
 * Records tool token usage snapshot for a single agent run.
 * Accumulates daily averages and per-source breakdown so we can track
 * whether optimizations (description trimming, mini-tier filtering) are
 * actually reducing tool token overhead over time.
 * @param {{ toolsChars: number, toolPct: number, toolCount: number, breakdown: object }} snapshot
 */
export function recordToolTokenSnapshot(snapshot) {
  const day = ensureTodayUsageStats();
  if (!day.toolTokens) {
    day.toolTokens = { runs: 0, avgChars: 0, avgPct: 0, avgToolCount: 0, breakdown: {} };
  }
  const tt = day.toolTokens;
  const prevCharsTotal = tt.runs * tt.avgChars;
  const prevPctTotal = tt.runs * tt.avgPct;
  const prevCountTotal = tt.runs * tt.avgToolCount;
  tt.runs += 1;
  tt.avgChars = Math.round((prevCharsTotal + snapshot.toolsChars) / tt.runs);
  tt.avgPct = Math.round((prevPctTotal + snapshot.toolPct) / tt.runs);
  tt.avgToolCount = Math.round((prevCountTotal + snapshot.toolCount) / tt.runs);
  // Accumulate per-source breakdown (running averages)
  if (snapshot.breakdown) {
    for (const [source, chars] of Object.entries(snapshot.breakdown)) {
      if (source === "total") continue;
      const prev = tt.breakdown[source] || 0;
      tt.breakdown[source] = Math.round((prev * (tt.runs - 1) + chars) / tt.runs);
    }
  }
  persistUsageStatsSettings();
}

function formatGuardOutcomeSummary(guardOutcomes) {
  if (!guardOutcomes) return "";
  const parts = [];
  for (const [name, counts] of Object.entries(guardOutcomes)) {
    const total = (counts.truePositive || 0) + (counts.falsePositive || 0);
    if (total === 0) continue;
    const tp = counts.truePositive || 0;
    const pct = ((tp / total) * 100).toFixed(0);
    parts.push(`${name} ${tp}/${total} TP (${pct}%)`);
  }
  return parts.length > 0 ? ` | guard accuracy: ${parts.join(", ")}` : "";
}

export async function persistUsageStatsPage() {
  if (deps.getUnloadInProgress()) return;
  try {
    const key = todayDateKey();
    const day = usageStats.days[key];
    if (!day || !day.agentRuns) return;

    const pageTitle = "Chief of Staff/Usage Stats";
    const pageUid = await deps.ensurePageUidByTitle(pageTitle);
    if (!pageUid) return;

    const dateStr = deps.formatRoamDate(new Date());
    const totalToolCalls = Object.values(day.toolCalls).reduce((s, c) => s + c, 0);
    const topTools = Object.entries(day.toolCalls)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([name, count]) => `${name} (${count})`)
      .join(", ");
    const totalApprovals = day.approvalsGranted + day.approvalsDenied;
    const approvalStr = totalApprovals > 0
      ? `${day.approvalsGranted}/${totalApprovals}`
      : "0";

    // Eval summary
    const evalStr = day.evalRuns > 0
      ? ` | eval: ${day.evalRuns} runs, avg ${day.evalAvgScore.toFixed(1)}/5`
      : "";
    // Guard accuracy summary
    const guardStr = formatGuardOutcomeSummary(day.guardOutcomes);

    // Tool token overhead summary
    const toolTokenStr = day.toolTokens && day.toolTokens.runs > 0
      ? ` | tools: avg ${Math.round(day.toolTokens.avgChars / 1000)}k chars (${day.toolTokens.avgPct}% of input), ${day.toolTokens.avgToolCount} tools`
      : "";

    const block = `[[${dateStr}]] — ${day.agentRuns} runs | ${totalToolCalls} tool calls`
      + ` | approvals ${approvalStr}`
      + ` | ${day.injectionWarnings} injection warn`
      + ` | ${day.claimedActionFires} claimed-action`
      + ` | ${day.tierEscalations} escalations`
      + ` | ${day.memoryWriteBlocks} mem blocks`
      + evalStr + guardStr + toolTokenStr
      + (topTools ? ` | Top: ${topTools}` : "");

    // Find existing block for today — update in place to avoid duplicates
    const safeDateRef = deps.escapeForDatalog(`[[${dateStr}]]`);
    const existingUid = await deps.queryRoamDatalog(
      `[:find ?uid . :where [?p :node/title "${deps.escapeForDatalog(pageTitle)}"] [?b :block/page ?p] [?b :block/string ?s] [(clojure.string/includes? ?s "${safeDateRef}")] [?b :block/uid ?uid]]`
    );
    const api = deps.getRoamAlphaApi();
    if (existingUid) {
      await api.updateBlock({ block: { uid: existingUid, string: block } });
    } else {
      const insertOrder = deps.getFirstContentOrder ? deps.getFirstContentOrder(pageUid) : 0;
      await deps.createRoamBlock(pageUid, block, insertOrder);
    }
    deps.debugLog("[Chief flow] Usage stats page updated");
  } catch (err) {
    deps.debugLog("[Chief flow] Usage stats page write failed (non-fatal):", err?.message || err);
  }
}

// ── Flush (for onunload) ─────────────────────────────────────────────

/**
 * Synchronously flushes any pending debounced writes for cost history and usage stats.
 * Called from onunload() to ensure data is persisted before extension teardown.
 */
export function flushUsageTracking(api) {
  if (costHistoryPersistTimeoutId) {
    window.clearTimeout(costHistoryPersistTimeoutId);
    costHistoryPersistTimeoutId = null;
    pruneCostHistory();
    api?.settings?.set?.(deps.SETTINGS_KEYS.costHistory, costHistory);
  }
  if (usageStatsPersistTimeoutId) {
    window.clearTimeout(usageStatsPersistTimeoutId);
    usageStatsPersistTimeoutId = null;
    pruneUsageStats();
    api?.settings?.set?.(deps.SETTINGS_KEYS.usageStats, usageStats);
  }
}

// ── DI Initialiser ───────────────────────────────────────────────────

export function initUsageTracking(injected) {
  deps = injected;
}
