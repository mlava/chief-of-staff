/**
 * local-mcp.js — Local MCP server connection, tool discovery, and supply-chain security.
 *
 * Manages NativeSSETransport (browser-native EventSource), connection lifecycle
 * with exponential backoff, two-stage routing for large servers, schema pinning,
 * and MCP suspension state.
 *
 * Dependency-injected via initLocalMcp(). All external functions/constants
 * accessed through `deps.*`.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";

// ── Constants ───────────────────────────────────────────────────────────────
const LOCAL_MCP_CONNECT_TIMEOUT_MS = 10_000;  // 10s — local servers should be fast
const LOCAL_MCP_INITIAL_BACKOFF_MS = 2_000;   // 2s initial backoff after first failure
const LOCAL_MCP_MAX_BACKOFF_MS = 60_000;      // 60s cap on exponential backoff
const LOCAL_MCP_AUTO_CONNECT_MAX_RETRIES = 5; // max startup retries per port (covers ~62s)
const LOCAL_MCP_DIRECT_TOOL_THRESHOLD = 15;   // servers with ≤15 tools register directly; >15 use meta-tool
const LOCAL_MCP_LIST_TOOLS_TIMEOUT_MS = 5_000; // 5s timeout for listTools call

// ── Module state ────────────────────────────────────────────────────────────
const localMcpClients = new Map(); // port → { client, transport, lastFailureAt, connectPromise, ... }
let localMcpToolsCache = null;     // derived from localMcpClients Map; invalidated on connect/disconnect
const localMcpAutoConnectTimerIds = new Set();
const suspendedMcpServers = new Map(); // serverKey → { newHash, newToolNames, newFingerprints, added, removed, modified, summary, serverName, suspendedAt }

// ── DI deps ─────────────────────────────────────────────────────────────────
let deps = {};

export function initLocalMcp(injected) {
  deps = injected;
}

// ── MCP supply-chain suspension ─────────────────────────────────────────────

export function suspendMcpServer(serverKey, details) {
  suspendedMcpServers.set(serverKey, { ...details, suspendedAt: Date.now() });
  deps.debugLog(`[MCP Security] Server suspended: ${serverKey}`, details.summary);
}

export function unsuspendMcpServer(serverKey, acceptNewPin) {
  const suspension = suspendedMcpServers.get(serverKey);
  if (!suspension) return false;
  if (acceptNewPin) {
    // Accept the new schema — update the stored pin
    const extensionAPI = deps.getExtensionAPI();
    const stored = extensionAPI.settings.get(deps.SETTINGS_KEY_mcpSchemaHashes) || {};
    stored[serverKey] = suspension.newHash;
    stored[`${serverKey}_tools`] = suspension.newToolNames;
    stored[`${serverKey}_fingerprints`] = suspension.newFingerprints;
    extensionAPI.settings.set(deps.SETTINGS_KEY_mcpSchemaHashes, stored);
    deps.debugLog(`[MCP Security] Schema pin updated for ${serverKey}: ${suspension.newHash.slice(0, 12)}…`);
  }
  suspendedMcpServers.delete(serverKey);
  deps.debugLog(`[MCP Security] Server unsuspended: ${serverKey} (accepted: ${acceptNewPin})`);
  return true;
}

export function isServerSuspended(serverKey) {
  return suspendedMcpServers.has(serverKey);
}

/** Resolve a tool invocation to its MCP server key (local:PORT or composio:TOOLKIT). Returns null for non-MCP tools. */
export function getServerKeyForTool(toolName, toolObj, args) {
  // Direct local MCP tool (≤15 tools from that server)
  if (toolObj && toolObj._port) return `local:${toolObj._port}`;
  // LOCAL_MCP_EXECUTE meta-tool (>15 tools, routed)
  if (toolName === "LOCAL_MCP_EXECUTE" && args?.server_name) {
    // Find the port by server name
    for (const [port, entry] of localMcpClients.entries()) {
      if (entry.serverName === args.server_name) return `local:${port}`;
    }
  }
  // LOCAL_MCP_ROUTE meta-tool
  if (toolName === "LOCAL_MCP_ROUTE") return null; // routing tool, not executing — allow
  // Composio tools — extract toolkit key from slug prefix
  if (toolName === "COMPOSIO_MULTI_EXECUTE_TOOL") {
    const slugs = (Array.isArray(args?.tools) ? args.tools : []).map(t => t?.tool_slug).filter(Boolean);
    // All slugs in one call share a toolkit — check the first
    if (slugs.length > 0) {
      const slug = slugs[0];
      // Match against known suspended keys
      for (const key of suspendedMcpServers.keys()) {
        if (key.startsWith("composio:") && slug.startsWith(key.replace("composio:", "") + "_")) return key;
      }
    }
  }
  return null;
}

