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
} from "../src/agent-loop.js";

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
    SETTINGS_KEYS: { ludicrousModeEnabled: "ludicrous-mode-enabled" },
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
