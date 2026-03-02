import test from "node:test";
import assert from "node:assert/strict";
import {
  initLocalMcp,
  suspendMcpServer,
  unsuspendMcpServer,
  isServerSuspended,
  getServerKeyForTool,
  getSuspendedServers,
  getLocalMcpTools,
  buildLocalMcpMetaTool,
  formatToolListByServer,
  formatServerToolList,
  buildLocalMcpRouteTool,
  getLocalMcpClients,
  getLocalMcpToolsCache,
  invalidateLocalMcpToolsCache,
  cleanupLocalMcp,
} from "../src/local-mcp.js";

// ── Test helpers ─────────────────────────────────────────────────────────────

/** Minimal deps stub — override per-test as needed. */
function stubDeps(overrides = {}) {
  const storedSettings = {};
  return {
    debugLog: () => {},
    getExtensionAPI: () => ({
      settings: {
        get: (key) => storedSettings[key],
        set: (key, val) => { storedSettings[key] = val; },
      },
    }),
    SETTINGS_KEY_mcpSchemaHashes: "mcp-schema-hashes",
    showInfoToast: () => {},
    showErrorToast: () => {},
    getLocalMcpPorts: () => [],
    scanToolDescriptions: () => [],
    checkSchemaPin: async () => ({ status: "skipped" }),
    updateMcpBom: async () => {},
    isUnloadInProgress: () => false,
    COMPOSIO_AUTO_CONNECT_DELAY_MS: 0,
    _storedSettings: storedSettings,
    ...overrides,
  };
}

function makeTool(name, opts = {}) {
  return {
    name,
    description: opts.description || `${name} description`,
    input_schema: opts.input_schema || { type: "object", properties: {} },
    _serverName: opts.serverName || "test-server",
    _serverDescription: opts.serverDescription || "",
    _port: opts.port || 3000,
    _isDirect: opts.isDirect !== undefined ? opts.isDirect : true,
    execute: opts.execute || (async () => ({ ok: true })),
  };
}

// ── Setup & teardown ─────────────────────────────────────────────────────────

test.beforeEach(() => {
  // Reset module state before each test
  initLocalMcp(stubDeps());
  // Clear clients Map and suspension state
  cleanupLocalMcp();
  const clients = getLocalMcpClients();
  for (const key of clients.keys()) clients.delete(key);
});

// ═════════════════════════════════════════════════════════════════════════════
// suspendMcpServer / unsuspendMcpServer / isServerSuspended / getSuspendedServers
// ═════════════════════════════════════════════════════════════════════════════

test("suspendMcpServer adds server to suspended state", () => {
  suspendMcpServer("local:3000", { summary: "schema changed", serverName: "zotero" });
  assert.ok(isServerSuspended("local:3000"));
});

test("isServerSuspended returns false for non-suspended server", () => {
  assert.ok(!isServerSuspended("local:9999"));
});

test("unsuspendMcpServer removes server from suspended state without accepting pin", () => {
  suspendMcpServer("local:3000", { summary: "changed", serverName: "s" });
  const result = unsuspendMcpServer("local:3000", false);
  assert.ok(result);
  assert.ok(!isServerSuspended("local:3000"));
});

test("unsuspendMcpServer returns false for non-suspended server", () => {
  const result = unsuspendMcpServer("local:9999", false);
  assert.ok(!result);
});

test("unsuspendMcpServer with acceptNewPin updates stored settings", () => {
  const deps = stubDeps();
  initLocalMcp(deps);
  suspendMcpServer("local:3000", {
    newHash: "abc123hash",
    newToolNames: ["tool_a", "tool_b"],
    newFingerprints: { a: "fp1" },
    summary: "tools changed",
    serverName: "zotero",
  });
  unsuspendMcpServer("local:3000", true);
  const stored = deps._storedSettings["mcp-schema-hashes"];
  assert.equal(stored["local:3000"], "abc123hash");
  assert.deepEqual(stored["local:3000_tools"], ["tool_a", "tool_b"]);
  assert.deepEqual(stored["local:3000_fingerprints"], { a: "fp1" });
  assert.ok(!isServerSuspended("local:3000"));
});

test("getSuspendedServers returns array of suspended entries with serverKey", () => {
  suspendMcpServer("local:3000", { summary: "a", serverName: "s1" });
  suspendMcpServer("composio:GMAIL", { summary: "b", serverName: "s2" });
  const servers = getSuspendedServers();
  assert.equal(servers.length, 2);
  const keys = servers.map(s => s.serverKey).sort();
  assert.deepEqual(keys, ["composio:GMAIL", "local:3000"]);
  // Each entry should have suspendedAt
  for (const s of servers) {
    assert.ok(typeof s.suspendedAt === "number");
    assert.ok(s.suspendedAt > 0);
  }
});

