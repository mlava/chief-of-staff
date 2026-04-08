// =============================================================================
// skill-autoresearch.test.mjs — Tests for skill-autoresearch.js (#98)
// =============================================================================

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  initSkillAutoresearch,
  runSkillOptimization,
  parseSkillOptimizeIntent,
  isOptimizationRunning,
  computePassRate,
  detectRegression,
  detectUnprovableCriteria,
  selectMutationAspect,
  detectMissingSections,
  hasSourcesWithParameterHints,
  validateAndFixToolReferences,
  shouldStop,
  parseFirstLevelSections,
  restoreDroppedSections,
  repairTruncatedTail,
  preserveSectionLines,
  OPTIMIZATION_DEFAULTS,
} from "../src/skill-autoresearch.js";

// ── Test helpers ────────────────────────────────────────────────────────────

function makeDeps(overrides = {}) {
  return {
    callLlmMini: async () => makeMockLlmResponse("{}"),
    callLlmJudge: async () => makeMockLlmResponse("{}"),
    findSkillEntryByName: async () => ({
      title: "Test Skill",
      uid: "skill-uid-1",
      content: "- Test Skill\n  - Trigger: test\n  - Approach: do things\n  - Output: result",
      childrenContent: "- Trigger: test\n- Approach: do things\n- Output: result",
    }),
    updateChiefMemory: async () => ({ success: true }),
    getModelCostRates: () => ({ inputPerM: 0.25, outputPerM: 1.25 }),
    recordCostEntry: () => {},
    accumulateSessionTokens: () => {},
    isDailyCapExceeded: () => ({ exceeded: false, cap: 10, spent: 0 }),
    scoreWithBinaryChecks: async (_resp, checks) => ({
      results: checks.map(c => ({ id: c.id, pass: true, reason: null })),
      cost: 0.001,
      inputTokens: 100,
      outputTokens: 50,
    }),
    ensurePageUidByTitle: async () => "page-uid-1",
    createRoamBlock: async () => "block-uid-1",
    formatRoamDate: () => "March 31st, 2026",
    showOptimizationResultToast: async ({ onAccept }) => { onAccept(); return "accepted"; },
    debugLog: () => {},
    getExtensionAPIRef: () => ({ settings: { get: () => null, set: () => {} } }),
    getSettingString: () => "2.00",
    SETTINGS_KEYS: { skillAutoresearchBudget: "skill-autoresearch-budget" },
    extractBalancedJsonObjects: () => [],
    isOpenAICompatible: () => true,
    getMiniProvider: () => "openai",
    getMiniModel: () => "gpt-4o-mini",
    getJudgeConfig: () => ({ provider: "anthropic", apiKey: "test-key", model: "claude-haiku" }),
    parseSkillSources: () => [],
    parseSkillTools: () => [],
    findClosestToolName: () => null,
    getKnownToolNames: async () => new Set(),
    ...overrides,
  };
}

function makeMockLlmResponse(content, inputTokens = 100, outputTokens = 50) {
  return {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens },
  };
}

function makeSetupResponse(testCaseCount = 3, criteriaCount = 2) {
  const testCases = Array.from({ length: testCaseCount }, (_, i) => ({
    prompt: `Test prompt ${i + 1}`,
    expectedBehavior: `Expected behavior ${i + 1}`,
  }));
  const evalCriteria = Array.from({ length: criteriaCount }, (_, i) => ({
    id: `criterion_${i + 1}`,
    prompt: `Does the response satisfy criterion ${i + 1}?`,
  }));
  return JSON.stringify({ testCases, evalCriteria });
}

// ── Intent Parsing ──────────────────────────────────────────────────────────

describe("parseSkillOptimizeIntent", () => {
  it("matches 'optimize my Daily Briefing skill'", () => {
    const result = parseSkillOptimizeIntent("optimize my Daily Briefing skill");
    assert.deepStrictEqual(result, { skillName: "Daily Briefing", withTools: false, powerMutations: false });
  });

  it("matches 'improve the research skill'", () => {
    const result = parseSkillOptimizeIntent("improve the research skill");
    assert.deepStrictEqual(result, { skillName: "research", withTools: false, powerMutations: false });
  });

  it("matches British spelling 'optimise my writing skill'", () => {
    const result = parseSkillOptimizeIntent("optimise my writing skill");
    assert.deepStrictEqual(result, { skillName: "writing", withTools: false, powerMutations: false });
  });

  it("matches 'refine Daily Briefing'", () => {
    const result = parseSkillOptimizeIntent("refine Daily Briefing");
    assert.deepStrictEqual(result, { skillName: "Daily Briefing", withTools: false, powerMutations: false });
  });

  it("matches 'enhance my Task Triage skill'", () => {
    const result = parseSkillOptimizeIntent("enhance my Task Triage skill");
    assert.deepStrictEqual(result, { skillName: "Task Triage", withTools: false, powerMutations: false });
  });

  it("matches with 'please' prefix", () => {
    const result = parseSkillOptimizeIntent("please optimize my briefing skill");
    assert.deepStrictEqual(result, { skillName: "briefing", withTools: false, powerMutations: false });
  });

  it("matches quoted skill name", () => {
    const result = parseSkillOptimizeIntent('optimize "Daily Briefing"');
    assert.deepStrictEqual(result, { skillName: "Daily Briefing", withTools: false, powerMutations: false });
  });

  it("parses --with-tools flag", () => {
    const result = parseSkillOptimizeIntent("optimise Daily Briefing --with-tools");
    assert.deepStrictEqual(result, { skillName: "Daily Briefing", withTools: true, powerMutations: false });
  });

  it("parses --with-tools flag with quoted name", () => {
    const result = parseSkillOptimizeIntent('optimize "Daily Briefing" --with-tools');
    assert.deepStrictEqual(result, { skillName: "Daily Briefing", withTools: true, powerMutations: false });
  });

  it("parses --power flag", () => {
    const result = parseSkillOptimizeIntent("optimise Daily Briefing --power");
    assert.deepStrictEqual(result, { skillName: "Daily Briefing", withTools: false, powerMutations: true });
  });

  it("parses --power-mutations flag", () => {
    const result = parseSkillOptimizeIntent("optimise Daily Briefing --power-mutations");
    assert.deepStrictEqual(result, { skillName: "Daily Briefing", withTools: false, powerMutations: true });
  });

  it("parses both --with-tools and --power flags", () => {
    const result = parseSkillOptimizeIntent("optimise Daily Briefing --with-tools --power");
    assert.deepStrictEqual(result, { skillName: "Daily Briefing", withTools: true, powerMutations: true });
  });

  it("returns null for 'run skill Daily Briefing'", () => {
    assert.strictEqual(parseSkillOptimizeIntent("run skill Daily Briefing"), null);
  });

  it("returns null for 'apply skill research'", () => {
    assert.strictEqual(parseSkillOptimizeIntent("apply skill research"), null);
  });

  it("returns null for empty string", () => {
    assert.strictEqual(parseSkillOptimizeIntent(""), null);
  });

  it("returns null for null input", () => {
    assert.strictEqual(parseSkillOptimizeIntent(null), null);
  });

  it("returns null for unrelated text", () => {
    assert.strictEqual(parseSkillOptimizeIntent("what are my tasks for today"), null);
  });
});

