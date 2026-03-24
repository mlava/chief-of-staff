/**
 * oauth-client.js — COS-specific OAuth wrapper around roam-oauth-client.js.
 *
 * This module adds Chief of Staff concerns on top of the generic Roam OAuth client:
 *   - DI via initOAuthClient() (matches COS module pattern)
 *   - Toast notifications for auth progress / success / failure
 *   - Debug logging with PII redaction
 *   - getValidToken() with automatic server-side refresh via credential_id
 *   - getAuthHeader() for remote MCP connection injection
 *   - Provider label mapping for UI display
 *
 * The Worker holds refresh tokens server-side. The client stores only the
 * credential_id and calls POST /auth/access to get fresh access tokens.
 *
 * Dependency-injected via initOAuthClient(). All external functions/constants
 * accessed through `deps.*`.
 */

import {
  RoamOAuthClient,
  createRoamStorageAdapter,
  saveTokens,
  loadTokens,
  clearTokens as clearStoredTokens,
  isTokenExpired,
} from "./roam-oauth-client.js";

// ── Constants ───────────────────────────────────────────────────────────────

const OAUTH_WORKER_BASE_URL = "https://roam-oauth-middleware.roam-extensions.workers.dev";
const EXTENSION_ID = "chief-of-staff";

// ── Provider labels ─────────────────────────────────────────────────────────
// Only used for toast messages and UI display. The Worker owns the real
// provider config (scopes, token URLs, etc.). Adding a provider here is
// optional — unknown providers still work, they just show the raw key.

const PROVIDER_LABELS = {
  google: "Google",
  github: "GitHub",
  notion: "Notion",
  slack: "Slack",
  todoist: "Todoist",
  linear: "Linear",
};

function providerLabel(provider) {
  return PROVIDER_LABELS[provider] || provider;
}

// ── Module state ────────────────────────────────────────────────────────────
let oauthClient = null;   // RoamOAuthClient instance
let storage = null;        // Roam storage adapter

// ── DI deps ─────────────────────────────────────────────────────────────────
let deps = {};

/**
 * Inject dependencies from index.js onload().
 *
 * Required deps:
 *   - extensionAPI          — Roam Depot settings read/write
 *   - debugLog(...args)     — conditional debug logging
 *   - redactForLog(str)     — PII/token redaction
 *   - showInfoToast(title, msg)
 *   - showErrorToast(title, msg)
 *   - sanitizeHeaderValue(val) — strip CRLF from header values
 */
export function initOAuthClient(injected) {
  deps = injected;
  oauthClient = new RoamOAuthClient(OAUTH_WORKER_BASE_URL);
  storage = createRoamStorageAdapter(deps.extensionAPI);
}

// ── Core OAuth flow ─────────────────────────────────────────────────────────

/**
 * Full OAuth 2.0 acquisition flow via the Roam OAuth middleware.
 * Opens a popup, polls until tokens arrive, stores credential_id.
 *
 * Returns { success: true, provider } on success,
 *         { success: false, error: string } on failure.
 *
 * @param {string} provider — provider name (e.g. "google")
 * @param {string[]} [scopes] — OAuth scopes (optional, worker uses defaults)
 */
export async function acquireOAuthToken(provider, scopes) {
  const providerKey = String(provider || "").toLowerCase();
  const label = providerLabel(providerKey);
  const log = deps.debugLog || (() => {});

  if (!oauthClient) {
    return { success: false, error: "OAuth client not initialized" };
  }

  try {
    log("[OAuth] Starting auth for", providerKey);
    deps.showInfoToast?.("Authenticating", `Complete ${label} sign-in in the opened window.`);

    const tokens = await oauthClient.authenticate({
      provider: providerKey,
      extensionId: EXTENSION_ID,
      scopes,
    });

    // Store tokens + credential_id via roam-oauth-client storage
    saveTokens(EXTENSION_ID, providerKey, tokens, storage);
    log("[OAuth] Tokens acquired and stored for", providerKey,
      tokens.credential_id ? "(credential_id present)" : "(no credential_id)");
    deps.showInfoToast?.("Connected", `${label} authentication complete.`);

    return { success: true, provider: providerKey };

  } catch (error) {
    const msg = error?.message || String(error);
    log("[OAuth] acquireOAuthToken error:", deps.redactForLog?.(msg) || msg);
    deps.showErrorToast?.("Auth failed", `${label} authentication failed.`);
    return { success: false, error: msg };
  }
}

// ── Token access & refresh ──────────────────────────────────────────────────

/**
 * Get a valid access token for a provider. If the stored token is expired,
 * automatically refreshes via the Worker's /auth/access endpoint using
 * the stored credential_id (server-side refresh — no client-side refresh tokens).
 *
 * Returns the access token string, or "" if no token is available.
 * This is the function that remote-mcp.js should call at connection time.
 */
