// =============================================================================
// composio-ui.js — Composio UI Layer
// =============================================================================
// Extracted from index.js following the DI pattern from composio-mcp.js.
// Handles Composio connection lifecycle (connect, disconnect, reconnect),
// tool installation/deregistration, auth polling, proxy validation, and
// auto-connect scheduling.
// =============================================================================

import {
  normaliseInstalledToolRecord,
  normaliseToolSlugToken,
  normaliseToolkitSlug,
  mapComposioStatusToInstallState,
  extractAuthRedirectUrls,
  clearAuthPollForSlug,
  getToolsConfigState,
  saveToolsConfigState,
  resolveComposioToolkitSlugForInstall,
  mergeComposioToolkitCatalogSlugs,
  inferToolkitFromSlug,
  discoverToolkitSchema,
  discoverAllConnectedToolkitSchemas,
} from "./composio-mcp.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

let deps = {};

export function initComposioUi(injected) {
  deps = injected;
}

// ═══════════════════════════════════════════════════════════════════════
// Module-scoped state (moved from index.js)
// ═══════════════════════════════════════════════════════════════════════

let installedToolsFetchCache = { data: null, expiresAt: 0, promise: null };
let connectInFlightPromise = null;
let composioLastFailureAt = 0;
let composioTransportAbortController = null;
let reconcileInFlightPromise = null;
let composioAutoConnectTimeoutId = null;
let startupAuthPollTimeoutIds = [];

// ═══════════════════════════════════════════════════════════════════════
// State accessors — used by index.js for runtime stats and cleanup
// ═══════════════════════════════════════════════════════════════════════

export function getComposioUiState() {
  return {
    connectInFlight: Boolean(connectInFlightPromise),
    autoConnectTimerPending: Boolean(composioAutoConnectTimeoutId),
    startupAuthPollTimeouts: startupAuthPollTimeoutIds.length,
  };
}

/**
 * Reset module-scoped state during extension unload.
 * Mirrors the direct variable nulling that index.js onunload() previously did.
 */
export function resetComposioUiState() {
  reconcileInFlightPromise = null;
  invalidateInstalledToolsFetchCache();
}

/**
 * Returns the in-flight connect promise (for onunload await/cleanup).
 * Also clears the local reference if requested.
 */
export function getConnectInFlightPromise({ clear = false } = {}) {
  const p = connectInFlightPromise;
  if (clear) connectInFlightPromise = null;
  return p;
}

// ═══════════════════════════════════════════════════════════════════════
// Installed tool fetch helpers
// ═══════════════════════════════════════════════════════════════════════

function extractInstalledToolRecordsFromResponse(response) {
  const text = response?.content?.[0]?.text;
  if (typeof text !== "string") return [];

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return [];
  }

  const installedTools = [];
  const seenSlugs = new Set();
  const queue = [parsed];
  let visited = 0;
  while (queue.length && visited < deps.COMPOSIO_INSTALLED_TOOLS_BFS_MAX_NODES) {
    visited += 1;
    const current = queue.shift();
    if (!current || typeof current !== "object") continue;

    const slugCandidates = [
      current.toolkit_slug,
      current.tool_slug,
      current.toolkit,
      current.app
    ];
    const labelCandidates = [
      current.toolkit_name,
      current.tool_name,
      current.app_name,
      current.label
    ];
    const connectionId = typeof current.id === "string" ? current.id : "";
    const installState = mapComposioStatusToInstallState(current.status);

    const slug = slugCandidates.find((value) => typeof value === "string" && value.trim());
    const label = labelCandidates.find((value) => typeof value === "string" && value.trim());
    if (slug && !seenSlugs.has(slug)) {
      seenSlugs.add(slug);
      installedTools.push(
        normaliseInstalledToolRecord({
          slug,
          label: label || slug,
          installState,
          connectionId
        })
      );
    }

    Object.values(current).forEach((value) => {
      if (Array.isArray(value)) value.forEach((item) => queue.push(item));
      else if (value && typeof value === "object") queue.push(value);
    });
  }
  if (queue.length > 0) {
    deps.debugLog("[Chief of Staff] Installed tools BFS capped:", {
      maxNodes: deps.COMPOSIO_INSTALLED_TOOLS_BFS_MAX_NODES
    });
  }

  return installedTools.filter(Boolean);
}

function composioCallLooksSuccessful(result) {
  const text = result?.content?.[0]?.text;
  if (typeof text !== "string") return true;
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    parsed = null;
  }
  if (parsed && typeof parsed === "object") {
    if (parsed.success === false || parsed.successful === false) return false;
    if (parsed.error && String(parsed.error).trim()) return false;
  }
  const lowered = text.toLowerCase();
  if (lowered.includes("\"success\":false")) return false;
  if (lowered.includes("\"successful\":false")) return false;
  if (lowered.includes("\"error\":") && !lowered.includes("\"error\":null")) return false;
  return true;
}

export function invalidateInstalledToolsFetchCache() {
  installedToolsFetchCache.expiresAt = 0;
  installedToolsFetchCache.promise = null;
  installedToolsFetchCache.data = null;
}

