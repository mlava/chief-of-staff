import test from "node:test";
import assert from "node:assert/strict";
import {
  scoreToolCount,
  scorePromptComplexity,
  scoreTrajectory,
  computeRoutingScore,
  recordTurnOutcome,
  sessionTrajectory,
  TIER_THRESHOLDS,
  STRATEGY_WEIGHTS,
} from "../src/tier-routing.js";

// ═════════════════════════════════════════════════════════════════════════════
// Helpers
// ═════════════════════════════════════════════════════════════════════════════

function assertRange(value, min, max, label) {
  assert.ok(
    value >= min && value <= max,
    `${label} → ${value.toFixed(3)} not in [${min}, ${max}]`
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Mock data
// ═════════════════════════════════════════════════════════════════════════════

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
    `,
  },
  {
    title: "Quick Add Task",
    content: `
      Quick Add Task
        Create a task block on today's page.
        Sources
          roam_create_block — add the task
    `,
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
    `,
  },
];

function mockParseSkillSources(content) {
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
  "roam_update_block", "roam_delete_block",
]);

const defaultOpts = {
  skillEntries: mockSkillEntries,
  knownToolNames: mockToolNames,
  parseSkillSourcesFn: mockParseSkillSources,
};

// ═════════════════════════════════════════════════════════════════════════════
// Strategy 1: Tool Count
// ═════════════════════════════════════════════════════════════════════════════

test("scoreToolCount: matches Weekly Review skill → 4 sources", () => {
  const r = scoreToolCount("run my weekly review", {
    skillEntries: mockSkillEntries,
    knownToolNames: mockToolNames,
    parseSkillSources: mockParseSkillSources,
  });
  assert.equal(r.matchedSkill, "Weekly Review");
  assert.equal(r.estimatedTools, 4);
  assertRange(r.score, 0.3, 0.7, "mid-range for 4 tools");
});

test("scoreToolCount: low score for simple task add", () => {
  const r = scoreToolCount("add a task for tomorrow", {
    skillEntries: mockSkillEntries,
    knownToolNames: mockToolNames,
    parseSkillSources: mockParseSkillSources,
  });
  assertRange(r.score, 0.0, 0.4, "low score for simple task");
});

test("scoreToolCount: keyword fallback for multi-source prompt", () => {
  const r = scoreToolCount("check my email, calendar, and tasks for today", {
    skillEntries: mockSkillEntries,
    knownToolNames: mockToolNames,
    parseSkillSources: mockParseSkillSources,
  });
  assert.ok(r.estimatedTools >= 3, `expected ≥3 tools, got ${r.estimatedTools}`);
  assertRange(r.score, 0.3, 0.7, "mid-range for multi-source keywords");
});

test("scoreToolCount: zero for trivial prompt", () => {
  const r = scoreToolCount("hello", {
    skillEntries: mockSkillEntries,
    knownToolNames: mockToolNames,
    parseSkillSources: mockParseSkillSources,
  });
  assert.equal(r.score, 0);
  assert.equal(r.estimatedTools, 0);
});

// ═════════════════════════════════════════════════════════════════════════════
// Strategy 2: Prompt Complexity
// ═════════════════════════════════════════════════════════════════════════════

test("scorePromptComplexity: trivial prompt scores near zero", () => {
  const r = scorePromptComplexity("hello");
  assertRange(r.score, 0, 0.1, "trivial prompt");
  assert.equal(r.signals.length, 0);
});

test("scorePromptComplexity: complex multi-entity prompt scores high", () => {
  const r = scorePromptComplexity(
    "Compare my [[Project Alpha]] and [[Project Beta]] progress this week, " +
    "then summarize the key differences and suggest which one I should prioritize " +
    "based on upcoming deadlines. Also check if there are any overdue tasks."
  );
  assertRange(r.score, 0.4, 1.0, "complex prompt");
  assert.ok(r.signals.includes("comparison"));
  assert.ok(r.signals.includes("synthesis"));
  assert.ok(
    r.signals.includes("temporal_reasoning") || r.signals.includes("sequenced"),
    "detects temporal or sequenced intent"
  );
});

