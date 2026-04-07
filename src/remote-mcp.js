/**
 * remote-mcp.js — Remote MCP server connection, tool discovery, and supply-chain security.
 *
 * Manages connections to arbitrary remote MCP endpoints using either:
 * - StreamableHTTPClientTransport for /mcp endpoints (modern, stateless POST)
 * - RemoteSSETransport for /sse endpoints (legacy, EventSource GET + session POST)
 *
 * Connection lifecycle with exponential backoff, two-stage routing for large servers,
 * schema pinning, and MCP suspension state (shared with local-mcp.js).
 *
 * Servers are configured via settings as per-instance fields:
 *   remote-mcp-count        : number of servers (integer string, e.g. "2")
 *   remote-mcp-${n}-url     : full StreamableHTTP endpoint URL
 *   remote-mcp-${n}-name    : optional friendly display name
 *   remote-mcp-${n}-header  : optional auth header name (e.g. "x-brain-key")
 *   remote-mcp-${n}-token   : optional auth token value (redacted from logs)
 *
 * Dependency-injected via initRemoteMcp(). All external functions/constants
 * accessed through `deps.*`.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError, auth as sdkAuth } from "@modelcontextprotocol/sdk/client/auth.js";
import { createMcpOAuthProvider, urlToHash, getOAuthProxiedUrl } from "./mcp-oauth-provider.js";

// ── Constants ───────────────────────────────────────────────────────────────
const REMOTE_MCP_CONNECT_TIMEOUT_MS = 20_000;    // StreamableHTTP connect (no SSE startup overhead)
const REMOTE_MCP_SSE_CONNECT_TIMEOUT_MS = 25_000; // SSE needs longer: GET handshake + endpoint event
const REMOTE_MCP_LIST_TOOLS_TIMEOUT_MS = 10_000; // Remote servers may have higher latency
const REMOTE_MCP_INITIAL_BACKOFF_MS = 5_000;
const REMOTE_MCP_MAX_BACKOFF_MS = 120_000;
const REMOTE_MCP_AUTO_CONNECT_MAX_RETRIES = 4;
const REMOTE_MCP_DIRECT_TOOL_THRESHOLD = 15;     // ≤15 tools: direct; >15: REMOTE_MCP_ROUTE meta-tool
const REMOTE_SSE_MAX_START_ATTEMPTS = 6;
const REMOTE_SSE_START_RETRY_DELAY_MS = 800;

// ── Module state ────────────────────────────────────────────────────────────
// keyed by normalizeRemoteMcpUrl(url) — the urlKey
const remoteMcpClients = new Map();
// { client, transport, abortController, serverName, serverDescription, tools,
//   lastFailureAt, failureCount, connectPromise, _nameFragments, _urlKey }
let remoteMcpToolsCache = null;
const remoteMcpAutoConnectTimerIds = new Set();

// ── DI deps ─────────────────────────────────────────────────────────────────
let deps = {};

export function initRemoteMcp(injected) {
  deps = injected;
}

// ── Pure helpers (exported for tests) ───────────────────────────────────────

/**
 * Normalise a raw URL string to a stable Map key.
 * Strips trailing slash, lowercases protocol+host, preserves path case.
 */
export function normalizeRemoteMcpUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || "").trim());
    return `${u.protocol}//${u.host}${u.pathname}`.replace(/\/+$/, "");
  } catch {
    return String(rawUrl || "").trim().replace(/\/+$/, "");
  }
}

/**
 * Build an auth header object from a header name and token string.
 * Returns null if either argument is empty.
 */
export function parseAuthHeader(headerName, token) {
  const name = String(headerName || "").trim();
  const value = String(token || "").trim();
  if (!name || !value) return null;
  return { name, value };
}

/**
 * Attempt to correct common argument errors based on a -32602 validation error.
 * Returns corrected args object if any fix was applied, or null if nothing could be done.
 *
 * Corrections:
 * - "Expected string, received array" → unwrap single-element arrays to first element
 * - Missing required field → map common aliases (timeMin→dateMin, timeMax→dateMax)
 */
// Groups of equivalent parameter names — any can map to any other within the group.
const PARAM_EQUIV_GROUPS = [
  ["dateMin", "timeMin", "time_min", "start", "startDate", "start_date", "from"],
  ["dateMax", "timeMax", "time_max", "end", "endDate", "end_date", "to"],
  ["calendarId", "calendar_id", "calendar", "account"],
];

export function tryCorrectArgs(args, schema, errorMessage) {
  if (!args || typeof args !== "object") return null;
  const corrected = { ...args };
  let changed = false;

  const schemaProps = schema?.properties || {};

  // Fix 1: unwrap arrays that should be strings
  for (const [key, val] of Object.entries(corrected)) {
    if (Array.isArray(val) && schemaProps[key]?.type === "string") {
      corrected[key] = val.length > 0 ? String(val[0]) : "";
      changed = true;
    }
  }

  // Fix 2: bidirectional parameter name mapping using equivalence groups.
  // For each schema property that's missing from the args, check if the model
  // provided a value under an equivalent name (e.g. dateMin for timeMin or vice versa).
  for (const group of PARAM_EQUIV_GROUPS) {
    // Find the schema property that belongs to this group (case-insensitive)
    const schemaProp = Object.keys(schemaProps).find(k =>
      group.some(g => g.toLowerCase() === k.toLowerCase())
    );
    if (!schemaProp) continue;
    // Skip if already provided
    if (corrected[schemaProp] !== undefined && corrected[schemaProp] !== null) continue;
    // Check if any equivalent name was provided in the args
    for (const alias of group) {
      if (alias === schemaProp) continue;
      if (corrected[alias] !== undefined && corrected[alias] !== null) {
        corrected[schemaProp] = corrected[alias];
        delete corrected[alias];
        changed = true;
        break;
      }
    }
  }

  return changed ? corrected : null;
}

/**
 * Detect whether a URL is an SSE endpoint (legacy MCP transport).
 * SSE endpoints use GET to establish an EventSource stream, then POST
 * to a session-specific endpoint. StreamableHTTP endpoints use POST only.
 */
export function isSSEEndpoint(rawUrl) {
  try {
    const u = new URL(String(rawUrl || "").trim());
    return u.pathname.endsWith("/sse");
  } catch {
    return String(rawUrl || "").trim().endsWith("/sse");
  }
}

