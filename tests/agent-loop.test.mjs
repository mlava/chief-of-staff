// =============================================================================
// agent-loop.test.mjs — Tests for agent-loop.js (extracted agent loop module)
// =============================================================================

// NOTE: This test requires --require tests/setup-browser-globals.cjs to shim
// browser globals needed by transitive deps (izitoast via chat-panel.js).

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  initAgentLoop,
  ClaimedActionEscalationError,
  EmptyResponseEscalationError,
  LiveDataEscalationError,
  getLastAgentRunTrace,
  setLastAgentRunTrace,
  getActiveAgentAbortController,
  cleanupAgentLoop,
  runAgentLoop,
  runAgentLoopWithFailover,
  buildToolCacheKey,
  shouldEscalateClaimedAction,
  shouldShortCircuitAfterWrite,
  shortCircuitMessage,
  batchShortCircuitMessage,
  shouldShortCircuitAfterCollision,
  collisionShortCircuitMessage,
  isMultiWriteGraphIntent,
  resolveMultiWriteMaxIterations,
} from "../src/agent-loop.js";
import { clampSkillMaxIterations, clampAgentMaxIterations } from "../src/settings-config.js";

// ── Test helpers ────────────────────────────────────────────────────────────

function makeDeps(overrides = {}) {
  return {
    debugLog: () => {},
    getExtensionAPIRef: () => ({ settings: { get: () => null, set: () => {} } }),
    getExternalExtensionTools: () => [],
    getExtensionToolsRegistry: () => ({}),
    getExtToolsConfig: () => ({}),
    setExtToolsConfig: () => {},
    clearExternalExtensionToolsCache: () => {},
    getAvailableToolSchemas: async () => [],
    getRoamNativeTools: () => [],
    getBetterTasksTools: () => [],
    getCosIntegrationTools: () => [],
    getCronTools: () => [],
    getComposioMetaToolsForLlm: () => [],
    getAssistantDisplayName: () => "Chief of Staff",
    escapeHtml: (t) => t,
    safeJsonStringify: (v, max) => JSON.stringify(v).slice(0, max || 12000),
    getSettingBool: () => false,
    getSettingString: () => "",
    getVerbosityMaxOutputTokens: () => 2500,
    getCurrentPageContext: async () => null,
    checkGatheringCompleteness: () => [],
    parseSkillSources: () => [],
    guardAgainstSystemPromptLeakage: (text) => text,
    showRawToast: () => {},
    showInfoToast: () => {},
    showErrorToast: () => {},
    updateChatPanelCostIndicator: () => {},
    getToastTheme: () => "dark",
    isUnloadInProgress: () => false,
    MAX_AGENT_ITERATIONS: 20,
    MAX_AGENT_ITERATIONS_SKILL: 16,
    MAX_TOOL_CALLS_PER_ITERATION: 4,
    MAX_TOOL_CALLS_PER_ITERATION_SKILL: 8,
    MAX_CALLS_PER_TOOL_PER_LOOP: 10,
    MAX_TOOL_RESULT_CHARS: 12000,
    FAILOVER_CHAINS: {
      mini: ["gemini", "openai", "anthropic", "mistral", "groq"],
      power: ["gemini", "openai", "anthropic", "mistral", "groq"],
      ludicrous: ["anthropic", "openai", "gemini", "mistral", "groq"],
    },
    FAILOVER_CONTINUATION_MESSAGE: "Continuing from a prior model.",
    DEFAULT_LLM_PROVIDER: "anthropic",
    STANDARD_MAX_OUTPUT_TOKENS: 2500,
    SKILL_MAX_OUTPUT_TOKENS: 4096,
    LUDICROUS_MAX_OUTPUT_TOKENS: 8192,
    MAX_AGENT_MESSAGES_CHAR_BUDGET: 70000,
    SETTINGS_KEYS: {
      ludicrousModeEnabled: "ludicrous-mode-enabled",
      postWriteShortCircuit: "post-write-short-circuit",
      claimedActionEscalationAllProviders: "claimed-action-escalation-all-providers",
      skillContinueAfterWrite: "skill-continue-after-write",
      skillMaxIterations: "skill-max-iterations",
    },
    INBOX_READ_ONLY_TOOL_ALLOWLIST: new Set(["roam_search"]),
    WRITE_TOOL_NAMES: new Set(["roam_create_block", "roam_update_block"]),
    ...overrides,
  };
}

// ── Error classes ───────────────────────────────────────────────────────────

describe("ClaimedActionEscalationError", () => {
  it("is an instance of Error", () => {
    const err = new ClaimedActionEscalationError("test");
    assert.ok(err instanceof Error);
  });

  it("has correct name property", () => {
    const err = new ClaimedActionEscalationError("test");
    assert.equal(err.name, "ClaimedActionEscalationError");
  });

  it("stores escalationContext", () => {
    const ctx = { provider: "gemini", tier: "mini", sessionClaimedActionCount: 2 };
    const err = new ClaimedActionEscalationError("test", ctx);
    assert.deepEqual(err.escalationContext, ctx);
  });

  it("defaults escalationContext to empty object", () => {
    const err = new ClaimedActionEscalationError("test");
    assert.deepEqual(err.escalationContext, {});
  });

  it("preserves message", () => {
    const err = new ClaimedActionEscalationError("claimed action failure");
    assert.equal(err.message, "claimed action failure");
  });
});