test("getSuspendedServers returns empty array when nothing suspended", () => {
  assert.deepEqual(getSuspendedServers(), []);
});

// ═════════════════════════════════════════════════════════════════════════════
// getServerKeyForTool
// ═════════════════════════════════════════════════════════════════════════════

test("getServerKeyForTool returns local:PORT for direct MCP tool", () => {
  const tool = makeTool("zotero_search", { port: 4000 });
  assert.equal(getServerKeyForTool("zotero_search", tool, {}), "local:4000");
});

test("getServerKeyForTool returns null for LOCAL_MCP_ROUTE", () => {
  assert.equal(getServerKeyForTool("LOCAL_MCP_ROUTE", null, {}), null);
});

test("getServerKeyForTool resolves LOCAL_MCP_EXECUTE via server_name lookup", () => {
  // Populate localMcpClients with a server entry
  const clients = getLocalMcpClients();
  clients.set(5000, { client: {}, serverName: "github-mcp", tools: [] });

  const key = getServerKeyForTool("LOCAL_MCP_EXECUTE", null, { server_name: "github-mcp" });
  assert.equal(key, "local:5000");
});

test("getServerKeyForTool returns null for LOCAL_MCP_EXECUTE with unknown server", () => {
  const key = getServerKeyForTool("LOCAL_MCP_EXECUTE", null, { server_name: "unknown" });
  assert.equal(key, null);
});

test("getServerKeyForTool resolves COMPOSIO_MULTI_EXECUTE_TOOL via suspended keys", () => {
  suspendMcpServer("composio:GMAIL", { summary: "changed", serverName: "Gmail" });
  const key = getServerKeyForTool("COMPOSIO_MULTI_EXECUTE_TOOL", null, {
    tools: [{ tool_slug: "GMAIL_SEND_EMAIL" }],
  });
  assert.equal(key, "composio:GMAIL");
});

test("getServerKeyForTool returns null for COMPOSIO tool with no suspended match", () => {
  const key = getServerKeyForTool("COMPOSIO_MULTI_EXECUTE_TOOL", null, {
    tools: [{ tool_slug: "SLACK_POST_MESSAGE" }],
  });
  assert.equal(key, null);
});

test("getServerKeyForTool returns null for regular non-MCP tool", () => {
  assert.equal(getServerKeyForTool("roam_search", null, {}), null);
  assert.equal(getServerKeyForTool("cos_update_memory", {}, {}), null);
});

// ═════════════════════════════════════════════════════════════════════════════
// getLocalMcpTools / invalidateLocalMcpToolsCache
// ═════════════════════════════════════════════════════════════════════════════

test("getLocalMcpTools returns empty array when no clients", () => {
  assert.deepEqual(getLocalMcpTools(), []);
});

test("getLocalMcpTools aggregates tools from all clients", () => {
  const clients = getLocalMcpClients();
  clients.set(3000, {
    client: {},
    tools: [makeTool("tool_a"), makeTool("tool_b")],
  });
  clients.set(4000, {
    client: {},
    tools: [makeTool("tool_c")],
  });
  invalidateLocalMcpToolsCache(); // force rebuild

  const tools = getLocalMcpTools();
  assert.equal(tools.length, 3);
  assert.deepEqual(tools.map(t => t.name).sort(), ["tool_a", "tool_b", "tool_c"]);
});

test("getLocalMcpTools deduplicates by tool name", () => {
  const clients = getLocalMcpClients();
  clients.set(3000, { client: {}, tools: [makeTool("dup_tool")] });
  clients.set(4000, { client: {}, tools: [makeTool("dup_tool")] });
  invalidateLocalMcpToolsCache();

  const tools = getLocalMcpTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "dup_tool");
});

test("getLocalMcpTools skips entries with null client", () => {
  const clients = getLocalMcpClients();
  clients.set(3000, { client: null, tools: [makeTool("orphan")] });
  clients.set(4000, { client: {}, tools: [makeTool("real")] });
  invalidateLocalMcpToolsCache();

  const tools = getLocalMcpTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, "real");
});

test("getLocalMcpTools caches result until invalidated", () => {
  const clients = getLocalMcpClients();
  clients.set(3000, { client: {}, tools: [makeTool("cached_tool")] });
  invalidateLocalMcpToolsCache();

  const first = getLocalMcpTools();
  // Add another client — should NOT appear because cache is warm
  clients.set(4000, { client: {}, tools: [makeTool("new_tool")] });
  const second = getLocalMcpTools();
  assert.strictEqual(first, second); // same reference

  // Invalidate and rebuild
  invalidateLocalMcpToolsCache();
  const third = getLocalMcpTools();
  assert.equal(third.length, 2);
});

