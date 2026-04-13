# Chief of Staff — Roadmap

> Lean planning layer. One-line per item, priority-ordered, status-tracked.
> Full research notes (addenda, implementation sketches, decision context) live in [[Chief of Staff/Roadmap]] in Roam.
> Last sync: April 13 2026

---

## Recently Shipped

| # | Item | Shipped |
|---|------|---------|
| #89 | Per-skill tool whitelist | Mar 30 |
| #79 | Context compaction v2 (structured sections + artifact tracking) | Mar 30 |
| #73 | User correction capture (idle-time diff tracking) | Mar 30 |
| #100 | Binary eval mode (pass/fail checks in eval-judge) | Mar 30 |
| #87 | Per-skill token budgets (`Budget:` field, graceful termination) | Mar 31 |
| #97 | Intent confidence gate (mini-tier classification before agent loop) | Mar 31 |
| #24b | Extension Tools API (`window.RoamExtensionTools`, 54 tools discovered) | Mar 31 |
| #103 | Constraint architecture for skills (`Constraints:` field, four quadrants) | Mar 31 |
| #104 | Per-skill eval rubrics (`Rubric:` field, binary pass/fail scoring) | Mar 31 |
| #98 | Skill Autoresearch Loop Phase 1 | Apr |
| #118 | Advisor Pattern Phase 1 | Apr |

---

## High Priority

> Both items are awaiting real-world usage data before iterating. Do not start today.

| # | Item | Key files |
|---|------|-----------|
| #98 | Skill Autoresearch Loop Phase 2 — tool mocking + tool suggestions from known toolset | `src/skill-autoresearch.js` |
| #118 | Advisor Pattern Phase 2 — see `docs/PLAN-98-skill-autoresearch.md` | `src/index.js` |

---

## Medium Priority

| # | Item | Notes | Key files |
|---|------|-------|-----------|
| **#102** | **Periodic synthesis skill** — cron-driven; distils `Chief of Staff/Corrections` patterns into durable memories on `Chief of Staff/Memory`. **← Ship next. Closes the minimum viable learning loop.** | v2 addendum: auto-draft skill constraints from 3+ repeated corrections | `src/cron-scheduler.js`, `src/index.js` |
| #109 | Skill Backlog Audit — structured scoring (recurrence × methodology × quality variance × agent exposure) to prioritise what to build next | Fills gap between Suggest Workflows and Skill Designer | `src/index.js` (skill framework) |
| #82 | Permission scope governance — **ship tool-usage-frequency logging first** (50–100 lines); periodic scope audit and auto-tightening are downstream. Absorbs #95. | Unblocks #94 adaptive tier routing | `src/tool-execution.js`, `src/usage-tracking.js` |
| #114 | Automation inventory page (`Chief of Staff/Automations`) — living registry of everything COS handles autonomously; populated by cron, skill, and MCP events | "What is my agent doing right now?" | `src/cron-scheduler.js`, `src/index.js` |
| #101 | `/compact` testing and further dev — milestone-based decomposition for skill composition; benchmark against Factory/OpenAI/Anthropic compaction approaches | Extracted from #79 sub-tasks | `src/conversation.js` |
| #115 | Automatic skill discovery — after successful ≥3-tool-call runs, detect patterns and offer to save as a draft skill for human review | Discovery only, never auto-activate | `src/eval-judge.js`, `src/index.js` |
| #116 | Resilient async retry queue — IndexedDB-backed queue for background remote calls that currently fail silently (Supabase cold starts, MCP restarts) | New module `src/retry-queue.js`, ~150–200 lines | `src/retry-queue.js` (new), `src/index.js` |
| #34 | Skill composition & orchestration — **Phase 1**: sequential chaining (fresh context per skill). **Phase 2**: template instantiation. **Phase 3**: orchestrated cross-system playbooks with worker/orchestrator split. | Pre-validation gate between steps (see #113) | `src/index.js`, `src/agent-loop.js` |

---

## Lower Priority

