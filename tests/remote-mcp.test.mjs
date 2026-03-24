import test from "node:test";
import assert from "node:assert/strict";
import {
  initRemoteMcp,
  normalizeRemoteMcpUrl,
  parseAuthHeader,
  getRemoteMcpTools,
  getRemoteMcpClients,
  getRemoteMcpToolsCache,
  invalidateRemoteMcpToolsCache,
  getRemoteServerKeyForTool,
  buildRemoteMcpRouteTool,
  buildRemoteMcpMetaTool,
  cleanupRemoteMcp,
} from "../src/remote-mcp.js";

// ── Test helpers ─────────────────────────────────────────────────────────────

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
    getRemoteMcpServers: () => [],
    getProxiedRemoteUrl: (url) => url,
    scanToolDescriptions: () => [],
    checkSchemaPin: async () => ({ status: "skipped" }),
    updateMcpBom: async () => {},
    isUnloadInProgress: () => false,
    COMPOSIO_AUTO_CONNECT_DELAY_MS: 0,
    getOAuthAuthHeader: async () => null,
    getOAuthValidToken: async () => "",
    _storedSettings: storedSettings,
    ...overrides,
  };
}

function makeRemoteTool(name, opts = {}) {
  return {
    name,
    description: opts.description || `${name} description`,
    input_schema: opts.input_schema || { type: "object", properties: {} },
    _serverName: opts.serverName || "remote-server",
    _serverDescription: opts.serverDescription || "",
    _urlKey: opts.urlKey || "https://example.com/mcp",
    _isDirect: opts.isDirect !== undefined ? opts.isDirect : true,
    _isRemote: true,
    execute: opts.execute || (async () => ({ ok: true })),
  };
}

/** Inject a fake connected entry into remoteMcpClients for test isolation. */
function seedClient(urlKey, serverName, tools, opts = {}) {
  const clients = getRemoteMcpClients();
  clients.set(urlKey, {
    client: null, transport: null, abortController: null,
    serverName, serverDescription: opts.description || "",
    tools,
    lastFailureAt: 0, failureCount: 0, connectPromise: null,
    _nameFragments: [], _urlKey: urlKey,
  });
  invalidateRemoteMcpToolsCache();
}

// Reset module state before each group
function resetState() {
  cleanupRemoteMcp();
  initRemoteMcp(stubDeps());
}

// ── normalizeRemoteMcpUrl ────────────────────────────────────────────────────

test("normalizeRemoteMcpUrl strips trailing slash", () => {
  assert.equal(normalizeRemoteMcpUrl("https://example.com/mcp/"), "https://example.com/mcp");
});

test("normalizeRemoteMcpUrl lowercases protocol and host", () => {
  assert.equal(normalizeRemoteMcpUrl("HTTPS://Example.COM/Path"), "https://example.com/Path");
});

test("normalizeRemoteMcpUrl preserves path case", () => {
  assert.equal(normalizeRemoteMcpUrl("https://example.com/MyMCP/v1"), "https://example.com/MyMCP/v1");
});

test("normalizeRemoteMcpUrl handles invalid URL gracefully", () => {
  const result = normalizeRemoteMcpUrl("not-a-url");
  assert.equal(typeof result, "string");
  assert.ok(result.length > 0);
});

test("normalizeRemoteMcpUrl handles empty string", () => {
  const result = normalizeRemoteMcpUrl("");
  assert.equal(result, "");
});

// ── parseAuthHeader ──────────────────────────────────────────────────────────

test("parseAuthHeader returns { name, value } for valid inputs", () => {
  const result = parseAuthHeader("x-brain-key", "my-secret");
  assert.deepEqual(result, { name: "x-brain-key", value: "my-secret" });
});

test("parseAuthHeader trims whitespace", () => {
  const result = parseAuthHeader("  Authorization  ", "  Bearer token  ");
  assert.deepEqual(result, { name: "Authorization", value: "Bearer token" });
});

test("parseAuthHeader returns null when header name is empty", () => {
  assert.equal(parseAuthHeader("", "token"), null);
});

test("parseAuthHeader returns null when token is empty", () => {
  assert.equal(parseAuthHeader("x-api-key", ""), null);
});

test("parseAuthHeader returns null when both are empty", () => {
  assert.equal(parseAuthHeader("", ""), null);
});

test("parseAuthHeader returns null when both are undefined", () => {
  assert.equal(parseAuthHeader(undefined, undefined), null);
});

// ── getRemoteMcpTools ────────────────────────────────────────────────────────

