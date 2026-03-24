// ─── Idle-Time Background Task Scheduler ────────────────────────────────────────
// Infrastructure for running heavy tasks (graph scans, system health, memory
// management) when Roam is open but not actively used. Three browser API layers:
// user activity tracking, document.visibilityState, and requestIdleCallback.
// Multi-tab coordination via navigator.locks (localStorage fallback).
// All external dependencies injected via initIdleScheduler().

// ─── Constants ─────────────────────────────────────────────────────────────────
const IDLE_ACTIVITY_TIMEOUT_MS = 180_000;       // 3 minutes of inactivity
const IDLE_CALLBACK_TIMEOUT_MS = 5_000;         // requestIdleCallback starvation prevention
const IDLE_MAX_WORK_MS_PER_WINDOW = 2_000;      // 2s cumulative work cap per idle window
const IDLE_DEADLINE_MARGIN_MS = 5;              // Yield when deadline.timeRemaining() < 5ms
const IDLE_TICK_INTERVAL_MS = 10_000;           // State machine check interval
const IDLE_MIN_TASK_INTERVAL_MS = 60_000;       // Floor for task intervalMs
const IDLE_ACTIVITY_EVENTS = ["mousemove", "keydown", "click", "hashchange"];
const IDLE_LOCK_PREFIX = "cos-idle-";
const IDLE_LEADER_KEY_PREFIX = "chief-of-staff-idle-leader-";
const IDLE_LEADER_HEARTBEAT_MS = 15_000;        // Faster than cron (15s vs 30s)
const IDLE_LEADER_STALE_MS = 45_000;            // 3 missed heartbeats

// ─── Module-scoped state ───────────────────────────────────────────────────────

let deps = {};

// State machine: "ready" | "idle" | "running" | "paused"
let schedulerState = "ready";
let schedulerRunning = false;

// Task registry
const taskRegistry = new Map();     // id → taskDef
const taskLastRunAt = new Map();    // id → timestamp of last completion
let activeTaskId = null;            // currently executing task ID
let activeTaskState = null;         // chunk state for active task (pause/resume)

// Idle detection
let lastActivityAt = Date.now();
let tabVisible = true;
const eventCleanupFns = [];

// Timers & callbacks
let tickIntervalId = null;
let idleCallbackId = null;
let cumulativeWorkMs = 0;

// Coordinator (navigator.locks)
let lockHeld = false;
let lockAbortController = null;
let usingNavigatorLocks = false;

// Coordinator (localStorage fallback)
let leaderTabId = null;
let leaderHeartbeatId = null;
let leaderStorageHandler = null;

// ─── DI Initialiser ────────────────────────────────────────────────────────────

export function initIdleScheduler(injected) {
  deps = injected;
}

// ─── Graph Name Helpers ────────────────────────────────────────────────────────

function getGraphName() {
  return (typeof window !== "undefined" && window.roamAlphaAPI?.graph?.name) || "default";
}

function getIdleLockName() {
  return `${IDLE_LOCK_PREFIX}${getGraphName()}`;
}

function getIdleLeaderKey() {
  return `${IDLE_LEADER_KEY_PREFIX}${getGraphName()}`;
}

// ─── Coordinator: navigator.locks ──────────────────────────────────────────────

function startNavigatorLockCoordinator() {
  if (typeof navigator === "undefined" || !navigator.locks?.request) return false;
  usingNavigatorLocks = true;
  lockAbortController = new AbortController();

  // Acquire lock and hold via never-resolving promise.
  // Auto-releases on tab crash (~100ms failover).
  navigator.locks.request(
    getIdleLockName(),
    { signal: lockAbortController.signal },
    () => {
      lockHeld = true;
      deps.debugLog?.("[Idle] Acquired coordinator lock");
      // Hold the lock until abort — the promise never resolves on its own
      return new Promise((_, reject) => {
        lockAbortController.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      });
    }
  ).catch((err) => {
    if (err?.name !== "AbortError") {
      deps.debugLog?.("[Idle] Lock request failed:", err?.message);
    }
    lockHeld = false;
  });

  return true;
}