async function fetchInstalledToolsFromComposio(clientOverride = null) {
  const client = clientOverride || deps.getMcpClient();
  if (!client?.callTool) return [];

  const probes = [
    { name: "COMPOSIO_GET_CONNECTED_ACCOUNTS", arguments: {} },
    { name: "COMPOSIO_MANAGE_CONNECTIONS", arguments: { action: "list" } }
  ];

  for (const probe of probes) {
    try {
      const result = await client.callTool(probe);
      const records = extractInstalledToolRecordsFromResponse(result);
      if (records.length > 0) return records;
    } catch (error) {
      continue;
    }
  }
  return [];
}

async function fetchInstalledToolsFromComposioCached(clientOverride = null, options = {}) {
  const { ttlMs = 8000, force = false } = options;
  const now = Date.now();
  if (!force && Array.isArray(installedToolsFetchCache.data) && installedToolsFetchCache.expiresAt > now) {
    return installedToolsFetchCache.data;
  }
  if (!force && installedToolsFetchCache.promise) {
    return installedToolsFetchCache.promise;
  }

  installedToolsFetchCache.promise = fetchInstalledToolsFromComposio(clientOverride)
    .then((records) => {
      installedToolsFetchCache.data = Array.isArray(records) ? records : [];
      installedToolsFetchCache.expiresAt = Date.now() + Math.max(1000, Number(ttlMs) || 8000);
      installedToolsFetchCache.promise = null;
      return installedToolsFetchCache.data;
    })
    .catch((error) => {
      installedToolsFetchCache.promise = null;
      throw error;
    });
  return installedToolsFetchCache.promise;
}

async function checkToolConnectedViaComposio(client, toolSlug, options = {}) {
  const {
    logProbeResponses = false,
    remoteInstalledTools: remoteInstalledToolsOverride = null
  } = options;
  if (!client?.callTool || !toolSlug) return false;

  const remoteInstalledTools = Array.isArray(remoteInstalledToolsOverride)
    ? remoteInstalledToolsOverride
    : await fetchInstalledToolsFromComposio(client);
  const normalisedTarget = normaliseToolSlugToken(toolSlug);
  if (remoteInstalledTools.length) {
    const matchingRecord = remoteInstalledTools.find(
      (tool) => normaliseToolSlugToken(tool?.slug) === normalisedTarget
    );
    if (!matchingRecord) return false;
    return matchingRecord.installState === "installed";
  }

  try {
    const probe = {
      name: "COMPOSIO_MANAGE_CONNECTIONS",
      arguments: { action: "list", toolkits: [toolSlug] }
    };
    const result = await client.callTool(probe);
    const records = extractInstalledToolRecordsFromResponse(result);
    const matchingRecord = records.find(
      (tool) => normaliseToolSlugToken(tool?.slug) === normalisedTarget
    );
    if (logProbeResponses) {
      deps.debugLog("[Chief of Staff] Composio tool-check meta:", {
        toolSlug,
        recordCount: records.length,
        hasMatch: Boolean(matchingRecord),
        installState: matchingRecord?.installState || "unknown"
      });
    }
    if (!matchingRecord) return false;
    return matchingRecord.installState === "installed";
  } catch (error) {
    return false;
  }
}

export async function reconcileInstalledToolsWithComposio(extensionAPI) {
  if (reconcileInFlightPromise) return reconcileInFlightPromise;
  reconcileInFlightPromise = (async () => {
    try {
      const remoteInstalledTools = await fetchInstalledToolsFromComposio();
      if (!remoteInstalledTools.length) return getToolsConfigState(extensionAPI);

      const currentState = getToolsConfigState(extensionAPI);
      const now = Date.now();
      const bySlug = new Map(currentState.installedTools.map((tool) => [tool.slug, tool]));

      remoteInstalledTools.forEach((remoteTool) => {
        const existing = bySlug.get(remoteTool.slug);
        bySlug.set(remoteTool.slug, {
          ...(existing || {}),
          ...remoteTool,
          enabled: existing?.enabled !== false,
          installState: remoteTool.installState || existing?.installState || "installed",
          lastError:
            remoteTool.installState === "failed"
              ? remoteTool.lastError || existing?.lastError || "Composio reported a failed status"
              : "",
          updatedAt: now
        });
      });

      const nextState = {
        ...currentState,
        schemaVersion: deps.TOOLS_SCHEMA_VERSION,
        installedTools: Array.from(bySlug.values())
      };
      saveToolsConfigState(extensionAPI, nextState);
      return nextState;
    } finally {
      reconcileInFlightPromise = null;
    }
  })();
  return reconcileInFlightPromise;
}

// ═══════════════════════════════════════════════════════════════════════
// Connection lifecycle
// ═══════════════════════════════════════════════════════════════════════