export async function getValidToken(provider) {
  const providerKey = String(provider || "").toLowerCase();
  const log = deps.debugLog || (() => {});

  if (!storage || !oauthClient) return "";

  const stored = loadTokens(EXTENSION_ID, providerKey, storage);
  if (!stored || !stored.access_token) return "";

  // If token is still fresh, return it
  if (!isTokenExpired(stored)) {
    return stored.access_token;
  }

  // Token expired — refresh via credential_id
  if (!stored.credential_id) {
    log("[OAuth] Token expired but no credential_id for", providerKey, "— re-auth required");
    return "";
  }

  try {
    log("[OAuth] Refreshing access token for", providerKey, "via credential_id");
    const fresh = await oauthClient.getAccessToken(stored.credential_id, EXTENSION_ID);
    // Merge fresh token with existing credential_id and save
    saveTokens(EXTENSION_ID, providerKey, {
      ...fresh,
      credential_id: stored.credential_id,
    }, storage);
    log("[OAuth] Access token refreshed for", providerKey);
    return fresh.access_token;
  } catch (error) {
    log("[OAuth] Refresh error:", deps.redactForLog?.(error?.message) || error?.message);
    // Return stale token — might still work, let caller handle the 401
    return stored.access_token;
  }
}

/**
 * Build the auth header object for a given provider, suitable for passing
 * to remote MCP connection or direct API calls.
 *
 * Returns { name, value } or null if no token is available.
 */
export async function getAuthHeader(provider) {
  const token = await getValidToken(provider);
  if (!token) return null;

  const sanitized = deps.sanitizeHeaderValue?.(token) || token;
  return {
    name: "Authorization",
    value: `Bearer ${sanitized}`,
  };
}

// ── Disconnect / revoke ─────────────────────────────────────────────────────

/**
 * Revoke the server-side credential and clear local tokens.
 */
export async function revokeToken(provider) {
  const providerKey = String(provider || "").toLowerCase();
  const label = providerLabel(providerKey);
  const log = deps.debugLog || (() => {});

  if (storage && oauthClient) {
    const stored = loadTokens(EXTENSION_ID, providerKey, storage);
    // Revoke server-side credential if we have one
    if (stored?.credential_id) {
      try {
        await oauthClient.revokeCredential(stored.credential_id, EXTENSION_ID);
        log("[OAuth] Server-side credential revoked for", providerKey);
      } catch (error) {
        log("[OAuth] Revoke error (continuing with local clear):",
          deps.redactForLog?.(error?.message) || error?.message);
      }
    }
    clearStoredTokens(EXTENSION_ID, providerKey, storage);
  }

  log("[OAuth] Tokens cleared for", providerKey);
  deps.showInfoToast?.("Disconnected", `${label} has been disconnected.`);
}

// ── Read-only state (for UI) ────────────────────────────────────────────────

/**
 * Read-only snapshot of a provider's token state for UI display.
 * Does NOT trigger refresh.
 */
export function getOAuthTokenState(provider) {
  const providerKey = String(provider || "").toLowerCase();
  if (!storage) return { connected: false, provider: providerKey };

  const stored = loadTokens(EXTENSION_ID, providerKey, storage);
  if (!stored) {
    return {
      connected: false,
      provider: providerKey,
      label: providerLabel(providerKey),
    };
  }

  return {
    connected: !!stored.access_token,
    provider: providerKey,
    label: providerLabel(providerKey),
    hasCredentialId: !!stored.credential_id,
    isExpired: isTokenExpired(stored),
    scopes: stored.scope || "",
  };
}

/**
 * Get all connected providers as an array of state snapshots.
 */
export function getAllConnectedProviders() {
  return Object.keys(PROVIDER_LABELS)
    .map(getOAuthTokenState)
    .filter(s => s.connected);
}

/**
 * List providers available on the Worker (live query).
 * Falls back to local PROVIDER_LABELS keys on network error.
 */
export async function getAvailableProviders() {
  if (!oauthClient) return Object.keys(PROVIDER_LABELS);
  try {
    return await oauthClient.listProviders(EXTENSION_ID);
  } catch {
    return Object.keys(PROVIDER_LABELS);
  }
}

/**
 * Cancel any in-flight OAuth operations (e.g. on extension unload).
 * The RoamOAuthClient uses setInterval internally which resolves/rejects
 * the promise naturally — no external abort needed. This is kept for
 * the DI contract compatibility.
 */
export function cancelOAuthPolling() {
  // RoamOAuthClient manages its own polling lifecycle via setInterval.
  // Popup close detection + timeout handle cleanup automatically.
  // This function exists for interface compatibility with index.js onunload.
}
