/**
 * mcp-oauth-provider.js — MCP OAuth 2.1 client provider for Chief of Staff.
 *
 * Implements the SDK's OAuthClientProvider interface so that
 * StreamableHTTPClientTransport can natively handle the MCP OAuth 2.1
 * authorization code flow with PKCE.
 *
 * Key design:
 *   - Popup-based redirect: the auth server redirects to a Worker callback
 *     page which relays the authorization code back via postMessage.
 *   - Storage: Roam Depot IndexedDB via extensionAPI.settings (per-server,
 *     scoped by a URL-derived hash).
 *   - Public client: token_endpoint_auth_method = "none" (browser context).
 *   - Pre-registered client_id support for servers that block DCR.
 *
 * Dependency-injected via initMcpOAuthProvider(). All external functions
 * accessed through `deps.*`.
 */

// ── Constants ───────────────────────────────────────────────────────────────

const MCP_OAUTH_CALLBACK_URL =
  "https://roam-oauth-middleware.roam-extensions.workers.dev/mcp-oauth/callback";

const MCP_OAUTH_CALLBACK_ORIGIN = new URL(MCP_OAUTH_CALLBACK_URL).origin;

// Worker CORS proxy for OAuth flows — routes through our Cloudflare Worker
// instead of Roam's generic corsAnywhere proxy.
const MCP_OAUTH_PROXY_BASE = `${MCP_OAUTH_CALLBACK_ORIGIN}/proxy`;

const MCP_OAUTH_AUTH_TIMEOUT_MS = 180_000;  // 3 minutes for user to authorise
const MCP_OAUTH_POPUP_CHECK_MS = 2_000;     // poll popup.closed every 2s

const STORAGE_PREFIX = "mcp-oauth";

// ── Module state ────────────────────────────────────────────────────────────

let deps = {};

// ── DI ──────────────────────────────────────────────────────────────────────

/**
 * Inject dependencies from index.js onload().
 *
 * Required deps:
 *   - extensionAPI           — Roam Depot settings read/write
 *   - debugLog(...args)      — conditional debug logging
 *   - redactForLog(str)      — PII/token redaction
 *   - showInfoToast(title, msg)
 *   - showErrorToast(title, msg)
 */
export function initMcpOAuthProvider(injected) {
  deps = injected;
}

// ── Storage helpers ─────────────────────────────────────────────────────────

/**
 * Derive a short, settings-key-safe hash from a normalised URL.
 * Used to scope per-server OAuth state in Roam Depot IndexedDB.
 */
export function urlToHash(normalizedUrl) {
  return btoa(normalizedUrl).replace(/[^a-zA-Z0-9]/g, "").slice(0, 24);
}

function storageKey(urlHash, suffix) {
  return `${STORAGE_PREFIX}-${suffix}-${urlHash}`;
}

function loadJson(key) {
  try {
    const raw = deps.extensionAPI?.settings?.get(key);
    return raw ? JSON.parse(raw) : undefined;
  } catch {
    return undefined;
  }
}

function saveJson(key, value) {
  try {
    deps.extensionAPI?.settings?.set(key, value ? JSON.stringify(value) : "");
  } catch (e) {
    deps.debugLog?.("[MCP OAuth] Storage write error:", e?.message);
  }
}

function clearKey(key) {
  try {
    deps.extensionAPI?.settings?.set(key, "");
  } catch { /* best-effort */ }
}

// ── Popup helpers ───────────────────────────────────────────────────────────