test("invalidateLocalMcpToolsCache sets cache to null", () => {
  // Warm the cache
  const clients = getLocalMcpClients();
  clients.set(3000, { client: {}, tools: [makeTool("t")] });
  invalidateLocalMcpToolsCache();
  getLocalMcpTools();
  assert.ok(getLocalMcpToolsCache() !== null);

  invalidateLocalMcpToolsCache();
  assert.equal(getLocalMcpToolsCache(), null);
});

// ═════════════════════════════════════════════════════════════════════════════
// formatToolListByServer
// ═════════════════════════════════════════════════════════════════════════════

test("formatToolListByServer groups tools by server name", () => {
  const tools = [
    makeTool("search", { serverName: "Zotero" }),
    makeTool("cite", { serverName: "Zotero" }),
    makeTool("commit", { serverName: "GitHub" }),
  ];
  const result = formatToolListByServer(tools);
  assert.ok(result.includes("Zotero (2 tools)"));
  assert.ok(result.includes("GitHub (1 tools)"));
  assert.ok(result.includes("3 tools across 2 servers"));
});

test("formatToolListByServer uses singular header for single server", () => {
  const tools = [makeTool("a", { serverName: "MyServer" }), makeTool("b", { serverName: "MyServer" })];
  const result = formatToolListByServer(tools);
  assert.ok(result.includes("## MyServer — 2 tools available"));
  assert.ok(!result.includes("across"));
});

test("formatToolListByServer handles tool with no description", () => {
  const tool = makeTool("nodesc", { serverName: "S" });
  tool.description = "";
  const result = formatToolListByServer([tool]);
  assert.ok(result.includes("(no description)"));
});

test("formatToolListByServer handles tool with missing server name", () => {
  const tool = makeTool("orphan");
  tool._serverName = undefined;
  const result = formatToolListByServer([tool]);
  assert.ok(result.includes("unknown"));
});

// ═════════════════════════════════════════════════════════════════════════════
// formatServerToolList
// ═════════════════════════════════════════════════════════════════════════════

test("formatServerToolList returns object with text property", () => {
  const tools = [makeTool("search", { serverName: "Zotero" })];
  const result = formatServerToolList(tools, "Zotero");
  assert.ok(typeof result.text === "string");
  assert.ok(result.text.includes("Zotero — 1 tools available"));
  assert.ok(result.text.includes("LOCAL_MCP_EXECUTE"));
});

test("formatServerToolList includes input schema for tools with properties", () => {
  const tool = makeTool("search", {
    serverName: "Zotero",
    input_schema: { type: "object", properties: { query: { type: "string" } } },
  });
  const result = formatServerToolList([tool], "Zotero");
  assert.ok(result.text.includes("Input:"));
  assert.ok(result.text.includes('"query"'));
});

test("formatServerToolList omits input schema for tools with empty properties", () => {
  const tool = makeTool("ping", {
    serverName: "S",
    input_schema: { type: "object", properties: {} },
  });
  const result = formatServerToolList([tool], "S");
  assert.ok(!result.text.includes("Input:"));
});

// ═════════════════════════════════════════════════════════════════════════════
// buildLocalMcpMetaTool
// ═════════════════════════════════════════════════════════════════════════════

test("buildLocalMcpMetaTool returns correct tool shape", () => {
  const tool = buildLocalMcpMetaTool();
  assert.equal(tool.name, "LOCAL_MCP_EXECUTE");
  assert.ok(tool.description.includes("Execute a tool"));
  assert.deepEqual(tool.input_schema.required, ["tool_name"]);
  assert.ok(typeof tool.execute === "function");
});

test("buildLocalMcpMetaTool execute returns error for missing tool_name", async () => {
  const tool = buildLocalMcpMetaTool();
  const result = await tool.execute({});
  assert.ok(result.error.includes("tool_name is required"));
});

test("buildLocalMcpMetaTool execute returns error for unknown tool", async () => {
  invalidateLocalMcpToolsCache();
  const tool = buildLocalMcpMetaTool();
  const result = await tool.execute({ tool_name: "nonexistent" });
  assert.ok(result.error.includes("not found"));
});