test("getRemoteMcpTools returns empty array when no servers connected", () => {
  resetState();
  assert.deepEqual(getRemoteMcpTools(), []);
});

test("getRemoteMcpTools returns tools from connected server", () => {
  resetState();
  const tools = [makeRemoteTool("search"), makeRemoteTool("capture")];
  seedClient("https://example.com/mcp", "My Server", tools);
  const result = getRemoteMcpTools();
  assert.equal(result.length, 2);
  assert.equal(result[0].name, "search");
});

test("getRemoteMcpTools returns cached array on second call", () => {
  resetState();
  seedClient("https://example.com/mcp", "My Server", [makeRemoteTool("tool1")]);
  const first = getRemoteMcpTools();
  const second = getRemoteMcpTools();
  assert.equal(first, second); // same reference = cached
});

test("getRemoteMcpTools rebuilds after invalidateRemoteMcpToolsCache", () => {
  resetState();
  seedClient("https://example.com/mcp", "My Server", [makeRemoteTool("tool1")]);
  const first = getRemoteMcpTools();
  invalidateRemoteMcpToolsCache();
  // Re-seed with a different tool
  seedClient("https://example.com/mcp", "My Server", [makeRemoteTool("tool1"), makeRemoteTool("tool2")]);
  const second = getRemoteMcpTools();
  assert.notEqual(first, second);
  assert.equal(second.length, 2);
});

test("getRemoteMcpTools aggregates tools from multiple servers", () => {
  resetState();
  seedClient("https://a.example.com/mcp", "Server A", [makeRemoteTool("toolA", { urlKey: "https://a.example.com/mcp", serverName: "Server A" })]);
  seedClient("https://b.example.com/mcp", "Server B", [makeRemoteTool("toolB", { urlKey: "https://b.example.com/mcp", serverName: "Server B" })]);
  const result = getRemoteMcpTools();
  assert.equal(result.length, 2);
});

test("getRemoteMcpTools namespaces colliding tool names from different servers", () => {
  resetState();
  seedClient("https://a.example.com/mcp", "Server A", [makeRemoteTool("shared_tool", { serverName: "Server A" })]);
  seedClient("https://b.example.com/mcp", "Server B", [makeRemoteTool("shared_tool", { serverName: "Server B" })]);
  const result = getRemoteMcpTools();
  // Both tools present, namespaced
  assert.equal(result.length, 2);
  assert.equal(result[0].name, "server_a__shared_tool");
  assert.equal(result[0]._originalName, "shared_tool");
  assert.equal(result[1].name, "server_b__shared_tool");
  assert.equal(result[1]._originalName, "shared_tool");
});

// ── buildRemoteMcpRouteTool ──────────────────────────────────────────────────

test("buildRemoteMcpRouteTool returns REMOTE_MCP_ROUTE tool", () => {
  resetState();
  const tool = buildRemoteMcpRouteTool();
  assert.equal(tool.name, "REMOTE_MCP_ROUTE");
  assert.equal(tool.isMutating, false);
});

test("REMOTE_MCP_ROUTE execute returns error for unknown server", async () => {
  resetState();
  const tool = buildRemoteMcpRouteTool();
  const result = await tool.execute({ server_name: "nonexistent" });
  assert.ok(result.error);
  assert.ok(result.error.includes("nonexistent"));
});

test("REMOTE_MCP_ROUTE execute returns error with guidance for direct-tool server", async () => {
  resetState();
  const directTool = makeRemoteTool("my_tool", { serverName: "DirectServer", isDirect: true });
  seedClient("https://direct.example.com/mcp", "DirectServer", [directTool]);
  // Force cache rebuild
  getRemoteMcpTools();
  const routeTool = buildRemoteMcpRouteTool();
  const result = await routeTool.execute({ server_name: "DirectServer" });
  assert.ok(result.error);
  assert.ok(result.error.includes("DIRECT"));
});

test("REMOTE_MCP_ROUTE execute returns tool list for routed server", async () => {
  resetState();
  const routedTools = Array.from({ length: 16 }, (_, i) =>
    makeRemoteTool(`tool_${i}`, { serverName: "BigServer", isDirect: false })
  );
  seedClient("https://big.example.com/mcp", "BigServer", routedTools);
  getRemoteMcpTools();
  const routeTool = buildRemoteMcpRouteTool();
  const result = await routeTool.execute({ server_name: "BigServer" });
  assert.ok(result.text);
  assert.ok(result.text.includes("BigServer"));
});

// ── buildRemoteMcpMetaTool ───────────────────────────────────────────────────