/**
 * RemoteSSETransport — SSE transport for remote MCP servers.
 * Adapted from NativeSSETransport in local-mcp.js.
 *
 * Connection strategy (dual-path):
 * 1. Try DIRECT EventSource GET (no proxy) — works when the server sets
 *    Access-Control-Allow-Origin headers (most public MCP servers do)
 * 2. If direct fails, try fetch-based SSE through the CORS proxy —
 *    reads the streamed response body as text and parses SSE events
 * 3. Session endpoint POST for tool calls always goes through the proxy
 *    (the proxy handles regular POST/response fine, it's long-lived
 *    streaming that it doesn't support)
 *
 * EventSource doesn't support custom headers, so auth headers are only
 * applied on POST requests (tool calls). Most SSE servers that need auth
 * use OAuth tokens obtained during the SSE handshake, not header auth.
 */
class RemoteSSETransport {
  constructor(proxiedSseUrl, originalSseUrl, getProxiedRemoteUrl, authHeaders = {}) {
    this._proxiedSseUrl = proxiedSseUrl;    // CORS-proxied URL for fallback
    this._originalSseUrl = originalSseUrl;  // Direct server URL (tried first)
    this._getProxiedRemoteUrl = getProxiedRemoteUrl;
    this._authHeaders = authHeaders;
    this._eventSource = null;
    this._fetchAbort = null;       // AbortController for fetch-based SSE fallback
    this._endpoint = null;         // Session endpoint (proxied) for POSTs
    this._rawEndpoint = null;      // Session endpoint (original, unproxied)
    this._protocolVersion = null;
    this._retryTimer = null;
    this._usedDirect = false;      // Whether direct (no proxy) EventSource succeeded
    this.onclose = null;
    this.onerror = null;
    this.onmessage = null;
  }

  /**
   * Connect via EventSource GET. Tries two strategies:
   * 1. Direct (no proxy) — native EventSource to the original server URL
   * 2. Fetch-based SSE through proxy — ReadableStream parsing of SSE events
   */
  start() {
    return new Promise(async (resolve, reject) => {
      // ── Strategy 1: Direct EventSource (no proxy) ──
      const directResult = await this._tryDirectEventSource().catch(() => null);
      if (directResult) {
        this._usedDirect = true;
        resolve();
        return;
      }

      // ── Strategy 2: Fetch-based SSE through CORS proxy ──
      console.log(`[Remote MCP SSE] Direct connection failed for ${this._originalSseUrl}, trying fetch-based SSE through proxy…`);
      try {
        await this._tryFetchBasedSSE();
        resolve();
      } catch (err) {
        reject(new Error(`Remote SSE connection failed for ${this._originalSseUrl}: direct and proxy both failed. Last error: ${err.message}`));
      }
    });
  }

  /**
   * Strategy 1: Direct EventSource to the original server URL (no CORS proxy).
   * Returns a promise that resolves when the "endpoint" event is received,
   * or rejects after REMOTE_SSE_MAX_START_ATTEMPTS failed attempts.
   */
  _tryDirectEventSource() {
    return new Promise((resolve, reject) => {
      let resolved = false;
      let attempt = 0;
      // Limit direct attempts to 3 (save budget for proxy fallback)
      const maxDirectAttempts = Math.min(REMOTE_SSE_MAX_START_ATTEMPTS, 3);

      const tryConnect = () => {
        attempt++;
        if (this._eventSource) { this._eventSource.close(); this._eventSource = null; }

        console.log(`[Remote MCP SSE] Direct attempt ${attempt}/${maxDirectAttempts} to ${this._originalSseUrl}`);
        const es = new EventSource(this._originalSseUrl);
        this._eventSource = es;

        es.addEventListener("endpoint", (e) => {
          this._handleEndpointEvent(e);
          if (!resolved) { resolved = true; resolve(true); }
        });

        es.addEventListener("message", (e) => {
          this._handleMessageEvent(e);
        });

        es.onerror = () => {
          if (!resolved) {
            es.close(); this._eventSource = null;
            if (attempt < maxDirectAttempts) {
              this._retryTimer = setTimeout(tryConnect, REMOTE_SSE_START_RETRY_DELAY_MS);
            } else {
              reject(new Error(`Direct SSE failed after ${attempt} attempts`));
            }
          } else {
            // Post-connect error: stream dropped
            es.close(); this._eventSource = null;
            this.onclose?.();
          }
        };
      };

      tryConnect();
    });
  }

  /**
   * Strategy 2: Fetch-based SSE through the CORS proxy.
   * Uses fetch() + ReadableStream to read SSE events from the proxy.
   * The proxy can handle a regular GET→response flow even if it can't
   * keep a true EventSource alive — some SSE servers send the endpoint
   * event quickly in the initial response.
   */
  async _tryFetchBasedSSE() {
    this._fetchAbort = new AbortController();
    const fetchUrl = this._proxiedSseUrl;
    console.log(`[Remote MCP SSE] Fetch-based attempt to ${fetchUrl}`);

    const resp = await fetch(fetchUrl, {
      method: "GET",
      headers: { "Accept": "text/event-stream" },
      signal: this._fetchAbort.signal
    });

    if (!resp.ok) {
      throw new Error(`Fetch SSE HTTP ${resp.status} from proxy`);
    }

    // Read the streamed response body and parse SSE events
    const reader = resp.body?.getReader();
    if (!reader) throw new Error("Fetch SSE: no readable body");

    const decoder = new TextDecoder();
    let buffer = "";
    let gotEndpoint = false;
    const startTime = Date.now();
    const maxWaitMs = REMOTE_MCP_SSE_CONNECT_TIMEOUT_MS;

    try {
      while (true) {
        if (Date.now() - startTime > maxWaitMs) {
          throw new Error(`Fetch SSE timeout waiting for endpoint event (${maxWaitMs / 1000}s)`);
        }
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // Keep incomplete last line in buffer

        for (const line of lines) {
          if (line.startsWith("event: endpoint")) {
            // Next data: line has the endpoint
            continue;
          }
          if (line.startsWith("data: ") && !gotEndpoint) {
            const data = line.slice(6).trim();
            // Check if this is the endpoint event data
            if (data.startsWith("/") || data.startsWith("http")) {
              this._handleEndpointEventData(data);
              if (this._endpoint) {
                gotEndpoint = true;
                // Don't close the reader — keep the stream alive for messages
                // But we've got what we need to return
                this._setupFetchMessageLoop(reader, decoder, buffer);
                return;
              }
            }
            // Try parsing as JSON (might be a message event)
            try {
              const msg = JSON.parse(data);
              this.onmessage?.(msg);
            } catch { /* not JSON, might be endpoint path */ }
          }
        }
      }
    } catch (err) {
      reader.cancel().catch(() => {});
      throw err;
    }

    if (!gotEndpoint) {
      throw new Error("Fetch SSE: stream ended without endpoint event");
    }
  }

