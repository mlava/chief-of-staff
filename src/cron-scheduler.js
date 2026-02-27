// ─── Cron Scheduler Module ──────────────────────────────────────────────────────
// Extracted from index.js. Leader election, tick loop, job persistence, COS tools,
// and system prompt builder. All external dependencies injected via initCronScheduler().
//
// NOTE: innerHTML usage in fireCronJob is safe — content is processed through
// renderMarkdownToSafeHtml (which escapes all input) and sanitizeChatDom (which
// strips any remaining unsafe attributes). This matches the existing pattern in
// chat-panel.js and index.js.

import { Cron } from "croner";

let deps = {};

// ─── Constants ─────────────────────────────────────────────────────────────────
const CRON_TICK_INTERVAL_MS = 60_000; // Check due jobs every 60 seconds
const CRON_LEADER_KEY = "chief-of-staff-cron-leader";
const CRON_LEADER_HEARTBEAT_MS = 30_000; // 30s heartbeat for multi-tab leader lock
const CRON_LEADER_STALE_MS = 90_000; // 90s without heartbeat = stale, claim leadership
const CRON_MAX_JOBS = 20; // Soft cap on total scheduled jobs
const CRON_MIN_INTERVAL_MINUTES = 5; // Minimum interval between job firings

// ─── Module-scoped state ───────────────────────────────────────────────────────
let cronTickIntervalId = null;
let cronLeaderHeartbeatId = null;
let cronLeaderTabId = null; // random string identifying this tab's leader claim
let cronStorageHandler = null; // "storage" event listener for cross-tab leader detection
let cronInitialTickTimeoutId = null; // initial 5s tick after scheduler start
let cronSchedulerRunning = false;
const cronRunningJobs = new Set(); // job IDs currently executing (prevent overlap)

// ─── DI Initialiser ────────────────────────────────────────────────────────────

export function initCronScheduler(injected) {
  deps = injected;
}

// ─── Cron Scheduler: Helpers ───────────────────────────────────────────────────

export function getDefaultBrowserTimezone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && typeof tz === "string") return tz;
  } catch { /* ignore */ }
  return "Australia/Melbourne";
}

function normaliseCronJob(input) {
  if (!input || typeof input !== "object") return null;
  const id = String(input.id || "").trim();
  if (!id) return null;
  const type = ["cron", "interval", "once"].includes(input.type) ? input.type : "cron";
  return {
    id,
    name: String(input.name || id).trim().slice(0, 100),
    type,
    expression: type === "cron" ? String(input.expression || "").trim() : "",
    intervalMinutes: type === "interval" ? Math.max(CRON_MIN_INTERVAL_MINUTES, Math.round(Number(input.intervalMinutes) || 60)) : 0,
    timezone: String(input.timezone || getDefaultBrowserTimezone()).trim(),
    prompt: String(input.prompt || "").trim().slice(0, 2000),
    enabled: input.enabled !== false,
    createdAt: Number.isFinite(input.createdAt) ? input.createdAt : Date.now(),
    lastRun: Number.isFinite(input.lastRun) ? input.lastRun : 0,
    runCount: Number.isFinite(input.runCount) ? input.runCount : 0,
    runAt: type === "once" && Number.isFinite(input.runAt) ? input.runAt : 0,
    lastRunError: input.lastRunError ? String(input.lastRunError).slice(0, 200) : null
  };
}

export function loadCronJobs() {
  const extensionAPI = deps.getExtensionAPI();
  const raw = deps.getSettingArray(extensionAPI, deps.cronJobsSettingKey, []);
  return raw.map(normaliseCronJob).filter(Boolean);
}

function saveCronJobs(jobs) {
  const extensionAPI = deps.getExtensionAPI();
  const normalised = jobs.map(normaliseCronJob).filter(Boolean);
  extensionAPI?.settings?.set?.(deps.cronJobsSettingKey, normalised);
}

function generateCronJobId(name) {
  const base = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  if (!base) return `job-${Date.now()}`;
  return base;
}

