import test from "node:test";
import assert from "node:assert/strict";
import {
  initToolExecution,
  isPotentiallyMutatingTool,
  isLikelyLiveDataReadIntent,
  extractToolCalls,
  convertMessagesForProvider,
  detectSuccessfulWriteToolCallsInMessages,
  computeToolCallScope,
} from "../src/tool-execution.js";

// ── Shared mock deps ────────────────────────────────────────────────────────

function makeDeps(overrides = {}) {
  return {
    getRoamNativeTools: () => [],
    getBetterTasksTools: () => [],
    getCosIntegrationTools: () => [],
    getCronTools: () => [],
    getExternalExtensionTools: () => [],
    getLocalMcpToolsCache: () => [],
    getComposioMetaToolsForLlm: () => [],
    getComposioSafeMultiExecuteSlugAllowlist: () => new Set(),
    isOpenAICompatible: (p) => p !== "anthropic",
    debugLog: () => {},
    getLocalMcpClients: () => new Map(),
    WRITE_TOOL_NAMES: new Set(["roam_create_block", "roam_update_block", "roam_delete_block"]),
    ...overrides,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// isPotentiallyMutatingTool
// ═════════════════════════════════════════════════════════════════════════════

test("isPotentiallyMutatingTool: Priority 1 — explicit isMutating flag on tool object", () => {
  initToolExecution(makeDeps());
  assert.equal(isPotentiallyMutatingTool("my_tool", {}, { isMutating: true }), true);
  assert.equal(isPotentiallyMutatingTool("my_tool", {}, { isMutating: false }), false);
});

test("isPotentiallyMutatingTool: Priority 1 — resolves via deps when no toolObj", () => {
  initToolExecution(makeDeps({
    getRoamNativeTools: () => [{ name: "roam_search", isMutating: false }],
  }));
  assert.equal(isPotentiallyMutatingTool("roam_search", {}), false);
});

test("isPotentiallyMutatingTool: empty name returns false", () => {
  initToolExecution(makeDeps());
  assert.equal(isPotentiallyMutatingTool("", {}), false);
  assert.equal(isPotentiallyMutatingTool(null, {}), false);
});

test("isPotentiallyMutatingTool: MANAGE_CONNECTIONS — safe actions", () => {
  initToolExecution(makeDeps());
  assert.equal(isPotentiallyMutatingTool("MANAGE_CONNECTIONS", { action: "list" }), false);
  assert.equal(isPotentiallyMutatingTool("MANAGE_CONNECTIONS", { action: "status" }), false);
  assert.equal(isPotentiallyMutatingTool("MANAGE_CONNECTIONS", { action: "check" }), false);
  assert.equal(isPotentiallyMutatingTool("MANAGE_CONNECTIONS", { action: "get" }), false);
});

test("isPotentiallyMutatingTool: MANAGE_CONNECTIONS — mutating actions", () => {
  initToolExecution(makeDeps());
  assert.equal(isPotentiallyMutatingTool("MANAGE_CONNECTIONS", { action: "disconnect" }), true);
  assert.equal(isPotentiallyMutatingTool("MANAGE_CONNECTIONS", { action: "connect" }), true);
  assert.equal(isPotentiallyMutatingTool("MANAGE_CONNECTIONS", {}), true);
});

test("isPotentiallyMutatingTool: COMPOSIO_MULTI_EXECUTE_TOOL — empty tools array is mutating", () => {
  initToolExecution(makeDeps());
  assert.equal(isPotentiallyMutatingTool("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [] }), true);
  assert.equal(isPotentiallyMutatingTool("COMPOSIO_MULTI_EXECUTE_TOOL", {}), true);
});

test("isPotentiallyMutatingTool: LOCAL_MCP_EXECUTE — uses inner tool isMutating", () => {
  initToolExecution(makeDeps({
    getLocalMcpToolsCache: () => [
      { name: "zotero_get_collections", isMutating: false },
      { name: "zotero_create_item", isMutating: true },
    ],
  }));
  assert.equal(
    isPotentiallyMutatingTool("LOCAL_MCP_EXECUTE", { tool_name: "zotero_get_collections" }),
    false
  );
  assert.equal(
    isPotentiallyMutatingTool("LOCAL_MCP_EXECUTE", { tool_name: "zotero_create_item" }),
    true
  );
});

test("isPotentiallyMutatingTool: LOCAL_MCP_EXECUTE — heuristic fallback for unannotated inner tool", () => {
  initToolExecution(makeDeps({
    getLocalMcpToolsCache: () => [{ name: "custom_fetch_data" }],
  }));
  // "FETCH" is a read-only token → should not be mutating
  assert.equal(
    isPotentiallyMutatingTool("LOCAL_MCP_EXECUTE", { tool_name: "custom_fetch_data" }),
    false
  );
  // No inner tool name → mutating (fail-closed)
  assert.equal(isPotentiallyMutatingTool("LOCAL_MCP_EXECUTE", {}), true);
});

test("isPotentiallyMutatingTool: external extension tools — fail-closed (no metadata)", () => {
  initToolExecution(makeDeps({
    getExternalExtensionTools: () => [{ name: "EXT_GET_DATA" }],
  }));
  // Even though "GET" is in the name, fail-closed returns true
  assert.equal(isPotentiallyMutatingTool("EXT_GET_DATA", {}), true);
});

test("isPotentiallyMutatingTool: local MCP tools — heuristic on name tokens", () => {
  initToolExecution(makeDeps({
    getLocalMcpToolsCache: () => [
      { name: "search_documents" },
      { name: "delete_item" },
    ],
  }));
  // "SEARCH" is a read-only token
  assert.equal(isPotentiallyMutatingTool("search_documents", {}), false);
  // "DELETE" triggers sensitive-token fallback — but first, the tool IS in local cache
  // so it should use the local MCP heuristic. "DELETE" is NOT a read-only token → mutating.
  assert.equal(isPotentiallyMutatingTool("delete_item", {}), true);
});

test("isPotentiallyMutatingTool: final fallback — sensitive tokens for unknown tools", () => {
  initToolExecution(makeDeps());
  assert.equal(isPotentiallyMutatingTool("UNKNOWN_CREATE_THING", {}), true);
  assert.equal(isPotentiallyMutatingTool("UNKNOWN_DELETE_THING", {}), true);
  assert.equal(isPotentiallyMutatingTool("UNKNOWN_SEND_EMAIL", {}), true);
  assert.equal(isPotentiallyMutatingTool("totally_harmless", {}), false);
});

// ═════════════════════════════════════════════════════════════════════════════
// isLikelyLiveDataReadIntent
// ═════════════════════════════════════════════════════════════════════════════

test("isLikelyLiveDataReadIntent: explicit phrases trigger the guard", () => {
  initToolExecution(makeDeps());
  assert.equal(isLikelyLiveDataReadIntent("show me my most recent emails"), true);
  assert.equal(isLikelyLiveDataReadIntent("what's on my calendar today"), true);
  assert.equal(isLikelyLiveDataReadIntent("check my inbox"), true);
  assert.equal(isLikelyLiveDataReadIntent("show upcoming events"), true);
});

test("isLikelyLiveDataReadIntent: read verb + live data noun triggers", () => {
  initToolExecution(makeDeps());
  assert.equal(isLikelyLiveDataReadIntent("list my github issues"), true);
  assert.equal(isLikelyLiveDataReadIntent("search slack messages"), true);
  assert.equal(isLikelyLiveDataReadIntent("find papers about AI"), true);
});

test("isLikelyLiveDataReadIntent: action verb + live data noun triggers", () => {
  initToolExecution(makeDeps());
  assert.equal(isLikelyLiveDataReadIntent("delete that email"), true);
  assert.equal(isLikelyLiveDataReadIntent("send a message"), true);
});

test("isLikelyLiveDataReadIntent: skill update requests do NOT trigger", () => {
  initToolExecution(makeDeps());
  assert.equal(isLikelyLiveDataReadIntent("update my email skill to be better"), false);
  assert.equal(isLikelyLiveDataReadIntent("edit the calendar skill"), false);
});

test("isLikelyLiveDataReadIntent: capability questions do NOT trigger", () => {
  initToolExecution(makeDeps());
  assert.equal(isLikelyLiveDataReadIntent("do you have access to gmail"), false);
  assert.equal(isLikelyLiveDataReadIntent("are you connected to my calendar"), false);
  assert.equal(isLikelyLiveDataReadIntent("what tools do I have"), false);
});

test("isLikelyLiveDataReadIntent: meta/reflective questions do NOT trigger", () => {
  initToolExecution(makeDeps());
  assert.equal(isLikelyLiveDataReadIntent("how should I prompt you for emails"), false);
  assert.equal(isLikelyLiveDataReadIntent("what went wrong with the last request"), false);
  assert.equal(isLikelyLiveDataReadIntent("help me with email prompting techniques"), false);
});

test("isLikelyLiveDataReadIntent: empty input returns false", () => {
  initToolExecution(makeDeps());
  assert.equal(isLikelyLiveDataReadIntent(""), false);
  assert.equal(isLikelyLiveDataReadIntent(null), false);
});

test("isLikelyLiveDataReadIntent: generic text without live data nouns returns false", () => {
  initToolExecution(makeDeps());
  assert.equal(isLikelyLiveDataReadIntent("hello how are you"), false);
  assert.equal(isLikelyLiveDataReadIntent("create a block about cooking"), false);
});

test("isLikelyLiveDataReadIntent: sessionUsedLocalMcp forces true for substantive queries", () => {
  initToolExecution(makeDeps());
  // Short prompt without ? → false even with flag
  assert.equal(isLikelyLiveDataReadIntent("ok", { sessionUsedLocalMcp: true }), false);
  // Long prompt or ? → true with flag
  assert.equal(
    isLikelyLiveDataReadIntent("can you show me those results again please?", { sessionUsedLocalMcp: true }),
    true
  );
});

test("isLikelyLiveDataReadIntent: Roam context phrases trigger the guard", () => {
  initToolExecution(makeDeps());
  assert.equal(isLikelyLiveDataReadIntent("what page am I on?"), true);
  assert.equal(isLikelyLiveDataReadIntent("which page is this?"), true);
  assert.equal(isLikelyLiveDataReadIntent("where am I"), true);
  assert.equal(isLikelyLiveDataReadIntent("what's on today's page"), true);
  assert.equal(isLikelyLiveDataReadIntent("show me the daily page"), true);
  assert.equal(isLikelyLiveDataReadIntent("what's on today"), true);
});

test("isLikelyLiveDataReadIntent: Roam context phrases — write intents do NOT false-positive", () => {
  initToolExecution(makeDeps());
  // Generic Roam write operations should NOT trigger — the explicit phrase list
  // is narrow enough that page/block creation won't match
  assert.equal(isLikelyLiveDataReadIntent("create a page called Recipes"), false);
  assert.equal(isLikelyLiveDataReadIntent("add a block about cooking"), false);
  assert.equal(isLikelyLiveDataReadIntent("remember that I like tea"), false);
});

test("isLikelyLiveDataReadIntent: dynamic MCP server names expand nouns", () => {
  const clients = new Map();
  clients.set(7777, { serverName: "zotero-server", tools: [] });
  initToolExecution(makeDeps({ getLocalMcpClients: () => clients }));
  assert.equal(isLikelyLiveDataReadIntent("search zotero for papers"), true);
});

// ═════════════════════════════════════════════════════════════════════════════
// extractToolCalls
// ═════════════════════════════════════════════════════════════════════════════

test("extractToolCalls: Anthropic format", () => {
  initToolExecution(makeDeps());
  const response = {
    content: [
      { type: "text", text: "Thinking..." },
      { type: "tool_use", id: "tu_1", name: "roam_search", input: { query: "test" } },
      { type: "tool_use", id: "tu_2", name: "roam_create_block", input: { text: "hello" } },
    ],
  };
  const calls = extractToolCalls("anthropic", response);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, "roam_search");
  assert.deepEqual(calls[0].arguments, { query: "test" });
  assert.equal(calls[1].name, "roam_create_block");
});

test("extractToolCalls: OpenAI format", () => {
  initToolExecution(makeDeps());
  const response = {
    choices: [{
      message: {
        tool_calls: [
          { id: "call_1", function: { name: "roam_search", arguments: '{"query":"test"}' } },
        ],
      },
    }],
  };
  const calls = extractToolCalls("openai", response);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "roam_search");
  assert.deepEqual(calls[0].arguments, { query: "test" });
});

test("extractToolCalls: OpenAI format — recovers from malformed JSON args", () => {
  initToolExecution(makeDeps());
  const response = {
    choices: [{
      message: {
        tool_calls: [
          { id: "call_1", function: { name: "roam_search", arguments: '{"query":"test"} some trailing text' } },
        ],
      },
    }],
  };
  const calls = extractToolCalls("openai", response);
  assert.equal(calls.length, 1);
  // Should recover the JSON despite trailing text
  assert.deepEqual(calls[0].arguments, { query: "test" });
});

test("extractToolCalls: unknown provider returns empty", () => {
  initToolExecution(makeDeps({ isOpenAICompatible: () => false }));
  assert.deepEqual(extractToolCalls("unknown", {}), []);
});

test("extractToolCalls: Anthropic with empty content", () => {
  initToolExecution(makeDeps());
  assert.deepEqual(extractToolCalls("anthropic", {}), []);
  assert.deepEqual(extractToolCalls("anthropic", { content: [] }), []);
});

// ═════════════════════════════════════════════════════════════════════════════
// convertMessagesForProvider
// ═════════════════════════════════════════════════════════════════════════════

test("convertMessagesForProvider: same provider returns shallow copies", () => {
  initToolExecution(makeDeps());
  const msgs = [{ role: "user", content: "hello" }];
  const result = convertMessagesForProvider(msgs, "anthropic", "anthropic");
  assert.equal(result.length, 1);
  assert.equal(result[0].content, "hello");
  assert.notEqual(result[0], msgs[0]); // shallow copy, not reference
});

test("convertMessagesForProvider: OpenAI→OpenAI remaps tool IDs", () => {
  initToolExecution(makeDeps());
  const msgs = [
    {
      role: "assistant",
      content: "thinking",
      tool_calls: [{ id: "chatcmpl-abc123", function: { name: "roam_search", arguments: "{}" } }],
    },
    { role: "tool", tool_call_id: "chatcmpl-abc123", content: "result" },
  ];
  const result = convertMessagesForProvider(msgs, "openai", "gemini");
  // IDs should be remapped to call_N format
  assert.equal(result[0].tool_calls[0].id, "call_0");
  assert.equal(result[1].tool_call_id, "call_0");
});

test("convertMessagesForProvider: strips empty tool_calls arrays in OpenAI→OpenAI", () => {
  initToolExecution(makeDeps());
  const msgs = [
    { role: "assistant", content: "no tools here", tool_calls: [] },
  ];
  const result = convertMessagesForProvider(msgs, "openai", "gemini");
  assert.equal(result[0].tool_calls, undefined);
});

test("convertMessagesForProvider: Anthropic→OpenAI conversion", () => {
  initToolExecution(makeDeps());
  const msgs = [
    { role: "user", content: "test" },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Thinking..." },
        { type: "tool_use", id: "tu_1", name: "roam_search", input: { query: "q" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu_1", content: "result text" },
      ],
    },
  ];
  const result = convertMessagesForProvider(msgs, "anthropic", "openai");
  // Assistant message should have OpenAI format tool_calls
  const assistantMsg = result.find(m => m.role === "assistant");
  assert.ok(assistantMsg);
  assert.ok(Array.isArray(assistantMsg.tool_calls));
  assert.equal(assistantMsg.tool_calls[0].function.name, "roam_search");
  // Tool result should be role: "tool"
  const toolMsg = result.find(m => m.role === "tool");
  assert.ok(toolMsg);
});

test("convertMessagesForProvider: OpenAI→Anthropic conversion", () => {
  initToolExecution(makeDeps());
  const msgs = [
    { role: "user", content: "test" },
    {
      role: "assistant",
      content: "thinking",
      tool_calls: [
        { id: "call_0", function: { name: "roam_search", arguments: '{"query":"q"}' } },
      ],
    },
    { role: "tool", tool_call_id: "call_0", content: "result text" },
  ];
  const result = convertMessagesForProvider(msgs, "openai", "anthropic");
  // Assistant message should have Anthropic format content blocks
  const assistantMsg = result.find(m => m.role === "assistant");
  assert.ok(assistantMsg);
  assert.ok(Array.isArray(assistantMsg.content));
  const toolUseBlock = assistantMsg.content.find(b => b.type === "tool_use");
  assert.ok(toolUseBlock);
  assert.equal(toolUseBlock.name, "roam_search");
  // Tool result should be embedded in user message
  const userMsgs = result.filter(m => m.role === "user");
  const hasToolResult = userMsgs.some(m =>
    Array.isArray(m.content) && m.content.some(b => b.type === "tool_result")
  );
  assert.ok(hasToolResult);
});

// ═════════════════════════════════════════════════════════════════════════════
// detectSuccessfulWriteToolCallsInMessages
// ═════════════════════════════════════════════════════════════════════════════

test("detectSuccessfulWriteToolCallsInMessages: OpenAI format — detects successful writes", () => {
  initToolExecution(makeDeps());
  const messages = [
    {
      role: "assistant",
      tool_calls: [
        { id: "call_0", function: { name: "roam_create_block", arguments: '{"text":"hello"}' } },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_0",
      content: '{"success":true,"created_uids":["abc123"]}',
    },
  ];
  const writes = detectSuccessfulWriteToolCallsInMessages(messages);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].name, "roam_create_block");
});

test("detectSuccessfulWriteToolCallsInMessages: Anthropic format — detects successful writes", () => {
  initToolExecution(makeDeps());
  const messages = [
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "tu_1", name: "roam_update_block", input: { uid: "x", text: "new" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu_1", content: '{"success":true}' },
      ],
    },
  ];
  const writes = detectSuccessfulWriteToolCallsInMessages(messages);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].name, "roam_update_block");
});

