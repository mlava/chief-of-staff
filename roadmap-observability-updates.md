# Roadmap Updates — Observability Learnings from Langfuse Blog Post

> Source: "I Built my own Observability for Claude Code — Here's Why and How" (Doneyli De Jesus, Feb 2026)
> Key constraint: all changes must be agnostic — work for any COS user, not just those running Open Brain.

---

## 1. #81 — Enhance with concrete implementation sub-tasks

**Current state:** #81 has three sub-tasks focused on longitudinal eval tracking, model drift detection, and surfacing data in #55. These are the right *analysis* layer but they assume a *data* layer that doesn't exist yet. The `lastAgentRunTrace` object in `agent-loop.js` captures rich per-run data (timing, provider, model, iterations, every tool call with args/results, guards fired, cost, tokens) — but it's volatile. It holds only the most recent run and is wiped on extension unload. The usage stats in `usage-tracking.js` aggregate daily counters but lose individual trace detail. There is no way to answer "what happened in the run where the fabrication guard fired on Tuesday."

**Proposed new sub-tasks (add below existing three):**

```
- Trace persistence to Roam — persist trace summaries to a `[[Chief of Staff/Agent Log]]` page
  for runs that meet anomaly criteria: any guard fired, eval score ≤ 3, tier escalated,
  budget exceeded, or ≥ 10 iterations. One child block per run. Schema:
  `timestamp | tier | provider/model | iterations | tool calls (names only, comma-separated) |
  guards fired | eval score | cost`. Compact single-line format to stay within Roam's
  comfortable block size. Skip logging for deterministic-router fast-path hits (no agent loop).
  90-day rolling retention (prune on extension load, matching COST_HISTORY_MAX_DAYS).
  Implementation: hook into the existing `trace.finishedAt` assignment points in
  runAgentLoop() — at each early return and the final return, check anomaly criteria
  and call a new `persistTraceToRoam(trace)` function. Non-blocking (fire and forget via
  setTimeout to avoid delaying response rendering). Page creation on first write if missing.

- cos_get_last_trace tool — expose `lastAgentRunTrace` as a read-only COS tool so users,
  skills, and cron jobs can query what just happened. Returns the full trace object
  (timing, iterations, tool calls, guards, cost, tokens). Useful for: skills that need to
  reference their own execution metadata, eval-judge consuming trace data, and the /lesson
  command capturing execution context alongside conversational context. No persistence
  dependency — reads the in-memory trace directly.

- Trace-backed longitudinal queries — once Agent Log exists, add a deterministic route
  for "show me recent agent issues" / "what went wrong" intents that reads the Agent Log
  page and summarises: guard fire frequency, most common failure tools, cost outliers,
  tier escalation rate. Feeds #55 (system health dashboard) with the observability dimension
  #81 originally called for. Also provides the raw data #94 (adaptive tier routing) needs
  for empirical routing decisions.
```

**Rationale for Roam-native storage:** Every COS user has Roam. The `Chief of Staff/*` namespace is already established for Memory, Decisions, Lessons, Skills, Eval Log, and Review Queue. Agent Log is the natural addition. Roam pages are queryable via `roam_search` and readable by skills. No external infrastructure dependency.

---

## 2. New item — #116 Resilient async queue for remote operations

**Proposed placement:** Medium Priority (general infrastructure, benefits multiple systems)

```
#116 Resilient async queue for remote operations — IndexedDB-backed retry queue
for fire-and-forget remote calls that currently fail silently. Inspired by the offline
queue pattern in Doneyli De Jesus's Langfuse observability hook (Feb 2026): when a
remote endpoint is unreachable, queue the payload locally; drain automatically on
next successful connection.

**Problem:** COS makes several async remote calls that are non-critical to the user's
immediate interaction but valuable for system health: eval-judge captures, Agent Log
persistence (#81), Open Brain captures (for users who have it), and future observability
payloads. When the remote endpoint is temporarily down (Supabase cold start, MCP server
restart, network blip, Roam API transient error), these calls fail silently and the data
is lost. The user doesn't notice, but the observability and memory pipelines develop gaps.

**Design:**
- New utility module `src/retry-queue.js` (~150-200 lines)
- Queue storage: Roam Depot IndexedDB via extensionAPI.settings (key: `retry-queue`,
  shape: `{ items: [{ id, type, payload, queuedAt, attempts }] }`)
- Max queue depth: 50 items (FIFO eviction if exceeded)
- Max retry attempts per item: 3 (discard after)
- Drain trigger: on extension load + after any successful remote call of the same type
- Type registry: callers register a `{ type, execute }` pair. The queue stores
  serialisable payloads; the execute function is provided at registration time,
  not serialised.
- Non-blocking: drain runs via requestIdleCallback or setTimeout, never on the
  critical path of user interaction
- Graceful: all queue operations wrapped in try/catch. Queue corruption → clear
  and continue. Never blocks the agent loop or chat panel.

**Consumers:**
- #81 Agent Log trace persistence (if Roam API write fails)
- Eval-judge review queue writes
- Any future remote MCP fire-and-forget operation
- Open Brain captures (for users who have it — queue is agnostic to destination)

**Not in scope:** Retrying user-facing tool calls (those should fail fast with a
toast). This is exclusively for background/observability writes where silent retry
is acceptable.

Touches: new `src/retry-queue.js`, `src/index.js` (init + registration in onload),
consumers register individually.
Related: #81 (agent observability), #88 (failure state preservation), #110 (health check
could report queue depth as a diagnostic signal).
```

---

## 3. #94 — Add linkage note to #81 trace data

**Current state:** #94 says "log which tier actually succeeded for different query shapes over time" but doesn't specify where that log lives. With #81's Agent Log providing per-run `{tier, provider, eval score, guard fires, prompt preview}` tuples, #94 has a concrete data source.

**Proposed addition (append to #94):**

```
**Data dependency on #81:** Agent Log trace persistence provides the empirical
per-run data (tier used, provider, eval score, guard fires, iteration count, cost)
that adaptive routing needs to learn from. Without #81, #94 would need to build its
own logging — duplicating infrastructure. With #81 shipping first, #94 can read
Agent Log entries, cluster by prompt shape (short keyword heuristics matching
existing POWER_ESCALATION_PATTERNS), and compute per-pattern success rates by tier.
The exploration/exploitation balance then operates on real data rather than static
scoring weights.
```

---

## 4. Minor cross-reference additions

**#63 (cost tracking):** No changes needed. The blog reinforces existing sub-tasks (per-conversation display, tool token instrumentation) without adding new dimensions.

**#82 (permission scope governance):** No changes needed. The "actually used vs. approved" tool usage analysis is already a sub-task. `usageStats.days[key].toolCalls` provides the raw data.

**#88 (failure state preservation):** No changes needed. The blog's trace capture is post-hoc; #88's live serialisation on every tool call is more ambitious and already well-specified.

---

## Summary of changes

| Item | Action | Priority change? |
|------|--------|-----------------|
| #81 | Add 3 sub-tasks: trace persistence to Roam, cos_get_last_trace tool, trace-backed queries | Consider promoting from Architecture Notes to Medium Priority |
| #116 (new) | Resilient async queue for remote operations | Medium Priority |
| #94 | Add data-dependency note linking to #81 Agent Log | No change |
| #63, #82, #88 | No changes | No change |
