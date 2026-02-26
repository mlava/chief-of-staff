# roam-mcp-proxy

A lightweight Cloudflare Worker that adds CORS headers to proxied requests. Chief of Staff needs this because browser security policy blocks cross-origin requests from the Roam Research SPA to Composio's MCP endpoint (which doesn't return CORS headers).

LLM API calls (Anthropic / OpenAI) use Roam's own built-in CORS proxy automatically — this worker is only needed for Composio MCP.

---

## Prerequisites

- A free [Cloudflare account](https://dash.cloudflare.com/sign-up)
- Node.js 18+ and npm

---

## Deploy your own proxy

### 1. Install Wrangler

```bash
npm install -g wrangler
```

### 2. Authenticate

```bash
wrangler login
```

This opens a browser window to authorise Wrangler with your Cloudflare account.

### 3. Install dependencies

From the `roam-mcp-proxy/` directory:

```bash
npm install
```

### 4. Deploy

```bash
npx wrangler deploy
```

Wrangler will output the deployed URL, e.g.:

```
Published roam-mcp-proxy (x.xx sec)
  https://roam-mcp-proxy.<your-subdomain>.workers.dev
```

Copy this URL — you'll need it when configuring Chief of Staff.

---

## Configure Chief of Staff

In **Roam → Settings → Chief of Staff**, set **Composio MCP URL** to your worker URL with the real Composio MCP endpoint appended as the path:

```
https://roam-mcp-proxy.<your-subdomain>.workers.dev/https://mcp.composio.dev/<your-composio-endpoint>
```

The worker strips the leading `/`, forwards the request to the target URL, and adds CORS headers to the response.

---

## How it works

For every incoming request:

1. **Origin check** — rejects requests whose `Origin` header is not an exact match for an allowlisted Roam origin (`https://roamresearch.com` or `https://www.roamresearch.com`).
2. **OPTIONS** (CORS preflight) — returns CORS headers with validated `Access-Control-Allow-Headers` (echoes back only headers from the static allowlist plus `mcp-*` and `x-composio-*` prefixes — no wildcard `*`). Methods restricted to `GET, POST, OPTIONS`.
3. **GET to `/tool_router/`** — returns `204 No Content`. Composio's MCP endpoint returns `405` for SSE probe GETs, which causes noisy browser console errors. The proxy intercepts these silently.
4. **Target allowlist check** — only proxies to allowlisted upstream hosts (Composio MCP + local dev hosts).
5. **Redirect hardening** — upstream redirects are blocked (the worker does not follow redirects).
6. **CORS response headers** — all responses include `Vary: Origin` for correct cache behaviour, origin-specific `Access-Control-Allow-Origin` (no wildcard), and validated `Access-Control-Allow-Headers`.
7. **Everything else** — forwards the request (method, allowlisted headers, body) to the target URL extracted from the path, then copies the response back with CORS headers added.

---

## Local development

```bash
npm run dev
```

This starts a local dev server (typically `http://localhost:8787`). You can point your Composio MCP URL at `http://localhost:8787/https://mcp.composio.dev/...` for testing.

---

## Security

The proxy applies multiple layers of security:

1. **Caller origin allowlist (exact match)** — only requests from:
   - `https://roamresearch.com`
   - `https://www.roamresearch.com`
2. **Upstream target allowlist** — only proxies to:
   - `mcp.composio.dev` (Composio MCP hostname)
   - `backend.composio.dev` (Composio streamable HTTP / tool router hostname used by some endpoints)
   - `localhost`, `127.0.0.1`, and private IPv4 ranges (for local development/testing)

Requests to any other target host are rejected with `403 Forbidden target`.

3. **CORS hardening**:
   - `Vary: Origin` header on all responses (correct cache behaviour when serving multiple origins)
   - Methods restricted to `GET, POST, OPTIONS` only (no PUT, DELETE, PATCH)
   - `Access-Control-Allow-Headers` uses a validated echo approach: the browser's `Access-Control-Request-Headers` are checked against a static allowlist (`accept`, `authorization`, `cache-control`, `content-type`, `last-event-id`, `pragma`, `x-api-key`) plus `mcp-*` and `x-composio-*` prefix patterns. Disallowed headers are silently dropped. No wildcard `*`.
   - `Access-Control-Max-Age: 86400` reduces preflight round-trips

4. **Redirect blocking** — upstream redirects are intercepted (`redirect: "manual"`) and return `502` to prevent SSRF via redirect chains

5. **Header filtering** — only a narrow set of request headers are forwarded upstream (see "Notes on forwarded headers" below)

This means the worker is not a general-purpose CORS proxy.

### Customising allowlisted upstream hosts

If your Composio endpoint uses a different hostname (for example, a region-specific or custom domain), add it to `ALLOWED_TARGET_HOSTS` in `src/index.js` and redeploy:

```js
const ALLOWED_TARGET_HOSTS = new Set([
  "mcp.composio.dev",
  "backend.composio.dev",
  "my-custom-composio-host.example.com",
  "localhost",
  "127.0.0.1",
]);
```

To allow additional origins (e.g. a local dev server), edit the `ALLOWED_ORIGINS` array at the top of `src/index.js`:

```js
const ALLOWED_ORIGINS = [
  "https://roamresearch.com",
  "https://www.roamresearch.com",
  "http://localhost:3000",  // local dev
];
```

Then redeploy with `npx wrangler deploy`.

### Optional: shared secret header

For additional protection, you can require a secret header. Set a Cloudflare Worker secret:

```bash
npx wrangler secret put PROXY_SECRET
```

Then check it in the worker:

```js
// Change export to accept env:
export default {
  async fetch(request, env) {
    if (request.headers.get("x-proxy-secret") !== env.PROXY_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }
    // ... rest of handler
  }
};
```

You would then need to add this header in the extension's transport fetch. This is an advanced setup and not required for basic use.

### Notes on forwarded headers

The worker forwards only a small allowlist of request headers (for example `Authorization`, `Content-Type`, `Accept`, MCP headers like `mcp-*`, and Composio headers like `x-composio-*`). It also rewrites the upstream `Origin` header to match the target URL.

This reduces accidental leakage and avoids proxy/header confusion issues.

### Redirect handling

The worker sets `redirect: "manual"` for upstream fetches and blocks redirects. This prevents an allowlisted hostname from redirecting the proxy to a non-allowlisted destination.

---

## Testing

The proxy has two test suites:

### Security tests (Node.js — no Workers runtime needed)

```bash
node --test roam-mcp-proxy/test/security.test.mjs
```

62 tests across 7 suites covering origin allowlist, target host allowlist, private IP detection, redirect status detection, local dev targets, CORS `getAllowedHeaders` validated echo, and CORS response headers. These re-declare the proxy's pure validation functions inline so they run in any Node 18+ environment.

### Integration tests (Cloudflare Workers vitest pool)

```bash
cd roam-mcp-proxy && npx vitest run
```

These use `@cloudflare/vitest-pool-workers` to test the full worker `fetch()` handler with synthetic requests. Requires the Cloudflare test harness and `node_modules` installed for your platform.

---

## Updating

To deploy changes after editing `src/index.js`:

```bash
npx wrangler deploy
```

The worker URL stays the same — no need to update Chief of Staff settings.
