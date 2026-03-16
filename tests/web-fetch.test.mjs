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

test("roam_web_fetch: successful single-page fetch", async () => {
  const tool = getWebFetchTool();
  let postCalled = false;
  let pollCount = 0;

  installFetchMock(async (url, opts) => {
    if (opts?.method === "POST") {
      postCalled = true;
      // Verify POST body
      const body = JSON.parse(opts.body);
      assert.equal(body.url, "https://example.com/article");
      assert.equal(body.limit, 1);
      assert.equal(body.depth, 0);
      assert.deepEqual(body.formats, ["markdown"]);
      assert.equal(body.render, false);
      // Verify auth header
      assert.ok(opts.headers.Authorization.includes("test-cf-token"));
      return {
        ok: true,
        json: async () => ({ success: true, result: "job-123" })
      };
    }
    // GET poll
    pollCount++;
    if (pollCount < 2) {
      return {
        ok: true,
        json: async () => ({ success: true, result: { status: "running", records: [] } })
      };
    }
    return {
      ok: true,
      json: async () => ({
        success: true,
        result: {
          status: "completed",
          records: [{
            status: "completed",
            markdown: "# Test Article\n\nThis is the content.",
            metadata: { title: "Test Article", url: "https://example.com/article", status: 200 }
          }]
        }
      })
    };
  });

  try {
    const result = await tool.execute({ url: "https://example.com/article" });
    assert.ok(postCalled, "POST should have been called");
    assert.equal(result.success, true);
    assert.equal(result.url, "https://example.com/article");
    assert.equal(result.title, "Test Article");
    assert.equal(result.markdown, "# Test Article\n\nThis is the content.");
    assert.equal(result.truncated, undefined);
  } finally {
    uninstallFetchMock();
  }
});

test("roam_web_fetch: passes render: true when specified", async () => {
  const tool = getWebFetchTool();
  let renderValue;

  installFetchMock(async (url, opts) => {
    if (opts?.method === "POST") {
      renderValue = JSON.parse(opts.body).render;
      return {
        ok: true,
        json: async () => ({ success: true, result: "job-456" })
      };
    }
    return {
      ok: true,
      json: async () => ({
        success: true,
        result: {
          status: "completed",
          records: [{
            status: "completed",
            markdown: "# Rendered",
            metadata: { title: "Rendered", url: "https://spa.example.com" }
          }]
        }
      })
    };
  });

  try {
    await tool.execute({ url: "https://spa.example.com", render: true });
    assert.equal(renderValue, true);
  } finally {
    uninstallFetchMock();
  }
});

// ── Truncation Tests ─────────────────────────────────────────────────────────

test("roam_web_fetch: truncates large content", async () => {
  const tool = getWebFetchTool();
  const largeContent = "x".repeat(15000);

  installFetchMock(async (url, opts) => {
    if (opts?.method === "POST") {
      return { ok: true, json: async () => ({ success: true, result: "job-big" }) };
    }
    return {
      ok: true,
      json: async () => ({
        success: true,
        result: {
          status: "completed",
          records: [{
            status: "completed",
            markdown: largeContent,
            metadata: { title: "Big Page", url: "https://example.com/big" }
          }]
        }
      })
    };
  });

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

test("roam_web_fetch: handles robots.txt disallowed", async () => {
  const tool = getWebFetchTool();

  installFetchMock(async (url, opts) => {
    if (opts?.method === "POST") {
      return { ok: true, json: async () => ({ success: true, result: "job-blocked" }) };
    }
    return {
      ok: true,
      json: async () => ({
        success: true,
        result: {
          status: "completed",
          records: [{ status: "disallowed", markdown: "", metadata: {} }]
        }
      })
    };
  });

  try {
    await assert.rejects(
      () => tool.execute({ url: "https://blocked.example.com" }),
      /robots\.txt/
    );
  } finally {
    uninstallFetchMock();
  }
});

test("roam_web_fetch: handles errored record", async () => {
  const tool = getWebFetchTool();

  installFetchMock(async (url, opts) => {
    if (opts?.method === "POST") {
      return { ok: true, json: async () => ({ success: true, result: "job-err" }) };
    }
    return {
      ok: true,
      json: async () => ({
        success: true,
        result: {
          status: "completed",
          records: [{ status: "errored", markdown: "", metadata: {} }]
        }
      })
    };
  });

  try {
    await assert.rejects(
      () => tool.execute({ url: "https://broken.example.com" }),
      /failed to fetch this page/
    );
  } finally {
    uninstallFetchMock();
  }
});

// ── HTTP Error Tests ─────────────────────────────────────────────────────────

test("roam_web_fetch: handles POST HTTP error", async () => {
  const tool = getWebFetchTool();

  installFetchMock(async (url, opts) => {
    if (opts?.method === "POST") {
      return {
        ok: false,
        status: 403,
        text: async () => "Forbidden"
      };
    }
    return { ok: true, json: async () => ({}) };
  });

  try {
    await assert.rejects(
      () => tool.execute({ url: "https://example.com" }),
      /HTTP 403/
    );
  } finally {
    uninstallFetchMock();
  }
});

test("roam_web_fetch: handles POST returning unsuccessful", async () => {
  const tool = getWebFetchTool();

  installFetchMock(async (url, opts) => {
    if (opts?.method === "POST") {
      return {
        ok: true,
        json: async () => ({ success: false, errors: [{ message: "Bad request" }] })
      };
    }
    return { ok: true, json: async () => ({}) };
  });

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
  assert.ok(tool.input_schema.properties.render);
});

test("roam_web_fetch: accepts http:// URLs", async () => {
  const tool = getWebFetchTool();

  installFetchMock(async (url, opts) => {
    if (opts?.method === "POST") {
      return { ok: true, json: async () => ({ success: true, result: "job-http" }) };
    }
    return {
      ok: true,
      json: async () => ({
        success: true,
        result: {
          status: "completed",
          records: [{
            status: "completed",
            markdown: "# HTTP Page",
            metadata: { title: "HTTP Page", url: "http://example.com" }
          }]
        }
      })
    };
  });

  try {
    const result = await tool.execute({ url: "http://example.com" });
    assert.equal(result.success, true);
  } finally {
    uninstallFetchMock();
  }
});

// ── Poll Retry Tests ─────────────────────────────────────────────────────────

test("roam_web_fetch: retries on poll network errors", async () => {
  const tool = getWebFetchTool();
  let pollAttempts = 0;

  installFetchMock(async (url, opts) => {
    if (opts?.method === "POST") {
      return { ok: true, json: async () => ({ success: true, result: "job-retry" }) };
    }
    pollAttempts++;
    if (pollAttempts === 1) {
      throw new Error("Network error");
    }
    return {
      ok: true,
      json: async () => ({
        success: true,
        result: {
          status: "completed",
          records: [{
            status: "completed",
            markdown: "# Recovered",
            metadata: { title: "Recovered", url: "https://example.com" }
          }]
        }
      })
    };
  });

  try {
    const result = await tool.execute({ url: "https://example.com" });
    assert.equal(result.success, true);
    assert.ok(pollAttempts >= 2, "Should have retried after network error");
  } finally {
    uninstallFetchMock();
  }
});