export function getSuspendedServers() {
  return Array.from(suspendedMcpServers.entries()).map(([key, details]) => ({ serverKey: key, ...details }));
}

// ── Tool discovery ──────────────────────────────────────────────────────────

export function getLocalMcpTools() {
  if (localMcpToolsCache) return localMcpToolsCache;

  const allTools = [];
  const seenNames = new Set();
  for (const [, entry] of localMcpClients) {
    if (!entry?.client || !Array.isArray(entry.tools)) continue;
    for (const tool of entry.tools) {
      if (seenNames.has(tool.name)) continue;
      seenNames.add(tool.name);
      allTools.push(tool);
    }
  }
  localMcpToolsCache = allTools;
  return localMcpToolsCache;
}

/**
 * Build the LOCAL_MCP_EXECUTE meta-tool for large MCP servers.
 * The LLM references tool names from the system prompt and dispatches
 * through this single tool, keeping the registered tool count low.
 */
export function buildLocalMcpMetaTool() {
  return {
    name: "LOCAL_MCP_EXECUTE",
    description: "Execute a tool discovered via LOCAL_MCP_ROUTE. Provide the exact tool_name and its arguments. IMPORTANT: key/ID parameters (e.g. collection_key, item_key) take a single alphanumeric identifier like \"NADHRMVD\" — never a path like \"parent/child\" or a display name.",
    input_schema: {
      type: "object",
      properties: {
        tool_name: { type: "string", description: "Exact tool name returned by LOCAL_MCP_ROUTE" },
        arguments: { type: "object", description: "Arguments for the tool" }
      },
      required: ["tool_name"]
    },
    execute: async (args) => {
      const innerName = args?.tool_name;
      if (!innerName) return { error: "tool_name is required" };
      const tool = (localMcpToolsCache || []).find(t => t.name === innerName);
      if (!tool) return { error: `Tool "${innerName}" not found in local MCP servers` };
      return tool.execute(args.arguments || {});
    }
  };
}

// Compact tool listing for deterministic "what X tools" responses.
// Groups by server, descriptions only (no schemas) to stay concise.
export function formatToolListByServer(tools) {
  const byServer = new Map();
  for (const t of tools) {
    const sn = t._serverName || "unknown";
    if (!byServer.has(sn)) byServer.set(sn, []);
    byServer.get(sn).push(t);
  }
  const sections = [];
  for (const [serverName, serverTools] of byServer) {
    const toolLines = serverTools.map(t => `- **${t.name}**: ${t.description || "(no description)"}`);
    sections.push(`### ${serverName} (${serverTools.length} tools)\n${toolLines.join("\n")}`);
  }
  const totalCount = tools.length;
  const serverCount = byServer.size;
  const header = serverCount === 1
    ? `## ${[...byServer.keys()][0]} — ${totalCount} tools available`
    : `## ${totalCount} tools across ${serverCount} servers`;
  return `${header}\n\n${sections.join("\n\n")}`;
}

// Full tool listing with schemas for LLM tool discovery (LOCAL_MCP_ROUTE).
export function formatServerToolList(tools, serverName) {
  const lines = tools.map(t => {
    const schema = t.input_schema && Object.keys(t.input_schema.properties || {}).length > 0
      ? `\n  Input: ${JSON.stringify(t.input_schema)}`
      : "";
    return `- **${t.name}**: ${t.description || "(no description)"}${schema}`;
  });
  return {
    text: `## ${serverName} — ${tools.length} tools available\n\nCall these via LOCAL_MCP_EXECUTE({ "tool_name": "...", "arguments": {...} }).\n\n${lines.join("\n\n")}`
  };
}