export async function connectComposio(extensionAPI, options = {}) {
  const { suppressConnectedToast = false } = options;
  if (deps.getMcpClient()) {
    deps.debugLog("Composio client already connected.");
    return deps.getMcpClient();
  }
  // Backoff after recent failure to avoid hammering a down server
  if (composioLastFailureAt && (Date.now() - composioLastFailureAt) < deps.COMPOSIO_CONNECT_BACKOFF_MS) {
    deps.debugLog("Composio connect skipped (backoff after recent failure).");
    return null;
  }
  if (connectInFlightPromise) {
    deps.debugLog("Composio connection already in progress.");
    // Wait for in-flight connection and return its result
    const result = await connectInFlightPromise;
    return result; // Will be mcpClient or null
  }

  const promise = (async () => {
    let transport = null;
    let client = null;
    try {
      const composioMcpUrl = deps.getSettingString(
        extensionAPI,
        deps.SETTINGS_KEYS.composioMcpUrl,
        ""
      );
      const composioApiKey = deps.getSettingString(
        extensionAPI,
        deps.SETTINGS_KEYS.composioApiKey,
        ""
      );
      // Block connection if settings still contain placeholder defaults or are blank
      if (!composioMcpUrl || composioMcpUrl === deps.DEFAULT_COMPOSIO_MCP_URL
          || !composioApiKey || composioApiKey === deps.DEFAULT_COMPOSIO_API_KEY) {
        deps.debugLog("Composio connect skipped — MCP URL or API key not configured.");
        return null;
      }
      const safeApiKey = deps.sanitizeHeaderValue(composioApiKey);
      const headers = { "x-api-key": safeApiKey };

      // Derive proxy base: strip any path so we can prepend it to the session MCP URL.
      // Setting should now be just the proxy root, e.g. https://roam-mcp-proxy.foo.workers.dev
      const proxyBase = composioMcpUrl.replace(/\/+$/, "");

      // Create a tool-router session to obtain the dynamic MCP endpoint URL.
      deps.debugLog("[Chief flow] Creating Composio tool-router session...");
      const sessionRes = await fetch(
        `${proxyBase}/https://backend.composio.dev/api/v3/tool_router/session`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": safeApiKey },
          body: JSON.stringify({ user_id: "user_roam" })
        }
      );
      if (!sessionRes.ok) {
        throw new Error(`Composio session creation failed: ${sessionRes.status} ${sessionRes.statusText}`);
      }
      const sessionData = await sessionRes.json();
      const sessionMcpUrl = sessionData?.mcp?.url;
      if (!sessionMcpUrl) {
        throw new Error("Composio session response missing mcp.url");
      }
      // Route the session MCP URL through the proxy (backend.composio.dev is CORS-blocked).
      const proxiedMcpUrl = `${proxyBase}/${sessionMcpUrl.replace(/^https?:\/\//, "https://")}`;
      deps.debugLog("[Chief flow] Composio session MCP URL:", proxiedMcpUrl);

      composioTransportAbortController = new AbortController();

      const transportFetch = async (input, init = {}) => {
        return fetch(input, { ...init, signal: composioTransportAbortController?.signal });
      };

      transport = new StreamableHTTPClientTransport(
        new URL(proxiedMcpUrl),
        {
          fetch: transportFetch,
          requestInit: {
            headers
          },
          // Suppress automatic SSE GET reconnection loop. The SDK opens a GET SSE
          // listener after connect and reconnects every ~2s when the proxy closes
          // the stream. Composio doesn't push server-initiated messages, so the
          // listener is unnecessary. maxRetries: 0 lets the initial GET fire once
          // (harmless) but prevents the infinite reconnection cycle.
          reconnectionOptions: {
            initialReconnectionDelay: 1000,
            maxReconnectionDelay: 30000,
            reconnectionDelayGrowFactor: 1.5,
            maxRetries: 0
          }
        }
      );

      client = new Client({
        name: "roam-mcp-client",
        version: "0.1.0"
      });

      // Add timeout to prevent indefinite hang
      let timeoutId = null;
      const connectPromise = client.connect(transport);
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          timeoutId = null;
          reject(new Error("MCP connection timeout after 30 seconds"));
        }, deps.COMPOSIO_MCP_CONNECT_TIMEOUT_MS);
      });

      try {
        await Promise.race([connectPromise, timeoutPromise]);
      } finally {
        // Clear timeout if connection succeeded before timeout fired
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
      }
      deps.setMcpClient(client);
      composioLastFailureAt = 0;
      invalidateInstalledToolsFetchCache();
      deps.debugLog("Connected to Composio!");
      if (!suppressConnectedToast) deps.showConnectedToast();
      await reconcileInstalledToolsWithComposio(extensionAPI);
      // Discover schemas for all connected toolkits in background
      discoverAllConnectedToolkitSchemas(extensionAPI).catch(e => {
        deps.debugLog("[Chief flow] Post-connect schema discovery failed:", e?.message);
      });

      return deps.getMcpClient();
    } catch (error) {
      deps.setMcpClient(null);
      composioLastFailureAt = Date.now();
      // Close client and transport to prevent resource leaks on failure/timeout
      if (client) try { await client.close(); } catch { }
      if (transport) try { await transport.close(); } catch { }
      if (composioTransportAbortController) {
        composioTransportAbortController.abort();
        composioTransportAbortController = null;
      }
      console.error("Failed to connect to Composio:", deps.redactForLog(String(error)));
      return null;
    } finally {
      connectInFlightPromise = null;
    }
  })();

  // Assign immediately so concurrent callers see the in-flight promise
  connectInFlightPromise = promise;
  return promise;
}