// ── computePassRate ─────────────────────────────────────────────────────────

describe("computePassRate", () => {
  it("returns 1.0 when all pass", () => {
    const scores = [
      { testCaseIdx: 0, results: [{ id: "a", pass: true }, { id: "b", pass: true }] },
      { testCaseIdx: 1, results: [{ id: "a", pass: true }, { id: "b", pass: true }] },
    ];
    assert.strictEqual(computePassRate(scores, 2), 1.0);
  });

  it("returns 0.5 when half pass", () => {
    const scores = [
      { testCaseIdx: 0, results: [{ id: "a", pass: true }, { id: "b", pass: false }] },
      { testCaseIdx: 1, results: [{ id: "a", pass: true }, { id: "b", pass: false }] },
    ];
    assert.strictEqual(computePassRate(scores, 2), 0.5);
  });

  it("returns 0 when none pass", () => {
    const scores = [
      { testCaseIdx: 0, results: [{ id: "a", pass: false }] },
    ];
    assert.strictEqual(computePassRate(scores, 1), 0);
  });

  it("returns 0 for empty scores", () => {
    assert.strictEqual(computePassRate([], 3), 0);
  });

  it("returns 0 for zero criteria count", () => {
    assert.strictEqual(computePassRate([{ testCaseIdx: 0, results: [] }], 0), 0);
  });

  it("handles partial results (fewer results than criteria)", () => {
    const scores = [
      { testCaseIdx: 0, results: [{ id: "a", pass: true }] },
    ];
    // 1 pass out of (1 test * 3 criteria) = 0.333...
    const rate = computePassRate(scores, 3);
    assert.ok(Math.abs(rate - 1 / 3) < 0.001);
  });
});

// ── detectRegression ────────────────────────────────────────────────────────

describe("detectRegression", () => {
  const makeScores = (passMap) =>
    Object.entries(passMap).map(([idx, results]) => ({
      testCaseIdx: parseInt(idx),
      results: results.map(([id, pass]) => ({ id, pass })),
    }));

  it("returns null when no regression", () => {
    const baseline = makeScores({
      0: [["a", true], ["b", true]],
      1: [["a", true], ["b", true]],
    });
    const candidate = makeScores({
      0: [["a", true], ["b", true]],
      1: [["a", true], ["b", true]],
    });
    assert.strictEqual(detectRegression(baseline, candidate), null);
  });

  it("returns null when criterion had baseline failures", () => {
    const baseline = makeScores({
      0: [["a", true], ["b", false]],
      1: [["a", true], ["b", true]],
    });
    const candidate = makeScores({
      0: [["a", true], ["b", false]],
      1: [["a", true], ["b", false]],
    });
    // "b" already failed in baseline, so this is not a regression
    assert.strictEqual(detectRegression(baseline, candidate), null);
  });

  it("detects regression when previously-passing criterion fails on 2+ tests", () => {
    const baseline = makeScores({
      0: [["a", true], ["b", true]],
      1: [["a", true], ["b", true]],
      2: [["a", true], ["b", true]],
    });
    const candidate = makeScores({
      0: [["a", false], ["b", true]],
      1: [["a", false], ["b", true]],
      2: [["a", true], ["b", true]],
    });
    const result = detectRegression(baseline, candidate);
    assert.ok(result);
    assert.strictEqual(result.id, "a");
    assert.strictEqual(result.failures, 2);
  });

  it("does not flag regression for single test case failure", () => {
    const baseline = makeScores({
      0: [["a", true]],
      1: [["a", true]],
      2: [["a", true]],
    });
    const candidate = makeScores({
      0: [["a", false]],
      1: [["a", true]],
      2: [["a", true]],
    });
    assert.strictEqual(detectRegression(baseline, candidate), null);
  });

  it("respects custom threshold", () => {
    const baseline = makeScores({
      0: [["a", true]],
      1: [["a", true]],
    });
    const candidate = makeScores({
      0: [["a", false]],
      1: [["a", true]],
    });
    // With threshold=1, a single failure counts as regression
    const result = detectRegression(baseline, candidate, 1);
    assert.ok(result);
    assert.strictEqual(result.id, "a");
  });
});

// ── detectMissingSections ────────────────────────────────────────────────────

describe("detectMissingSections", () => {
  it("detects present sections", () => {
    const content = "- Trigger: when X\n- Approach: do Y\n- Output: write Z\n- Sources: roam_search";
    const { sections, missing } = detectMissingSections(content);
    assert.strictEqual(sections.trigger, true);
    assert.strictEqual(sections.approach, true);
    assert.strictEqual(sections.output, true);
    assert.strictEqual(sections.sources, true);
    assert.ok(missing.includes("constraints"));
    assert.ok(missing.includes("rubric"));
  });

  it("detects all missing when content is empty", () => {
    const { missing } = detectMissingSections("");
    assert.ok(missing.length >= 6);
  });

  it("handles Constraints and Rubric", () => {
    const content = "- Trigger: x\n- Constraints:\n  - Must Do: y\n- Rubric:\n  - check 1";
    const { sections } = detectMissingSections(content);
    assert.strictEqual(sections.constraints, true);
    assert.strictEqual(sections.rubric, true);
  });
});

// ── hasSourcesWithParameterHints ─────────────────────────────────────────────

describe("hasSourcesWithParameterHints", () => {
  it("returns false when no Sources section", () => {
    assert.strictEqual(hasSourcesWithParameterHints("- Trigger: test\n- Approach: do"), false);
  });

  it("returns false for clean Sources", () => {
    const content = "- Sources:\n  - roam_search\n  - list_calendars\n- Approach: do things";
    assert.strictEqual(hasSourcesWithParameterHints(content), false);
  });

  it("detects parenthetical parameter hints", () => {
    const content = "- Sources:\n  - roam_bt_search_tasks (status: TODO/DOING, due: today)\n- Approach: do";
    assert.strictEqual(hasSourcesWithParameterHints(content), true);
  });

  it("detects em-dash descriptions", () => {
    const content = "- Sources:\n  - search_email — recent email signals only\n- Approach: do";
    assert.strictEqual(hasSourcesWithParameterHints(content), true);
  });

  it("detects inline JSON", () => {
    const content = "- Sources:\n  - WEATHERMAP_WEATHER via Composio — `{\"location\": \"Melbourne\"}`\n- Approach: do";
    assert.strictEqual(hasSourcesWithParameterHints(content), true);
  });
});

// ── selectMutationAspect ────────────────────────────────────────────────────