  /** Continue reading SSE messages from the fetch stream after endpoint is resolved. */
  _setupFetchMessageLoop(reader, decoder, initialBuffer) {
    let buffer = initialBuffer;
    const loop = async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) { this.onclose?.(); return; }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const msg = JSON.parse(line.slice(6));
                this.onmessage?.(msg);
              } catch { /* ignore non-JSON lines */ }
            }
          }
        }
      } catch (err) {
        if (err.name !== "AbortError") {
          this.onerror?.(err);
        }
        this.onclose?.();
      }
    };
    loop(); // Fire-and-forget — runs in background
  }

  /** Handle the "endpoint" event from native EventSource. */
  _handleEndpointEvent(e) {
    this._handleEndpointEventData(e.data);
  }

  /** Resolve and proxy the endpoint URL from SSE event data. */
  _handleEndpointEventData(data) {
    try {
      // Resolve relative endpoint against the ORIGINAL server URL
      // so the host stays correct (not the proxy host)
      this._rawEndpoint = new URL(data, this._originalSseUrl);
    } catch {
      try { this._rawEndpoint = new URL(data); } catch { /* ignore */ }
    }
    if (this._rawEndpoint) {
      // Always proxy the session POST endpoint for CORS
      this._endpoint = this._getProxiedRemoteUrl(this._rawEndpoint.toString());
      console.log(`[Remote MCP SSE] Got session endpoint: ${this._rawEndpoint} → proxied: ${this._endpoint}`);
    }
  }

  /** Handle an SSE "message" event. */
  _handleMessageEvent(e) {
    try {
      const msg = JSON.parse(e.data);
      this.onmessage?.(msg);
    } catch (err) {
      this.onerror?.(new Error(`Failed to parse SSE message: ${err.message}`));
    }
  }

  /** Send a JSON-RPC message to the session endpoint via POST. */
  async send(message) {
    if (!this._endpoint) throw new Error("RemoteSSETransport: not connected (no session endpoint)");
    const headers = {
      "Content-Type": "application/json",
      ...this._authHeaders
    };
    if (this._protocolVersion) {
      headers["mcp-protocol-version"] = this._protocolVersion;
    }
    const resp = await fetch(this._endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(message)
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`RemoteSSETransport POST ${resp.status}: ${text}`);
    }
  }

  /** Get the proxied session endpoint URL (for raw JSON-RPC tool calls). */
  getSessionEndpoint() {
    return this._endpoint;
  }

  /** Whether the direct (no proxy) strategy was used for EventSource. */
  usedDirectConnection() {
    return this._usedDirect;
  }

  /** Close the EventSource, fetch abort, and any pending retry timer. */
  async close() {
    if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
    if (this._eventSource) { this._eventSource.close(); this._eventSource = null; }
    if (this._fetchAbort) { this._fetchAbort.abort(); this._fetchAbort = null; }
  }
}

// ── Tool accessors ───────────────────────────────────────────────────────────

/**
 * Normalise a server name into a safe tool-name prefix.
 * "Open Brain" → "open_brain", "my-server" → "my_server"
 */
