import test from "node:test";
import assert from "node:assert/strict";
import {
  initMcpOAuthProvider,
  createMcpOAuthProvider,
  getMcpOAuthStatus,
  clearMcpOAuthCredentials,
  urlToHash,
  MCP_OAUTH_CALLBACK_URL,
  MCP_OAUTH_CALLBACK_ORIGIN,
} from "../src/mcp-oauth-provider.js";

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeStorage() {
  const store = {};
  return {
    settings: {
      get: (key) => store[key],
      set: (key, val) => { store[key] = val; },
    },
    _store: store,
  };
}

function initWithStorage(overrides = {}) {
  const extensionAPI = makeStorage();
  initMcpOAuthProvider({
    extensionAPI,
    debugLog: () => {},
    redactForLog: (s) => s,
    showInfoToast: () => {},
    showErrorToast: () => {},
    ...overrides,
  });
  return extensionAPI;
}

// ── urlToHash ────────────────────────────────────────────────────────────────

test("urlToHash produces a stable, settings-key-safe string", () => {
  const hash = urlToHash("https://mcp.linear.app/mcp");
  assert.ok(hash.length > 0 && hash.length <= 24);
  assert.ok(/^[a-zA-Z0-9]+$/.test(hash), "hash should be alphanumeric only");
  // Deterministic
  assert.strictEqual(hash, urlToHash("https://mcp.linear.app/mcp"));
});

test("urlToHash produces different hashes for different URLs", () => {
  const a = urlToHash("https://mcp.linear.app/mcp");
  const b = urlToHash("https://mcp.notion.com/sse");
  assert.notStrictEqual(a, b);
});

// ── Constants ────────────────────────────────────────────────────────────────

test("MCP_OAUTH_CALLBACK_URL is a valid HTTPS URL", () => {
  const url = new URL(MCP_OAUTH_CALLBACK_URL);
  assert.strictEqual(url.protocol, "https:");
});

test("MCP_OAUTH_CALLBACK_ORIGIN matches the callback URL origin", () => {
  const url = new URL(MCP_OAUTH_CALLBACK_URL);
  assert.strictEqual(MCP_OAUTH_CALLBACK_ORIGIN, url.origin);
});

// ── createMcpOAuthProvider — basic properties ────────────────────────────────

test("provider has correct redirectUrl", () => {
  initWithStorage();
  const provider = createMcpOAuthProvider({ urlHash: "abc123" });
  assert.strictEqual(provider.redirectUrl, MCP_OAUTH_CALLBACK_URL);
});

test("provider clientMetadata is well-formed", () => {
  initWithStorage();
  const provider = createMcpOAuthProvider({ urlHash: "abc123" });
  const meta = provider.clientMetadata;
  assert.strictEqual(meta.client_name, "Chief of Staff (Roam Research)");
  assert.ok(Array.isArray(meta.redirect_uris));
  assert.strictEqual(meta.redirect_uris.length, 1);
  assert.ok(meta.redirect_uris[0] instanceof URL);
  assert.deepStrictEqual(meta.grant_types, ["authorization_code", "refresh_token"]);
  assert.deepStrictEqual(meta.response_types, ["code"]);
  assert.strictEqual(meta.token_endpoint_auth_method, "none");
});

test("provider state() returns a non-empty string and stores it as _lastState", () => {
  initWithStorage();
  const provider = createMcpOAuthProvider({ urlHash: "abc123" });
  const state = provider.state();
  assert.ok(typeof state === "string" && state.length > 0);
  assert.strictEqual(provider._lastState, state);
});

test("provider._urlHash is exposed for internal use", () => {
  initWithStorage();
  const provider = createMcpOAuthProvider({ urlHash: "abc123" });
  assert.strictEqual(provider._urlHash, "abc123");
});

// ── Client information — pre-registered ──────────────────────────────────────

test("clientInformation returns pre-registered client_id when set", async () => {
  initWithStorage();
  const provider = createMcpOAuthProvider({
    urlHash: "test1",
    preRegisteredClientId: "my-client-id",
    preRegisteredClientSecret: "my-secret",
  });
  const info = await provider.clientInformation();
  assert.strictEqual(info.client_id, "my-client-id");
  assert.strictEqual(info.client_secret, "my-secret");
});

test("clientInformation omits secret when not provided", async () => {
  initWithStorage();
  const provider = createMcpOAuthProvider({
    urlHash: "test2",
    preRegisteredClientId: "my-client-id",
  });
  const info = await provider.clientInformation();
  assert.strictEqual(info.client_id, "my-client-id");
  assert.strictEqual(info.client_secret, undefined);
});

test("clientInformation ignores blank pre-registered client_id", async () => {
  initWithStorage();
  const provider = createMcpOAuthProvider({
    urlHash: "test3",
    preRegisteredClientId: "  ",
  });
  const info = await provider.clientInformation();
  assert.strictEqual(info, undefined);
});

// ── Client information — DCR stored ──────────────────────────────────────────