describe("selectMutationAspect", () => {
  it("Phase A: returns add_rubric first when Rubric missing", () => {
    const skill = "- Trigger: test\n- Approach: do things\n- Output: result";
    const result = selectMutationAspect("failures", new Set(), skill);
    assert.strictEqual(result, "add_rubric");
  });

  it("Phase A: returns add_constraints second when Rubric present but Constraints missing", () => {
    const skill = "- Trigger: test\n- Rubric:\n  - check 1\n- Approach: do";
    const result = selectMutationAspect("failures", new Set(["add_rubric"]), skill);
    assert.strictEqual(result, "add_constraints");
  });

  it("Phase A: returns add_or_fix_sources when Sources missing", () => {
    const skill = "- Trigger: test\n- Rubric:\n  - check\n- Constraints:\n  - Must Do: x";
    const result = selectMutationAspect("failures", new Set(["add_rubric", "add_constraints"]), skill);
    assert.strictEqual(result, "add_or_fix_sources");
  });

  it("Phase A: skips add_or_fix_sources when Sources exist (even with parameter hints — locked)", () => {
    const skill = "- Sources:\n  - roam_search (query: test)\n- Rubric:\n  - check\n- Constraints:\n  - Must Do: x";
    const result = selectMutationAspect("failures", new Set(["add_rubric", "add_constraints"]), skill);
    // Sources is locked during mutation — skip to Phase B
    assert.strictEqual(result, "approach_specificity");
  });

  it("Phase A: skips add_or_fix_sources when Sources are clean", () => {
    const skill = "- Sources:\n  - roam_search\n- Rubric:\n  - check\n- Constraints:\n  - Must Do: x";
    const result = selectMutationAspect("failures", new Set(["add_rubric", "add_constraints"]), skill);
    // Should fall through to Phase B
    assert.strictEqual(result, "approach_specificity");
  });

  it("Phase A: skips sections that already exist", () => {
    const skill = "- Rubric:\n  - check\n- Constraints:\n  - Must Do: x\n- Sources:\n  - roam_search";
    const result = selectMutationAspect("failures", new Set(), skill);
    // All structural sections present and clean — goes straight to Phase B
    assert.strictEqual(result, "approach_specificity");
  });

  it("Phase B: cycles through refinement aspects", () => {
    const tried = new Set(["add_rubric", "add_constraints", "add_or_fix_sources", "approach_specificity"]);
    const result = selectMutationAspect("failures", tried, "- Rubric:\n  - x\n- Constraints:\n  - y\n- Sources:\n  - z");
    assert.strictEqual(result, "output_format");
  });

  it("Phase B: cycles with iteration count when all tried", () => {
    const tried = new Set([
      "add_rubric", "add_constraints", "add_or_fix_sources",
      "approach_specificity", "output_format", "constraint_tightening",
      "edge_case_handling", "trigger_clarity",
    ]);
    const skill = "- Rubric:\n  - x\n- Constraints:\n  - y\n- Sources:\n  - z";
    const r7 = selectMutationAspect("failures", tried, skill, 7);
    const r8 = selectMutationAspect("failures", tried, skill, 8);
    assert.notStrictEqual(r7, r8, "consecutive iterations should pick different aspects");
  });
});

// ── shouldStop ──────────────────────────────────────────────────────────────

describe("shouldStop", () => {
  beforeEach(() => {
    initSkillAutoresearch(makeDeps());
  });

  it("stops on budget exhaustion", () => {
    const state = { totalCostUsd: 2.5, currentBestPassRate: 0.5, consecutiveDiscards: 0, iteration: 1 };
    const result = shouldStop(state, 2.0);
    assert.strictEqual(result.stop, true);
    assert.strictEqual(result.reason, "budget_exhausted");
  });

  it("stops on daily cap exceeded", () => {
    initSkillAutoresearch(makeDeps({
      isDailyCapExceeded: () => ({ exceeded: true, cap: 5, spent: 5 }),
    }));
    const state = { totalCostUsd: 0.5, currentBestPassRate: 0.5, consecutiveDiscards: 0, iteration: 1 };
    const result = shouldStop(state, 10);
    assert.strictEqual(result.stop, true);
    assert.strictEqual(result.reason, "daily_cap_exceeded");
  });

  it("stops on perfect score", () => {
    const state = { totalCostUsd: 0.5, currentBestPassRate: 1.0, consecutiveDiscards: 0, iteration: 1 };
    const result = shouldStop(state, 10);
    assert.strictEqual(result.stop, true);
    assert.strictEqual(result.reason, "perfect_score");
  });

  it("stops on plateau (3 consecutive discards)", () => {
    const state = { totalCostUsd: 0.5, currentBestPassRate: 0.7, consecutiveDiscards: 3, iteration: 5 };
    const result = shouldStop(state, 10);
    assert.strictEqual(result.stop, true);
    assert.strictEqual(result.reason, "plateau");
  });

  it("stops on max iterations", () => {
    const state = { totalCostUsd: 0.5, currentBestPassRate: 0.7, consecutiveDiscards: 0, iteration: 20 };
    const result = shouldStop(state, 10);
    assert.strictEqual(result.stop, true);
    assert.strictEqual(result.reason, "max_iterations");
  });

  it("does not stop when no criteria met", () => {
    const state = { totalCostUsd: 0.5, currentBestPassRate: 0.7, consecutiveDiscards: 1, iteration: 3 };
    const result = shouldStop(state, 10);
    assert.strictEqual(result.stop, false);
    assert.strictEqual(result.reason, null);
  });
});

// ── Concurrency Guard ───────────────────────────────────────────────────────

describe("concurrency guard", () => {
  let callCount;
  let resolveSetup;

  beforeEach(() => {
    callCount = 0;
  });

  it("rejects second optimization while first is running", async () => {
    const setupPromise = new Promise(resolve => { resolveSetup = resolve; });
    const testDeps = makeDeps({
      callLlmMini: async () => {
        callCount++;
        if (callCount === 1) await setupPromise;
        return makeMockLlmResponse(makeSetupResponse());
      },
    });
    initSkillAutoresearch(testDeps);

    // Start first optimization (will block on setup)
    const first = runSkillOptimization("Test Skill", { budgetUsd: 0.01 });

    // Wait a tick for the first to start
    await new Promise(r => setTimeout(r, 10));

    // Second should fail
    await assert.rejects(
      runSkillOptimization("Other Skill", { budgetUsd: 0.01 }),
      /already running/i
    );

    // Resolve the first and let it finish (will fail on budget but that's fine)
    resolveSetup();
    try { await first; } catch (_) { /* budget or other stop is expected */ }
  });

  it("allows optimization after previous completes", async () => {
    let callIdx = 0;
    const testDeps = makeDeps({
      callLlmMini: async () => {
        callIdx++;
        return makeMockLlmResponse(makeSetupResponse(1, 1));
      },
      // Score everything as passing so baseline is 100% → early stop
      scoreWithBinaryChecks: async (_resp, checks) => ({
        results: checks.map(c => ({ id: c.id, pass: true, reason: null })),
        cost: 0.001,
        inputTokens: 50,
        outputTokens: 25,
      }),
    });
    initSkillAutoresearch(testDeps);

    // First completes (perfect score = immediate stop)
    const result1 = await runSkillOptimization("Test Skill", { budgetUsd: 5 });
    assert.ok(!isOptimizationRunning());

    // Second should also work
    const result2 = await runSkillOptimization("Test Skill", { budgetUsd: 5 });
    assert.ok(!isOptimizationRunning());
  });
});