test("detectSuccessfulWriteToolCallsInMessages: ignores failed writes (error field)", () => {
  initToolExecution(makeDeps());
  const messages = [
    {
      role: "assistant",
      tool_calls: [
        { id: "call_0", function: { name: "roam_create_block", arguments: '{"text":"hi"}' } },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_0",
      content: '{"error":"Block not found"}',
    },
  ];
  const writes = detectSuccessfulWriteToolCallsInMessages(messages);
  assert.equal(writes.length, 0);
});

test("detectSuccessfulWriteToolCallsInMessages: ignores failed writes (success: false)", () => {
  initToolExecution(makeDeps());
  const messages = [
    {
      role: "assistant",
      tool_calls: [
        { id: "call_0", function: { name: "roam_delete_block", arguments: '{"uid":"x"}' } },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_0",
      content: '{"success":false}',
    },
  ];
  const writes = detectSuccessfulWriteToolCallsInMessages(messages);
  assert.equal(writes.length, 0);
});

test("detectSuccessfulWriteToolCallsInMessages: ignores read-only tool calls", () => {
  initToolExecution(makeDeps());
  const messages = [
    {
      role: "assistant",
      tool_calls: [
        { id: "call_0", function: { name: "roam_search", arguments: '{"query":"test"}' } },
      ],
    },
    {
      role: "tool",
      tool_call_id: "call_0",
      content: '{"results":[]}',
    },
  ];
  const writes = detectSuccessfulWriteToolCallsInMessages(messages);
  assert.equal(writes.length, 0);
});

test("detectSuccessfulWriteToolCallsInMessages: empty messages returns empty", () => {
  initToolExecution(makeDeps());
  assert.deepEqual(detectSuccessfulWriteToolCallsInMessages([]), []);
  assert.deepEqual(detectSuccessfulWriteToolCallsInMessages(null), []);
});

test("detectSuccessfulWriteToolCallsInMessages: multiple writes across formats", () => {
  initToolExecution(makeDeps());
  const messages = [
    // OpenAI format write
    {
      role: "assistant",
      tool_calls: [
        { id: "call_0", function: { name: "roam_create_block", arguments: '{"text":"a"}' } },
      ],
    },
    { role: "tool", tool_call_id: "call_0", content: '{"success":true}' },
    // Anthropic format write in same conversation (e.g. after failover)
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "tu_1", name: "roam_update_block", input: { uid: "x" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "tu_1", content: '{"success":true}' },
      ],
    },
  ];
  const writes = detectSuccessfulWriteToolCallsInMessages(messages);
  assert.equal(writes.length, 2);
});