export function shouldAttemptComposioAutoConnect(extensionAPI) {
  const composioMcpUrl = deps.getSettingString(
    extensionAPI,
    deps.SETTINGS_KEYS.composioMcpUrl,
    deps.DEFAULT_COMPOSIO_MCP_URL
  );
  const composioApiKey = deps.getSettingString(
    extensionAPI,
    deps.SETTINGS_KEYS.composioApiKey,
    deps.DEFAULT_COMPOSIO_API_KEY
  );
  const hasRealUrl =
    composioMcpUrl &&
    composioMcpUrl !== deps.DEFAULT_COMPOSIO_MCP_URL &&
    /^https?:\/\//i.test(composioMcpUrl);
  const hasRealKey =
    composioApiKey &&
    composioApiKey !== deps.DEFAULT_COMPOSIO_API_KEY &&
    composioApiKey.length > 8;
  return Boolean(hasRealUrl && hasRealKey);
}

export function clearStartupAuthPollTimers() {
  while (startupAuthPollTimeoutIds.length) {
    const timeoutId = startupAuthPollTimeoutIds.pop();
    window.clearTimeout(timeoutId);
  }
}

export function clearComposioAutoConnectTimer() {
  if (!composioAutoConnectTimeoutId) return;
  window.clearTimeout(composioAutoConnectTimeoutId);
  composioAutoConnectTimeoutId = null;
}

export function scheduleComposioAutoConnect(extensionAPI) {
  clearComposioAutoConnectTimer();
  if (!shouldAttemptComposioAutoConnect(extensionAPI)) return;
  composioAutoConnectTimeoutId = window.setTimeout(() => {
    composioAutoConnectTimeoutId = null;
    connectComposio(extensionAPI, { suppressConnectedToast: true });
  }, deps.COMPOSIO_AUTO_CONNECT_DELAY_MS);
}

export async function disconnectComposio(options = {}) {
  const { suppressDisconnectedToast = false } = options;
  if (connectInFlightPromise) {
    deps.debugLog("Composio connection is in progress; try again in a moment.");
    return;
  }
  if (!deps.getMcpClient()) {
    deps.debugLog("No active Composio client to disconnect.");
    return;
  }
  try {
    await deps.getMcpClient().close();
    deps.debugLog("Disconnected from Composio.");
    if (!suppressDisconnectedToast) deps.showDisconnectedToast();
  } catch (error) {
    console.error("Failed to disconnect from Composio:", deps.redactForLog(String(error)));
  } finally {
    deps.setMcpClient(null);
    if (composioTransportAbortController) {
      composioTransportAbortController.abort();
      composioTransportAbortController = null;
    }
    invalidateInstalledToolsFetchCache();
  }
}

export async function reconnectComposio(extensionAPI) {
  if (connectInFlightPromise) {
    deps.debugLog("Composio connection is in progress; try again in a moment.");
    deps.showInfoToast("Reconnect pending", "Composio connection is already in progress. Try again in a moment.");
    return;
  }
  await disconnectComposio({ suppressDisconnectedToast: true });
  const client = await connectComposio(extensionAPI, { suppressConnectedToast: true });
  if (client) deps.showReconnectedToast();
}

// ═══════════════════════════════════════════════════════════════════════
// Tool upsert & auth polling
// ═══════════════════════════════════════════════════════════════════════

function upsertInstalledTool(extensionAPI, toolRecord) {
  const normalised = normaliseInstalledToolRecord(toolRecord);
  if (!normalised) return;
  const state = getToolsConfigState(extensionAPI);
  const bySlug = new Map(state.installedTools.map((tool) => [tool.slug, tool]));
  const existing = bySlug.get(normalised.slug);
  bySlug.set(normalised.slug, {
    ...(existing || {}),
    ...normalised,
    updatedAt: Date.now()
  });
  saveToolsConfigState(extensionAPI, {
    ...state,
    installedTools: Array.from(bySlug.values())
  });
}

