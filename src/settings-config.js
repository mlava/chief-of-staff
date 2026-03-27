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

export function rebuildSettingsPanel(extensionAPI) {
  setTimeout(() => {
    extensionAPI.settings.panel.create(buildSettingsConfig(extensionAPI));
  }, 60);
}

// Return blank string (not the placeholder default) for Composio settings
// so unconfigured fields stay empty rather than sending placeholder strings.
function getComposioSettingOrBlank(extensionAPI, key) {
  const val = deps.getSettingString(extensionAPI, key, "");
  if (val === deps.DEFAULT_COMPOSIO_MCP_URL || val === deps.DEFAULT_COMPOSIO_API_KEY) return "";
  return val;
}

// ── Main config builder ─────────────────────────────────────────────────────

export function buildSettingsConfig(extensionAPI) {
  const showIntegrations = ensureSettingBool(extensionAPI, SETTINGS_SHOW_INTEGRATIONS, false);
  const showAdvanced = ensureSettingBool(extensionAPI, SETTINGS_SHOW_ADVANCED, false);

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
      description: "Primary AI provider. If this provider fails, Chief of Staff automatically falls back to other providers you have keys for.",
      action: {
        type: "select",
        items: ["anthropic", "openai", "gemini", "mistral", "groq"],
        value: deps.getLlmProvider(extensionAPI)
      }
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
        name: "Composio Proxy URL",
        description: "Base URL of your roam-mcp-proxy Cloudflare Worker. Format: https://your-proxy.workers.dev — the Composio session endpoint is constructed automatically. Leave blank if not using Composio.",
        action: {
          type: "input",
          value: getComposioSettingOrBlank(extensionAPI, deps.SETTINGS_KEYS.composioMcpUrl),
          placeholder: "https://your-proxy.workers.dev"
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
        //action: { type: "input", placeholder: "", onChange: () => {} }
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
      }/*,
      {
        id: deps.SETTINGS_KEYS.evalEnabled,
        name: "Post-Run Evaluation",
        description: "Enable automatic quality scoring after each agent interaction using an LLM judge. Adds roughly $0.001–0.003 per evaluated run.",
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
        description: "Score at or below this value (1–5) triggers the review queue. Default 2 means only clearly problematic interactions are flagged.",
        action: {
          type: "input",
          value: deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.evalReviewThreshold, "2"),
          placeholder: "2"
        }
      }*/
    );
  }

  return {
    tabTitle: "Chief of Staff",
    settings
  };
}
