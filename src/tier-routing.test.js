// ─── Tier Routing Tests ─────────────────────────────────────────────────────
//
// Run: node --experimental-vm-modules src/tier-routing.test.js
//   or: node src/tier-routing.test.js  (if using the CJS shim below)
//
// No test framework needed — plain assertions with readable output.

import {
  scoreToolCount,
  scorePromptComplexity,
  scoreTrajectory,
  computeRoutingScore,
  recordTurnOutcome,
  sessionTrajectory,
  TIER_THRESHOLDS,
  STRATEGY_WEIGHTS
} from "./tier-routing.js";

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  ✗ ${label}`);
  }
}

function assertRange(value, min, max, label) {
  assert(value >= min && value <= max, `${label} → ${value.toFixed(3)} in [${min}, ${max}]`);
}

function section(name) {
  console.log(`\n── ${name} ──`);
}

// ─── Mock data ──────────────────────────────────────────────────────────────

const mockSkillEntries = [
  {
    title: "Weekly Review",
    content: `
      Weekly Review
        Gather open tasks, calendar events, and project pages.
        Sources
          roam_search — find open tasks
          cos_get_calendar — upcoming events
          roam_pull_many — project page trees
          cos_update_memory — save review summary
    `
  },
  {
    title: "Quick Add Task",
    content: `
      Quick Add Task
        Create a task block on today's page.
        Sources
          roam_create_block — add the task
    `
  },
  {
    title: "End of Day Reconciliation",
    content: `
      End of Day Reconciliation
        Review completed tasks, update memory, log decisions.
        Sources
          roam_search — find today's tasks
          bt_get_tasks — Better Tasks query
          cos_update_memory — save end-of-day summary
          roam_create_block — log decisions
          cos_get_calendar — check what meetings happened
    `
  }
];

// Simulates parseSkillSources returning source objects
function mockParseSkillSources(content, knownToolNames) {
  const lines = String(content || "").split("\n");
  let inSources = false;
  let sourceIndent = -1;
  const sources = [];

  for (const line of lines) {
    if (!inSources) {
      if (/^\s*-?\s*Sources\s*(?:—|:)?/i.test(line)) {
        inSources = true;
        sourceIndent = (line.match(/^(\s*)/)?.[1] || "").length;
      }
      continue;
    }
    const indent = (line.match(/^(\s*)/)?.[1] || "").length;
    if (indent > sourceIndent && line.trim()) {
      const toolName = line.trim().replace(/^-\s*/, "").split(/\s*—\s*/)[0].trim();
      if (toolName) sources.push({ tool: toolName, description: line.trim() });
    } else if (line.trim()) {
      break;
    }
  }
  return sources;
}

const mockToolNames = new Set([
  "roam_search", "roam_create_block", "roam_pull_many",
  "cos_update_memory", "cos_get_calendar", "bt_get_tasks",
  "roam_update_block", "roam_delete_block"
]);

// ─── Strategy 1: Tool Count ─────────────────────────────────────────────────

section("Strategy 1: Tool Count");

(() => {
  // Should match "weekly review" skill → 4 sources
  const r = scoreToolCount("run my weekly review", {
    skillEntries: mockSkillEntries,
    knownToolNames: mockToolNames,
    parseSkillSources: mockParseSkillSources
  });
  assert(r.matchedSkill === "Weekly Review", "matches Weekly Review skill");
  assert(r.estimatedTools === 4, `estimated 4 tools (got ${r.estimatedTools})`);
  assertRange(r.score, 0.3, 0.7, "score in mid range for 4 tools");
})();

(() => {
  // Should match "quick add task" → 1 source
  const r = scoreToolCount("add a task for tomorrow", {
    skillEntries: mockSkillEntries,
    knownToolNames: mockToolNames,
    parseSkillSources: mockParseSkillSources
  });
  // May or may not match the skill — keyword fallback should give low tool count
  assertRange(r.score, 0.0, 0.4, "low score for simple task add");
})();

(() => {
  // No skill match, keyword fallback: email + calendar + tasks = 3 tools
  const r = scoreToolCount("check my email, calendar, and tasks for today", {
    skillEntries: mockSkillEntries,
    knownToolNames: mockToolNames,
    parseSkillSources: mockParseSkillSources
  });
  assert(r.estimatedTools >= 3, `estimated ≥3 tools from keywords (got ${r.estimatedTools})`);
  assertRange(r.score, 0.3, 0.7, "mid-range for multi-source keyword prompt");
})();

(() => {
  // Trivial prompt — no tools expected
  const r = scoreToolCount("hello", {
    skillEntries: mockSkillEntries,
    knownToolNames: mockToolNames,
    parseSkillSources: mockParseSkillSources
  });
  assert(r.score === 0, "zero score for trivial prompt");
  assert(r.estimatedTools === 0, "zero tools for trivial prompt");
})();

// ─── Strategy 2: Prompt Complexity ──────────────────────────────────────────

section("Strategy 2: Prompt Complexity");

(() => {
  const r = scorePromptComplexity("hello");
  assertRange(r.score, 0, 0.1, "trivial prompt scores near zero");
  assert(r.signals.length === 0, "no signals for trivial prompt");
})();

(() => {
  const r = scorePromptComplexity(
    "Compare my [[Project Alpha]] and [[Project Beta]] progress this week, " +
    "then summarize the key differences and suggest which one I should prioritize " +
    "based on upcoming deadlines. Also check if there are any overdue tasks."
  );
  assertRange(r.score, 0.4, 1.0, "complex multi-entity prompt scores high");
  assert(r.signals.includes("comparison"), "detects comparison");
  assert(r.signals.includes("synthesis"), "detects synthesis");
  assert(r.signals.includes("temporal_reasoning") || r.signals.includes("sequenced"),
    "detects temporal or sequenced intent");
})();

(() => {
  const r = scorePromptComplexity(
    "First gather all my tasks from this week. Then check which ones are overdue. " +
    "After that, update the project status page. Finally, send me a summary email."
  );
  assert(r.signals.includes("multi_step_chain"), "detects multi-step chain");
  assertRange(r.score, 0.4, 1.0, "multi-step chain scores high");
})();

(() => {
  const r = scorePromptComplexity("what time is it?");
  assertRange(r.score, 0, 0.15, "simple question scores very low");
})();

(() => {
  const r = scorePromptComplexity(
    "I'm not sure whether I should restructure the [[Q1 Roadmap]] or just " +
    "add the new items. What are the pros and cons? It's a comprehensive document " +
    "and I don't want to lose the context from last quarter's retrospective."
  );
  assert(r.signals.includes("deliberation"), "detects deliberation");
  assert(r.signals.includes("ambiguous"), "detects ambiguity");
  assertRange(r.score, 0.4, 1.0, "deliberation + ambiguity scores high");
})();

// ─── Strategy 4: Trajectory ─────────────────────────────────────────────────

section("Strategy 4: Trajectory");

(() => {
  sessionTrajectory.reset();
  const r = scoreTrajectory("anything");
  assert(r.score === 0, "zero score with no history");
  assert(r.signals.length === 0, "no signals with no history");
})();

(() => {
  sessionTrajectory.reset();
  // Simulate 3 heavy turns
  recordTurnOutcome({ toolCallCount: 6, iterations: 4, tier: "power", escalated: true });
  recordTurnOutcome({ toolCallCount: 5, iterations: 3, tier: "power", escalated: true });
  recordTurnOutcome({ toolCallCount: 7, iterations: 5, tier: "power", escalated: false });

  const r = scoreTrajectory("what about the project status?");
  assertRange(r.score, 0.4, 1.0, "high trajectory after heavy turns");
  assert(r.signals.includes("high_tool_trajectory") || r.signals.includes("moderate_tool_trajectory"),
    "detects tool trajectory signal");
  assert(r.signals.includes("repeated_escalation"), "detects repeated escalation");
})();

(() => {
  sessionTrajectory.reset();
  // Simulate a gathering turn followed by a short write follow-up
  recordTurnOutcome({ toolCallCount: 4, iterations: 2, tier: "mini", escalated: false });

  const r = scoreTrajectory("now apply those changes");
  assert(r.signals.includes("write_after_gather"), "detects write-after-gather");
  assert(r.signals.includes("complex_followup"), "detects complex follow-up");
  assertRange(r.score, 0.3, 1.0, "write-after-gather scores meaningfully");
})();

(() => {
  sessionTrajectory.reset();
  // Simulate simple turns
  recordTurnOutcome({ toolCallCount: 1, iterations: 1, tier: "mini", escalated: false });
  recordTurnOutcome({ toolCallCount: 0, iterations: 1, tier: "mini", escalated: false });

  const r = scoreTrajectory("what's the weather like?");
  assertRange(r.score, 0, 0.25, "low trajectory after simple turns");
})();

// ─── Composite Router ───────────────────────────────────────────────────────

section("Composite Router");

(() => {
  sessionTrajectory.reset();
  const r = computeRoutingScore("hello", {
    skillEntries: mockSkillEntries,
    knownToolNames: mockToolNames,
    parseSkillSourcesFn: mockParseSkillSources
  });
  assert(r.tier === "mini", `trivial prompt stays mini (got ${r.tier})`);
  assertRange(r.score, 0, 0.2, "trivial composite score near zero");
})();

(() => {
  sessionTrajectory.reset();
  const r = computeRoutingScore("run my weekly review and catch me up on everything", {
    skillEntries: mockSkillEntries,
    knownToolNames: mockToolNames,
    parseSkillSourcesFn: mockParseSkillSources
  });
  assert(r.tier === "power", `skill-heavy prompt escalates to power (got ${r.tier})`);
  assertRange(r.score, TIER_THRESHOLDS.power, 1.0, "composite above power threshold");
  assert(r.breakdown.toolCount.matchedSkill === "Weekly Review", "breakdown shows matched skill");
})();

(() => {
  sessionTrajectory.reset();
  // Build up trajectory with heavy turns
  recordTurnOutcome({ toolCallCount: 6, iterations: 5, tier: "power", escalated: true });
  recordTurnOutcome({ toolCallCount: 5, iterations: 4, tier: "power", escalated: true });

  const r = computeRoutingScore(
    "Now do the end of day reconciliation — compare what I planned versus what I actually " +
    "accomplished, then update the project pages and draft a retrospective note with " +
    "pros and cons of this week's approach.",
    {
      skillEntries: mockSkillEntries,
      knownToolNames: mockToolNames,
      parseSkillSourcesFn: mockParseSkillSources,
      ludicrousEnabled: true
    }
  );
  assertRange(r.score, 0.5, 1.0, "complex prompt with heavy trajectory scores very high");
  // With skill-ceiling cap, skill-matched queries are capped at power even if score >= ludicrous
  assert(r.tier === "power",
    `escalates to power (skill-ceiling caps ludicrous) (got ${r.tier})`);
})();

(() => {
  sessionTrajectory.reset();
  // Simple follow-up after simple turn
  recordTurnOutcome({ toolCallCount: 1, iterations: 1, tier: "mini", escalated: false });

  const r = computeRoutingScore("thanks", {
    skillEntries: mockSkillEntries,
    knownToolNames: mockToolNames,
    parseSkillSourcesFn: mockParseSkillSources
  });
  assert(r.tier === "mini", `simple follow-up stays mini (got ${r.tier})`);
})();

// ─── Edge Cases ─────────────────────────────────────────────────────────────

section("Edge Cases");

(() => {
  // No skill entries, no tool names — should degrade gracefully
  sessionTrajectory.reset();
  const r = computeRoutingScore("search for my tasks and email", {});
  assert(r.tier === "mini" || r.tier === "power", "works without skill entries");
  assert(r.breakdown.toolCount.estimated >= 2, "keyword fallback still works");
})();

(() => {
  // Empty prompt
  sessionTrajectory.reset();
  const r = computeRoutingScore("", {});
  assert(r.tier === "mini", "empty prompt stays mini");
  assert(r.score === 0 || r.score < 0.1, "empty prompt scores near zero");
})();

(() => {
  // Trajectory buffer limit (>8 turns should keep only last 8)
  sessionTrajectory.reset();
  for (let i = 0; i < 12; i++) {
    recordTurnOutcome({ toolCallCount: 3, iterations: 2, tier: "mini", escalated: false });
  }
  assert(sessionTrajectory.turns.length === 8, `trajectory capped at 8 (got ${sessionTrajectory.turns.length})`);
})();

(() => {
  // Reset clears trajectory
  sessionTrajectory.reset();
  recordTurnOutcome({ toolCallCount: 5, iterations: 4, tier: "power", escalated: true });
  sessionTrajectory.reset();
  assert(sessionTrajectory.turns.length === 0, "reset clears all turns");
  const r = scoreTrajectory("anything");
  assert(r.score === 0, "trajectory score is 0 after reset");
})();

// ─── Config Sanity ──────────────────────────────────────────────────────────

section("Config Sanity");

(() => {
  const weightSum = STRATEGY_WEIGHTS.toolCount + STRATEGY_WEIGHTS.promptComplexity + STRATEGY_WEIGHTS.trajectory;
  assert(Math.abs(weightSum - 1.0) < 0.001, `strategy weights sum to 1.0 (got ${weightSum})`);
})();

(() => {
  assert(TIER_THRESHOLDS.power < TIER_THRESHOLDS.ludicrous, "power threshold < ludicrous threshold");
  assert(TIER_THRESHOLDS.power > 0 && TIER_THRESHOLDS.power < 1, "power threshold in (0, 1)");
  assert(TIER_THRESHOLDS.ludicrous > 0 && TIER_THRESHOLDS.ludicrous < 1, "ludicrous threshold in (0, 1)");
})();

// ─── New Behaviour Tests ────────────────────────────────────────────────────

section("Multi-Entity Comparison (compound signal)");

(() => {
  // 2 page refs + "compare" should trigger multi_entity_comparison
  const r = scorePromptComplexity(
    "Compare my progress on [[CE ANZAHPE]] and [[Roam Extensions]] and suggest which I should prioritize based on upcoming"
  );
  assert(r.signals.includes("comparison"), "detects comparison");
  assert(r.signals.includes("multi_entity_comparison"), "detects multi_entity_comparison compound signal");
  assert(r.signals.includes("multiple_entities"), "detects multiple entities");
  // comparison (1.5) + multi_entity_comparison (1.5) + multiple_entities (1.0) + planning (1.0) + temporal (0.5) = 5.5
  assertRange(r.score, 0.45, 0.75, "multi-entity comparison scores above power threshold level");
})();

(() => {
  // Single entity + compare should NOT trigger compound signal
  const r = scorePromptComplexity("Compare the weather today versus yesterday");
  assert(r.signals.includes("comparison"), "detects comparison with single entity");
  assert(!r.signals.includes("multi_entity_comparison"), "no compound signal without 2+ entities");
})();

section("Trajectory Override: Complex Follow-up");

(() => {
  sessionTrajectory.reset();
  // Simulate a heavy skill-driven turn (many iterations, many tools)
  recordTurnOutcome({ toolCallCount: 8, iterations: 9, tier: "power", escalated: true });

  const r = computeRoutingScore("now apply those changes", {
    skillEntries: mockSkillEntries,
    knownToolNames: mockToolNames,
    parseSkillSourcesFn: mockParseSkillSources
  });
  assert(r.tier === "power", `short follow-up after complex turn should escalate to power (got ${r.tier})`);
  assert(r.signals.includes("complex_followup"), "detects complex_followup signal");
  assertRange(r.score, TIER_THRESHOLDS.power, 1.0, "trajectory override floors score at power threshold");
})();

(() => {
  sessionTrajectory.reset();
  // Simulate a simple turn — short follow-up should NOT override
  recordTurnOutcome({ toolCallCount: 1, iterations: 1, tier: "mini", escalated: false });

  const r = computeRoutingScore("now apply those changes", {
    skillEntries: mockSkillEntries,
    knownToolNames: mockToolNames,
    parseSkillSourcesFn: mockParseSkillSources
  });
  assert(r.tier === "mini", `short follow-up after simple turn stays mini (got ${r.tier})`);
})();

(() => {
  sessionTrajectory.reset();
  // Simulate a single-tool turn with guard-inflated iterations (empty-response retry)
  // This is the B2′→C1a bug: exportCitation used 1 tool but 3 iterations due to
  // empty response guard. "thanks" should NOT escalate as a complex_followup.
  recordTurnOutcome({ toolCallCount: 1, iterations: 3, tier: "mini", escalated: false });

  const r = scoreTrajectory("thanks");
  assert(!r.signals.includes("complex_followup"),
    "guard-inflated iterations (1 tool, 3 iters) should NOT trigger complex_followup");
})();

(() => {
  sessionTrajectory.reset();
  // But genuine multi-tool + multi-iteration turns SHOULD still trigger it
  recordTurnOutcome({ toolCallCount: 3, iterations: 4, tier: "mini", escalated: false });

  const r = scoreTrajectory("thanks");
  assert(r.signals.includes("complex_followup"),
    "genuine multi-tool turn (3 tools, 4 iters) should trigger complex_followup");
})();

(() => {
  sessionTrajectory.reset();
  // Repeated calls to the SAME hallucinated tool (e.g. cos_get-current-time) with
  // live-data guard retries: 2 tool calls but only 1 unique tool name across 4 iterations.
  // This should NOT be treated as a complex turn — it's a failure loop, not genuine work.
  recordTurnOutcome({ toolCallCount: 2, uniqueToolCount: 1, iterations: 4, tier: "mini", escalated: false });

  const r = scoreTrajectory("remind me what page I'm on");
  assert(!r.signals.includes("complex_followup"),
    "repeated same-tool failures (2 calls, 1 unique, 4 iters) should NOT trigger complex_followup");
})();

(() => {
  sessionTrajectory.reset();
  // "Struggling" turn: model called 3 different tools across 5 iterations trying to
  // answer "what's today's date?" but 2 out of 3 failed (cos_get-current-time not found,
  // get-current-time validation error). Only list-calendars succeeded but was irrelevant.
  // successfulUniqueToolCount = 1 → should NOT be complex.
  recordTurnOutcome({ toolCallCount: 3, uniqueToolCount: 3, successfulUniqueToolCount: 1, iterations: 5, tier: "mini", escalated: false });

  const r = scoreTrajectory("remind me what page I'm on");
  assert(!r.signals.includes("complex_followup"),
    "struggling turn (3 tools, 1 succeeded, 5 iters) should NOT trigger complex_followup");
})();

(() => {
  sessionTrajectory.reset();
  // Same total tool calls but 2+ UNIQUE successful tools — this IS genuinely complex
  recordTurnOutcome({ toolCallCount: 2, uniqueToolCount: 2, successfulUniqueToolCount: 2, iterations: 4, tier: "mini", escalated: false });

  const r = scoreTrajectory("remind me what page I'm on");
  assert(r.signals.includes("complex_followup"),
    "multi-unique-tool turn (2 calls, 2 unique, 4 iters) should trigger complex_followup");
})();

section("Write-After-Gather (relaxed iterations)");

(() => {
  sessionTrajectory.reset();
  // Simulate a gathering turn with MANY iterations (skill-driven sequential tool calls)
  recordTurnOutcome({ toolCallCount: 6, iterations: 9, tier: "power", escalated: true });

  const r = scoreTrajectory("now apply those changes");
  assert(r.signals.includes("write_after_gather"), "detects write-after-gather even with high iterations");
  assert(r.signals.includes("complex_followup"), "also detects complex_followup");
})();

section("Skill-Ceiling Cap (ludicrous → power for skill-matched)");

(() => {
  sessionTrajectory.reset();
  // Build trajectory to push score very high
  recordTurnOutcome({ toolCallCount: 7, iterations: 5, tier: "power", escalated: true });
  recordTurnOutcome({ toolCallCount: 6, iterations: 4, tier: "power", escalated: true });

  const r = computeRoutingScore(
    "Do the end of day reconciliation — compare what I planned versus what I did, " +
    "update the project pages, draft a retrospective with pros and cons",
    {
      skillEntries: mockSkillEntries,
      knownToolNames: mockToolNames,
      parseSkillSourcesFn: mockParseSkillSources,
      ludicrousEnabled: true
    }
  );
  // Should match "End of Day Reconciliation" skill and cap at power
  if (r.breakdown.toolCount.matchedSkill) {
    assert(r.tier === "power", `skill-matched query capped at power (got ${r.tier}, skill: ${r.breakdown.toolCount.matchedSkill})`);
    assert(r.reason.includes("skill-matched"), "reason mentions skill-ceiling cap");
  } else {
    // If no skill match, it may legitimately go ludicrous — just verify it escalated
    assert(r.tier !== "mini", `complex prompt at least escalates from mini (got ${r.tier})`);
  }
})();

section("Direct MCP Server Mention (soft signal)");

(() => {
  sessionTrajectory.reset();
  // Use a very simple prompt that scores well below power threshold on its own
  const base = computeRoutingScore("check the weather", {
    skillEntries: mockSkillEntries,
    knownToolNames: mockToolNames,
    parseSkillSourcesFn: mockParseSkillSources
  });
  const withMcp = computeRoutingScore("check the weather", {
    skillEntries: mockSkillEntries,
    knownToolNames: mockToolNames,
    parseSkillSourcesFn: mockParseSkillSources,
    mentionsDirectMcpServer: true
  });
  assert(withMcp.score > base.score, `direct MCP mention adds soft signal (${base.score.toFixed(3)} → ${withMcp.score.toFixed(3)})`);
  assert(withMcp.score - base.score < 0.15, "soft signal is modest, not a hard override");
  // Simple query should still stay mini even with MCP mention
  assert(withMcp.tier === "mini", `simple query stays mini even with direct MCP (got ${withMcp.tier})`);
})();

section("sessionUsedLocalMcp Soft Signal (Issue #8)");

(() => {
  sessionTrajectory.reset();
  // Trivial follow-up in an MCP session should NOT force-escalate to power
  const r = computeRoutingScore("thanks", {
    skillEntries: mockSkillEntries,
    knownToolNames: mockToolNames,
    parseSkillSourcesFn: mockParseSkillSources,
    sessionUsedLocalMcp: true
  });
  assert(r.tier === "mini", `trivial MCP follow-up stays mini (got ${r.tier})`);
  assert(r.signals.includes("mcp_session_followup"), "includes mcp_session_followup signal");
})();

(() => {
  sessionTrajectory.reset();
  // Simple short question in MCP session — boost alone shouldn't cross power threshold
  const base = computeRoutingScore("what time is it?", {
    skillEntries: mockSkillEntries,
    knownToolNames: mockToolNames,
    parseSkillSourcesFn: mockParseSkillSources
  });
  const withMcp = computeRoutingScore("what time is it?", {
    skillEntries: mockSkillEntries,
    knownToolNames: mockToolNames,
    parseSkillSourcesFn: mockParseSkillSources,
    sessionUsedLocalMcp: true
  });
  assert(withMcp.score > base.score, `MCP session adds soft boost (${base.score.toFixed(3)} → ${withMcp.score.toFixed(3)})`);
  assert(withMcp.score - base.score >= 0.14 && withMcp.score - base.score <= 0.16,
    `boost is ~0.15 (got ${(withMcp.score - base.score).toFixed(3)})`);
  assert(withMcp.tier === "mini", `simple question stays mini even in MCP session (got ${withMcp.tier})`);
})();

(() => {
  sessionTrajectory.reset();
  // Substantive MCP follow-up after complex turn SHOULD escalate via trajectory + MCP boost
  recordTurnOutcome({ toolCallCount: 5, iterations: 4, tier: "power", escalated: true });
  recordTurnOutcome({ toolCallCount: 4, iterations: 3, tier: "power", escalated: true });

  const r = computeRoutingScore("now search for the recent papers on that topic", {
    skillEntries: mockSkillEntries,
    knownToolNames: mockToolNames,
    parseSkillSourcesFn: mockParseSkillSources,
    sessionUsedLocalMcp: true
  });
  assert(r.tier === "power", `substantive MCP follow-up after complex turns escalates to power (got ${r.tier})`);
  assert(r.signals.includes("mcp_session_followup"), "includes mcp_session_followup signal");
})();

(() => {
  sessionTrajectory.reset();
  // MCP boost is stronger than direct MCP mention boost
  const withDirectMention = computeRoutingScore("hello", {
    mentionsDirectMcpServer: true
  });
  const withSession = computeRoutingScore("hello", {
    sessionUsedLocalMcp: true
  });
  assert(withSession.score > withDirectMention.score,
    `session boost (${withSession.score.toFixed(3)}) > direct mention boost (${withDirectMention.score.toFixed(3)})`);
})();

(() => {
  sessionTrajectory.reset();
  // Both signals should stack
  const withBoth = computeRoutingScore("hello", {
    mentionsDirectMcpServer: true,
    sessionUsedLocalMcp: true
  });
  const withSessionOnly = computeRoutingScore("hello", {
    sessionUsedLocalMcp: true
  });
  assert(withBoth.score > withSessionOnly.score,
    `both signals stack (${withSessionOnly.score.toFixed(3)} → ${withBoth.score.toFixed(3)})`);
})();

// ─── Summary ────────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(50)}`);
console.log(`  ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log(`\n  Failures:`);
  for (const f of failures) console.log(`    ✗ ${f}`);
}
console.log();
process.exit(failed > 0 ? 1 : 0);