export function startToolAuthPolling(extensionAPI, toolSlug) {
  const key = String(toolSlug || "").trim().toUpperCase();
  if (!key) return;
  clearAuthPollForSlug(key);

  const pollState = {
    running: false,
    stopped: false,
    timeoutId: null,
    hardTimeoutId: null
  };

  const scheduleNextPoll = () => {
    if (pollState.stopped) return;
    pollState.timeoutId = window.setTimeout(runPoll, deps.AUTH_POLL_INTERVAL_MS);
  };

  const runPoll = async () => {
    if (pollState.running || pollState.stopped) return;
    pollState.running = true;
    try {
      // Check stopped before async work
      if (pollState.stopped) return;
      const client = deps.getMcpClient() || await connectComposio(extensionAPI, { suppressConnectedToast: true });
      // Check again after async operation
      if (pollState.stopped || !client?.callTool) return;
      deps.debugLog("[Chief of Staff] Auth poll tick:", key);
      const remoteInstalledTools = await fetchInstalledToolsFromComposioCached(client, {
        ttlMs: deps.COMPOSIO_AUTH_POLL_REMOTE_CACHE_TTL_MS
      });
      // Check after fetch
      if (pollState.stopped) return;
      const isConnected = await checkToolConnectedViaComposio(client, key, {
        logProbeResponses: false,
        remoteInstalledTools
      });
      // Check after check
      if (pollState.stopped || !isConnected) return;

      upsertInstalledTool(extensionAPI, {
        slug: key,
        label: key,
        installState: "installed",
        lastError: ""
      });
      deps.showInfoToast("Authentication complete", `${key} is now connected and ready.`);
      clearAuthPollForSlug(key);
      // Discover toolkit schemas in background
      discoverToolkitSchema(inferToolkitFromSlug(key), { force: true }).catch(e => { deps.debugLog("[Chief flow] Post-auth schema discovery failed:", key, e?.message); });
    } catch (error) {
      console.error("[Chief of Staff] Auth poll error:", { toolSlug: key, error: deps.redactForLog(String(error)) });
    } finally {
      pollState.running = false;
      // Don't schedule next poll if stopped
      if (!pollState.stopped) {
        scheduleNextPoll();
      }
    }
  };

  pollState.hardTimeoutId = window.setTimeout(() => {
    pollState.stopped = true;
    upsertInstalledTool(extensionAPI, {
      slug: key,
      label: key,
      installState: "pending_auth",
      lastError: "Timed out waiting for authentication completion"
    });
    deps.showInfoToast("Authentication pending", `${key} is still waiting for completion. Use refresh to re-check.`);
    clearAuthPollForSlug(key);
  }, deps.AUTH_POLL_TIMEOUT_MS);

  deps.getAuthPollStateBySlug().set(key, pollState);
  runPoll();
}

// ═══════════════════════════════════════════════════════════════════════
// Tool installation & deregistration
// ═══════════════════════════════════════════════════════════════════════

export async function installComposioTool(extensionAPI, requestedSlug) {
  const toolSlug = normaliseToolkitSlug(requestedSlug);
  if (!toolSlug) {
    deps.showInfoToast("Install cancelled", "No tool slug entered.");
    return;
  }

  const client = await connectComposio(extensionAPI, { suppressConnectedToast: true });
  if (!client?.callTool) {
    deps.showErrorToast("Install failed", "Composio is not connected.");
    return;
  }

  const resolution = await resolveComposioToolkitSlugForInstall(client, toolSlug, extensionAPI);
  const installSlug = resolution?.resolvedSlug || toolSlug;
  const suggestions = Array.isArray(resolution?.suggestions) ? resolution.suggestions : [];
  mergeComposioToolkitCatalogSlugs(extensionAPI, [toolSlug, installSlug], { touchFetchedAt: false });
  if (installSlug !== toolSlug) {
    deps.showInfoToast("Slug resolved", `Using ${installSlug} for requested ${toolSlug}.`);
  } else if (suggestions.length > 0 && !suggestions.includes(toolSlug)) {
    const hint = suggestions.slice(0, 5).join(", ");
    deps.showInfoToast("Possible slug mismatch", `Closest known toolkit slugs: ${hint}`);
  }

  try {
    const installResult = await client.callTool({
      name: "COMPOSIO_MANAGE_CONNECTIONS",
      arguments: {
        toolkits: [installSlug]
      }
    });
    const authUrls = extractAuthRedirectUrls(installResult);
    const installRecords = extractInstalledToolRecordsFromResponse(installResult);
    deps.debugLog("[Chief of Staff] Composio install meta:", {
      toolSlug: installSlug,
      authRedirectCount: authUrls.length,
      recordCount: installRecords.length
    });
    if (authUrls.length > 0) {
      upsertInstalledTool(extensionAPI, {
        slug: installSlug,
        label: installSlug,
        installState: "pending_auth",
        lastError: ""
      });
      authUrls.forEach((url) => {
        const opened = window.open(url, "_blank", "noopener,noreferrer");
        if (!opened) {
          deps.showInfoToast("Auth required", `Open this link to finish ${installSlug}: ${url}`);
        }
      });
      deps.showInfoToast("Authentication required", `Finish ${installSlug} setup in the opened tab.`);
      invalidateInstalledToolsFetchCache();
      startToolAuthPolling(extensionAPI, installSlug);
      return;
    }

    invalidateInstalledToolsFetchCache();
    await reconcileInstalledToolsWithComposio(extensionAPI);
    upsertInstalledTool(extensionAPI, {
      slug: installSlug,
      label: installSlug,
      installState: "installed",
      lastError: ""
    });
    deps.showConnectedToast();
    deps.showInfoToast("Tool installed", `${installSlug} is now available.`);
    // Discover toolkit schemas in background (non-blocking)
    discoverToolkitSchema(inferToolkitFromSlug(installSlug)).catch(e => { deps.debugLog("[Chief flow] Post-install schema discovery failed:", installSlug, e?.message); });
  } catch (error) {
    upsertInstalledTool(extensionAPI, {
      slug: installSlug,
      label: installSlug,
      installState: "failed",
      lastError: error?.message || "Unknown install error"
    });
    deps.showErrorToast("Install failed", `Could not install ${installSlug}.`);
    console.error("Failed to install Composio tool:", deps.redactForLog(String(error)));
  }
}