test("buildRemoteMcpMetaTool returns REMOTE_MCP_EXECUTE tool", () => {
  resetState();
  const tool = buildRemoteMcpMetaTool();
  assert.equal(tool.name, "REMOTE_MCP_EXECUTE");
});

test("REMOTE_MCP_EXECUTE returns error when tool_name missing", async () => {
  resetState();
  const meta = buildRemoteMcpMetaTool();
  const result = await meta.execute({});
  assert.ok(result.error);
  assert.ok(result.error.includes("tool_name"));
});

test("REMOTE_MCP_EXECUTE calls correct tool from cache", async () => {
  resetState();
  let called = false;
  const tools = [makeRemoteTool("my_remote_tool", { execute: async () => { called = true; return { ok: true }; } })];
  seedClient("https://example.com/mcp", "My Server", tools);
  getRemoteMcpTools(); // build cache
  const meta = buildRemoteMcpMetaTool();
  const result = await meta.execute({ tool_name: "my_remote_tool", arguments: {} });
  assert.equal(called, true);
  assert.deepEqual(result, { ok: true });
});

test("REMOTE_MCP_EXECUTE uses case-insensitive fallback for tool name", async () => {
  resetState();
  let called = false;
  const tools = [makeRemoteTool("MyTool", { execute: async () => { called = true; return {}; } })];
  seedClient("https://example.com/mcp", "Server", tools);
  getRemoteMcpTools();
  const meta = buildRemoteMcpMetaTool();
  await meta.execute({ tool_name: "mytool" });
  assert.equal(called, true);
});

test("REMOTE_MCP_EXECUTE returns error for unknown tool", async () => {
  resetState();
  seedClient("https://example.com/mcp", "Server", [makeRemoteTool("existing")]);
  getRemoteMcpTools();
  const meta = buildRemoteMcpMetaTool();
  const result = await meta.execute({ tool_name: "no_such_tool" });
  assert.ok(result.error);
});

// ── getRemoteServerKeyForTool ────────────────────────────────────────────────

test("getRemoteServerKeyForTool returns remote key for direct tool with _urlKey", () => {
  const tool = makeRemoteTool("my_tool", { urlKey: "https://example.com/mcp" });
  const key = getRemoteServerKeyForTool("my_tool", tool, {});
  assert.equal(key, "remote:https://example.com/mcp");
});

test("getRemoteServerKeyForTool returns null when _isRemote is missing", () => {
  const tool = { name: "my_tool", _urlKey: "https://example.com/mcp" }; // no _isRemote
  const key = getRemoteServerKeyForTool("my_tool", tool, {});
  assert.equal(key, null);
});

test("getRemoteServerKeyForTool resolves REMOTE_MCP_EXECUTE by server name", () => {
  resetState();
  const urlKey = "https://example.com/mcp";
  seedClient(urlKey, "My Server", []);
  const key = getRemoteServerKeyForTool("REMOTE_MCP_EXECUTE", null, { server_name: "My Server" });
  assert.equal(key, `remote:${urlKey}`);
});

test("getRemoteServerKeyForTool returns null for REMOTE_MCP_ROUTE", () => {
  const key = getRemoteServerKeyForTool("REMOTE_MCP_ROUTE", null, { server_name: "x" });
  assert.equal(key, null);
});

test("getRemoteServerKeyForTool returns null for non-remote tools", () => {
  const key = getRemoteServerKeyForTool("roam_search", { name: "roam_search" }, {});
  assert.equal(key, null);
});

// ── cleanupRemoteMcp ─────────────────────────────────────────────────────────

test("cleanupRemoteMcp clears tools cache", () => {
  resetState();
  seedClient("https://example.com/mcp", "Server", [makeRemoteTool("tool1")]);
  getRemoteMcpTools(); // populate cache
  assert.ok(getRemoteMcpToolsCache() !== null);
  cleanupRemoteMcp();
  assert.equal(getRemoteMcpToolsCache(), null);
});

test("cleanupRemoteMcp clears remoteMcpClients Map", () => {
  resetState();
  seedClient("https://example.com/mcp", "Server", [makeRemoteTool("tool1")]);
  assert.equal(getRemoteMcpClients().size, 1);
  cleanupRemoteMcp();
  assert.equal(getRemoteMcpClients().size, 0);
});

test("cleanupRemoteMcp is idempotent (safe to call twice)", () => {
  resetState();
  cleanupRemoteMcp();
  cleanupRemoteMcp(); // should not throw
  assert.ok(true);
});