// ── End-to-End Orchestrator ─────────────────────────────────────────────────

describe("runSkillOptimization", () => {
  it("returns improved=false when baseline is already perfect", async () => {
    const testDeps = makeDeps({
      callLlmMini: async () => makeMockLlmResponse(makeSetupResponse(2, 2)),
      scoreWithBinaryChecks: async (_resp, checks) => ({
        results: checks.map(c => ({ id: c.id, pass: true, reason: null })),
        cost: 0.001,
        inputTokens: 50,
        outputTokens: 25,
      }),
      showOptimizationResultToast: async ({ onRevert }) => { onRevert(); return "reverted"; },
    });
    initSkillAutoresearch(testDeps);

    const result = await runSkillOptimization("Test Skill", { budgetUsd: 5 });
    assert.strictEqual(result.improved, false);
    assert.strictEqual(result.baselineRate, 1.0);
  });

  it("accepts mutation that improves pass rate", async () => {
    let callIdx = 0;
    let updateMemoryCalled = false;

    const testDeps = makeDeps({
      callLlmMini: async () => {
        callIdx++;
        if (callIdx === 1) {
          // Setup: return test cases and criteria
          return makeMockLlmResponse(makeSetupResponse(2, 2));
        }
        // All other calls: return some response text
        return makeMockLlmResponse("Simulated response or mutation content with improvements");
      },
      scoreWithBinaryChecks: async (_resp, checks) => {
        // Baseline: 50% pass rate. After mutation: 100%
        const isPostMutation = callIdx > 5; // after setup(1) + 2 baseline sims + 1 mutation + 2 mutated sims
        const results = checks.map(c => ({
          id: c.id,
          pass: isPostMutation ? true : (c.id.includes("1") ? true : false),
          reason: null,
        }));
        return { results, cost: 0.001, inputTokens: 50, outputTokens: 25 };
      },
      updateChiefMemory: async () => { updateMemoryCalled = true; return { success: true }; },
      showOptimizationResultToast: async ({ onAccept }) => { await onAccept(); return "accepted"; },
    });
    initSkillAutoresearch(testDeps);

    const result = await runSkillOptimization("Test Skill", { budgetUsd: 5 });
    assert.strictEqual(result.improved, true);
    assert.ok(result.finalRate > result.baselineRate);
    assert.ok(updateMemoryCalled, "updateChiefMemory should be called on accept");
  });

  it("does not write to Roam when user reverts", async () => {
    let callIdx = 0;
    let updateMemoryCalled = false;

    const testDeps = makeDeps({
      callLlmMini: async () => {
        callIdx++;
        if (callIdx === 1) return makeMockLlmResponse(makeSetupResponse(2, 2));
        return makeMockLlmResponse("Mutation content");
      },
      scoreWithBinaryChecks: async (_resp, checks) => {
        const isPostMutation = callIdx > 5;
        const results = checks.map(c => ({
          id: c.id,
          pass: isPostMutation ? true : false,
          reason: null,
        }));
        return { results, cost: 0.001, inputTokens: 50, outputTokens: 25 };
      },
      updateChiefMemory: async () => { updateMemoryCalled = true; },
      showOptimizationResultToast: async ({ onRevert }) => { onRevert(); return "reverted"; },
    });
    initSkillAutoresearch(testDeps);

    const result = await runSkillOptimization("Test Skill", { budgetUsd: 5 });
    assert.strictEqual(updateMemoryCalled, false, "updateChiefMemory should NOT be called on revert");
  });

  it("stops on budget exhaustion", async () => {
    let costAccumulator = 0;
    const testDeps = makeDeps({
      callLlmMini: async () => makeMockLlmResponse(makeSetupResponse(2, 1)),
      getModelCostRates: () => ({ inputPerM: 100, outputPerM: 500 }), // expensive
      scoreWithBinaryChecks: async (_resp, checks) => ({
        results: checks.map(c => ({ id: c.id, pass: false, reason: "fail" })),
        cost: 0.5,
        inputTokens: 50,
        outputTokens: 25,
      }),
      showOptimizationResultToast: async ({ onRevert }) => { onRevert(); return "reverted"; },
    });
    initSkillAutoresearch(testDeps);

    const result = await runSkillOptimization("Test Skill", { budgetUsd: 0.10 });
    assert.ok(result.cost > 0);
    // Should stop due to budget (cost will exceed quickly with expensive rates)
  });

  it("throws when skill not found", async () => {
    const testDeps = makeDeps({
      findSkillEntryByName: async () => null,
    });
    initSkillAutoresearch(testDeps);

    await assert.rejects(
      runSkillOptimization("Nonexistent Skill"),
      /not found/i
    );
  });

  it("throws when skill has no content", async () => {
    const testDeps = makeDeps({
      findSkillEntryByName: async () => ({
        title: "Empty Skill",
        uid: "uid-1",
        content: "- Empty Skill",
        childrenContent: "",
      }),
    });
    initSkillAutoresearch(testDeps);

    await assert.rejects(
      runSkillOptimization("Empty Skill"),
      /no content/i
    );
  });

  it("throws when daily cap already exceeded", async () => {
    const testDeps = makeDeps({
      isDailyCapExceeded: () => ({ exceeded: true, cap: 5, spent: 5 }),
    });
    initSkillAutoresearch(testDeps);

    await assert.rejects(
      runSkillOptimization("Test Skill"),
      /daily spending cap/i
    );
  });

  it("throws when test case generation fails", async () => {
    const testDeps = makeDeps({
      callLlmMini: async () => makeMockLlmResponse("not valid json at all"),
    });
    initSkillAutoresearch(testDeps);

    await assert.rejects(
      runSkillOptimization("Test Skill"),
      /failed to generate/i
    );
  });

  it("tracks cost across all phases", async () => {
    const costEntries = [];
    const testDeps = makeDeps({
      callLlmMini: async () => makeMockLlmResponse(makeSetupResponse(1, 1)),
      scoreWithBinaryChecks: async (_resp, checks) => ({
        results: checks.map(c => ({ id: c.id, pass: true, reason: null })),
        cost: 0.001,
        inputTokens: 50,
        outputTokens: 25,
      }),
      recordCostEntry: (label, input, output, cost) => { costEntries.push({ label, cost }); },
    });
    initSkillAutoresearch(testDeps);

    const result = await runSkillOptimization("Test Skill", { budgetUsd: 5 });
    assert.ok(costEntries.length > 0, "should record cost entries");
    assert.ok(costEntries.some(e => e.label.includes("autoresearch")), "entries should be labeled autoresearch");
  });

  it("persists debrief to eval log and decisions when improved", async () => {
    let callIdx = 0;
    const createdBlocks = [];

    const testDeps = makeDeps({
      callLlmMini: async () => {
        callIdx++;
        if (callIdx === 1) return makeMockLlmResponse(makeSetupResponse(1, 1));
        return makeMockLlmResponse("Improved skill content");
      },
      scoreWithBinaryChecks: async (_resp, checks) => {
        const isPostMutation = callIdx > 3;
        return {
          results: checks.map(c => ({ id: c.id, pass: isPostMutation, reason: null })),
          cost: 0.001,
          inputTokens: 50,
          outputTokens: 25,
        };
      },
      createRoamBlock: async (parentUid, text) => {
        createdBlocks.push({ parentUid, text });
        return "new-uid";
      },
      showOptimizationResultToast: async ({ onAccept }) => { await onAccept(); return "accepted"; },
    });
    initSkillAutoresearch(testDeps);

    await runSkillOptimization("Test Skill", { budgetUsd: 5 });

    const evalLogEntry = createdBlocks.find(b => b.text.includes("skill-optimize"));
    assert.ok(evalLogEntry, "should write eval log entry");
    assert.ok(evalLogEntry.text.includes("Test Skill"), "eval log should mention skill name");

    const decisionsEntry = createdBlocks.find(b => b.text.includes("optimised"));
    assert.ok(decisionsEntry, "should write decisions entry");
  });

  it("clears activeOptimization even on error", async () => {
    const testDeps = makeDeps({
      findSkillEntryByName: async () => { throw new Error("boom"); },
    });
    initSkillAutoresearch(testDeps);

    try { await runSkillOptimization("Test Skill"); } catch (_) {}
    assert.strictEqual(isOptimizationRunning(), false);
  });
});

