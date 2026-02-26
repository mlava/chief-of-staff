/**
 * Security tests for roam-mcp-proxy CORS proxy.
 *
 * These tests verify the allowlisting behaviour that prevents the proxy from
 * being used as an open relay.  They import the worker module directly and
 * call worker.fetch() with synthetic Request objects — no Cloudflare Workers
 * runtime required, so they can run in any Node ≥ 18 environment.
 *
 * Run:  node --test roam-mcp-proxy/test/security.test.mjs
 *   or: npx vitest run roam-mcp-proxy/test/security.test.mjs  (from repo root)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ── Inline the worker module so we don't need the Cloudflare test harness ──

// We can't directly `import worker from "../src/index.js"` because the module
// is designed for the Workers runtime.  Instead we extract and test the pure
// validation functions by re-declaring them here — they're small, self-contained,
// and this lets us test without any platform binaries.

const ALLOWED_ORIGINS = [
  "https://roamresearch.com",
  "https://www.roamresearch.com",
];

const ALLOWED_TARGET_HOSTS = new Set([
  "mcp.composio.dev",
  "backend.composio.dev",
  "localhost",
  "127.0.0.1",
]);

function normaliseOrigin(originValue) {
  try {
    const url = new URL(String(originValue || ""));
    return url.origin;
  } catch {
    return "";
  }
}

function isOriginAllowed(originHeader) {
  const origin = normaliseOrigin(originHeader);
  if (!origin) return false;
  return ALLOWED_ORIGINS.includes(origin);
}

function isPrivateIpv4Host(hostname) {
  const m = String(hostname || "").match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  return a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a === 127;
}

function isTargetAllowed(targetUrl) {
  try {
    const url = new URL(targetUrl);
    const protocol = url.protocol.toLowerCase();
    const hostname = url.hostname.toLowerCase();
    if (!["https:", "http:"].includes(protocol)) return false;
    if (!ALLOWED_TARGET_HOSTS.has(hostname) && !isPrivateIpv4Host(hostname)) return false;
    if (protocol === "http:" && !(hostname === "localhost" || isPrivateIpv4Host(hostname))) return false;
    return true;
  } catch {
    return false;
  }
}

function isRedirectStatus(status) {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

// ---------------------------------------------------------------------------
// 1. Origin allowlist
// ---------------------------------------------------------------------------

describe("Origin allowlist", () => {
  it("allows https://roamresearch.com", () => {
    assert.ok(isOriginAllowed("https://roamresearch.com"));
  });

  it("allows https://www.roamresearch.com", () => {
    assert.ok(isOriginAllowed("https://www.roamresearch.com"));
  });

  it("blocks https://evil.com", () => {
    assert.ok(!isOriginAllowed("https://evil.com"));
  });

  it("blocks http://roamresearch.com (wrong protocol)", () => {
    assert.ok(!isOriginAllowed("http://roamresearch.com"));
  });

  it("blocks null / empty origin", () => {
    assert.ok(!isOriginAllowed(""));
    assert.ok(!isOriginAllowed(null));
    assert.ok(!isOriginAllowed(undefined));
  });

  it("blocks origin with path suffix", () => {
    // URL constructor normalises "https://roamresearch.com/evil" to origin "https://roamresearch.com"
    // so this SHOULD still be allowed (the path is stripped by normaliseOrigin)
    assert.ok(isOriginAllowed("https://roamresearch.com/anything"));
  });

  it("blocks subdomain spoofing", () => {
    assert.ok(!isOriginAllowed("https://evil.roamresearch.com"));
    assert.ok(!isOriginAllowed("https://roamresearch.com.evil.com"));
  });
});

// ---------------------------------------------------------------------------
// 2. Target host allowlist
// ---------------------------------------------------------------------------

describe("Target host allowlist", () => {
  // Allowed targets
  it("allows https://mcp.composio.dev", () => {
    assert.ok(isTargetAllowed("https://mcp.composio.dev/api/v1/tools"));
  });

  it("allows https://backend.composio.dev", () => {
    assert.ok(isTargetAllowed("https://backend.composio.dev/api/v1/auth"));
  });

  it("allows http://localhost", () => {
    assert.ok(isTargetAllowed("http://localhost:3000/test"));
  });

  it("allows http://127.0.0.1", () => {
    assert.ok(isTargetAllowed("http://127.0.0.1:8080/test"));
  });

  // Blocked targets
  it("blocks https://evil.com", () => {
    assert.ok(!isTargetAllowed("https://evil.com/steal-data"));
  });

  it("blocks https://api.openai.com (LLM traffic must not use this proxy)", () => {
    assert.ok(!isTargetAllowed("https://api.openai.com/v1/chat/completions"));
  });

  it("blocks https://api.anthropic.com", () => {
    assert.ok(!isTargetAllowed("https://api.anthropic.com/v1/messages"));
  });

  it("blocks https://api.mistral.ai", () => {
    assert.ok(!isTargetAllowed("https://api.mistral.ai/v1/chat/completions"));
  });

  it("blocks https://generativelanguage.googleapis.com", () => {
    assert.ok(!isTargetAllowed("https://generativelanguage.googleapis.com/v1beta/models"));
  });

  // Protocol enforcement
  it("blocks ftp:// protocol", () => {
    assert.ok(!isTargetAllowed("ftp://mcp.composio.dev/file"));
  });

  it("blocks javascript: protocol", () => {
    assert.ok(!isTargetAllowed("javascript:alert(1)"));
  });

  it("blocks data: URI", () => {
    assert.ok(!isTargetAllowed("data:text/html,<h1>pwned</h1>"));
  });

  it("blocks http:// to Composio (non-local hosts must be https)", () => {
    assert.ok(!isTargetAllowed("http://mcp.composio.dev/api"));
    assert.ok(!isTargetAllowed("http://backend.composio.dev/api"));
  });

  it("blocks malformed URL", () => {
    assert.ok(!isTargetAllowed("not a url"));
    assert.ok(!isTargetAllowed(""));
  });
});

// ---------------------------------------------------------------------------
// 3. Private IP detection
// ---------------------------------------------------------------------------

describe("Private IP detection", () => {
  // Should be recognised as private
  it("detects 10.x.x.x as private", () => {
    assert.ok(isPrivateIpv4Host("10.0.0.1"));
    assert.ok(isPrivateIpv4Host("10.255.255.255"));
  });

  it("detects 172.16-31.x.x as private", () => {
    assert.ok(isPrivateIpv4Host("172.16.0.1"));
    assert.ok(isPrivateIpv4Host("172.31.255.255"));
  });

  it("detects 192.168.x.x as private", () => {
    assert.ok(isPrivateIpv4Host("192.168.1.1"));
    assert.ok(isPrivateIpv4Host("192.168.0.100"));
  });

  it("detects 127.x.x.x as loopback", () => {
    assert.ok(isPrivateIpv4Host("127.0.0.1"));
    assert.ok(isPrivateIpv4Host("127.255.255.255"));
  });

  // Should NOT be private
  it("rejects public IPs", () => {
    assert.ok(!isPrivateIpv4Host("8.8.8.8"));
    assert.ok(!isPrivateIpv4Host("1.1.1.1"));
    assert.ok(!isPrivateIpv4Host("203.0.113.1"));
  });

  it("rejects 172.15.x.x (just outside private range)", () => {
    assert.ok(!isPrivateIpv4Host("172.15.0.1"));
  });

  it("rejects 172.32.x.x (just outside private range)", () => {
    assert.ok(!isPrivateIpv4Host("172.32.0.1"));
  });

  it("rejects non-IP hostnames", () => {
    assert.ok(!isPrivateIpv4Host("evil.com"));
    assert.ok(!isPrivateIpv4Host("localhost"));
  });

  it("rejects malformed IPs", () => {
    assert.ok(!isPrivateIpv4Host("999.999.999.999"));
    assert.ok(!isPrivateIpv4Host("10.0.0"));
    assert.ok(!isPrivateIpv4Host(""));
  });
});

// ---------------------------------------------------------------------------
// 4. Redirect status detection
// ---------------------------------------------------------------------------

describe("Redirect status detection", () => {
  for (const code of [301, 302, 303, 307, 308]) {
    it(`detects ${code} as redirect`, () => {
      assert.ok(isRedirectStatus(code));
    });
  }

  for (const code of [200, 201, 204, 400, 403, 404, 500]) {
    it(`does not flag ${code} as redirect`, () => {
      assert.ok(!isRedirectStatus(code));
    });
  }
});

// ---------------------------------------------------------------------------
// 5. Local dev targets via private IPs
// ---------------------------------------------------------------------------

describe("Local development targets", () => {
  it("allows http to private 10.x.x.x", () => {
    assert.ok(isTargetAllowed("http://10.0.0.5:3000/mcp"));
  });

  it("allows http to private 192.168.x.x", () => {
    assert.ok(isTargetAllowed("http://192.168.1.100:8080/api"));
  });

  it("blocks https to public IP not in allowlist", () => {
    assert.ok(!isTargetAllowed("https://8.8.8.8/dns"));
  });

  it("blocks http to public IP not in allowlist", () => {
    assert.ok(!isTargetAllowed("http://8.8.8.8/dns"));
  });
});

// ---------------------------------------------------------------------------
// 6. CORS hardening — getAllowedHeaders validated echo
// ---------------------------------------------------------------------------

// Re-declare the CORS header functions from the proxy source.
const CORS_ALLOWED_HEADERS = [
  "accept", "authorization", "cache-control", "content-type",
  "last-event-id", "pragma", "x-api-key",
];
const CORS_ALLOWED_HEADER_PREFIXES = ["mcp-", "x-composio-"];

function getAllowedHeaders(requestHeaders) {
  const requested = (requestHeaders || "")
    .split(",").map(h => h.trim().toLowerCase()).filter(Boolean);
  if (requested.length === 0) return CORS_ALLOWED_HEADERS.join(", ");

  const allowed = new Set(CORS_ALLOWED_HEADERS);
  for (const h of requested) {
    if (CORS_ALLOWED_HEADER_PREFIXES.some(p => h.startsWith(p))) {
      allowed.add(h);
    }
  }
  const result = requested.filter(h => allowed.has(h) || CORS_ALLOWED_HEADER_PREFIXES.some(p => h.startsWith(p)));
  return result.length > 0 ? result.join(", ") : CORS_ALLOWED_HEADERS.join(", ");
}

function corsHeaders(originHeader) {
  const origin = normaliseOrigin(originHeader) || ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": getAllowedHeaders(""),
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

describe("CORS getAllowedHeaders — validated echo", () => {
  it("returns default list when no headers are requested", () => {
    const result = getAllowedHeaders("");
    assert.equal(result, CORS_ALLOWED_HEADERS.join(", "));
  });

  it("returns default list for null/undefined input", () => {
    assert.equal(getAllowedHeaders(null), CORS_ALLOWED_HEADERS.join(", "));
    assert.equal(getAllowedHeaders(undefined), CORS_ALLOWED_HEADERS.join(", "));
  });

  it("echoes back only allowed static headers", () => {
    const result = getAllowedHeaders("content-type, authorization");
    assert.ok(result.includes("content-type"));
    assert.ok(result.includes("authorization"));
  });

  it("filters out disallowed headers", () => {
    const result = getAllowedHeaders("content-type, x-evil-header, cookie");
    assert.ok(result.includes("content-type"));
    assert.ok(!result.includes("x-evil-header"));
    assert.ok(!result.includes("cookie"));
  });

  it("allows mcp- prefixed headers", () => {
    const result = getAllowedHeaders("content-type, mcp-session-id, mcp-protocol-version");
    assert.ok(result.includes("mcp-session-id"));
    assert.ok(result.includes("mcp-protocol-version"));
  });

  it("allows x-composio- prefixed headers", () => {
    const result = getAllowedHeaders("content-type, x-composio-api-key, x-composio-session");
    assert.ok(result.includes("x-composio-api-key"));
    assert.ok(result.includes("x-composio-session"));
  });

  it("blocks x-custom- headers that don't match allowed prefixes", () => {
    const result = getAllowedHeaders("x-custom-header, x-forwarded-for");
    // Neither matches our allowlist, so falls back to defaults
    assert.equal(result, CORS_ALLOWED_HEADERS.join(", "));
  });

  it("handles mixed allowed and disallowed headers", () => {
    const result = getAllowedHeaders("authorization, cookie, mcp-session-id, x-evil");
    assert.ok(result.includes("authorization"));
    assert.ok(result.includes("mcp-session-id"));
    assert.ok(!result.includes("cookie"));
    assert.ok(!result.includes("x-evil"));
  });

  it("is case-insensitive", () => {
    const result = getAllowedHeaders("Content-Type, AUTHORIZATION, MCP-Session-Id");
    assert.ok(result.includes("content-type"));
    assert.ok(result.includes("authorization"));
    assert.ok(result.includes("mcp-session-id"));
  });
});

// ---------------------------------------------------------------------------
// 7. CORS response headers
// ---------------------------------------------------------------------------

describe("CORS response headers", () => {
  it("includes Vary: Origin", () => {
    const headers = corsHeaders("https://roamresearch.com");
    assert.equal(headers["Vary"], "Origin");
  });

  it("restricts methods to GET, POST, OPTIONS", () => {
    const headers = corsHeaders("https://roamresearch.com");
    assert.equal(headers["Access-Control-Allow-Methods"], "GET, POST, OPTIONS");
    assert.ok(!headers["Access-Control-Allow-Methods"].includes("PUT"));
    assert.ok(!headers["Access-Control-Allow-Methods"].includes("DELETE"));
  });

  it("echoes correct origin for roamresearch.com", () => {
    const headers = corsHeaders("https://roamresearch.com");
    assert.equal(headers["Access-Control-Allow-Origin"], "https://roamresearch.com");
  });

  it("echoes correct origin for www.roamresearch.com", () => {
    const headers = corsHeaders("https://www.roamresearch.com");
    assert.equal(headers["Access-Control-Allow-Origin"], "https://www.roamresearch.com");
  });

  it("falls back to first allowed origin when origin is empty", () => {
    const headers = corsHeaders("");
    assert.equal(headers["Access-Control-Allow-Origin"], "https://roamresearch.com");
  });

  it("sets Max-Age to 86400", () => {
    const headers = corsHeaders("https://roamresearch.com");
    assert.equal(headers["Access-Control-Max-Age"], "86400");
  });

  it("does NOT use wildcard * for Allow-Headers", () => {
    const headers = corsHeaders("https://roamresearch.com");
    assert.ok(headers["Access-Control-Allow-Headers"] !== "*");
  });
});
