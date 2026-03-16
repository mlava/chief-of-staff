import test from "node:test";
import assert from "node:assert/strict";
import { initRoamNativeTools, getRoamNativeTools, resetRoamNativeToolsCache } from "../src/roam-native-tools.js";

// ── Test helpers ─────────────────────────────────────────────────────────────

/** Minimal deps stub — override per-test as needed. */
function stubDeps(overrides = {}) {
  return {
    getRoamAlphaApi: () => ({}),
    queryRoamDatalog: async () => [],
    requireRoamUpdateBlockApi: () => {},
    requireRoamUidExists: async () => {},
    escapeForDatalog: (s) => s,
    truncateRoamBlockText: (s) => s,
    getBlockUid: () => null,
    getBlockString: () => "",
    getBlockChildren: () => [],
    createRoamBlock: async () => "mock-uid",
    createRoamBlockTree: async () => {},
    withRoamWriteRetry: async (fn) => fn(),
    ensurePageUidByTitle: async () => "mock-page-uid",
    ensureDailyPageUid: async () => "mock-daily-uid",
    getPageTreeByUidAsync: async () => ({}),
    getPageTreeByTitleAsync: async () => ({}),
    flattenBlockTree: () => [],
    countBlockTreeNodes: () => 0,
    parseMarkdownToBlockTree: () => [],
    formatRoamDate: () => "March 16th, 2026",
    updateChiefMemory: async () => {},
    getActiveMemoryPageTitles: () => [],
    getSkillEntries: () => [],
    findSkillEntryByName: () => null,
    invalidateSkillsPromptCache: () => {},
    debugLog: () => {},
    BLOCK_TREE_PULL_PATTERN: "",
    MAX_CREATE_BLOCKS_TOTAL: 100,
    SKILLS_PAGE_TITLE: "Chief of Staff/Skills",
    getCloudflareApiToken: () => "test-cf-token",
    getCloudflareAccountId: () => "test-cf-account",
    getCorsProxyUrl: () => "https://test-proxy.workers.dev",
    ...overrides,
  };
}

/** Find the roam_web_fetch tool from the tools array. */
function getWebFetchTool(depsOverrides = {}) {
  resetRoamNativeToolsCache();
  initRoamNativeTools(stubDeps(depsOverrides));
  const tools = getRoamNativeTools();
  const tool = tools.find(t => t.name === "roam_web_fetch");
  assert.ok(tool, "roam_web_fetch tool should exist");
  return tool;
}

// ── Mock fetch infrastructure ────────────────────────────────────────────────

let fetchMock;
let originalFetch;

function installFetchMock(handler) {
  originalFetch = globalThis.fetch;
  fetchMock = handler;
  globalThis.fetch = async (...args) => fetchMock(...args);
}

function uninstallFetchMock() {
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = undefined;
  }
  fetchMock = undefined;
}

// ── URL Validation Tests ─────────────────────────────────────────────────────

test("roam_web_fetch: rejects empty URL", async () => {
  const tool = getWebFetchTool();
  await assert.rejects(() => tool.execute({}), /url is required/);
  await assert.rejects(() => tool.execute({ url: "" }), /url is required/);
  await assert.rejects(() => tool.execute({ url: "   " }), /url is required/);
});

test("roam_web_fetch: rejects invalid URL format", async () => {
  const tool = getWebFetchTool();
  await assert.rejects(() => tool.execute({ url: "not-a-url" }), /Invalid URL format/);
});