test("saveClientInformation + clientInformation round-trip", async () => {
  initWithStorage();
  const provider = createMcpOAuthProvider({ urlHash: "dcr1" });
  assert.strictEqual(await provider.clientInformation(), undefined);

  await provider.saveClientInformation({ client_id: "dcr-id-123", client_secret: "dcr-secret" });
  const info = await provider.clientInformation();
  assert.strictEqual(info.client_id, "dcr-id-123");
  assert.strictEqual(info.client_secret, "dcr-secret");
});

test("pre-registered client_id takes precedence over DCR stored", async () => {
  initWithStorage();
  const provider = createMcpOAuthProvider({
    urlHash: "dcr2",
    preRegisteredClientId: "pre-reg",
  });
  await provider.saveClientInformation({ client_id: "dcr-id" });
  const info = await provider.clientInformation();
  assert.strictEqual(info.client_id, "pre-reg");
});

// ── Token storage ────────────────────────────────────────────────────────────

test("tokens() returns undefined when no tokens stored", async () => {
  initWithStorage();
  const provider = createMcpOAuthProvider({ urlHash: "tok1" });
  assert.strictEqual(await provider.tokens(), undefined);
});

test("saveTokens + tokens round-trip", async () => {
  initWithStorage();
  const provider = createMcpOAuthProvider({ urlHash: "tok2" });
  await provider.saveTokens({ access_token: "at-123", refresh_token: "rt-456", expires_in: 3600, token_type: "bearer" });
  const tokens = await provider.tokens();
  assert.strictEqual(tokens.access_token, "at-123");
  assert.strictEqual(tokens.refresh_token, "rt-456");
  assert.strictEqual(tokens.expires_in, 3600);
  assert.ok(tokens._saved_at > 0, "_saved_at timestamp should be set");
});

// ── PKCE code verifier ───────────────────────────────────────────────────────

test("codeVerifier returns empty string when not set", async () => {
  initWithStorage();
  const provider = createMcpOAuthProvider({ urlHash: "pkce1" });
  assert.strictEqual(await provider.codeVerifier(), "");
});

test("saveCodeVerifier + codeVerifier round-trip", async () => {
  initWithStorage();
  const provider = createMcpOAuthProvider({ urlHash: "pkce2" });
  await provider.saveCodeVerifier("my-verifier-string");
  assert.strictEqual(await provider.codeVerifier(), "my-verifier-string");
});

// ── Credential invalidation ──────────────────────────────────────────────────

test("invalidateCredentials('all') clears all storage", async () => {
  initWithStorage();
  const provider = createMcpOAuthProvider({ urlHash: "inv1" });
  await provider.saveClientInformation({ client_id: "c1" });
  await provider.saveTokens({ access_token: "t1", token_type: "bearer" });
  await provider.saveCodeVerifier("v1");

  await provider.invalidateCredentials("all");
  assert.strictEqual(await provider.clientInformation(), undefined);
  assert.strictEqual(await provider.tokens(), undefined);
  assert.strictEqual(await provider.codeVerifier(), "");
});

test("invalidateCredentials('tokens') clears only tokens", async () => {
  initWithStorage();
  const provider = createMcpOAuthProvider({ urlHash: "inv2" });
  await provider.saveClientInformation({ client_id: "c2" });
  await provider.saveTokens({ access_token: "t2", token_type: "bearer" });

  await provider.invalidateCredentials("tokens");
  const clientInfo = await provider.clientInformation();
  assert.strictEqual(clientInfo.client_id, "c2");  // still there
  assert.strictEqual(await provider.tokens(), undefined);
});

test("invalidateCredentials('client') clears only client info", async () => {
  initWithStorage();
  const provider = createMcpOAuthProvider({ urlHash: "inv3" });
  await provider.saveClientInformation({ client_id: "c3" });
  await provider.saveTokens({ access_token: "t3", token_type: "bearer" });

  await provider.invalidateCredentials("client");
  assert.strictEqual(await provider.clientInformation(), undefined);
  const tokens = await provider.tokens();
  assert.strictEqual(tokens.access_token, "t3");  // still there
});

// ── Storage isolation between providers ──────────────────────────────────────

test("two providers with different urlHash are isolated", async () => {
  initWithStorage();
  const p1 = createMcpOAuthProvider({ urlHash: "iso1" });
  const p2 = createMcpOAuthProvider({ urlHash: "iso2" });

  await p1.saveTokens({ access_token: "tok-1", token_type: "bearer" });
  await p2.saveTokens({ access_token: "tok-2", token_type: "bearer" });

  const t1 = await p1.tokens();
  const t2 = await p2.tokens();
  assert.strictEqual(t1.access_token, "tok-1");
  assert.strictEqual(t2.access_token, "tok-2");
});

// ── getMcpOAuthStatus ────────────────────────────────────────────────────────

test("getMcpOAuthStatus returns not connected for unknown URL", () => {
  initWithStorage();
  const status = getMcpOAuthStatus("https://unknown.example.com/mcp");
  assert.strictEqual(status.connected, false);
  assert.strictEqual(status.hasClientInfo, false);
  assert.strictEqual(status.isExpired, false);
});