describe("EmptyResponseEscalationError", () => {
  it("is an instance of Error", () => {
    const err = new EmptyResponseEscalationError("test");
    assert.ok(err instanceof Error);
  });

  it("has correct name property", () => {
    const err = new EmptyResponseEscalationError("test");
    assert.equal(err.name, "EmptyResponseEscalationError");
  });

  it("stores escalationContext", () => {
    const ctx = { provider: "openai", tier: "mini", iterations: 3 };
    const err = new EmptyResponseEscalationError("test", ctx);
    assert.deepEqual(err.escalationContext, ctx);
  });

  it("defaults escalationContext to empty object", () => {
    const err = new EmptyResponseEscalationError("test");
    assert.deepEqual(err.escalationContext, {});
  });
});

describe("LiveDataEscalationError", () => {
  it("is an instance of Error", () => {
    const err = new LiveDataEscalationError("test");
    assert.ok(err instanceof Error);
  });

  it("has correct name property", () => {
    const err = new LiveDataEscalationError("test");
    assert.equal(err.name, "LiveDataEscalationError");
  });

  it("stores escalationContext", () => {
    const ctx = { provider: "gemini", tier: "mini", model: "gemini-3.1-flash-lite-preview" };
    const err = new LiveDataEscalationError("test", ctx);
    assert.deepEqual(err.escalationContext, ctx);
  });

  it("defaults escalationContext to empty object", () => {
    const err = new LiveDataEscalationError("test");
    assert.deepEqual(err.escalationContext, {});
  });

  it("preserves message", () => {
    const err = new LiveDataEscalationError("live data failure");
    assert.equal(err.message, "live data failure");
  });
});

// ── State management ────────────────────────────────────────────────────────

describe("State management", () => {
  beforeEach(() => {
    initAgentLoop(makeDeps());
    cleanupAgentLoop();
  });

  it("getLastAgentRunTrace returns null initially", () => {
    assert.equal(getLastAgentRunTrace(), null);
  });

  it("setLastAgentRunTrace stores and getLastAgentRunTrace retrieves", () => {
    const trace = { provider: "anthropic", iterations: 3, toolCalls: [] };
    setLastAgentRunTrace(trace);
    assert.deepEqual(getLastAgentRunTrace(), trace);
  });

  it("getActiveAgentAbortController returns null initially", () => {
    assert.equal(getActiveAgentAbortController(), null);
  });

  it("cleanupAgentLoop resets lastAgentRunTrace to null", () => {
    setLastAgentRunTrace({ provider: "test" });
    cleanupAgentLoop();
    assert.equal(getLastAgentRunTrace(), null);
  });

  it("cleanupAgentLoop resets activeAgentAbortController to null", () => {
    cleanupAgentLoop();
    assert.equal(getActiveAgentAbortController(), null);
  });
});

// ── DI wiring ───────────────────────────────────────────────────────────────

describe("DI wiring", () => {
  it("initAgentLoop stores deps accessible by exported functions", () => {
    const customTrace = { test: true };
    initAgentLoop(makeDeps());
    setLastAgentRunTrace(customTrace);
    assert.deepEqual(getLastAgentRunTrace(), customTrace);
    cleanupAgentLoop();
  });

  it("runAgentLoop is exported as a function", () => {
    assert.equal(typeof runAgentLoop, "function");
  });

  it("runAgentLoopWithFailover is exported as a function", () => {
    assert.equal(typeof runAgentLoopWithFailover, "function");
  });

  it("runAgentLoop throws when extension API is not ready", async () => {
    initAgentLoop(makeDeps({ getExtensionAPIRef: () => null }));
    await assert.rejects(
      () => runAgentLoop("test prompt"),
      { message: "Extension API not ready" }
    );
  });
});

// ── Exports completeness ────────────────────────────────────────────────────

describe("Module exports", () => {
  it("exports initAgentLoop", () => {
    assert.equal(typeof initAgentLoop, "function");
  });

  it("exports ClaimedActionEscalationError", () => {
    assert.equal(typeof ClaimedActionEscalationError, "function");
  });

  it("exports EmptyResponseEscalationError", () => {
    assert.equal(typeof EmptyResponseEscalationError, "function");
  });

  it("exports LiveDataEscalationError", () => {
    assert.equal(typeof LiveDataEscalationError, "function");
  });

  it("exports getLastAgentRunTrace", () => {
    assert.equal(typeof getLastAgentRunTrace, "function");
  });

  it("exports setLastAgentRunTrace", () => {
    assert.equal(typeof setLastAgentRunTrace, "function");
  });

  it("exports getActiveAgentAbortController", () => {
    assert.equal(typeof getActiveAgentAbortController, "function");
  });

  it("exports cleanupAgentLoop", () => {
    assert.equal(typeof cleanupAgentLoop, "function");
  });

  it("exports runAgentLoop", () => {
    assert.equal(typeof runAgentLoop, "function");
  });

  it("exports runAgentLoopWithFailover", () => {
    assert.equal(typeof runAgentLoopWithFailover, "function");
  });
});