test("scorePromptComplexity: multi-step chain detected", () => {
  const r = scorePromptComplexity(
    "First gather all my tasks from this week. Then check which ones are overdue. " +
    "After that, update the project status page. Finally, send me a summary email."
  );
  assert.ok(r.signals.includes("multi_step_chain"));
  assertRange(r.score, 0.4, 1.0, "multi-step chain");
});

test("scorePromptComplexity: simple question scores very low", () => {
  const r = scorePromptComplexity("what time is it?");
  assertRange(r.score, 0, 0.15, "simple question");
});

test("scorePromptComplexity: deliberation + ambiguity detected", () => {
  const r = scorePromptComplexity(
    "I'm not sure whether I should restructure the [[Q1 Roadmap]] or just " +
    "add the new items. What are the pros and cons? It's a comprehensive document " +
    "and I don't want to lose the context from last quarter's retrospective."
  );
  assert.ok(r.signals.includes("deliberation"));
  assert.ok(r.signals.includes("ambiguous"));
  assertRange(r.score, 0.4, 1.0, "deliberation + ambiguity");
});

// ═════════════════════════════════════════════════════════════════════════════
// Strategy 4: Trajectory
// ═════════════════════════════════════════════════════════════════════════════

test("scoreTrajectory: zero score with no history", () => {
  sessionTrajectory.reset();
  const r = scoreTrajectory("anything");
  assert.equal(r.score, 0);
  assert.equal(r.signals.length, 0);
});

test("scoreTrajectory: high score after heavy turns", () => {
  sessionTrajectory.reset();
  recordTurnOutcome({ toolCallCount: 6, iterations: 4, tier: "power", escalated: true });
  recordTurnOutcome({ toolCallCount: 5, iterations: 3, tier: "power", escalated: true });
  recordTurnOutcome({ toolCallCount: 7, iterations: 5, tier: "power", escalated: false });

  const r = scoreTrajectory("what about the project status?");
  assertRange(r.score, 0.4, 1.0, "heavy trajectory");
  assert.ok(
    r.signals.includes("high_tool_trajectory") || r.signals.includes("moderate_tool_trajectory")
  );
  assert.ok(r.signals.includes("repeated_escalation"));
});

test("scoreTrajectory: write-after-gather detection", () => {
  sessionTrajectory.reset();
  recordTurnOutcome({ toolCallCount: 4, iterations: 2, tier: "mini", escalated: false });

  const r = scoreTrajectory("now apply those changes");
  assert.ok(r.signals.includes("write_after_gather"));
  assert.ok(r.signals.includes("complex_followup"));
  assertRange(r.score, 0.3, 1.0, "write-after-gather");
});

test("scoreTrajectory: low after simple turns", () => {
  sessionTrajectory.reset();
  recordTurnOutcome({ toolCallCount: 1, iterations: 1, tier: "mini", escalated: false });
  recordTurnOutcome({ toolCallCount: 0, iterations: 1, tier: "mini", escalated: false });

  const r = scoreTrajectory("what's the weather like?");
  assertRange(r.score, 0, 0.25, "low trajectory");
});

// ═════════════════════════════════════════════════════════════════════════════
// Composite Router
// ═════════════════════════════════════════════════════════════════════════════

test("computeRoutingScore: trivial prompt stays mini", () => {
  sessionTrajectory.reset();
  const r = computeRoutingScore("hello", defaultOpts);
  assert.equal(r.tier, "mini");
  assertRange(r.score, 0, 0.2, "trivial composite");
});

test("computeRoutingScore: skill-heavy prompt escalates to power", () => {
  sessionTrajectory.reset();
  const r = computeRoutingScore("run my weekly review and catch me up on everything", defaultOpts);
  assert.equal(r.tier, "power");
  assertRange(r.score, TIER_THRESHOLDS.power, 1.0, "above power threshold");
  assert.equal(r.breakdown.toolCount.matchedSkill, "Weekly Review");
});