// ── Test case generation parsing ────────────────────────────────────────────

describe("test case generation parsing", () => {
  it("parses valid JSON response", async () => {
    const setup = makeSetupResponse(5, 3);
    const testDeps = makeDeps({
      callLlmMini: async () => makeMockLlmResponse(setup),
      scoreWithBinaryChecks: async (_resp, checks) => ({
        results: checks.map(c => ({ id: c.id, pass: true, reason: null })),
        cost: 0.001,
        inputTokens: 50,
        outputTokens: 25,
      }),
    });
    initSkillAutoresearch(testDeps);

    // Will stop at baseline (perfect score) — we just want to verify parsing worked
    const result = await runSkillOptimization("Test Skill", { budgetUsd: 5 });
    // If parsing failed, it would throw "Failed to generate test cases"
    assert.ok(result);
  });

  it("handles JSON in code fences", async () => {
    const setup = "```json\n" + makeSetupResponse(3, 2) + "\n```";
    const testDeps = makeDeps({
      callLlmMini: async () => makeMockLlmResponse(setup),
      scoreWithBinaryChecks: async (_resp, checks) => ({
        results: checks.map(c => ({ id: c.id, pass: true, reason: null })),
        cost: 0.001,
        inputTokens: 50,
        outputTokens: 25,
      }),
    });
    initSkillAutoresearch(testDeps);

    const result = await runSkillOptimization("Test Skill", { budgetUsd: 5 });
    assert.ok(result);
  });

  it("caps test cases at maxTestCases", async () => {
    const setup = makeSetupResponse(15, 2); // 15 exceeds cap of 5
    let simulationCount = 0;
    const testDeps = makeDeps({
      callLlmMini: async () => {
        simulationCount++;
        return makeMockLlmResponse(setup);
      },
      scoreWithBinaryChecks: async (_resp, checks) => ({
        results: checks.map(c => ({ id: c.id, pass: true, reason: null })),
        cost: 0.001,
        inputTokens: 50,
        outputTokens: 25,
      }),
    });
    initSkillAutoresearch(testDeps);

    await runSkillOptimization("Test Skill", { budgetUsd: 5 });
    // setup(1) + up to 5 baseline simulations + scoring
    // If all 15 were used, simulationCount would be much higher
    assert.ok(simulationCount <= 7, "should cap test cases (setup + max 5 sims = 6)");
  });

  it("throws on completely malformed response", async () => {
    const testDeps = makeDeps({
      callLlmMini: async () => makeMockLlmResponse("Sorry, I can't help with that."),
    });
    initSkillAutoresearch(testDeps);

    await assert.rejects(
      runSkillOptimization("Test Skill"),
      /failed to generate/i
    );
  });

  it("uses extractBalancedJsonObjects fallback", async () => {
    const setup = makeSetupResponse(2, 1);
    const malformedButRecoverable = "Here is the JSON: " + setup + " and some trailing text";
    const testDeps = makeDeps({
      callLlmMini: async () => makeMockLlmResponse(malformedButRecoverable),
      extractBalancedJsonObjects: (text) => {
        // Simulate finding the JSON object
        try {
          const match = text.match(/\{[\s\S]*\}/);
          if (match) return [{ parsed: JSON.parse(match[0]) }];
        } catch (_) {}
        return [];
      },
      scoreWithBinaryChecks: async (_resp, checks) => ({
        results: checks.map(c => ({ id: c.id, pass: true, reason: null })),
        cost: 0.001,
        inputTokens: 50,
        outputTokens: 25,
      }),
    });
    initSkillAutoresearch(testDeps);

    const result = await runSkillOptimization("Test Skill", { budgetUsd: 5 });
    assert.ok(result);
  });
});

// ── OPTIMIZATION_DEFAULTS ───────────────────────────────────────────────────

describe("OPTIMIZATION_DEFAULTS", () => {
  it("exports expected constants", () => {
    assert.strictEqual(OPTIMIZATION_DEFAULTS.maxTestCases, 5);
    assert.strictEqual(OPTIMIZATION_DEFAULTS.maxEvalCriteria, 5);
    assert.strictEqual(OPTIMIZATION_DEFAULTS.maxIterations, 20);
    assert.strictEqual(OPTIMIZATION_DEFAULTS.consecutiveDiscardLimit, 3);
    assert.strictEqual(OPTIMIZATION_DEFAULTS.regressionThreshold, 2);
    assert.strictEqual(OPTIMIZATION_DEFAULTS.defaultBudgetUsd, 2.0);
  });
});

// ── validateAndFixToolReferences ────────────────────────────────────────────