export function buildLocalMcpRouteTool() {
  // Inject available server names into the tool schema so the LLM doesn't have to
  // cross-reference the system prompt to find valid server_name values.
  const cache = localMcpToolsCache || [];
  const routedServers = [...new Set(cache.filter(t => !t._isDirect).map(t => t._serverName))];
  const serverNameDesc = routedServers.length > 0
    ? `Server name. Available servers: ${routedServers.join(", ")}`
    : "Server name from the system prompt";

  return {
    name: "LOCAL_MCP_ROUTE",
    isMutating: false,
    description: "Discover available tools on a local MCP server. Call this FIRST for routed servers to see their tool names, descriptions, and input schemas. Then call LOCAL_MCP_EXECUTE with the specific tool.",
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

      const cache = localMcpToolsCache || [];
      let serverTools = cache.filter(t => t._serverName === serverName && !t._isDirect);

      // Case-insensitive fallback
      if (serverTools.length === 0) {
        const lowerName = serverName.toLowerCase();
        serverTools = cache.filter(t => (t._serverName || "").toLowerCase() === lowerName && !t._isDirect);
      }

      if (serverTools.length === 0) {
        // Check if the server_name matches a DIRECT tool name or server — guide the LLM to call it directly
        const lowerName2 = (serverName || "").toLowerCase();
        const directMatch = cache.find(t => t._isDirect && (
          t.name.toLowerCase() === lowerName2 ||
          (t._serverName || "").toLowerCase() === lowerName2 ||
          (t._serverName || "").toLowerCase().includes(lowerName2)
        ));
        if (directMatch) {
          return { error: `"${serverName}" is a DIRECT tool, not a routed server. Do NOT use LOCAL_MCP_ROUTE for it. Instead, call the tool "${directMatch.name}" directly with its arguments — it is already registered as a callable tool.` };
        }
        const available = [...new Set(cache.filter(t => !t._isDirect).map(t => t._serverName))];
        return { error: `Server "${serverName}" not found. Available routed servers: ${available.join(", ") || "(none)"}` };
      }

      return formatServerToolList(serverTools, serverTools[0]._serverName);
    }
  };
}

// ── NativeSSETransport ──────────────────────────────────────────────────────

export class NativeSSETransport {
  constructor(url) {
    this._url = url;
    this._eventSource = null;
    this._endpoint = null;
    this._protocolVersion = null;
    this._retryTimer = null;
    this.onclose = null;
    this.onerror = null;
    this.onmessage = null;
  }

  setProtocolVersion(version) {
    this._protocolVersion = version;
  }

  start() {
    const MAX_START_ATTEMPTS = 4;
    const START_RETRY_DELAY_MS = 1500;

    return new Promise((resolve, reject) => {
      let resolved = false;
      let attempt = 0;

      const tryConnect = () => {
        attempt++;
        // Clean up previous failed EventSource
        if (this._eventSource) {
          this._eventSource.close();
          this._eventSource = null;
        }

        const es = new EventSource(this._url.toString());
        this._eventSource = es;

        es.addEventListener("endpoint", (e) => {
          try {
            this._endpoint = new URL(e.data, this._url);
          } catch {
            this._endpoint = new URL(e.data);
          }
          if (!resolved) {
            resolved = true;
            resolve();
          }
        });

        es.addEventListener("message", (e) => {
          try {
            const msg = JSON.parse(e.data);
            this.onmessage?.(msg);
          } catch (err) {
            this.onerror?.(new Error(`Failed to parse SSE message: ${err.message}`));
          }
        });

        es.onerror = () => {
          if (!resolved) {
            es.close();
            this._eventSource = null;
            if (attempt < MAX_START_ATTEMPTS) {
              this._retryTimer = setTimeout(tryConnect, START_RETRY_DELAY_MS);
            } else {
              reject(new Error("SSE connection failed to " + this._url));
            }
          } else {
            // Post-connect error: close immediately to prevent zombie EventSource
            // auto-reconnects flooding the console. Our caller's backoff logic
            // handles reconnection on the next getLocalMcpTools() cycle.
            es.close();
            this._eventSource = null;
            this.onclose?.();
          }
        };
      };

      tryConnect();
    });
  }

  async close() {
    if (this._retryTimer) {
      clearTimeout(this._retryTimer);
      this._retryTimer = null;
    }
    if (this._eventSource) {
      this._eventSource.close();
      this._eventSource = null;
    }
    this._endpoint = null;
    this.onclose?.();
  }

  async send(message) {
    if (!this._endpoint) throw new Error("Not connected");
    const headers = { "Content-Type": "application/json" };
    if (this._protocolVersion) {
      headers["mcp-protocol-version"] = this._protocolVersion;
    }
    const resp = await fetch(this._endpoint.toString(), {
      method: "POST",
      headers,
      body: JSON.stringify(message),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`POST ${resp.status}: ${text}`);
    }
  }
}

// ── Connection management ───────────────────────────────────────────────────

