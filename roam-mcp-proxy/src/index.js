const ALLOWED_ORIGINS = ["https://roamresearch.com"];

function isOriginAllowed(request) {
  const origin = request.headers.get("Origin") || "";
  return ALLOWED_ORIGINS.some((o) => origin.startsWith(o));
}

function corsHeaders(request) {
  return {
    "Access-Control-Allow-Origin": request.headers.get("Origin") || ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Access-Control-Max-Age": "86400",
  };
}

export default {
  async fetch(request) {
    if (!isOriginAllowed(request)) {
      return new Response("Forbidden", { status: 403 });
    }

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(request) });
    }

    const url = new URL(request.url);
    const targetUrl = url.pathname.slice(1) + url.search;

    if (!targetUrl.startsWith("http")) {
      return new Response("Usage: /<target-url>", { status: 400 });
    }

    // Block MCP SSE probe (GET to /tool_router/) — Composio returns 405
    // and the browser logs a noisy red error. Intercept it here cleanly.
    if (request.method === "GET" && new URL(targetUrl).pathname.includes("/tool_router/")) {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request),
      });
    }

    const response = await fetch(targetUrl, {
      method: request.method,
      headers: request.headers,
      body: request.method !== "GET" ? await request.text() : undefined,
    });

    const newResponse = new Response(response.body, response);
    for (const [key, value] of Object.entries(corsHeaders(request))) {
      newResponse.headers.set(key, value);
    }
    return newResponse;
  },
};