function releaseNavigatorLock() {
  if (lockAbortController) {
    lockAbortController.abort();
    lockAbortController = null;
  }
  lockHeld = false;
}

function isCoordinator() {
  if (usingNavigatorLocks) return lockHeld;
  return leaderTabId !== null;
}

// ─── Coordinator: localStorage Fallback ────────────────────────────────────────

function localStorageTryClaimLeadership() {
  try {
    const now = Date.now();
    const raw = localStorage.getItem(getIdleLeaderKey());
    if (raw) {
      const data = JSON.parse(raw);
      if (data.heartbeat && (now - data.heartbeat) < IDLE_LEADER_STALE_MS) {
        if (data.tabId !== leaderTabId) return false;
        return true;
      }
    }
    leaderTabId = Math.random().toString(36).slice(2, 10);
    localStorage.setItem(getIdleLeaderKey(), JSON.stringify({
      tabId: leaderTabId,
      heartbeat: now,
    }));
    // Re-read to detect race condition
    const check = JSON.parse(localStorage.getItem(getIdleLeaderKey()) || "{}");
    if (check.tabId === leaderTabId) {
      deps.debugLog?.("[Idle] Claimed leadership (localStorage):", leaderTabId);
      return true;
    }
    leaderTabId = null;
    return false;
  } catch {
    leaderTabId = "fallback";
    return true;
  }
}

function localStorageHeartbeat() {
  if (leaderTabId === null) return;
  try {
    const raw = localStorage.getItem(getIdleLeaderKey());
    if (!raw) { leaderTabId = null; return; }
    const data = JSON.parse(raw);
    if (data.tabId !== leaderTabId) { leaderTabId = null; return; }
    data.heartbeat = Date.now();
    localStorage.setItem(getIdleLeaderKey(), JSON.stringify(data));
    const check = JSON.parse(localStorage.getItem(getIdleLeaderKey()) || "{}");
    if (check.tabId !== leaderTabId) { leaderTabId = null; }
  } catch { /* ignore */ }
}

function releaseLocalStorageLeadership() {
  try {
    const raw = localStorage.getItem(getIdleLeaderKey());
    if (raw) {
      const data = JSON.parse(raw);
      if (data.tabId === leaderTabId) {
        localStorage.removeItem(getIdleLeaderKey());
      }
    }
  } catch { /* ignore */ }
  leaderTabId = null;
}

function startLocalStorageCoordinator() {
  localStorageTryClaimLeadership();
  leaderHeartbeatId = setInterval(() => {
    localStorageHeartbeat();
    if (leaderTabId === null) localStorageTryClaimLeadership();
  }, IDLE_LEADER_HEARTBEAT_MS);

  leaderStorageHandler = (e) => {
    if (e.key !== getIdleLeaderKey()) return;
    if (!e.newValue) {
      // Key removed — try to claim
      localStorageTryClaimLeadership();
      return;
    }
    try {
      const data = JSON.parse(e.newValue);
      if (data.tabId !== leaderTabId && leaderTabId !== null) {
        leaderTabId = null;
      }
    } catch { /* ignore */ }
  };
  window.addEventListener("storage", leaderStorageHandler);
}

function startCoordinator() {
  if (startNavigatorLockCoordinator()) return;
  startLocalStorageCoordinator();
}

// ─── Idle Detection ────────────────────────────────────────────────────────────

function onUserActivity() {
  lastActivityAt = Date.now();
  if (schedulerState === "running") {
    transitionTo("paused");
  }
}

function setupActivityListeners() {
  for (const eventName of IDLE_ACTIVITY_EVENTS) {
    const handler = () => onUserActivity();
    const target = eventName === "hashchange" ? window : document;
    target.addEventListener(eventName, handler, { passive: true });
    eventCleanupFns.push(() => target.removeEventListener(eventName, handler));
  }
}

function onVisibilityChange() {
  tabVisible = document.visibilityState === "visible";
  if (tabVisible) {
    lastActivityAt = Date.now();
    if (schedulerState === "running") {
      transitionTo("paused");
    }
  }
}