export async function connectLocalMcp(port) {
  const existing = localMcpClients.get(port);

  // Already connected — return cached client
  if (existing?.client) return existing.client;

  // Exponential backoff after recent failure: 2s, 4s, 8s, 16s, 32s, 60s (capped)
  if (existing?.lastFailureAt && existing.failureCount > 0) {
    const backoffMs = Math.min(LOCAL_MCP_INITIAL_BACKOFF_MS * Math.pow(2, existing.failureCount - 1), LOCAL_MCP_MAX_BACKOFF_MS);
    if ((Date.now() - existing.lastFailureAt) < backoffMs) {
      deps.debugLog(`[Local MCP] Port ${port} skipped (backoff ${Math.round(backoffMs / 1000)}s after ${existing.failureCount} failure(s))`);
      return null;
    }
  }

  // Dedup in-flight connect
  if (existing?.connectPromise) {
    deps.debugLog(`[Local MCP] Port ${port} connection already in progress`);
    return existing.connectPromise;
  }

  const promise = (async () => {
    let transport = null;
    try {
      const url = new URL(`http://localhost:${port}/sse`);
      transport = new NativeSSETransport(url);
      const client = new Client({ name: `roam-local-mcp-${port}`, version: "0.1.0" });

      let timeoutId = null;
      const connectPromise = client.connect(transport);
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          timeoutId = null;
          reject(new Error(`Local MCP connection timeout on port ${port}`));
        }, LOCAL_MCP_CONNECT_TIMEOUT_MS);
      });

      try {
        await Promise.race([connectPromise, timeoutPromise]);
      } finally {
        if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
      }

      // Capture server metadata from MCP handshake
      const serverVersion = client.getServerVersion?.() || {};
      const serverName = serverVersion.name || `mcp-${port}`;
      const serverDescription = serverVersion.description || client.getInstructions?.() || "";

      // List tools at connection time (cached until reconnect/refresh — no per-loop calls)
      let tools = [];
      try {
        const listPromise = client.listTools();
        let listTimeoutId;
        const listTimeoutPromise = new Promise((_, reject) => {
          listTimeoutId = setTimeout(() => reject(new Error(`listTools timeout on port ${port}`)), LOCAL_MCP_LIST_TOOLS_TIMEOUT_MS);
        });
        let result;
        try {
          result = await Promise.race([listPromise, listTimeoutPromise]);
        } finally {
          clearTimeout(listTimeoutId);
        }
        const serverTools = result?.tools || [];
        const isDirect = serverTools.length <= LOCAL_MCP_DIRECT_TOOL_THRESHOLD;

        for (const t of serverTools) {
          if (!t?.name) continue;
          const boundClient = client;
          const toolName = t.name;
          // Derive isMutating from MCP ToolAnnotations (readOnlyHint, destructiveHint).
          // undefined = no annotation → heuristic fallback in isPotentiallyMutatingTool.
          const annotations = t.annotations || null;
          if (annotations) deps.debugLog(`[Local MCP] Tool ${toolName} annotations:`, annotations);
          let isMutating;
          if (annotations?.readOnlyHint === true) {
            isMutating = false;
          } else if (annotations?.destructiveHint === true || annotations?.readOnlyHint === false) {
            isMutating = true;
          } else {
            isMutating = undefined;
          }
          tools.push({
            name: toolName,
            isMutating,
            description: t.description || "",
            input_schema: t.inputSchema || { type: "object", properties: {} },
            _annotations: annotations,
            _serverName: serverName,
            _serverDescription: serverDescription,
            _port: port,
            _isDirect: isDirect,
            execute: async (args = {}) => {
              // Calendar auto-inject: for event-query tools, if calendarId is missing or invalid,
              // auto-discover all calendars and inject their IDs BEFORE making the call.
              // This prevents LLM failures from bad/missing calendarId on weaker models.
              const CALENDAR_EVENT_TOOLS = ["list-events", "search-events", "get-freebusy"];
              const isCalendarEventTool = CALENDAR_EVENT_TOOLS.includes(toolName);
              if (isCalendarEventTool && !args.calendarId) {
                try {
                  deps.debugLog(`[Local MCP] Calendar auto-inject: ${toolName} called without calendarId, discovering calendars...`);
                  const calResult = await boundClient.callTool({ name: "list-calendars", arguments: {} });
                  const calText = calResult?.content?.[0]?.text;
                  let calendars;
                  if (typeof calText === "string") { try { calendars = JSON.parse(calText); } catch { /* ignore */ } }
                  const ids = (calendars?.calendars || []).map(c => c.id).filter(Boolean);
                  if (ids.length > 0) {
                    deps.debugLog(`[Local MCP] Calendar auto-inject: adding ${ids.length} calendar IDs to ${toolName}`);
                    args = { ...args, calendarId: ids };
                  }
                } catch (injectErr) {
                  deps.debugLog(`[Local MCP] Calendar auto-inject failed:`, injectErr?.message);
                }
              }
              try {
                const result = await boundClient.callTool({ name: toolName, arguments: args });
                const text = result?.content?.[0]?.text;
                if (typeof text === "string") {
                  // If the result is a calendar error about bad IDs, retry with discovered IDs
                  if (isCalendarEventTool && /MCP error|calendar\(s\)\s*not\s*found/i.test(text)) {
                    try {
                      deps.debugLog(`[Local MCP] Calendar retry: ${toolName} returned error, re-discovering calendars...`);
                      const calResult = await boundClient.callTool({ name: "list-calendars", arguments: {} });
                      const calText = calResult?.content?.[0]?.text;
                      let calendars;
                      if (typeof calText === "string") { try { calendars = JSON.parse(calText); } catch { /* ignore */ } }
                      const ids = (calendars?.calendars || []).map(c => c.id).filter(Boolean);
                      if (ids.length > 0) {
                        deps.debugLog(`[Local MCP] Calendar retry: retrying ${toolName} with ${ids.length} fresh calendar IDs`);
                        const retryResult = await boundClient.callTool({ name: toolName, arguments: { ...args, calendarId: ids } });
                        const retryText = retryResult?.content?.[0]?.text;
                        if (typeof retryText === "string") {
                          try { return JSON.parse(retryText); } catch { return { text: retryText }; }
                        }
                        return retryResult;
                      }
                    } catch (retryErr) {
                      deps.debugLog(`[Local MCP] Calendar retry failed:`, retryErr?.message);
                    }
                  }
                  try { return JSON.parse(text); } catch { return { text }; }
                }
                return result;
              } catch (e) {
                const errMsg = e?.message || `Failed: ${toolName}`;
                return { error: errMsg };
              }
            }
          });
        }
        deps.debugLog(`[Local MCP] Discovered ${serverTools.length} tools from port ${port} (server: ${serverName})`);
      } catch (e) {
        console.warn(`[Local MCP] listTools failed at connect for port ${port}:`, e?.message);
      }

      // ─── MCP Supply Chain Hardening (scan → pin → BOM) ───
      const flaggedTools = deps.scanToolDescriptions(tools, serverName);
      let pinResult = { status: "skipped" };
      try {
        pinResult = await deps.checkSchemaPin(`local:${port}`, tools, serverName);
      } catch (e) {
        deps.debugLog(`[MCP Security] Schema pin failed for port ${port}:`, e?.message);
      }
      try {
        await deps.updateMcpBom(`local:${port}`, serverName, serverDescription, tools, pinResult, flaggedTools);
      } catch (e) {
        deps.debugLog(`[MCP BOM] BOM update failed for port ${port}:`, e?.message);
      }
      // ─── End MCP Supply Chain Hardening ───

      // Pre-compute server name fragments and regex patterns for fast prompt matching (L7).
      // These patterns are stable for the lifetime of the connection.
      const _nameFragments = serverName
        ? serverName.toLowerCase().split(/[-_]/).filter(p => p.length > 3).map(part => {
          const escaped = part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          try { return new RegExp(`\\b${escaped}\\b`); } catch { return null; }
        }).filter(Boolean)
        : [];
      localMcpClients.set(port, { client, transport, lastFailureAt: 0, failureCount: 0, connectPromise: null, serverName, serverDescription, tools, _nameFragments });
      localMcpToolsCache = null; // invalidate so getLocalMcpTools() rebuilds from Map
      deps.debugLog(`[Local MCP] Connected to port ${port} — server: ${serverName}`);
      deps.showInfoToast("Local MCP connected", `${serverName} (port ${port}) — ${tools.length} tool${tools.length !== 1 ? "s" : ""} available.`);
      return client;
    } catch (error) {
      // Close client and transport to prevent orphaned state and EventSource zombie connections
      if (transport) try { await transport.close(); } catch { }
      const prevCount = localMcpClients.get(port)?.failureCount || 0;
      console.warn(`[Local MCP] Failed to connect to port ${port} (attempt ${prevCount + 1}):`, error?.message);
      localMcpClients.set(port, { client: null, transport: null, lastFailureAt: Date.now(), failureCount: prevCount + 1, connectPromise: null, serverName: null, serverDescription: "" });
      return null;
    } finally {
      const entry = localMcpClients.get(port);
      if (entry) entry.connectPromise = null;
    }
  })();

  // Store in-flight promise immediately for deduplication
  const entry = localMcpClients.get(port) || { client: null, transport: null, lastFailureAt: 0, failureCount: 0, connectPromise: null };
  entry.connectPromise = promise;
  localMcpClients.set(port, entry);

  return promise;
}

