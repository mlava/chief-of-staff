/**
 * roam-oauth-client.js — Drop-in OAuth helper for Roam Research extensions.
 *
 * Converted from roam-client.ts for use in Chief of Staff (pure JS, no TypeScript).
 * Works with the roam-oauth-middleware Cloudflare Worker.
 *
 * The Worker holds refresh tokens server-side and issues short-lived access tokens.
 * The client stores only the credential_id and calls /auth/access to get fresh tokens.
 */

// ── RoamOAuthClient ─────────────────────────────────────────────────────────

export class RoamOAuthClient {
  constructor(workerBaseUrl) {
    this.baseUrl = workerBaseUrl.replace(/\/+$/, "");
  }

  /**
   * Start the full OAuth flow:
   *  1. Call /auth/init to get a session + auth URL
   *  2. Open a popup to the auth URL
   *  3. Poll /auth/poll until tokens arrive or timeout
   *
   * @param {object} options
   * @param {string} options.provider      — Provider key, e.g. "google"
   * @param {string} options.extensionId   — Extension identifier, e.g. "chief-of-staff"
   * @param {string[]} [options.scopes]    — OAuth scopes (optional, falls back to provider defaults)
   * @param {number} [options.pollIntervalMs] — Override poll interval
   * @param {number} [options.timeoutMs]   — Max wait time (default: 600000 = 10 min)
   * @param {string} [options.popupFeatures] — Popup window features string
   * @returns {Promise<{access_token: string, credential_id?: string, token_type: string, expires_in?: number, scope?: string}>}
   */
  async authenticate(options) {
    const {
      provider,
      extensionId,
      scopes,
      pollIntervalMs,
      timeoutMs = 600_000,
    } = options;

    // Step 1: Initialize the session
    const initRes = await fetch(`${this.baseUrl}/auth/init`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider,
        extension_id: extensionId,
        scopes,
      }),
    });

    if (!initRes.ok) {
      const err = await initRes.json();
      throw new Error(`OAuth init failed: ${err.error}`);
    }

    const initData = await initRes.json();

    // Step 2: Open the auth URL in a popup
    const popup = this._openPopup(initData.auth_url, options.popupFeatures);

    // Step 3: Poll for tokens
    const interval = pollIntervalMs ?? initData.poll_interval * 1000;
    const deadline = Date.now() + Math.min(timeoutMs, initData.expires_in * 1000);

    return new Promise((resolve, reject) => {
      const timer = setInterval(async () => {
        // Check if user closed the popup
        if (popup && popup.closed) {
          clearInterval(timer);
          reject(new Error("User closed the authorization window."));
          return;
        }

        // Check timeout
        if (Date.now() > deadline) {
          clearInterval(timer);
          if (popup && !popup.closed) popup.close();
          reject(new Error("Authorization timed out."));
          return;
        }

        try {
          const pollRes = await fetch(`${this.baseUrl}/auth/poll`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              session_id: initData.session_id,
              poll_token: initData.poll_token,
            }),
          });

          const pollData = await pollRes.json();

          if (pollData.status === "complete") {
            clearInterval(timer);
            if (popup && !popup.closed) popup.close();
            resolve({
              access_token: pollData.access_token,
              credential_id: pollData.credential_id,
              token_type: pollData.token_type ?? "bearer",
              expires_in: pollData.expires_in,
              scope: pollData.scope,
            });
          } else if (pollData.status === "error") {
            clearInterval(timer);
            if (popup && !popup.closed) popup.close();
            reject(new Error(`Authorization failed: ${pollData.error}`));
          }
          // status === "pending" → keep polling
        } catch (err) {
          // Network error during poll — don't fail immediately, retry next tick
          console.warn("Poll request failed, retrying...", err);
        }
      }, interval);
    });
  }

  /**
   * Get a fresh access token from a server-side stored credential.
   * @param {string} credentialId
   * @param {string} extensionId
   * @returns {Promise<{access_token: string, credential_id: string, token_type: string, expires_in?: number, scope?: string}>}
   */
  async getAccessToken(credentialId, extensionId) {
    const res = await fetch(`${this.baseUrl}/auth/access`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential_id: credentialId, extension_id: extensionId }),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(`Access token request failed: ${err.error}`);
    }

    return res.json();
  }

  /**
   * Revoke a server-side credential (disconnect).
   * @param {string} credentialId
   * @param {string} extensionId
   * @returns {Promise<{revoked: boolean, error?: string}>}
   */
  async revokeCredential(credentialId, extensionId) {
    const res = await fetch(`${this.baseUrl}/auth/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential_id: credentialId, extension_id: extensionId }),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(`Credential revoke failed: ${data.error ?? "unknown_error"}`);
    }

    return data;
  }

  /**
   * List available providers on the Worker.
   * @param {string} [extensionId]
   * @returns {Promise<string[]>}
   */
  async listProviders(extensionId) {
    const url = new URL(`${this.baseUrl}/auth/providers`);
    if (extensionId) {
      url.searchParams.set("extension_id", extensionId);
    }
    const res = await fetch(url.toString());
    const data = await res.json();
    return data.providers;
  }

  /** @private */
  _openPopup(url, features) {
    const width = 500;
    const height = 700;
    const left = Math.round(window.screenX + (window.outerWidth - width) / 2);
    const top = Math.round(window.screenY + (window.outerHeight - height) / 2);

    const defaultFeatures = `width=${width},height=${height},left=${left},top=${top},toolbar=no,menubar=no,scrollbars=yes,resizable=yes`;

    return window.open(url, "roam_oauth", features ?? defaultFeatures);
  }
}

// ── Token storage helpers ───────────────────────────────────────────────────

const STORAGE_PREFIX = "roam_oauth_";

function storageKey(extensionId, provider) {
  return `${extensionId}_${provider}`;
}

/**
 * Create a storage adapter backed by Roam Depot extensionAPI.settings.
 * Credentials are namespaced per-extension automatically.
 * @param {object} extensionAPI — The Roam extension API object from onload()
 * @param {string} [prefix]
 * @returns {{getItem: function, setItem: function, removeItem: function}}
 */
export function createRoamStorageAdapter(extensionAPI, prefix = STORAGE_PREFIX) {
  return {
    getItem(key) {
      const value = extensionAPI.settings.get(`${prefix}${key}`);
      return typeof value === "string" ? value : null;
    },
    setItem(key, value) {
      extensionAPI.settings.set(`${prefix}${key}`, value);
    },
    removeItem(key) {
      extensionAPI.settings.set(`${prefix}${key}`, null);
    },
  };
}

/**
 * Save access-token metadata and credential id.
 * @param {string} extensionId
 * @param {string} provider
 * @param {object} tokens — { access_token, credential_id?, token_type, expires_in?, scope? }
 * @param {object} storage — Storage adapter (use createRoamStorageAdapter)
 */
export function saveTokens(extensionId, provider, tokens, storage) {
  const key = storageKey(extensionId, provider);
  const payload = {
    ...tokens,
    saved_at: Date.now(),
  };
  storage.setItem(key, JSON.stringify(payload));
}

/**
 * Load access-token metadata and credential id.
 * Returns null if nothing is stored.
 * @param {string} extensionId
 * @param {string} provider
 * @param {object} storage
 * @returns {object|null} — { access_token, credential_id?, token_type, expires_in?, scope?, saved_at }
 */
export function loadTokens(extensionId, provider, storage) {
  const key = storageKey(extensionId, provider);
  const raw = storage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Clear stored tokens for a provider.
 * @param {string} extensionId
 * @param {string} provider
 * @param {object} storage
 */
export function clearTokens(extensionId, provider, storage) {
  const key = storageKey(extensionId, provider);
  if (storage.removeItem) storage.removeItem(key);
}

/**
 * Check if a stored token is likely expired (with 60s buffer).
 * @param {object} stored — { saved_at, expires_in? }
 * @returns {boolean}
 */
export function isTokenExpired(stored) {
  if (!stored.expires_in) return false;
  const expiresAt = stored.saved_at + stored.expires_in * 1000;
  return Date.now() > expiresAt - 60_000;
}