// ── buildToolCacheKey ─────────────────────────────────────────────────────

describe("buildToolCacheKey", () => {
  it("returns null for LOCAL_MCP_ROUTE", () => {
    assert.strictEqual(buildToolCacheKey("LOCAL_MCP_ROUTE", { server_name: "test" }), null);
  });

  it("returns null for REMOTE_MCP_ROUTE", () => {
    assert.strictEqual(buildToolCacheKey("REMOTE_MCP_ROUTE", {}), null);
  });

  it("returns null for ROAM_ROUTE", () => {
    assert.strictEqual(buildToolCacheKey("ROAM_ROUTE", {}), null);
  });

  it("returns a string key for regular tools", () => {
    const key = buildToolCacheKey("roam_search", { query: "test" });
    assert.strictEqual(typeof key, "string");
    assert.ok(key.startsWith("roam_search::"));
  });

  it("produces identical keys for identical tool+args", () => {
    const key1 = buildToolCacheKey("list_calendars", {});
    const key2 = buildToolCacheKey("list_calendars", {});
    assert.strictEqual(key1, key2);
  });

  it("produces different keys for different args", () => {
    const key1 = buildToolCacheKey("roam_search", { query: "test" });
    const key2 = buildToolCacheKey("roam_search", { query: "other" });
    assert.notStrictEqual(key1, key2);
  });

  it("strips session_id from Composio args", () => {
    const key = buildToolCacheKey("COMPOSIO_MULTI_EXECUTE_TOOL", {
      tools: [{ tool_slug: "WEATHERMAP_WEATHER", arguments: { location: "Melbourne" } }],
      session_id: "abc123",
      session: { id: "abc123" },
    });
    assert.ok(!key.includes("abc123"));
    assert.ok(key.includes("WEATHERMAP_WEATHER"));
    assert.ok(key.includes("Melbourne"));
  });

  it("strips session fields from inner tool arguments", () => {
    const key = buildToolCacheKey("COMPOSIO_MULTI_EXECUTE_TOOL", {
      tools: [{ tool_slug: "GMAIL_FETCH_EMAILS", arguments: { query: "test", session_id: "xyz" } }],
    });
    assert.ok(!key.includes("xyz"));
    assert.ok(key.includes("test"));
  });

  it("handles null args gracefully", () => {
    const key = buildToolCacheKey("roam_search", null);
    assert.strictEqual(typeof key, "string");
  });

  it("returns key for LOCAL_MCP_EXECUTE (cacheable)", () => {
    const key = buildToolCacheKey("LOCAL_MCP_EXECUTE", {
      tool_name: "search_issues",
      arguments: { q: "is:open" }
    });
    assert.strictEqual(typeof key, "string");
    assert.ok(key.includes("search_issues"));
  });

  it("produces identical keys regardless of arg property order", () => {
    const key1 = buildToolCacheKey("get_calendar_events", {
      calendarId: "abc@group.calendar.google.com",
      dateMin: "2026-04-01",
      timeMin: "00:00:00",
      timeZone: "Australia/Melbourne"
    });
    const key2 = buildToolCacheKey("get_calendar_events", {
      timeZone: "Australia/Melbourne",
      dateMin: "2026-04-01",
      calendarId: "abc@group.calendar.google.com",
      timeMin: "00:00:00"
    });
    assert.strictEqual(key1, key2);
  });
});
// ── Collision short-circuit ────────────────────────────────────────────────

describe("shouldShortCircuitAfterCollision", () => {
  const collisionResult = () => [{
    toolCall: { name: "cos_schedule_block", arguments: {} },
    result: {
      success: false,
      error: "Time collision: 21:00 - 00:00 overlaps existing slot.",
      colliding_uid: "uid007",
      colliding_string: "21:00 - 00:00 (**180'**) ((abc))",
    },
  }];

  it("is true when the last result is a cos_schedule_block collision and no skill is active", () => {
    assert.equal(shouldShortCircuitAfterCollision({
      toolResults: collisionResult(), skillActive: false, skillContinueAfterWrite: true,
    }), true);
  });

  it("is true for a ROAM_EXECUTE-wrapped cos_schedule_block collision", () => {
    const toolResults = [{
      toolCall: { name: "ROAM_EXECUTE", arguments: { tool_name: "cos_schedule_block" } },
      result: { success: false, colliding_string: "21:00 - 00:00 (**180'**) ((abc))" },
    }];
    assert.equal(shouldShortCircuitAfterCollision({
      toolResults, skillActive: false, skillContinueAfterWrite: true,
    }), true);
  });

  it("is false when a skill is active and skill-continue-after-write is on/undefined", () => {
    assert.equal(shouldShortCircuitAfterCollision({
      toolResults: collisionResult(), skillActive: true, skillContinueAfterWrite: true,
    }), false);
    assert.equal(shouldShortCircuitAfterCollision({
      toolResults: collisionResult(), skillActive: true, skillContinueAfterWrite: undefined,
    }), false);
  });

  it("is true during a skill run when skill-continue-after-write is OFF", () => {
    assert.equal(shouldShortCircuitAfterCollision({
      toolResults: collisionResult(), skillActive: true, skillContinueAfterWrite: false,
    }), true);
  });

  it("is false for cos_schedule_block success with overlapped and informational colliding_string", () => {
    const toolResults = [{
      toolCall: { name: "cos_schedule_block", arguments: {} },
      result: {
        success: true,
        overlapped: true,
        slot_string: "21:00 - 22:00 (**60'**) ((new))",
        colliding_string: "21:00 - 00:00 (**180'**) ((abc))",
      },
    }];
    assert.equal(shouldShortCircuitAfterCollision({
      toolResults, skillActive: false, skillContinueAfterWrite: true,
    }), false);
  });

  it("is false without a colliding_string or for other tools", () => {
    assert.equal(shouldShortCircuitAfterCollision({
      toolResults: [{ toolCall: { name: "cos_schedule_block", arguments: {} }, result: { success: true } }],
      skillActive: false, skillContinueAfterWrite: true,
    }), false);
    assert.equal(shouldShortCircuitAfterCollision({
      toolResults: [{ toolCall: { name: "roam_create_block", arguments: {} }, result: { colliding_string: "x" } }],
      skillActive: false, skillContinueAfterWrite: true,
    }), false);
    assert.equal(shouldShortCircuitAfterCollision({
      toolResults: [], skillActive: false, skillContinueAfterWrite: true,
    }), false);
  });
});

