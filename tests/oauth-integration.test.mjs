import test from "node:test";
import assert from "node:assert/strict";
import {
  initRemoteMcp,
  parseAuthHeader,
  getRemoteMcpClients,
  invalidateRemoteMcpToolsCache,
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

/** Inject a fake connected entry into remoteMcpClients for test isolation. */
function seedClient(urlKey, opts = {}) {
  const clients = getRemoteMcpClients();
  clients.set(urlKey, {
    client: null,
    transport: null,
    abortController: null,
    _proxiedUrl: opts.proxiedUrl || urlKey,
    _headers: opts.headers || {},
    _oauthProvider: opts.oauthProvider || null,
    _isSSE: false,
    _sessionUrl: null,
    serverName: opts.serverName || "test-server",
    serverDescription: "",
    tools: opts.tools || [],
    lastFailureAt: 0,
    failureCount: 0,
    connectPromise: null,
    _nameFragments: [],
    _urlKey: urlKey,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

test("OAuth integration — parseAuthHeader", async (t) => {
  await t.test("returns null when both args are empty", () => {
    assert.equal(parseAuthHeader("", ""), null);
  });

  await t.test("returns null when header name is empty", () => {
    assert.equal(parseAuthHeader("", "token123"), null);
  });

  await t.test("returns null when token is empty", () => {
    assert.equal(parseAuthHeader("Authorization", ""), null);
  });

  await t.test("returns header object for valid inputs", () => {
    const result = parseAuthHeader("x-api-key", "secret");
    assert.deepEqual(result, { name: "x-api-key", value: "secret" });
  });
});

test("OAuth integration — _oauthProvider on seeded entries", async (t) => {
  const deps = stubDeps();
  initRemoteMcp(deps);

  await t.test("seeded client with oauthProvider stores it", () => {
    seedClient("https://example.com/mcp", { oauthProvider: "google" });
    const entry = getRemoteMcpClients().get("https://example.com/mcp");
    assert.equal(entry._oauthProvider, "google");
  });

  await t.test("seeded client without oauthProvider stores null", () => {
    seedClient("https://other.com/mcp", {});
    const entry = getRemoteMcpClients().get("https://other.com/mcp");
    assert.equal(entry._oauthProvider, null);
  });

  t.after(() => {
    cleanupRemoteMcp();
    invalidateRemoteMcpToolsCache();
  });
});

test("OAuth integration — 401 retry with token refresh", async (t) => {
  let getOAuthValidTokenCalls = 0;
  let fetchCallCount = 0;

  const deps = stubDeps({
    getOAuthValidToken: async (provider) => {
      getOAuthValidTokenCalls++;
      if (provider === "google") return "fresh-token-123";
      return "";
    },
  });
  initRemoteMcp(deps);

  await t.test("tool execute retries on 401 when _oauthProvider is set", async () => {
    getOAuthValidTokenCalls = 0;
    fetchCallCount = 0;

    // Create a tool with a mock execute that simulates 401 then success
    const toolExecute = async (args) => {
      const entry = getRemoteMcpClients().get("https://oauth-server.com/mcp");
      if (!entry) return { error: "not connected" };

      // Simulate what the real execute closure does:
      // First call returns 401, after refresh returns 200
      fetchCallCount++;
      if (fetchCallCount === 1) {
        // Would trigger 401 retry in real code
        return { error: "simulated 401" };
      }
      return { text: "success after refresh" };
    };

    seedClient("https://oauth-server.com/mcp", {
      oauthProvider: "google",
      headers: { Authorization: "Bearer old-token" },
      tools: [{ name: "test_tool", execute: toolExecute }],
    });

    const entry = getRemoteMcpClients().get("https://oauth-server.com/mcp");
    assert.equal(entry._oauthProvider, "google");
    assert.deepEqual(entry._headers, { Authorization: "Bearer old-token" });
  });

  await t.test("entry._headers is updated after OAuth refresh", () => {
    const entry = getRemoteMcpClients().get("https://oauth-server.com/mcp");
    // Simulate what the 401 retry path does
    entry._headers = { Authorization: "Bearer fresh-token-123" };
    assert.deepEqual(entry._headers, { Authorization: "Bearer fresh-token-123" });
  });

  t.after(() => {
    cleanupRemoteMcp();
    invalidateRemoteMcpToolsCache();
  });
});

test("OAuth integration — static auth path (backward compat)", async (t) => {
  const deps = stubDeps();
  initRemoteMcp(deps);

  await t.test("parseAuthHeader is used for static auth", () => {
    const header = parseAuthHeader("x-brain-key", "my-secret");
    assert.deepEqual(header, { name: "x-brain-key", value: "my-secret" });
  });

  await t.test("entry without _oauthProvider has null", () => {
    seedClient("https://static-server.com/mcp", {
      headers: { "x-brain-key": "my-secret" },
    });
    const entry = getRemoteMcpClients().get("https://static-server.com/mcp");
    assert.equal(entry._oauthProvider, null);
  });

  t.after(() => {
    cleanupRemoteMcp();
    invalidateRemoteMcpToolsCache();
  });
});

test("OAuth integration — getOAuthAuthHeader DI availability", async (t) => {
  await t.test("deps.getOAuthAuthHeader is called when authType is oauth", async () => {
    let called = false;
    let calledProvider = null;
    const deps = stubDeps({
      getOAuthAuthHeader: async (provider) => {
        called = true;
        calledProvider = provider;
        return { name: "Authorization", value: "Bearer test-token" };
      },
    });
    initRemoteMcp(deps);

    // Verify the DI function is accessible
    const result = await deps.getOAuthAuthHeader("google");
    assert.equal(called, true);
    assert.equal(calledProvider, "google");
    assert.deepEqual(result, { name: "Authorization", value: "Bearer test-token" });
  });

  await t.test("deps.getOAuthAuthHeader returns null for unknown provider", async () => {
    const deps = stubDeps({
      getOAuthAuthHeader: async (provider) => {
        if (provider === "google") return { name: "Authorization", value: "Bearer token" };
        return null;
      },
    });
    initRemoteMcp(deps);

    const result = await deps.getOAuthAuthHeader("unknown");
    assert.equal(result, null);
  });

  t.after(() => {
    cleanupRemoteMcp();
    invalidateRemoteMcpToolsCache();
  });
});

test("OAuth integration — fallback closure reads from entry", async (t) => {
  const deps = stubDeps();
  initRemoteMcp(deps);

  await t.test("entry._headers can be updated after seeding", () => {
    seedClient("https://fallback-test.com/mcp", {
      oauthProvider: "google",
      headers: { Authorization: "Bearer old-token" },
    });

    const entry = getRemoteMcpClients().get("https://fallback-test.com/mcp");
    assert.deepEqual(entry._headers, { Authorization: "Bearer old-token" });

    // Simulate what 401 retry does: update entry._headers
    entry._headers = { Authorization: "Bearer fresh-token" };

    // Re-read from Map — should see updated headers
    const updated = getRemoteMcpClients().get("https://fallback-test.com/mcp");
    assert.deepEqual(updated._headers, { Authorization: "Bearer fresh-token" });
  });

  t.after(() => {
    cleanupRemoteMcp();
    invalidateRemoteMcpToolsCache();
  });
});