describe("validateAndFixToolReferences", () => {
  const knownTools = new Set(["roam_search", "roam_get_page", "roam_create_block", "list-events", "bt_search", "cos_update_memory"]);

  beforeEach(() => {
    initSkillAutoresearch(makeDeps({
      getKnownToolNames: async () => knownTools,
      parseSkillSources: (content) => {
        const match = content.match(/Sources:\s*(.+)/i);
        if (!match) return [];
        return match[1].split(",").map(t => ({ tool: t.trim() }));
      },
      parseSkillTools: (content) => {
        const match = content.match(/Tools:\s*(.+)/i);
        if (!match) return [];
        return match[1].split(",").map(t => t.trim()).filter(Boolean);
      },
    }));
  });

  it("passes content through unchanged when no tool references", async () => {
    const content = "- Trigger: user asks\n- Approach: think hard\n- Output: answer";
    const result = await validateAndFixToolReferences(content);
    assert.strictEqual(result.content, content);
    assert.strictEqual(result.stripped.length, 0);
  });

  it("passes content through unchanged when all tools are valid", async () => {
    const content = "- Sources: roam_search, list-events\n- Approach: search then list";
    const result = await validateAndFixToolReferences(content);
    assert.strictEqual(result.content, content);
    assert.strictEqual(result.stripped.length, 0);
  });

  it("strips invalid tool names from Sources section", async () => {
    const content = "- Sources: roam_get_recent_changes\n- Approach: check changes";
    const result = await validateAndFixToolReferences(content);
    assert.ok(result.stripped.includes("roam_get_recent_changes"));
    assert.ok(!result.content.includes("roam_get_recent_changes"));
  });

  it("strips invalid tool names from Tools section", async () => {
    const content = "- Tools: roam_search, fake_nonexistent_tool\n- Approach: search";
    const result = await validateAndFixToolReferences(content);
    assert.ok(result.stripped.includes("fake_nonexistent_tool"));
    assert.ok(result.content.includes("roam_search")); // valid tool preserved
  });

  it("strips multiple invalid names in one pass", async () => {
    const content = "- Sources: roam_get_recent_changes, roam_get_focused_block\n- Approach: check";
    const result = await validateAndFixToolReferences(content);
    assert.strictEqual(result.stripped.length, 2);
    assert.ok(result.stripped.includes("roam_get_recent_changes"));
    assert.ok(result.stripped.includes("roam_get_focused_block"));
  });

  it("returns empty results when getKnownToolNames returns empty set", async () => {
    initSkillAutoresearch(makeDeps({
      getKnownToolNames: async () => new Set(),
    }));
    const content = "- Sources: roam_search\n- Approach: search";
    const result = await validateAndFixToolReferences(content);
    assert.strictEqual(result.stripped.length, 0);
  });

  it("does not scan inline Approach text for tool-shaped words", async () => {
    const content = "- Approach: provide a forward-looking analysis with low-activity handling and include_blocks parameter";
    const result = await validateAndFixToolReferences(content);
    assert.strictEqual(result.stripped.length, 0);
    assert.strictEqual(result.content, content); // unchanged
  });

  it("removes blank lines left in Sources section after stripping", async () => {
    const content = "- Sources: roam_search, fake_tool, list-events\n- Approach: search";
    const result = await validateAndFixToolReferences(content);
    assert.ok(result.stripped.includes("fake_tool"));
    // The stripped name should be gone, no blank/empty entries remain
    assert.ok(!result.content.includes("fake_tool"));
    assert.ok(result.content.includes("roam_search"));
    assert.ok(result.content.includes("list-events"));
  });

  it("preserves content outside Sources/Tools sections during cleanup", async () => {
    const content = "- Trigger: user asks\n- Sources: fake_tool\n- Approach: do things\n- Output: result";
    const result = await validateAndFixToolReferences(content);
    assert.ok(result.content.includes("Trigger: user asks"));
    assert.ok(result.content.includes("Approach: do things"));
    assert.ok(result.content.includes("Output: result"));
  });
});

// ── computePassRate with excludedIds ──────────────────────────────────────

describe("computePassRate with excludedIds", () => {
  it("excludes criteria from both numerator and denominator", () => {
    const scores = [
      { testCaseIdx: 0, results: [{ id: "a", pass: true }, { id: "b", pass: false }, { id: "c", pass: true }] },
      { testCaseIdx: 1, results: [{ id: "a", pass: true }, { id: "b", pass: false }, { id: "c", pass: false }] },
    ];
    // Without exclusion: 3 / (2 * 3) = 0.5
    assert.strictEqual(computePassRate(scores, 3), 0.5);
    // Exclude "b": 3 / (2 * 2) = 0.75
    assert.strictEqual(computePassRate(scores, 3, new Set(["b"])), 0.75);
  });

  it("returns 0 when all criteria are excluded", () => {
    const scores = [
      { testCaseIdx: 0, results: [{ id: "a", pass: true }] },
    ];
    assert.strictEqual(computePassRate(scores, 1, new Set(["a"])), 0);
  });

  it("behaves identically with null excludedIds", () => {
    const scores = [
      { testCaseIdx: 0, results: [{ id: "a", pass: true }, { id: "b", pass: false }] },
    ];
    assert.strictEqual(computePassRate(scores, 2, null), 0.5);
    assert.strictEqual(computePassRate(scores, 2), 0.5);
  });

  it("ignores non-Set excludedIds values", () => {
    const scores = [
      { testCaseIdx: 0, results: [{ id: "a", pass: true }] },
    ];
    // Array is not a Set — should be ignored
    assert.strictEqual(computePassRate(scores, 1, ["a"]), 1.0);
  });
});

// ── detectUnprovableCriteria ──────────────────────────────────────────────

describe("detectUnprovableCriteria", () => {
  const makeScores = (criterionResults) =>
    criterionResults.map((results, idx) => ({
      testCaseIdx: idx,
      results: results.map(([id, pass]) => ({ id, pass })),
    }));

  it("returns empty set in LLM-only mode", () => {
    const scores = makeScores([
      [["write_check", false]],
    ]);
    const criteria = [{ id: "write_check", prompt: "confirms blocks were written" }];
    const result = detectUnprovableCriteria(scores, criteria, false);
    assert.strictEqual(result.size, 0);
  });

  it("detects criteria that score 0% and have write keywords", () => {
    const scores = makeScores([
      [["write_check", false], ["quality", false]],
      [["write_check", false], ["quality", true]],
    ]);
    const criteria = [
      { id: "write_check", prompt: "confirms data was written to daily page" },
      { id: "quality", prompt: "response is well-structured" },
    ];
    const result = detectUnprovableCriteria(scores, criteria, true);
    assert.ok(result.has("write_check"));
    assert.ok(!result.has("quality")); // 0% but no write keywords
  });

  it("does not exclude criteria that pass on some test cases", () => {
    const scores = makeScores([
      [["write_check", true]],
      [["write_check", false]],
    ]);
    const criteria = [{ id: "write_check", prompt: "confirms blocks were created" }];
    const result = detectUnprovableCriteria(scores, criteria, true);
    assert.strictEqual(result.size, 0); // passed at least once
  });

  it("does not exclude criteria with 0% but no write keywords", () => {
    const scores = makeScores([
      [["format_check", false]],
      [["format_check", false]],
    ]);
    const criteria = [{ id: "format_check", prompt: "response uses proper formatting" }];
    const result = detectUnprovableCriteria(scores, criteria, true);
    assert.strictEqual(result.size, 0);
  });

  it("matches write keywords in criterion ID", () => {
    const scores = makeScores([
      [["daily_page_write_confirmation", false]],
    ]);
    const criteria = [{ id: "daily_page_write_confirmation", prompt: "blocks are on the page" }];
    const result = detectUnprovableCriteria(scores, criteria, true);
    assert.ok(result.has("daily_page_write_confirmation"));
  });
});

