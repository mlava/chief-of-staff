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

1. **Origin check** — rejects requests whose `Origin` header doesn't match `https://roamresearch.com`. This prevents abuse from unknown sites.
2. **OPTIONS** (CORS preflight) — returns permissive CORS headers immediately.
3. **GET to `/tool_router/`** — returns `204 No Content`. Composio's MCP endpoint returns `405` for SSE probe GETs, which causes noisy browser console errors. The proxy intercepts these silently.
4. **Everything else** — forwards the request (method, headers, body) to the target URL extracted from the path, then copies the response back with CORS headers added.

---

## Local development

```bash
npm run dev
```

This starts a local dev server (typically `http://localhost:8787`). You can point your Composio MCP URL at `http://localhost:8787/https://mcp.composio.dev/...` for testing.

---

## Security

The proxy only accepts requests whose `Origin` header starts with `https://roamresearch.com`. Requests from any other origin are rejected with `403 Forbidden`.

To allow additional origins (e.g. a local dev server), edit the `ALLOWED_ORIGINS` array at the top of `src/index.js`:

```js
const ALLOWED_ORIGINS = [
  "https://roamresearch.com",
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

---

## Updating

To deploy changes after editing `src/index.js`:

```bash
npx wrangler deploy
```

The worker URL stays the same — no need to update Chief of Staff settings.