function ensureUniqueCronJobId(id, existingJobs) {
  const ids = new Set(existingJobs.map(j => j.id));
  if (!ids.has(id)) return id;
  for (let i = 2; i <= 99; i++) {
    const candidate = `${id}-${i}`;
    if (!ids.has(candidate)) return candidate;
  }
  return `${id}-${Date.now()}`;
}

// ─── Cron Scheduler: Leader Election ───────────────────────────────────────────

function cronTryClaimLeadership() {
  try {
    const now = Date.now();
    const raw = localStorage.getItem(CRON_LEADER_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data.heartbeat && (now - data.heartbeat) < CRON_LEADER_STALE_MS) {
        // Another tab is the active leader — don't usurp
        if (data.tabId !== cronLeaderTabId) return false;
        // We are already the leader
        return true;
      }
    }
    // Claim leadership
    cronLeaderTabId = Math.random().toString(36).slice(2, 10);
    localStorage.setItem(CRON_LEADER_KEY, JSON.stringify({
      tabId: cronLeaderTabId,
      heartbeat: now
    }));
    // Re-read to detect race condition with another tab
    const check = JSON.parse(localStorage.getItem(CRON_LEADER_KEY) || "{}");
    if (check.tabId === cronLeaderTabId) {
      deps.debugLog("[Chief cron] Claimed leadership:", cronLeaderTabId);
      return true;
    }
    cronLeaderTabId = null;
    return false;
  } catch {
    // localStorage unavailable — assume leader (single-tab fallback)
    cronLeaderTabId = "fallback";
    return true;
  }
}

function cronIsLeader() {
  return cronLeaderTabId !== null;
}

function cronHeartbeat() {
  if (!cronIsLeader()) return;
  try {
    const raw = localStorage.getItem(CRON_LEADER_KEY);
    if (!raw) { cronLeaderTabId = null; return; }
    const data = JSON.parse(raw);
    if (data.tabId !== cronLeaderTabId) { cronLeaderTabId = null; return; }
    data.heartbeat = Date.now();
    localStorage.setItem(CRON_LEADER_KEY, JSON.stringify(data));
    // Re-verify after write to detect near-simultaneous claims
    const check = JSON.parse(localStorage.getItem(CRON_LEADER_KEY) || "{}");
    if (check.tabId !== cronLeaderTabId) { cronLeaderTabId = null; }
  } catch { /* ignore */ }
}

function cronReleaseLeadership() {
  try {
    const raw = localStorage.getItem(CRON_LEADER_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      // Only remove if we own it
      if (data.tabId === cronLeaderTabId) {
        localStorage.removeItem(CRON_LEADER_KEY);
      }
    }
  } catch { /* ignore */ }
  cronLeaderTabId = null;
}

// ─── Cron Scheduler: Tick Loop ─────────────────────────────────────────────────

function isCronJobDue(job, now) {
  if (!job.enabled) return false;
  const nowMs = now.getTime();

  if (job.type === "once") {
    if (job.lastRun > 0) return false; // already fired
    return job.runAt > 0 && nowMs >= job.runAt;
  }

  if (job.type === "interval") {
    if (!job.intervalMinutes || job.intervalMinutes < 1) return false;
    const intervalMs = job.intervalMinutes * 60_000;
    // If never run, due immediately (or after createdAt + interval)
    if (job.lastRun === 0) return (nowMs - job.createdAt) >= intervalMs;
    return (nowMs - job.lastRun) >= intervalMs;
  }

  if (job.type === "cron") {
    if (!job.expression) return false;
    try {
      const cron = new Cron(job.expression, { timezone: job.timezone || getDefaultBrowserTimezone() });
      // Find next occurrence after lastRun (or createdAt if never run)
      const since = job.lastRun > 0 ? new Date(job.lastRun) : new Date(job.createdAt);
      const nextDue = cron.nextRun(since);
      if (!nextDue) return false;
      return nextDue.getTime() <= nowMs;
    } catch (e) {
      deps.debugLog("[Chief cron] Invalid cron expression for job", job.id, ":", e?.message);
      return false;
    }
  }

  return false;
}