// ── parseFirstLevelSections ──────────────────────────────────────────────

describe("parseFirstLevelSections", () => {
  it("parses first-level sections from skill content", () => {
    const content = [
      "- Trigger: user provides messy input",
      "- Approach:",
      "  - Step 1",
      "  - Step 2",
      "- Constraints:",
      "  - Must Do:",
      "    - Extract tasks",
      "- Tools: bt_create, roam_create_block",
    ].join("\n");
    const sections = parseFirstLevelSections(content);
    assert.strictEqual(sections.length, 4);
    assert.strictEqual(sections[0].key, "trigger");
    assert.strictEqual(sections[1].key, "approach");
    assert.strictEqual(sections[2].key, "constraints");
    assert.strictEqual(sections[3].key, "tools");
  });

  it("includes children in section fullText", () => {
    const content = "- Approach:\n  - Step 1\n  - Step 2\n- Rubric:\n  - Check A";
    const sections = parseFirstLevelSections(content);
    assert.strictEqual(sections.length, 2);
    assert.ok(sections[0].fullText.includes("Step 1"));
    assert.ok(sections[0].fullText.includes("Step 2"));
  });

  it("handles sections without colons", () => {
    const content = "- OPERATING PRINCIPLES\n  - Be thorough\n- PHASE 1\n  - Do stuff";
    const sections = parseFirstLevelSections(content);
    assert.strictEqual(sections[0].key, "operating principles");
    assert.strictEqual(sections[1].key, "phase 1");
  });

  it("returns empty array for empty content", () => {
    assert.deepStrictEqual(parseFirstLevelSections(""), []);
    assert.deepStrictEqual(parseFirstLevelSections(null), []);
  });

  it("ignores indented lines before first section", () => {
    const content = "  - orphan child\n- Trigger: test\n  - detail";
    const sections = parseFirstLevelSections(content);
    assert.strictEqual(sections.length, 1);
    assert.strictEqual(sections[0].key, "trigger");
  });
});

// ── restoreDroppedSections ──────────────────────────────────────────────

describe("restoreDroppedSections", () => {
  const original = [
    "- Trigger: user provides messy input",
    "- Approach:",
    "  - Step 1",
    "  - Step 2",
    "- OPERATING PRINCIPLES",
    "  - Be thorough",
    "- PHASE 1: ORGANISE",
    "  - Core Ideas",
    "- Constraints:",
    "  - Must Do:",
    "    - Extract tasks",
    "- Rubric:",
    "  - Check quality",
    "- Tools: bt_create",
  ].join("\n");

  it("restores sections dropped by the LLM", () => {
    const mutated = [
      "- Constraints:",
      "  - Must Do:",
      "    - Extract tasks",
      "    - New constraint added",
      "- Rubric:",
      "  - Check quality",
      "  - New criterion added",
      "- Tools: bt_create",
    ].join("\n");

    const result = restoreDroppedSections(original, mutated);
    assert.ok(result.restored.includes("trigger"));
    assert.ok(result.restored.includes("approach"));
    assert.ok(result.restored.includes("operating principles"));
    assert.ok(result.restored.includes("phase 1"));
    assert.strictEqual(result.restored.length, 4);
    // Restored content should include the original sections
    assert.ok(result.content.includes("Trigger: user provides messy input"));
    assert.ok(result.content.includes("Step 1"));
    assert.ok(result.content.includes("OPERATING PRINCIPLES"));
    assert.ok(result.content.includes("Core Ideas"));
  });

  it("does not duplicate sections already present", () => {
    const mutated = original + "\n- Extra: new section";
    const result = restoreDroppedSections(original, mutated);
    assert.strictEqual(result.restored.length, 0);
    assert.strictEqual(result.content, mutated);
  });

  it("matches case-insensitively", () => {
    const mutated = "- trigger: user provides messy input\n- tools: bt_create";
    const result = restoreDroppedSections(original, mutated);
    // trigger and tools are present (case-insensitive), others should be restored
    assert.ok(!result.restored.includes("trigger"));
    assert.ok(!result.restored.includes("tools"));
    assert.ok(result.restored.includes("approach"));
  });

  it("returns unchanged content when nothing is dropped", () => {
    const result = restoreDroppedSections(original, original);
    assert.strictEqual(result.restored.length, 0);
    assert.strictEqual(result.content, original);
  });

  it("handles empty post-mutation content", () => {
    const result = restoreDroppedSections(original, "");
    // All sections should be restored
    assert.ok(result.restored.length > 0);
    assert.ok(result.content.includes("Trigger"));
    assert.ok(result.content.includes("Approach"));
  });

  it("detects absorbed sections and skips restoration", () => {
    const pre = [
      "- ROUTING",
      "  - After organising and extracting, route outputs to the correct destinations:",
      "  - My tasks → create via bt_create with project, due date, and effort attributes where known",
      "  - Others' tasks → create via bt_create with assignee set to owner (becomes waiting-for)",
      "  - Ideas and parking lot items → add to [[Chief of Staff/Inbox]] via roam_create_block",
      "  - Questions needing decisions → add to [[Chief of Staff/Decisions]] via roam_create_block",
      "- Trigger: test input",
    ].join("\n");

    // LLM reorganised ROUTING content into a new Output section
    const post = [
      "- Output:",
      "  - Where output goes:",
      "    - My tasks → create via bt_create with project, due date, and effort attributes where known",
      "    - Others' tasks → create via bt_create with assignee set to owner (becomes waiting-for)",
      "    - Ideas and parking lot items → add to [[Chief of Staff/Inbox]] via roam_create_block",
      "    - Questions needing decisions → add to [[Chief of Staff/Decisions]] via roam_create_block",
      "- Trigger: test input",
    ].join("\n");

    const result = restoreDroppedSections(pre, post);
    assert.ok(!result.restored.includes("routing"));
    assert.ok(result.absorbed.includes("routing"));
    assert.strictEqual(result.restored.length, 0);
  });

  it("restores sections with low absorption rate", () => {
    const pre = [
      "- OPERATING PRINCIPLES",
      "  - **Extract aggressively.** Surface all potential tasks",
      "  - **Preserve context.** Keep the why behind each item",
      "  - **Flag ambiguity.** Mark unclear items with [UNCLEAR]",
      "  - **Suggest ownership.** Note if task is mine or someone else's",
      "  - **Identify dependencies.** Link related tasks",
      "- Tools: bt_create",
    ].join("\n");

    // LLM output has only one overlapping line — not enough for absorption
    const post = [
      "- Constraints:",
      "  - Must Do:",
      "    - **Flag ambiguity.** Mark unclear items with [UNCLEAR]",
      "- Tools: bt_create",
    ].join("\n");

    const result = restoreDroppedSections(pre, post);
    assert.ok(result.restored.includes("operating principles"));
    assert.strictEqual(result.absorbed.length, 0);
  });

  it("returns absorbed array even when empty", () => {
    const result = restoreDroppedSections(original, original);
    assert.deepStrictEqual(result.absorbed, []);
  });
});