function setupVisibilityListener() {
  const handler = () => onVisibilityChange();
  document.addEventListener("visibilitychange", handler);
  eventCleanupFns.push(() => document.removeEventListener("visibilitychange", handler));
}

function isUserIdle() {
  if (!tabVisible) return true;
  return (Date.now() - lastActivityAt) >= IDLE_ACTIVITY_TIMEOUT_MS;
}

// ─── State Machine ─────────────────────────────────────────────────────────────

function transitionTo(newState) {
  if (newState === schedulerState) return;
  const oldState = schedulerState;
  deps.debugLog?.("[Idle] State:", oldState, "→", newState);
  schedulerState = newState;

  switch (newState) {
    case "ready":
      cancelScheduledIdleCallback();
      cumulativeWorkMs = 0;
      break;
    case "idle":
      cumulativeWorkMs = 0;
      scheduleIdleCallback();
      break;
    case "running":
      // Entered from within the idle callback — nothing to do here
      break;
    case "paused":
      cancelScheduledIdleCallback();
      // activeTaskId and activeTaskState preserved for resume
      break;
  }
}

// ─── Tick Loop & Guards ────────────────────────────────────────────────────────

function isAgentBusy() {
  return Boolean(deps.getActiveAgentAbortController?.()) || Boolean(deps.getChatPanelIsSending?.());
}

function hasTasksDue() {
  const now = Date.now();
  for (const [id, task] of taskRegistry) {
    const lastRun = taskLastRunAt.get(id) || 0;
    if ((now - lastRun) >= task.intervalMs) return true;
  }
  return false;
}

function getNextDueTask() {
  // Paused task resumes first
  if (activeTaskId && taskRegistry.has(activeTaskId)) {
    return taskRegistry.get(activeTaskId);
  }

  const now = Date.now();
  const dueTasks = [];
  for (const [id, task] of taskRegistry) {
    const lastRun = taskLastRunAt.get(id) || 0;
    if ((now - lastRun) >= task.intervalMs) {
      dueTasks.push(task);
    }
  }
  dueTasks.sort((a, b) => a.priority - b.priority);
  return dueTasks[0] || null;
}

function tick() {
  if (!schedulerRunning || deps.isUnloadInProgress?.()) return;
  if (!isCoordinator()) {
    // Not coordinator — try to reclaim if using localStorage fallback
    if (!usingNavigatorLocks && leaderTabId === null) {
      localStorageTryClaimLeadership();
    }
    return;
  }

  switch (schedulerState) {
    case "ready":
      if (isUserIdle() && hasTasksDue() && !isAgentBusy()) {
        transitionTo("idle");
      }
      break;
    case "idle":
      if (!isUserIdle()) {
        transitionTo("ready");
      }
      break;
    case "paused":
      if (isUserIdle() && !isAgentBusy()) {
        transitionTo("idle");
      }
      break;
    case "running":
      // Managed within processNextChunk, not by tick
      break;
  }
}

// ─── requestIdleCallback Integration ───────────────────────────────────────────

function scheduleIdleCallback() {
  cancelScheduledIdleCallback();
  if (typeof requestIdleCallback === "function") {
    idleCallbackId = requestIdleCallback(
      (deadline) => processNextChunk(deadline),
      { timeout: IDLE_CALLBACK_TIMEOUT_MS }
    );
  } else {
    // Fallback: simulate with setTimeout
    idleCallbackId = setTimeout(
      () => processNextChunk({ timeRemaining: () => 50, didTimeout: false }),
      100
    );
  }
}

function cancelScheduledIdleCallback() {
  if (idleCallbackId == null) return;
  if (typeof cancelIdleCallback === "function") {
    cancelIdleCallback(idleCallbackId);
  } else {
    clearTimeout(idleCallbackId);
  }
  idleCallbackId = null;
}