describe("collisionShortCircuitMessage", () => {
  it("echoes colliding_string verbatim in a two-line message with move hint", () => {
    const msg = collisionShortCircuitMessage({ colliding_string: "21:00 - 00:00 (**180'**) ((abc))" });
    assert.ok(msg.includes("21:00 - 00:00 (**180'**) ((abc))"));
    assert.equal(
      msg,
      "Time collision: 21:00 - 00:00 (**180'**) ((abc))\nThat window is taken. Reply overlap or allow overlapping timed blocks to keep both, move 21:00-23:00 to shift the existing timed block, or pick a different time."
    );
    assert.match(msg, /\bmove\b/i, "collision copy must mention move");
    assert.match(msg, /21:00-23:00/, "collision copy must include a time example");
  });
});

// ── Post-write short-circuit helpers ───────────────────────────────────────

const SHORT_WRITE_TOOL_NAMES = new Set([
  "roam_create_block",
  "roam_update_block",
  "cos_write_draft_skill",
  "cos_update_memory",
  "cos_cron_create",
  "cos_cron_update",
  "cos_cron_delete",
  "cos_cron_delete_jobs",
]);

function loneWrite({ name, args, result }) {
  return [{ toolCall: { name, arguments: args || {} }, result: result || {} }];
}

describe("isMultiWriteGraphIntent", () => {
  it("detects rearrange / mid-list insert / multi-target writes", () => {
    const trueCases = [
      "rearrange the reading list",
      "insert the remaining items into the main list",
      "reorder TODOs so the list stays chronological",
      "move existing TODOs as needed under Projects",
      "rearrange/move existing TODOs as needed",
      "batch add all of these tasks to my daily page",
      "sort the grocery list alphabetically",
      "reorganise the [[Project Alpha]] page",
      "fill in the outline under [[Trip Planning]]",
      "flesh out this outline with the points we discussed",
      "migrate the children of [[Old Inbox]] to [[Inbox]]",
      "add all of these to my notes",
      "consolidate the children under one parent block",
      "turn each of these bullets into its own page",
      "move every completed task to the archive page",
    ];
    for (const t of trueCases) {
      assert.equal(isMultiWriteGraphIntent(t), true, `expected true: ${t}`);
    }
  });

  it("stays false for single writes and read-only multi-noun questions", () => {
    const falseCases = [
      "add a note about coffee",
      "schedule gaming 9pm to midnight",
      "create a TODO for laundry",
      "",
      "how many todos are overdue?",
      "what sort of music do I listen to?",
      "show me all of these pages",
      "summarise the children of [[Projects]]",
      "what's on my reading list?",
      "insert a page break in this document",
      "expand on your last answer",
      "create a page called Watch Order",
    ];
    for (const t of falseCases) {
      assert.equal(isMultiWriteGraphIntent(t), false, `expected false: ${t}`);
    }
  });
});

describe("resolveMultiWriteMaxIterations", () => {
  it("boosts the default chat cap of 20 up to 32", () => {
    assert.equal(resolveMultiWriteMaxIterations(20), 32);
  });

  it("keeps a higher user setting", () => {
    assert.equal(resolveMultiWriteMaxIterations(36), 36);
    assert.equal(resolveMultiWriteMaxIterations(40), 40);
  });

  it("never exceeds hardCap", () => {
    assert.equal(resolveMultiWriteMaxIterations(50), 40);
    assert.equal(resolveMultiWriteMaxIterations(20, { hardCap: 30 }), 30);
  });

  it("respects a custom minBoost", () => {
    assert.equal(resolveMultiWriteMaxIterations(20, { minBoost: 28 }), 28);
  });
});