export async function disconnectLocalMcp(port) {
  const entry = localMcpClients.get(port);
  if (!entry) { localMcpClients.delete(port); return; }
  try {
    if (entry.client) await entry.client.close();
    // Safety net: close transport directly in case client.close() didn't
    if (entry.transport) await entry.transport.close().catch(() => { });
    deps.debugLog(`[Local MCP] Disconnected from port ${port}`);
  } catch (error) {
    console.warn(`[Local MCP] Error disconnecting port ${port}:`, error?.message);
  } finally {
    localMcpClients.delete(port);
    localMcpToolsCache = null; // invalidate so getLocalMcpTools() rebuilds from Map
  }
}

export async function disconnectAllLocalMcp() {
  const ports = [...localMcpClients.keys()];
  await Promise.allSettled(ports.map(port => disconnectLocalMcp(port)));
  localMcpToolsCache = null;
}

export function scheduleLocalMcpAutoConnect() {
  const ports = deps.getLocalMcpPorts();
  if (!ports.length) return;

  const connectWithRetry = (port, attempt) => {
    if (deps.isUnloadInProgress() || deps.getExtensionAPI() === null) return;
    if (attempt > LOCAL_MCP_AUTO_CONNECT_MAX_RETRIES) {
      deps.debugLog(`[Local MCP] Auto-connect gave up on port ${port} after ${LOCAL_MCP_AUTO_CONNECT_MAX_RETRIES} retries`);
      deps.showErrorToast("Local MCP failed", `Could not connect to MCP server on port ${port} after ${LOCAL_MCP_AUTO_CONNECT_MAX_RETRIES} retries. Check that the server is running, then use "Refresh Local MCP Servers" to retry.`);
      return;
    }

    // Clear stale failure state so connectLocalMcp doesn't skip via backoff
    const stale = localMcpClients.get(port);
    if (stale && !stale.client) localMcpClients.delete(port);

    connectLocalMcp(port).then(client => {
      if (client) return; // success
      const delay = Math.min(LOCAL_MCP_INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1), LOCAL_MCP_MAX_BACKOFF_MS);
      deps.debugLog(`[Local MCP] Auto-connect retry for port ${port} in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${LOCAL_MCP_AUTO_CONNECT_MAX_RETRIES})`);
      const tid = window.setTimeout(() => { localMcpAutoConnectTimerIds.delete(tid); connectWithRetry(port, attempt + 1); }, delay);
      localMcpAutoConnectTimerIds.add(tid);
    }).catch(e => {
      deps.debugLog(`[Local MCP] Auto-connect failed for port ${port}:`, e?.message);
      const delay = Math.min(LOCAL_MCP_INITIAL_BACKOFF_MS * Math.pow(2, attempt - 1), LOCAL_MCP_MAX_BACKOFF_MS);
      const tid = window.setTimeout(() => { localMcpAutoConnectTimerIds.delete(tid); connectWithRetry(port, attempt + 1); }, delay);
      localMcpAutoConnectTimerIds.add(tid);
    });
  };

  const initialTid = window.setTimeout(() => {
    localMcpAutoConnectTimerIds.delete(initialTid);
    if (deps.isUnloadInProgress() || deps.getExtensionAPI() === null) return;
    ports.forEach(port => connectWithRetry(port, 1));
  }, deps.COMPOSIO_AUTO_CONNECT_DELAY_MS + 500);
  localMcpAutoConnectTimerIds.add(initialTid);
}

// ── State accessors (for DI into other modules & cleanup) ───────────────────

export function getLocalMcpClients() {
  return localMcpClients;
}

export function getLocalMcpToolsCache() {
  return localMcpToolsCache;
}

export function invalidateLocalMcpToolsCache() {
  localMcpToolsCache = null;
}

/** Called from onunload to clean up all local MCP state. */
export function cleanupLocalMcp() {
  localMcpToolsCache = null;
  localMcpAutoConnectTimerIds.forEach(id => clearTimeout(id));
  localMcpAutoConnectTimerIds.clear();
  suspendedMcpServers.clear();
}