async function fireCronJob(job) {
  deps.debugLog("[Chief cron] Firing job:", job.id, job.name);
  const timeLabel = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

  // Show toast regardless of chat panel state
  deps.showInfoToast("Scheduled job", `Running: ${job.name}`);

  // Render in chat panel if open
  deps.refreshChatPanelElementRefs();
  let streamingEl = null;
  const streamChunks = [];
  let streamRenderPending = false;

  const msgsEl = deps.getChatPanelMessages();
  if (msgsEl) {
    // Header element
    const headerEl = document.createElement("div");
    headerEl.classList.add("chief-msg", "chief-msg--assistant", "chief-msg--scheduled");
    const headerInner = document.createElement("div");
    headerInner.classList.add("chief-msg-scheduled-header");
    headerInner.textContent = `Scheduled: ${job.name} (${timeLabel})`;
    headerEl.appendChild(headerInner);
    msgsEl.appendChild(headerEl);

    // Streaming response element
    streamingEl = document.createElement("div");
    streamingEl.classList.add("chief-msg", "chief-msg--assistant", "chief-msg--scheduled");
    streamingEl.textContent = "";
    msgsEl.appendChild(streamingEl);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function flushCronStreamRender() {
    streamRenderPending = false;
    if (!streamingEl || !document.body.contains(streamingEl)) return;
    const joined = streamChunks.join("");
    const capped = joined.length > 60000 ? joined.slice(joined.length - 60000) : joined;
    // NOTE: renderMarkdownToSafeHtml already escapes all content; sanitizeChatDom deferred to final render
    streamingEl.textContent = "";
    const rendered = deps.renderMarkdownToSafeHtml(capped);
    // Safe: rendered output is from renderMarkdownToSafeHtml which escapes all user input
    streamingEl.insertAdjacentHTML("afterbegin", rendered);
    deps.refreshChatPanelElementRefs();
    const scrollEl = deps.getChatPanelMessages();
    if (scrollEl) scrollEl.scrollTop = scrollEl.scrollHeight;
  }

  try {
    const result = await deps.askChiefOfStaff(job.prompt, {
      suppressToasts: true,
      onTextChunk: (chunk) => {
        if (!streamingEl) return;
        streamChunks.push(chunk);
        if (!streamRenderPending) {
          streamRenderPending = true;
          requestAnimationFrame(flushCronStreamRender);
        }
      }
    });
    const responseText = String(result?.text || "").trim().replace(/\[Key reference:[^\]]*\]\s*/g, "").trim() || "No response generated.";

    if (streamingEl && document.body.contains(streamingEl)) {
      // Safe: renderMarkdownToSafeHtml escapes all input; sanitizeChatDom strips unsafe attrs
      const safeHtml = deps.renderMarkdownToSafeHtml(responseText);
      streamingEl.textContent = "";
      streamingEl.insertAdjacentHTML("afterbegin", safeHtml);
      deps.sanitizeChatDom(streamingEl);
      const trace = typeof deps.getLastAgentRunTrace === "function" ? deps.getLastAgentRunTrace() : null;
      if (typeof deps.addModelIndicator === "function") deps.addModelIndicator(streamingEl, trace?.model);
      deps.addSaveToDailyPageButton(streamingEl, `[Scheduled: ${job.name}] ${job.prompt}`, responseText);
    }
    deps.appendChatPanelHistory("assistant", `[Scheduled: ${job.name}]\n${responseText}`);
    deps.updateChatPanelCostIndicator();
    return null; // no error
  } catch (error) {
    const errorText = deps.getUserFacingLlmErrorMessage(error, "Scheduled job");
    if (streamingEl && document.body.contains(streamingEl)) {
      // Safe: renderMarkdownToSafeHtml escapes all input; sanitizeChatDom strips unsafe attrs
      const safeErrorHtml = deps.renderMarkdownToSafeHtml(`Error: ${errorText}`);
      streamingEl.textContent = "";
      streamingEl.insertAdjacentHTML("afterbegin", safeErrorHtml);
      deps.sanitizeChatDom(streamingEl);
    }
    deps.appendChatPanelHistory("assistant", `[Scheduled: ${job.name}] Error: ${errorText}`);
    deps.showErrorToast("Scheduled job failed", `${job.name}: ${errorText}`);
    return errorText;
  }
}

