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
        items: ["anthropic", "openai", "gemini", "mistral"],
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
  ];

  // --- Tier 2 toggle: Integrations ------------------------------------------
  settings.push({
    id: SETTINGS_SHOW_INTEGRATIONS,
    name: "Show Integration Settings",
    description: "Composio (external tools like Gmail, Calendar, GitHub) and Local MCP server connections.",
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
        name: "Composio MCP URL",
        description: "Full proxy URL including your Composio endpoint path. Format: https://your-proxy.workers.dev/https://mcp.composio.dev/your-endpoint — requires deploying roam-mcp-proxy (see docs). Leave blank if not using Composio.",
        action: {
          type: "input",
          value: getComposioSettingOrBlank(extensionAPI, deps.SETTINGS_KEYS.composioMcpUrl),
          placeholder: "https://your-proxy.workers.dev/https://mcp.composio.dev/..."
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
        description: "No Roam extensions have registered tools yet. Install extensions that support the Extension Tools API.",
        action: { type: "input", placeholder: "", onChange: () => {} }
      });
    } else {
      for (const [extKey, ext] of extEntries) {
        const label = String(ext.name || extKey).trim();
        const toolCount = ext.tools.filter(t => t?.name && typeof t.execute === "function").length;
        const isEnabled = !!extToolsConfig[extKey]?.enabled;
        settings.push({
          id: `ext-tool-${extKey}`,
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
        id: deps.SETTINGS_KEYS.auditLogRetentionDays,
        name: "Audit Log Retention (days)",
        description: "Automatically trim audit log entries older than this many days. Runs after each agent interaction. Leave blank or 0 to keep all entries indefinitely.",
        action: {
          type: "input",
          value: deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.auditLogRetentionDays, ""),
          placeholder: "e.g. 14"
        }
      }
    );
  }

  return {
    tabTitle: "Chief of Staff",
    settings
  };
}