describe("shouldShortCircuitAfterWrite", () => {
  it("returns false when multiWriteIntent is true even after a successful write", () => {
    assert.equal(
      shouldShortCircuitAfterWrite({
        toolResults: loneWrite({ name: "roam_create_block" }),
        approvedPlan: null,
        settingOn: true,
        writeToolNames: SHORT_WRITE_TOOL_NAMES,
        multiWriteIntent: true,
      }),
      false
    );
  });

  it("returns true for a lone roam_create_block success when settingOn true", () => {
    assert.equal(
      shouldShortCircuitAfterWrite({
        toolResults: loneWrite({ name: "roam_create_block" }),
        approvedPlan: null,
        settingOn: true,
        writeToolNames: SHORT_WRITE_TOOL_NAMES,
      }),
      true
    );
  });

  it("returns true when settingOn is undefined (treated as ON)", () => {
    assert.equal(
      shouldShortCircuitAfterWrite({
        toolResults: loneWrite({ name: "roam_create_block" }),
        approvedPlan: null,
        settingOn: undefined,
        writeToolNames: SHORT_WRITE_TOOL_NAMES,
      }),
      true
    );
  });

  it("returns false when settingOn is false (OFF continues)", () => {
    assert.equal(
      shouldShortCircuitAfterWrite({
        toolResults: loneWrite({ name: "roam_create_block" }),
        approvedPlan: null,
        settingOn: false,
        writeToolNames: SHORT_WRITE_TOOL_NAMES,
      }),
      false
    );
  });

  it("returns false when approvedPlan is truthy even if setting ON", () => {
    assert.equal(
      shouldShortCircuitAfterWrite({
        toolResults: loneWrite({ name: "roam_create_block" }),
        approvedPlan: "a plan",
        settingOn: true,
        writeToolNames: SHORT_WRITE_TOOL_NAMES,
      }),
      false
    );
    assert.equal(
      shouldShortCircuitAfterWrite({
        toolResults: loneWrite({ name: "roam_create_block" }),
        approvedPlan: { plan: true },
        settingOn: true,
        writeToolNames: SHORT_WRITE_TOOL_NAMES,
      }),
      false
    );
  });

  it("returns true for approvedPlan null / undefined / empty string when ON", () => {
    for (const approvedPlan of [null, undefined, ""]) {
      assert.equal(
        shouldShortCircuitAfterWrite({
          toolResults: loneWrite({ name: "roam_create_block" }),
          approvedPlan,
          settingOn: true,
          writeToolNames: SHORT_WRITE_TOOL_NAMES,
        }),
        true,
        `expected short-circuit for approvedPlan ${JSON.stringify(approvedPlan)}`
      );
    }
  });

  it("returns false for two tools in one iteration", () => {
    assert.equal(
      shouldShortCircuitAfterWrite({
        toolResults: [
          { toolCall: { name: "roam_search" }, result: {} },
          { toolCall: { name: "roam_create_block" }, result: {} },
        ],
        approvedPlan: null,
        settingOn: true,
        writeToolNames: SHORT_WRITE_TOOL_NAMES,
      }),
      false
    );
  });

  it("returns false for a lone read (tool not in write set)", () => {
    assert.equal(
      shouldShortCircuitAfterWrite({
        toolResults: loneWrite({ name: "roam_search" }),
        approvedPlan: null,
        settingOn: true,
        writeToolNames: SHORT_WRITE_TOOL_NAMES,
      }),
      false
    );
  });

  it("returns false when the result has an error", () => {
    assert.equal(
      shouldShortCircuitAfterWrite({
        toolResults: [{ toolCall: { name: "roam_create_block" }, result: { error: "boom" } }],
        approvedPlan: null,
        settingOn: true,
        writeToolNames: SHORT_WRITE_TOOL_NAMES,
      }),
      false
    );
  });

  it("returns true for ROAM_EXECUTE wrapping an inner write tool", () => {
    assert.equal(
      shouldShortCircuitAfterWrite({
        toolResults: [{ toolCall: { name: "ROAM_EXECUTE", arguments: { tool_name: "roam_update_block" } }, result: {} }],
        approvedPlan: null,
        settingOn: true,
        writeToolNames: SHORT_WRITE_TOOL_NAMES,
      }),
      true
    );
  });

  it("returns false for ROAM_EXECUTE wrapping a non-write tool", () => {
    assert.equal(
      shouldShortCircuitAfterWrite({
        toolResults: [{ toolCall: { name: "ROAM_EXECUTE", arguments: { tool_name: "roam_search" } }, result: {} }],
        approvedPlan: null,
        settingOn: true,
        writeToolNames: SHORT_WRITE_TOOL_NAMES,
      }),
      false
    );
  });

  // ── skill-continue-after-write ────────────────────────────────────────────
  // When a skill is active and skillContinueAfterWrite is ON (or undefined),
  // the skill may take another turn even if the one-write switch is ON.
  it("returns false when skillActive + skillContinueAfterWrite ON + lone write + settingOn true", () => {
    assert.equal(
      shouldShortCircuitAfterWrite({
        toolResults: loneWrite({ name: "roam_create_block" }),
        approvedPlan: null,
        settingOn: true,
        writeToolNames: SHORT_WRITE_TOOL_NAMES,
        skillActive: true,
        skillContinueAfterWrite: true,
      }),
      false
    );
  });

  it("returns false when skillActive + skillContinueAfterWrite undefined (treated as ON) + lone write + settingOn true", () => {
    assert.equal(
      shouldShortCircuitAfterWrite({
        toolResults: loneWrite({ name: "roam_create_block" }),
        approvedPlan: null,
        settingOn: true,
        writeToolNames: SHORT_WRITE_TOOL_NAMES,
        skillActive: true,
      }),
      false
    );
  });

  // When skillContinueAfterWrite is OFF, skills obey the one-write switch.
  it("returns true when skillActive + skillContinueAfterWrite false + settingOn true + lone write", () => {
    assert.equal(
      shouldShortCircuitAfterWrite({
        toolResults: loneWrite({ name: "roam_create_block" }),
        approvedPlan: null,
        settingOn: true,
        writeToolNames: SHORT_WRITE_TOOL_NAMES,
        skillActive: true,
        skillContinueAfterWrite: false,
      }),
      true
    );
  });

  // Casual chat (skillActive false/undefined) still short-circuits when
  // post-write is ON, even if skillContinueAfterWrite is ON.
  it("returns true for casual chat (skillActive false) + settingOn true + lone write even when skillContinueAfterWrite ON", () => {
    assert.equal(
      shouldShortCircuitAfterWrite({
        toolResults: loneWrite({ name: "roam_create_block" }),
        approvedPlan: null,
        settingOn: true,
        writeToolNames: SHORT_WRITE_TOOL_NAMES,
        skillActive: false,
        skillContinueAfterWrite: true,
      }),
      true
    );
    assert.equal(
      shouldShortCircuitAfterWrite({
        toolResults: loneWrite({ name: "roam_create_block" }),
        approvedPlan: null,
        settingOn: true,
        writeToolNames: SHORT_WRITE_TOOL_NAMES,
        skillActive: undefined,
        skillContinueAfterWrite: true,
      }),
      true
    );
  });

  it("returns true for two successful cos_schedule_block results", () => {
    assert.equal(
      shouldShortCircuitAfterWrite({
        toolResults: [
          { toolCall: { name: "cos_schedule_block" }, result: { success: true, slot_string: "09:00 - 10:00 (**60'**) ((a))" } },
          { toolCall: { name: "cos_schedule_block" }, result: { success: true, slot_string: "10:00 - 11:00 (**60'**) ((b))" } },
        ],
        approvedPlan: null,
        settingOn: true,
        writeToolNames: SHORT_WRITE_TOOL_NAMES,
      }),
      true
    );
  });

  // Existing callers that omit the new args must still short-circuit for casual chat.
  it("returns true for casual chat when skillActive/skillContinueAfterWrite are omitted (back-compat)", () => {
    assert.equal(
      shouldShortCircuitAfterWrite({
        toolResults: loneWrite({ name: "roam_create_block" }),
        approvedPlan: null,
        settingOn: true,
        writeToolNames: SHORT_WRITE_TOOL_NAMES,
      }),
      true
    );
  });
});

