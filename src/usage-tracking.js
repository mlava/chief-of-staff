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

// ── Accessors ────────────────────────────────────────────────────────

export function getSessionTokenUsage() {
  return sessionTokenUsage;
}

export function accumulateSessionTokens(inputTokens, outputTokens, callCost) {
  sessionTokenUsage.totalInputTokens += inputTokens;
  sessionTokenUsage.totalOutputTokens += outputTokens;
  sessionTokenUsage.totalRequests += 1;
  sessionTokenUsage.totalCostUsd += callCost;
}

export function resetSessionTokenUsage() {
  sessionTokenUsage.totalInputTokens = 0;
  sessionTokenUsage.totalOutputTokens = 0;
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
  if (!day.models[model]) {
    day.models[model] = { cost: 0, input: 0, output: 0, requests: 0 };
  }
  const m = day.models[model];
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
export async function persistAuditLogEntry(trace, userPrompt) {
  try {
    if (!trace || !trace.startedAt) return;
    const pageTitle = "Chief of Staff/Audit Log";
    const pageUid = await deps.ensurePageUidByTitle(pageTitle);
    if (!pageUid) return;

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
    const tokens = (trace.totalInputTokens || 0) + (trace.totalOutputTokens || 0);
    const cost = typeof trace.cost === "number" ? `$${trace.cost.toFixed(4)}` : "";
    const outcome = trace.capExceeded ? "cap-exceeded"
      : trace.error ? `error: ${String(trace.error).slice(0, 80)}`
      : "success";
    const prompt = String(userPrompt || trace.promptPreview || "").slice(0, 120);

    const block = `[[${dateStr}]] **${trace.model || "unknown"}** `
      + `(${trace.iterations || 0} iter, ${durationSec}s, ${tokens} tok${cost ? ", " + cost : ""}) `
      + `— ${outcome}`
      + `\nPrompt: ${prompt}`
      + `\nTools: ${toolSummary}`;

    await deps.createRoamBlock(pageUid, block, "first");
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
    const allBlocks = api.q(`
      [:find ?uid ?str
       :where [?p :node/title "${pageTitle}"]
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

    let deleted = 0;
    for (const [uid, str] of allBlocks) {
      const m = String(str).match(dateRefRe);
      if (!m) continue;
      const monthIdx = MONTHS[m[1].toLowerCase()];
      if (monthIdx === undefined) continue;
      const blockDate = new Date(parseInt(m[3], 10), monthIdx, parseInt(m[2], 10));
      if (blockDate < cutoff) {
        await api.deleteBlock({ block: { uid } });
        deleted++;
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
      injectionWarnings: 0, claimedActionFires: 0, tierEscalations: 0, memoryWriteBlocks: 0
    };
  }
  return usageStats.days[key];
}

export function recordUsageStat(stat, detail) {
  const day = ensureTodayUsageStats();
  if (stat === "toolCall" && detail) {
    day.toolCalls[detail] = (day.toolCalls[detail] || 0) + 1;
  } else if (stat in day && typeof day[stat] === "number") {
    day[stat] += 1;
  }
  persistUsageStatsSettings();
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

    const block = `[[${dateStr}]] — ${day.agentRuns} runs | ${totalToolCalls} tool calls`
      + ` | approvals ${approvalStr}`
      + ` | ${day.injectionWarnings} injection warn`
      + ` | ${day.claimedActionFires} claimed-action`
      + ` | ${day.tierEscalations} escalations`
      + ` | ${day.memoryWriteBlocks} mem blocks`
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
      await deps.createRoamBlock(pageUid, block, "first");
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