export async function promptInstallComposioTool(extensionAPI) {
  const toolSlug = await deps.promptToolSlugWithToast("");
  if (!toolSlug) {
    deps.showInfoToast("Install cancelled", "No tool slug entered.");
    return;
  }
  await installComposioTool(extensionAPI, toolSlug);
}

export async function promptDeregisterComposioTool(extensionAPI) {
  const client = await connectComposio(extensionAPI, { suppressConnectedToast: true });
  if (!client?.callTool) {
    deps.showErrorToast("Deregister failed", "Composio is not connected.");
    return;
  }

  await reconcileInstalledToolsWithComposio(extensionAPI);
  const state = getToolsConfigState(extensionAPI);
  const removableTools = state.installedTools
    .filter((tool) => tool.installState === "installed" || tool.installState === "pending_auth")
    .map((tool) => ({
      ...tool,
      label:
        tool.installState === "pending_auth"
          ? `${tool.label || tool.slug} (pending auth)`
          : (tool.label || tool.slug)
    }));
  if (!removableTools.length) {
    deps.showInfoToast("Nothing to deregister", "No installed or pending-auth tools found.");
    return;
  }

  const toolSlug = await deps.promptInstalledToolSlugWithToast(removableTools, {
    title: "Deregister Composio Tool",
    confirmLabel: "Uninstall"
  });
  if (!toolSlug) {
    deps.showInfoToast("Deregister cancelled", "No tool selected.");
    return;
  }
  await deregisterComposioTool(extensionAPI, toolSlug);
}

async function testComposioToolConnection(extensionAPI, requestedSlug) {
  const toolSlug = (requestedSlug || "").trim().toUpperCase();
  if (!toolSlug) {
    deps.showInfoToast("Test cancelled", "No tool selected.");
    return;
  }

  const client = await connectComposio(extensionAPI, { suppressConnectedToast: true });
  if (!client?.callTool) {
    deps.showErrorToast("Test failed", "Composio is not connected.");
    return;
  }

  const isConnected = await checkToolConnectedViaComposio(client, toolSlug);

  if (isConnected) {
    deps.showInfoToast("Tool connected", `${toolSlug} is reachable. Composio session is connected.`);
  } else {
    const localState = getToolsConfigState(extensionAPI);
    const hasLocalInstalledRecord = localState.installedTools.some(
      (tool) =>
        normaliseToolSlugToken(tool?.slug) === normaliseToolSlugToken(toolSlug) &&
        tool.installState === "installed"
    );

    if (hasLocalInstalledRecord) {
      deps.showInfoToast(
        "Connection uncertain",
        `${toolSlug} is marked installed locally, but Composio did not return a definitive match.`
      );
      return;
    }
    deps.showErrorToast("Test failed", `${toolSlug} was not found in connected Composio tools.`);
  }
}

export async function promptTestComposioTool(extensionAPI) {
  const client = await connectComposio(extensionAPI, { suppressConnectedToast: true });
  if (!client?.callTool) {
    deps.showErrorToast("Test failed", "Composio is not connected.");
    return;
  }

  const localStateBeforeReconcile = getToolsConfigState(extensionAPI);
  await reconcileInstalledToolsWithComposio(extensionAPI);
  const state = getToolsConfigState(extensionAPI);

  const bySlug = new Map();
  [...localStateBeforeReconcile.installedTools, ...state.installedTools].forEach((tool) => {
    if (!tool?.slug) return;
    bySlug.set(tool.slug, tool);
  });

  const selectableTools = Array.from(bySlug.values());
  if (!selectableTools.length) {
    deps.showInfoToast("No tools available", "No installed tools found to test.");
    return;
  }

  const toolSlug = await deps.promptInstalledToolSlugWithToast(selectableTools, {
    title: "Test Composio Tool Connection",
    confirmLabel: "Test"
  });
  if (!toolSlug) {
    deps.showInfoToast("Test cancelled", "No tool selected.");
    return;
  }

  await testComposioToolConnection(extensionAPI, toolSlug);
}

export async function refreshToolAuthStatus(extensionAPI) {
  const client = await connectComposio(extensionAPI, { suppressConnectedToast: true });
  if (!client?.callTool) {
    deps.showErrorToast("Refresh failed", "Composio is not connected.");
    return;
  }

  const state = getToolsConfigState(extensionAPI);
  const pendingTools = state.installedTools.filter((tool) => tool.installState === "pending_auth");
  if (!pendingTools.length) {
    deps.showInfoToast("Nothing pending", "No tools are currently waiting for authentication.");
    return;
  }

  const remoteInstalledTools = await fetchInstalledToolsFromComposioCached(client, { ttlMs: 2000, force: true });
  let activatedCount = 0;
  for (const tool of pendingTools) {
    const toolSlug = String(tool.slug || "").toUpperCase();
    const isConnected = await checkToolConnectedViaComposio(client, toolSlug, {
      remoteInstalledTools
    });
    if (!isConnected) continue;
    activatedCount += 1;
    upsertInstalledTool(extensionAPI, {
      slug: toolSlug,
      label: tool.label || toolSlug,
      installState: "installed",
      lastError: ""
    });
    clearAuthPollForSlug(toolSlug);
  }

  if (activatedCount > 0) {
    deps.showInfoToast("Auth refreshed", `${activatedCount} tool(s) are now connected.`);
  } else {
    deps.showInfoToast("Still pending", "No pending tools have completed authentication yet.");
  }
}

