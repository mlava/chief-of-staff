// ---------------------------------------------------------------------------
// Settings panel — progressive disclosure (rebuild-on-toggle)
// ---------------------------------------------------------------------------
// Extracted from index.js.  DI via initSettingsConfig().
//
// Three tiers:
//   1. Always visible — provider, API keys, your name
//   2. "Show Integration Settings" — Composio, Local MCP
//   3. "Show Advanced Settings" — debug, dry run, PII, ludicrous
// Toggle switches rebuild the panel so sections appear/disappear immediately.
// ---------------------------------------------------------------------------

let deps = {};

export function initSettingsConfig(injected) {
  deps = injected;
}

// ── Local constants ─────────────────────────────────────────────────────────

const SETTINGS_SHOW_INTEGRATIONS = "show-integration-settings";
const SETTINGS_SHOW_EXTENSION_TOOLS = "show-extension-tools";
const SETTINGS_SHOW_ADVANCED = "show-advanced-settings";
const SETTINGS_SHOW_AUTOMATIC_ACTIONS = "show-automatic-actions";

// ── Helpers ─────────────────────────────────────────────────────────────────

function ensureSettingBool(extensionAPI, key, fallback) {
  const val = extensionAPI.settings.get(key);
  if (val === true || val === false) return val;
  return fallback;
}

export function normaliseSwitchValue(evt, fallback) {
  if (typeof evt === "boolean") return evt;
  if (typeof evt?.target?.checked === "boolean") return evt.target.checked;
  if (typeof evt?.checked === "boolean") return evt.checked;
  return fallback;
}

/**
 * Clamp the skill max iterations setting to 8–40 with a fallback of 16.
 * Pure helper — no deps, safe to import directly from tests.
 *   - undefined / null / "" / NaN / non-numeric → 16
 *   - below 8 → 8, above 40 → 40
 *   - integers and numeric strings in range pass through (floor if float)
 */
export function clampSkillMaxIterations(raw) {
  const fallback = 16;
  if (raw === undefined || raw === null || raw === "") return fallback;
  const num = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(num)) return fallback;
  const floored = Math.floor(num);
  if (floored < 8) return 8;
  if (floored > 40) return 40;
  return floored;
}

/**
 * Clamp the chat agent max iterations setting to 10–40 with a fallback of 20.
 * Pure helper — no deps, safe to import directly from tests.
 *   - undefined / null / "" / NaN / non-numeric → 20
 *   - below 10 → 10, above 40 → 40
 *   - integers and numeric strings in range pass through (floor if float)
 */
export function clampAgentMaxIterations(raw) {
  const fallback = 20;
  if (raw === undefined || raw === null || raw === "") return fallback;
  const num = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(num)) return fallback;
  const floored = Math.floor(num);
  if (floored < 10) return 10;
  if (floored > 40) return 40;
  return floored;
}

export function rebuildSettingsPanel(extensionAPI) {
  setTimeout(() => {
    extensionAPI.settings.panel.create(buildSettingsConfig(extensionAPI));
  }, 60);
}

// Rebuild + force a REMOUNT of every settings row. panel.create alone
// re-renders the open panel (how the disclosure toggles reveal rows), but
// re-rendered select widgets keep their last interactive state and ignore the
// `value` prop — so a programmatic change to e.g. llm-provider stays visually
// stale. Registering an empty config for one tick unmounts all rows; the real
// config then mounts fresh widgets that read the saved settings.
export function remountSettingsPanel(extensionAPI) {
  setTimeout(() => {
    try {
      extensionAPI.settings.panel.create({ tabTitle: "Chief of Staff", settings: [] });
    } catch { /* fall through to the full rebuild */ }
    setTimeout(() => {
      extensionAPI.settings.panel.create(buildSettingsConfig(extensionAPI));
    }, 50);
  }, 60);
}

// Return blank string (not the placeholder default) for Composio settings
// so unconfigured fields stay empty rather than sending placeholder strings.
function getComposioSettingOrBlank(extensionAPI, key) {
  const val = deps.getSettingString(extensionAPI, key, "");
  if (val === deps.DEFAULT_COMPOSIO_MCP_URL || val === deps.DEFAULT_COMPOSIO_API_KEY) return "";
  return val;
}

// Build the LLM Provider select items: built-ins plus any configured custom slots.
// Custom slots use a compound label "custom-N — Display Name" so the user sees
// the friendly name in the dropdown. The canonical slot ID stays as a prefix so
// `getLlmProvider` can recover it after a rename without losing the selection.
function buildCustomProviderLabel(extensionAPI, id) {
  if (!deps.getCustomProviderConfig) return id;
  const cfg = deps.getCustomProviderConfig(extensionAPI, id);
  if (!cfg) return id;
  const isDefaultName = cfg.name === `Custom ${cfg.slot}`;
  return cfg.name && !isDefaultName ? `${id} — ${cfg.name}` : id;
}

function buildProviderSelectItems(extensionAPI) {
  const builtins = ["anthropic", "openai", "gemini", "mistral", "groq", "grok", "kimi", "kimi-coding", "deepseek", "ollama"];
  // ChatGPT-subscription provider appears once connected (mirrors custom slots
  // appearing only once configured). Plain id — no compound label to parse.
  const codex = deps.getCodexAuthStatus?.(extensionAPI)?.connected ? ["openai-codex"] : [];
  const customs = (deps.listCustomProviderIds ? deps.listCustomProviderIds(extensionAPI) : [])
    .map(id => buildCustomProviderLabel(extensionAPI, id));
  return [...builtins, ...codex, ...customs];
}

// Resolve the dropdown's current `value` to match what's in `items`.
// `getLlmProvider` returns the canonical slot ID; we must reconstruct the
// compound label so Roam's select widget shows the right item as selected.
function buildProviderSelectValue(extensionAPI) {
  const canonical = deps.getLlmProvider(extensionAPI);
  if (!canonical.startsWith("custom-")) return canonical;
  return buildCustomProviderLabel(extensionAPI, canonical);
}

// Status + guardrail text for the ChatGPT-subscription (Codex OAuth) block.
function buildCodexConnectionDescription(extensionAPI) {
  const status = deps.getCodexAuthStatus ? deps.getCodexAuthStatus(extensionAPI) : { connected: false };
  let statusLine;
  if (status.dead) {
    statusLine = `Auth expired (${status.deadReason || "refresh failed"}) — reconnect required.`;
  } else if (status.connected) {
    statusLine = `Connected${status.email ? ` as ${status.email}` : ""}. Select "openai-codex" as your LLM Provider above to use it.`;
  } else {
    statusLine = "Not connected.";
  }
  return `${statusLine} EXPERIMENTAL — routes GPT calls through your ChatGPT Plus/Pro subscription via OpenAI's Codex device sign-in instead of API billing. `
    + "Grey-area, best-effort path: OpenAI could restrict it at any time, and your plan's weekly usage caps apply. "
    + "Keep an API key configured — Chief of Staff falls back to API-key providers automatically if subscription auth fails.";
}