function processNextChunk(deadline) {
  idleCallbackId = null;

  // Pre-flight safety checks
  if (!schedulerRunning || deps.isUnloadInProgress?.()) {
    transitionTo("ready");
    return;
  }
  if (!isCoordinator()) {
    transitionTo("ready");
    return;
  }
  if (isAgentBusy()) {
    if (activeTaskId) {
      transitionTo("paused");
    } else {
      transitionTo("ready");
    }
    return;
  }
  if (!isUserIdle()) {
    if (activeTaskId) {
      transitionTo("paused");
    } else {
      transitionTo("ready");
    }
    return;
  }

  // Skip if deadline already too short — avoid noisy running→idle bounce
  if (deadline.timeRemaining() <= IDLE_DEADLINE_MARGIN_MS) {
    scheduleIdleCallback();
    return;
  }

  // Find or resume a task
  const task = getNextDueTask();
  if (!task) {
    transitionTo("ready");
    return;
  }

  transitionTo("running");

  // Initialise task state if this is a fresh start (not a resume)
  if (activeTaskId !== task.id) {
    activeTaskId = task.id;
    try {
      activeTaskState = task.init();
    } catch (err) {
      deps.debugLog?.("[Idle] Task init failed:", task.id, err?.message);
      handleTaskError(task, err);
      return;
    }
  }

  // Process chunks within deadline
  try {
    while (
      deadline.timeRemaining() > IDLE_DEADLINE_MARGIN_MS &&
      cumulativeWorkMs < IDLE_MAX_WORK_MS_PER_WINDOW &&
      !deps.isUnloadInProgress?.()
    ) {
      const beforeMs = performance.now();
      const result = task.processChunk(activeTaskState, deadline);
      const elapsedMs = performance.now() - beforeMs;
      cumulativeWorkMs += elapsedMs;

      if (!result || typeof result !== "object") {
        deps.debugLog?.("[Idle] processChunk returned invalid result:", task.id);
        handleTaskError(task, new Error("processChunk must return { state, done }"));
        return;
      }

      activeTaskState = result.state;

      if (result.done) {
        handleTaskComplete(task, activeTaskState);
        return;
      }
    }
  } catch (err) {
    deps.debugLog?.("[Idle] processChunk error:", task.id, err?.message);
    handleTaskError(task, err);
    return;
  }

  // Budget exhausted or deadline expired — yield then continue
  if (cumulativeWorkMs >= IDLE_MAX_WORK_MS_PER_WINDOW) {
    deps.debugLog?.("[Idle] Work budget exhausted, yielding");
    cumulativeWorkMs = 0;
  }

  if (isUserIdle() && !isAgentBusy() && !deps.isUnloadInProgress?.()) {
    transitionTo("idle");
  } else {
    transitionTo("paused");
  }
}

// ─── Task Lifecycle ────────────────────────────────────────────────────────────

function handleTaskComplete(task, finalState) {
  deps.debugLog?.("[Idle] Task complete:", task.id);
  taskLastRunAt.set(task.id, Date.now());
  activeTaskId = null;
  activeTaskState = null;

  try {
    task.onComplete?.(finalState);
  } catch (err) {
    deps.debugLog?.("[Idle] onComplete error:", task.id, err?.message);
  }

  if (isUserIdle() && hasTasksDue() && !isAgentBusy()) {
    transitionTo("idle");
  } else {
    transitionTo("ready");
  }
}

function handleTaskError(task, err) {
  deps.debugLog?.("[Idle] Task error:", task.id, err?.message);

  try {
    task.onError?.(err, activeTaskState);
  } catch (handlerErr) {
    deps.debugLog?.("[Idle] onError handler failed:", task.id, handlerErr?.message);
  }

  // Mark as run even on error to prevent tight retry loops
  taskLastRunAt.set(task.id, Date.now());
  activeTaskId = null;
  activeTaskState = null;
  transitionTo("ready");
}

// ─── Task Registration ─────────────────────────────────────────────────────────