test("computeRoutingScore: complex prompt with trajectory caps at power (skill-ceiling)", () => {
  sessionTrajectory.reset();
  recordTurnOutcome({ toolCallCount: 6, iterations: 5, tier: "power", escalated: true });
  recordTurnOutcome({ toolCallCount: 5, iterations: 4, tier: "power", escalated: true });

  const r = computeRoutingScore(
    "Now do the end of day reconciliation — compare what I planned versus what I actually " +
    "accomplished, then update the project pages and draft a retrospective note with " +
    "pros and cons of this week's approach.",
    { ...defaultOpts, ludicrousEnabled: true }
  );
  assertRange(r.score, 0.5, 1.0, "complex + heavy trajectory");
  assert.equal(r.tier, "power");
});

test("computeRoutingScore: simple follow-up stays mini", () => {
  sessionTrajectory.reset();
  recordTurnOutcome({ toolCallCount: 1, iterations: 1, tier: "mini", escalated: false });

  const r = computeRoutingScore("thanks", defaultOpts);
  assert.equal(r.tier, "mini");
});

// ═════════════════════════════════════════════════════════════════════════════
// Edge Cases
// ═════════════════════════════════════════════════════════════════════════════

test("computeRoutingScore: works without skill entries (graceful degradation)", () => {
  sessionTrajectory.reset();
  const r = computeRoutingScore("search for my tasks and email", {});
  assert.ok(r.tier === "mini" || r.tier === "power");
  assert.ok(r.breakdown.toolCount.estimated >= 2);
});

test("computeRoutingScore: empty prompt stays mini", () => {
  sessionTrajectory.reset();
  const r = computeRoutingScore("", {});
  assert.equal(r.tier, "mini");
  assert.ok(r.score === 0 || r.score < 0.1);
});

test("sessionTrajectory: buffer capped at 8 turns", () => {
  sessionTrajectory.reset();
  for (let i = 0; i < 12; i++) {
    recordTurnOutcome({ toolCallCount: 3, iterations: 2, tier: "mini", escalated: false });
  }
  assert.equal(sessionTrajectory.turns.length, 8);
});

test("sessionTrajectory: reset clears all turns", () => {
  sessionTrajectory.reset();
  recordTurnOutcome({ toolCallCount: 5, iterations: 4, tier: "power", escalated: true });
  sessionTrajectory.reset();
  assert.equal(sessionTrajectory.turns.length, 0);
  const r = scoreTrajectory("anything");
  assert.equal(r.score, 0);
});

// ═════════════════════════════════════════════════════════════════════════════
// Config Sanity
// ═════════════════════════════════════════════════════════════════════════════

test("STRATEGY_WEIGHTS sum to 1.0", () => {
  const sum = STRATEGY_WEIGHTS.toolCount + STRATEGY_WEIGHTS.promptComplexity + STRATEGY_WEIGHTS.trajectory;
  assert.ok(Math.abs(sum - 1.0) < 0.001, `got ${sum}`);
});

test("TIER_THRESHOLDS: power < ludicrous, both in (0, 1)", () => {
  assert.ok(TIER_THRESHOLDS.power < TIER_THRESHOLDS.ludicrous);
  assert.ok(TIER_THRESHOLDS.power > 0 && TIER_THRESHOLDS.power < 1);
  assert.ok(TIER_THRESHOLDS.ludicrous > 0 && TIER_THRESHOLDS.ludicrous < 1);
});

// ═════════════════════════════════════════════════════════════════════════════
// Multi-Entity Comparison (compound signal)
// ═════════════════════════════════════════════════════════════════════════════

test("scorePromptComplexity: multi-entity comparison compound signal", () => {
  const r = scorePromptComplexity(
    "Compare my progress on [[CE ANZAHPE]] and [[Roam Extensions]] and suggest which I should prioritize based on upcoming"
  );
  assert.ok(r.signals.includes("comparison"));
  assert.ok(r.signals.includes("multi_entity_comparison"));
  assert.ok(r.signals.includes("multiple_entities"));
  assertRange(r.score, 0.45, 0.75, "multi-entity comparison");
});