async function cronTick() {
  if (!cronIsLeader()) {
    // Passive tab — try to claim if leader is stale
    cronTryClaimLeadership();
    if (!cronIsLeader()) return;
  }

  // Guard: don't fire if agent is already running
  if (deps.getChatPanelIsSending() || deps.getActiveAgentAbortController()) {
    deps.debugLog("[Chief cron] Skipping tick — agent loop in progress");
    return;
  }
  if (deps.isUnloadInProgress()) return;

  const now = new Date();
  const jobs = loadCronJobs();
  const dueJobs = jobs.filter(j => isCronJobDue(j, now) && !cronRunningJobs.has(j.id));

  if (!dueJobs.length) return;

  // Re-verify leadership right before executing (belt-and-suspenders for TOCTOU).
  // Read-only check first — avoids a write that could itself race with another tab.
  try {
    const leaderRaw = localStorage.getItem(CRON_LEADER_KEY);
    if (leaderRaw) {
      const leaderData = JSON.parse(leaderRaw);
      if (leaderData.tabId !== cronLeaderTabId) { cronLeaderTabId = null; return; }
    }
  } catch { /* ignore — fall through to heartbeat */ }
  cronHeartbeat();
  if (!cronIsLeader()) return;

  deps.debugLog("[Chief cron] Due jobs:", dueJobs.map(j => j.id));

  // Fire sequentially to avoid concurrent agent loops
  for (const job of dueJobs) {
    if (deps.isUnloadInProgress()) break;
    if (deps.getChatPanelIsSending() || deps.getActiveAgentAbortController()) {
      deps.debugLog("[Chief cron] Deferring remaining due jobs — agent loop started during execution");
      break;
    }

    cronRunningJobs.add(job.id);
    try {
      const errorText = await fireCronJob(job);

      // Update lastRun and runCount (re-read to avoid stale writes)
      const freshJobs = loadCronJobs();
      const idx = freshJobs.findIndex(j => j.id === job.id);
      if (idx >= 0) {
        freshJobs[idx].lastRun = Date.now();
        freshJobs[idx].runCount = (freshJobs[idx].runCount || 0) + 1;
        freshJobs[idx].lastRunError = errorText || null;
        // Disable one-shot jobs after execution
        if (job.type === "once") freshJobs[idx].enabled = false;
        saveCronJobs(freshJobs);
      }
    } finally {
      cronRunningJobs.delete(job.id);
    }
  }
}

export function startCronScheduler() {
  if (cronSchedulerRunning) return;
  cronSchedulerRunning = true;

  cronTryClaimLeadership();

  // Cross-tab leader detection: if another tab writes to our key, check immediately.
  // This closes the TOCTOU window — even if two tabs briefly both claim leadership,
  // the loser's storage event fires before the next tick executes any jobs.
  cronStorageHandler = (event) => {
    if (event.key !== CRON_LEADER_KEY || !cronLeaderTabId) return;
    try {
      const data = event.newValue ? JSON.parse(event.newValue) : null;
      if (!data || data.tabId !== cronLeaderTabId) {
        deps.debugLog("[Chief cron] Leadership lost (storage event from another tab)");
        cronLeaderTabId = null;
      }
    } catch { /* ignore */ }
  };
  window.addEventListener("storage", cronStorageHandler);

  // Heartbeat: maintain leadership or try to claim if leader is stale
  cronLeaderHeartbeatId = window.setInterval(() => {
    if (cronIsLeader()) cronHeartbeat();
    else cronTryClaimLeadership();
  }, CRON_LEADER_HEARTBEAT_MS);

  // Tick loop: check due jobs every 60 seconds
  cronTickIntervalId = window.setInterval(() => cronTick(), CRON_TICK_INTERVAL_MS);

  // Initial tick after a short delay (let extension finish loading, catch missed jobs).
  // Random jitter (0–5s) reduces the chance of two tabs racing to claim leadership
  // and both executing the same cron jobs during the overlap window.
  const cronInitialJitterMs = Math.floor(Math.random() * 5000);
  cronInitialTickTimeoutId = window.setTimeout(() => {
    cronInitialTickTimeoutId = null;
    if (cronSchedulerRunning && !deps.isUnloadInProgress()) cronTick();
  }, 5000 + cronInitialJitterMs);

  deps.debugLog("[Chief cron] Scheduler started, leader:", cronIsLeader());
}