// ═════════════════════════════════════════════════════════════════════════════
// computeToolCallScope (roadmap #82 Phase 1 tool/scope logging)
// ═════════════════════════════════════════════════════════════════════════════

function makeScopeDeps(overrides = {}) {
  // Mock Roam API for page-uid resolution tests. Returns a title (truthy) for
  // any UID query so resolvePageUidForBlock short-circuits and treats input
  // UIDs as already being page UIDs.
  return makeDeps({
    getRoamAlphaApi: () => ({ q: () => "Mock Page" }),
    escapeForDatalog: (s) => String(s).replace(/"/g, '\\"'),
    ...overrides,
  });
}

test("computeToolCallScope: plain mutating Roam tool → tool scope", () => {
  initToolExecution(makeScopeDeps({
    getRoamNativeTools: () => [{ name: "roam_update_block", isMutating: true }],
  }));
  const scope = computeToolCallScope("roam_update_block", { uid: "abc" });
  assert.equal(scope.resolvedName, "roam_update_block");
  assert.equal(scope.scopeType, "tool");
  assert.deepEqual(scope.approvalKeys, ["roam_update_block"]);
});

test("computeToolCallScope: non-mutating tool → scopeType none, empty keys", () => {
  initToolExecution(makeScopeDeps({
    getRoamNativeTools: () => [{ name: "roam_search", isMutating: false }],
  }));
  const scope = computeToolCallScope("roam_search", { query: "x" });
  assert.equal(scope.scopeType, "none");
  assert.deepEqual(scope.approvalKeys, []);
  assert.equal(scope.resolvedName, "roam_search");
});

test("computeToolCallScope: COMPOSIO_MULTI_EXECUTE_TOOL → sorted-composite key", () => {
  initToolExecution(makeScopeDeps());
  const scope = computeToolCallScope("COMPOSIO_MULTI_EXECUTE_TOOL", {
    tools: [
      { tool_slug: "GMAIL_SEND" },
      { tool_slug: "GOOGLECAL_CREATE" },
    ],
  });
  assert.equal(scope.scopeType, "tool");
  // Slugs are sorted for stable keys
  assert.deepEqual(
    scope.approvalKeys,
    ["COMPOSIO_MULTI_EXECUTE_TOOL::GMAIL_SEND,GOOGLECAL_CREATE"]
  );
  assert.equal(scope.resolvedName, "GMAIL_SEND,GOOGLECAL_CREATE");
});

test("computeToolCallScope: LOCAL_MCP_EXECUTE unwraps inner tool name", () => {
  initToolExecution(makeScopeDeps({
    getLocalMcpToolsCache: () => [
      { name: "zotero_create_item", isMutating: true },
    ],
  }));
  const scope = computeToolCallScope("LOCAL_MCP_EXECUTE", {
    tool_name: "zotero_create_item",
    arguments: {},
  });
  assert.equal(scope.scopeType, "tool");
  assert.deepEqual(scope.approvalKeys, ["LOCAL_MCP_EXECUTE::zotero_create_item"]);
  assert.equal(scope.resolvedName, "zotero_create_item");
});

test("computeToolCallScope: roam_create_blocks with multi-batches fans out per page UID", () => {
  initToolExecution(makeScopeDeps({
    getRoamNativeTools: () => [{ name: "roam_create_blocks", isMutating: true }],
  }));
  const scope = computeToolCallScope("roam_create_blocks", {
    batches: [
      { parent_uid: "pgB", blocks: [{ string: "x" }] },
      { parent_uid: "pgA", blocks: [{ string: "y" }] },
    ],
  });
  assert.equal(scope.scopeType, "page");
  // Page keys are sorted for stable ordering
  assert.deepEqual(scope.approvalKeys, ["page::pgA", "page::pgB"]);
  assert.equal(scope.resolvedName, "roam_create_blocks");
});

test("computeToolCallScope: roam_create_block single parent_uid → single page key", () => {
  initToolExecution(makeScopeDeps({
    getRoamNativeTools: () => [{ name: "roam_create_block", isMutating: true }],
  }));
  const scope = computeToolCallScope("roam_create_block", { parent_uid: "pg1" });
  assert.equal(scope.scopeType, "page");
  assert.deepEqual(scope.approvalKeys, ["page::pg1"]);
});

test("computeToolCallScope: unknown/empty tool returns none scope", () => {
  initToolExecution(makeScopeDeps());
  assert.equal(computeToolCallScope("", {}).scopeType, "none");
  assert.equal(computeToolCallScope(null, null).scopeType, "none");
});