function serverNameToPrefix(name) {
  return (name || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

export function getRemoteMcpTools() {
  if (remoteMcpToolsCache) return remoteMcpToolsCache;

  const allTools = [];
  const nameToIndex = new Map();
  const collisionNames = new Set();

  for (const [, entry] of remoteMcpClients) {
    if (!entry?.serverName || !Array.isArray(entry.tools)) continue;
    for (const tool of entry.tools) {
      if (nameToIndex.has(tool.name)) {
        if (!collisionNames.has(tool.name)) {
          collisionNames.add(tool.name);
          const origIdx = nameToIndex.get(tool.name);
          const origTool = allTools[origIdx];
          const origPrefix = serverNameToPrefix(origTool._serverName);
          const namespacedOrigName = `${origPrefix}__${origTool.name}`;
          origTool._originalName = origTool._originalName || origTool.name;
          origTool.name = namespacedOrigName;
          deps.debugLog(`[Remote MCP] Tool name collision: "${tool.name}" — renamed first occurrence to "${namespacedOrigName}" (from ${origTool._serverName})`);
        }
        const prefix = serverNameToPrefix(entry.serverName);
        const namespacedName = `${prefix}__${tool.name}`;
        const namespacedTool = { ...tool, name: namespacedName, _originalName: tool.name };
        allTools.push(namespacedTool);
        deps.debugLog(`[Remote MCP] Tool name collision: "${tool.name}" — renamed to "${namespacedName}" (from ${entry.serverName})`);
      } else {
        nameToIndex.set(tool.name, allTools.length);
        allTools.push(tool);
      }
    }
  }
  remoteMcpToolsCache = allTools;
  return remoteMcpToolsCache;
}

export function getRemoteMcpClients() {
  return remoteMcpClients;
}

export function getRemoteMcpToolsCache() {
  return remoteMcpToolsCache;
}

export function invalidateRemoteMcpToolsCache() {
  remoteMcpToolsCache = null;
}

// ── Suspension key lookup ────────────────────────────────────────────────────

/**
 * Resolve a remote tool invocation to its server key ("remote:<urlKey>").
 * Returns null for non-remote tools — caller checks local MCP as a fallback.
 */
export function getRemoteServerKeyForTool(toolName, toolObj, args) {
  // Direct remote tool (≤15 tools from that server)
  if (toolObj && toolObj._urlKey && toolObj._isRemote) return `remote:${toolObj._urlKey}`;
  // REMOTE_MCP_EXECUTE meta-tool (>15 tools, routed)
  if (toolName === "REMOTE_MCP_EXECUTE" && args?.server_name) {
    for (const [urlKey, entry] of remoteMcpClients.entries()) {
      if (entry.serverName === args.server_name) return `remote:${urlKey}`;
    }
  }
  // REMOTE_MCP_ROUTE is discovery-only — don't suspend
  if (toolName === "REMOTE_MCP_ROUTE") return null;
  return null;
}

// ── Meta-tools for large servers (>15 tools) ─────────────────────────────────

export function buildRemoteMcpRouteTool() {
  const cache = getRemoteMcpTools();
  const routedServers = [...new Set(cache.filter(t => !t._isDirect).map(t => t._serverName))];
  const serverNameDesc = routedServers.length > 0
    ? `Server name. Available servers: ${routedServers.join(", ")}`
    : "Server name from the system prompt";

  return {
    name: "REMOTE_MCP_ROUTE",
    isMutating: false,
    description: "Discover available tools on a remote MCP server. Call this FIRST for routed remote servers to see their tool names, descriptions, and input schemas. Then call REMOTE_MCP_EXECUTE with the specific tool.",
    input_schema: {
      type: "object",
      properties: {
        server_name: { type: "string", description: serverNameDesc },
        task_description: { type: "string", description: "Optional: brief description of what you want to accomplish" }
      },
      required: ["server_name"]
    },
    execute: async (args) => {
      const serverName = args?.server_name;
      if (!serverName) return { error: "server_name is required" };

      const cache = getRemoteMcpTools();
      let serverTools = cache.filter(t => t._serverName === serverName && !t._isDirect);

      if (serverTools.length === 0) {
        const lowerName = serverName.toLowerCase();
        serverTools = cache.filter(t => (t._serverName || "").toLowerCase() === lowerName && !t._isDirect);
      }

      if (serverTools.length === 0) {
        const lowerName2 = (serverName || "").toLowerCase();
        // Find ALL direct tools from this server, not just the first match
        const directTools = cache.filter(t => t._isDirect && t._isRemote && (
          (t._serverName || "").toLowerCase() === lowerName2 ||
          (t._serverName || "").toLowerCase().includes(lowerName2)
        ));
        if (directTools.length > 0) {
          // Show all tool names. Note: cross-source dedup may have renamed these
          // (e.g. search_issues → sentry__search_issues). The actual names in the
          // cache may already reflect within-remote-MCP renames; cross-source renames
          // are applied at schema assembly time. Hint the namespaced form so the model
          // can find the right tool even if it was cross-source renamed.
          const prefix = serverNameToPrefix(directTools[0]._serverName || serverName);
          const toolList = directTools.map(t => {
            const namespacedHint = `${prefix}__${t._originalName || t.name}`;
            return namespacedHint !== t.name ? `${t.name} (or ${namespacedHint} if renamed)` : t.name;
          });
          return { error: `"${serverName}" is a DIRECT server — its tools are in your tool list. Do NOT use REMOTE_MCP_ROUTE. Call these tools directly: ${toolList.join(", ")}` };
        }
        const available = [...new Set(cache.filter(t => !t._isDirect && t._isRemote).map(t => t._serverName))];
        return { error: `Remote server "${serverName}" not found. Available routed servers: ${available.join(", ") || "(none)"}` };
      }

      const lines = serverTools.map(t => {
        const schema = t.input_schema && Object.keys(t.input_schema.properties || {}).length > 0
          ? `\n  Input: ${JSON.stringify(t.input_schema)}`
          : "";
        const nameLabel = t._originalName && t._originalName !== t.name
          ? `${t.name}` + ` (originally "${t._originalName}" — renamed to avoid collision)`
          : t.name;
        return `- **${nameLabel}**: ${t.description || "(no description)"}${schema}`;
      });
      const callHint = `Call these via REMOTE_MCP_EXECUTE({ "tool_name": "...", "arguments": {...} }).`;
      const collisionHint = serverTools.some(t => t._originalName && t._originalName !== t.name)
        ? ` Use the full namespaced tool name to avoid ambiguity.`
        : "";
      return {
        text: `## ${serverTools[0]._serverName} — ${serverTools.length} tools available\n\n${callHint}${collisionHint}\n\n${lines.join("\n\n")}`
      };
    }
  };
}

export function buildRemoteMcpMetaTool() {
  return {
    name: "REMOTE_MCP_EXECUTE",
    description: "Execute a tool discovered via REMOTE_MCP_ROUTE. Provide the exact tool_name and its arguments. When multiple servers have tools with the same original name, use the namespaced form (e.g. \"server_name__tool\") or provide server_name to disambiguate.",
    input_schema: {
      type: "object",
      properties: {
        tool_name: { type: "string", description: "Exact tool name returned by REMOTE_MCP_ROUTE (use namespaced name when there are collisions)" },
        server_name: { type: "string", description: "Optional: server name to disambiguate when multiple servers have the same tool name" },
        arguments: { type: "object", description: "Arguments for the tool" }
      },
      required: ["tool_name"]
    },
    execute: async (args) => {
      const innerName = args?.tool_name;
      const serverFilter = args?.server_name;
      if (!innerName) return { error: "tool_name is required" };
      const cache = getRemoteMcpTools();

      let tool;

      // 1. If server_name is provided, find by original name within that server
      if (serverFilter) {
        const lowerServer = serverFilter.toLowerCase();
        tool = cache.find(t =>
          (t._serverName || "").toLowerCase() === lowerServer &&
          (t.name === innerName || t._originalName === innerName)
        );
        if (!tool) {
          const lowerName = innerName.toLowerCase();
          tool = cache.find(t =>
            (t._serverName || "").toLowerCase() === lowerServer &&
            (t.name.toLowerCase() === lowerName || (t._originalName || "").toLowerCase() === lowerName)
          );
        }
      }

      // 2. Direct name match (namespaced or non-colliding)
      if (!tool) {
        tool = cache.find(t => t.name === innerName);
      }

      // 3. Match by _originalName — disambiguate if multiple
      if (!tool) {
        const origMatches = cache.filter(t => t._originalName === innerName);
        if (origMatches.length === 1) {
          tool = origMatches[0];
        } else if (origMatches.length > 1) {
          const options = origMatches.map(t => `"${t.name}" (${t._serverName})`).join(", ");
          return { error: `Tool "${innerName}" exists on multiple servers. Use the namespaced name: ${options}` };
        }
      }

      // 4. Case-insensitive fallback
      if (!tool) {
        const lower = innerName.toLowerCase();
        tool = cache.find(t => t.name.toLowerCase() === lower);
      }

      if (!tool) return { error: `Tool "${innerName}" not found in remote MCP servers. Use REMOTE_MCP_ROUTE to discover available tools.` };
      return tool.execute(args.arguments || {});
    }
  };
}

// ── Connection management ────────────────────────────────────────────────────

export async function connectRemoteMcp(serverConfig) {
  const { url: rawUrl, name: configName, header, token, authType, oauthProvider } = serverConfig || {};
  if (!rawUrl || !String(rawUrl).startsWith("http")) {
    deps.debugLog("[Remote MCP] Invalid or missing URL:", rawUrl);
    return null;
  }

  const urlKey = normalizeRemoteMcpUrl(rawUrl);
  const existing = remoteMcpClients.get(urlKey);

  // Already connected — tools cached
  if (existing?.serverName && Array.isArray(existing.tools)) return existing;

  // MCP OAuth auto-connect: skip if no stored tokens (user must use command palette)
  if (authType === "mcp-oauth" && !serverConfig._interactive) {
    const hash = urlToHash(urlKey);
    const storedTokens = deps.getExtensionAPI()?.settings?.get(`mcp-oauth-tokens-${hash}`);
    if (!storedTokens) {
      deps.debugLog(`[Remote MCP] MCP OAuth: no stored tokens for ${urlKey} — skipping auto-connect (use command palette)`);
      return null;
    }
  }

  // Exponential backoff after recent failure
  if (existing?.lastFailureAt && existing.failureCount > 0) {
    const backoffMs = Math.min(REMOTE_MCP_INITIAL_BACKOFF_MS * Math.pow(2, existing.failureCount - 1), REMOTE_MCP_MAX_BACKOFF_MS);
    if ((Date.now() - existing.lastFailureAt) < backoffMs) {
      deps.debugLog(`[Remote MCP] ${urlKey} skipped (backoff ${Math.round(backoffMs / 1000)}s after ${existing.failureCount} failure(s))`);
      return null;
    }
  }

  // Dedup in-flight connect
  if (existing?.connectPromise) {
    deps.debugLog(`[Remote MCP] ${urlKey} connection already in progress`);
    return existing.connectPromise;
  }

  const promise = (async () => {
    let transport = null;
    let client = null;
    let abortController = null;
    // Build auth headers before try block so they're accessible in catch fallback
    const headers = {};
    let resolvedOauthProvider = null;
    let authProvider = null;   // MCP OAuth 2.1 provider (set when authType === "mcp-oauth")

    if (authType === "mcp-oauth") {
      // MCP OAuth 2.1 — SDK-native auth. Provider handles discovery, DCR, PKCE, tokens.
      // Always create the provider, even for SSE URLs — the SSE→StreamableHTTP fallback
      // path will use it if the SSE connection fails (which it will without auth).
      authProvider = createMcpOAuthProvider({
        urlHash: urlToHash(normalizeRemoteMcpUrl(rawUrl)),
        preRegisteredClientId: serverConfig.mcpOauthClientId || "",
        preRegisteredClientSecret: serverConfig.mcpOauthClientSecret || "",
        silent: !serverConfig._interactive,  // suppress popups during auto-connect
      });
      deps.debugLog(`[Remote MCP] MCP OAuth 2.1 auth provider created for ${urlKey}`);
    } else if (authType === "oauth" && oauthProvider && deps.getOAuthAuthHeader) {
      const oauthHeader = await deps.getOAuthAuthHeader(oauthProvider);
      if (oauthHeader) {
        headers[oauthHeader.name] = oauthHeader.value;
        resolvedOauthProvider = oauthProvider;
        deps.debugLog(`[Remote MCP] OAuth auth (${oauthProvider}): ${oauthHeader.name}: [REDACTED]`);
      } else {
        deps.debugLog(`[Remote MCP] No OAuth token for ${oauthProvider} — connecting without auth`);
      }
    } else {
      const authHeader = parseAuthHeader(header, token);
      if (authHeader) {
        headers[authHeader.name] = authHeader.value;
        deps.debugLog(`[Remote MCP] Auth header: ${authHeader.name}: [REDACTED]`);
      }
    }

    // MCP OAuth 2.1 only works on StreamableHTTP — if the URL ends in /sse,
    // rewrite to /mcp to skip the SSE→fallback dance entirely.
    // Declared before try so the catch block can check it for fallback suppression.
    let effectiveUrl = rawUrl;
    if (authProvider && isSSEEndpoint(rawUrl)) {
      const rewritten = rawUrl.replace(/\/sse\s*$/, "/mcp");
      if (rewritten !== rawUrl) {
        deps.debugLog(`[Remote MCP] MCP OAuth: rewriting SSE URL to StreamableHTTP: ${rewritten}`);
        effectiveUrl = rewritten;
      }
    }

    try {
      const proxiedUrl = authProvider ? getOAuthProxiedUrl(effectiveUrl) : deps.getProxiedRemoteUrl(effectiveUrl);
      deps.debugLog(`[Remote MCP] Connecting to ${urlKey} via ${proxiedUrl !== effectiveUrl ? (authProvider ? "OAuth Worker proxy" : "proxy") : "direct"}`);

      const useSSE = isSSEEndpoint(effectiveUrl);
      abortController = new AbortController();

      if (useSSE) {
        // ── SSE transport: direct EventSource → proxied POST (with fetch fallback) ──
        deps.debugLog(`[Remote MCP] Using SSE transport for ${urlKey} (direct first, proxy fallback)`);
        transport = new RemoteSSETransport(proxiedUrl, rawUrl, deps.getProxiedRemoteUrl, headers);

        // Connect: establish EventSource, wait for session endpoint
        let timeoutId = null;
        try {
          await Promise.race([
            transport.start(),
            new Promise((_, reject) => {
              timeoutId = setTimeout(() => {
                timeoutId = null;
                reject(new Error(`Remote SSE connect timeout (${REMOTE_MCP_SSE_CONNECT_TIMEOUT_MS / 1000}s) for ${urlKey}`));
              }, REMOTE_MCP_SSE_CONNECT_TIMEOUT_MS);
            })
          ]);
        } finally {
          if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
        }

        // Use SDK Client over the SSE transport for discovery
        client = new Client({ name: `roam-remote-mcp-sse-${urlKey.slice(0, 40)}`, version: "0.1.0" });
        await client.connect(transport);
      } else {
        // ── StreamableHTTP transport (existing path) ──
        const wrappedFetch = (input, init = {}) => fetch(input, { ...init, signal: abortController.signal });

        // MCP OAuth: pass the effective URL (not proxied) so the SDK constructs correct
        // discovery URLs (/.well-known/oauth-protected-resource, auth server metadata, DCR).
        // OAuth connections route through the OAuth Worker proxy; non-OAuth through corsAnywhere.
        const useRawUrl = !!authProvider;
        const transportUrl = useRawUrl ? new URL(effectiveUrl) : new URL(proxiedUrl);
        const proxyFn = useRawUrl ? getOAuthProxiedUrl : deps.getProxiedRemoteUrl;
        const transportFetch = useRawUrl
          ? (input, init = {}) => {
              const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
              return fetch(proxyFn(url), { ...init, signal: abortController.signal });
            }
          : wrappedFetch;

        transport = new StreamableHTTPClientTransport(
          transportUrl,
          {
            fetch: transportFetch,
            requestInit: { headers },
            ...(authProvider ? { authProvider } : {}),
          }
        );

        const clientName = `roam-remote-mcp-${urlKey.slice(0, 40)}`;
        client = new Client({ name: clientName, version: "0.1.0" });

        let timeoutId = null;
        try {
          await Promise.race([
            client.connect(transport),
            new Promise((_, reject) => {
              timeoutId = setTimeout(() => {
                timeoutId = null;
                reject(new Error(`Remote MCP connect timeout (${REMOTE_MCP_CONNECT_TIMEOUT_MS / 1000}s) for ${urlKey}`));
              }, REMOTE_MCP_CONNECT_TIMEOUT_MS);
            })
          ]);
        } catch (connectErr) {
          // MCP OAuth 2.1 two-phase connect: SDK opened popup, now await auth code
          if (connectErr instanceof UnauthorizedError && authProvider?._authPromise) {
            deps.debugLog(`[Remote MCP] MCP OAuth redirect initiated for ${urlKey}, awaiting user authorisation…`);
            deps.showInfoToast("Authorising…", `Complete sign-in in the popup for ${configName || urlKey}.`);

            const authorizationCode = await authProvider._authPromise;
            await transport.finishAuth(authorizationCode);
            deps.debugLog(`[Remote MCP] MCP OAuth code exchanged for ${urlKey}, reconnecting…`);

            // Transport can only start() once — recreate client + transport
            try { await transport.close(); } catch { }
            transport = new StreamableHTTPClientTransport(
              transportUrl,
              { fetch: transportFetch, requestInit: { headers }, authProvider }
            );
            client = new Client({ name: clientName, version: "0.1.0" });

            let postAuthTimeout = null;
            try {
              await Promise.race([
                client.connect(transport),
                new Promise((_, reject) => {
                  postAuthTimeout = setTimeout(() => {
                    postAuthTimeout = null;
                    reject(new Error(`Post-auth connect timeout (${REMOTE_MCP_CONNECT_TIMEOUT_MS / 1000}s) for ${urlKey}`));
                  }, REMOTE_MCP_CONNECT_TIMEOUT_MS);
                })
              ]);
            } finally {
              if (postAuthTimeout) { clearTimeout(postAuthTimeout); postAuthTimeout = null; }
            }

            deps.showInfoToast("Authorised", `${configName || urlKey} connected via MCP OAuth.`);
          } else {
            throw connectErr;  // Non-OAuth error — propagate normally
          }
        } finally {
          if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
        }
      }

      // Capture server metadata from MCP handshake
      const serverVersion = client.getServerVersion?.() || {};
      const serverName = configName || serverVersion.name || urlKey.split("/").pop() || "remote-mcp";
      const serverDescription = serverVersion.description || client.getInstructions?.() || "";

      // List tools at connection time
      let tools = [];
      try {
        let listTimeoutId;
        const result = await Promise.race([
          client.listTools(),
          new Promise((_, reject) => {
            listTimeoutId = setTimeout(() => reject(new Error(`listTools timeout for ${urlKey}`)), REMOTE_MCP_LIST_TOOLS_TIMEOUT_MS);
          })
        ]).finally(() => { if (listTimeoutId) clearTimeout(listTimeoutId); });

        const serverTools = result?.tools || [];
        const isDirect = serverTools.length <= REMOTE_MCP_DIRECT_TOOL_THRESHOLD;

        for (const t of serverTools) {
          if (!t?.name) continue;
          const toolName = t.name;
          const annotations = t.annotations || null;
          let isMutating;
          if (annotations?.readOnlyHint === true) isMutating = false;
          else if (annotations?.destructiveHint === true || annotations?.readOnlyHint === false) isMutating = true;
          else isMutating = undefined;

          // Cap external tool descriptions to reduce tool token overhead (#63)
          const rawDesc = t.description || "";
          const trimmedDesc = rawDesc.length > 300 ? rawDesc.slice(0, 299) + "…" : rawDesc;
          tools.push({
            name: toolName,
            isMutating,
            description: trimmedDesc,
            input_schema: t.inputSchema || { type: "object", properties: {} },
            _annotations: annotations,
            _serverName: serverName,
            _serverDescription: serverDescription,
            _urlKey: urlKey,
            _isDirect: isDirect,
            _isRemote: true,
            execute: async (args = {}) => {
              const entry = remoteMcpClients.get(urlKey);
              if (!entry) return { error: `Remote server "${urlKey}" not connected` };
              const schema = t.inputSchema || {};
              try {
                // Use SDK client.callTool() — handles protocol headers, session ID,
                // and transport details that raw fetch() misses (causes 400 on strict servers).
                if (entry.client) {
                  const sdkResult = await entry.client.callTool({ name: toolName, arguments: args });
                  const text = sdkResult?.content?.[0]?.text;
                  if (typeof text === "string") {
                    try { return JSON.parse(text); } catch { return { text }; }
                  }
                  return sdkResult;
                }
                return { error: `Remote server "${urlKey}" has no active client` };
              } catch (err) {
                const msg = err?.message || "";
                // Auto-correct common argument errors and retry once
                if (msg.includes("-32602") && entry.client) {
                  const corrected = tryCorrectArgs(args, schema, msg);
                  if (corrected) {
                    deps.debugLog(`[Remote MCP] Retrying ${toolName} with corrected args`);
                    try {
                      const retryResult = await entry.client.callTool({ name: toolName, arguments: corrected });
                      const retryText = retryResult?.content?.[0]?.text;
                      if (typeof retryText === "string") {
                        try { return JSON.parse(retryText); } catch { return { text: retryText }; }
                      }
                      return retryResult;
                    } catch (retryErr) {
                      deps.debugLog(`[Remote MCP] Retry also failed for ${toolName}:`, retryErr?.message);
                    }
                  }
                }
                deps.debugLog(`[Remote MCP] Tool call failed for ${toolName}:`, msg);
                return { error: `Remote MCP tool "${toolName}" failed: ${msg}` };
              }
            }
          });
        }
        deps.debugLog(`[Remote MCP] Discovered ${serverTools.length} tools from ${urlKey} (server: ${serverName})`);
      } catch (e) {
        console.warn(`[Remote MCP] listTools failed for ${urlKey}:`, e?.message);
        throw e;
      }

      // ─── MCP Supply Chain Hardening ───
      const flaggedTools = deps.scanToolDescriptions(tools, serverName);
      let pinResult = { status: "skipped" };
      try {
        pinResult = await deps.checkSchemaPin(`remote:${urlKey}`, tools, serverName);
      } catch (e) {
        deps.debugLog(`[MCP Security] Schema pin failed for ${urlKey}:`, e?.message);
      }
      try {
        await deps.updateMcpBom(`remote:${urlKey}`, serverName, serverDescription, tools, pinResult, flaggedTools);
      } catch (e) {
        deps.debugLog(`[MCP BOM] BOM update failed for ${urlKey}:`, e?.message);
      }
      // ─── End Supply Chain Hardening ───

      // Pre-compute name fragments for auto-escalation prompt matching
      const _nameFragments = serverName
        ? serverName.toLowerCase().split(/[-_\s]/).filter(p => p.length > 3).map(part => {
          const escaped = part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          try { return new RegExp(`\\b${escaped}\\b`); } catch { return null; }
        }).filter(Boolean)
        : [];

      // For SSE servers, capture the session endpoint URL for tool execution
      const _isSSE = useSSE;
      const _sessionUrl = _isSSE && transport.getSessionEndpoint ? transport.getSessionEndpoint() : null;

      const sseMethod = _isSSE && transport.usedDirectConnection?.() ? " (SSE direct)" : _isSSE ? " (SSE via proxy)" : "";
      remoteMcpClients.set(urlKey, {
        client, transport, abortController,
        _proxiedUrl: proxiedUrl, _headers: headers,
        _oauthProvider: resolvedOauthProvider,
        _authProvider: authProvider,
        _isSSE, _sessionUrl,
        serverName, serverDescription, tools,
        lastFailureAt: 0, failureCount: 0, connectPromise: null,
        _nameFragments, _urlKey: urlKey
      });
      remoteMcpToolsCache = null;
      deps.debugLog(`[Remote MCP] Connected: ${serverName} — ${tools.length} tool(s)${sseMethod}`);
      deps.showInfoToast("Remote MCP connected", `${serverName} — ${tools.length} tool${tools.length !== 1 ? "s" : ""} available.`);
      return true;
    } catch (error) {
      if (abortController) { try { abortController.abort(); } catch { } }
      if (client) try { await client.close(); } catch { }
      if (transport) try { await transport.close(); } catch { }

      // ── StreamableHTTP fallback for failed SSE endpoints ──
      // Many modern MCP servers support both /sse and /mcp transports.
      // When SSE fails (CORS, proxy 410, etc.), try StreamableHTTP automatically.
      // Skip if effectiveUrl was already rewritten to /mcp (MCP OAuth path).
      if (isSSEEndpoint(effectiveUrl)) {
        const fallbackUrl = effectiveUrl.replace(/\/sse\s*$/, "/mcp");
        if (fallbackUrl !== rawUrl) {
          deps.debugLog(`[Remote MCP] SSE failed for ${urlKey}, trying StreamableHTTP fallback: ${fallbackUrl}`);
          try {
            const fbAbort = new AbortController();
            const fbProxyFn = authProvider ? getOAuthProxiedUrl : deps.getProxiedRemoteUrl;
            const fbProxied = fbProxyFn(fallbackUrl);
            const fbUseRaw = !!authProvider;
            const fbTransportUrl = fbUseRaw ? new URL(fallbackUrl) : new URL(fbProxied);
            const fbFetch = fbUseRaw
              ? (input, init = {}) => {
                  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
                  return fetch(fbProxyFn(url), { ...init, signal: fbAbort.signal });
                }
              : (input, init = {}) => fetch(input, { ...init, signal: fbAbort.signal });
            const fbClientName = `roam-remote-mcp-${urlKey.slice(0, 40)}`;
            let fbTransport = new StreamableHTTPClientTransport(
              fbTransportUrl,
              { fetch: fbFetch, requestInit: { headers }, ...(authProvider ? { authProvider } : {}) }
            );
            let fbClient = new Client({ name: fbClientName, version: "0.1.0" });

            let fbTimeoutId = null;
            try {
              await Promise.race([
                fbClient.connect(fbTransport),
                new Promise((_, reject) => {
                  fbTimeoutId = setTimeout(() => {
                    fbTimeoutId = null;
                    reject(new Error(`StreamableHTTP fallback timeout (${REMOTE_MCP_CONNECT_TIMEOUT_MS / 1000}s) for ${urlKey}`));
                  }, REMOTE_MCP_CONNECT_TIMEOUT_MS);
                })
              ]);
            } catch (fbConnErr) {
              // MCP OAuth two-phase connect in the SSE→StreamableHTTP fallback
              if (fbConnErr instanceof UnauthorizedError && authProvider?._authPromise) {
                deps.debugLog(`[Remote MCP] MCP OAuth redirect (SSE fallback) for ${urlKey}, awaiting user…`);
                deps.showInfoToast("Authorising…", `Complete sign-in in the popup for ${configName || urlKey}.`);

                const fbAuthCode = await authProvider._authPromise;
                await fbTransport.finishAuth(fbAuthCode);
                deps.debugLog(`[Remote MCP] MCP OAuth code exchanged (SSE fallback) for ${urlKey}, reconnecting…`);

                try { await fbTransport.close(); } catch { }
                fbTransport = new StreamableHTTPClientTransport(
                  fbTransportUrl,
                  { fetch: fbFetch, requestInit: { headers }, authProvider }
                );
                fbClient = new Client({ name: fbClientName, version: "0.1.0" });

                let postAuthFbTimeout = null;
                try {
                  await Promise.race([
                    fbClient.connect(fbTransport),
                    new Promise((_, reject) => {
                      postAuthFbTimeout = setTimeout(() => {
                        postAuthFbTimeout = null;
                        reject(new Error(`Post-auth fallback timeout (${REMOTE_MCP_CONNECT_TIMEOUT_MS / 1000}s) for ${urlKey}`));
                      }, REMOTE_MCP_CONNECT_TIMEOUT_MS);
                    })
                  ]);
                } finally {
                  if (postAuthFbTimeout) { clearTimeout(postAuthFbTimeout); postAuthFbTimeout = null; }
                }
                deps.showInfoToast("Authorised", `${configName || urlKey} connected via MCP OAuth.`);
              } else {
                throw fbConnErr;
              }
            } finally {
              if (fbTimeoutId) { clearTimeout(fbTimeoutId); fbTimeoutId = null; }
            }

            // Success — discover tools using the fallback transport
            const fbServerVersion = fbClient.getServerVersion?.() || {};
            const fbServerName = configName || fbServerVersion.name || urlKey.split("/").pop() || "remote-mcp";
            const fbServerDescription = fbServerVersion.description || fbClient.getInstructions?.() || "";

            let fbTools = [];
            try {
              let fbListTimeout;
              const fbResult = await Promise.race([
                fbClient.listTools(),
                new Promise((_, reject) => {
                  fbListTimeout = setTimeout(() => reject(new Error(`listTools timeout for ${urlKey}`)), REMOTE_MCP_LIST_TOOLS_TIMEOUT_MS);
                })
              ]).finally(() => { if (fbListTimeout) clearTimeout(fbListTimeout); });
              fbTools = (fbResult?.tools || []).map(t => ({
                ...t,
                _serverName: fbServerName, _serverDescription: fbServerDescription,
                _urlKey: urlKey, _isRemote: true, _isDirect: (fbResult?.tools || []).length <= REMOTE_MCP_DIRECT_TOOL_THRESHOLD,
                execute: async (args) => {
                  const entry = remoteMcpClients.get(urlKey);
                  if (!entry?.client) throw new Error(`Remote server "${urlKey}" not connected`);
                  const sdkResult = await entry.client.callTool({ name: t.name, arguments: args || {} });
                  const text = sdkResult?.content?.[0]?.text;
                  if (typeof text === "string") {
                    try { return JSON.parse(text); } catch { return { text }; }
                  }
                  return sdkResult;
                }
              }));
            } catch (listErr) {
              console.warn(`[Remote MCP] Fallback listTools failed for ${urlKey}:`, listErr?.message);
            }

            const fbNameFragments = fbServerName.toLowerCase().split(/[\s_\-\/]+/).filter(f => f.length >= 2);
            remoteMcpClients.set(urlKey, {
              client: fbClient, transport: fbTransport, abortController: fbAbort,
              _proxiedUrl: fbProxied, _headers: headers,
              _oauthProvider: resolvedOauthProvider,
              _authProvider: authProvider,
              _isSSE: false, _sessionUrl: null,
              serverName: fbServerName, serverDescription: fbServerDescription, tools: fbTools,
              lastFailureAt: 0, failureCount: 0, connectPromise: null,
              _nameFragments: fbNameFragments, _urlKey: urlKey
            });
            remoteMcpToolsCache = null;
            deps.debugLog(`[Remote MCP] Connected: ${fbServerName} — ${fbTools.length} tool(s) (SSE→StreamableHTTP fallback)`);
            deps.showInfoToast("Remote MCP connected", `${fbServerName} — ${fbTools.length} tool${fbTools.length !== 1 ? "s" : ""} available (StreamableHTTP fallback).`);
            return true;
          } catch (fbError) {
            console.warn(`[Remote MCP] StreamableHTTP fallback also failed for ${urlKey}:`, fbError?.message);
          }
        }
      }

      const prevCount = remoteMcpClients.get(urlKey)?.failureCount || 0;
      console.warn(`[Remote MCP] Failed to connect to ${urlKey} (attempt ${prevCount + 1}):`, error?.message);
      remoteMcpClients.set(urlKey, {
        client: null, transport: null, abortController: null,
        lastFailureAt: Date.now(), failureCount: prevCount + 1, connectPromise: null,
        serverName: null, serverDescription: "", tools: [], _nameFragments: [], _urlKey: urlKey
      });
      return null;
    } finally {
      const entry = remoteMcpClients.get(urlKey);
      if (entry) entry.connectPromise = null;
    }
  })();

  // Store in-flight promise immediately for deduplication
  const entry = remoteMcpClients.get(urlKey) || {
    client: null, transport: null, abortController: null,
    lastFailureAt: 0, failureCount: 0, connectPromise: null,
    serverName: null, serverDescription: "", tools: [], _nameFragments: [], _urlKey: urlKey
  };
  entry.connectPromise = promise;
  remoteMcpClients.set(urlKey, entry);
  return promise;
}

export async function disconnectRemoteMcp(urlKey) {
  const entry = remoteMcpClients.get(urlKey);
  if (!entry) { remoteMcpClients.delete(urlKey); return; }
  try {
    if (entry.abortController) { try { entry.abortController.abort(); } catch { } }
    if (entry.client) await entry.client.close().catch(() => { });
    if (entry.transport) await entry.transport.close().catch(() => { });
    deps.debugLog(`[Remote MCP] Disconnected from ${urlKey}`);
  } catch (error) {
    console.warn(`[Remote MCP] Error disconnecting ${urlKey}:`, error?.message);
  } finally {
    remoteMcpClients.delete(urlKey);
    remoteMcpToolsCache = null;
  }
}

export async function disconnectAllRemoteMcp() {
  const keys = [...remoteMcpClients.keys()];
  await Promise.allSettled(keys.map(k => disconnectRemoteMcp(k)));
  remoteMcpToolsCache = null;
}

// ── Auto-connect scheduler ───────────────────────────────────────────────────

export function scheduleRemoteMcpAutoConnect() {
  const servers = deps.getRemoteMcpServers();
  if (!servers.length) return;

  const connectWithRetry = (serverConfig, attempt) => {
    if (deps.isUnloadInProgress() || deps.getExtensionAPI() === null) return;
    const urlKey = normalizeRemoteMcpUrl(serverConfig.url);
    if (attempt > REMOTE_MCP_AUTO_CONNECT_MAX_RETRIES) {
      deps.debugLog(`[Remote MCP] Auto-connect gave up on ${urlKey} after ${REMOTE_MCP_AUTO_CONNECT_MAX_RETRIES} retries`);
      deps.showErrorToast("Remote MCP failed", `Could not connect to ${serverConfig.name || urlKey} after ${REMOTE_MCP_AUTO_CONNECT_MAX_RETRIES} retries. Use "Refresh Remote MCP Servers" to retry.`);
      return;
    }
    // Reset backoff for failed entries only
    const stale = remoteMcpClients.get(urlKey);
    if (stale && !stale.serverName && !stale.connectPromise) {
      stale.lastFailureAt = 0;
      stale.failureCount = 0;
    }
    connectRemoteMcp(serverConfig).then(result => {
      if (result) return;
      const delay = Math.min(REMOTE_MCP_INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1), REMOTE_MCP_MAX_BACKOFF_MS);
      deps.debugLog(`[Remote MCP] Auto-connect retry for ${urlKey} in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${REMOTE_MCP_AUTO_CONNECT_MAX_RETRIES})`);
      const tid = window.setTimeout(() => { remoteMcpAutoConnectTimerIds.delete(tid); connectWithRetry(serverConfig, attempt + 1); }, delay);
      remoteMcpAutoConnectTimerIds.add(tid);
    }).catch(e => {
      deps.debugLog(`[Remote MCP] Auto-connect failed for ${urlKey}:`, e?.message);
      const delay = Math.min(REMOTE_MCP_INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1), REMOTE_MCP_MAX_BACKOFF_MS);
      const tid = window.setTimeout(() => { remoteMcpAutoConnectTimerIds.delete(tid); connectWithRetry(serverConfig, attempt + 1); }, delay);
      remoteMcpAutoConnectTimerIds.add(tid);
    });
  };

  // Stagger after local MCP auto-connect to avoid stampede at startup
  const initialTid = window.setTimeout(() => {
    remoteMcpAutoConnectTimerIds.delete(initialTid);
    if (deps.isUnloadInProgress() || deps.getExtensionAPI() === null) return;
    servers.forEach(s => connectWithRetry(s, 1));
  }, deps.COMPOSIO_AUTO_CONNECT_DELAY_MS + 1500);
  remoteMcpAutoConnectTimerIds.add(initialTid);
}

// ── Cleanup ──────────────────────────────────────────────────────────────────

export function cleanupRemoteMcp() {
  remoteMcpToolsCache = null;
  remoteMcpAutoConnectTimerIds.forEach(id => clearTimeout(id));
  remoteMcpAutoConnectTimerIds.clear();
  // Abort all in-flight transports
  for (const [, entry] of remoteMcpClients) {
    if (entry?.abortController) try { entry.abortController.abort(); } catch { }
    if (entry?.transport) try { entry.transport.close(); } catch { }
  }
  remoteMcpClients.clear();
}