// ── repairTruncatedTail ─────────────────────────────────────────────────

describe("repairTruncatedTail", () => {
  it("repairs a truncated last section", () => {
    const pre = [
      "- Approach:",
      "  - Step 1",
      "- Rubric:",
      "  - Check quality of output",
      "  - Check ownership labels present",
      "  - Check effort estimation included",
    ].join("\n");

    const post = [
      "- Approach:",
      "  - Step 1",
      "- Rubric:",
      "  - Check quality of output",
      "  - Check ownership labels",
    ].join("\n");

    const result = repairTruncatedTail(pre, post);
    assert.strictEqual(result.repaired, "rubric");
    assert.ok(result.content.includes("Check effort estimation included"));
    assert.ok(result.content.includes("Check ownership labels present"));
  });

  it("returns unchanged when last section is not truncated", () => {
    const content = [
      "- Trigger: test",
      "- Rubric:",
      "  - Check A",
      "  - Check B",
    ].join("\n");

    const result = repairTruncatedTail(content, content);
    assert.strictEqual(result.repaired, null);
    assert.strictEqual(result.content, content);
  });

  it("returns unchanged when last section is longer in post", () => {
    const pre = "- Rubric:\n  - Check A";
    const post = "- Rubric:\n  - Check A\n  - Check B (new)";

    const result = repairTruncatedTail(pre, post);
    assert.strictEqual(result.repaired, null);
    assert.strictEqual(result.content, post);
  });

  it("returns unchanged when last section has no pre match", () => {
    const pre = "- Trigger: test";
    const post = "- NewSection: added by mutation\n  - Detail";

    const result = repairTruncatedTail(pre, post);
    assert.strictEqual(result.repaired, null);
  });

  it("preserves content before the truncated section", () => {
    const pre = [
      "- Trigger: test input",
      "- Approach:",
      "  - Step 1",
      "  - Step 2",
      "- Constraints:",
      "  - Must Do:",
      "    - Extract tasks",
      "    - Preserve voice",
    ].join("\n");

    const post = [
      "- Trigger: test input",
      "- Approach:",
      "  - Step 1",
      "  - Step 2",
      "  - Step 3 (new)",
      "- Constraints:",
      "  - Must Do:",
      "    - Extract tasks",
    ].join("\n");

    const result = repairTruncatedTail(pre, post);
    assert.strictEqual(result.repaired, "constraints");
    // Approach (with new Step 3) should be preserved
    assert.ok(result.content.includes("Step 3 (new)"));
    // Constraints should be restored from pre
    assert.ok(result.content.includes("Preserve voice"));
  });

  it("handles empty inputs gracefully", () => {
    assert.strictEqual(repairTruncatedTail("", "- X:\n  - Y").repaired, null);
    assert.strictEqual(repairTruncatedTail("- X:\n  - Y", "").repaired, null);
  });
});

// ── preserveSectionLines ────────────────────────────────────────────────

describe("preserveSectionLines", () => {
  it("restores lines removed from within a section", () => {
    const pre = [
      "- Output:",
      "  - My tasks → create via bt_create with project and due date",
      "  - Others' tasks → create via bt_create with assignee",
      "  - If input looks like a project, group them and suggest creating a project page",
      "- Trigger: test input",
    ].join("\n");

    const post = [
      "- Output:",
      "  - My tasks → create via bt_create with project and due date",
      "  - Others' tasks → create via bt_create with assignee",
      "  - New addition from the mutation",
      "- Trigger: test input",
    ].join("\n");

    const result = preserveSectionLines(pre, post);
    assert.strictEqual(result.restoredLines.length, 1);
    assert.strictEqual(result.restoredLines[0].section, "output");
    assert.ok(result.content.includes("If input looks like a project"));
    // New addition should still be present
    assert.ok(result.content.includes("New addition from the mutation"));
  });

  it("does not restore lines that were moved to another section", () => {
    const pre = [
      "- ROUTING",
      "  - My tasks → create via bt_create with project and due date",
      "- Output:",
      "  - Summary of results",
    ].join("\n");

    const post = [
      "- ROUTING",
      "  - Routes are defined elsewhere",
      "- Output:",
      "  - Summary of results",
      "  - My tasks → create via bt_create with project and due date",
    ].join("\n");

    const result = preserveSectionLines(pre, post);
    // Line was moved to Output, not deleted — should not be restored into ROUTING
    assert.strictEqual(result.restoredLines.length, 0);
  });

  it("does not restore short/header lines", () => {
    const pre = "- Constraints:\n  - Must Do:\n  - Extract tasks aggressively but flag ambiguity";
    const post = "- Constraints:\n  - Extract tasks aggressively but flag ambiguity";

    const result = preserveSectionLines(pre, post);
    // "Must Do:" is ≤10 chars normalised — should not be restored
    assert.strictEqual(result.restoredLines.length, 0);
  });

  it("returns unchanged when no lines are missing", () => {
    const content = "- Approach:\n  - Step 1 is to do something\n  - Step 2 is to do another thing";
    const result = preserveSectionLines(content, content);
    assert.strictEqual(result.restoredLines.length, 0);
    assert.strictEqual(result.content, content);
  });

  it("skips sections only in pre (handled by restoreDroppedSections)", () => {
    const pre = "- Approach:\n  - Step 1 is important\n- Rubric:\n  - Check quality of output";
    const post = "- Approach:\n  - Step 1 is important";

    const result = preserveSectionLines(pre, post);
    // Rubric section is missing entirely — not this guard's job
    assert.strictEqual(result.restoredLines.length, 0);
  });

  it("restores multiple lines from multiple sections", () => {
    const pre = [
      "- Output:",
      "  - Route tasks to correct destinations for processing",
      "  - If input looks like a project, group them and suggest creating a project page",
      "- Constraints:",
      "  - Must preserve original voice and context in all outputs",
      "  - Must route items to correct destinations for processing",
    ].join("\n");

    const post = [
      "- Output:",
      "  - Route tasks to correct destinations for processing",
      "  - New output line added by mutation here",
      "- Constraints:",
      "  - Must preserve original voice and context in all outputs",
      "  - New constraint added by mutation here",
    ].join("\n");

    const result = preserveSectionLines(pre, post);
    assert.strictEqual(result.restoredLines.length, 2);
    assert.ok(result.content.includes("If input looks like a project"));
    assert.ok(result.content.includes("Must route items to correct destinations"));
  });
});

// ── OPTIMIZATION_DEFAULTS ─────────────────────────────────────────────────

describe("OPTIMIZATION_DEFAULTS wall-clock", () => {
  it("has iterationWallClockMs set to 150000", () => {
    assert.strictEqual(OPTIMIZATION_DEFAULTS.iterationWallClockMs, 150_000);
  });
});