test("buildLocalMcpMetaTool execute dispatches to matching cached tool", async () => {
  const clients = getLocalMcpClients();
  let calledWith = null;
  clients.set(3000, {
    client: {},
    tools: [makeTool("zotero_search", {
      execute: async (args) => { calledWith = args; return { results: [] }; },
    })],
  });
  invalidateLocalMcpToolsCache();
  getLocalMcpTools(); // warm cache

  const metaTool = buildLocalMcpMetaTool();
  const result = await metaTool.execute({ tool_name: "zotero_search", arguments: { query: "test" } });
  assert.deepEqual(calledWith, { query: "test" });
  assert.deepEqual(result, { results: [] });
});

// ═════════════════════════════════════════════════════════════════════════════
// buildLocalMcpRouteTool
// ═════════════════════════════════════════════════════════════════════════════

test("buildLocalMcpRouteTool returns correct tool shape", () => {
  const tool = buildLocalMcpRouteTool();
  assert.equal(tool.name, "LOCAL_MCP_ROUTE");
  assert.equal(tool.isMutating, false);
  assert.deepEqual(tool.input_schema.required, ["server_name"]);
});

test("buildLocalMcpRouteTool execute returns error for missing server_name", async () => {
  const tool = buildLocalMcpRouteTool();
  const result = await tool.execute({});
  assert.ok(result.error.includes("server_name is required"));
});

test("buildLocalMcpRouteTool execute returns tools for matching routed server", async () => {
  const clients = getLocalMcpClients();
  clients.set(3000, {
    client: {},
    tools: [
      makeTool("gh_search", { serverName: "GitHub", isDirect: false }),
      makeTool("gh_commit", { serverName: "GitHub", isDirect: false }),
    ],
  });
  invalidateLocalMcpToolsCache();
  getLocalMcpTools();

  const tool = buildLocalMcpRouteTool();
  const result = await tool.execute({ server_name: "GitHub" });
  assert.ok(result.text.includes("GitHub"));
  assert.ok(result.text.includes("gh_search"));
  assert.ok(result.text.includes("gh_commit"));
});

test("buildLocalMcpRouteTool execute case-insensitive fallback", async () => {
  const clients = getLocalMcpClients();
  clients.set(3000, {
    client: {},
    tools: [makeTool("z_search", { serverName: "Zotero", isDirect: false })],
  });
  invalidateLocalMcpToolsCache();
  getLocalMcpTools();

  const tool = buildLocalMcpRouteTool();
  const result = await tool.execute({ server_name: "zotero" });
  assert.ok(result.text.includes("Zotero"));
});

test("buildLocalMcpRouteTool execute guides direct tool usage", async () => {
  const clients = getLocalMcpClients();
  clients.set(3000, {
    client: {},
    tools: [makeTool("simple_tool", { serverName: "Simple", isDirect: true })],
  });
  invalidateLocalMcpToolsCache();
  getLocalMcpTools();

  const tool = buildLocalMcpRouteTool();
  const result = await tool.execute({ server_name: "Simple" });
  assert.ok(result.error.includes("DIRECT tool"));
  assert.ok(result.error.includes("simple_tool"));
});

test("buildLocalMcpRouteTool execute returns error for unknown server", async () => {
  invalidateLocalMcpToolsCache();
  getLocalMcpTools();

  const tool = buildLocalMcpRouteTool();
  const result = await tool.execute({ server_name: "NonExistent" });
  assert.ok(result.error.includes("not found"));
});

test("buildLocalMcpRouteTool injects available server names in schema", () => {
  const clients = getLocalMcpClients();
  clients.set(3000, {
    client: {},
    tools: [
      makeTool("gh_tool", { serverName: "GitHub", isDirect: false }),
      makeTool("zot_tool", { serverName: "Zotero", isDirect: false }),
    ],
  });
  invalidateLocalMcpToolsCache();
  getLocalMcpTools();

  const tool = buildLocalMcpRouteTool();
  const desc = tool.input_schema.properties.server_name.description;
  assert.ok(desc.includes("GitHub"));
  assert.ok(desc.includes("Zotero"));
});

// ═════════════════════════════════════════════════════════════════════════════
// cleanupLocalMcp
// ═════════════════════════════════════════════════════════════════════════════

test("cleanupLocalMcp clears tools cache and suspended servers", () => {
  // Set up some state
  suspendMcpServer("local:3000", { summary: "test", serverName: "s" });
  const clients = getLocalMcpClients();
  clients.set(3000, { client: {}, tools: [makeTool("t")] });
  invalidateLocalMcpToolsCache();
  getLocalMcpTools(); // warm cache
  assert.ok(getLocalMcpToolsCache() !== null);

  cleanupLocalMcp();
  assert.equal(getLocalMcpToolsCache(), null);
  assert.deepEqual(getSuspendedServers(), []);
});