test("roam_web_fetch: rejects non-http schemes", async () => {
  const tool = getWebFetchTool();
  await assert.rejects(() => tool.execute({ url: "javascript:alert(1)" }), /Only http:\/\/ and https:\/\//);
  await assert.rejects(() => tool.execute({ url: "file:///etc/passwd" }), /Only http:\/\/ and https:\/\//);
  await assert.rejects(() => tool.execute({ url: "data:text/html,<h1>hi</h1>" }), /Only http:\/\/ and https:\/\//);
  await assert.rejects(() => tool.execute({ url: "ftp://example.com/file" }), /Only http:\/\/ and https:\/\//);
});

// ── Credentials Tests ────────────────────────────────────────────────────────

test("roam_web_fetch: rejects when no API token configured", async () => {
  const tool = getWebFetchTool({ getCloudflareApiToken: () => "" });
  await assert.rejects(
    () => tool.execute({ url: "https://example.com" }),
    /Cloudflare API token and account ID must be configured/
  );
});

test("roam_web_fetch: rejects when no account ID configured", async () => {
  const tool = getWebFetchTool({ getCloudflareAccountId: () => "" });
  await assert.rejects(
    () => tool.execute({ url: "https://example.com" }),
    /Cloudflare API token and account ID must be configured/
  );
});

test("roam_web_fetch: rejects when no CORS proxy configured", async () => {
  const tool = getWebFetchTool({ getCorsProxyUrl: () => "" });
  await assert.rejects(
    () => tool.execute({ url: "https://example.com" }),
    /Composio Proxy URL must be configured/
  );
});

// ── Successful Fetch Tests ───────────────────────────────────────────────────

test("roam_web_fetch: successful single-page fetch via /markdown endpoint", async () => {
  const tool = getWebFetchTool();
  let postCalled = false;

  installFetchMock(async (url, opts) => {
    postCalled = true;
    // Verify URL goes through proxy to /markdown endpoint
    assert.ok(String(url).startsWith("https://test-proxy.workers.dev/"), "Should use proxy");
    assert.ok(String(url).includes("/browser-rendering/markdown"), "Should use /markdown endpoint");
    // Verify POST body contains just the URL
    const body = JSON.parse(opts.body);
    assert.equal(body.url, "https://example.com/article");
    // Verify auth header
    assert.ok(opts.headers.Authorization.includes("test-cf-token"));
    return {
      ok: true,
      status: 200,
      json: async () => ({ success: true, result: "# Test Article\n\nThis is the content." })
    };
  });

  try {
    const result = await tool.execute({ url: "https://example.com/article" });
    assert.ok(postCalled, "POST should have been called");
    assert.equal(result.success, true);
    assert.equal(result.url, "https://example.com/article");
    assert.equal(result.markdown, "# Test Article\n\nThis is the content.");
    assert.equal(result.truncated, undefined);
  } finally {
    uninstallFetchMock();
  }
});

// ── Truncation Tests ─────────────────────────────────────────────────────────

test("roam_web_fetch: truncates large content", async () => {
  const tool = getWebFetchTool();
  const largeContent = "x".repeat(15000);

  installFetchMock(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ success: true, result: largeContent })
  }));

  try {
    const result = await tool.execute({ url: "https://example.com/big" });
    assert.equal(result.success, true);
    assert.equal(result.markdown.length, 12000);
    assert.equal(result.truncated, true);
    assert.ok(result.note.includes("15000"));
  } finally {
    uninstallFetchMock();
  }
});

// ── Error Status Tests ───────────────────────────────────────────────────────

test("roam_web_fetch: handles 429 rate limit", async () => {
  const tool = getWebFetchTool();

  installFetchMock(async () => ({
    ok: false,
    status: 429,
    text: async () => "Rate limited"
  }));

  try {
    await assert.rejects(
      () => tool.execute({ url: "https://example.com" }),
      /rate limit/i
    );
  } finally {
    uninstallFetchMock();
  }
});

test("roam_web_fetch: handles HTTP error", async () => {
  const tool = getWebFetchTool();

  installFetchMock(async () => ({
    ok: false,
    status: 403,
    text: async () => "Forbidden"
  }));

  try {
    await assert.rejects(
      () => tool.execute({ url: "https://example.com" }),
      /HTTP 403/
    );
  } finally {
    uninstallFetchMock();
  }
});

test("roam_web_fetch: handles unsuccessful API response", async () => {
  const tool = getWebFetchTool();

  installFetchMock(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ success: false, errors: [{ message: "Bad request" }] })
  }));

  try {
    await assert.rejects(
      () => tool.execute({ url: "https://example.com" }),
      /Cloudflare API error/
    );
  } finally {
    uninstallFetchMock();
  }
});

// ── Tool Metadata Tests ──────────────────────────────────────────────────────

test("roam_web_fetch: tool metadata is correct", () => {
  const tool = getWebFetchTool();
  assert.equal(tool.isMutating, false);
  assert.deepEqual(tool.input_schema.required, ["url"]);
  assert.ok(tool.input_schema.properties.url);
});

test("roam_web_fetch: accepts http:// URLs", async () => {
  const tool = getWebFetchTool();

  installFetchMock(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ success: true, result: "# HTTP Page" })
  }));

  try {
    const result = await tool.execute({ url: "http://example.com" });
    assert.equal(result.success, true);
  } finally {
    uninstallFetchMock();
  }
});

// ── Network Error Tests ──────────────────────────────────────────────────────

test("roam_web_fetch: handles network failure", async () => {
  const tool = getWebFetchTool();

  installFetchMock(async () => {
    throw new Error("Network error");
  });

  try {
    await assert.rejects(
      () => tool.execute({ url: "https://example.com" }),
      /Network error/
    );
  } finally {
    uninstallFetchMock();
  }
});