export function registerIdleTask(taskDef) {
  if (!taskDef?.id || typeof taskDef.id !== "string") {
    throw new Error("registerIdleTask: id is required (string)");
  }
  if (typeof taskDef.processChunk !== "function") {
    throw new Error("registerIdleTask: processChunk function is required");
  }
  if (typeof taskDef.init !== "function") {
    throw new Error("registerIdleTask: init function is required");
  }

  const normalised = {
    id: taskDef.id,
    priority: Number.isFinite(taskDef.priority) ? taskDef.priority : 50,
    intervalMs: Number.isFinite(taskDef.intervalMs)
      ? Math.max(IDLE_MIN_TASK_INTERVAL_MS, taskDef.intervalMs)
      : 3_600_000,
    init: taskDef.init,
    processChunk: taskDef.processChunk,
    onComplete: typeof taskDef.onComplete === "function" ? taskDef.onComplete : null,
    onError: typeof taskDef.onError === "function" ? taskDef.onError : null,
  };

  taskRegistry.set(normalised.id, normalised);
  deps.debugLog?.("[Idle] Registered task:", normalised.id, "priority:", normalised.priority, "interval:", normalised.intervalMs);
}

export function unregisterIdleTask(id) {
  if (activeTaskId === id) {
    activeTaskId = null;
    activeTaskState = null;
    if (schedulerState === "running" || schedulerState === "paused") {
      transitionTo("ready");
    }
  }
  taskRegistry.delete(id);
  taskLastRunAt.delete(id);
  deps.debugLog?.("[Idle] Unregistered task:", id);
}

// ─── Start / Stop / Cleanup ────────────────────────────────────────────────────

export function startIdleScheduler() {
  if (schedulerRunning) return;
  schedulerRunning = true;
  lastActivityAt = Date.now();
  tabVisible = typeof document !== "undefined" ? document.visibilityState === "visible" : true;

  startCoordinator();
  if (typeof document !== "undefined") {
    setupActivityListeners();
    setupVisibilityListener();
  }

  tickIntervalId = setInterval(() => tick(), IDLE_TICK_INTERVAL_MS);
  deps.debugLog?.("[Idle] Scheduler started");
}

export function stopIdleScheduler() {
  schedulerRunning = false;

  cancelScheduledIdleCallback();

  if (tickIntervalId) {
    clearInterval(tickIntervalId);
    tickIntervalId = null;
  }

  // Release coordinator
  if (usingNavigatorLocks) {
    releaseNavigatorLock();
  } else {
    releaseLocalStorageLeadership();
    if (leaderHeartbeatId) {
      clearInterval(leaderHeartbeatId);
      leaderHeartbeatId = null;
    }
    if (leaderStorageHandler) {
      window.removeEventListener("storage", leaderStorageHandler);
      leaderStorageHandler = null;
    }
  }

  // Remove activity/visibility listeners
  for (const cleanup of eventCleanupFns) {
    try { cleanup(); } catch { /* ignore */ }
  }
  eventCleanupFns.length = 0;

  schedulerState = "ready";
  deps.debugLog?.("[Idle] Scheduler stopped");
}

export function cleanupIdleScheduler() {
  stopIdleScheduler();
  taskRegistry.clear();
  taskLastRunAt.clear();
  activeTaskId = null;
  activeTaskState = null;
  cumulativeWorkMs = 0;
  lockHeld = false;
  usingNavigatorLocks = false;
  leaderTabId = null;
}

// ─── Debug Accessors ───────────────────────────────────────────────────────────

export function getIdleSchedulerState() {
  return {
    state: schedulerState,
    running: schedulerRunning,
    isCoordinator: isCoordinator(),
    isUserIdle: typeof document !== "undefined" ? isUserIdle() : false,
    activeTaskId,
    registeredTasks: [...taskRegistry.keys()],
    tabVisible,
    lastActivityAt,
    cumulativeWorkMs,
  };
}

export function getRegisteredIdleTasks() {
  return taskRegistry;
}

// ─── Exported Constants (for testing) ──────────────────────────────────────────

export {
  IDLE_ACTIVITY_TIMEOUT_MS,
  IDLE_CALLBACK_TIMEOUT_MS,
  IDLE_MAX_WORK_MS_PER_WINDOW,
  IDLE_DEADLINE_MARGIN_MS,
  IDLE_TICK_INTERVAL_MS,
  IDLE_MIN_TASK_INTERVAL_MS,
  IDLE_ACTIVITY_EVENTS,
  IDLE_LEADER_HEARTBEAT_MS,
  IDLE_LEADER_STALE_MS,
};