export function stopCronScheduler() {
  cronSchedulerRunning = false;
  if (cronInitialTickTimeoutId) {
    window.clearTimeout(cronInitialTickTimeoutId);
    cronInitialTickTimeoutId = null;
  }
  if (cronStorageHandler) {
    window.removeEventListener("storage", cronStorageHandler);
    cronStorageHandler = null;
  }
  if (cronTickIntervalId) {
    window.clearInterval(cronTickIntervalId);
    cronTickIntervalId = null;
  }
  if (cronLeaderHeartbeatId) {
    window.clearInterval(cronLeaderHeartbeatId);
    cronLeaderHeartbeatId = null;
  }
  cronReleaseLeadership();
  cronRunningJobs.clear();
  deps.debugLog("[Chief cron] Scheduler stopped");
}

// ─── Cron Scheduler: COS Tools ─────────────────────────────────────────────────

export function getCronTools() {
  return [
    {
      name: "cos_cron_list",
      isMutating: false,
      description: "List all scheduled cron jobs with their status, schedule, and next run time.",
      input_schema: {
        type: "object",
        properties: {
          enabled_only: { type: "boolean", description: "If true, only return enabled jobs." }
        }
      },
      execute: async ({ enabled_only } = {}) => {
        const jobs = loadCronJobs();
        const filtered = enabled_only ? jobs.filter(j => j.enabled) : jobs;
        return {
          jobs: filtered.map(j => {
            let nextRun = null;
            try {
              if (j.type === "cron" && j.expression && j.enabled) {
                const cron = new Cron(j.expression, { timezone: j.timezone || getDefaultBrowserTimezone() });
                const next = cron.nextRun();
                if (next) nextRun = next.toISOString();
              } else if (j.type === "interval" && j.enabled) {
                const base = j.lastRun > 0 ? j.lastRun : j.createdAt;
                nextRun = new Date(base + j.intervalMinutes * 60_000).toISOString();
              } else if (j.type === "once" && j.runAt && j.lastRun === 0) {
                nextRun = new Date(j.runAt).toISOString();
              }
            } catch { /* ignore */ }
            return {
              id: j.id,
              name: j.name,
              type: j.type,
              expression: j.expression || undefined,
              intervalMinutes: j.intervalMinutes || undefined,
              timezone: j.timezone,
              prompt: j.prompt,
              enabled: j.enabled,
              lastRun: j.lastRun ? new Date(j.lastRun).toISOString() : null,
              lastRunError: j.lastRunError || null,
              nextRun,
              runCount: j.runCount
            };
          }),
          total: filtered.length
        };
      }
    },
    {
      name: "cos_cron_create",
      isMutating: true,
      description: "Create a new scheduled job. Types: 'cron' (5-field expression with timezone), 'interval' (every N minutes), 'once' (one-shot at a specific time). The job prompt is sent to Chief of Staff as if the user typed it.",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Human-readable job name." },
          type: { type: "string", enum: ["cron", "interval", "once"], description: "Schedule type." },
          cron: { type: "string", description: "5-field cron expression (required for type 'cron'). E.g. '0 8 * * 1-5' for weekdays at 08:00." },
          interval_minutes: { type: "number", description: "Interval in minutes (required for type 'interval')." },
          run_at: { type: "string", description: "ISO 8601 datetime for one-shot execution (required for type 'once')." },
          timezone: { type: "string", description: "IANA timezone. Default: auto-detected from browser." },
          prompt: { type: "string", description: "The instruction to send to Chief of Staff when the job fires." }
        },
        required: ["name", "type", "prompt"]
      },
      execute: async ({ name, type, cron: cronExpr, interval_minutes, run_at, timezone, prompt } = {}) => {
        if (!name || !type || !prompt) return { error: "name, type, and prompt are required." };

        const jobs = loadCronJobs();
        if (jobs.length >= CRON_MAX_JOBS) return { error: `Maximum ${CRON_MAX_JOBS} scheduled jobs reached. Delete unused jobs first.` };

        // Validate cron expression
        if (type === "cron") {
          if (!cronExpr) return { error: "cron expression is required for type 'cron'." };
          try {
            const parsed = new Cron(cronExpr);
            const next1 = parsed.nextRun();
            const next2 = next1 ? parsed.nextRun(next1) : null;
            if (next1 && next2 && (next2 - next1) < CRON_MIN_INTERVAL_MINUTES * 60_000) {
              return { error: `Cron expression fires too frequently (every ${Math.round((next2 - next1) / 60_000)}m). Minimum interval is ${CRON_MIN_INTERVAL_MINUTES} minutes.` };
            }
          } catch (e) {
            return { error: `Invalid cron expression "${cronExpr}": ${e?.message || "parse error"}` };
          }
        }
        if (type === "interval" && (!interval_minutes || interval_minutes < CRON_MIN_INTERVAL_MINUTES)) {
          return { error: `interval_minutes must be at least ${CRON_MIN_INTERVAL_MINUTES}.` };
        }
        if (type === "once" && !run_at) {
          return { error: "run_at (ISO 8601 datetime) is required for type 'once'." };
        }

        const baseId = generateCronJobId(name);
        const id = ensureUniqueCronJobId(baseId, jobs);
        const tz = timezone || getDefaultBrowserTimezone();

        const newJob = normaliseCronJob({
          id,
          name,
          type,
          expression: cronExpr || "",
          intervalMinutes: interval_minutes || 0,
          timezone: tz,
          prompt,
          enabled: true,
          createdAt: Date.now(),
          lastRun: 0,
          runCount: 0,
          runAt: type === "once" && run_at ? new Date(run_at).getTime() : 0
        });

        if (!newJob) return { error: "Failed to create job — invalid parameters." };

        jobs.push(newJob);
        saveCronJobs(jobs);

        // Compute next run for confirmation
        let nextRun = null;
        try {
          if (type === "cron" && cronExpr) nextRun = new Cron(cronExpr, { timezone: tz }).nextRun()?.toISOString();
          else if (type === "interval") nextRun = new Date(Date.now() + (interval_minutes || 60) * 60_000).toISOString();
          else if (type === "once" && run_at) nextRun = new Date(run_at).toISOString();
        } catch { /* ignore */ }

        return { created: true, id: newJob.id, name: newJob.name, type: newJob.type, nextRun, timezone: tz };
      }
    },
    {
      name: "cos_cron_update",
      isMutating: true,
      description: "Update an existing scheduled job. Pass the job ID and any fields to change (name, cron, interval_minutes, timezone, prompt, enabled).",
      input_schema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Job ID to update." },
          name: { type: "string", description: "New display name." },
          cron: { type: "string", description: "New cron expression (for cron-type jobs)." },
          interval_minutes: { type: "number", description: "New interval in minutes (for interval-type jobs)." },
          timezone: { type: "string", description: "New IANA timezone." },
          prompt: { type: "string", description: "New prompt text." },
          enabled: { type: "boolean", description: "Enable or disable the job." }
        },
        required: ["id"]
      },
      execute: async ({ id, name, cron: cronExpr, interval_minutes, timezone, prompt, enabled } = {}) => {
        if (!id) return { error: "id is required." };
        const jobs = loadCronJobs();
        const idx = jobs.findIndex(j => j.id === id);
        if (idx < 0) return { error: `Job not found: ${id}` };

        const job = { ...jobs[idx] };
        if (name !== undefined) job.name = String(name).trim().slice(0, 100);
        if (cronExpr !== undefined) {
          try {
            const parsed = new Cron(cronExpr);
            const next1 = parsed.nextRun();
            const next2 = next1 ? parsed.nextRun(next1) : null;
            if (next1 && next2 && (next2 - next1) < CRON_MIN_INTERVAL_MINUTES * 60_000) {
              return { error: `Cron expression fires too frequently (every ${Math.round((next2 - next1) / 60_000)}m). Minimum interval is ${CRON_MIN_INTERVAL_MINUTES} minutes.` };
            }
          } catch (e) {
            return { error: `Invalid cron expression "${cronExpr}": ${e?.message || "parse error"}` };
          }
          job.expression = cronExpr;
        }
        if (interval_minutes !== undefined) job.intervalMinutes = Math.max(CRON_MIN_INTERVAL_MINUTES, Math.round(interval_minutes));
        if (timezone !== undefined) job.timezone = String(timezone).trim();
        if (prompt !== undefined) job.prompt = String(prompt).trim().slice(0, 2000);
        if (enabled !== undefined) job.enabled = Boolean(enabled);

        jobs[idx] = normaliseCronJob(job);
        saveCronJobs(jobs);

        return { updated: true, id: jobs[idx].id, name: jobs[idx].name, enabled: jobs[idx].enabled };
      }
    },
    {
      name: "cos_cron_delete",
      isMutating: true,
      description: "Delete a scheduled job by ID.",
      input_schema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Job ID to delete." }
        },
        required: ["id"]
      },
      execute: async ({ id } = {}) => {
        if (!id) return { error: "id is required." };
        const jobs = loadCronJobs();
        const idx = jobs.findIndex(j => j.id === id);
        if (idx < 0) return { error: `Job not found: ${id}` };
        const removed = jobs.splice(idx, 1)[0];
        saveCronJobs(jobs);
        return { deleted: true, id: removed.id, name: removed.name };
      }
    }
  ];
}