// ── Claimed-action escalation helper ───────────────────────────────────────

describe("shouldEscalateClaimedAction", () => {
  const providers = ["grok", "kimi", "ollama", "openai", "anthropic", "gemini"];

  // allProviders ON (default) + mini + sessionCount>=2 → true for every provider
  for (const provider of providers) {
    it(`returns true when allProviders ON + provider ${provider} + mini + sessionCount 2`, () => {
      assert.equal(
        shouldEscalateClaimedAction({ provider, effectiveTier: "mini", sessionCount: 2, allProviders: true }),
        true,
        `expected escalation for provider ${provider}`
      );
    });
  }

  // allProviders undefined (treated as ON) + mini + sessionCount>=2 → true for non-gemini
  for (const provider of ["grok", "kimi", "ollama", "openai", "anthropic"]) {
    it(`returns true when allProviders undefined + provider ${provider} + mini + sessionCount 2`, () => {
      assert.equal(
        shouldEscalateClaimedAction({ provider, effectiveTier: "mini", sessionCount: 2 }),
        true,
        `expected escalation for provider ${provider}`
      );
    });
  }

  // allProviders OFF + provider gemini + mini + sessionCount>=2 → true (old Gemini behavior)
  it("returns true when allProviders OFF + provider gemini + mini + sessionCount 2 (legacy)", () => {
    assert.equal(
      shouldEscalateClaimedAction({ provider: "gemini", effectiveTier: "mini", sessionCount: 2, allProviders: false }),
      true
    );
  });

  // allProviders OFF + non-gemini + mini + sessionCount>=2 → false
  for (const provider of ["grok", "kimi", "ollama", "openai", "anthropic"]) {
    it(`returns false when allProviders OFF + provider ${provider} + mini + sessionCount 2`, () => {
      assert.equal(
        shouldEscalateClaimedAction({ provider, effectiveTier: "mini", sessionCount: 2, allProviders: false }),
        false,
        `expected no escalation for provider ${provider}`
      );
    });
  }

  // sessionCount < 2 → false even when ON
  it("returns false when sessionCount < 2 even when allProviders ON + mini", () => {
    assert.equal(
      shouldEscalateClaimedAction({ provider: "grok", effectiveTier: "mini", sessionCount: 1, allProviders: true }),
      false
    );
    assert.equal(
      shouldEscalateClaimedAction({ provider: "gemini", effectiveTier: "mini", sessionCount: 0, allProviders: true }),
      false
    );
  });

  // tier !== mini → false even when ON
  it("returns false when tier is not mini even when allProviders ON + sessionCount>=2", () => {
    assert.equal(
      shouldEscalateClaimedAction({ provider: "grok", effectiveTier: "power", sessionCount: 2, allProviders: true }),
      false
    );
    assert.equal(
      shouldEscalateClaimedAction({ provider: "gemini", effectiveTier: "power", sessionCount: 5, allProviders: true }),
      false
    );
  });
});