test("getMcpOAuthStatus returns connected after saving tokens", async () => {
  const extensionAPI = initWithStorage();
  const url = "https://mcp.test.com/mcp";
  const hash = urlToHash(url);
  const provider = createMcpOAuthProvider({ urlHash: hash });
  await provider.saveTokens({ access_token: "at-status", token_type: "bearer", expires_in: 3600 });

  const status = getMcpOAuthStatus(url);
  assert.strictEqual(status.connected, true);
  assert.strictEqual(status.isExpired, false);
});

test("getMcpOAuthStatus detects expired tokens", async () => {
  const extensionAPI = initWithStorage();
  const url = "https://mcp.expired.com/mcp";
  const hash = urlToHash(url);
  // Manually write a token that's already expired
  const expiredTokens = {
    access_token: "at-expired",
    token_type: "bearer",
    expires_in: 1,  // 1 second
    _saved_at: Date.now() - 120_000,  // 2 minutes ago
  };
  extensionAPI.settings.set(`mcp-oauth-tokens-${hash}`, JSON.stringify(expiredTokens));

  const status = getMcpOAuthStatus(url);
  assert.strictEqual(status.connected, true);
  assert.strictEqual(status.isExpired, true);
});

test("getMcpOAuthStatus detects stored client info", async () => {
  initWithStorage();
  const url = "https://mcp.clientinfo.com/mcp";
  const hash = urlToHash(url);
  const provider = createMcpOAuthProvider({ urlHash: hash });
  await provider.saveClientInformation({ client_id: "cid-test" });

  const status = getMcpOAuthStatus(url);
  assert.strictEqual(status.hasClientInfo, true);
});

// ── clearMcpOAuthCredentials ─────────────────────────────────────────────────

test("clearMcpOAuthCredentials removes all state for a server", async () => {
  initWithStorage();
  const url = "https://mcp.clear.com/mcp";
  const hash = urlToHash(url);
  const provider = createMcpOAuthProvider({ urlHash: hash });
  await provider.saveClientInformation({ client_id: "c-clear" });
  await provider.saveTokens({ access_token: "t-clear", token_type: "bearer" });
  await provider.saveCodeVerifier("v-clear");

  clearMcpOAuthCredentials(url);

  const status = getMcpOAuthStatus(url);
  assert.strictEqual(status.connected, false);
  assert.strictEqual(status.hasClientInfo, false);
});

test("clearMcpOAuthCredentials is safe for unknown URLs", () => {
  initWithStorage();
  assert.doesNotThrow(() => clearMcpOAuthCredentials("https://nope.example.com/mcp"));
  assert.doesNotThrow(() => clearMcpOAuthCredentials(""));
  assert.doesNotThrow(() => clearMcpOAuthCredentials(null));
});

// ── redirectToAuthorization sets _authPromise ────────────────────────────────

test("redirectToAuthorization in silent mode rejects _authPromise immediately", async () => {
  initWithStorage();
  const provider = createMcpOAuthProvider({ urlHash: "redir1", silent: true });
  assert.strictEqual(provider._authPromise, null);

  await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));

  assert.ok(provider._authPromise !== null, "_authPromise should be set");
  try {
    await provider._authPromise;
    assert.fail("Should have rejected");
  } catch (e) {
    assert.ok(e.message.includes("silent mode"), `Unexpected error: ${e.message}`);
  }
});

test("redirectToAuthorization requires state() to be called first", async () => {
  initWithStorage();
  const provider = createMcpOAuthProvider({ urlHash: "redir2" });
  // Don't call state() — _lastState is null

  await provider.redirectToAuthorization(new URL("https://auth.example.com/authorize"));

  assert.ok(provider._authPromise !== null);
  try {
    await provider._authPromise;
    assert.fail("Should have rejected");
  } catch (e) {
    assert.ok(e.message.includes("no state"), `Unexpected error: ${e.message}`);
  }
});

// ── Edge cases ───────────────────────────────────────────────────────────────

test("getMcpOAuthStatus handles empty/null URL gracefully", () => {
  initWithStorage();
  assert.deepStrictEqual(getMcpOAuthStatus(""), { connected: false, hasClientInfo: false, isExpired: false });
  assert.deepStrictEqual(getMcpOAuthStatus(null), { connected: false, hasClientInfo: false, isExpired: false });
});

test("provider handles corrupted storage gracefully", async () => {
  const extensionAPI = initWithStorage();
  const hash = "corrupt1";
  extensionAPI.settings.set(`mcp-oauth-tokens-${hash}`, "not-valid-json");
  const provider = createMcpOAuthProvider({ urlHash: hash });
  // Should return undefined rather than throwing
  assert.strictEqual(await provider.tokens(), undefined);
});

test("provider handles missing extensionAPI gracefully", async () => {
  // Init with null extensionAPI
  initMcpOAuthProvider({
    extensionAPI: null,
    debugLog: () => {},
    redactForLog: (s) => s,
    showInfoToast: () => {},
    showErrorToast: () => {},
  });
  const provider = createMcpOAuthProvider({ urlHash: "noop1" });
  // Should not throw
  assert.strictEqual(await provider.tokens(), undefined);
  assert.strictEqual(await provider.clientInformation(), undefined);
  assert.strictEqual(await provider.codeVerifier(), "");
});
