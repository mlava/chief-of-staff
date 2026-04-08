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
  parseMutationDiff,
  applyMutationDiff,
  ASPECT_SECTION_MAP,
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
    appendChatPanelMessage: () => {},
    getChatPanelIsOpen: () => false,
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

// Returns a valid structured mutation diff JSON (as LLM response text)
function makeMutationResponseText(section = "Rubric") {
  return JSON.stringify({
    section,
    content: `- ${section}:\n    - Does the response address the task directly?`,
  });
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
        if (callIdx === 1) return makeMockLlmResponse(makeSetupResponse(2, 2));
        // Call 4 is the mutation (1 setup + 2 baseline sims + 1 mutation)
        if (callIdx === 4) return makeMockLlmResponse(makeMutationResponseText());
        // Other calls are simulations — plain text response is fine
        return makeMockLlmResponse("Simulated skill response");
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
        // Call 4 is the mutation (1 setup + 2 baseline sims + 1 mutation)
        if (callIdx === 4) return makeMockLlmResponse(makeMutationResponseText());
        return makeMockLlmResponse("Simulated skill response");
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
        // Call 3 is the mutation (1 setup + 1 baseline sim + 1 mutation)
        if (callIdx === 3) return makeMockLlmResponse(makeMutationResponseText());
        return makeMockLlmResponse("Simulated skill response");
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

// ── OPTIMIZATION_DEFAULTS ─────────────────────────────────────────────────

describe("OPTIMIZATION_DEFAULTS wall-clock", () => {
  it("has iterationWallClockMs set to 150000", () => {
    assert.strictEqual(OPTIMIZATION_DEFAULTS.iterationWallClockMs, 150_000);
  });
});

// ── parseMutationDiff ─────────────────────────────────────────────────────

describe("parseMutationDiff", () => {
  beforeEach(() => { initSkillAutoresearch(makeDeps()); });

  it("returns null for null input", () => {
    assert.strictEqual(parseMutationDiff(null), null);
  });

  it("returns null for empty string", () => {
    assert.strictEqual(parseMutationDiff(""), null);
  });

  it("returns null for non-JSON text", () => {
    assert.strictEqual(parseMutationDiff("here is an improved skill body..."), null);
  });

  it("returns null when section field is missing", () => {
    assert.strictEqual(parseMutationDiff(JSON.stringify({ content: "- Rubric:\n    - check" })), null);
  });

  it("returns null when content field is missing", () => {
    assert.strictEqual(parseMutationDiff(JSON.stringify({ section: "Rubric" })), null);
  });

  it("returns null when section is empty", () => {
    assert.strictEqual(parseMutationDiff(JSON.stringify({ section: "", content: "- Rubric:\n    - check" })), null);
  });

  it("returns null when content is empty", () => {
    assert.strictEqual(parseMutationDiff(JSON.stringify({ section: "Rubric", content: "" })), null);
  });

  it("parses valid { section, content } JSON", () => {
    const diff = parseMutationDiff(JSON.stringify({
      section: "Rubric",
      content: "- Rubric:\n    - Does the response address the task?",
    }));
    assert.deepStrictEqual(diff, {
      section: "Rubric",
      content: "- Rubric:\n    - Does the response address the task?",
    });
  });

  it("strips JSON code fences", () => {
    const raw = "```json\n" + JSON.stringify({ section: "Constraints", content: "- Constraints:\n    - Must Do: be concise" }) + "\n```";
    const diff = parseMutationDiff(raw);
    assert.strictEqual(diff.section, "Constraints");
    assert.ok(diff.content.includes("Must Do"));
  });

  it("trims whitespace from section name", () => {
    const diff = parseMutationDiff(JSON.stringify({ section: "  Approach  ", content: "- Approach:\n    - step" }));
    assert.strictEqual(diff.section, "Approach");
  });
});

// ── applyMutationDiff ─────────────────────────────────────────────────────

describe("applyMutationDiff", () => {
  it("returns currentContent when diff is null", () => {
    const content = "- Trigger: test\n- Approach:\n    - step";
    assert.strictEqual(applyMutationDiff(content, null), content);
  });

  it("returns currentContent when diff has no section", () => {
    const content = "- Trigger: test";
    assert.strictEqual(applyMutationDiff(content, { section: "", content: "..." }), content);
  });

  it("replaces an existing section", () => {
    const before = "- Trigger: test\n- Approach:\n    - old step\n- Output: result";
    const diff = { section: "Approach", content: "- Approach:\n    - new step 1\n    - new step 2" };
    const result = applyMutationDiff(before, diff);
    assert.ok(result.includes("new step 1"));
    assert.ok(result.includes("new step 2"));
    assert.ok(!result.includes("old step"));
    // Other sections untouched
    assert.ok(result.includes("- Trigger: test"));
    assert.ok(result.includes("- Output: result"));
  });

  it("appends a new section when not present", () => {
    const before = "- Trigger: test\n- Approach:\n    - step";
    const diff = { section: "Rubric", content: "- Rubric:\n    - Does the response include required sections?" };
    const result = applyMutationDiff(before, diff);
    assert.ok(result.includes("- Rubric:"));
    assert.ok(result.includes("- Trigger: test"));
    assert.ok(result.includes("- Approach:"));
  });

  it("does not alter other sections when replacing", () => {
    const before = [
      "- Trigger: test",
      "- Approach:",
      "    - step 1",
      "- Constraints:",
      "    - Must Do: be concise",
      "- Output: return result",
    ].join("\n");
    const diff = {
      section: "Approach",
      content: "- Approach:\n    - improved step 1\n    - added step 2",
    };
    const result = applyMutationDiff(before, diff);
    assert.ok(result.includes("improved step 1"));
    assert.ok(result.includes("Must Do: be concise"));
    assert.ok(result.includes("- Trigger: test"));
    assert.ok(result.includes("- Output: return result"));
  });
});

// ── ASPECT_SECTION_MAP ────────────────────────────────────────────────────

describe("ASPECT_SECTION_MAP", () => {
  it("maps all structural aspects to their target sections", () => {
    assert.strictEqual(ASPECT_SECTION_MAP.add_rubric, "Rubric");
    assert.strictEqual(ASPECT_SECTION_MAP.add_constraints, "Constraints");
    assert.strictEqual(ASPECT_SECTION_MAP.add_or_fix_sources, "Sources");
  });

  it("maps all refinement aspects to their target sections", () => {
    assert.strictEqual(ASPECT_SECTION_MAP.approach_specificity, "Approach");
    assert.strictEqual(ASPECT_SECTION_MAP.output_format, "Output");
    assert.strictEqual(ASPECT_SECTION_MAP.constraint_tightening, "Constraints");
    assert.strictEqual(ASPECT_SECTION_MAP.edge_case_handling, "Approach");
    assert.strictEqual(ASPECT_SECTION_MAP.trigger_clarity, "Trigger");
  });

  it("covers all STRUCTURAL_ASPECTS and REFINEMENT_ASPECTS", () => {
    const allAspects = [
      "add_rubric", "add_constraints", "add_or_fix_sources",
      "approach_specificity", "output_format", "constraint_tightening",
      "edge_case_handling", "trigger_clarity",
    ];
    for (const a of allAspects) {
      assert.ok(a in ASPECT_SECTION_MAP, `missing aspect: ${a}`);
      assert.ok(ASPECT_SECTION_MAP[a], `empty section for aspect: ${a}`);
    }
  });
});

// ── computePassRate exclusion ─────────────────────────────────────────────

describe("computePassRate with excluded criteria", () => {
  function makeScores(passMap) {
    // passMap: { criterionId: boolean }
    return [{ results: Object.entries(passMap).map(([id, pass]) => ({ id, pass })) }];
  }

  it("includes all criteria when excludedIds is null", () => {
    const scores = makeScores({ a: true, b: false, c: true });
    assert.strictEqual(computePassRate(scores, 3, null), 2 / 3);
  });

  it("excludes specified criteria from numerator and denominator", () => {
    const scores = makeScores({ a: true, b: false, c: true });
    // Exclude b (which was failing) — effective rate should be 2/2
    const excluded = new Set(["b"]);
    assert.strictEqual(computePassRate(scores, 3, excluded), 1.0);
  });

  it("excluding a 0/5 wall criterion raises the reported rate", () => {
    // Simulates: baseline 0/5 on 'extracts_core_ideas', 5/5 on 4 others → 80%
    // After wallcriterialization of 'extracts_core_ideas': 5/5 on remaining 4 → 100%
    const scores = [
      { results: [
        { id: "extracts_core_ideas", pass: false },
        { id: "preserves_voice", pass: true },
        { id: "routes_tasks", pass: true },
        { id: "includes_summary", pass: true },
        { id: "avoids_fabrication", pass: true },
      ]},
    ];
    const rateWithWall = computePassRate(scores, 5, null);
    assert.strictEqual(rateWithWall, 4 / 5);

    const excluded = new Set(["extracts_core_ideas"]);
    const rateWithoutWall = computePassRate(scores, 5, excluded);
    assert.strictEqual(rateWithoutWall, 1.0);
  });

  it("returns 0 when all criteria are excluded", () => {
    const scores = makeScores({ a: true });
    assert.strictEqual(computePassRate(scores, 1, new Set(["a"])), 0);
  });
});