test("scorePromptComplexity: single entity + compare has no compound signal", () => {
  const r = scorePromptComplexity("Compare the weather today versus yesterday");
  assert.ok(r.signals.includes("comparison"));
  assert.ok(!r.signals.includes("multi_entity_comparison"));
});

// ═════════════════════════════════════════════════════════════════════════════
// Trajectory Override: Complex Follow-up
// ═════════════════════════════════════════════════════════════════════════════

test("computeRoutingScore: short follow-up after complex turn escalates to power", () => {
  sessionTrajectory.reset();
  recordTurnOutcome({ toolCallCount: 8, iterations: 9, tier: "power", escalated: true });

  const r = computeRoutingScore("now apply those changes", defaultOpts);
  assert.equal(r.tier, "power");
  assert.ok(r.signals.includes("complex_followup"));
  assertRange(r.score, TIER_THRESHOLDS.power, 1.0, "trajectory override");
});

test("computeRoutingScore: short follow-up after simple turn stays mini", () => {
  sessionTrajectory.reset();
  recordTurnOutcome({ toolCallCount: 1, iterations: 1, tier: "mini", escalated: false });

  const r = computeRoutingScore("now apply those changes", defaultOpts);
  assert.equal(r.tier, "mini");
});

test("scoreTrajectory: guard-inflated iterations (1 tool, 3 iters) does NOT trigger complex_followup", () => {
  sessionTrajectory.reset();
  recordTurnOutcome({ toolCallCount: 1, iterations: 3, tier: "mini", escalated: false });

  const r = scoreTrajectory("thanks");
  assert.ok(!r.signals.includes("complex_followup"));
});

test("scoreTrajectory: genuine multi-tool turn (3 tools, 4 iters) triggers complex_followup", () => {
  sessionTrajectory.reset();
  recordTurnOutcome({ toolCallCount: 3, iterations: 4, tier: "mini", escalated: false });

  const r = scoreTrajectory("thanks");
  assert.ok(r.signals.includes("complex_followup"));
});

test("scoreTrajectory: repeated same-tool failures do NOT trigger complex_followup", () => {
  sessionTrajectory.reset();
  recordTurnOutcome({ toolCallCount: 2, uniqueToolCount: 1, iterations: 4, tier: "mini", escalated: false });

  const r = scoreTrajectory("remind me what page I'm on");
  assert.ok(!r.signals.includes("complex_followup"));
});

test("scoreTrajectory: struggling turn (3 tools, 1 succeeded) does NOT trigger complex_followup", () => {
  sessionTrajectory.reset();
  recordTurnOutcome({ toolCallCount: 3, uniqueToolCount: 3, successfulUniqueToolCount: 1, iterations: 5, tier: "mini", escalated: false });

  const r = scoreTrajectory("remind me what page I'm on");
  assert.ok(!r.signals.includes("complex_followup"));
});

test("scoreTrajectory: multi-unique-tool turn (2 unique, 2 succeeded) triggers complex_followup", () => {
  sessionTrajectory.reset();
  recordTurnOutcome({ toolCallCount: 2, uniqueToolCount: 2, successfulUniqueToolCount: 2, iterations: 4, tier: "mini", escalated: false });

  const r = scoreTrajectory("remind me what page I'm on");
  assert.ok(r.signals.includes("complex_followup"));
});

// ═════════════════════════════════════════════════════════════════════════════
// Write-After-Gather (relaxed iterations)
// ═════════════════════════════════════════════════════════════════════════════

test("scoreTrajectory: write-after-gather with high iterations", () => {
  sessionTrajectory.reset();
  recordTurnOutcome({ toolCallCount: 6, iterations: 9, tier: "power", escalated: true });

  const r = scoreTrajectory("now apply those changes");
  assert.ok(r.signals.includes("write_after_gather"));
  assert.ok(r.signals.includes("complex_followup"));
});