export async function deregisterComposioTool(extensionAPI, requestedSlug) {
  const toolSlug = (requestedSlug || "").trim().toUpperCase();
  if (!toolSlug) {
    deps.showInfoToast("Deregister cancelled", "No tool slug entered.");
    return;
  }

  const client = await connectComposio(extensionAPI, { suppressConnectedToast: true });
  if (!client?.callTool) {
    deps.showErrorToast("Deregister failed", "Composio is not connected.");
    return;
  }

  const attempts = [
    {
      name: "COMPOSIO_MANAGE_CONNECTIONS",
      arguments: { action: "disconnect", toolkits: [toolSlug] }
    },
    {
      name: "COMPOSIO_MANAGE_CONNECTIONS",
      arguments: { action: "remove", toolkits: [toolSlug] }
    },
    {
      name: "COMPOSIO_MANAGE_CONNECTIONS",
      arguments: { action: "delete", toolkits: [toolSlug] }
    }
  ];

  let success = false;
  for (const attempt of attempts) {
    try {
      const deregisterResult = await client.callTool(attempt);
      const records = extractInstalledToolRecordsFromResponse(deregisterResult);
      const looksSuccessful = composioCallLooksSuccessful(deregisterResult);
      deps.debugLog("[Chief of Staff] Composio deregister meta:", {
        toolSlug,
        action: attempt?.arguments?.action || "unknown",
        recordCount: records.length,
        looksSuccessful
      });
      if (!looksSuccessful) continue;
      success = true;
      break;
    } catch (error) {
      continue;
    }
  }

  if (!success) {
    upsertInstalledTool(extensionAPI, {
      slug: toolSlug,
      label: toolSlug,
      installState: "failed",
      lastError: "Deregister command failed"
    });
    deps.showErrorToast("Deregister failed", `Could not deregister ${toolSlug}.`);
    return;
  }

  clearAuthPollForSlug(toolSlug);
  invalidateInstalledToolsFetchCache();
  const state = getToolsConfigState(extensionAPI);
  const nextInstalledTools = state.installedTools.filter((tool) => tool.slug !== toolSlug);
  saveToolsConfigState(extensionAPI, {
    ...state,
    installedTools: nextInstalledTools
  });
  await reconcileInstalledToolsWithComposio(extensionAPI);

  // Clean up entry on [[Chief of Staff/MCP Servers]] written by discoverToolkitSchema()
  // via updateMcpBom() with serverKey = "composio:<SLUG>"
  try {
    const mcpPageTitle = "Chief of Staff/MCP Servers";
    const composioServerKey = `composio:${String(toolSlug).replace(/[\\"]/g, "")}`;
    const api = deps.getRoamAlphaApi();
    const staleEntries = api.q(`
      [:find ?uid
       :where [?p :node/title "${mcpPageTitle}"]
              [?p :block/children ?b]
              [?b :block/string ?str]
              [?b :block/uid ?uid]
              [(clojure.string/includes? ?str "${composioServerKey}")]]
    `);
    if (staleEntries && staleEntries.length > 0) {
      for (const [uid] of staleEntries) {
        await api.deleteBlock({ block: { uid } });
        deps.debugLog(`[MCP BOM] Removed MCP Servers entry for deregistered Composio tool ${toolSlug} (uid: ${uid})`);
      }
    }
  } catch (e) {
    deps.debugLog(`[MCP BOM] Cleanup after deregister failed for ${toolSlug}:`, e?.message);
  }

  // Clean up schema pin for this Composio tool
  try {
    const pinKey = `composio:${toolSlug}`;
    const stored = deps.getExtensionAPIRef().settings.get(deps.SETTINGS_KEYS.mcpSchemaHashes) || {};
    if (stored[pinKey] || stored[`${pinKey}_tools`] || stored[`${pinKey}_fingerprints`]) {
      delete stored[pinKey];
      delete stored[`${pinKey}_tools`];
      delete stored[`${pinKey}_fingerprints`];
      deps.getExtensionAPIRef().settings.set(deps.SETTINGS_KEYS.mcpSchemaHashes, stored);
      deps.debugLog(`[MCP Security] Removed schema pin for deregistered Composio tool ${toolSlug}`);
    }
  } catch (e) {
    deps.debugLog(`[MCP Security] Schema pin cleanup failed for ${toolSlug}:`, e?.message);
  }

  // Refresh AIBOM so the deregistered tool is removed from the snapshot
  deps.scheduleRuntimeAibomRefresh(200);

  deps.showInfoToast("Tool deregistered", `${toolSlug} has been deregistered.`);
}

// ═══════════════════════════════════════════════════════════════════════
// Startup auth poll scheduling — called from onload()
// ═══════════════════════════════════════════════════════════════════════

/**
 * Schedule auth polling for pending tools during startup.
 * Replaces the inline loop in onload() that manipulated startupAuthPollTimeoutIds.
 */