function openPopup(url) {
  const width = 500;
  const height = 700;
  const left = Math.round(window.screenX + (window.outerWidth - width) / 2);
  const top = Math.round(window.screenY + (window.outerHeight - height) / 2);
  return window.open(
    url,
    "cos_mcp_oauth",
    `width=${width},height=${height},left=${left},top=${top},toolbar=no,menubar=no,scrollbars=yes,resizable=yes`
  );
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create an OAuthClientProvider for a specific remote MCP server.
 *
 * @param {object} config
 * @param {string} config.urlHash             — urlToHash(normalizedUrl)
 * @param {string} [config.preRegisteredClientId]    — user-provided client_id for 🔐 servers
 * @param {string} [config.preRegisteredClientSecret] — optional client_secret
 * @param {boolean} [config.silent]           — if true, suppress popups (auto-connect mode)
 * @returns {OAuthClientProvider} — SDK-compatible provider object
 */
export function createMcpOAuthProvider(config) {
  const { urlHash } = config;
  const clientKey = storageKey(urlHash, "client");
  const tokensKey = storageKey(urlHash, "tokens");
  const verifierKey = storageKey(urlHash, "verifier");

  const log = (...a) => deps.debugLog?.("[MCP OAuth]", ...a);

  // ── Provider object (satisfies OAuthClientProvider interface) ──

  const provider = {
    // ── Redirect URL ──────────────────────────────────────────────
    get redirectUrl() {
      return MCP_OAUTH_CALLBACK_URL;
    },

    // ── Client metadata (for DCR) ─────────────────────────────────
    get clientMetadata() {
      return {
        client_name: "Chief of Staff (Roam Research)",
        redirect_uris: [new URL(MCP_OAUTH_CALLBACK_URL)],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",  // public client
      };
    },

    // ── Client information (DCR result or pre-registered) ─────────
    async clientInformation() {
      // Pre-registered client takes precedence
      const preId = String(config.preRegisteredClientId || "").trim();
      if (preId) {
        const info = { client_id: preId };
        const preSecret = String(config.preRegisteredClientSecret || "").trim();
        if (preSecret) info.client_secret = preSecret;
        return info;
      }
      // Otherwise load DCR-stored info
      return loadJson(clientKey);
    },

    async saveClientInformation(clientInfo) {
      log("Saving client information (DCR):", clientInfo?.client_id ? `client_id=${clientInfo.client_id.slice(0, 8)}…` : "unknown");
      saveJson(clientKey, clientInfo);
    },

    // ── Token storage ─────────────────────────────────────────────
    async tokens() {
      return loadJson(tokensKey);
    },

    async saveTokens(tokens) {
      const withMeta = { ...tokens, _saved_at: Date.now() };
      log("Saving tokens:", tokens?.access_token ? "access_token present" : "no access_token");
      saveJson(tokensKey, withMeta);
    },

    // ── PKCE code verifier ────────────────────────────────────────
    async saveCodeVerifier(codeVerifier) {
      saveJson(verifierKey, codeVerifier);
    },

    async codeVerifier() {
      return loadJson(verifierKey) || "";
    },

    // ── CSRF state ────────────────────────────────────────────────
    // Capture the state value so we can use it as the polling key.
    state() {
      const s = crypto.randomUUID
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
      provider._lastState = s;
      return s;
    },

    // ── Redirect to authorisation ─────────────────────────────────
    // Opens the auth URL in a new window (Electron opens it in the
    // external browser). The callback page POSTs the auth code to
    // the Worker, and we poll for it. The pending Promise is exposed
    // as provider._authPromise for connectRemoteMcp() to await.
    async redirectToAuthorization(authorizationUrl) {
      if (config.silent) {
        log("Silent mode — suppressing OAuth popup for auto-connect");
        provider._authPromise = Promise.reject(new Error("MCP OAuth: silent mode — use command palette to authenticate"));
        provider._authPromise.catch(() => {}); // prevent unhandled rejection
        return;
      }
      log("Opening authorisation window:", authorizationUrl.toString().slice(0, 80) + "…");

      const pollState = provider._lastState;
      if (!pollState) {
        provider._authPromise = Promise.reject(new Error("MCP OAuth: no state available for polling"));
        provider._authPromise.catch(() => {});
        return;
      }

      provider._authPromise = new Promise((resolve, reject) => {
        let timeoutId = null;
        let pollId = null;

        function cleanup() {
          if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
          if (pollId) { clearInterval(pollId); pollId = null; }
        }

        // Timeout
        timeoutId = setTimeout(() => {
          cleanup();
          reject(new Error("MCP OAuth timed out waiting for authorisation (3 minutes)"));
        }, MCP_OAUTH_AUTH_TIMEOUT_MS);

        // Open the auth URL in a new window/tab.
        // In Electron this opens in the external browser — the reference
        // may be null, which is fine since we use polling (not postMessage).
        openPopup(authorizationUrl.toString());

        // Poll the Worker for the auth code (callback page POSTs it there)
        log("Polling for auth code with state:", pollState.slice(0, 8) + "…");
        pollId = setInterval(async () => {
          try {
            const res = await fetch(`${MCP_OAUTH_CALLBACK_URL.replace("/mcp-oauth/callback", "/mcp-oauth/poll")}`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ state: pollState }),
            });
            if (!res.ok) return; // transient error, keep polling
            const data = await res.json();
            if (data.status === "complete" && data.code) {
              cleanup();
              log("Authorisation code received via polling");
              resolve(data.code);
            }
            // status === "pending" → keep polling
          } catch {
            // Network error — keep polling
          }
        }, MCP_OAUTH_POPUP_CHECK_MS);
      });
    },

    // ── Credential invalidation ───────────────────────────────────
    async invalidateCredentials(scope) {
      log("Invalidating credentials:", scope);
      if (scope === "all" || scope === "client") clearKey(clientKey);
      if (scope === "all" || scope === "tokens") clearKey(tokensKey);
      if (scope === "all" || scope === "verifier") clearKey(verifierKey);
    },

    // ── Internal state ────────────────────────────────────────────
    // Exposed for connectRemoteMcp() to await after UnauthorizedError
    _authPromise: null,
    _lastState: null,
    _urlHash: urlHash,
  };

  return provider;
}