// ── Skill max iterations clamp ──────────────────────────────────────────────

describe("clampSkillMaxIterations", () => {
  it("returns 16 for undefined / null / empty string", () => {
    assert.equal(clampSkillMaxIterations(undefined), 16);
    assert.equal(clampSkillMaxIterations(null), 16);
    assert.equal(clampSkillMaxIterations(""), 16);
  });

  it("returns 16 for NaN / non-numeric strings", () => {
    assert.equal(clampSkillMaxIterations(NaN), 16);
    assert.equal(clampSkillMaxIterations("abc"), 16);
    assert.equal(clampSkillMaxIterations({}), 16);
  });

  it("returns 8 as the minimum (below 8 clamps to 8)", () => {
    assert.equal(clampSkillMaxIterations(7), 8);
    assert.equal(clampSkillMaxIterations(0), 8);
    assert.equal(clampSkillMaxIterations(-5), 8);
    assert.equal(clampSkillMaxIterations("7"), 8);
  });

  it("returns 40 as the maximum (above 40 clamps to 40)", () => {
    assert.equal(clampSkillMaxIterations(99), 40);
    assert.equal(clampSkillMaxIterations(1000), 40);
    assert.equal(clampSkillMaxIterations("99"), 40);
  });

  it("passes through integers in range", () => {
    assert.equal(clampSkillMaxIterations(16), 16);
    assert.equal(clampSkillMaxIterations(8), 8);
    assert.equal(clampSkillMaxIterations(40), 40);
    assert.equal(clampSkillMaxIterations(20), 20);
  });

  it("passes through numeric strings in range (floors floats)", () => {
    assert.equal(clampSkillMaxIterations("12"), 12);
    assert.equal(clampSkillMaxIterations("16"), 16);
    assert.equal(clampSkillMaxIterations("8"), 8);
    assert.equal(clampSkillMaxIterations("40"), 40);
  });

  it("floors floats in range", () => {
    assert.equal(clampSkillMaxIterations(12.9), 12);
    assert.equal(clampSkillMaxIterations(16.5), 16);
    assert.equal(clampSkillMaxIterations("20.99"), 20);
  });

  it("clamps floats outside the range", () => {
    assert.equal(clampSkillMaxIterations(7.5), 8);
    assert.equal(clampSkillMaxIterations(40.5), 40);
    assert.equal(clampSkillMaxIterations(99.9), 40);
  });
});

// ── Agent (chat) max iterations clamp ───────────────────────────────────────

describe("clampAgentMaxIterations", () => {
  it("returns 20 for undefined / null / empty string", () => {
    assert.equal(clampAgentMaxIterations(undefined), 20);
    assert.equal(clampAgentMaxIterations(null), 20);
    assert.equal(clampAgentMaxIterations(""), 20);
  });

  it("returns 20 for NaN / non-numeric strings", () => {
    assert.equal(clampAgentMaxIterations(NaN), 20);
    assert.equal(clampAgentMaxIterations("abc"), 20);
  });

  it("returns 10 as the minimum", () => {
    assert.equal(clampAgentMaxIterations(7), 10);
    assert.equal(clampAgentMaxIterations(0), 10);
    assert.equal(clampAgentMaxIterations("9"), 10);
  });

  it("returns 40 as the maximum", () => {
    assert.equal(clampAgentMaxIterations(99), 40);
    assert.equal(clampAgentMaxIterations("1000"), 40);
  });

  it("passes through integers and numeric strings in range", () => {
    assert.equal(clampAgentMaxIterations(20), 20);
    assert.equal(clampAgentMaxIterations(10), 10);
    assert.equal(clampAgentMaxIterations(40), 40);
    assert.equal(clampAgentMaxIterations("32"), 32);
    assert.equal(clampAgentMaxIterations(32.9), 32);
  });
});