| # | Item | Key files |
|---|------|-----------|
| #105 | Graduated inbox delegation — replace binary read-only mode with three tiers (Act autonomously / Act and notify / Escalate). Per-tag/per-pattern rules. | `src/inbox.js`, `src/agent-loop.js` |
| #106 | Structured memory template — Personal Context Document pattern for `Chief of Staff/Memory`; dual-voice schema (internal briefing vs. deliverable voice); cross-cutting domain rules via `Chief of Staff/Rules` | `src/system-prompt.js`, `src/index.js` |
| #107 | Query enrichment layer — pre-processing step that detects underspecified requests and enriches with Memory context before LLM call | `src/index.js` (`askChiefOfStaff`), `src/deterministic-router.js` |
| #108 | Specification builder for autonomous tasks — skill that produces structured spec blocks attached to cron jobs; agent loads spec as execution context | `src/cron-scheduler.js` |
| #77 | Source monitor / personalised digest skill — cron-driven content scanner across topics and sources; writes digest to DNP | `src/cron-scheduler.js` |
| #50 | MCP tool whitelist per server — per-server tool cap/allowlist in COS settings for graceful degradation on large MCP servers | `src/local-mcp.js`, `src/remote-mcp.js` |
| #39 | Meeting Agenda Prep skill — pull backlinks, open tasks, recent notes, decision history; structure into agenda | skill definition |
| #42 | Decision retrospective skill — periodic review of past decisions with outcome annotations | skill definition |
| #30 | Memory management — `cos_search_memory` (semantic search across memory pages), `cos_get_memory_stats` | `src/index.js` |
| #29 | Proactive monitoring — `roam_watch_page`, `roam_watch_query` triggers | `src/roam-native-tools.js` |
| #35 | Decision capture & linking — auto-link blocks to `Chief of Staff/Decisions` with metadata | `src/index.js` |
| #45 | Detachable popout panel — `window.open()` for independent COS window; restore-to-default command | `src/chat-panel.js` |
| #17 | Day tracking mode — snapshot graph + MCP tool state at start of day, track changes throughout | `src/idle-scheduler.js` |

---

## Deferred

> Revisit when prerequisites are met. Do not start without re-evaluating rationale.

| # | Item | Blocker / Rationale |
|---|------|---------------------|
| #86 | Monte Carlo eval for skill reliability (N-run mode, statistical pass/fail, CI integration) | Wait until #98 Phase 2 proves whether binary evals are sufficient. 50 iterations/scenario is expensive. |
| #94 | Adaptive tier routing — frequency counter pre-routes patterns that escalate 3+ times in 7 days | Needs #82 tool-usage-frequency data first |
| #93 | Eval-driven skill refinement | Merged into #98 |
| #95 | Tool success tracking | Merged into #82 |
| #91B | Board of Advisors (multi-perspective deliberation) | Council Mode A shipped. Full Board is a different product. Park until core improvement loop is solid. |
| #99 | Roam Graph Vector Index | Maintenance burden (sync/chunking/dedup) outweighs benefit. `roam_search` + Open Brain covers the use case. |
| #111 | Workflow state + crash recovery | Engineering cost disproportionate to user pain. Browser mid-run crashes are rare; blast radius is small. |
| #117 | Nebius Token Factory | Hermes 4 known tool-calling issues. Revisit when Hermes 4.5 ships. |
| #52 | Cross-system intelligence Phases 2–4 (proactive nudging, communication intelligence, temporal patterns) | Phase 1 health metrics covered by #110. Phases 2–4 are multi-month epics depending on infrastructure that doesn't exist yet. |
| #84 | Out-of-process policy engine | Deferred — architecture cost too high for current scale |
| #85/#88 | HITL intervention patterns | Deferred — graduated inbox delegation (#105) covers the near-term need |
| #96 | Context reset | Deferred |
| #67 | i18n | Deferred |
| #72 | Memory decay | Deferred |
| #74 | Graduated autonomy | Deferred — partially addressed by #105 |