export function scheduleStartupAuthPolls(extensionAPI, pendingTools) {
  pendingTools.forEach((tool, index) => {
    const delayMs = index * 2000;
    const timeoutId = window.setTimeout(() => {
      const timeoutIndex = startupAuthPollTimeoutIds.indexOf(timeoutId);
      if (timeoutIndex >= 0) startupAuthPollTimeoutIds.splice(timeoutIndex, 1);
      // Guard against unload racing with the timeout
      if (deps.getExtensionAPIRef() === null) return;
      startToolAuthPolling(extensionAPI, tool.slug);
    }, delayMs);
    startupAuthPollTimeoutIds.push(timeoutId);
  });
}

// ═══════════════════════════════════════════════════════════════════════
// Proxy validation
// ═══════════════════════════════════════════════════════════════════════

export async function validateComposioProxy(extensionAPI) {
  // Step 1 — Settings check
  const composioMcpUrl = deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.composioMcpUrl, "");
  const composioApiKey = deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.composioApiKey, "");
  const hasRealUrl = composioMcpUrl && composioMcpUrl !== deps.DEFAULT_COMPOSIO_MCP_URL && /^https?:\/\//i.test(composioMcpUrl);
  const hasRealKey = composioApiKey && composioApiKey !== deps.DEFAULT_COMPOSIO_API_KEY && composioApiKey.length > 8;
  if (!hasRealUrl || !hasRealKey) {
    deps.showErrorToast("Proxy validation failed", "Composio MCP URL or API key not configured. Update Settings first.");
    return;
  }

  deps.showInfoToast("Validating proxy\u2026", "Running connectivity checks.");
  const results = [];

  // Step 2 — Proxy reachable (OPTIONS preflight to the configured MCP URL)
  try {
    const proxyResp = await fetch(composioMcpUrl, { method: "OPTIONS", signal: AbortSignal.timeout(10000) });
    if (proxyResp.ok || proxyResp.status === 204) {
      results.push("\u2713 Proxy reachable");
    } else {
      results.push(`\u2717 Proxy returned ${proxyResp.status}`);
    }
  } catch (e) {
    results.push(`\u2717 Proxy unreachable: ${e?.message || "network error"}`);
  }

  // Step 3 — Upstream reachable (POST to the MCP URL with a JSON-RPC initialize-ish payload)
  try {
    const upstreamResp = await fetch(composioMcpUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": deps.sanitizeHeaderValue(composioApiKey)
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "cos-validate", version: "1.0" } } }),
      signal: AbortSignal.timeout(15000)
    });
    if (upstreamResp.ok) {
      results.push("\u2713 Upstream MCP responds");
      // Try to read body for API key validation
      try {
        const body = await upstreamResp.text();
        if (body.includes("error") && (body.includes("auth") || body.includes("key") || body.includes("unauthorized"))) {
          results.push("\u2717 API key may be invalid (auth error in response)");
        } else {
          results.push("\u2713 API key accepted");
        }
      } catch { /* body read failed, skip */ }
    } else if (upstreamResp.status === 401 || upstreamResp.status === 403) {
      results.push("\u2717 API key rejected (HTTP " + upstreamResp.status + ")");
    } else if (upstreamResp.status === 502) {
      results.push("\u2717 Proxy blocked upstream (502) \u2014 check target URL");
    } else {
      results.push(`\u26A0 Upstream returned ${upstreamResp.status}`);
    }
  } catch (e) {
    results.push(`\u2717 Upstream check failed: ${e?.message || "network error"}`);
  }

  // Step 4 — Tool call probe (tools/list via the live MCP client, if connected)
  const mcpClient = deps.getMcpClient();
  if (mcpClient?.callTool) {
    try {
      // Use a raw JSON-RPC tools/list POST — lightweight, no side effects
      const sessionId = mcpClient?._transport?._sessionId;
      const toolListHeaders = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "x-api-key": composioApiKey
      };
      if (sessionId) toolListHeaders["mcp-session-id"] = sessionId;
      const toolListResp = await fetch(composioMcpUrl, {
        method: "POST",
        headers: toolListHeaders,
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
        signal: AbortSignal.timeout(15000)
      });
      if (toolListResp.ok) {
        results.push("\u2713 Tool calls accepted (tools/list OK)");
      } else if (toolListResp.status === 406) {
        results.push("\u2717 Tool calls rejected (406 Not Acceptable) \u2014 Composio may have changed their API");
      } else {
        results.push(`\u26A0 Tool call returned ${toolListResp.status}`);
      }
    } catch (e) {
      results.push(`\u2717 Tool call probe failed: ${e?.message || "network error"}`);
    }
  } else {
    results.push("\u26A0 Skipped tool call probe (not connected)");
  }

  // Step 5 — Report
  // Only hard failures (\u2717) count against the verdict — warnings (\u26A0) are informational
  const hasFailure = results.some(r => r.startsWith("\u2717"));
  const summary = results.join("\n");
  if (!hasFailure) {
    deps.showInfoToast("Proxy validation passed", summary);
  } else {
    deps.showErrorToast("Proxy validation issues", summary);
  }
  deps.debugLog("[Composio Proxy Validation]", summary);
}