function getModelSmokeSummary(extensionAPI) {
  const raw = extensionAPI?.settings?.get?.(deps.SETTINGS_KEYS.llmModelSmokeResults);
  let report = raw;
  if (typeof raw === "string") {
    try { report = JSON.parse(raw); } catch { report = null; }
  }
  if (deps.summariseModelSmokeResults) return deps.summariseModelSmokeResults(report);
  return report ? "LLM model check results are available." : "Not checked yet. Run command palette → Chief of Staff: Check LLM Model Availability.";
}

// ── Main config builder ─────────────────────────────────────────────────────

export function buildSettingsConfig(extensionAPI) {
  const showIntegrations = ensureSettingBool(extensionAPI, SETTINGS_SHOW_INTEGRATIONS, false);
  const showAdvanced = ensureSettingBool(extensionAPI, SETTINGS_SHOW_ADVANCED, false);
  const advisorEnabled = ensureSettingBool(extensionAPI, deps.SETTINGS_KEYS.advisorEnabled, false);

  // --- Tier 1: Essential (always visible) -----------------------------------
  const settings = [
    {
      id: deps.SETTINGS_KEYS.userName,
      name: "Your Name",
      description: "How Chief of Staff addresses you.",
      action: {
        type: "input",
        value: deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.userName, ""),
        placeholder: "Your name"
      }
    },
    {
      id: deps.SETTINGS_KEYS.assistantName,
      name: "Assistant Name",
      description: "Display name used in the chat panel and toasts. Defaults to \"Chief of Staff\".",
      action: {
        type: "input",
        value: deps.getAssistantDisplayName(extensionAPI),
        placeholder: deps.DEFAULT_ASSISTANT_NAME
      }
    },
    {
      id: deps.SETTINGS_KEYS.llmProvider,
      name: "LLM Provider",
      description: "Primary AI provider. If this provider fails, Chief of Staff automatically falls back to other providers you have keys for. Custom providers (LM Studio, Ollama, etc.) appear here once configured below — with their display name if set.",
      action: {
        type: "select",
        items: buildProviderSelectItems(extensionAPI),
        value: buildProviderSelectValue(extensionAPI)
      }
    },
    {
      id: deps.SETTINGS_KEYS.llmModelSmokeResults,
      name: "LLM Model Availability",
      description: `${getModelSmokeSummary(extensionAPI)} This check sends tiny prompts to each configured provider/tier.`,
      action: {
        type: "button",
        content: "Run check",
        onClick: async () => {
          if (deps.runModelAvailabilitySmokeTest) {
            await deps.runModelAvailabilitySmokeTest(extensionAPI);
          }
        },
      },
    },
    {
      id: deps.SETTINGS_KEYS.anthropicApiKey,
      name: "Anthropic API Key",
      description: "Get yours at console.anthropic.com. Used for Claude models and as a failover provider.",
      action: {
        type: "input",
        value: deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.anthropicApiKey, ""),
        placeholder: "sk-ant-..."
      }
    },
    {
      id: deps.SETTINGS_KEYS.openaiApiKey,
      name: "OpenAI API Key",
      description: "Get yours at platform.openai.com. Used for GPT models and as a failover provider.",
      action: {
        type: "input",
        value: deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.openaiApiKey, "") || deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.llmApiKey, ""),
        placeholder: "sk-..."
      }
    },
    {
      id: "openai-codex-connection",
      name: "ChatGPT Subscription (EXPERIMENTAL)",
      description: buildCodexConnectionDescription(extensionAPI),
      action: {
        type: "button",
        content: deps.getCodexAuthStatus?.(extensionAPI)?.connected ? "Disconnect" : "Connect",
        onClick: async () => {
          const status = deps.getCodexAuthStatus?.(extensionAPI);
          if (status?.connected) {
            if (deps.disconnectCodex) deps.disconnectCodex(extensionAPI);
          } else if (deps.connectCodex) {
            await deps.connectCodex(extensionAPI);
          }
          remountSettingsPanel(extensionAPI);
        },
      },
    },
    {
      id: deps.SETTINGS_KEYS.geminiApiKey,
      name: "Google Gemini API Key",
      description: "Get yours at aistudio.google.com. Used for Gemini models and as a failover provider.",
      action: {
        type: "input",
        value: deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.geminiApiKey, ""),
        placeholder: "AIza..."
      }
    },
    {
      id: deps.SETTINGS_KEYS.mistralApiKey,
      name: "Mistral API Key",
      description: "Get yours at console.mistral.ai. Used for Mistral models and as a failover provider.",
      action: {
        type: "input",
        value: deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.mistralApiKey, ""),
        placeholder: "sk-..."
      }
    },
    {
      id: deps.SETTINGS_KEYS.groqApiKey,
      name: "Groq API Key",
      description: "Get yours at console.groq.com. Requires a paid plan (Dev tier or above) — the free tier's 12K TPM limit is too low. Used for Llama models via Groq's fast inference and as a failover provider.",
      action: {
        type: "input",
        value: deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.groqApiKey, ""),
        placeholder: "gsk_..."
      }
    },
    {
      id: deps.SETTINGS_KEYS.grokApiKey,
      name: "Grok API Key (xAI)",
      description: "Get yours at console.x.ai. Used for Grok models and as a failover provider.",
      action: {
        type: "input",
        value: deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.grokApiKey, ""),
        placeholder: "xai-..."
      }
    },
    {
      id: deps.SETTINGS_KEYS.kimiApiKey,
      name: "Kimi API Key (Moonshot)",
      description: "Get yours at platform.moonshot.ai (platform.kimi.ai). Uses Moonshot's OpenAI-compatible API as a failover provider — not the coding/Anthropic host.",
      action: {
        type: "input",
        value: deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.kimiApiKey, ""),
        placeholder: "sk-..."
      }
    },
    {
      id: deps.SETTINGS_KEYS.kimiCodingApiKey,
      name: "Kimi Code API Key",
      description: "Get yours at kimi.com/code. OpenAI-compatible host api.kimi.com/coding/v1 — this is NOT the Moonshot key. A key pasted into the Moonshot field above that starts with sk-kimi will be reused here automatically.",
      action: {
        type: "input",
        value: deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.kimiCodingApiKey, ""),
        placeholder: "sk-..."
      }
    },
    {
      id: deps.SETTINGS_KEYS.deepseekApiKey,
      name: "DeepSeek API Key",
      description: "Get yours at platform.deepseek.com. Used for DeepSeek chat and reasoner models via DeepSeek's OpenAI-compatible API.",
      action: {
        type: "input",
        value: deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.deepseekApiKey, ""),
        placeholder: "sk-..."
      }
    },
    {
      id: deps.SETTINGS_KEYS.ollamaApiKey,
      name: "Ollama API Key",
      description: "Your Ollama Cloud key from ollama.com. Leave blank for local Ollama (a local server needs no key).",
      action: {
        type: "input",
        value: deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.ollamaApiKey, ""),
        placeholder: "ollama-cloud-key"
      }
    },
    {
      id: deps.SETTINGS_KEYS.ollamaBaseUrl,
      name: "Ollama Base URL",
      description: "Ollama OpenAI-compatible base URL ending at /v1. Default: Ollama Cloud (https://ollama.com/v1). For a local server use http://127.0.0.1:11434/v1 — localhost calls go direct (no CORS proxy), remote calls go through the Roam CORS proxy.",
      action: {
        type: "input",
        value: deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.ollamaBaseUrl, ""),
        placeholder: "https://ollama.com/v1"
      }
    },
    {
      id: deps.SETTINGS_KEYS.ollamaMiniModel,
      name: "Ollama Mini Model (optional override)",
      description: "Model id used for the mini tier when the Ollama provider is selected. Leave blank to use the default (deepseek-v4-flash on Ollama Cloud).",
      action: {
        type: "input",
        value: deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.ollamaMiniModel, ""),
        placeholder: "deepseek-v4-flash"
      }
    },
    {
      id: deps.SETTINGS_KEYS.ollamaPowerModel,
      name: "Ollama Power Model (optional override)",
      description: "Model id used for the power tier. Leave blank to use the default (deepseek-v4-pro).",
      action: {
        type: "input",
        value: deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.ollamaPowerModel, ""),
        placeholder: "deepseek-v4-pro"
      }
    },
    {
      id: deps.SETTINGS_KEYS.ollamaLudicrousModel,
      name: "Ollama Ludicrous Model (optional override)",
      description: "Model id used for the ludicrous tier. Leave blank to use the default (glm-5.2).",
      action: {
        type: "input",
        value: deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.ollamaLudicrousModel, ""),
        placeholder: "glm-5.2"
      }
    },
  ];

  // --- Tier 2 toggle: Integrations ------------------------------------------
  settings.push({
    id: SETTINGS_SHOW_INTEGRATIONS,
    name: "Show Integration Settings",
    description: "Composio (external tools like Gmail, Calendar, GitHub), Local MCP server connections, and Remote MCP servers.",
    action: {
      type: "switch",
      value: showIntegrations,
      onChange: () => rebuildSettingsPanel(extensionAPI),
    }
  });

  if (showIntegrations) {
    settings.push(
      {
        id: deps.SETTINGS_KEYS.composioMcpUrl,
        name: "CORS Proxy URL",
        description: "Base URL of your roam-mcp-proxy Cloudflare Worker. Format: https://your-proxy.workers.dev — one deployment serves both Composio and web page fetching. Redeploy the worker if you set it up before v2 (v2 allows Cloudflare Browser Rendering out of the box). Leave blank if you use neither.",
        action: {
          type: "input",
          value: getComposioSettingOrBlank(extensionAPI, deps.SETTINGS_KEYS.composioMcpUrl),
          placeholder: "https://your-proxy.workers.dev",
        }
      },
      {
        id: deps.SETTINGS_KEYS.composioApiKey,
        name: "Composio API Key",
        description: "Your Composio API key (starts with \"ak_\"). Found at app.composio.dev under Settings → API Keys. Leave blank if not using Composio.",
        action: {
          type: "input",
          value: getComposioSettingOrBlank(extensionAPI, deps.SETTINGS_KEYS.composioApiKey),
          placeholder: "ak_..."
        }
      },
      {
        id: deps.SETTINGS_KEYS.localMcpPorts,
        name: "Local MCP Server Ports",
        description: "Comma-separated localhost ports where supergateway is exposing your MCP servers as SSE. Each port should be a running supergateway instance. Example: 8003,8004",
        action: {
          type: "input",
          value: deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.localMcpPorts, ""),
          placeholder: "8003,8004"
        }
      }
    );

    // ── Remote MCP servers — progressive disclosure ──────────────────────────
    // Count select reveals per-server URL / name / header / token fields.
    const MAX_REMOTE_MCP_SERVERS = 10;
    const rawCount = extensionAPI.settings.get(deps.SETTINGS_KEYS.remoteMcpCount);
    const remoteMcpCount = Math.min(MAX_REMOTE_MCP_SERVERS, Math.max(0, parseInt(rawCount, 10) || 0));

    settings.push({
      id: deps.SETTINGS_KEYS.remoteMcpCount,
      name: "Remote MCP Servers",
      description: "Number of remote StreamableHTTP MCP servers to connect. Each server's URL, display name, and authentication are configured in the fields that appear below.",
      action: {
        type: "select",
        items: Array.from({ length: MAX_REMOTE_MCP_SERVERS + 1 }, (_, i) => String(i)),
        value: String(remoteMcpCount),
        onChange: (value) => {
          const next = Math.min(MAX_REMOTE_MCP_SERVERS, Math.max(0, parseInt(value, 10) || 0));
          try { extensionAPI.settings.set(deps.SETTINGS_KEYS.remoteMcpCount, next); } catch { }
          rebuildSettingsPanel(extensionAPI);
        }
      }
    });

    for (let i = 1; i <= remoteMcpCount; i++) {
      settings.push({
        id: `remote-mcp-${i}-url`,
        name: `Remote Server ${i} — URL`,
        description: "Full StreamableHTTP endpoint (must be https://). The extension will connect on load and make its tools available to the agent.",
        action: {
          type: "input",
          value: deps.getSettingString(extensionAPI, `remote-mcp-${i}-url`, ""),
          placeholder: "https://my-server.example.com/mcp",
          onChange: (evt) => {
            const v = String(evt?.target?.value ?? evt ?? "").trim();
            try { extensionAPI.settings.set(`remote-mcp-${i}-url`, v); } catch { }
            if (deps.invalidateRemoteMcpToolsCache) deps.invalidateRemoteMcpToolsCache();
          }
        }
      });
      settings.push({
        id: `remote-mcp-${i}-name`,
        name: `Remote Server ${i} — Display name`,
        description: "Optional friendly label shown in the system prompt and toasts. Falls back to the server's own name reported during the MCP handshake.",
        action: {
          type: "input",
          value: deps.getSettingString(extensionAPI, `remote-mcp-${i}-name`, ""),
          placeholder: "e.g. Open Brain",
          onChange: (evt) => {
            const v = String(evt?.target?.value ?? evt ?? "").trim();
            try { extensionAPI.settings.set(`remote-mcp-${i}-name`, v); } catch { }
            if (deps.invalidateRemoteMcpToolsCache) deps.invalidateRemoteMcpToolsCache();
          }
        }
      });
      // ── Auth type selector (token / oauth) ──
      // Stored values are "token" and "oauth" (display-friendly).
      // getRemoteMcpServers() maps these to internal authType values.
      // Migrate legacy stored values on read.
      const rawAuthType = deps.getSettingString(extensionAPI, `remote-mcp-${i}-auth-type`, "token") || "token";
      const authType = rawAuthType === "mcp-oauth" ? "oauth"    // migrate legacy
                     : rawAuthType === "static"    ? "token"    // migrate legacy
                     : rawAuthType;
      // Persist the migrated value so Roam's select displays correctly
      if (authType !== rawAuthType) {
        try { extensionAPI.settings.set(`remote-mcp-${i}-auth-type`, authType); } catch { }
      }
      settings.push({
        id: `remote-mcp-${i}-auth-type`,
        name: `Remote Server ${i} — Auth method`,
        description: "Token: paste an API key or bearer token. OAuth: automatic sign-in via the server's OAuth flow (GitHub, Notion, Linear, Sentry, etc.).",
        action: {
          type: "select",
          items: ["token", "oauth"],
          value: authType,
          onChange: (value) => {
            try { extensionAPI.settings.set(`remote-mcp-${i}-auth-type`, value || "token"); } catch { }
            rebuildSettingsPanel(extensionAPI);
          }
        }
      });

      if (authType === "oauth") {
        // OAuth mode: auto-discovery via MCP OAuth 2.1 spec
        const serverUrl = deps.getSettingString(extensionAPI, `remote-mcp-${i}-url`, "").trim();
        if (serverUrl && deps.getMcpOAuthStatus) {
          const mcpStatus = deps.getMcpOAuthStatus(serverUrl);
          const statusText = mcpStatus.connected
            ? (mcpStatus.isExpired ? "Connected (token expired — will auto-refresh)" : "Connected")
            : "Not connected — use command palette: Chief of Staff: Connect Remote OAuth Server";
          settings.push({
            id: `remote-mcp-${i}-oauth-status`,
            name: `Remote Server ${i} — OAuth status`,
            description: statusText,
            action: { type: "input", placeholder: "", onChange: () => {} },
          });
        }
        settings.push({
          id: `remote-mcp-${i}-mcp-oauth-client-id`,
          name: `Remote Server ${i} — Client ID (optional)`,
          description: "Only needed for servers that block dynamic client registration (e.g. GitHub, Atlassian). Register an OAuth app in the provider's developer console, set the redirect URI to the Worker callback URL, then enter the client ID here.",
          action: {
            type: "input",
            value: deps.getSettingString(extensionAPI, `remote-mcp-${i}-mcp-oauth-client-id`, ""),
            placeholder: "Leave blank for auto-registration",
          }
        });
        settings.push({
          id: `remote-mcp-${i}-mcp-oauth-client-secret`,
          name: `Remote Server ${i} — Client Secret (optional)`,
          description: "Required only if the server demands a client secret (confidential client). Most MCP OAuth servers use public clients — leave blank.",
          action: {
            type: "input",
            value: deps.getSettingString(extensionAPI, `remote-mcp-${i}-mcp-oauth-client-secret`, ""),
            placeholder: "Leave blank for public client",
          }
        });
      } else {
        // Static mode: existing header + token fields
        settings.push({
          id: `remote-mcp-${i}-header`,
          name: `Remote Server ${i} — Auth header name`,
          description: "Header name for authentication (e.g. x-brain-key, Authorization). Leave blank if the server needs no authentication.",
          action: {
            type: "input",
            value: deps.getSettingString(extensionAPI, `remote-mcp-${i}-header`, ""),
            placeholder: "x-api-key",
            onChange: (evt) => {
              const v = String(evt?.target?.value ?? evt ?? "").trim();
              try { extensionAPI.settings.set(`remote-mcp-${i}-header`, v); } catch { }
            }
          }
        });
        settings.push({
          id: `remote-mcp-${i}-token`,
          name: `Remote Server ${i} — Auth token`,
          description: "Token or secret value. Stored in Roam Depot (local IndexedDB only). Redacted from all debug logs and never sent to any service other than this server.",
          action: {
            type: "input",
            value: deps.getSettingString(extensionAPI, `remote-mcp-${i}-token`, ""),
            placeholder: "your-token",
            onChange: (evt) => {
              const v = String(evt?.target?.value ?? evt ?? "").trim();
              try { extensionAPI.settings.set(`remote-mcp-${i}-token`, v); } catch { }
            }
          }
        });
      }
    }

    // ── Web Fetch (Cloudflare Browser Rendering) ──────────────────────────────
    settings.push(
      {
        id: deps.SETTINGS_KEYS.cloudflareApiToken,
        name: "Cloudflare API Token",
        description: "Optional. Enables the roam_web_fetch tool for fetching web pages as Markdown. Create a token with Browser Rendering Edit permission at dash.cloudflare.com/profile/api-tokens.",
        action: {
          type: "input",
          value: deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.cloudflareApiToken, ""),
          placeholder: "v1.0-..."
        }
      },
      {
        id: deps.SETTINGS_KEYS.cloudflareAccountId,
        name: "Cloudflare Account ID",
        description: "Required for web fetch. Found on your Cloudflare dashboard overview page.",
        action: {
          type: "input",
          value: deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.cloudflareAccountId, ""),
          placeholder: "abc123..."
        }
      }
    );

    // ── Custom LLM providers (LM Studio, Ollama, OpenAI-compatible) ──────────
    // Count select reveals per-slot URL / model / auth fields. Mirrors the
    // remote-mcp-count pattern above.
    const MAX_CUSTOM_LLM_SLOTS = 3;
    const rawCustomCount = extensionAPI.settings.get(deps.SETTINGS_KEYS.customLlmCount);
    const customLlmCount = Math.min(MAX_CUSTOM_LLM_SLOTS, Math.max(0, parseInt(rawCustomCount, 10) || 0));

    settings.push({
      id: deps.SETTINGS_KEYS.customLlmCount,
      name: "Custom LLM Providers",
      description: "Number of custom OpenAI-compatible LLM endpoints (LM Studio, Ollama, OpenRouter, vLLM, etc.). Each slot's base URL, model IDs, and optional API key are configured below.",
      action: {
        type: "select",
        items: Array.from({ length: MAX_CUSTOM_LLM_SLOTS + 1 }, (_, i) => String(i)),
        value: String(customLlmCount),
        onChange: (value) => {
          const next = Math.min(MAX_CUSTOM_LLM_SLOTS, Math.max(0, parseInt(value, 10) || 0));
          try { extensionAPI.settings.set(deps.SETTINGS_KEYS.customLlmCount, next); } catch { }
          rebuildSettingsPanel(extensionAPI);
        }
      }
    });

    for (let i = 1; i <= customLlmCount; i++) {
      settings.push({
        id: `custom-llm-${i}-name`,
        name: `Custom Provider ${i} — Display name`,
        description: "Optional friendly label, shown in the LLM Provider dropdown above and in toasts. Examples: \"LM Studio\", \"Ollama\", \"OpenRouter\". After renaming, close and re-open settings to see the dropdown update — Roam's select widget doesn't refresh its displayed selection in-place.",
        action: {
          type: "input",
          value: deps.getSettingString(extensionAPI, `custom-llm-${i}-name`, ""),
          placeholder: "e.g. LM Studio",
          onChange: (evt) => {
            const v = String(evt?.target?.value ?? evt ?? "").trim();
            try { extensionAPI.settings.set(`custom-llm-${i}-name`, v); } catch { }
            // If this slot is the saved primary, update llm-provider to the new
            // compound label so the dropdown matches on next settings open.
            try {
              const saved = String(extensionAPI.settings.get(deps.SETTINGS_KEYS.llmProvider) || "").toLowerCase();
              const isThisSlot = saved === `custom-${i}` || saved.startsWith(`custom-${i} `) || saved.startsWith(`custom-${i}—`);
              if (isThisSlot) {
                const newLabel = v ? `custom-${i} — ${v}` : `custom-${i}`;
                extensionAPI.settings.set(deps.SETTINGS_KEYS.llmProvider, newLabel);
              }
            } catch { /* ignore */ }
            // No rebuild — Roam's select widget caches its displayed selection
            // across panel.create() rebuilds, so the dropdown only refreshes on
            // close+reopen. The migration in onload handles the sync on reload.
          }
        }
      });
      settings.push({
        id: `custom-llm-${i}-base-url`,
        name: `Custom Provider ${i} — Base URL`,
        description: "Server base URL ending at /v1 (or equivalent). The /chat/completions path is appended automatically. Local servers must enable CORS themselves: LM Studio → Developer tab → \"Enable CORS\" → restart server; Ollama → run with OLLAMA_ORIGINS=https://roamresearch.com. Remote servers usually work directly; if they have restrictive CORS, enable \"Route through proxy\" below (does NOT work for localhost). Examples: http://localhost:1234/v1 (LM Studio), http://localhost:11434/v1 (Ollama), https://openrouter.ai/api/v1.",
        action: {
          type: "input",
          value: deps.getSettingString(extensionAPI, `custom-llm-${i}-base-url`, ""),
          placeholder: "http://localhost:1234/v1",
          onChange: (evt) => {
            const v = String(evt?.target?.value ?? evt ?? "").trim();
            try { extensionAPI.settings.set(`custom-llm-${i}-base-url`, v); } catch { }
            rebuildSettingsPanel(extensionAPI);
          }
        }
      });
      settings.push({
        id: `custom-llm-${i}-api-key`,
        name: `Custom Provider ${i} — API key (optional)`,
        description: "Bearer token sent in the Authorization header. Leave blank for local servers (LM Studio, Ollama) that ignore auth. Required for remote services like OpenRouter.",
        action: {
          type: "input",
          value: deps.getSettingString(extensionAPI, `custom-llm-${i}-api-key`, ""),
          placeholder: "sk-... (leave blank for local servers)",
          onChange: (evt) => {
            const v = String(evt?.target?.value ?? evt ?? "").trim();
            try { extensionAPI.settings.set(`custom-llm-${i}-api-key`, v); } catch { }
          }
        }
      });
      settings.push({
        id: `custom-llm-${i}-mini-model`,
        name: `Custom Provider ${i} — Model (mini tier)`,
        description: "Model ID used for the default mini tier. Required. Look up the exact ID from the server's /v1/models endpoint or the provider's docs.",
        action: {
          type: "input",
          value: deps.getSettingString(extensionAPI, `custom-llm-${i}-mini-model`, ""),
          placeholder: "e.g. llama3.2 or meta-llama/llama-3.2-3b-instruct",
          onChange: (evt) => {
            const v = String(evt?.target?.value ?? evt ?? "").trim();
            try { extensionAPI.settings.set(`custom-llm-${i}-mini-model`, v); } catch { }
          }
        }
      });
      settings.push({
        id: `custom-llm-${i}-power-model`,
        name: `Custom Provider ${i} — Model (power tier)`,
        description: "Model ID used for the power tier (skill execution, complex reasoning). Falls back to the mini model if blank.",
        action: {
          type: "input",
          value: deps.getSettingString(extensionAPI, `custom-llm-${i}-power-model`, ""),
          placeholder: "Leave blank to use mini model",
          onChange: (evt) => {
            const v = String(evt?.target?.value ?? evt ?? "").trim();
            try { extensionAPI.settings.set(`custom-llm-${i}-power-model`, v); } catch { }
          }
        }
      });
      settings.push({
        id: `custom-llm-${i}-ludicrous-model`,
        name: `Custom Provider ${i} — Model (ludicrous tier)`,
        description: "Model ID used when ludicrous mode is enabled. Falls back to the power model if blank.",
        action: {
          type: "input",
          value: deps.getSettingString(extensionAPI, `custom-llm-${i}-ludicrous-model`, ""),
          placeholder: "Leave blank to use power model",
          onChange: (evt) => {
            const v = String(evt?.target?.value ?? evt ?? "").trim();
            try { extensionAPI.settings.set(`custom-llm-${i}-ludicrous-model`, v); } catch { }
          }
        }
      });
      // Switch defaults: seed false on first render so Roam's switch UI matches
      // the in-code default (per the earned rule about switch state in CLAUDE.md).
      const failoverKey = `custom-llm-${i}-include-in-failover`;
      if (extensionAPI.settings.get(failoverKey) === undefined) {
        try { extensionAPI.settings.set(failoverKey, false); } catch { }
      }
      settings.push({
        id: failoverKey,
        name: `Custom Provider ${i} — Include in failover`,
        description: "When ON, this slot is appended to the end of every failover chain. When OFF (default), it is only used when explicitly selected as the primary provider.",
        action: {
          type: "switch",
          value: ensureSettingBool(extensionAPI, failoverKey, false),
          onChange: () => { /* auto-persisted */ }
        }
      });
      const noFailoverKey = `custom-llm-${i}-no-failover`;
      if (extensionAPI.settings.get(noFailoverKey) === undefined) {
        try { extensionAPI.settings.set(noFailoverKey, false); } catch { }
      }
      settings.push({
        id: noFailoverKey,
        name: `Custom Provider ${i} — Privacy mode (no failover)`,
        description: "When this slot is the primary provider and a request fails, surface the error instead of falling over to another provider. Use this if you want to keep all traffic local.",
        action: {
          type: "switch",
          value: ensureSettingBool(extensionAPI, noFailoverKey, false),
          onChange: () => { /* auto-persisted */ }
        }
      });
      const useProxyKey = `custom-llm-${i}-use-proxy`;
      if (extensionAPI.settings.get(useProxyKey) === undefined) {
        try { extensionAPI.settings.set(useProxyKey, false); } catch { }
      }
      settings.push({
        id: useProxyKey,
        name: `Custom Provider ${i} — Route through Roam CORS proxy`,
        description: "Escape hatch for remote (https://) endpoints with restrictive CORS. Does NOT work for localhost — the proxy runs on Cloudflare and cannot reach your machine; for local servers you must enable CORS on the server itself. Local URLs (localhost, 127.0.0.1) always go direct regardless of this setting.",
        action: {
          type: "switch",
          value: ensureSettingBool(extensionAPI, useProxyKey, false),
          onChange: () => { /* auto-persisted */ }
        }
      });
      const disableToolsKey = `custom-llm-${i}-disable-tool-calling`;
      if (extensionAPI.settings.get(disableToolsKey) === undefined) {
        try { extensionAPI.settings.set(disableToolsKey, false); } catch { }
      }
      settings.push({
        id: disableToolsKey,
        name: `Custom Provider ${i} — Disable tool calling`,
        description: "Required for some free OpenRouter models and small local models that don't support tool calling — they 404 when 'tools' is in the request body. With this ON the agent works in chat-only mode (no Roam reads/writes, no MCP). Off by default; most modern models support tools. OpenRouter filter for tools-capable models: https://openrouter.ai/models?supported_parameters=tools",
        action: {
          type: "switch",
          value: ensureSettingBool(extensionAPI, disableToolsKey, false),
          onChange: () => { /* auto-persisted */ }
        }
      });
    }
  }

  // --- Tier 2.5 toggle: Extension Tools --------------------------------------
  const showExtTools = ensureSettingBool(extensionAPI, SETTINGS_SHOW_EXTENSION_TOOLS, false);
  settings.push({
    id: SETTINGS_SHOW_EXTENSION_TOOLS,
    name: "Show Extension Tools",
    description: "Control which Roam extensions can provide tools to Chief of Staff.",
    action: {
      type: "switch",
      value: showExtTools,
      onChange: () => rebuildSettingsPanel(extensionAPI),
    }
  });

  if (showExtTools) {
    const extToolsRegistry = deps.getExtensionToolsRegistry();
    const extToolsConfig = deps.getExtToolsConfig(extensionAPI);
    const extEntries = Object.entries(extToolsRegistry)
      .filter(([, ext]) => ext && Array.isArray(ext.tools) && ext.tools.length)
      .sort(([a], [b]) => a.localeCompare(b));

    if (!extEntries.length) {
      
      settings.push({
        id: "ext-tools-none",
        name: "No extensions detected",
        description: "No installed extensions have registered tools yet. Install extensions that support the Extension Tools API.",
        action: {
          type: "button",
          content: "Refresh",
          onClick: () => rebuildSettingsPanel(extensionAPI),
        }
      });
      
    } else {
      for (const [extKey, ext] of extEntries) {
        const label = String(ext.name || extKey).trim();
        const toolCount = ext.tools.filter(t => t?.name && typeof t.execute === "function").length;
        const isEnabled = !!extToolsConfig[extKey]?.enabled;
        // Sync Roam's auto-persisted switch value with our JSON config so the
        // toggle renders correctly. Without this, Roam may display its own stored
        // value (which defaults to false for new switches) instead of our config.
        const switchId = `ext-tool-${extKey}`;
        extensionAPI.settings.set(switchId, isEnabled);
        settings.push({
          id: switchId,
          name: label,
          description: `${toolCount} tool${toolCount !== 1 ? "s" : ""}: ${ext.tools.filter(t => t?.name).map(t => t.name).join(", ")}`,
          action: {
            type: "switch",
            value: isEnabled,
            onChange: (evt) => {
              const nextEnabled = normaliseSwitchValue(evt, !isEnabled);
              const cfg = deps.getExtToolsConfig(extensionAPI);
              cfg[extKey] = { enabled: nextEnabled };
              deps.setExtToolsConfig(extensionAPI, cfg);
              deps.clearExternalExtensionToolsCache();
              deps.scheduleRuntimeAibomRefresh(120);
              rebuildSettingsPanel(extensionAPI);
            }
          }
        });
      }
    }
  }

  // --- Tier 3 toggle: Advanced ----------------------------------------------
  settings.push({
    id: SETTINGS_SHOW_ADVANCED,
    name: "Show Advanced Settings",
    description: "Debug logging, dry run mode, PII scrubbing, and ludicrous mode failover.",
    action: {
      type: "switch",
      value: showAdvanced,
      onChange: () => rebuildSettingsPanel(extensionAPI),
    }
  });

  if (showAdvanced) {
    settings.push(
      {
        id: deps.SETTINGS_KEYS.responseVerbosity,
        name: "Response Verbosity",
        description: "Controls how verbose assistant responses are. Concise saves output tokens (cheaper), Detailed allows thorough explanations (more expensive). Only affects the mini tier — power and ludicrous tiers have their own token budgets.",
        action: {
          type: "select",
          items: ["concise", "standard", "detailed"],
          value: deps.getResponseVerbosity(extensionAPI)
        }
      },
      {
        id: deps.SETTINGS_KEYS.debugLogging,
        name: "Debug Logging",
        description: "Enable verbose console logging. Useful for troubleshooting tool calls, failover, and connection issues.",
        action: {
          type: "switch",
          value: deps.isDebugLoggingEnabled(extensionAPI)
        }
      },
      {
        id: deps.SETTINGS_KEYS.dryRunMode,
        name: "Dry Run (one-shot)",
        description: "Simulates the next mutating tool call — shows what would happen without writing to your graph. Auto-disables after one use. Approval prompt is still shown.",
        action: {
          type: "switch",
          value: deps.isDryRunEnabled(extensionAPI)
        }
      },
      {
        id: deps.SETTINGS_KEYS.ludicrousModeEnabled,
        name: "Ludicrous Mode Failover",
        description: "Allow escalation to top-tier models (Claude Opus, GPT-5.2) when all power-tier providers fail. These models are significantly more expensive — use with caution.",
        action: {
          type: "switch",
          value: deps.getSettingBool(extensionAPI, deps.SETTINGS_KEYS.ludicrousModeEnabled, false)
        }
      },
      {
        id: deps.SETTINGS_KEYS.piiScrubEnabled,
        name: "PII Scrubbing",
        description: "Automatically redact emails, phone numbers, credit cards, SSNs, and other personal data before sending to LLM APIs. Disable only if your workflow requires full data fidelity.",
        action: {
          type: "switch",
          value: deps.getSettingBool(extensionAPI, deps.SETTINGS_KEYS.piiScrubEnabled, true)
        }
      },
      {
        id: deps.SETTINGS_KEYS.postWriteShortCircuit,
        name: "End run after a single successful write",
        description: "ON matches current Chief of Staff: a lone successful write ends the run with a confirmation. OFF lets the model take another turn after one write, so skills that need several graph writes can finish.",
        action: {
          type: "switch",
          value: deps.getSettingBool(extensionAPI, deps.SETTINGS_KEYS.postWriteShortCircuit, true)
        }
      },
      {
        id: deps.SETTINGS_KEYS.skillContinueAfterWrite,
        name: "Continue after a write during a skill run",
        description: "ON: a skill run may take another turn after one successful write, even if End run after a single successful write is ON. OFF: skills obey that switch. Casual chat is unchanged.",
        action: {
          type: "switch",
          value: deps.getSettingBool(extensionAPI, deps.SETTINGS_KEYS.skillContinueAfterWrite, true)
        }
      },
      {
        id: deps.SETTINGS_KEYS.scheduleParent,
        name: "Timed block parent",
        description: "Page title or block uid that owns new timed blocks. Empty = today's daily page (Nautilus Log child if present, else a Schedule heading). Any graph.",
        action: {
          type: "input",
          value: deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.scheduleParent, ""),
          placeholder: "e.g. Team Plan"
        }
      },
      {
        id: deps.SETTINGS_KEYS.scheduleSandboxPage,
        name: "Timed block sandbox page",
        description: "When the user message contains [sandbox], timed blocks go under this page's timed block parent. Default: COS Daily Plan Sandbox.",
        action: {
          type: "input",
          value: deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.scheduleSandboxPage, ""),
          placeholder: "COS Daily Plan Sandbox"
        }
      },
      {
        id: deps.SETTINGS_KEYS.scheduleAllowOverlap,
        name: "Allow overlapping timed blocks",
        description: "OFF (default): a new timed block that overlaps a different one is refused unless the user asks to overlap (same time, during, in parallel). ON: overlapping writes are allowed even without that language. Same task still reschedules in place.",
        action: {
          type: "switch",
          value: deps.getSettingBool(extensionAPI, deps.SETTINGS_KEYS.scheduleAllowOverlap, false)
        }
      },
      {
        id: deps.SETTINGS_KEYS.autoApproveMode,
        name: "Auto mode",
        description: "off: every mutating tool still asks. graph: auto-approve reversible graph writes (create/update/todo/batch) after a passive toast; deletes, email, and money still ask. full: also auto-approve a single roam_delete_block; bulk deletes, page deletes, email, and money still ask. Injection and chat cannot change this.",
        action: {
          type: "select",
          items: ["off", "graph", "full"],
          value: (() => {
            const raw = deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.autoApproveMode, "off");
            return ["off", "graph", "full"].includes(raw) ? raw : "off";
          })()
        }
      },
      {
        id: deps.SETTINGS_KEYS.claimedActionEscalationAllProviders,
        name: "Escalate on claimed action with no tool call (all providers)",
        description: "ON means any mini-tier provider that repeatedly claims an action with no successful tool call escalates to power. OFF keeps the old Gemini-only trigger. Default ON.",
        action: {
          type: "switch",
          value: deps.getSettingBool(extensionAPI, deps.SETTINGS_KEYS.claimedActionEscalationAllProviders, true)
        }
      },
      {
        id: deps.SETTINGS_KEYS.agentMaxIterations,
        name: "Agent max iterations",
        description: "Caps agent-loop iterations for normal chat (not skills). Raise for weaker models that burn one iteration per tool call, or for long multi-write rearranges. Multi-write intents auto-boost to at least 32. 10–40, default 20.",
        action: {
          type: "input",
          value: deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.agentMaxIterations, "20"),
          placeholder: "20"
        }
      },
      {
        id: deps.SETTINGS_KEYS.skillMaxIterations,
        name: "Skill max iterations",
        description: "Caps agent-loop iterations when a skill or gathering guard is active. Weaker models that burn one iteration per tool call can raise this. 8–40, default 16.",
        action: {
          type: "input",
          value: deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.skillMaxIterations, "16"),
          placeholder: "16"
        }
      },
      {
        id: deps.SETTINGS_KEYS.dailySpendingCap,
        name: "Daily Spending Cap (USD)",
        description: "Maximum daily LLM API spend in USD. Agent execution halts when this limit is reached. Leave blank for no limit. Resets at midnight. Example: 1.00 = one dollar per day.",
        action: {
          type: "input",
          value: deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.dailySpendingCap, ""),
          placeholder: "e.g. 1.00"
        }
      },
      {
        id: deps.SETTINGS_KEYS.cosLinkedRefsFilter,
        name: "Hide COS Pages from Linked References",
        description: "Automatically removes Chief of Staff namespace pages from linked references on all non-COS pages. Applies once per page per session — manual filter changes are respected.",
        action: {
          type: "switch",
          value: deps.getSettingBool(extensionAPI, deps.SETTINGS_KEYS.cosLinkedRefsFilter, true)
        }
      },
      {
        id: deps.SETTINGS_KEYS.logUseLinkedDates,
        name: "Use Linked Dates in CoS Logs",
        description: "When enabled, internal CoS log entries (audit log, usage stats, eval scores, corrections, graph hygiene, skill-optimize) prefix each line with a [[Linked Date]]. Disable to write plain dates instead — keeps Daily Notes pages from accumulating linked references on mobile.",
        action: {
          type: "switch",
          value: deps.getSettingBool(extensionAPI, deps.SETTINGS_KEYS.logUseLinkedDates, true)
        }
      },
      {
        id: deps.SETTINGS_KEYS.auditLogRetentionDays,
        name: "Audit Log Retention (days)",
        description: "Automatically trim audit log entries older than this many days. Runs after each agent interaction. Leave blank or 0 to keep all entries indefinitely.",
        action: {
          type: "input",
          value: deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.auditLogRetentionDays, ""),
          placeholder: "e.g. 14"
        }
      },
      {
        id: deps.SETTINGS_KEYS.intentGateEnabled,
        name: "Intent Confidence Gate (Beta)",
        description: "Classify intent before running the agent loop. Ambiguous or high-risk requests trigger a confirmation step. Adds ~200–400ms and a small token cost per classified query. Default: off.",
        action: {
          type: "switch",
          value: deps.getSettingBool(extensionAPI, deps.SETTINGS_KEYS.intentGateEnabled, false)
        }
      },
      {
        id: deps.SETTINGS_KEYS.advisorEnabled,
        name: "Anthropic Advisor Tool (Beta)",
        description: "When running on Anthropic, lets the executor (Haiku/Sonnet) consult Opus on hard decisions within a single API call. Costs more per consultation but typically reduces overall agent loop cost and improves quality. Anthropic-only.",
        action: {
          type: "switch",
          value: advisorEnabled,
          onChange: () => rebuildSettingsPanel(extensionAPI),
        }
      }
    );
    if (advisorEnabled) {
      settings.push(
        {
          id: deps.SETTINGS_KEYS.advisorMaxUses,
          name: "Advisor Max Uses Per Run",
          description: "Maximum number of advisor consultations per agent run. 1–5 recommended. Each consultation calls Opus and is billed at Opus rates.",
          action: {
            type: "input",
            value: deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.advisorMaxUses, "2"),
            placeholder: "2"
          }
        },
        {
          id: deps.SETTINGS_KEYS.advisorMiniOnly,
          name: "Restrict Advisor to Mini Tier",
          description: "When on, advisor is only injected on mini tier runs (the highest-leverage case). Turn off to also use it on power tier — smaller cost saving but still useful.",
          action: {
            type: "switch",
            value: deps.getSettingBool(extensionAPI, deps.SETTINGS_KEYS.advisorMiniOnly, true)
          }
        }
      );
    }
  }

  // --- Tier 4 toggle: Automatic Actions ----------------------------------------
  const showAutoActions = ensureSettingBool(extensionAPI, SETTINGS_SHOW_AUTOMATIC_ACTIONS, false);
  settings.push({
    id: SETTINGS_SHOW_AUTOMATIC_ACTIONS,
    name: "Show Automatic Actions",
    description: "Background features that run when Roam is idle. Each feature has its own toggle below. All are off by default.",
    action: {
      type: "switch",
      value: showAutoActions,
      onChange: () => rebuildSettingsPanel(extensionAPI),
    }
  });

  if (showAutoActions) {
    settings.push(
      {
        id: deps.SETTINGS_KEYS.correctionCaptureEnabled,
        name: "Correction Capture",
        description: "Detect when you edit COS outputs on your daily page and record the differences on [[Chief of Staff/Corrections]]. Runs during idle time only — no impact on active use.",
        action: {
          type: "switch",
          value: deps.getSettingBool(extensionAPI, deps.SETTINGS_KEYS.correctionCaptureEnabled, false),
          onChange: () => {
            // Defer to let Roam persist the new value, then sync the idle task
            setTimeout(() => {
              if (typeof deps.onCorrectionCaptureToggle === "function") {
                deps.onCorrectionCaptureToggle(deps.getSettingBool(extensionAPI, deps.SETTINGS_KEYS.correctionCaptureEnabled, false));
              }
            }, 100);
          }
        }
      },
      {
        id: deps.SETTINGS_KEYS.graphHygieneOrphansEnabled,
        name: "Orphan Page Detection",
        description: "Periodically scan for pages with zero incoming references. Results available via cos_get_orphan_pages tool and logged to [[Chief of Staff/Graph Hygiene]]. Runs during idle time only.",
        action: {
          type: "switch",
          value: deps.getSettingBool(extensionAPI, deps.SETTINGS_KEYS.graphHygieneOrphansEnabled, false),
          onChange: () => {
            setTimeout(() => {
              if (typeof deps.onGraphHygieneOrphansToggle === "function") {
                deps.onGraphHygieneOrphansToggle(deps.getSettingBool(extensionAPI, deps.SETTINGS_KEYS.graphHygieneOrphansEnabled, false));
              }
            }, 100);
          }
        }
      },
      {
        id: deps.SETTINGS_KEYS.graphHygieneStaleLinkEnabled,
        name: "Stale Link Detection",
        description: "Periodically scan for broken block references ((uid)) and page references [[Title]] pointing to deleted content. Results available via cos_get_stale_links tool and logged to [[Chief of Staff/Graph Hygiene]]. Runs during idle time only.",
        action: {
          type: "switch",
          value: deps.getSettingBool(extensionAPI, deps.SETTINGS_KEYS.graphHygieneStaleLinkEnabled, false),
          onChange: () => {
            setTimeout(() => {
              if (typeof deps.onGraphHygieneStaleLinkToggle === "function") {
                deps.onGraphHygieneStaleLinkToggle(deps.getSettingBool(extensionAPI, deps.SETTINGS_KEYS.graphHygieneStaleLinkEnabled, false));
              }
            }, 100);
          }
        }
      },
      {
        id: deps.SETTINGS_KEYS.synthesisEnabled,
        name: "Correction Synthesis",
        description: "Weekly deterministic pass over [[Chief of Staff/Corrections]]: repeated corrections become proposed memories on [[Chief of Staff/Synthesis]], and stale memory entries are flagged. Propose-only — nothing is written to memory without your approval. Needs Correction Capture enabled to have data to synthesise. Runs during idle time only.",
        action: {
          type: "switch",
          value: deps.getSettingBool(extensionAPI, deps.SETTINGS_KEYS.synthesisEnabled, false),
          onChange: () => {
            setTimeout(() => {
              if (typeof deps.onSynthesisToggle === "function") {
                deps.onSynthesisToggle(deps.getSettingBool(extensionAPI, deps.SETTINGS_KEYS.synthesisEnabled, false));
              }
            }, 100);
          }
        }
      },
      {
        id: deps.SETTINGS_KEYS.evalEnabled,
        name: "Post-Run Evaluation",
        description: "Automatic quality scoring after each agent interaction using an LLM judge. Produces 1-5 rubric scores plus binary pass/fail checks. Low scores or failed checks are routed to [[Chief of Staff/Review Queue]]. Adds roughly $0.001–0.003 per evaluated run.",
        action: {
          type: "switch",
          value: deps.getSettingBool(extensionAPI, deps.SETTINGS_KEYS.evalEnabled, false)
        }
      },
      {
        id: deps.SETTINGS_KEYS.evalSampleRate,
        name: "Evaluation Sample Rate",
        description: "Fraction of runs to evaluate (0.0–1.0). Use 1.0 to evaluate every run, 0.1 for 10% random sampling. Only relevant when Post-Run Evaluation is enabled.",
        action: {
          type: "input",
          value: deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.evalSampleRate, "1.0"),
          placeholder: "1.0"
        }
      },
      {
        id: deps.SETTINGS_KEYS.evalReviewThreshold,
        name: "Evaluation Review Threshold",
        description: "Score at or below this value (1–5) triggers the review queue. Default 2 means only clearly problematic interactions are flagged. Failed binary checks always trigger review regardless of this threshold.",
        action: {
          type: "input",
          value: deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.evalReviewThreshold, "2"),
          placeholder: "2"
        }
      },
      {
        id: deps.SETTINGS_KEYS.skillAutoresearchEnabled,
        name: "Skill Auto-Optimisation",
        description: "Enable the Karpathy Loop for skill improvement. When enabled, you can say \"optimise my X skill\" or use the cos_skill_optimize tool. Generates test cases, scores the current version, iteratively mutates and evaluates, then presents results with accept/revert.",
        action: {
          type: "switch",
          value: deps.getSettingBool(extensionAPI, deps.SETTINGS_KEYS.skillAutoresearchEnabled, false)
        }
      },
      {
        id: deps.SETTINGS_KEYS.skillAutoresearchBudget,
        name: "Max Budget Per Skill (USD)",
        description: "Maximum LLM spend per skill optimisation run. A $2 budget typically allows ~10 mutation iterations after setup costs.",
        action: {
          type: "input",
          value: deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.skillAutoresearchBudget, "2.00"),
          placeholder: "2.00"
        }
      }/*,
      {
        id: deps.SETTINGS_KEYS.skillAutoresearchToolCalling,
        name: "Enable Tool-Calling Simulation",
        description: "When enabled, optimisation runs real tool calls (calendar, email, etc.) during simulation. Slower and less reliable but tests tool usage. Default: off (LLM-only simulation). Can also be enabled per-run with --with-tools flag.",
        action: {
          type: "switch",
          value: deps.getSettingBool(extensionAPI, deps.SETTINGS_KEYS.skillAutoresearchToolCalling, false)
        }
      },
      {
        id: deps.SETTINGS_KEYS.skillAutoresearchToolCache,
        name: "Cache Tool Results During Optimisation",
        description: "When tool-calling simulation is enabled, cache tool results so identical calls across test cases and iterations return instantly. Disable to force fresh calls every time (useful for debugging tool flakiness). Default: on.",
        action: {
          type: "switch",
          value: deps.getSettingBool(extensionAPI, deps.SETTINGS_KEYS.skillAutoresearchToolCache, true)
        }
      }*/,
      {
        id: deps.SETTINGS_KEYS.skillAutoresearchPowerMutations,
        name: "Power-Tier Mutations",
        description: "Use the power model (e.g. Sonnet, GPT-4.1) for mutation calls instead of mini. Better content fidelity — fewer dropped sections and lines. Simulations and scoring stay on mini. Higher cost per iteration. Also available via --power flag.",
        action: {
          type: "switch",
          value: deps.getSettingBool(extensionAPI, deps.SETTINGS_KEYS.skillAutoresearchPowerMutations, false)
        }
      },
      {
        id: deps.SETTINGS_KEYS.skillAutoresearchTokenGuard,
        name: "Token-Growth Guard",
        description: "Reject refinement mutations that grow the skill text by 25% or more, even when the score improves. Stops the optimiser from stacking instructions indefinitely. Mutations that add a missing Rubric, Constraints, or Sources section are exempt — growth is the point. Default: on.",
        action: {
          type: "switch",
          value: deps.getSettingBool(extensionAPI, deps.SETTINGS_KEYS.skillAutoresearchTokenGuard, true)
        }
      }
    );
  }

  // Staleness detection (#112) — applies to all skills and cron jobs, not gated on auto-research.
  settings.push(
    {
      id: deps.SETTINGS_KEYS.skillStalenessDays,
      name: "Staleness Warning Threshold (days)",
      description: "Skills and scheduled jobs not reviewed within this many days will trigger a warning toast at startup. Use cos_review_skill / cos_review_cron to reset the timer. Set to 0 to disable staleness warnings. Default: 30.",
      action: {
        type: "input",
        value: deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.skillStalenessDays, "30"),
        placeholder: "30"
      }
    }
  );

  return {
    tabTitle: "Chief of Staff",
    settings
  };
}