// ── Status helper (for settings UI) ─────────────────────────────────────────

/**
 * Read-only snapshot of MCP OAuth state for a given server URL.
 * Used by settings-config.js to display connection status.
 *
 * @param {string} normalizedUrl — normalizeRemoteMcpUrl(url) output
 * @returns {{ connected: boolean, hasClientInfo: boolean, isExpired: boolean }}
 */
export function getMcpOAuthStatus(normalizedUrl) {
  if (!normalizedUrl) return { connected: false, hasClientInfo: false, isExpired: false };
  const hash = urlToHash(normalizedUrl);
  const tokens = loadJson(storageKey(hash, "tokens"));
  const clientInfo = loadJson(storageKey(hash, "client"));

  const connected = !!(tokens?.access_token);
  let isExpired = false;
  if (tokens?.expires_in && tokens?._saved_at) {
    const expiresAt = tokens._saved_at + (tokens.expires_in * 1000) - 60_000; // 60s buffer
    isExpired = Date.now() > expiresAt;
  }

  return {
    connected,
    hasClientInfo: !!(clientInfo?.client_id),
    isExpired,
  };
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

/**
 * Clear all MCP OAuth state for a server. Used on disconnect or revoke.
 *
 * @param {string} normalizedUrl — normalizeRemoteMcpUrl(url) output
 */
export function clearMcpOAuthCredentials(normalizedUrl) {
  if (!normalizedUrl) return;
  const hash = urlToHash(normalizedUrl);
  clearKey(storageKey(hash, "client"));
  clearKey(storageKey(hash, "tokens"));
  clearKey(storageKey(hash, "verifier"));
  deps.debugLog?.("[MCP OAuth] Cleared credentials for", normalizedUrl);
}

// ── Worker proxy helper ──────────────────────────────────────────────────────

/**
 * Proxy a URL through the OAuth Worker instead of Roam's corsAnywhere.
 * Used for all fetch calls in MCP OAuth connections (discovery, DCR, token
 * exchange, and authenticated MCP requests).
 */
export function getOAuthProxiedUrl(url) {
  const raw = typeof url === "string" ? url : url instanceof URL ? url.toString() : String(url);
  return `${MCP_OAUTH_PROXY_BASE}/${raw}`;
}

// ── Exports for testing ─────────────────────────────────────────────────────

export { MCP_OAUTH_CALLBACK_URL, MCP_OAUTH_CALLBACK_ORIGIN, MCP_OAUTH_PROXY_BASE };