describe("shortCircuitMessage", () => {
  it("returns Written successfully. for a plain write", () => {
    assert.equal(shortCircuitMessage({ name: "roam_create_block" }, {}), "Written successfully.");
  });

  it("returns generic for a specialised tool without the extra flag", () => {
    assert.equal(shortCircuitMessage({ name: "cos_cron_create" }, {}), "Written successfully.");
  });

  it("returns generic for ROAM_EXECUTE wrapping a write", () => {
    assert.equal(
      shortCircuitMessage({ name: "ROAM_EXECUTE", arguments: { tool_name: "roam_update_block" } }, {}),
      "Written successfully."
    );
  });

  it("cos_write_draft_skill", () => {
    assert.equal(
      shortCircuitMessage({ name: "cos_write_draft_skill" }, { skill_name: "MySkill" }),
      "Draft skill \"MySkill\" written to Skills page."
    );
  });

  it("cos_update_memory", () => {
    assert.equal(
      shortCircuitMessage({ name: "cos_update_memory" }, { page: "MyPage", action: "created" }),
      "MyPage created successfully."
    );
  });

  it("cos_cron_create with created + reminder + when", () => {
    assert.equal(
      shortCircuitMessage({ name: "cos_cron_create" }, { created: true, type: "reminder", nextRunLocal: "09:00" }),
      "Reminder set — I'll notify you at 09:00."
    );
  });

  it("cos_cron_create with created + reminder without when", () => {
    assert.equal(
      shortCircuitMessage({ name: "cos_cron_create" }, { created: true, type: "reminder" }),
      "Reminder set."
    );
  });

  it("cos_cron_create with created + other type with when", () => {
    assert.equal(
      shortCircuitMessage({ name: "cos_cron_create" }, { created: true, type: "cron", name: "Backup", nextRunLocal: "10:00" }),
      "Scheduled cron \"Backup\" — next run at 10:00."
    );
  });

  it("cos_cron_create with created + other type without when", () => {
    assert.equal(
      shortCircuitMessage({ name: "cos_cron_create" }, { created: true, type: "cron", name: "Backup" }),
      "Scheduled cron \"Backup\" successfully."
    );
  });

  it("cos_cron_update with updated", () => {
    assert.equal(
      shortCircuitMessage({ name: "cos_cron_update" }, { updated: true, id: "job-1" }),
      "Job \"job-1\" updated."
    );
  });

  it("cos_cron_delete with deleted", () => {
    assert.equal(
      shortCircuitMessage({ name: "cos_cron_delete" }, { deleted: true, id: "job-2" }),
      "Job \"job-2\" deleted."
    );
  });

  it("cos_cron_delete_jobs with deleted array", () => {
    assert.equal(
      shortCircuitMessage({ name: "cos_cron_delete_jobs" }, { deleted: [{ name: "A" }, { name: "B" }] }),
      "Deleted 2 job(s): \"A\", \"B\"."
    );
  });

  it("cos_cron_delete_jobs with deleted array and notFound", () => {
    assert.equal(
      shortCircuitMessage({ name: "cos_cron_delete_jobs" }, { deleted: [{ name: "A" }], notFound: ["missing"] }),
      "Deleted 1 job(s): \"A\". Not found: missing."
    );
  });

  it("cos_schedule_block success includes slot_string", () => {
    assert.equal(
      shortCircuitMessage(
        { name: "cos_schedule_block" },
        { slot_string: "19:00 - 21:00 (**120'**) ((todo1))" }
      ),
      "Timed block placed: 19:00 - 21:00 (**120'**) ((todo1))"
    );
  });

  it("cos_schedule_block overlapped success", () => {
    assert.equal(
      shortCircuitMessage(
        { name: "cos_schedule_block" },
        { slot_string: "19:00 - 21:00 (**120'**) ((todo2))", overlapped: true }
      ),
      "Timed block placed alongside an existing one: 19:00 - 21:00 (**120'**) ((todo2))"
    );
  });

  it("ROAM_EXECUTE inner cos_schedule_block success includes slot_string", () => {
    assert.equal(
      shortCircuitMessage(
        { name: "ROAM_EXECUTE", arguments: { tool_name: "cos_schedule_block" } },
        { slot_string: "14:00 - 15:00 (**60'**) ((todo3))" }
      ),
      "Timed block placed: 14:00 - 15:00 (**60'**) ((todo3))"
    );
  });

  it("cos_schedule_block unschedule", () => {
    assert.equal(
      shortCircuitMessage(
        { name: "cos_schedule_block" },
        { unscheduled: true, slot_string: "21:00 - 00:00 (**180'**) ((g))" }
      ),
      "Timed block removed: 21:00 - 00:00 (**180'**) ((g))"
    );
  });

  it("cos_schedule_block moved/rescheduled", () => {
    assert.equal(
      shortCircuitMessage(
        { name: "cos_schedule_block" },
        { rescheduled: true, slot_string: "22:00 - 01:00 (**180'**) ((g))" }
      ),
      "Timed block moved: 22:00 - 01:00 (**180'**) ((g))"
    );
    assert.equal(
      shortCircuitMessage(
        { name: "cos_schedule_block" },
        {
          moved: true,
          moved_string: "21:00 - 23:00 (**120'**) ((m))",
          slot_string: "19:00 - 21:00 (**120'**) ((l))",
        }
      ),
      "Timed block moved: 21:00 - 23:00 (**120'**) ((m))\nTimed block placed: 19:00 - 21:00 (**120'**) ((l))"
    );
  });

  it("batchShortCircuitMessage combines multi-window successes", () => {
    const msg = batchShortCircuitMessage([
      { result: { success: true, slot_string: "09:00 - 10:00 (**60'**) ((a))" } },
      { result: { success: true, slot_string: "10:00 - 11:00 (**60'**) ((b))" } },
    ]);
    assert.equal(
      msg,
      "Timed block placed: 09:00 - 10:00 (**60'**) ((a))\nTimed block placed: 10:00 - 11:00 (**60'**) ((b))"
    );
  });
});