// ─── Cron Scheduler: System Prompt Section ─────────────────────────────────────

export function buildCronJobsPromptSection() {
  const jobs = loadCronJobs();
  if (!jobs.length) return "";

  const enabledJobs = jobs.filter(j => j.enabled);
  if (!enabledJobs.length) {
    return `## Scheduled Jobs\n\nAll ${jobs.length} scheduled job(s) are currently disabled. Use cos_cron_update to re-enable or cos_cron_delete to remove them.`;
  }

  const lines = enabledJobs.map(j => {
    let schedule = "";
    if (j.type === "cron") schedule = `cron: ${j.expression} (${j.timezone})`;
    else if (j.type === "interval") schedule = `every ${j.intervalMinutes} min`;
    else if (j.type === "once") schedule = `once at ${j.runAt ? new Date(j.runAt).toISOString() : "TBD"}`;

    let nextRun = "";
    try {
      if (j.type === "cron" && j.expression) {
        const next = new Cron(j.expression, { timezone: j.timezone || getDefaultBrowserTimezone() }).nextRun();
        if (next) nextRun = ` | next: ${next.toLocaleString("en-GB")}`;
      }
    } catch { /* ignore */ }

    const lastRunStr = j.lastRun > 0 ? ` | last: ${new Date(j.lastRun).toLocaleString("en-GB")}` : "";
    return `- **${j.name}** (${j.id}) — ${schedule}${nextRun}${lastRunStr} — "${j.prompt.slice(0, 80)}"`;
  });

  return `## Scheduled Jobs

You have access to cron job tools (cos_cron_list, cos_cron_create, cos_cron_update, cos_cron_delete).
The user currently has ${enabledJobs.length} active scheduled job(s):
${deps.wrapUntrustedWithInjectionScan("cron_jobs", lines.join("\n"))}`;
}