// ═════════════════════════════════════════════════════════════════════════════
// Skill-Ceiling Cap
// ═════════════════════════════════════════════════════════════════════════════

test("computeRoutingScore: skill-ceiling caps ludicrous to power", () => {
  sessionTrajectory.reset();
  recordTurnOutcome({ toolCallCount: 7, iterations: 5, tier: "power", escalated: true });
  recordTurnOutcome({ toolCallCount: 6, iterations: 4, tier: "power", escalated: true });

  const r = computeRoutingScore(
    "Do the end of day reconciliation — compare what I planned versus what I did, " +
    "update the project pages, draft a retrospective with pros and cons",
    { ...defaultOpts, ludicrousEnabled: true }
  );
  if (r.breakdown.toolCount.matchedSkill) {
    assert.equal(r.tier, "power");
    assert.ok(r.reason.includes("skill-matched"));
  } else {
    assert.notEqual(r.tier, "mini");
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Direct MCP Server Mention (soft signal)
// ═════════════════════════════════════════════════════════════════════════════

test("computeRoutingScore: direct MCP mention adds modest soft signal", () => {
  sessionTrajectory.reset();
  const base = computeRoutingScore("check the weather", defaultOpts);
  const withMcp = computeRoutingScore("check the weather", {
    ...defaultOpts,
    mentionsDirectMcpServer: true,
  });
  assert.ok(withMcp.score > base.score);
  assert.ok(withMcp.score - base.score < 0.15, "soft signal is modest");
  assert.equal(withMcp.tier, "mini");
});

// ═════════════════════════════════════════════════════════════════════════════
// sessionUsedLocalMcp Soft Signal
// ═════════════════════════════════════════════════════════════════════════════

test("computeRoutingScore: trivial MCP follow-up stays mini", () => {
  sessionTrajectory.reset();
  const r = computeRoutingScore("thanks", { ...defaultOpts, sessionUsedLocalMcp: true });
  assert.equal(r.tier, "mini");
  assert.ok(r.signals.includes("mcp_session_followup"));
});

test("computeRoutingScore: MCP session adds ~0.15 soft boost", () => {
  sessionTrajectory.reset();
  const base = computeRoutingScore("what time is it?", defaultOpts);
  const withMcp = computeRoutingScore("what time is it?", {
    ...defaultOpts,
    sessionUsedLocalMcp: true,
  });
  assert.ok(withMcp.score > base.score);
  const delta = withMcp.score - base.score;
  assert.ok(delta >= 0.14 && delta <= 0.16, `expected ~0.15 boost, got ${delta.toFixed(3)}`);
  assert.equal(withMcp.tier, "mini");
});

test("computeRoutingScore: substantive MCP follow-up after complex turns escalates", () => {
  sessionTrajectory.reset();
  recordTurnOutcome({ toolCallCount: 5, iterations: 4, tier: "power", escalated: true });
  recordTurnOutcome({ toolCallCount: 4, iterations: 3, tier: "power", escalated: true });

  const r = computeRoutingScore("now search for the recent papers on that topic", {
    ...defaultOpts,
    sessionUsedLocalMcp: true,
  });
  assert.equal(r.tier, "power");
  assert.ok(r.signals.includes("mcp_session_followup"));
});

test("computeRoutingScore: MCP session boost > direct mention boost", () => {
  sessionTrajectory.reset();
  const withDirect = computeRoutingScore("hello", { mentionsDirectMcpServer: true });
  const withSession = computeRoutingScore("hello", { sessionUsedLocalMcp: true });
  assert.ok(withSession.score > withDirect.score);
});

test("computeRoutingScore: both MCP signals stack", () => {
  sessionTrajectory.reset();
  const withSession = computeRoutingScore("hello", { sessionUsedLocalMcp: true });
  const withBoth = computeRoutingScore("hello", {
    mentionsDirectMcpServer: true,
    sessionUsedLocalMcp: true,
  });
  assert.ok(withBoth.score > withSession.score);
});
