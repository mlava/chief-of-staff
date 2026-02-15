import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import iziToast from "izitoast";

const DEFAULT_COMPOSIO_MCP_URL = "enter your composio mcp url here";
const DEFAULT_COMPOSIO_API_KEY = "enter your composio api key here";
const DEFAULT_ASSISTANT_NAME = "Chief of Staff";
const SETTINGS_KEYS = {
  composioMcpUrl: "composio-mcp-url",
  composioApiKey: "composio-api-key",
  assistantName: "assistant-name",
  llmProvider: "llm-provider",
  llmApiKey: "llm-api-key",
  openaiApiKey: "openai-api-key",
  anthropicApiKey: "anthropic-api-key",
  llmModel: "llm-model",
  debugLogging: "debug-logging",
  dryRunMode: "dry-run-mode",
  conversationContext: "conversation-context",
  chatPanelHistory: "chat-panel-history",
  installedTools: "installed-tools",
  composioToolkitCatalogCache: "composio-toolkit-catalog-cache",
  toolPreferences: "tool-preferences",
  toolPacksEnabled: "tool-packs-enabled",
  toolsSchemaVersion: "tools-schema-version",
  toolkitSchemaRegistry: "toolkit-schema-registry"
};
const TOOLS_SCHEMA_VERSION = 3;
const AUTH_POLL_INTERVAL_MS = 9000;
const AUTH_POLL_TIMEOUT_MS = 180000;
const MAX_AGENT_ITERATIONS = 10;
const MAX_TOOL_RESULT_CHARS = 12000;
const MAX_CONVERSATION_TURNS = 12;
const MAX_CONTEXT_MESSAGE_CHARS = 500;
const MAX_CHAT_PANEL_MESSAGES = 80;
const MAX_AGENT_MESSAGES_CHAR_BUDGET = 50000; // Conservative budget (20% safety margin for token estimation)
const MIN_AGENT_MESSAGES_TO_KEEP = 6;
const ANTHROPIC_MAX_OUTPUT_TOKENS = 1200;
const OPENAI_MAX_OUTPUT_TOKENS = 1200;
const LLM_MAX_RETRIES = 3;
const LLM_RETRY_BASE_DELAY_MS = 700;
const LLM_STREAM_CHUNK_TIMEOUT_MS = 60_000; // 60s per-chunk timeout for streaming reads
const DEFAULT_LLM_PROVIDER = "anthropic";
const DEFAULT_LLM_MODELS = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-4o-mini"
};
const POWER_LLM_MODELS = {
  anthropic: "claude-sonnet-4-5-20250929",
  openai: "gpt-4o"
};
const LLM_MODEL_COSTS = {
  // [inputPerM, outputPerM]
  "claude-haiku-4-5-20251001": [0.80, 4.0],
  "claude-sonnet-4-5-20250929": [3.0, 15.0],
  "gpt-4o-mini": [0.15, 0.60],
  "gpt-4o": [2.5, 10.0]
};
const LLM_API_ENDPOINTS = {
  anthropic: "https://api.anthropic.com/v1/messages",
  openai: "https://api.openai.com/v1/chat/completions"
};

/**
 * Get the proxied URL for an LLM API endpoint.
 * Uses Roam's built-in CORS proxy if available, otherwise returns the direct URL.
 * The Roam proxy (Google Cloud Functions) is faster than routing through a personal
 * Cloudflare worker and avoids overloading it with LLM traffic.
 */
function getProxiedLlmUrl(directUrl) {
  const proxy = window.roamAlphaAPI?.constants?.corsAnywhereProxyUrl;
  if (!proxy) return directUrl;
  const proxied = `${proxy.replace(/\/+$/, "")}/${directUrl}`;
  debugLog("[Chief flow] Using Roam CORS proxy for LLM call");
  return proxied;
}
const CHIEF_NAMESPACE = "chiefOfStaff";
const CHAT_PANEL_SELECTORS = {
  messages: "[data-chief-chat-messages]",
  input: "[data-chief-chat-input]",
  send: "[data-chief-chat-send]"
};
const MEMORY_PAGE_TITLES_BASE = [
  "Chief of Staff/Memory",
  "Chief of Staff/Inbox",
  "Chief of Staff/Decisions",
  "Chief of Staff/Lessons Learned"
];
function getActiveMemoryPageTitles() {
  if (hasBetterTasksAPI()) return MEMORY_PAGE_TITLES_BASE;
  return [
    "Chief of Staff/Memory",
    "Chief of Staff/Inbox",
    "Chief of Staff/Projects",
    "Chief of Staff/Decisions",
    "Chief of Staff/Lessons Learned"
  ];
}
const MEMORY_MAX_CHARS_PER_PAGE = 3000;
const MEMORY_TOTAL_MAX_CHARS = 8000;
const MEMORY_CACHE_TTL_MS = 300000; // 5 minutes (pull watches handle live updates)
const SKILLS_PAGE_TITLE = "Chief of Staff/Skills";
const SKILLS_MAX_CHARS = 5000;
const SKILLS_INDEX_MAX_CHARS = 1400;
const SKILLS_CACHE_TTL_MS = 300000; // 5 minutes (pull watches handle live updates)
const COMPOSIO_TOOLKIT_CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const COMPOSIO_TOOLKIT_CATALOG_MAX_SLUGS = 1000;
const COMPOSIO_TOOLKIT_SEARCH_BFS_MAX_NODES = 300;
const COMPOSIO_INSTALLED_TOOLS_BFS_MAX_NODES = 400;
const COMPOSIO_AUTO_CONNECT_DELAY_MS = 1200;
const COMPOSIO_AUTH_POLL_REMOTE_CACHE_TTL_MS = 10000;
const COMPOSIO_MCP_CONNECT_TIMEOUT_MS = 30000; // 30 seconds
const COMPOSIO_CONNECT_BACKOFF_MS = 30000; // 30s cooldown after a failed connection
const EMAIL_ACTION_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_EMAIL_CACHE_MESSAGES = 200; // Limit email cache to prevent unbounded growth
const TOOLKIT_SCHEMA_REGISTRY_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const TOOLKIT_SCHEMA_MAX_TOOLKITS = 30;
const TOOLKIT_SCHEMA_MAX_PROMPT_CHARS = 8000;
const MAX_ROAM_BLOCK_CHARS = 100000; // Conservative limit for Roam block size
const MAX_CREATE_BLOCKS_TOTAL = 50; // Hard cap on total blocks created in one roam_create_blocks call

let mcpClient = null;
let commandPaletteRegistered = false;
let connectInFlightPromise = null;
let unloadInProgress = false;
let activeAgentAbortController = null; // AbortController for in-flight LLM requests
let composioLastFailureAt = 0; // timestamp of last connectComposio failure for backoff
let composioTransportAbortController = null; // AbortController for in-flight MCP transport fetches
const authPollStateBySlug = new Map();
let extensionAPIRef = null;
let lastAgentRunTrace = null;
let conversationTurns = [];
let lastPromptSections = null; // Track sections from previous query for follow-ups
let chatPanelContainer = null;
let chatPanelMessages = null;
let chatPanelInput = null;
let chatPanelSendButton = null;
let chatPanelCleanupDrag = null;
let chatPanelCleanupListeners = null;
let chatPanelDragState = null;
let chatPanelIsSending = false;
let chatPanelIsOpen = false;
let chatPanelHistory = [];
const startupAuthPollTimeoutIds = [];
const activeToastKeyboards = new Set();
let reconcileInFlightPromise = null;
let composioAutoConnectTimeoutId = null;
let chatPanelPersistTimeoutId = null;
let extensionBroadcastCleanups = [];
let lastKnownPageContext = null; // { uid, title } — for detecting page navigation between turns
const approvedToolsThisSession = new Set(); // tools approved once skip future prompts
let roamNativeToolsCache = null;
const activePullWatches = []; // { name, cleanup } for onunload
let pullWatchDebounceTimers = {}; // keyed by cache type
const sessionTokenUsage = {
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalRequests: 0,
  totalCostUsd: 0
};
let installedToolsFetchCache = {
  expiresAt: 0,
  promise: null,
  data: null
};
let memoryPromptCache = {
  expiresAt: 0,
  content: "",
  signature: ""
};
let skillsPromptCache = {
  expiresAt: 0,
  content: "",
  indexContent: "",
  entries: [],
  detectedCount: 0,
  injectedCount: 0,
  signature: ""
};
let toolkitSchemaRegistryCache = null; // loaded lazily from settings
let latestEmailActionCache = {
  updatedAt: 0,
  messages: [],
  unreadEstimate: null,
  requestedCount: 0,
  returnedCount: 0,
  query: ""
};

// --- Extension Tools API discovery ---
const getExtensionToolsRegistry = () =>
  (typeof window !== "undefined" && window.RoamExtensionTools) || {};
const getBetterTasksExtension = () =>
  getExtensionToolsRegistry()["better-tasks"] || null;
const getBetterTasksTool = (toolName) => {
  const ext = getBetterTasksExtension();
  if (!ext || !Array.isArray(ext.tools)) return null;
  return ext.tools.find((t) => t && t.name === toolName) || null;
};
const runBetterTasksTool = async (toolName, args = {}) => {
  const tool = getBetterTasksTool(toolName);
  if (!tool || typeof tool.execute !== "function") {
    return { error: `Better Tasks tool not available: ${toolName}` };
  }
  try {
    const result = await tool.execute(args);
    return result && typeof result === "object" ? result : { result };
  } catch (e) {
    return { error: e?.message || `Failed to execute ${toolName}` };
  }
};
const hasBetterTasksAPI = () => Boolean(getBetterTasksExtension());

// --- Generic external extension tool discovery ---
function getExternalExtensionTools() {
  const registry = getExtensionToolsRegistry();
  const tools = [];
  for (const [extKey, ext] of Object.entries(registry)) {
    if (extKey === "better-tasks") continue; // already handled with name mapping
    if (!ext || !Array.isArray(ext.tools)) continue;
    const extLabel = String(ext.name || extKey || "").trim();
    for (const t of ext.tools) {
      if (!t?.name) continue;
      if (typeof t.execute !== "function") {
        debugLog(`[Chief flow] External tool skipped (no execute function): ${extKey}/${t.name}`);
        continue;
      }
      const rawDesc = t.description || "";
      const desc = extLabel ? `[${extLabel}] ${rawDesc}` : rawDesc;
      tools.push({
        name: t.name,
        description: desc,
        input_schema: t.parameters || { type: "object", properties: {} },
        execute: async (args = {}) => {
          try {
            const result = await t.execute(args);
            return result && typeof result === "object" ? result : { result };
          } catch (e) {
            return { error: e?.message || `Failed: ${t.name}` };
          }
        }
      });
    }
  }
  return tools;
}

// --- Generic extension broadcast event bridge ---
function setupExtensionBroadcastListeners() {
  teardownExtensionBroadcastListeners();
  const registry = getExtensionToolsRegistry();
  for (const [extKey, ext] of Object.entries(registry)) {
    if (!ext || !Array.isArray(ext.broadcasts)) continue;
    for (const bc of ext.broadcasts) {
      if (!bc?.event) continue;
      const handler = (e) => {
        const detail = e?.detail || {};
        const title = String(detail.title || bc.event).slice(0, 100);
        const message = String(detail.message || title).slice(0, 500);
        debugLog(`[Chief flow] Broadcast ${bc.event}:`, detail);
        if (bc.chat) {
          appendChatPanelMessage("assistant", message);
          appendChatPanelHistory("assistant", message);
        }
        if (bc.toast === "info") showInfoToast(title, message);
        else if (bc.toast === "error") showErrorToast(title, message);
      };
      window.addEventListener(bc.event, handler);
      extensionBroadcastCleanups.push(() => window.removeEventListener(bc.event, handler));
    }
  }
}

function teardownExtensionBroadcastListeners() {
  extensionBroadcastCleanups.forEach(fn => fn());
  extensionBroadcastCleanups = [];
}

const COMPOSIO_SAFE_MULTI_EXECUTE_SLUG_ALLOWLIST = new Set([
  "GOOGLECALENDAR_EVENTS_LIST",
  "GOOGLECALENDAR_CALENDARS_LIST",
  "GMAIL_FETCH_EMAILS",
  "GMAIL_DELETE_MESSAGE",
  "GMAIL_TRASH_MESSAGE",
  "GMAIL_DELETE_EMAIL",
  "GMAIL_GET_PROFILE",
  "GMAIL_LIST_LABELS",
  "GMAIL_GET_LABEL",
  "TODOIST_GET_ALL_PROJECTS",
  "TODOIST_GET_ACTIVE_TASKS"
]);
const COMPOSIO_MULTI_EXECUTE_SLUG_ALIAS_BY_TOKEN = {
  GMAILGETEVENTS: "GMAIL_FETCH_EMAILS"
};

function showConnectedToast() {
  if (!iziToast?.success) return;
  const assistantName = getAssistantDisplayName();
  iziToast.success({
    title: "Connected",
    message: `${assistantName} connected to Composio.`,
    position: "topRight",
    timeout: 2500
  });
}

function showDisconnectedToast() {
  if (!iziToast?.success) return;
  const assistantName = getAssistantDisplayName();
  iziToast.success({
    title: "Disconnected",
    message: `${assistantName} disconnected from Composio.`,
    position: "topRight",
    timeout: 2500
  });
}

function showReconnectedToast() {
  if (!iziToast?.success) return;
  const assistantName = getAssistantDisplayName();
  iziToast.success({
    title: "Reconnected",
    message: `${assistantName} reconnected to Composio.`,
    position: "topRight",
    timeout: 2500
  });
}

function showInfoToast(title, message) {
  if (!iziToast?.info) return;
  iziToast.info({
    title,
    message,
    position: "topRight",
    timeout: 4500
  });
}

function showErrorToast(title, message) {
  if (!iziToast?.error) return;
  iziToast.error({
    title,
    message,
    position: "topRight",
    timeout: 3500
  });
}

function removeOrphanChiefPanels() {
  if (!document?.querySelectorAll) return;
  const panels = Array.from(document.querySelectorAll("[data-chief-chat-panel='true']"));
  panels.forEach((panel) => {
    if (panel === chatPanelContainer) return;
    panel.remove();
  });
}

function showInfoToastIfAllowed(title, message, suppressToasts = false) {
  if (suppressToasts) return;
  showInfoToast(title, message);
}

function showErrorToastIfAllowed(title, message, suppressToasts = false) {
  if (suppressToasts) return;
  showErrorToast(title, message);
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitiseMarkdownHref(href) {
  const value = String(href || "").trim();
  if (!value) return "#";
  const lower = value.toLowerCase();
  if (lower.startsWith("http://") || lower.startsWith("https://") || lower.startsWith("mailto:")) {
    return escapeHtml(value);
  }
  return "#";
}

function renderInlineMarkdown(text) {
  const codeChunks = [];
  const pageRefChunks = [];
  const blockRefChunks = [];
  const mdLinkChunks = [];
  const urlChunks = [];
  const nonce = Math.random().toString(36).slice(2, 10);

  // Extract all link-like patterns BEFORE escapeHtml so we get raw values
  let raw = String(text || "");
  raw = raw.replace(/`([^`]+)`/g, (_, code) => {
    const key = `__CODE_${nonce}_${codeChunks.length}__`;
    codeChunks.push(`<code class="chief-inline-code">${escapeHtml(code)}</code>`);
    return key;
  });
  raw = raw.replace(/\[\[([^\]]+)\]\]/g, (_, pageTitle) => {
    const key = `__PREF_${nonce}_${pageRefChunks.length}__`;
    const escaped = escapeHtml(pageTitle);
    pageRefChunks.push(`<a href="#" class="chief-page-ref" data-page-title="${escaped}" title="Open ${escaped} in Roam (Shift-click for sidebar)">[[${escaped}]]</a>`);
    return key;
  });
  raw = raw.replace(/\(\(([a-zA-Z0-9_-]{9,12})\)\)/g, (_, blockUid) => {
    const key = `__BREF_${nonce}_${blockRefChunks.length}__`;
    const escaped = escapeHtml(blockUid);
    blockRefChunks.push(`<a href="#" class="chief-block-ref" data-block-uid="${escaped}" title="Open block in Roam (Shift-click for sidebar)">((${escaped}))</a>`);
    return key;
  });
  // Strip markdown image syntax ![alt](url) → [alt](url) — chat panel doesn't render images
  raw = raw.replace(/!\[([^\]]*)\]\(/g, "[$1](");
  // Markdown links [label](url) — extract before bare URLs so they don't double-match
  raw = raw.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => {
    const key = `__MDLNK_${nonce}_${mdLinkChunks.length}__`;
    const safeHref = sanitiseMarkdownHref(href);
    mdLinkChunks.push(`<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`);
    return key;
  });
  // Bare URLs — anything remaining that looks like http(s)://...
  raw = raw.replace(/(https?:\/\/[^\s<)\]]+)/g, (url) => {
    const key = `__URL_${nonce}_${urlChunks.length}__`;
    const escaped = escapeHtml(url);
    urlChunks.push(`<a href="${escaped}" target="_blank" rel="noopener noreferrer" class="chief-external-link">${escaped}</a>`);
    return key;
  });

  let output = escapeHtml(raw)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");

  codeChunks.forEach((chunk, index) => {
    output = output.replace(`__CODE_${nonce}_${index}__`, chunk);
  });
  pageRefChunks.forEach((chunk, index) => {
    output = output.replace(`__PREF_${nonce}_${index}__`, chunk);
  });
  blockRefChunks.forEach((chunk, index) => {
    output = output.replace(`__BREF_${nonce}_${index}__`, chunk);
  });
  mdLinkChunks.forEach((chunk, index) => {
    output = output.replace(`__MDLNK_${nonce}_${index}__`, chunk);
  });
  urlChunks.forEach((chunk, index) => {
    output = output.replace(`__URL_${nonce}_${index}__`, chunk);
  });
  return output;
}

function renderMarkdownToSafeHtml(markdownText) {
  const lines = String(markdownText || "").replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let inUl = false;
  let inOl = false;
  let inCode = false;
  let inBlockquote = false;
  let codeLines = [];
  let lastOlLiOpen = false; // track if we have an unclosed <li> in an <ol>

  const closeOlLi = () => {
    if (lastOlLiOpen) {
      html.push("</li>");
      lastOlLiOpen = false;
    }
  };

  const closeBlockquote = () => {
    if (inBlockquote) {
      html.push("</blockquote>");
      inBlockquote = false;
    }
  };

  const closeLists = () => {
    if (inUl) {
      html.push("</ul>");
      // If nested inside an <ol> <li>, close that li too
      if (inOl) closeOlLi();
      inUl = false;
    }
    if (inOl) {
      closeOlLi();
      html.push("</ol>");
      inOl = false;
    }
  };

  const flushCodeBlock = () => {
    if (!inCode) return;
    html.push(`<pre class="chief-code-block"><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
    codeLines = [];
    inCode = false;
  };

  lines.forEach((line) => {
    if (line.trim().startsWith("```")) {
      if (inCode) {
        flushCodeBlock();
      } else {
        closeLists();
        inCode = true;
        codeLines = [];
      }
      return;
    }

    if (inCode) {
      codeLines.push(line);
      return;
    }

    const headingMatch = line.match(/^\s*(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      closeLists();
      const level = Math.min(headingMatch[1].length, 3);
      html.push(`<h${level} class="chief-heading">${renderInlineMarkdown(headingMatch[2])}</h${level}>`);
      return;
    }

    const bqMatch = line.match(/^\s*>\s?(.*)$/);
    if (bqMatch) {
      closeLists();
      if (!inBlockquote) {
        html.push('<blockquote class="chief-blockquote">');
        inBlockquote = true;
      }
      const content = bqMatch[1].trim();
      if (content) {
        html.push(`<div>${renderInlineMarkdown(content)}</div>`);
      } else {
        html.push("<br/>");
      }
      return;
    }
    if (inBlockquote) closeBlockquote();

    const ulMatch = line.match(/^\s*[-*]\s+(.+)$/);
    if (ulMatch) {
      // If we're inside an <ol>, nest this <ul> inside the current <li>
      if (inOl && !inUl) {
        // Don't close the <ol> — start a nested <ul> inside the current <li>
        html.push('<ul class="chief-list chief-list--nested">');
        inUl = true;
      } else if (!inOl && !inUl) {
        html.push('<ul class="chief-list">');
        inUl = true;
      }
      html.push(`<li>${renderInlineMarkdown(ulMatch[1])}</li>`);
      return;
    }

    const olMatch = line.match(/^\s*\d+\.\s+(.+)$/);
    if (olMatch) {
      // Close any nested <ul> first
      if (inUl) {
        html.push("</ul>");
        inUl = false;
      }
      // Close previous <ol> <li> if open
      closeOlLi();
      if (!inOl) {
        html.push('<ol class="chief-list">');
        inOl = true;
      }
      html.push(`<li>${renderInlineMarkdown(olMatch[1])}`);
      lastOlLiOpen = true;
      return;
    }

    if (!line.trim()) {
      // blank lines inside an open list are swallowed so numbered items don't restart at 1
      if (!inUl && !inOl) html.push("<br/>");
      return;
    }

    // Continuation text inside a numbered list item (e.g. description lines between items)
    // — keep it inside the current <li> so the <ol> isn't closed and numbering doesn't reset
    if (inOl && lastOlLiOpen) {
      html.push(`<br/>${renderInlineMarkdown(line.trim())}`);
      return;
    }

    closeLists();
    html.push(`<div>${renderInlineMarkdown(line)}</div>`);
  });

  closeBlockquote();
  closeLists();
  flushCodeBlock();
  return html.join("");
}

function createChatPanelMessageElement(role, text) {
  const item = document.createElement("div");
  item.classList.add("chief-msg", role === "user" ? "chief-msg--user" : "chief-msg--assistant");
  item.innerHTML = renderMarkdownToSafeHtml(text);
  return item;
}

function appendChatPanelMessage(role, text) {
  refreshChatPanelElementRefs();
  if (!chatPanelMessages) return;
  const item = createChatPanelMessageElement(role, text);
  chatPanelMessages.appendChild(item);
  chatPanelMessages.scrollTop = chatPanelMessages.scrollHeight;
  return item;
}

function addSaveToDailyPageButton(messageEl, promptText, responseText) {
  if (!messageEl) return;
  const btn = document.createElement("button");
  btn.className = "chief-msg-save-btn";
  btn.title = "Save to today's daily page";
  btn.textContent = "📌";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "⏳";
    try {
      const writeResult = await writeResponseToTodayDailyPage(promptText, responseText);
      btn.textContent = "✓";
      btn.classList.add("chief-msg-save-btn--done");
      showInfoToast("Saved to Roam", `Added under ${writeResult.pageTitle}.`);
    } catch (error) {
      btn.textContent = "📌";
      btn.disabled = false;
      showErrorToast("Write failed", error?.message || "Could not write to daily page.");
    }
  });
  messageEl.appendChild(btn);
}

function normaliseChatPanelMessage(input) {
  const role = String(input?.role || "").toLowerCase() === "user" ? "user" : "assistant";
  const text = String(input?.text || "").trim();
  if (!text) return null;
  return {
    role,
    text: truncateForContext(text, 2000),
    createdAt: Number.isFinite(input?.createdAt) ? input.createdAt : Date.now()
  };
}

function persistChatPanelHistory(extensionAPI = extensionAPIRef) {
  extensionAPI?.settings?.set?.(SETTINGS_KEYS.chatPanelHistory, chatPanelHistory);
}

function loadChatPanelHistory(extensionAPI = extensionAPIRef) {
  const raw = getSettingArray(extensionAPI, SETTINGS_KEYS.chatPanelHistory, []);
  const normalised = raw
    .map(normaliseChatPanelMessage)
    .filter(Boolean);
  chatPanelHistory = normalised.slice(normalised.length - MAX_CHAT_PANEL_MESSAGES);
}

function appendChatPanelHistory(role, text, extensionAPI = extensionAPIRef) {
  const normalised = normaliseChatPanelMessage({ role, text });
  if (!normalised) return;
  chatPanelHistory.push(normalised);
  if (chatPanelHistory.length > MAX_CHAT_PANEL_MESSAGES) {
    chatPanelHistory = chatPanelHistory.slice(chatPanelHistory.length - MAX_CHAT_PANEL_MESSAGES);
  }
  if (chatPanelPersistTimeoutId) {
    window.clearTimeout(chatPanelPersistTimeoutId);
  }
  chatPanelPersistTimeoutId = window.setTimeout(() => {
    chatPanelPersistTimeoutId = null;
    persistChatPanelHistory(extensionAPI);
  }, 5000); // 5s debounce to reduce IndexedDB writes
}

function flushPersistChatPanelHistory(extensionAPI = extensionAPIRef) {
  if (chatPanelPersistTimeoutId) {
    window.clearTimeout(chatPanelPersistTimeoutId);
    chatPanelPersistTimeoutId = null;
  }
  persistChatPanelHistory(extensionAPI);
}

function clearChatPanelHistory(extensionAPI = extensionAPIRef) {
  chatPanelHistory = [];
  flushPersistChatPanelHistory(extensionAPI);
  if (chatPanelMessages) chatPanelMessages.innerHTML = "";
}

function clearStartupAuthPollTimers() {
  while (startupAuthPollTimeoutIds.length) {
    const timeoutId = startupAuthPollTimeoutIds.pop();
    window.clearTimeout(timeoutId);
  }
}

function clearComposioAutoConnectTimer() {
  if (!composioAutoConnectTimeoutId) return;
  window.clearTimeout(composioAutoConnectTimeoutId);
  composioAutoConnectTimeoutId = null;
}

function refreshChatPanelElementRefs() {
  if (!chatPanelContainer) return;
  chatPanelMessages = chatPanelContainer.querySelector(CHAT_PANEL_SELECTORS.messages);
  chatPanelInput = chatPanelContainer.querySelector(CHAT_PANEL_SELECTORS.input);
  chatPanelSendButton = chatPanelContainer.querySelector(CHAT_PANEL_SELECTORS.send);
}

function hasValidChatPanelElementRefs() {
  return Boolean(chatPanelMessages && chatPanelInput && chatPanelSendButton);
}

function setChiefNamespaceGlobals() {
  window[CHIEF_NAMESPACE] = {
    ask: (message, options = {}) => askChiefOfStaff(message, options),
    briefing: () => askChiefOfStaff("use skill Structured Daily Briefing"),
    toggleChat: () => toggleChatPanel(),
    memory: async () => getAllMemoryContent({ force: true }),
    skills: async () => getSkillsContent({ force: true }),
    mcpClient: () => mcpClient,
    schemas: () => getToolkitSchemaRegistry(),
    discoverSchemas: () => discoverAllConnectedToolkitSchemas(extensionAPIRef, { force: true }),
    discoverToolkit: (name) => discoverToolkitSchema(name, { force: true }),
    buildArgs: (slug, args) => buildToolArgs(slug, args)
  };
}

function clearChiefNamespaceGlobals() {
  try {
    delete window[CHIEF_NAMESPACE];
  } catch (error) {
    window[CHIEF_NAMESPACE] = undefined;
  }
}

function setChatPanelSendingState(isSending) {
  refreshChatPanelElementRefs();
  chatPanelIsSending = Boolean(isSending);
  if (chatPanelInput) chatPanelInput.disabled = chatPanelIsSending;
  if (chatPanelSendButton) {
    chatPanelSendButton.disabled = chatPanelIsSending;
    chatPanelSendButton.textContent = chatPanelIsSending ? "Thinking..." : "Send";
  }
}

function updateChatPanelCostIndicator() {
  const el = document.querySelector("[data-chief-chat-cost]");
  if (!el) return;
  const cents = sessionTokenUsage.totalCostUsd * 100;
  if (cents < 0.01) {
    el.textContent = "";
    return;
  }
  el.textContent = cents < 1
    ? `${cents.toFixed(2)}¢`
    : `$${(cents / 100).toFixed(2)}`;
}

async function handleChatPanelSend() {
  refreshChatPanelElementRefs();
  if (chatPanelIsSending || !chatPanelInput) return;
  const message = String(chatPanelInput.value || "").trim();
  if (!message) return;

  appendChatPanelMessage("user", message);
  appendChatPanelHistory("user", message);
  chatPanelInput.value = "";
  setChatPanelSendingState(true);

  // Create a live streaming message element
  let streamingEl = null;
  let streamedChunks = "";

  function ensureStreamingEl() {
    if (streamingEl) return;
    refreshChatPanelElementRefs();
    if (!chatPanelMessages) return;
    streamingEl = document.createElement("div");
    streamingEl.classList.add("chief-msg", "chief-msg--assistant");
    streamingEl.textContent = "";
    chatPanelMessages.appendChild(streamingEl);
  }

  try {
    const result = await askChiefOfStaff(message, {
      suppressToasts: true,
      onTextChunk: (chunk) => {
        ensureStreamingEl();
        streamedChunks += chunk;
        // Re-render markdown on each chunk for live formatting
        if (streamingEl) {
          streamingEl.innerHTML = renderMarkdownToSafeHtml(streamedChunks);
          if (chatPanelMessages) chatPanelMessages.scrollTop = chatPanelMessages.scrollHeight;
        }
      }
    });
    const responseText = String(result?.text || "").trim() || "No response generated.";

    if (streamingEl) {
      // Final render with complete text (in case of minor differences)
      streamingEl.innerHTML = renderMarkdownToSafeHtml(responseText);
      addSaveToDailyPageButton(streamingEl, message, responseText);
    } else {
      // Non-streaming fallback (Anthropic or deterministic route)
      const el = appendChatPanelMessage("assistant", responseText);
      addSaveToDailyPageButton(el, message, responseText);
    }
    appendChatPanelHistory("assistant", responseText);
    updateChatPanelCostIndicator();
  } catch (error) {
    const errorText = getUserFacingLlmErrorMessage(error, "Chat");
    if (streamingEl) {
      streamingEl.innerHTML = renderMarkdownToSafeHtml(`Error: ${errorText}`);
    } else {
      appendChatPanelMessage("assistant", `Error: ${errorText}`);
    }
    appendChatPanelHistory("assistant", `Error: ${errorText}`);
    showErrorToastIfAllowed("Chat failed", errorText, true);
  } finally {
    setChatPanelSendingState(false);
    if (chatPanelInput) chatPanelInput.focus();
  }
}

const CHAT_PANEL_STORAGE_KEY = "chief-of-staff-panel-geometry";

function loadChatPanelGeometry() {
  try {
    const raw = localStorage.getItem(CHAT_PANEL_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveChatPanelGeometry(panelEl) {
  try {
    const rect = panelEl.getBoundingClientRect();
    localStorage.setItem(CHAT_PANEL_STORAGE_KEY, JSON.stringify({
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    }));
  } catch { /* ignore */ }
}

function applyChatPanelGeometry(panelEl) {
  const geo = loadChatPanelGeometry();
  if (!geo) return;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = Math.max(280, Math.min(geo.width || 360, vw - 16));
  const h = Math.max(200, Math.min(geo.height || 520, vh - 16));
  const l = Math.max(0, Math.min(geo.left ?? (vw - w - 20), vw - w));
  const t = Math.max(0, Math.min(geo.top ?? (vh - h - 20), vh - h));
  panelEl.style.width = `${w}px`;
  panelEl.style.height = `${h}px`;
  panelEl.style.left = `${l}px`;
  panelEl.style.top = `${t}px`;
  panelEl.style.right = "auto";
  panelEl.style.bottom = "auto";
}

function installChatPanelDragBehavior(handleEl, panelEl) {
  // --- Drag (via header) ---
  const onDragMove = (event) => {
    if (!chatPanelDragState) return;
    panelEl.style.left = `${Math.max(0, event.clientX - chatPanelDragState.offsetX)}px`;
    panelEl.style.top = `${Math.max(0, event.clientY - chatPanelDragState.offsetY)}px`;
    panelEl.style.right = "auto";
    panelEl.style.bottom = "auto";
  };
  const onDragUp = () => {
    if (chatPanelDragState) {
      chatPanelDragState = null;
      saveChatPanelGeometry(panelEl);
    }
  };
  const onDragDown = (event) => {
    if (event.button !== 0) return;
    const targetTag = String(event.target?.tagName || "").toLowerCase();
    if (targetTag === "button") return;
    const rect = panelEl.getBoundingClientRect();
    chatPanelDragState = {
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top
    };
    event.preventDefault();
  };
  handleEl.addEventListener("mousedown", onDragDown);
  window.addEventListener("mousemove", onDragMove);
  window.addEventListener("mouseup", onDragUp);

  // --- Resize (edge + corner grips) ---
  const GRIP = 6; // px from edge to activate resize cursor
  let resizeState = null;

  const getResizeEdge = (event) => {
    const rect = panelEl.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const w = rect.width;
    const h = rect.height;
    const left = x < GRIP;
    const right = x > w - GRIP;
    const top = y < GRIP;
    const bottom = y > h - GRIP;
    if (!left && !right && !top && !bottom) return null;
    return { left, right, top, bottom };
  };

  const getCursor = (edge) => {
    if (!edge) return "";
    if ((edge.top && edge.left) || (edge.bottom && edge.right)) return "nwse-resize";
    if ((edge.top && edge.right) || (edge.bottom && edge.left)) return "nesw-resize";
    if (edge.left || edge.right) return "ew-resize";
    if (edge.top || edge.bottom) return "ns-resize";
    return "";
  };

  const onPanelMouseMove = (event) => {
    if (resizeState) return; // don't change cursor while resizing
    const edge = getResizeEdge(event);
    panelEl.style.cursor = getCursor(edge);
  };

  const onPanelMouseDown = (event) => {
    if (event.button !== 0) return;
    const edge = getResizeEdge(event);
    if (!edge) return;
    const rect = panelEl.getBoundingClientRect();
    resizeState = {
      edge,
      startX: event.clientX,
      startY: event.clientY,
      startLeft: rect.left,
      startTop: rect.top,
      startWidth: rect.width,
      startHeight: rect.height
    };
    event.preventDefault();
    event.stopPropagation();
    document.body.style.cursor = getCursor(edge);
    document.body.style.userSelect = "none";
  };

  const onResizeMove = (event) => {
    if (!resizeState) return;
    const { edge, startX, startY, startLeft, startTop, startWidth, startHeight } = resizeState;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    let newLeft = startLeft;
    let newTop = startTop;
    let newWidth = startWidth;
    let newHeight = startHeight;

    if (edge.right) newWidth = Math.max(280, startWidth + dx);
    if (edge.bottom) newHeight = Math.max(200, startHeight + dy);
    if (edge.left) {
      newWidth = Math.max(280, startWidth - dx);
      newLeft = startLeft + startWidth - newWidth;
    }
    if (edge.top) {
      newHeight = Math.max(200, startHeight - dy);
      newTop = startTop + startHeight - newHeight;
    }
    panelEl.style.left = `${Math.max(0, newLeft)}px`;
    panelEl.style.top = `${Math.max(0, newTop)}px`;
    panelEl.style.width = `${newWidth}px`;
    panelEl.style.height = `${newHeight}px`;
    panelEl.style.right = "auto";
    panelEl.style.bottom = "auto";
  };

  const onResizeUp = () => {
    if (resizeState) {
      resizeState = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      saveChatPanelGeometry(panelEl);
    }
  };

  panelEl.addEventListener("mousemove", onPanelMouseMove);
  panelEl.addEventListener("mousedown", onPanelMouseDown);
  window.addEventListener("mousemove", onResizeMove);
  window.addEventListener("mouseup", onResizeUp);

  return () => {
    handleEl.removeEventListener("mousedown", onDragDown);
    panelEl.removeEventListener("mousemove", onPanelMouseMove);
    panelEl.removeEventListener("mousedown", onPanelMouseDown);
    window.removeEventListener("mousemove", onDragMove);
    window.removeEventListener("mouseup", onDragUp);
    window.removeEventListener("mousemove", onResizeMove);
    window.removeEventListener("mouseup", onResizeUp);
  };
}

function ensureChatPanel() {
  const assistantName = getAssistantDisplayName();
  removeOrphanChiefPanels();
  if (chatPanelContainer && !document.body.contains(chatPanelContainer)) {
    if (chatPanelCleanupDrag) {
      chatPanelCleanupDrag();
      chatPanelCleanupDrag = null;
    }
    if (chatPanelCleanupListeners) {
      chatPanelCleanupListeners();
      chatPanelCleanupListeners = null;
    }
    chatPanelContainer = null;
    chatPanelMessages = null;
    chatPanelInput = null;
    chatPanelSendButton = null;
    chatPanelDragState = null;
    chatPanelIsSending = false;
    chatPanelIsOpen = false;
  }
  if (chatPanelContainer) {
    refreshChatPanelElementRefs();
    if (hasValidChatPanelElementRefs()) return chatPanelContainer;
    if (chatPanelCleanupDrag) {
      chatPanelCleanupDrag();
      chatPanelCleanupDrag = null;
    }
    if (chatPanelCleanupListeners) {
      chatPanelCleanupListeners();
      chatPanelCleanupListeners = null;
    }
    chatPanelContainer.remove();
    chatPanelContainer = null;
    chatPanelMessages = null;
    chatPanelInput = null;
    chatPanelSendButton = null;
    chatPanelDragState = null;
    chatPanelIsSending = false;
    chatPanelIsOpen = false;
  }
  if (!document?.body) return null;

  const container = document.createElement("div");
  container.setAttribute("data-chief-chat-panel", "true");

  // Apply saved position/size from localStorage
  applyChatPanelGeometry(container);

  const header = document.createElement("div");
  header.classList.add("chief-panel-header");

  const title = document.createElement("div");
  title.textContent = assistantName;
  title.classList.add("chief-panel-title");

  const costIndicator = document.createElement("span");
  costIndicator.setAttribute("data-chief-chat-cost", "true");
  costIndicator.textContent = "";
  title.appendChild(costIndicator);

  header.appendChild(title);

  const headerButtons = document.createElement("div");
  headerButtons.classList.add("chief-panel-header-buttons");

  const clearButton = document.createElement("button");
  clearButton.textContent = "Clear";
  clearButton.classList.add("chief-panel-btn");
  clearButton.onclick = () => {
    clearChatPanelHistory();
    appendChatPanelMessage(
      "assistant",
      "History cleared. Ask me anything and I’ll continue from fresh chat history."
    );
  };
  headerButtons.appendChild(clearButton);

  const closeButton = document.createElement("button");
  closeButton.textContent = "×";
  closeButton.classList.add("chief-panel-btn", "chief-panel-btn--close");
  closeButton.onclick = () => {
    container.style.display = "none";
    chatPanelIsOpen = false;
  };
  headerButtons.appendChild(closeButton);

  header.appendChild(headerButtons);

  const messages = document.createElement("div");
  messages.setAttribute("data-chief-chat-messages", "true");

  const composer = document.createElement("div");
  composer.classList.add("chief-panel-composer");

  const input = document.createElement("textarea");
  input.setAttribute("data-chief-chat-input", "true");
  input.placeholder = `Ask ${assistantName}...`;
  input.rows = 2;
  const inputKeydownHandler = (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      handleChatPanelSend();
    }
  };
  input.addEventListener("keydown", inputKeydownHandler);

  const sendButton = document.createElement("button");
  sendButton.setAttribute("data-chief-chat-send", "true");
  sendButton.textContent = "Send";
  sendButton.onclick = () => {
    handleChatPanelSend();
  };

  composer.appendChild(input);
  composer.appendChild(sendButton);
  container.appendChild(header);
  container.appendChild(messages);
  container.appendChild(composer);
  document.body.appendChild(container);

  chatPanelContainer = container;
  chatPanelMessages = messages;
  chatPanelInput = input;
  chatPanelSendButton = sendButton;
  chatPanelCleanupDrag = installChatPanelDragBehavior(header, container);
  chatPanelIsOpen = true;

  // Delegated click handler for [[page ref]] and ((block ref)) links
  const messagesClickHandler = (e) => {
    const api = getRoamAlphaApi();
    const pageRef = e.target.closest(".chief-page-ref");
    if (pageRef) {
      e.preventDefault();
      const pageTitle = pageRef.getAttribute("data-page-title");
      if (!pageTitle) return;
      if (e.shiftKey) {
        try {
          const escaped = escapeForDatalog(pageTitle);
          const rows = api.q?.(`[:find ?uid :where [?p :node/title "${escaped}"] [?p :block/uid ?uid]]`) || [];
          const uid = String(rows?.[0]?.[0] || "").trim();
          if (uid) api.ui.rightSidebar.addWindow({ window: { type: "outline", "block-uid": uid } });
        } catch (err) { debugLog("[Chief flow] Shift-click page ref error:", err); }
      } else {
        openRoamPageByTitle(pageTitle);
      }
      return;
    }
    const blockRef = e.target.closest(".chief-block-ref");
    if (blockRef) {
      e.preventDefault();
      const uid = blockRef.getAttribute("data-block-uid");
      if (!uid) return;
      try {
        if (e.shiftKey) {
          api.ui.rightSidebar.addWindow({ window: { type: "outline", "block-uid": uid } });
        } else {
          api.ui.mainWindow.openBlock({ block: { uid } });
        }
      } catch (err) { debugLog("[Chief flow] Block ref click error:", err); }
      return;
    }
  };
  messages.addEventListener("click", messagesClickHandler);

  // Store cleanup function for event listeners
  chatPanelCleanupListeners = () => {
    input.removeEventListener("keydown", inputKeydownHandler);
    messages.removeEventListener("click", messagesClickHandler);
  };
  if (chatPanelHistory.length) {
    const fragment = document.createDocumentFragment();
    chatPanelHistory.forEach((entry) => {
      fragment.appendChild(createChatPanelMessageElement(entry.role, entry.text));
    });
    messages.appendChild(fragment);
    messages.scrollTop = messages.scrollHeight;
  } else {
    const greeting = "Hi — ask me anything. I keep context from this session, so follow-ups work.";
    appendChatPanelMessage("assistant", greeting);
    appendChatPanelHistory("assistant", greeting);
  }
  return chatPanelContainer;
}

function isChatPanelActuallyVisible(panel) {
  if (!panel || !document?.body?.contains?.(panel)) return false;
  const style = window.getComputedStyle(panel);
  if (!style) return false;
  return style.display !== "none" && style.visibility !== "hidden";
}

function setChatPanelOpen(nextOpen) {
  const panel = ensureChatPanel();
  if (!panel) return;
  refreshChatPanelElementRefs();
  panel.style.display = nextOpen ? "flex" : "none";
  chatPanelIsOpen = nextOpen;
  if (nextOpen && chatPanelInput) chatPanelInput.focus();
  try { localStorage.setItem("chief-of-staff-panel-open", nextOpen ? "1" : "0"); } catch { /* ignore */ }
}

function toggleChatPanel() {
  const hadUsablePanel = Boolean(chatPanelContainer && document?.body?.contains?.(chatPanelContainer));
  const panel = ensureChatPanel();
  if (!panel) return;
  if (!hadUsablePanel) {
    setChatPanelOpen(true);
    return;
  }
  const currentlyVisible = isChatPanelActuallyVisible(panel);
  setChatPanelOpen(!currentlyVisible);
}

function destroyChatPanel() {
  if (chatPanelCleanupDrag) {
    chatPanelCleanupDrag();
    chatPanelCleanupDrag = null;
  }
  if (chatPanelCleanupListeners) {
    chatPanelCleanupListeners();
    chatPanelCleanupListeners = null;
  }
  if (chatPanelContainer?.parentElement) {
    chatPanelContainer.parentElement.removeChild(chatPanelContainer);
  }
  chatPanelContainer = null;
  chatPanelMessages = null;
  chatPanelInput = null;
  chatPanelSendButton = null;
  chatPanelDragState = null;
  chatPanelIsSending = false;
  chatPanelIsOpen = false;
}

function createToastConfirmCancelKeyboardHandlers({ onConfirm, onCancel }) {
  let attached = false;
  const onKeyDown = (event) => {
    if (event.defaultPrevented) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      const tagName = String(event?.target?.tagName || "").toLowerCase();
      if (tagName === "textarea") return;
      event.preventDefault();
      onConfirm();
    }
  };

  const handlers = {
    attach(toast) {
      if (attached) return;
      document.addEventListener("keydown", onKeyDown, true);
      attached = true;
      activeToastKeyboards.add(handlers);
      const focusTarget = toast?.querySelector?.("input,select,textarea,button");
      if (focusTarget?.focus) focusTarget.focus();
    },
    detach() {
      if (!attached) return;
      document.removeEventListener("keydown", onKeyDown, true);
      attached = false;
      activeToastKeyboards.delete(handlers);
    }
  };
  return handlers;
}

function focusToastField(toast, selector) {
  const node = toast?.querySelector?.(selector);
  if (!node?.focus) return;
  window.setTimeout(() => {
    node.focus();
    if (typeof node.select === "function") node.select();
  }, 0);
}

function hideToastSafely(instance, toast) {
  const config = { transitionOut: "fadeOut" };
  if (typeof instance?.hide === "function") {
    instance.hide(config, toast, "button");
    return;
  }
  if (typeof iziToast?.hide === "function") {
    iziToast.hide(config, toast, "button");
    return;
  }
  if (toast?.remove) toast.remove();
}

function normaliseToastContext(firstArg, secondArg) {
  const firstToast = firstArg?.toast && typeof firstArg.toast.querySelector === "function"
    ? firstArg.toast
    : null;
  const secondToast = secondArg?.toast && typeof secondArg.toast.querySelector === "function"
    ? secondArg.toast
    : null;
  const firstIsToast = typeof firstArg?.querySelector === "function";
  const secondIsToast = typeof secondArg?.querySelector === "function";
  const toast = firstIsToast
    ? firstArg
    : secondIsToast
      ? secondArg
      : firstToast || secondToast || null;
  const instance = firstArg === toast ? secondArg : firstArg;
  return { instance, toast };
}

function promptToolSlugWithToast(defaultSlug = "") {
  return new Promise((resolve) => {
    if (!iziToast?.show) {
      resolve(null);
      return;
    }
    let resolved = false;
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };

    const initialValue = typeof defaultSlug === "string" ? defaultSlug : "";
    const escapedValue = initialValue
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    let activeInstance = null;
    let activeToast = null;
    const confirmAction = (instance, toast) => {
      const input = toast.querySelector("[data-chief-tool-input]");
      const value = typeof input?.value === "string" ? input.value.trim() : "";
      keyboard.detach();
      finish(value || null);
      hideToastSafely(instance, toast);
    };
    const cancelAction = (instance, toast) => {
      keyboard.detach();
      finish(null);
      hideToastSafely(instance, toast);
    };
    const keyboard = createToastConfirmCancelKeyboardHandlers({
      onConfirm: () => {
        if (!activeInstance || !activeToast) return;
        confirmAction(activeInstance, activeToast);
      },
      onCancel: () => {
        if (!activeInstance || !activeToast) return;
        cancelAction(activeInstance, activeToast);
      }
    });
    iziToast.show({
      title: "Install Composio Tool",
      message: `<input data-chief-tool-input type="text" value="${escapedValue}" placeholder="GOOGLECALENDAR" />`,
      position: "center",
      timeout: false,
      close: false,
      overlay: true,
      drag: false,
      buttons: [
        [
          "<button>Install</button>",
          (firstArg, secondArg) => {
            const { instance, toast } = normaliseToastContext(firstArg, secondArg);
            confirmAction(instance, toast);
          },
          true
        ],
        [
          "<button>Cancel</button>",
          (firstArg, secondArg) => {
            const { instance, toast } = normaliseToastContext(firstArg, secondArg);
            cancelAction(instance, toast);
          }
        ]
      ],
      onOpening: (firstArg, secondArg) => {
        const { instance, toast } = normaliseToastContext(firstArg, secondArg);
        activeInstance = instance;
        activeToast = toast;
        keyboard.attach(toast);
        focusToastField(toast, "[data-chief-tool-input]");
      },
      onOpened: (firstArg, secondArg) => {
        const { toast } = normaliseToastContext(firstArg, secondArg);
        focusToastField(toast, "[data-chief-tool-input]");
      },
      onClosing: () => {
        keyboard.detach();
        activeInstance = null;
        activeToast = null;
        finish(null);
      }
    });
  });
}

function promptTextWithToast({
  title = "Chief of Staff",
  placeholder = "Ask Chief of Staff...",
  confirmLabel = "Submit",
  initialValue = ""
} = {}) {
  return new Promise((resolve) => {
    if (!iziToast?.show) {
      resolve(null);
      return;
    }
    let resolved = false;
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };

    const escapedValue = String(initialValue || "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    const escapedPlaceholder = String(placeholder || "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    let activeInstance = null;
    let activeToast = null;
    const confirmAction = (instance, toast) => {
      const input = toast.querySelector("[data-chief-input]");
      const value = typeof input?.value === "string" ? input.value.trim() : "";
      keyboard.detach();
      finish(value || null);
      hideToastSafely(instance, toast);
    };
    const cancelAction = (instance, toast) => {
      keyboard.detach();
      finish(null);
      hideToastSafely(instance, toast);
    };
    const keyboard = createToastConfirmCancelKeyboardHandlers({
      onConfirm: () => {
        if (!activeInstance || !activeToast) return;
        confirmAction(activeInstance, activeToast);
      },
      onCancel: () => {
        if (!activeInstance || !activeToast) return;
        cancelAction(activeInstance, activeToast);
      }
    });

    iziToast.show({
      title,
      message: `<input data-chief-input type="text" value="${escapedValue}" placeholder="${escapedPlaceholder}" />`,
      position: "center",
      timeout: false,
      close: false,
      overlay: true,
      drag: false,
      buttons: [
        [
          `<button>${confirmLabel}</button>`,
          (instance, toast) => confirmAction(instance, toast),
          true
        ],
        [
          "<button>Cancel</button>",
          (instance, toast) => cancelAction(instance, toast)
        ]
      ],
      onOpening: (instance, toast) => {
        activeInstance = instance;
        activeToast = toast;
        keyboard.attach(toast);
        focusToastField(toast, "[data-chief-input]");
      },
      onClosing: () => {
        keyboard.detach();
        activeInstance = null;
        activeToast = null;
        finish(null);
      }
    });
  });
}

function promptInstalledToolSlugWithToast(
  installedTools,
  options = {}
) {
  const {
    title = "Select Composio Tool",
    confirmLabel = "Confirm"
  } = options;
  return new Promise((resolve) => {
    if (!iziToast?.show) {
      resolve(null);
      return;
    }
    let resolved = false;
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };

    const optionsHtml = installedTools
      .map((tool) => {
        const slug = String(tool.slug || "");
        const label = String(tool.label || slug);
        const escapedSlug = slug
          .replace(/&/g, "&amp;")
          .replace(/"/g, "&quot;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        const escapedLabel = label
          .replace(/&/g, "&amp;")
          .replace(/"/g, "&quot;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
        return `<option value="${escapedSlug}">${escapedLabel}</option>`;
      })
      .join("");
    let activeInstance = null;
    let activeToast = null;
    const confirmAction = (instance, toast) => {
      const select = toast.querySelector("[data-chief-tool-select]");
      const value = typeof select?.value === "string" ? select.value.trim() : "";
      keyboard.detach();
      finish(value || null);
      hideToastSafely(instance, toast);
    };
    const cancelAction = (instance, toast) => {
      keyboard.detach();
      finish(null);
      hideToastSafely(instance, toast);
    };
    const keyboard = createToastConfirmCancelKeyboardHandlers({
      onConfirm: () => {
        if (!activeInstance || !activeToast) return;
        confirmAction(activeInstance, activeToast);
      },
      onCancel: () => {
        if (!activeInstance || !activeToast) return;
        cancelAction(activeInstance, activeToast);
      }
    });

    iziToast.show({
      title,
      message: `<select data-chief-tool-select>${optionsHtml}</select>`,
      position: "center",
      timeout: false,
      close: false,
      overlay: true,
      drag: false,
      buttons: [
        [
          `<button>${confirmLabel}</button>`,
          (instance, toast) => confirmAction(instance, toast),
          true
        ],
        [
          "<button>Cancel</button>",
          (instance, toast) => cancelAction(instance, toast)
        ]
      ],
      onOpening: (instance, toast) => {
        activeInstance = instance;
        activeToast = toast;
        keyboard.attach(toast);
        focusToastField(toast, "[data-chief-tool-select]");
      },
      onClosing: () => {
        keyboard.detach();
        activeInstance = null;
        activeToast = null;
        finish(null);
      }
    });
  });
}

function promptToolExecutionApproval(toolName, args) {
  return new Promise((resolve) => {
    if (!iziToast?.show) {
      resolve(false);
      return;
    }
    let resolved = false;
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };

    const argsPreview = safeJsonStringify(args, 600);
    const escapedToolName = escapeHtml(String(toolName || ""));
    const escapedArgsPreview = String(argsPreview || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    let activeInstance = null;
    let activeToast = null;
    const confirmAction = (instance, toast) => {
      keyboard.detach();
      finish(true);
      hideToastSafely(instance, toast);
    };
    const cancelAction = (instance, toast) => {
      keyboard.detach();
      finish(false);
      hideToastSafely(instance, toast);
    };
    const keyboard = createToastConfirmCancelKeyboardHandlers({
      onConfirm: () => {
        if (!activeInstance || !activeToast) return;
        confirmAction(activeInstance, activeToast);
      },
      onCancel: () => {
        if (!activeInstance || !activeToast) return;
        cancelAction(activeInstance, activeToast);
      }
    });

    iziToast.show({
      title: "Approve tool action",
      message: `<div><strong>${escapedToolName}</strong></div><pre class="chief-tool-preview">${escapedArgsPreview}</pre>`,
      position: "center",
      timeout: false,
      close: false,
      overlay: true,
      drag: false,
      buttons: [
        [
          "<button>Approve</button>",
          (instance, toast) => confirmAction(instance, toast),
          true
        ],
        [
          "<button>Deny</button>",
          (instance, toast) => cancelAction(instance, toast)
        ]
      ],
      onOpening: (instance, toast) => {
        activeInstance = instance;
        activeToast = toast;
        keyboard.attach(toast);
      },
      onClosing: () => {
        keyboard.detach();
        activeInstance = null;
        activeToast = null;
        finish(false);
      }
    });
  });
}

function promptWriteToDailyPage() {
  return new Promise((resolve) => {
    if (!iziToast?.show) {
      resolve(false);
      return;
    }
    let resolved = false;
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };
    let activeInstance = null;
    let activeToast = null;
    const confirmAction = (instance, toast) => {
      keyboard.detach();
      finish(true);
      hideToastSafely(instance, toast);
    };
    const cancelAction = (instance, toast) => {
      keyboard.detach();
      finish(false);
      hideToastSafely(instance, toast);
    };
    const keyboard = createToastConfirmCancelKeyboardHandlers({
      onConfirm: () => {
        if (!activeInstance || !activeToast) return;
        confirmAction(activeInstance, activeToast);
      },
      onCancel: () => {
        if (!activeInstance || !activeToast) return;
        cancelAction(activeInstance, activeToast);
      }
    });

    iziToast.show({
      title: "Write to Daily Page?",
      message: "Save this response under today's daily page?",
      position: "center",
      timeout: false,
      close: false,
      overlay: true,
      drag: false,
      buttons: [
        [
          "<button>Write</button>",
          (instance, toast) => confirmAction(instance, toast),
          true
        ],
        [
          "<button>Skip</button>",
          (instance, toast) => cancelAction(instance, toast)
        ]
      ],
      onOpening: (instance, toast) => {
        activeInstance = instance;
        activeToast = toast;
        keyboard.attach(toast);
      },
      onClosing: () => {
        keyboard.detach();
        activeInstance = null;
        activeToast = null;
        finish(false);
      }
    });
  });
}

function getSettingString(extensionAPI, key, fallbackValue = "") {
  const value = extensionAPI?.settings?.get?.(key);
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  return fallbackValue;
}

function getAssistantDisplayName(extensionAPI = extensionAPIRef) {
  const configured = getSettingString(extensionAPI, SETTINGS_KEYS.assistantName, DEFAULT_ASSISTANT_NAME);
  const name = String(configured || "").trim();
  if (!name) return DEFAULT_ASSISTANT_NAME;
  return name.slice(0, 80);
}

function getSettingNumber(extensionAPI, key, fallbackValue = 0) {
  const value = extensionAPI?.settings?.get?.(key);
  if (Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallbackValue;
}

function getSettingBool(extensionAPI, key, fallbackValue = false) {
  const value = extensionAPI?.settings?.get?.(key);
  return typeof value === "boolean" ? value : fallbackValue;
}

function isDebugLoggingEnabled(extensionAPI = extensionAPIRef) {
  return getSettingBool(extensionAPI, SETTINGS_KEYS.debugLogging, false);
}

function debugLog(...args) {
  if (!isDebugLoggingEnabled()) return;
  console.log(...args);
}

function debugInfo(...args) {
  if (!isDebugLoggingEnabled()) return;
  console.info(...args);
}

function getSettingObject(extensionAPI, key, fallbackValue = {}) {
  const value = extensionAPI?.settings?.get?.(key);
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallbackValue;
}

function getSettingArray(extensionAPI, key, fallbackValue = []) {
  const value = extensionAPI?.settings?.get?.(key);
  return Array.isArray(value) ? value : fallbackValue;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason || new DOMException("Aborted", "AbortError")); return; }
    let onAbort;
    const id = window.setTimeout(() => {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal) {
      onAbort = () => { clearTimeout(id); reject(signal.reason || new DOMException("Aborted", "AbortError")); };
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

function normaliseInstalledToolRecord(input) {
  const slug = typeof input?.slug === "string" ? input.slug.trim() : "";
  if (!slug) return null;
  return {
    slug,
    label: typeof input?.label === "string" && input.label.trim() ? input.label.trim() : slug,
    enabled: input?.enabled !== false,
    installState: typeof input?.installState === "string" ? input.installState : "installed",
    lastError: typeof input?.lastError === "string" ? input.lastError : "",
    connectionId: typeof input?.connectionId === "string" ? input.connectionId : "",
    updatedAt: Number.isFinite(input?.updatedAt) ? input.updatedAt : Date.now()
  };
}

function normaliseToolSlugToken(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function normaliseComposioToolkitCatalogCache(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const fetchedAt = Number.isFinite(source?.fetchedAt) ? source.fetchedAt : 0;
  const seen = new Set();
  const slugs = Array.isArray(source?.slugs)
    ? source.slugs
      .map((value) => normaliseToolkitSlug(value))
      .filter((value) => {
        if (!value || seen.has(value)) return false;
        seen.add(value);
        return true;
      })
      .slice(0, COMPOSIO_TOOLKIT_CATALOG_MAX_SLUGS)
    : [];
  return { fetchedAt, slugs };
}

function getComposioToolkitCatalogCache(extensionAPI = extensionAPIRef) {
  const raw = extensionAPI?.settings?.get?.(SETTINGS_KEYS.composioToolkitCatalogCache);
  return normaliseComposioToolkitCatalogCache(raw);
}

function saveComposioToolkitCatalogCache(extensionAPI = extensionAPIRef, cache = {}) {
  if (!extensionAPI?.settings?.set) return;
  const normalised = normaliseComposioToolkitCatalogCache(cache);
  extensionAPI.settings.set(SETTINGS_KEYS.composioToolkitCatalogCache, normalised);
}

function mergeComposioToolkitCatalogSlugs(extensionAPI = extensionAPIRef, slugs = [], options = {}) {
  if (!extensionAPI?.settings?.set) return getComposioToolkitCatalogCache(extensionAPI);
  const { touchFetchedAt = false } = options;
  const current = getComposioToolkitCatalogCache(extensionAPI);
  const incoming = Array.isArray(slugs) ? slugs : [];
  const seen = new Set();
  const merged = [...incoming, ...current.slugs]
    .map((value) => normaliseToolkitSlug(value))
    .filter((value) => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    })
    .slice(0, COMPOSIO_TOOLKIT_CATALOG_MAX_SLUGS);
  const next = {
    fetchedAt: touchFetchedAt ? Date.now() : current.fetchedAt,
    slugs: merged
  };
  saveComposioToolkitCatalogCache(extensionAPI, next);
  return next;
}

// ═══════════════════════════════════════════════════════════════════════
// Toolkit Schema Registry
//
// Discovers, caches, and exposes Composio tool schemas so that both
// deterministic fast-paths and the LLM agent loop know the correct
// parameter names, types, defaults, and known pitfalls for every
// connected toolkit — without guessing or shotgun fallback args.
//
// Persistence: extensionAPI.settings (survives across sessions/devices).
// Runtime cache: toolkitSchemaRegistryCache (avoids repeated settings reads).
// Discovery: COMPOSIO_SEARCH_TOOLS (full plan + schemas) and
//            COMPOSIO_GET_TOOL_SCHEMAS (individual tool input_schema).
// ═══════════════════════════════════════════════════════════════════════

/**
 * Registry shape (persisted as a single settings value):
 * {
 *   toolkits: {
 *     "GMAIL": {
 *       toolkit: "GMAIL",
 *       discoveredAt: 1707600000000,
 *       plan: { recommended_plan_steps: [...], known_pitfalls: [...] },
 *       tools: {
 *         "GMAIL_FETCH_EMAILS": {
 *           slug: "GMAIL_FETCH_EMAILS",
 *           description: "...",
 *           input_schema: { properties: {...}, ... },
 *           fetchedAt: 1707600000000
 *         },
 *         ...
 *       }
 *     },
 *     ...
 *   }
 * }
 */

function getToolkitSchemaRegistry(extensionAPI = extensionAPIRef) {
  if (toolkitSchemaRegistryCache) return toolkitSchemaRegistryCache;
  const raw = extensionAPI?.settings?.get?.(SETTINGS_KEYS.toolkitSchemaRegistry);
  const registry = raw && typeof raw === "object" && raw.toolkits ? raw : { toolkits: {} };
  toolkitSchemaRegistryCache = registry;
  return registry;
}

function saveToolkitSchemaRegistry(extensionAPI = extensionAPIRef, registry = null) {
  const reg = registry || toolkitSchemaRegistryCache || { toolkits: {} };
  // Enforce size cap: keep the most recently discovered toolkits
  const entries = Object.entries(reg.toolkits || {});
  if (entries.length > TOOLKIT_SCHEMA_MAX_TOOLKITS) {
    entries.sort((a, b) => (b[1].discoveredAt || 0) - (a[1].discoveredAt || 0));
    reg.toolkits = Object.fromEntries(entries.slice(0, TOOLKIT_SCHEMA_MAX_TOOLKITS));
  }
  toolkitSchemaRegistryCache = reg;
  extensionAPI?.settings?.set?.(SETTINGS_KEYS.toolkitSchemaRegistry, reg);
}

function getToolkitEntry(toolkitName) {
  const registry = getToolkitSchemaRegistry();
  const key = String(toolkitName || "").toUpperCase();
  return registry.toolkits?.[key] || null;
}

function getToolSchema(toolSlug) {
  const slug = String(toolSlug || "").toUpperCase();
  const registry = getToolkitSchemaRegistry();
  for (const tk of Object.values(registry.toolkits || {})) {
    if (tk.tools?.[slug]) return tk.tools[slug];
  }
  return null;
}

/** Infer the toolkit name from a tool slug (e.g. "GMAIL_FETCH_EMAILS" → "GMAIL"). */
function inferToolkitFromSlug(toolSlug) {
  const slug = String(toolSlug || "").toUpperCase();
  // Common pattern: TOOLKIT_ACTION or TOOLKIT_NOUN_VERB
  // Google tools: GOOGLECALENDAR_EVENTS_LIST, GMAIL_FETCH_EMAILS
  const match = slug.match(/^(GOOGLE[A-Z]*|[A-Z]+?)_/);
  return match ? match[1] : slug;
}

/**
 * Discover all tools for a toolkit via COMPOSIO_SEARCH_TOOLS.
 * Extracts: tool slugs, input schemas, plan steps, known pitfalls.
 * Caches everything in the registry.
 */
function populateSlugAllowlist(entry) {
  if (!entry?.tools) return;
  for (const slug of Object.keys(entry.tools)) {
    const upperSlug = slug.toUpperCase();
    const tokens = upperSlug.split("_");
    const isReadOnly = tokens.some(t =>
      ["GET", "LIST", "FETCH", "SEARCH", "FIND", "READ", "QUERY", "DETAILS", "ABOUT", "SUGGEST"].includes(t)
    );
    if (isReadOnly && COMPOSIO_SAFE_MULTI_EXECUTE_SLUG_ALLOWLIST.size < 200) {
      COMPOSIO_SAFE_MULTI_EXECUTE_SLUG_ALLOWLIST.add(upperSlug);
    }
  }
}

async function discoverToolkitSchema(toolkitName, options = {}) {
  const { force = false } = options;
  const key = String(toolkitName || "").toUpperCase();
  if (!key) return null;

  // Check cache freshness
  if (!force) {
    const existing = getToolkitEntry(key);
    if (existing && (Date.now() - (existing.discoveredAt || 0)) < TOOLKIT_SCHEMA_REGISTRY_TTL_MS) {
      debugLog("[Chief flow] Schema registry: cache hit for", key);
      populateSlugAllowlist(existing);
      return existing;
    }
  }

  if (!mcpClient?.callTool) {
    debugLog("[Chief flow] Schema registry: no MCP client, skipping discovery for", key);
    return getToolkitEntry(key); // return stale if available
  }

  debugLog("[Chief flow] Schema registry: discovering", key);
  try {
    // Toolkit-specific query hints for better Composio search results.
    // Generic queries like "googlecalendar" often return admin/settings tools
    // while descriptive queries return the actual workflow tools.
    const TOOLKIT_QUERY_HINTS = {
      GMAIL: ["gmail", "gmail list read fetch send create"],
      GOOGLECALENDAR: ["google calendar list events", "google calendar create update delete events"],
      SLACK: ["slack send message", "slack list channels messages"],
      TODOIST: ["todoist tasks projects", "todoist create complete tasks"],
      GITHUB: ["github repos issues pull requests", "github create issue PR"],
      NOTION: ["notion pages databases", "notion create update pages"],
      GOOGLEDRIVE: ["google drive files folders", "google drive upload share"],
      GOOGLESHEETS: ["google sheets read write", "google sheets create update"],
      ASANA: ["asana tasks projects", "asana create update tasks"],
      TRELLO: ["trello boards cards lists", "trello create move cards"],
      LINEAR: ["linear issues projects", "linear create update issues"],
      JIRA: ["jira issues projects", "jira create update issues"],
      SEMANTICSCHOLAR: ["semantic scholar search papers authors", "semantic scholar paper details references citations"],
      OPENWEATHER: ["openweather current weather forecast", "openweather air quality UV index"]
    };

    const queries = TOOLKIT_QUERY_HINTS[key]
      || [key.toLowerCase(), `${key.toLowerCase()} list read fetch send create`];

    // Send all queries and merge the results
    const tools = {};
    let bestPlan = { recommended_plan_steps: [], known_pitfalls: [], execution_guidance: "" };
    const allPrimarySlugs = new Set();
    const allRelatedSlugs = new Set();

    for (const queryText of queries) {
      try {
        const searchResult = await mcpClient.callTool({
          name: "COMPOSIO_SEARCH_TOOLS",
          arguments: { queries: [{ use_case: queryText }] }
        });
        const text = searchResult?.content?.[0]?.text;
        const qParsed = typeof text === "string" ? safeJsonParse(text) : text;
        if (!qParsed?.successful) continue;

        const r = qParsed.data?.results?.[0] || {};
        const inlineSchemas = r.tool_schemas || {};
        const qPrimary = Array.isArray(r.primary_tool_slugs) ? r.primary_tool_slugs : [];
        const qRelated = Array.isArray(r.related_tool_slugs) ? r.related_tool_slugs : [];

        qPrimary.forEach(s => allPrimarySlugs.add(s));
        qRelated.forEach(s => allRelatedSlugs.add(s));

        // Keep the richest plan (most steps + pitfalls)
        const planSteps = Array.isArray(r.recommended_plan_steps) ? r.recommended_plan_steps : [];
        const pitfalls = Array.isArray(r.known_pitfalls) ? r.known_pitfalls : [];
        if (planSteps.length + pitfalls.length > bestPlan.recommended_plan_steps.length + bestPlan.known_pitfalls.length) {
          bestPlan = {
            recommended_plan_steps: planSteps,
            known_pitfalls: pitfalls,
            execution_guidance: r.execution_guidance || bestPlan.execution_guidance
          };
        }

        // Merge inline schemas, filtering cross-toolkit tools
        for (const [slug, schema] of Object.entries(inlineSchemas)) {
          const slugToolkit = inferToolkitFromSlug(slug);
          if (slugToolkit !== key && !qPrimary.includes(slug)) continue;
          // Prefer entries with full schemas over stubs
          if (tools[slug]?.input_schema && !schema?.input_schema) continue;
          if (schema?.input_schema && (schema.hasFullSchema !== false)) {
            tools[slug] = {
              slug,
              toolkit: schema.toolkit || key,
              description: schema.description || "",
              input_schema: schema.input_schema,
              fetchedAt: Date.now()
            };
          } else if (!tools[slug]) {
            tools[slug] = {
              slug,
              toolkit: schema?.toolkit || key,
              description: schema?.description || "",
              input_schema: null,
              fetchedAt: 0
            };
          }
        }

        debugLog("[Chief flow] Schema registry: query", queryText, "→",
          Object.keys(inlineSchemas).length, "tools,",
          planSteps.length, "steps,",
          pitfalls.length, "pitfalls");
      } catch (e) {
        debugLog("[Chief flow] Schema registry: query failed:", queryText, String(e?.message || e));
      }
    }

    // Add any primary/related slugs not yet represented
    for (const slug of [...allPrimarySlugs, ...allRelatedSlugs]) {
      const slugToolkit = inferToolkitFromSlug(slug);
      if (slugToolkit !== key && !allPrimarySlugs.has(slug)) continue;
      if (!tools[slug]) {
        tools[slug] = { slug, toolkit: key, description: "", input_schema: null, fetchedAt: 0 };
      }
    }

    const plan = bestPlan;
    const primarySlugs = [...allPrimarySlugs];
    const relatedSlugs = [...allRelatedSlugs];

    if (!Object.keys(tools).length) {
      debugLog("[Chief flow] Schema registry: no tools found for", key);
      return getToolkitEntry(key);
    }

    // Fetch full schemas for tools that only have stubs (batch up to 20)
    const needsFetch = Object.values(tools).filter(t => !t.input_schema).map(t => t.slug);
    if (needsFetch.length > 0) {
      for (let i = 0; i < needsFetch.length && i < 20; i += 10) {
        const batch = needsFetch.slice(i, i + 10);
        try {
          const schemaResult = await mcpClient.callTool({
            name: "COMPOSIO_GET_TOOL_SCHEMAS",
            arguments: { tool_slugs: batch }
          });
          const schemaText = schemaResult?.content?.[0]?.text;
          const schemaParsed = typeof schemaText === "string" ? safeJsonParse(schemaText) : schemaText;
          const fetchedSchemas = schemaParsed?.data?.tool_schemas || {};
          for (const [slug, schema] of Object.entries(fetchedSchemas)) {
            if (tools[slug] && schema?.input_schema) {
              tools[slug].input_schema = schema.input_schema;
              tools[slug].description = schema.description || tools[slug].description;
              tools[slug].fetchedAt = Date.now();
            }
          }
        } catch (e) {
          debugLog("[Chief flow] Schema registry: GET_TOOL_SCHEMAS batch failed:", String(e?.message || e));
        }
      }
    }

    const entry = {
      toolkit: key,
      discoveredAt: Date.now(),
      plan,
      primarySlugs,
      relatedSlugs,
      tools
    };

    // Save to registry
    const registry = getToolkitSchemaRegistry();
    registry.toolkits[key] = entry;
    saveToolkitSchemaRegistry(extensionAPIRef, registry);

    debugLog("[Chief flow] Schema registry: discovered", key, {
      toolCount: Object.keys(tools).length,
      withSchema: Object.values(tools).filter(t => t.input_schema).length,
      pitfalls: plan.known_pitfalls.length
    });

    populateSlugAllowlist(entry);

    return entry;
  } catch (e) {
    debugLog("[Chief flow] Schema registry: discovery failed for", key, String(e?.message || e));
    return getToolkitEntry(key);
  }
}

/**
 * Ensure schemas are cached for all currently connected toolkits.
 * Called after Composio connects and after tool install completes.
 */
async function discoverAllConnectedToolkitSchemas(extensionAPI = extensionAPIRef, options = {}) {
  const { force = false } = options;
  if (!extensionAPI) return;
  const { installedTools } = getToolsConfigState(extensionAPI);
  const connected = installedTools
    .filter(t => t.enabled && t.installState === "installed")
    .map(t => inferToolkitFromSlug(t.slug));
  const unique = [...new Set(connected)];
  debugLog("[Chief flow] Schema registry: discovering connected toolkits:", unique, force ? "(forced)" : "");

  // Run discoveries in parallel (max 5 at a time)
  const batchSize = 5;
  for (let i = 0; i < unique.length; i += batchSize) {
    const batch = unique.slice(i, i + batchSize);
    await Promise.allSettled(batch.map(tk => discoverToolkitSchema(tk, { force })));
  }
}

/**
 * Get the correct parameter name for a concept across different toolkits.
 * E.g., getParamName("GMAIL_FETCH_EMAILS", "max_results") → "max_results"
 *        getParamName("GOOGLECALENDAR_EVENTS_LIST", "max_results") → "maxResults"
 */
function getSchemaParamName(toolSlug, conceptName) {
  const schema = getToolSchema(toolSlug);
  if (!schema?.input_schema?.properties) return conceptName;
  const props = schema.input_schema.properties;
  // Direct match
  if (props[conceptName]) return conceptName;
  // Try common casing variants
  const variants = [
    conceptName,
    conceptName.replace(/_([a-z])/g, (_, c) => c.toUpperCase()), // snake → camel
    conceptName.replace(/([A-Z])/g, "_$1").toLowerCase().replace(/^_/, ""), // camel → snake
    conceptName.toLowerCase(),
    conceptName.toUpperCase()
  ];
  for (const v of variants) {
    if (props[v]) return v;
  }
  return conceptName;
}

/**
 * Build a parameter object for a tool call using the cached schema.
 * Maps concept names to the tool's actual parameter names.
 * Filters out unknown params and applies type coercion based on schema.
 */
function buildToolArgs(toolSlug, conceptArgs = {}) {
  const schema = getToolSchema(toolSlug);
  if (!schema?.input_schema?.properties) {
    debugLog("[Chief flow] Schema registry: no schema for", toolSlug, "— passing args as-is");
    return conceptArgs;
  }
  const props = schema.input_schema.properties;
  const result = {};

  for (const [concept, value] of Object.entries(conceptArgs)) {
    if (value === undefined || value === null) continue;
    const paramName = getSchemaParamName(toolSlug, concept);
    if (!props[paramName]) {
      debugLog("[Chief flow] Schema registry: skipping unknown param", concept, "for", toolSlug);
      continue;
    }
    // Type coercion based on schema
    const propSchema = props[paramName];
    if (propSchema.type === "integer" && typeof value === "number") {
      result[paramName] = Math.round(value);
    } else if (propSchema.type === "boolean" && typeof value !== "boolean") {
      result[paramName] = !!value;
    } else if (propSchema.type === "string" && typeof value !== "string") {
      result[paramName] = String(value);
    } else {
      result[paramName] = value;
    }
  }
  return result;
}

/**
 * Build a system prompt section describing all connected toolkit schemas.
 * Injected into the LLM system prompt so it knows exact param names and pitfalls.
 */
function buildToolkitSchemaPromptSection(activeSections) {
  const registry = getToolkitSchemaRegistry();
  const toolkits = Object.values(registry.toolkits || {});
  if (!toolkits.length) return "";

  // Only include toolkits that are actually installed
  const installedToolkits = new Set();
  if (extensionAPIRef) {
    const { installedTools } = getToolsConfigState(extensionAPIRef);
    for (const tool of installedTools) {
      if (tool.enabled && tool.installState === "installed") {
        installedToolkits.add(inferToolkitFromSlug(tool.slug));
      }
    }
  }

  const sections = [];
  let totalChars = 0;

  for (const tk of toolkits) {
    if (totalChars >= TOOLKIT_SCHEMA_MAX_PROMPT_CHARS) break;

    // Only include installed toolkits
    if (installedToolkits.size > 0 && !installedToolkits.has(tk.toolkit)) continue;

    // If activeSections provided, only include toolkits the query needs
    if (activeSections) {
      const tkKey = `toolkit_${tk.toolkit}`;
      if (!activeSections.has(tkKey)) continue;
    }

    const toolEntries = Object.values(tk.tools || {}).filter(t => t.input_schema);
    if (!toolEntries.length) continue;

    const lines = [`### ${tk.toolkit}`];

    // List all available tool slugs with brief descriptions
    const slugList = toolEntries.map(t => {
      const desc = (t.description || "").split(/[.\n]/)[0].slice(0, 50).trim();
      return desc ? `${t.slug} (${desc})` : t.slug;
    }).join(", ");
    lines.push(`Available: ${slugList}`);

    // Add known pitfalls (condensed, max 2)
    if (tk.plan?.known_pitfalls?.length) {
      tk.plan.known_pitfalls.slice(0, 2).forEach(p => {
        const cleaned = p.replace(/^\[[^\]]*\]\s*/, "").slice(0, 100);
        lines.push(`⚠ ${cleaned}`);
      });
    }

    // Show params only for primary/common tools (max 5 per toolkit)
    const primarySlugs = new Set(Array.isArray(tk.primarySlugs) ? tk.primarySlugs : []);
    const keyTools = toolEntries.filter(t => primarySlugs.has(t.slug)).slice(0, 5);
    // If no primary slugs, take the first 3
    if (!keyTools.length) keyTools.push(...toolEntries.slice(0, 3));

    for (const tool of keyTools) {
      const params = tool.input_schema?.properties || {};
      const paramEntries = Object.entries(params)
        .filter(([_, v]) => !v.description?.includes("Deprecated"))
        .slice(0, 8);
      lines.push(`- \`${tool.slug}\``);
      for (const [name, v] of paramEntries) {
        const type = v.type || "any";
        const def = v.default !== undefined ? `, default=${JSON.stringify(v.default)}` : "";
        const desc = (v.description || "").split(/[.\n]/)[0].slice(0, 60);
        lines.push(`    ${name}: ${type}${def}${desc ? ` — ${desc}` : ""}`);
      }
    }

    const section = lines.join("\n");
    if (totalChars + section.length > TOOLKIT_SCHEMA_MAX_PROMPT_CHARS) break;
    sections.push(section);
    totalChars += section.length;
  }

  if (!sections.length) return "";

  // Build a dynamic example from the first available toolkit
  const firstTk = toolkits.find(tk => installedToolkits.has(tk.toolkit));
  const firstTool = firstTk ? Object.values(firstTk.tools || {}).find(t => t.input_schema) : null;
  const exampleLine = firstTool
    ? `Example: call COMPOSIO_MULTI_EXECUTE_TOOL with:
  {"tools": [{"tool_slug": "${firstTool.slug}", "arguments": {}}]}`
    : `Example: {"tools": [{"tool_slug": "TOOL_SLUG", "arguments": {}}]}`;

  return `## Connected Toolkit Schemas

IMPORTANT: Call these tools directly via COMPOSIO_MULTI_EXECUTE_TOOL. Do NOT call COMPOSIO_SEARCH_TOOLS first — the schemas below are already cached and ready.

${exampleLine}

Use the EXACT tool slugs listed below. Do not shorten or modify them.

${sections.join("\n\n")}`;
}

/**
 * Record the response shape from a successful tool call for future reference.
 * Lightweight: just captures the path to data and top-level keys.
 */
function recordToolResponseShape(toolSlug, result) {
  try {
    const slug = String(toolSlug || "").toUpperCase();
    const schema = getToolSchema(slug);
    if (!schema || schema._responseShape) return; // already recorded

    const parsed = typeof result === "string" ? safeJsonParse(result) : result;
    if (!parsed) return;

    // Walk common Composio nesting to find the actual data
    const paths = [
      { path: "data.results[0].response.data", value: parsed?.data?.results?.[0]?.response?.data },
      { path: "data.results[0].response.data_preview", value: parsed?.data?.results?.[0]?.response?.data_preview },
      { path: "data.results[0].response", value: parsed?.data?.results?.[0]?.response },
      { path: "data", value: parsed?.data }
    ];

    for (const { path, value } of paths) {
      if (value && typeof value === "object" && Object.keys(value).length > 0) {
        const topKeys = Object.keys(value).slice(0, 15);
        const arrayKeys = topKeys.filter(k => Array.isArray(value[k]));
        const hasPagination = topKeys.includes("nextPageToken") || topKeys.includes("pageToken");
        schema._responseShape = {
          dataPath: path,
          topKeys,
          arrayKeys,
          hasPagination,
          recordedAt: Date.now()
        };
        debugLog("[Chief flow] Schema registry: recorded response shape for", slug, schema._responseShape);
        return;
      }
    }
  } catch { /* non-critical */ }
}

function resolveToolkitSlugFromSuggestions(requestedSlug, suggestions = []) {
  const requested = normaliseToolkitSlug(requestedSlug);
  const list = Array.isArray(suggestions) ? suggestions.map((value) => normaliseToolkitSlug(value)).filter(Boolean) : [];
  if (!requested || !list.length) {
    return {
      requestedSlug: requested,
      resolvedSlug: requested,
      suggestions: list
    };
  }

  const requestedToken = normaliseToolSlugToken(requested);
  const exact = list.find((slug) => normaliseToolSlugToken(slug) === requestedToken);
  if (exact) {
    return {
      requestedSlug: requested,
      resolvedSlug: exact,
      suggestions: list
    };
  }

  const rootToken = normaliseToolSlugToken(requested.split("_")[0] || requested);
  const rootMatch = list.find((slug) => normaliseToolSlugToken(slug) === rootToken);
  if (rootMatch) {
    return {
      requestedSlug: requested,
      resolvedSlug: rootMatch,
      suggestions: list
    };
  }

  return {
    requestedSlug: requested,
    resolvedSlug: requested,
    suggestions: list
  };
}

function canonicaliseComposioToolSlug(slug) {
  const raw = String(slug || "").trim().toUpperCase();
  if (!raw) return "";
  // Check explicit aliases first
  const alias = COMPOSIO_MULTI_EXECUTE_SLUG_ALIAS_BY_TOKEN[normaliseToolSlugToken(raw)];
  if (alias) return alias;

  // Check if slug exists exactly in schema registry
  const registry = getToolkitSchemaRegistry();
  const allToolkits = Object.values(registry.toolkits || {});
  for (const tk of allToolkits) {
    if (tk.tools?.[raw]) return raw; // exact match
  }

  // Fuzzy match: if the LLM hallucinated a close slug (e.g. TODOIST_GET_TASKS vs TODOIST_GET_ALL_TASKS),
  // find the best match from the registry
  const toolkit = inferToolkitFromSlug(raw);
  const tkEntry = registry.toolkits?.[toolkit];
  if (tkEntry?.tools) {
    const candidates = Object.keys(tkEntry.tools);
    // Try substring containment: if raw is a substring of a candidate or vice versa
    const contained = candidates.find(c => c.includes(raw) || raw.includes(c));
    if (contained) {
      debugLog("[Chief flow] Slug fuzzy-corrected:", raw, "→", contained);
      return contained;
    }
    // Try prefix + suffix match: same toolkit prefix, similar ending
    const rawSuffix = raw.replace(toolkit + "_", "");
    const rawParts = rawSuffix.split("_").filter(Boolean);
    const rawVerb = rawParts[0] || "";
    const rawWords = new Set(rawParts);
    // Action verbs that must match exactly — DELETE→FETCH would be catastrophic
    const ACTION_VERBS = new Set(["GET", "LIST", "FETCH", "SEARCH", "CREATE", "ADD", "DELETE", "REMOVE", "TRASH", "UPDATE", "PATCH", "SEND", "MOVE", "COPY", "STAR", "UNSTAR", "MARK", "ARCHIVE"]);
    for (const candidate of candidates) {
      const candSuffix = candidate.replace(toolkit + "_", "");
      const candParts = candSuffix.split("_").filter(Boolean);
      const candVerb = candParts[0] || "";
      // If both have action verbs, they must match (no DELETE→FETCH corrections)
      if (ACTION_VERBS.has(rawVerb) && ACTION_VERBS.has(candVerb) && rawVerb !== candVerb) continue;
      // e.g. "GET_TASKS" matches "GET_ALL_TASKS" if removing common words leaves overlap
      // Use Set intersection to avoid duplicate words inflating the score
      const candWords = new Set(candParts);
      const overlap = [...rawWords].filter(w => candWords.has(w)).length;
      if (overlap >= 2 && overlap >= rawWords.size * 0.6) {
        debugLog("[Chief flow] Slug fuzzy-corrected:", raw, "→", candidate);
        return candidate;
      }
    }
  }

  return raw;
}

function normaliseComposioMultiExecuteArgs(args) {
  const base = args && typeof args === "object" ? { ...args } : {};
  const tools = Array.isArray(base.tools) ? base.tools : [];
  if (!tools.length) return base;
  base.tools = tools.map((tool) => {
    if (!tool || typeof tool !== "object") return tool;
    const nextSlug = canonicaliseComposioToolSlug(tool.tool_slug);

    // LLMs sometimes use "parameters" or "params" instead of "arguments"
    const explicitArgs = tool.arguments && typeof tool.arguments === "object" ? tool.arguments : {};
    const altArgs = tool.parameters && typeof tool.parameters === "object" ? tool.parameters
      : tool.params && typeof tool.params === "object" ? tool.params
        : {};

    // Also scavenge loose keys that look like actual argument values
    // (not schema metadata like {type, description, examples, items})
    const META_KEYS = new Set(["tool_slug", "arguments", "parameters", "params", "toolkit"]);
    const SCHEMA_SHAPE_KEYS = new Set(["type", "description", "examples", "items", "properties", "required", "default", "enum"]);
    const looseArgs = {};
    for (const [k, v] of Object.entries(tool)) {
      if (META_KEYS.has(k)) continue;
      // If the value looks like a schema definition (has type+description), skip it
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const vKeys = Object.keys(v);
        const isSchemaObj = vKeys.length > 0 && vKeys.every(vk => SCHEMA_SHAPE_KEYS.has(vk));
        if (isSchemaObj) continue;
      }
      looseArgs[k] = v;
    }

    const mergedArgs = { ...looseArgs, ...altArgs, ...explicitArgs };
    return {
      tool_slug: nextSlug || tool.tool_slug,
      arguments: Object.keys(mergedArgs).length ? mergedArgs : {}
    };
  });
  return base;
}

function mapComposioStatusToInstallState(statusValue) {
  const status = String(statusValue || "").toLowerCase();
  if (!status) return "installed";
  if (["active", "connected", "completed", "complete", "success", "succeeded", "ready"].includes(status)) {
    return "installed";
  }
  if (["initiated", "pending", "pending_completion", "in_progress", "authorizing", "awaiting_auth"].includes(status)) {
    return "pending_auth";
  }
  if (["failed", "error", "cancelled", "canceled", "disconnected"].includes(status)) {
    return "failed";
  }
  return "installed";
}

function extractAuthRedirectUrls(response) {
  const text = response?.content?.[0]?.text;
  if (typeof text !== "string") return [];

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return [];
  }

  const urls = new Set();
  const queue = [parsed];
  while (queue.length) {
    const current = queue.shift();
    if (!current || typeof current !== "object") continue;

    if (typeof current.redirect_url === "string" && current.redirect_url.trim()) {
      urls.add(current.redirect_url.trim());
    }

    Object.values(current).forEach((value) => {
      if (Array.isArray(value)) value.forEach((item) => queue.push(item));
      else if (value && typeof value === "object") queue.push(value);
    });
  }

  return Array.from(urls);
}

function clearAuthPollForSlug(toolSlug) {
  const key = String(toolSlug || "").toUpperCase();
  if (!key) return;
  const state = authPollStateBySlug.get(key);
  if (!state) return;
  state.stopped = true;
  if (state.timeoutId) window.clearTimeout(state.timeoutId);
  if (state.hardTimeoutId) window.clearTimeout(state.hardTimeoutId);
  authPollStateBySlug.delete(key);
}

function clearAllAuthPolls() {
  authPollStateBySlug.forEach((_, toolSlug) => {
    clearAuthPollForSlug(toolSlug);
  });
}

function getToolsConfigState(extensionAPI) {
  const schemaVersion = getSettingNumber(extensionAPI, SETTINGS_KEYS.toolsSchemaVersion, 0);
  const installedToolsRaw = getSettingArray(extensionAPI, SETTINGS_KEYS.installedTools, []);
  const installedTools = installedToolsRaw
    .map(normaliseInstalledToolRecord)
    .filter(Boolean);
  const toolPreferences = getSettingObject(extensionAPI, SETTINGS_KEYS.toolPreferences, {});
  const toolPacksEnabled = getSettingArray(extensionAPI, SETTINGS_KEYS.toolPacksEnabled, [])
    .filter((item) => typeof item === "string");

  return {
    schemaVersion,
    installedTools,
    toolPreferences,
    toolPacksEnabled
  };
}

function saveToolsConfigState(extensionAPI, nextState) {
  extensionAPI?.settings?.set?.(SETTINGS_KEYS.toolsSchemaVersion, TOOLS_SCHEMA_VERSION);
  extensionAPI?.settings?.set?.(SETTINGS_KEYS.installedTools, nextState.installedTools || []);
  extensionAPI?.settings?.set?.(SETTINGS_KEYS.toolPreferences, nextState.toolPreferences || {});
  extensionAPI?.settings?.set?.(SETTINGS_KEYS.toolPacksEnabled, nextState.toolPacksEnabled || []);
}

function ensureToolsConfigState(extensionAPI) {
  const current = getToolsConfigState(extensionAPI);
  const needsInit =
    current.schemaVersion !== TOOLS_SCHEMA_VERSION ||
    !Array.isArray(current.installedTools) ||
    typeof current.toolPreferences !== "object" ||
    !Array.isArray(current.toolPacksEnabled);
  if (!needsInit) return current;
  // Version changed — clear stale schema registry so it re-discovers with new logic
  debugLog("[Chief flow] Schema version changed, clearing toolkit schema registry");
  toolkitSchemaRegistryCache = null;
  extensionAPI?.settings?.set?.(SETTINGS_KEYS.toolkitSchemaRegistry, { toolkits: {} });
  const initialState = {
    schemaVersion: TOOLS_SCHEMA_VERSION,
    installedTools: current.installedTools || [],
    toolPreferences: current.toolPreferences || {},
    toolPacksEnabled: current.toolPacksEnabled || []
  };
  saveToolsConfigState(extensionAPI, initialState);
  return initialState;
}

function getLlmProvider(extensionAPI) {
  const raw = getSettingString(extensionAPI, SETTINGS_KEYS.llmProvider, DEFAULT_LLM_PROVIDER).toLowerCase();
  return raw === "openai" ? "openai" : "anthropic";
}

/**
 * Get the API key for the currently selected LLM provider.
 * Falls back to the legacy llmApiKey field for backward compatibility.
 */
function getApiKeyForProvider(extensionAPI, provider) {
  const providerKey = provider === "openai"
    ? getSettingString(extensionAPI, SETTINGS_KEYS.openaiApiKey, "")
    : getSettingString(extensionAPI, SETTINGS_KEYS.anthropicApiKey, "");
  if (providerKey) return providerKey;
  // Fallback: legacy single-key field
  return getSettingString(extensionAPI, SETTINGS_KEYS.llmApiKey, "");
}

/**
 * Get the OpenAI API key specifically (for Whisper, etc.).
 * Checks dedicated OpenAI field first, then legacy field if provider is OpenAI.
 */
function getOpenAiApiKey(extensionAPI) {
  const dedicated = getSettingString(extensionAPI, SETTINGS_KEYS.openaiApiKey, "");
  if (dedicated) return dedicated;
  // Fallback: if the legacy key looks like an OpenAI key or provider is openai
  const legacy = getSettingString(extensionAPI, SETTINGS_KEYS.llmApiKey, "");
  if (legacy && (legacy.startsWith("sk-") || getLlmProvider(extensionAPI) === "openai")) return legacy;
  return "";
}

function getLlmModel(extensionAPI, provider) {
  const configured = getSettingString(extensionAPI, SETTINGS_KEYS.llmModel, "");
  if (configured) return configured;
  return DEFAULT_LLM_MODELS[provider] || DEFAULT_LLM_MODELS.anthropic;
}

function getPowerModel(provider) {
  return POWER_LLM_MODELS[provider] || POWER_LLM_MODELS.anthropic;
}

function getModelCostRates(model) {
  const rates = LLM_MODEL_COSTS[model];
  if (rates) return { inputPerM: rates[0], outputPerM: rates[1] };
  // Fallback: assume mid-range pricing
  return { inputPerM: 2.5, outputPerM: 10.0 };
}

function isDryRunEnabled(extensionAPI) {
  return getSettingBool(extensionAPI, SETTINGS_KEYS.dryRunMode, false);
}

function consumeDryRunMode(extensionAPI) {
  if (!extensionAPI?.settings?.set) return;
  extensionAPI.settings.set(SETTINGS_KEYS.dryRunMode, false);
}

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function safeJsonStringify(value, maxChars = MAX_TOOL_RESULT_CHARS) {
  try {
    const text = JSON.stringify(value);
    if (typeof text !== "string") return "";
    return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…[truncated]`;
  } catch (error) {
    return String(value || "");
  }
}

function truncateForContext(value, maxChars = MAX_CONTEXT_MESSAGE_CHARS) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

function approximateMessageChars(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.reduce((sum, message) => {
    const roleChars = String(message?.role || "").length;
    const content = message?.content;
    const toolCalls = message?.tool_calls;
    const toolCallId = message?.tool_call_id;
    let contentChars = 0;
    if (typeof content === "string") {
      contentChars = content.length;
    } else if (Array.isArray(content)) {
      contentChars = content.reduce((inner, block) => inner + safeJsonStringify(block, 20000).length, 0);
    } else if (content && typeof content === "object") {
      contentChars = safeJsonStringify(content, 20000).length;
    }
    const toolCallsChars = Array.isArray(toolCalls)
      ? toolCalls.reduce((inner, call) => inner + safeJsonStringify(call, 20000).length, 0)
      : 0;
    const toolCallIdChars = String(toolCallId || "").length;
    return sum + roleChars + contentChars + toolCallsChars + toolCallIdChars;
  }, 0);
}

function approximateSingleMessageChars(message) {
  if (!message || typeof message !== "object") return 0;
  const roleChars = String(message?.role || "").length;
  const content = message?.content;
  const toolCalls = message?.tool_calls;
  const toolCallId = message?.tool_call_id;
  let contentChars = 0;
  if (typeof content === "string") {
    contentChars = content.length;
  } else if (Array.isArray(content)) {
    contentChars = content.reduce((inner, block) => inner + safeJsonStringify(block, 20000).length, 0);
  } else if (content && typeof content === "object") {
    contentChars = safeJsonStringify(content, 20000).length;
  }
  const toolCallsChars = Array.isArray(toolCalls)
    ? toolCalls.reduce((inner, call) => inner + safeJsonStringify(call, 20000).length, 0)
    : 0;
  const toolCallIdChars = String(toolCallId || "").length;
  return roleChars + contentChars + toolCallsChars + toolCallIdChars;
}

function pruneAgentMessagesInPlace(
  messages,
  options = {}
) {
  if (!Array.isArray(messages)) return;
  const budget = Number.isFinite(options?.budget)
    ? options.budget
    : MAX_AGENT_MESSAGES_CHAR_BUDGET;
  let prunablePrefixCount = Number.isFinite(options?.prunablePrefixCount)
    ? Math.max(0, Math.floor(options.prunablePrefixCount))
    : messages.length;
  prunablePrefixCount = Math.min(prunablePrefixCount, messages.length);
  const perMessageChars = messages.map((message) => approximateSingleMessageChars(message));
  let totalChars = perMessageChars.reduce((sum, size) => sum + size, 0);
  while (
    messages.length > MIN_AGENT_MESSAGES_TO_KEEP &&
    totalChars > budget &&
    prunablePrefixCount > 0
  ) {
    const removed = perMessageChars.shift() || 0;
    messages.shift();
    totalChars -= removed;
    prunablePrefixCount -= 1;
  }
  return prunablePrefixCount;
}

function truncateToolResultContentText(text, nextChars) {
  const value = String(text || "");
  if (value.length <= nextChars) return value;
  const safeChars = Math.max(120, nextChars - 14);
  return `${value.slice(0, safeChars)}…[truncated]`;
}

function trimToolResultPayloadsInPlace(messages, budget = MAX_AGENT_MESSAGES_CHAR_BUDGET) {
  if (!Array.isArray(messages)) return false;
  const minCharsPerToolResult = 300;
  let changed = false;
  let currentChars = approximateMessageChars(messages);
  if (currentChars <= budget) return changed;

  for (let pass = 0; pass < 6 && currentChars > budget; pass += 1) {
    for (let index = 0; index < messages.length && currentChars > budget; index += 1) {
      const message = messages[index];
      if (!message || typeof message !== "object") continue;

      if (message.role === "tool" && typeof message.content === "string") {
        const existing = message.content;
        if (existing.length <= minCharsPerToolResult) continue;
        const nextChars = Math.max(
          minCharsPerToolResult,
          Math.floor(existing.length * 0.65)
        );
        const trimmed = truncateToolResultContentText(existing, nextChars);
        if (trimmed === existing) continue;
        message.content = trimmed;
        currentChars -= Math.max(0, existing.length - trimmed.length);
        changed = true;
        continue;
      }

      if (message.role === "user" && Array.isArray(message.content)) {
        for (let blockIndex = 0; blockIndex < message.content.length && currentChars > budget; blockIndex += 1) {
          const block = message.content[blockIndex];
          if (block?.type !== "tool_result" || typeof block?.content !== "string") continue;
          const existing = block.content;
          if (existing.length <= minCharsPerToolResult) continue;
          const nextChars = Math.max(
            minCharsPerToolResult,
            Math.floor(existing.length * 0.65)
          );
          const trimmed = truncateToolResultContentText(existing, nextChars);
          if (trimmed === existing) continue;
          block.content = trimmed;
          currentChars -= Math.max(0, existing.length - trimmed.length);
          changed = true;
        }
      }
    }
  }
  return changed;
}

function enforceAgentMessageBudgetInPlace(messages, options = {}) {
  const budget = Number.isFinite(options?.budget)
    ? options.budget
    : MAX_AGENT_MESSAGES_CHAR_BUDGET;
  const prunablePrefixCount = pruneAgentMessagesInPlace(messages, {
    budget,
    prunablePrefixCount: options?.prunablePrefixCount
  });
  if (approximateMessageChars(messages) > budget) {
    trimToolResultPayloadsInPlace(messages, budget);
  }
  return prunablePrefixCount;
}

function getAgentOverBudgetMessage() {
  return "I gathered too much tool output to send safely in one request. Please narrow the request (for example: fewer items or a smaller date range) and retry.";
}

function normaliseConversationTurn(input) {
  const user = truncateForContext(input?.user || "");
  const assistant = truncateForContext(input?.assistant || "");
  if (!user && !assistant) return null;
  return {
    user,
    assistant,
    createdAt: Number.isFinite(input?.createdAt) ? input.createdAt : Date.now()
  };
}

function persistConversationContext(extensionAPI = extensionAPIRef) {
  extensionAPI?.settings?.set?.(SETTINGS_KEYS.conversationContext, conversationTurns);
}

function loadConversationContext(extensionAPI) {
  const raw = getSettingArray(extensionAPI, SETTINGS_KEYS.conversationContext, []);
  const normalised = raw
    .map(normaliseConversationTurn)
    .filter(Boolean);
  conversationTurns = normalised.slice(normalised.length - MAX_CONVERSATION_TURNS);
}

function getConversationMessages() {
  const messages = [];
  conversationTurns.forEach((turn) => {
    const userText = truncateForContext(turn?.user || "");
    const assistantText = truncateForContext(turn?.assistant || "");
    if (userText) messages.push({ role: "user", content: userText });
    if (assistantText) messages.push({ role: "assistant", content: assistantText });
  });
  return messages;
}

function appendConversationTurn(userText, assistantText, extensionAPI = extensionAPIRef) {
  const user = truncateForContext(userText || "");
  const assistant = truncateForContext(assistantText || "");
  if (!user && !assistant) return;
  conversationTurns.push({ user, assistant, createdAt: Date.now() });
  if (conversationTurns.length > MAX_CONVERSATION_TURNS) {
    conversationTurns = conversationTurns.slice(conversationTurns.length - MAX_CONVERSATION_TURNS);
  }
  persistConversationContext(extensionAPI);
}

function clearConversationContext(options = {}) {
  const { persist = false, extensionAPI = extensionAPIRef } = options;
  conversationTurns = [];
  lastPromptSections = null;
  lastKnownPageContext = null;
  if (persist) persistConversationContext(extensionAPI);
}

function getComposioMetaToolsFromMcpList(listResult) {
  const tools = Array.isArray(listResult?.tools) ? listResult.tools : [];
  return tools
    .filter((tool) => typeof tool?.name === "string" && tool.name.startsWith("COMPOSIO_"))
    .map((tool) => ({
      name: tool.name,
      description: tool.description || "",
      input_schema:
        tool.inputSchema && typeof tool.inputSchema === "object"
          ? tool.inputSchema
          : { type: "object", properties: {} },
      source: "composio"
    }));
}

function getComposioMetaToolsForLlm() {
  return [
    {
      name: "COMPOSIO_SEARCH_TOOLS",
      description: "Discover app-specific tool slugs and schemas for a use case.",
      input_schema: {
        type: "object",
        properties: {
          queries: {
            type: "array",
            items: {
              type: "object",
              properties: {
                use_case: { type: "string" }
              },
              required: ["use_case"]
            }
          },
          session: {
            type: "object",
            properties: {
              id: { type: "string" },
              generate_id: { type: "boolean" }
            }
          }
        },
        required: ["queries"]
      },
      source: "composio"
    },
    {
      name: "COMPOSIO_MULTI_EXECUTE_TOOL",
      description: "Execute one or more discovered Composio tool slugs with arguments.",
      input_schema: {
        type: "object",
        properties: {
          tools: {
            type: "array",
            items: {
              type: "object",
              properties: {
                tool_slug: { type: "string" },
                arguments: { type: "object" }
              },
              required: ["tool_slug"]
            }
          }
        },
        required: ["tools"]
      },
      source: "composio"
    },
    {
      name: "COMPOSIO_MANAGE_CONNECTIONS",
      description: "Check, list, or initiate toolkit connections/authentication.",
      input_schema: {
        type: "object",
        properties: {
          action: { type: "string" },
          toolkits: {
            type: "array",
            items: { type: "string" }
          },
          session_id: { type: "string" }
        }
      },
      source: "composio"
    },
    {
      name: "COMPOSIO_GET_CONNECTED_ACCOUNTS",
      description: "List currently connected accounts and connection status.",
      input_schema: {
        type: "object",
        properties: {}
      },
      source: "composio",
      execute: () => {
        const extensionAPI = extensionAPIRef;
        if (!extensionAPI) return { connected: false, accounts: [] };
        const { installedTools } = getToolsConfigState(extensionAPI);
        const accounts = installedTools
          .filter((t) => t.enabled)
          .map((t) => ({ slug: t.slug, status: t.installState, connectionId: t.connectionId || null }));
        return { connected: mcpClient != null, accounts };
      }
    }
  ];
}

function getRoamAlphaApi() {
  const api = window?.roamAlphaAPI;
  if (!api) throw new Error("Roam API unavailable in current context.");
  return api;
}

function requireRoamQueryApi(api = getRoamAlphaApi()) {
  if (!api?.q) throw new Error("Roam query API unavailable.");
  return api;
}

async function queryRoamDatalog(query, api = getRoamAlphaApi()) {
  if (api?.data?.async?.q) {
    return api.data.async.q(query);
  }
  const queryApi = requireRoamQueryApi(api);
  return queryApi.q(query);
}

function requireRoamWriteApi(api = getRoamAlphaApi()) {
  if (!api?.util?.generateUID || !api?.createBlock) {
    throw new Error("Roam createBlock API unavailable.");
  }
  return api;
}

function requireRoamCreatePageApi(api = getRoamAlphaApi()) {
  if (!api?.createPage) throw new Error("Roam createPage API unavailable.");
  return api;
}

function escapeForDatalog(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

// Extract block string from any Roam API key format (:block/string, block/string, or string)
function getBlockString(block) {
  return String(block?.[":block/string"] ?? block?.["block/string"] ?? block?.string ?? "");
}
function getBlockUid(block) {
  return String(block?.[":block/uid"] ?? block?.["block/uid"] ?? block?.uid ?? "");
}
function getBlockChildren(block) {
  return Array.isArray(block?.[":block/children"]) ? block[":block/children"]
    : Array.isArray(block?.children) ? block.children : [];
}

async function getCurrentPageContext() {
  try {
    const api = getRoamAlphaApi();
    let uid = null;
    // Primary: Roam API (may return a Promise in some versions)
    try {
      const raw = api.ui?.mainWindow?.getOpenPageOrBlockUid?.();
      uid = (raw && typeof raw.then === "function") ? await raw : raw;
    } catch { /* ignore */ }
    // Fallback: parse UID from URL hash (#/app/graphname/page/uid)
    if (!uid) {
      const hashMatch = window.location.hash.match(/\/page\/([a-zA-Z0-9_-]+)/);
      if (hashMatch) uid = hashMatch[1];
    }
    // Fallback: read first data-page-uid from the DOM (works on daily notes stream)
    if (!uid) {
      const titleEl = document.querySelector(".rm-title-display-container[data-page-uid]");
      if (titleEl) uid = titleEl.getAttribute("data-page-uid");
    }
    if (!uid) {
      // Last resort: today's daily page
      const now = new Date();
      const todayUid = `${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}-${now.getFullYear()}`;
      const todayTitle = formatRoamDate(now);
      return { uid: todayUid, title: todayTitle, type: "page" };
    }
    const rows = api.q?.(`[:find ?t :where [?e :block/uid "${uid}"] [?e :node/title ?t]]`) || [];
    const title = String(rows?.[0]?.[0] || "").trim();
    if (title) return { uid, title, type: "page" };
    const blockRows = api.q?.(`[:find ?s :where [?b :block/uid "${uid}"] [?b :block/string ?s]]`) || [];
    const blockText = String(blockRows?.[0]?.[0] || "").trim();
    return { uid, title: blockText || uid, type: "block" };
  } catch {
    return null;
  }
}

function openRoamPageByTitle(pageTitle) {
  try {
    const api = getRoamAlphaApi();
    const escaped = escapeForDatalog(pageTitle);
    const rows = api.q?.(`[:find ?uid :where [?p :node/title "${escaped}"] [?p :block/uid ?uid]]`) || [];
    const uid = String(rows?.[0]?.[0] || "").trim();
    if (!uid) {
      debugLog("[Chief flow] openRoamPageByTitle: page not found:", pageTitle);
      return;
    }
    api.ui.mainWindow.openPage({ page: { uid } });
    debugLog("[Chief flow] Opened page:", pageTitle, uid);
  } catch (error) {
    console.warn("[Chief of Staff] Failed to open page:", pageTitle, error?.message || error);
  }
}

function formatRoamDate(date) {
  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];
  const day = date.getDate();
  const suffix = day === 1 || day === 21 || day === 31
    ? "st"
    : day === 2 || day === 22
      ? "nd"
      : day === 3 || day === 23
        ? "rd"
        : "th";
  return `${months[date.getMonth()]} ${day}${suffix}, ${date.getFullYear()}`;
}

function flattenBlockTree(block) {
  const uid = block?.[":block/uid"] ?? block?.uid ?? "";
  const text = block?.[":block/string"] ?? block?.string ?? "";
  const orderRaw = block?.[":block/order"] ?? block?.order;
  const childrenRaw = block?.[":block/children"] ?? block?.children;
  return {
    uid: String(uid || ""),
    text: String(text || ""),
    order: Number.isFinite(orderRaw) ? orderRaw : 0,
    children: Array.isArray(childrenRaw)
      ? childrenRaw.map(flattenBlockTree).sort((left, right) => left.order - right.order)
      : []
  };
}

function getPageUidByTitle(title) {
  const api = requireRoamQueryApi(getRoamAlphaApi());
  const escapedTitle = escapeForDatalog(title);
  const result = api.q(`[:find ?uid :where [?p :node/title "${escapedTitle}"] [?p :block/uid ?uid]]`);
  return Array.isArray(result) && result[0] ? result[0][0] : null;
}

async function getPageUidByTitleAsync(title) {
  const escapedTitle = escapeForDatalog(title);
  const result = await queryRoamDatalog(`[:find ?uid :where [?p :node/title "${escapedTitle}"] [?p :block/uid ?uid]]`);
  return Array.isArray(result) && result[0] ? result[0][0] : null;
}

function getPageTreeByTitle(title) {
  const api = requireRoamQueryApi(getRoamAlphaApi());
  const escapedTitle = escapeForDatalog(title);
  const pageResult = api.q(`[:find (pull ?p [:block/uid :node/title {:block/children [:block/uid :block/string :block/order {:block/children [:block/uid :block/string :block/order {:block/children [:block/uid :block/string :block/order {:block/children ...}]}]}]}]) .
    :where
    [?p :node/title "${escapedTitle}"]]`);
  if (!pageResult) {
    return {
      title,
      uid: null,
      children: []
    };
  }
  const pageUid = String(pageResult?.[":block/uid"] || pageResult?.uid || "");
  const pageChildren = pageResult?.[":block/children"] || pageResult?.children || [];
  const children = Array.isArray(pageChildren)
    ? pageChildren.map((item) => flattenBlockTree(item)).sort((left, right) => left.order - right.order)
    : [];

  return {
    title,
    uid: pageUid || null,
    children
  };
}

async function getPageTreeByTitleAsync(title) {
  const escapedTitle = escapeForDatalog(title);
  const pageResult = await queryRoamDatalog(`[:find (pull ?p [:block/uid :node/title {:block/children [:block/uid :block/string :block/order {:block/children [:block/uid :block/string :block/order {:block/children [:block/uid :block/string :block/order {:block/children ...}]}]}]}]) .
    :where
    [?p :node/title "${escapedTitle}"]]`);
  if (!pageResult) {
    return {
      title,
      uid: null,
      children: []
    };
  }
  const pageUid = String(pageResult?.[":block/uid"] || pageResult?.uid || "");
  const pageChildren = pageResult?.[":block/children"] || pageResult?.children || [];
  const children = Array.isArray(pageChildren)
    ? pageChildren.map((item) => flattenBlockTree(item)).sort((left, right) => left.order - right.order)
    : [];

  return {
    title,
    uid: pageUid || null,
    children
  };
}

function truncateRoamBlockText(text) {
  const originalText = String(text || "");
  const safeText = originalText.slice(0, MAX_ROAM_BLOCK_CHARS);
  if (safeText.length < originalText.length) {
    debugLog(`[Chief flow] Block text truncated from ${originalText.length} to ${MAX_ROAM_BLOCK_CHARS} chars`);
  }
  return safeText;
}

async function withRoamWriteRetry(fn, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === retries) throw error;
      const delay = 300 * Math.pow(2, attempt); // 300ms, 600ms
      debugLog(`[Chief flow] Roam write failed (attempt ${attempt + 1}/${retries + 1}), retrying in ${delay}ms...`, error?.message);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

async function createRoamBlock(parentUid, text, order = "last") {
  return withRoamWriteRetry(async () => {
    const api = requireRoamWriteApi(getRoamAlphaApi());
    const uid = api.util.generateUID();
    const safeText = truncateRoamBlockText(text);

    await api.createBlock({
      location: {
        "parent-uid": parentUid,
        order: order === "first" ? 0 : "last"
      },
      block: {
        uid,
        string: safeText
      }
    });
    return uid;
  });
}

function countBlockTreeNodes(blockDefs) {
  if (!Array.isArray(blockDefs)) return 0;
  let count = 0;
  for (const def of blockDefs) {
    count += 1;
    if (Array.isArray(def?.children)) count += countBlockTreeNodes(def.children);
  }
  return count;
}

async function createRoamBlockTree(parentUid, blockDef, order = "last") {
  const text = String(blockDef?.text || "");
  const uid = await createRoamBlock(parentUid, text, order);
  const children = Array.isArray(blockDef?.children) ? blockDef.children : [];
  for (let index = 0; index < children.length; index += 1) {
    await createRoamBlockTree(uid, children[index], index);
  }
  return uid;
}

async function ensureDailyPageUid(date = new Date()) {
  const api = getRoamAlphaApi();
  const pageTitle = formatRoamDate(date);
  let pageUid = await getPageUidByTitleAsync(pageTitle);
  if (!pageUid) {
    requireRoamCreatePageApi(api);
    await api.createPage({ page: { title: pageTitle } });
    pageUid = await getPageUidByTitleAsync(pageTitle);
  }
  return {
    pageUid,
    pageTitle
  };
}

async function writeResponseToTodayDailyPage(userPrompt, responseText) {
  const { pageUid, pageTitle } = await ensureDailyPageUid(new Date());
  if (!pageUid) throw new Error("Could not resolve today's daily page UID.");

  const assistantName = getAssistantDisplayName();
  const headerText = `**${assistantName}** — ${String(userPrompt || "").trim() || "Ask"}`;
  const parentUid = await createRoamBlock(pageUid, headerText, "last");
  await createRoamBlock(parentUid, String(responseText || "").trim() || "No response generated.", "last");
  return { pageUid, pageTitle, parentUid };
}

/**
 * Parse markdown text into a Roam block tree: { text, children: [...] }.
 * Handles headings (##-####), list items (- / * / 1.), and plain paragraphs.
 * Indented list items become children of the preceding item.
 */
function parseMarkdownToBlockTree(markdown) {
  const raw = String(markdown || "").trim();
  if (!raw) return [];

  const lines = raw.split(/\n/);
  // Each node: { text, children: [], depth }
  // depth: 0 = top-level, 1 = h3/h4 under h2, etc.

  const roots = [];
  // Stack tracks the nesting context: [{ node, depth }]
  const stack = [];

  function currentParent() {
    return stack.length ? stack[stack.length - 1].node : null;
  }

  function pushNode(node, depth) {
    // Pop stack until we find a parent with lower depth
    while (stack.length && stack[stack.length - 1].depth >= depth) {
      stack.pop();
    }
    const parent = currentParent();
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
    stack.push({ node, depth });
  }

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimEnd();

    // Skip blank lines
    if (!trimmed.trim()) { i++; continue; }

    // Heading: ## / ### / ####
    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length; // 1-6
      const text = headingMatch[2].trim();
      pushNode({ text, children: [] }, level);
      i++;
      continue;
    }

    // List item: detect indent level then strip marker
    const listMatch = trimmed.match(/^(\s*)([-*]|\d+[.)]) (.+)$/);
    if (listMatch) {
      const indent = listMatch[1].length;
      const text = listMatch[3].trim();
      // Depth: headings use 1-6, list items use 10 + indent/2 to avoid clashing
      const depth = 10 + Math.floor(indent / 2);
      pushNode({ text, children: [] }, depth);
      i++;
      continue;
    }

    // Bold-only line (e.g. **Today:** or **Tomorrow**) — treat as a sub-heading
    // at depth 7 (just below headings 1-6, above list items at 10+)
    const boldLineMatch = trimmed.match(/^\*\*[^*]+\*\*:?\s*$/);
    if (boldLineMatch) {
      pushNode({ text: trimmed.trim(), children: [] }, 7);
      i++;
      continue;
    }

    // Plain paragraph text — push as a top-level-ish node under current heading
    const paragraphDepth = stack.length ? stack[stack.length - 1].depth + 1 : 0;
    pushNode({ text: trimmed.trim(), children: [] }, paragraphDepth);
    i++;
  }

  return roots;
}

async function writeStructuredResponseToTodayDailyPage(heading, responseText) {
  const { pageUid, pageTitle } = await ensureDailyPageUid(new Date());
  if (!pageUid) throw new Error("Could not resolve today's daily page UID.");

  const tree = parseMarkdownToBlockTree(responseText);
  const headerUid = await createRoamBlock(pageUid, heading, "last");

  if (tree.length) {
    for (let i = 0; i < tree.length; i++) {
      await createRoamBlockTree(headerUid, tree[i], i);
    }
  } else {
    // Fallback: write as single block if parsing produced nothing
    await createRoamBlock(headerUid, String(responseText || "").trim(), "last");
  }

  return { pageUid, pageTitle, parentUid: headerUid };
}

function getMemoryPromptCacheSignature() {
  return `${getActiveMemoryPageTitles().join("|")}::${MEMORY_MAX_CHARS_PER_PAGE}::${MEMORY_TOTAL_MAX_CHARS}`;
}

function invalidateMemoryPromptCache() {
  memoryPromptCache = {
    expiresAt: 0,
    content: "",
    signature: getMemoryPromptCacheSignature()
  };
}

function flattenTreeToLines(children, depth = 0) {
  const lines = [];
  const indent = "  ".repeat(Math.max(0, depth));
  for (const child of Array.isArray(children) ? children : []) {
    const text = String(child?.text || "").trim();
    if (text) lines.push(`${indent}- ${text}`);
    if (Array.isArray(child?.children) && child.children.length) {
      lines.push(...flattenTreeToLines(child.children, depth + 1));
    }
  }
  return lines;
}

async function getMemoryPageContent(pageTitle, maxChars = MEMORY_MAX_CHARS_PER_PAGE) {
  try {
    const tree = await getPageTreeByTitleAsync(pageTitle);
    if (!tree?.uid || !Array.isArray(tree?.children) || tree.children.length === 0) return "";
    const text = flattenTreeToLines(tree.children, 0).join("\n");
    if (!text) return "";
    const safeMax = Math.max(200, Number(maxChars) || MEMORY_MAX_CHARS_PER_PAGE);
    return text.length <= safeMax ? text : `${text.slice(0, safeMax)}\n…[truncated]`;
  } catch (error) {
    console.warn("[Chief of Staff] Failed to fetch memory page:", pageTitle, error?.message);
    return "";
  }
}

async function getAllMemoryContent(options = {}) {
  const { force = false } = options;
  const now = Date.now();
  const signature = getMemoryPromptCacheSignature();
  if (
    !force &&
    memoryPromptCache.content &&
    memoryPromptCache.expiresAt > now &&
    memoryPromptCache.signature === signature
  ) {
    return memoryPromptCache.content;
  }

  const sections = [];
  let totalChars = 0;
  for (const title of getActiveMemoryPageTitles()) {
    if (totalChars >= MEMORY_TOTAL_MAX_CHARS) break;
    const remaining = MEMORY_TOTAL_MAX_CHARS - totalChars;
    const maxForPage = Math.min(MEMORY_MAX_CHARS_PER_PAGE, Math.max(0, remaining));
    const content = await getMemoryPageContent(title, maxForPage);
    if (!content) continue;
    sections.push(`### ${title.replace("Chief of Staff/", "")}\n${content}`);
    totalChars += content.length;
  }

  const merged = sections.length ? `## Your Memory\n\n${sections.join("\n\n")}` : "";
  memoryPromptCache = {
    expiresAt: Date.now() + MEMORY_CACHE_TTL_MS,
    content: merged,
    signature
  };
  return merged;
}

function getSkillsPromptCacheSignature() {
  return `${SKILLS_PAGE_TITLE}::${SKILLS_MAX_CHARS}::${SKILLS_INDEX_MAX_CHARS}`;
}

function invalidateSkillsPromptCache() {
  skillsPromptCache = {
    expiresAt: 0,
    content: "",
    indexContent: "",
    entries: [],
    detectedCount: 0,
    injectedCount: 0,
    signature: getSkillsPromptCacheSignature()
  };
}

function normaliseSkillName(rawName) {
  return String(rawName || "")
    .replace(/^skill\s*:\s*/i, "")
    .trim();
}

function normaliseSkillIndexSummary(line) {
  const raw = String(line || "").trim();
  if (!raw) return "";
  const withoutBullet = raw.replace(/^-+\s*/, "");
  return withoutBullet
    .replace(/^trigger\s*:\s*/i, "")
    .replace(/^approach\s*:\s*/i, "")
    .replace(/^output\s*format\s*:\s*/i, "")
    .trim();
}

function extractFirstSentenceFromText(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const match = text.match(/^(.+?[.!?])(?:\s|$)/);
  if (match?.[1]) return match[1].trim();
  return text;
}

function buildSkillEntriesFromTree(tree) {
  const topChildren = Array.isArray(tree?.children) ? tree.children : [];
  return topChildren
    .map((child, index) => {
      const rawTitle = String(child?.text || "").trim();
      if (!rawTitle) return null;
      const title = normaliseSkillName(rawTitle) || `Skill ${index + 1}`;
      const uid = String(child?.uid || "").trim() || null;
      const detailLines = flattenTreeToLines(child?.children || [], 1);
      const childrenLines = flattenTreeToLines(child?.children || [], 0);
      const detailText = detailLines
        .map((line) => normaliseSkillIndexSummary(line))
        .filter(Boolean)
        .join(" ");
      const summary = extractFirstSentenceFromText(detailText);
      const contentLines = [`- ${title}`, ...detailLines];
      const content = contentLines.join("\n");
      const childrenContent = childrenLines.join("\n");
      return {
        title,
        rawTitle,
        uid,
        content,
        childrenContent,
        summary
      };
    })
    .filter(Boolean);
}

async function getSkillEntries(options = {}) {
  const { force = false } = options;
  const now = Date.now();
  const signature = getSkillsPromptCacheSignature();
  if (
    !force &&
    Array.isArray(skillsPromptCache.entries) &&
    skillsPromptCache.expiresAt > now &&
    skillsPromptCache.signature === signature
  ) {
    return skillsPromptCache.entries;
  }

  const tree = await getPageTreeByTitleAsync(SKILLS_PAGE_TITLE);
  const entries = buildSkillEntriesFromTree(tree);
  if (!entries.length) {
    skillsPromptCache = {
      expiresAt: Date.now() + SKILLS_CACHE_TTL_MS,
      content: "",
      indexContent: "",
      entries: [],
      detectedCount: 0,
      injectedCount: 0,
      signature
    };
    return [];
  }

  const lines = [];
  let consumedChars = 0;
  const injectedEntries = [];
  for (const entry of entries) {
    const text = String(entry.content || "");
    if (!text) continue;
    const remaining = SKILLS_MAX_CHARS - consumedChars;
    if (remaining <= 0) break;
    if (text.length <= remaining) {
      lines.push(text);
      injectedEntries.push(entry);
      consumedChars += text.length;
      continue;
    }
    const trimmed = `${text.slice(0, Math.max(0, remaining - 20))}\n  …[truncated]`;
    lines.push(trimmed);
    injectedEntries.push({
      ...entry,
      content: trimmed
    });
    consumedChars = SKILLS_MAX_CHARS;
    break;
  }

  const content = lines.length ? `## Available Skills\n\n${lines.join("\n\n")}` : "";
  skillsPromptCache = {
    expiresAt: Date.now() + SKILLS_CACHE_TTL_MS,
    content,
    indexContent: "",
    entries,
    detectedCount: entries.length,
    injectedCount: 0,
    signature
  };
  return entries;
}

async function getSkillsContent(options = {}) {
  const { force = false } = options;
  if (!force && skillsPromptCache.content && skillsPromptCache.expiresAt > Date.now()) {
    return skillsPromptCache.content;
  }
  await getSkillEntries({ force });
  return skillsPromptCache.content || "";
}

async function getSkillsIndexContent(options = {}) {
  const { force = false } = options;
  const now = Date.now();
  if (!force && skillsPromptCache.indexContent && skillsPromptCache.expiresAt > now) {
    return skillsPromptCache.indexContent;
  }

  const entries = await getSkillEntries({ force });
  if (!entries.length) {
    skillsPromptCache.indexContent = "";
    skillsPromptCache.injectedCount = 0;
    return "";
  }

  // Names-only index — compact, always fits all skills
  const namesList = entries.map((entry) => `- ${entry.title}`).join("\n");
  skillsPromptCache.indexContent = `## Available Skills\n\n${namesList}\n\nUse the cos_get_skill tool to load a skill's full instructions before applying it.`;
  skillsPromptCache.injectedCount = entries.length;
  return skillsPromptCache.indexContent;
}

async function findSkillEntryByName(skillName, options = {}) {
  const target = String(skillName || "").trim().toLowerCase();
  if (!target) return null;
  const entries = await getSkillEntries(options);
  if (!entries.length) return null;
  const exact = entries.find((entry) => entry.title.toLowerCase() === target);
  if (exact) return exact;
  return entries.find((entry) => entry.title.toLowerCase().includes(target)) || null;
}

function resolveMemoryPageTitle(page) {
  const key = String(page || "").trim().toLowerCase();
  const pageMap = {
    memory: "Chief of Staff/Memory",
    inbox: "Chief of Staff/Inbox",
    notes: "Chief of Staff/Inbox",
    idea: "Chief of Staff/Inbox",
    ideas: "Chief of Staff/Inbox",
    skill: "Chief of Staff/Skills",
    skills: "Chief of Staff/Skills",
    projects: "Chief of Staff/Projects",
    decisions: "Chief of Staff/Decisions",
    lessons: "Chief of Staff/Lessons Learned",
    lessons_learned: "Chief of Staff/Lessons Learned",
    "lessons learned": "Chief of Staff/Lessons Learned"
  };
  return pageMap[key] || null;
}

function requireRoamUpdateBlockApi(api = getRoamAlphaApi()) {
  if (!api?.updateBlock) throw new Error("Roam updateBlock API unavailable.");
  return api;
}

async function ensurePageUidByTitle(pageTitle) {
  const safeTitle = String(pageTitle || "").trim();
  if (!safeTitle) throw new Error("pageTitle is required");

  const api = getRoamAlphaApi();
  let pageUid = await getPageUidByTitleAsync(safeTitle);
  if (!pageUid) {
    requireRoamCreatePageApi(api);
    await api.createPage({ page: { title: safeTitle } });
    pageUid = await getPageUidByTitleAsync(safeTitle);
  }
  if (!pageUid) throw new Error(`Could not create page: ${safeTitle}`);
  return pageUid;
}

async function updateChiefMemory({ page, action = "append", content, block_uid } = {}) {
  const pageTitle = resolveMemoryPageTitle(page);
  if (!pageTitle) {
    throw new Error(`Invalid memory page: "${page}". Use memory, inbox, skills, projects, decisions, or lessons.`);
  }

  const text = String(content || "").trim();
  if (!text) throw new Error("content is required");
  const pageUid = await ensurePageUidByTitle(pageTitle);

  if (String(action || "").toLowerCase() === "replace_children") {
    const uid = String(block_uid || "").trim();
    if (!uid) throw new Error("block_uid is required for replace_children");
    if (pageTitle !== SKILLS_PAGE_TITLE) {
      throw new Error("replace_children is only supported on the skills page.");
    }
    const api = getRoamAlphaApi();
    const apiQuery = requireRoamQueryApi(api);
    const escapedUid = escapeForDatalog(uid);

    // Verify block is on the skills page
    const targetPage = apiQuery.q(`[:find ?pageTitle .
      :where
      [?b :block/uid "${escapedUid}"]
      [?b :block/page ?p]
      [?p :node/title ?pageTitle]]`);
    if (String(targetPage || "").trim() !== SKILLS_PAGE_TITLE) {
      throw new Error(`UID ${uid} is not on the skills page.`);
    }

    // Get existing children to delete
    const childUids = apiQuery.q(`[:find [?childUid ...]
      :where
      [?b :block/uid "${escapedUid}"]
      [?b :block/children ?c]
      [?c :block/uid ?childUid]]`) || [];

    // Delete all existing children
    for (const childUid of childUids) {
      await withRoamWriteRetry(() => api.deleteBlock({ block: { uid: childUid } }));
    }

    // Parse new content into block tree and create children with nesting preserved
    // Normalise escaped newlines from LLM output
    debugLog("[Chief memory] replace_children raw content:", JSON.stringify(text).slice(0, 500));
    let normalisedText = text.replace(/\\n/g, "\n").replace(/\\t/g, "\t");

    // If the LLM sent everything on one line with " - " as delimiters (no real newlines),
    // split on " - " patterns that look like list items (preceded by newline-ish context)
    const realNewlineCount = (normalisedText.match(/\n/g) || []).length;
    const dashItemCount = (normalisedText.match(/\s+-\s+\S/g) || []).length;
    if (realNewlineCount < 2 && dashItemCount >= 2) {
      // Likely a single-line blob — split " - " into newlines, preserving the dash
      normalisedText = normalisedText.replace(/\s+-\s+/g, "\n- ");
    }

    // Strip the skill name if the LLM included it as the first line (it's already the parent block)
    const skillTitle = apiQuery.q(`[:find ?s .
      :where
      [?b :block/uid "${escapedUid}"]
      [?b :block/string ?s]]`) || "";
    if (skillTitle) {
      const titleLower = String(skillTitle).trim().toLowerCase();
      const lines = normalisedText.split("\n");
      const firstLine = lines[0].replace(/^[-#*\s]+/, "").trim().toLowerCase();
      if (firstLine === titleLower
        || firstLine.startsWith(titleLower + " skill")
        || firstLine.startsWith(titleLower + ":")
        || firstLine.startsWith(titleLower + "\n")
        || firstLine === titleLower + " -") {
        normalisedText = lines.slice(1).join("\n").trim();
      }
    }

    // Final cleanup: if lines start with the skill title followed by content (e.g. "Daily Briefing - Trigger:...")
    // the title strip above may have missed it because it was mid-line before splitting
    if (skillTitle) {
      const titleLower = String(skillTitle).trim().toLowerCase();
      const lines = normalisedText.split("\n");
      if (lines.length > 0) {
        const first = lines[0].replace(/^[-*\s]+/, "").trim().toLowerCase();
        if (first === titleLower || first === titleLower + " skill") {
          normalisedText = lines.slice(1).join("\n").trim();
        }
      }
    }

    debugLog("[Chief memory] replace_children normalised (first 500):", normalisedText.slice(0, 500));
    debugLog("[Chief memory] replace_children newline count:", (normalisedText.match(/\n/g) || []).length);
    const blockTree = parseMarkdownToBlockTree(normalisedText);
    debugLog("[Chief memory] replace_children blockTree roots:", blockTree.length, "total nodes:", JSON.stringify(blockTree).length);
    for (let i = 0; i < blockTree.length; i++) {
      await createRoamBlockTree(uid, blockTree[i], "last");
    }

    invalidateSkillsPromptCache();
    return { success: true, action: "replace_children", page: pageTitle, block_uid: uid, deleted: childUids.length, created: blockTree.length };
  }

  if (String(action || "").toLowerCase() === "replace_block") {
    const uid = String(block_uid || "").trim();
    if (!uid) throw new Error("block_uid is required for replace_block");
    const apiQuery = requireRoamQueryApi(getRoamAlphaApi());
    const escapedUid = escapeForDatalog(uid);
    const targetPage = apiQuery.q(`[:find ?pageTitle .
      :where
      [?b :block/uid "${escapedUid}"]
      [?b :block/page ?p]
      [?p :node/title ?pageTitle]]`);
    const targetPageTitle = String(targetPage || "").trim();
    if (!targetPageTitle) {
      throw new Error(`Could not resolve page for block UID: ${uid}`);
    }
    if (!getActiveMemoryPageTitles().includes(targetPageTitle) && targetPageTitle !== SKILLS_PAGE_TITLE) {
      throw new Error(`UID ${uid} is not on a Chief of Staff memory/skills page.`);
    }
    if (targetPageTitle !== pageTitle) {
      throw new Error(`UID ${uid} belongs to "${targetPageTitle}", not "${pageTitle}".`);
    }
    await withRoamWriteRetry(async () => {
      const api = requireRoamUpdateBlockApi(getRoamAlphaApi());
      await api.updateBlock({ block: { uid, string: truncateRoamBlockText(text) } });
    });
    invalidateMemoryPromptCache();
    if (pageTitle === SKILLS_PAGE_TITLE) invalidateSkillsPromptCache();
    return { success: true, action: "replaced", page: pageTitle, block_uid: uid };
  }

  const isDatedLogPage =
    pageTitle === "Chief of Staff/Decisions" ||
    pageTitle === "Chief of Staff/Lessons Learned";
  const prefixedText = isDatedLogPage && !text.startsWith("[[")
    ? `[[${formatRoamDate(new Date())}]] ${text}`
    : text;
  const uid = await createRoamBlock(pageUid, prefixedText, "last");
  invalidateMemoryPromptCache();
  if (pageTitle === SKILLS_PAGE_TITLE) invalidateSkillsPromptCache();
  return { success: true, action: "appended", page: pageTitle, uid };
}

async function bootstrapMemoryPages() {
  const starterPages = [
    {
      title: "Chief of Staff/Memory",
      lines: [
        "Preferences and context for Chief of Staff AI assistant.",
        "Communication style: concise, action-oriented",
        "Timezone: (set your timezone)",
        "Key contacts: (add key people you work with)"
      ]
    },
    {
      title: "Chief of Staff/Inbox",
      lines: [
        "Quick captures from chat (notes, ideas, reminders).",
        "Triage periodically into Projects, Decisions, or Better Tasks."
      ]
    },
    ...(!hasBetterTasksAPI() ? [{
      title: "Chief of Staff/Projects",
      lines: [
        "Active projects tracked by Chief of Staff.",
        "(Add your projects here, one block per project with nested details)"
      ]
    }] : []),
    {
      title: "Chief of Staff/Decisions",
      lines: [
        "Decision log — Chief of Staff appends entries with dates.",
        `[[${formatRoamDate(new Date())}]] Initialised Chief of Staff memory system.`
      ]
    },
    {
      title: "Chief of Staff/Lessons Learned",
      lines: [
        "Operational lessons, pitfalls, and fixes discovered while working.",
        "Format: problem → fix → prevention/guardrail.",
        `[[${formatRoamDate(new Date())}]] Initialised lessons learned log.`
      ]
    }
  ];

  let createdCount = 0;
  for (const page of starterPages) {
    const existingUid = getPageUidByTitle(page.title);
    if (existingUid) continue;
    const pageUid = await ensurePageUidByTitle(page.title);
    for (let index = 0; index < page.lines.length; index += 1) {
      await createRoamBlock(pageUid, page.lines[index], index);
    }
    createdCount += 1;
  }

  invalidateMemoryPromptCache();
  return { createdCount };
}


// --- Better Tasks tools via Extension Tools API ---
function getBetterTasksTools() {
  const ext = getBetterTasksExtension();
  if (!ext || !Array.isArray(ext.tools)) return [];

  const nameMap = {
    "bt_search": "roam_bt_search_tasks",
    "bt_create": "roam_bt_create_task",
    "bt_modify": "roam_bt_modify_task",
    "bt_get_projects": "roam_bt_get_projects",
    "bt_get_waiting_for": "roam_bt_get_waiting_for",
    "bt_get_context": "roam_bt_get_context",
    "bt_get_attributes": "roam_bt_get_attributes"
  };

  return ext.tools
    .filter(t => t?.name && nameMap[t.name])
    .map(t => ({
      name: nameMap[t.name],
      description: t.description || "",
      input_schema: t.parameters || { type: "object", properties: {} },
      execute: async (args = {}) => {
        try {
          const result = await t.execute(args);
          return result && typeof result === "object" ? result : { result };
        } catch (e) {
          return { error: e?.message || `Failed: ${t.name}` };
        }
      }
    }));
}

function getRoamNativeTools() {
  if (roamNativeToolsCache) return roamNativeToolsCache;
  roamNativeToolsCache = [
    {
      name: "roam_search",
      description: "Search Roam block text content and return matching blocks with page context.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Case-insensitive text to search for." },
          max_results: { type: "number", description: "Maximum matches to return. Default 20." }
        },
        required: ["query"]
      },
      execute: async ({ query, max_results = 20 } = {}) => {
        const api = getRoamAlphaApi();
        const queryText = String(query || "").trim().toLowerCase();
        if (!queryText) return [];
        const escapedQuery = escapeForDatalog(queryText);
        const limit = Number.isFinite(max_results) ? Math.max(1, Math.min(500, max_results)) : 20;
        const hardCap = Math.max(200, limit);
        const baseQuery = `[:find ?uid ?str ?page-title
          :where
          [?b :block/string ?str]
          [?b :block/uid ?uid]
          [?b :block/page ?p]
          [?p :node/title ?page-title]
          [(clojure.string/includes? (clojure.string/lower-case ?str) "${escapedQuery}")]]`;
        let results;
        try {
          results = await queryRoamDatalog(`${baseQuery.slice(0, -1)}
          :limit ${hardCap}]`);
        } catch (error) {
          console.warn("[Chief of Staff] Roam :limit unsupported; running unbounded roam_search scan.");
          results = await queryRoamDatalog(baseQuery, api);
        }
        return (Array.isArray(results) ? results : [])
          .slice(0, limit)
          .map(([uid, text, page]) => ({ uid, text, page }));
      }
    },
    {
      name: "roam_get_page",
      description: "Get a page block tree by exact page title.",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Exact page title." }
        },
        required: ["title"]
      },
      execute: async ({ title } = {}) => {
        const pageTitle = String(title || "").trim();
        if (!pageTitle) throw new Error("title is required");
        return getPageTreeByTitleAsync(pageTitle);
      }
    },
    {
      name: "roam_get_daily_page",
      description: "Get today's daily page (or a provided date) with full block tree.",
      input_schema: {
        type: "object",
        properties: {
          date: { type: "string", description: "Optional ISO date string (YYYY-MM-DD)." }
        }
      },
      execute: async ({ date } = {}) => {
        const targetDate = date ? new Date(date) : new Date();
        if (Number.isNaN(targetDate.getTime())) throw new Error("Invalid date value");
        return getPageTreeByTitleAsync(formatRoamDate(targetDate));
      }
    },
    {
      name: "roam_open_page",
      description: "Open a page in Roam's main window by title or UID. Use this when the user asks to navigate to, open, or go to a page.",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Page title to open (e.g. 'January 6th, 2026')." },
          uid: { type: "string", description: "Page or block UID to open. Takes priority over title." }
        }
      },
      execute: async ({ title, uid } = {}) => {
        const api = getRoamAlphaApi();
        const pageUid = String(uid || "").trim();
        const pageTitle = String(title || "").trim();
        if (!pageUid && !pageTitle) throw new Error("Either title or uid is required");

        if (pageUid) {
          await api.ui.mainWindow.openPage({ page: { uid: pageUid } });
          return { success: true, opened: pageUid };
        }
        // Resolve title to UID
        const rows = api.q?.(`[:find ?uid :where [?p :node/title "${escapeForDatalog(pageTitle)}"] [?p :block/uid ?uid]]`) || [];
        if (!rows.length) throw new Error(`Page not found: "${pageTitle}"`);
        const resolvedUid = String(rows[0]?.[0] || "").trim();
        if (!resolvedUid) throw new Error(`Could not resolve UID for "${pageTitle}"`);
        await api.ui.mainWindow.openPage({ page: { uid: resolvedUid } });
        return { success: true, opened: pageTitle, uid: resolvedUid };
      }
    },
    {
      name: "roam_create_block",
      description: "Create a new block in Roam under a parent block/page UID.",
      input_schema: {
        type: "object",
        properties: {
          parent_uid: { type: "string", description: "Parent block or page UID." },
          text: { type: "string", description: "Block text content." },
          order: { type: "string", description: "\"first\" or \"last\". Default \"last\"." }
        },
        required: ["parent_uid", "text"]
      },
      execute: async ({ parent_uid, text, order = "last" } = {}) => {
        const parentUid = String(parent_uid || "").trim();
        if (!parentUid) throw new Error("parent_uid is required");
        const uid = await createRoamBlock(parentUid, text, order);
        return {
          success: true,
          uid,
          parent_uid: parentUid
        };
      }
    },
    {
      name: "roam_delete_block",
      description: "Delete a block (and all its children) from Roam by UID. Use this to delete Better Tasks or any other block. Requires the block's UID.",
      input_schema: {
        type: "object",
        properties: {
          uid: { type: "string", description: "Block UID to delete." }
        },
        required: ["uid"]
      },
      execute: async ({ uid } = {}) => {
        const blockUid = String(uid || "").trim();
        if (!blockUid) throw new Error("uid is required");
        const api = getRoamAlphaApi();
        if (!api?.deleteBlock) throw new Error("Roam deleteBlock API unavailable");
        await withRoamWriteRetry(() => api.deleteBlock({ block: { uid: blockUid } }));
        return { success: true, deleted_uid: blockUid };
      }
    },
    {
      name: "roam_create_blocks",
      description: "Create multiple blocks (with optional nested children) under a parent UID.",
      input_schema: {
        type: "object",
        properties: {
          parent_uid: { type: "string", description: "Parent block or page UID." },
          blocks: {
            type: "array",
            description: "List of block definitions.",
            items: {
              type: "object",
              properties: {
                text: { type: "string" },
                children: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      text: { type: "string" },
                      children: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            text: { type: "string" }
                          },
                          required: ["text"]
                        }
                      }
                    },
                    required: ["text"]
                  }
                }
              },
              required: ["text"]
            }
          }
        },
        required: ["parent_uid", "blocks"]
      },
      execute: async ({ parent_uid, blocks } = {}) => {
        const parentUid = String(parent_uid || "").trim();
        if (!parentUid) throw new Error("parent_uid is required");
        if (!Array.isArray(blocks) || !blocks.length) throw new Error("blocks must be a non-empty array");
        const totalNodes = countBlockTreeNodes(blocks);
        if (totalNodes > MAX_CREATE_BLOCKS_TOTAL) {
          throw new Error(`Too many blocks (${totalNodes}). Maximum is ${MAX_CREATE_BLOCKS_TOTAL} per call.`);
        }

        const created = [];
        for (let index = 0; index < blocks.length; index += 1) {
          const uid = await createRoamBlockTree(parentUid, blocks[index], index);
          created.push(uid);
        }
        return {
          success: true,
          created_count: created.length,
          created_uids: created,
          parent_uid: parentUid
        };
      }
    },
    {
      name: "cos_get_skill",
      description: "Load the full instructions for a specific skill by name. Use this before applying any skill. Returns the complete skill content from the Skills page.",
      input_schema: {
        type: "object",
        properties: {
          skill_name: {
            type: "string",
            description: "Name of the skill to load (must match a name from the Available Skills list)."
          }
        },
        required: ["skill_name"]
      },
      execute: async (args = {}) => {
        const name = String(args?.skill_name || "").trim();
        if (!name) return JSON.stringify({ error: "skill_name is required" });
        const entry = await findSkillEntryByName(name, { force: false });
        if (!entry) {
          const entries = await getSkillEntries({ force: false });
          const available = entries.map((e) => e.title).join(", ");
          return JSON.stringify({ error: `Skill "${name}" not found. Available: ${available}` });
        }
        return JSON.stringify({
          skill_name: entry.title,
          block_uid: entry.uid || null,
          content: entry.content,
          children_content: entry.childrenContent || ""
        });
      }
    },
    {
      name: "cos_update_memory",
      description: "Append or update Chief of Staff memory pages. Pages: memory, inbox, skills, projects, decisions, lessons. Actions: append (default), replace_block (needs block_uid), replace_children (replaces all children of a skill block — needs block_uid, skills page only).",
      input_schema: {
        type: "object",
        properties: {
          page: {
            type: "string",
            description: "Target memory page: memory, inbox, skills, projects, decisions, or lessons."
          },
          action: {
            type: "string",
            description: "append (default), replace_block, or replace_children (skills page only — rewrites all child blocks under the given block_uid)."
          },
          content: {
            type: "string",
            description: "Content to write. For replace_children (skills): use markdown list items with ACTUAL NEWLINES between items (- item1\\n- item2), NOT a single line. Do not include the skill name."
          },
          block_uid: {
            type: "string",
            description: "Required for replace_block: block UID to replace."
          }
        },
        required: ["page", "action", "content"]
      },
      execute: async (args = {}) => updateChiefMemory(args)
    }
  ];
  return roamNativeToolsCache;
}

function getCosIntegrationTools() {
  return [
    {
      name: "cos_email_fetch",
      description:
        "Fetch emails from Gmail via Composio. Returns a summary of inbox messages. Call this before cos_email_delete.",
      input_schema: {
        type: "object",
        properties: {
          max_results: { type: "number", description: "Max emails to return. Default 5, max 20." },
          unread_only: { type: "boolean", description: "If true, fetch only unread emails." },
          urgent_only: { type: "boolean", description: "If true, filter for urgent/action-required emails." }
        }
      },
      execute: async ({ max_results, unread_only, urgent_only } = {}) =>
        runDeterministicEmailRead({ maxResults: max_results, unreadOnly: unread_only, urgentOnly: urgent_only })
    },
    {
      name: "cos_email_unread_count",
      description: "Check how many unread emails are in Gmail.",
      input_schema: {
        type: "object",
        properties: {
          threshold: {
            type: "number",
            description: "Report yes/no based on whether unread count exceeds this value. Default 1."
          }
        }
      },
      execute: async ({ threshold } = {}) => runDeterministicEmailUnreadCount({ threshold })
    },
    {
      name: "cos_email_delete",
      description:
        "Delete or trash a Gmail message. Requires cos_email_fetch to have been called first in this session. Identify the email by target_hint (subject/sender keywords) or target_index (1-based position from last fetch).",
      input_schema: {
        type: "object",
        properties: {
          target_hint: { type: "string", description: "Subject or sender keywords to identify the email." },
          target_index: { type: "number", description: "1-based index from the last email fetch." }
        }
      },
      execute: async ({ target_hint, target_index } = {}) =>
        runDeterministicEmailDelete({ targetHint: target_hint, targetIndex: target_index })
    },
    {
      name: "cos_calendar_fetch",
      description: "Fetch calendar events from Google Calendar via Composio.",
      input_schema: {
        type: "object",
        properties: {
          day_offset: {
            type: "number",
            description: "Days from today. 0 = today, 1 = tomorrow, -1 = yesterday. Default 0."
          },
          max_results: { type: "number", description: "Max events to return. Default 10." }
        }
      },
      execute: async ({ day_offset, max_results } = {}) =>
        runDeterministicCalendarRead({ dayOffset: day_offset, maxResults: max_results })
    }
  ];
}

async function getAvailableToolSchemas() {
  const metaTools = getComposioMetaToolsForLlm();
  const registry = getToolkitSchemaRegistry();

  // If all connected toolkits have cached schemas, mark SEARCH_TOOLS as fallback-only
  let adjustedMetaTools = metaTools;
  const extensionAPI = extensionAPIRef;
  if (extensionAPI) {
    const { installedTools } = getToolsConfigState(extensionAPI);
    const connected = installedTools
      .filter(t => t.enabled && t.installState === "installed")
      .map(t => inferToolkitFromSlug(t.slug));
    const allCovered = connected.length > 0 && connected.every(tk => {
      const entry = registry.toolkits?.[tk];
      return entry && Object.values(entry.tools || {}).some(t => t.input_schema);
    });
    if (allCovered) {
      adjustedMetaTools = metaTools.map(t => {
        if (t.name === "COMPOSIO_SEARCH_TOOLS") {
          return {
            ...t,
            description: "FALLBACK ONLY — use this only when a tool slug from the Connected Toolkit Schemas section fails. Prefer using COMPOSIO_MULTI_EXECUTE_TOOL directly with slugs from the schema section."
          };
        }
        return t;
      });
    }
  }

  const tools = [...adjustedMetaTools, ...getRoamNativeTools(), ...getBetterTasksTools(), ...getCosIntegrationTools(), ...getExternalExtensionTools()];
  return tools;
}

/**
 * Detect which features the user query likely needs.
 * Returns a set of section keys to include.
 */
function detectPromptSections(userMessage) {
  const text = String(userMessage || "").toLowerCase();
  const sections = new Set(["core"]); // always include core instructions

  // Email/Gmail
  if (/\b(email|gmail|inbox|unread|mail|message|send|draft|compose)\b/.test(text)) {
    sections.add("composio");
    sections.add("toolkit_GMAIL");
  }

  // Calendar (including common typos)
  if (/\b(cal[ea]n[dn]a?[rt]|schedule|event|meeting|appointment|agenda|gcal)\b/.test(text)) {
    sections.add("composio");
    sections.add("toolkit_GOOGLECALENDAR");
  }

  // Todoist
  if (/\b(todoist)\b/.test(text)) {
    sections.add("composio");
    sections.add("toolkit_TODOIST");
  }

  // Slack
  if (/\b(slack|channel|dm)\b/.test(text)) {
    sections.add("composio");
    sections.add("toolkit_SLACK");
  }

  // GitHub
  if (/\b(github|repo|pull request|pr|issue|commit)\b/.test(text)) {
    sections.add("composio");
    sections.add("toolkit_GITHUB");
  }

  // Generic external service / Composio mentions
  if (/\b(connect|install|composio|integration|app|tool)\b/.test(text)) {
    sections.add("composio");
  }

  // Better Tasks / Roam tasks — only when clearly referencing Roam's task system
  if (/\b(bt_|better tasks?|roam.*(task|todo))\b/.test(text)) {
    sections.add("bt_schema");
  }
  // Generic task words trigger BT only if no external service is mentioned
  if (/\b(tasks?|todo|done|overdue|due|project)\b/.test(text) &&
    !/\b(todoist|slack|github|gmail|calendar|asana|jira|notion|trello|linear)\b/.test(text)) {
    sections.add("bt_schema");
  }

  // Memory
  if (/\b(remember|memory|forget|preference|learned)\b/.test(text)) {
    sections.add("memory");
  }

  // Skills
  if (/\b(skill|apply skill)\b/.test(text)) {
    sections.add("skills");
  }

  // If nothing specific detected, check if this is a follow-up to a previous query
  if (sections.size <= 1) {
    if (lastPromptSections && lastPromptSections.size > 1) {
      // Short messages like "yes", "sure", "tell me more" are likely follow-ups
      const isLikelyFollowUp = text.length < 60 || /^(yes|no|sure|ok|please|go ahead|tell me|show me|do it|help|more|details)\b/.test(text);
      if (isLikelyFollowUp) {
        for (const s of lastPromptSections) sections.add(s);
      }
    }
  }

  // If still nothing specific, include everything (first message, general queries)
  if (sections.size <= 1) {
    sections.add("composio");
    sections.add("bt_schema");
    // Include all toolkit schemas
    const registry = getToolkitSchemaRegistry();
    for (const tk of Object.keys(registry.toolkits || {})) {
      sections.add(`toolkit_${tk}`);
    }
  }

  // Memory and skills are cheap — always include them
  sections.add("memory");
  sections.add("skills");

  return sections;
}

function buildBetterTasksPromptSection() {
  if (!hasBetterTasksAPI()) return "";
  const tools = getBetterTasksTools();
  if (!tools.length) return "";
  const toolList = tools.map(t => `  - ${t.name}: ${t.description}`).join("\n");
  return `## Better Tasks (via Extension Tools API)

Available tools:
${toolList}

CRITICAL: When modifying a task, ALWAYS use the exact uid from the most recent search result. Never reuse UIDs from earlier turns — always re-search first.
Use roam_bt_get_attributes to discover available attribute names if needed.`;
}

async function buildDefaultSystemPrompt(userMessage) {
  const sections = detectPromptSections(userMessage);

  const [memoryBlock, skillsBlock, pageCtx] = await Promise.all([getAllMemoryContent(), getSkillsIndexContent(), getCurrentPageContext()]);
  debugLog("[Chief flow] Skills index preview:", String(skillsBlock || "").slice(0, 300));
  const memorySection = memoryBlock
    ? `${memoryBlock}

Use this memory to personalise responses. Do not repeat memory back unless asked.
When the user says "remember this" or you learn significant preferences, project updates, decisions,
or operational lessons learned (problems and fixes),
use the cos_update_memory tool to save it.`
    : `## Your Memory

No memory pages found. You can create them with the "Chief of Staff: Bootstrap Memory Pages" command
or use the cos_update_memory tool to create memory records on demand.`;
  const skillsSection = skillsBlock
    ? `${skillsBlock}

When the user asks about skills, list all skill names from the index above.
When you need to apply a skill, first call cos_get_skill to load its full instructions, then follow them.
Do not copy skill text verbatim to the user unless explicitly asked.
When the user asks to improve, edit, or optimise a skill (e.g. "that briefing was too verbose, update the skill"):
1. Call cos_get_skill to load the current skill content and its block_uid. The response includes a "children_content" field — use this as the starting point for edits (it has the correct indent structure).
2. Incorporate the user's feedback to produce improved skill instructions.
3. Call cos_update_memory with page="skills", action="replace_children", block_uid=<the skill's block_uid>, and content=<the new instructions as markdown>.
   - CRITICAL: Use actual newlines between items, not literal "\\n" sequences.
   - Do NOT include the skill name as the first line — the parent block already has it.
   - Each top-level instruction MUST start with "- " at the beginning of the line (no leading spaces).
   - Sub-items should be indented with two spaces before the dash: "  - sub-item".
   - Preserve the existing structure (Trigger, Approach, Output sections) unless the user asks to change it.
   - Example format:
- Trigger: when X happens
- Approach: do Y via Z
  - Detail about Y
- Output: produce W
- Keep responses concise.
4. Confirm the change and briefly summarise what was updated.
5. Do NOT re-run the skill after updating it. Just confirm the update and stop.`
    : `## Available Skills

No skills page found yet. Create [[Chief of Staff/Skills]] with one top-level block per skill.`;

  const schemaSection = sections.has("composio")
    ? buildToolkitSchemaPromptSection(sections)
    : "";

  const btSchema = sections.has("bt_schema") ? buildBetterTasksPromptSection() : "";

  const coreInstructions = `You are Chief of Staff, an AI assistant embedded in Roam Research.
You orchestrate work across Composio tools and the user's Roam graph.

Use available tools when needed. Be concise and practical.
Ask for confirmation before actions that send, modify, or delete external data.
Never claim you performed an action without making the corresponding tool call. If a user asks you to do something, you must call the tool — do not infer the result from conversation history.

For Composio:
- Connected toolkit schemas are listed below under "Connected Toolkit Schemas". Use those exact tool slugs and parameter names directly via COMPOSIO_MULTI_EXECUTE_TOOL — no need to call COMPOSIO_SEARCH_TOOLS first when the tool is already listed below.
- Only use COMPOSIO_SEARCH_TOOLS to discover tools NOT listed in the cached schemas below.
- Use COMPOSIO_MANAGE_CONNECTIONS for authentication/connection state.
- For email requests, call cos_email_fetch or cos_email_unread_count directly — they handle the connection check internally.
- For calendar requests, call cos_calendar_fetch directly — it handles the connection check internally.
- When the user asks about an external service by name (e.g. "todoist", "slack", "github"), use the matching Composio tools, not Roam tools.
- Never claim email/calendar results without at least one successful external tool call in the current turn.
- For email/calendar delete or update requests, ask for confirmation and then execute the tool call; do not substitute a read/list response.
- For "what is connected" or "connection status", use COMPOSIO_GET_CONNECTED_ACCOUNTS (reads from local settings, no MCP call needed).

For Roam:
- Use roam_search for text lookup in graph blocks
- Use roam_get_page or roam_get_daily_page to locate context before writing
- Use roam_open_page to navigate the user to a page in Roam's main window
- When referencing Roam pages in your response, use [[Page Title]] syntax — these become clickable links in the chat panel
- Use roam_create_block only when the user asks to save/write into Roam
- Use roam_delete_block to delete blocks or Better Tasks by UID. The BT search results include the task UID — use that UID directly for deletion.

Summarise results clearly for the user.

Today is ${formatRoamDate(new Date())}.
${pageCtx ? (pageCtx.type === "page"
    ? `The user is currently viewing the page [[${pageCtx.title}]] (uid: ${pageCtx.uid}). When they say "this page" or "the current page", use this uid.`
    : `The user is currently viewing a block (uid: ${pageCtx.uid}). When they say "this page" or "this block", use this uid.`)
  : ""}

For Memory:
- Your memory is loaded below from Roam pages and persists across sessions.
- Use cos_update_memory when the user explicitly asks you to remember something.
- Use the inbox memory page for quick note/idea/capture items from chat.
- Also use cos_update_memory for genuinely useful preference, project, decision, or lessons-learned changes.
- Do not write memory on every interaction.

Always use British English spelling and conventions (e.g. organise, prioritise, colour, behaviour, centre, recognised).
`;

  // Inject live project context from BT if available
  let projectContext = "";
  if (hasBetterTasksAPI()) {
    try {
      const projectResult = await runBetterTasksTool("bt_get_projects", { status: "active", include_tasks: true });
      if (projectResult && !projectResult.error && Array.isArray(projectResult.projects) && projectResult.projects.length) {
        const projectLines = projectResult.projects.map(p => {
          let line = `- ${p.name}`;
          if (p.task_counts) {
            const counts = Object.entries(p.task_counts)
              .filter(([, v]) => v > 0)
              .map(([k, v]) => `${v} ${k}`)
              .join(", ");
            if (counts) line += ` (${counts})`;
          }
          return line;
        });
        projectContext = `## Active Projects (from Better Tasks)\n${projectLines.join("\n")}`;
      }
    } catch (e) {
      debugLog("[Chief flow] BT project context fetch failed:", e?.message);
    }
  }

  // Build a summary of external extension tools so the LLM knows they exist
  let extToolsSummary = "";
  try {
    const registry = getExtensionToolsRegistry();
    const extLines = [];
    for (const [extKey, ext] of Object.entries(registry)) {
      if (extKey === "better-tasks") continue;
      if (!ext || !Array.isArray(ext.tools) || !ext.tools.length) continue;
      const label = String(ext.name || extKey).trim();
      const toolNames = ext.tools.filter(t => t?.name && typeof t.execute === "function").map(t => t.name).join(", ");
      if (toolNames) extLines.push(`- **${label}**: ${toolNames}`);
    }
    if (extLines.length) {
      extToolsSummary = `## Roam Extension Tools (Local)\nThe following Roam extensions have registered tools you can call DIRECTLY by tool name. Do NOT route these through COMPOSIO_MULTI_EXECUTE_TOOL — they are local tools, not Composio actions.\n${extLines.join("\n")}`;
    }
  } catch (e) {
    debugLog("[Chief flow] Extension tools summary failed:", e?.message);
  }

  const parts = [coreInstructions, memorySection, projectContext, extToolsSummary, skillsSection, schemaSection, btSchema].filter(Boolean);
  const fullPrompt = parts.join("\n\n");

  debugLog("[Chief flow] System prompt breakdown:", {
    coreInstructions: coreInstructions.length,
    memory: memorySection.length,
    projectContext: projectContext.length,
    extToolsSummary: extToolsSummary.length,
    skills: skillsSection.length,
    toolkitSchemas: schemaSection.length,
    btSchema: btSchema.length,
    total: fullPrompt.length,
    sectionsIncluded: [...sections].join(", ")
  });

  // Save for follow-up detection
  lastPromptSections = sections;

  return fullPrompt;
}

function isConnectionStatusIntent(userMessage) {
  const text = String(userMessage || "").toLowerCase();
  if (!text) return false;

  const patterns = [
    "connected tools",
    "tool connections",
    "active connections",
    "connected apps",
    "composio apps",
    "apps from composio",
    "apps in composio",
    "apps do i have from composio",
    "what composio apps",
    "what apps do i have",
    "what is connected",
    "what's connected",
    "what tools are connected",
    "summarise my current connected tools",
    "summarize my current connected tools",
    "list my connected tools",
    "show my connected tools",
    "connection status"
  ];
  return patterns.some((pattern) => text.includes(pattern));
}

function parseMemorySaveIntent(userMessage) {
  const text = String(userMessage || "").trim();
  if (!text) return null;

  const inboxDirectMatch = text.match(/^(?:note|capture|idea)\s*[:\-]\s*(.+)$/i);
  if (inboxDirectMatch) {
    const content = String(inboxDirectMatch[1] || "").trim();
    if (!content) return null;
    return { page: "inbox", content };
  }

  const saveIdeaMatch = text.match(/^(?:save|remember|record)\s+(?:this\s+)?idea\s*[:\-]\s*(.+)$/i);
  if (saveIdeaMatch) {
    const content = String(saveIdeaMatch[1] || "").trim();
    if (!content) return null;
    return { page: "inbox", content };
  }

  const saveNoteMatch = text.match(/^(?:save|remember|record)\s+(?:this\s+)?note\s*[:\-]\s*(.+)$/i);
  if (saveNoteMatch) {
    const content = String(saveNoteMatch[1] || "").trim();
    if (!content) return null;
    return { page: "inbox", content };
  }

  const lessonMatch = text.match(/^(?:remember|save|note|record)\s+(?:this\s+)?lesson\s*[:\-]\s*(.+)$/i);
  if (lessonMatch) {
    const content = String(lessonMatch[1] || "").trim();
    if (!content) return null;
    return { page: "lessons", content };
  }

  const decisionMatch = text.match(/^(?:remember|save|note|record)\s+(?:this\s+)?decision\s*[:\-]\s*(.+)$/i);
  if (decisionMatch) {
    const content = String(decisionMatch[1] || "").trim();
    if (!content) return null;
    return { page: "decisions", content };
  }

  const projectMatch = text.match(/^(?:remember|save|note|record)\s+(?:this\s+)?project(?:\s+update)?\s*[:\-]\s*(.+)$/i);
  if (projectMatch) {
    const content = String(projectMatch[1] || "").trim();
    if (!content) return null;
    return { page: "projects", content };
  }

  const genericRememberMatch = text.match(/^(?:remember|save|note|record)\s+(?:this|that)\s*[:\-]\s*(.+)$/i);
  if (genericRememberMatch) {
    const content = String(genericRememberMatch[1] || "").trim();
    if (!content) return null;
    return { page: "memory", content };
  }

  return null;
}

function parseSkillInvocationIntent(userMessage) {
  const text = String(userMessage || "").trim();
  if (!text) return null;

  const explicitMatch = text.match(/^(?:use|apply|run)\s+(?:the\s+)?skill\s+["“]?([^"”]+?)["”]?(?:\s+(?:on|for)\s+(.+))?$/i);
  if (explicitMatch) {
    return {
      skillName: String(explicitMatch[1] || "").trim(),
      targetText: String(explicitMatch[2] || "").trim(),
      originalPrompt: text
    };
  }

  const inverseMatch = text.match(/^(?:use|apply|run)\s+(.+?)\s+skill(?:\s+(?:on|for)\s+(.+))?$/i);
  if (inverseMatch) {
    return {
      skillName: String(inverseMatch[1] || "").trim(),
      targetText: String(inverseMatch[2] || "").trim(),
      originalPrompt: text
    };
  }
  return null;
}

function parseComposioDeregisterIntent(userMessage, options = {}) {
  const { installedSlugs = [] } = options;
  const text = String(userMessage || "").trim();
  if (!text) return null;
  const lowered = text.toLowerCase();
  if (!/(deregister|uninstall|remove|disconnect)/i.test(lowered)) return null;
  const installedSet = new Set(
    (Array.isArray(installedSlugs) ? installedSlugs : [])
      .map((value) => normaliseToolSlugToken(value))
      .filter(Boolean)
  );
  const hasComposioContext = /(composio|tool|connection|integration|app|connected)/i.test(lowered);

  const quotedMatch = text.match(/"([^"]+)"/);
  const fromQuotes = normaliseToolSlugToken(String(quotedMatch?.[1] || "").trim());
  if (fromQuotes) {
    if (hasComposioContext || installedSet.has(fromQuotes)) {
      return { toolSlug: fromQuotes };
    }
    return null;
  }

  const directMatch = text.match(/\b(?:deregister|uninstall|remove|disconnect)\s+(?:(?:the|a|an)\s+)?(?:composio\s+)?(?:tool\s+)?([a-z][a-z0-9_ -]*)/i);
  const rawSlug = String(directMatch?.[1] || "").trim()
    .replace(/\s*tools?\s*$/i, "")  // strip trailing "tool"
  // Real tool slugs are 1–3 words max
  const slugWords = rawSlug.split(/\s+/).filter(Boolean);
  if (slugWords.length > 3) return null;
  // Reject if any word is a common English word — real Composio slugs are product/service names
  const slugStopWords = /^(a|an|the|my|some|any|this|that|it|its|from|to|in|on|for|with|about|at|by|of|random|please|just|here|there|all|every|each|no|not|but|or|and|so|yet)$/i;
  if (slugWords.some(w => slugStopWords.test(w))) return null;
  const directSlug = normaliseToolSlugToken(rawSlug.replace(/\s+/g, ""));
  if (!directSlug) return null;
  if (!hasComposioContext && !installedSet.has(directSlug)) return null;
  return { toolSlug: directSlug };
}

function parseComposioInstallIntent(userMessage) {
  const text = String(userMessage || "").trim();
  if (!text) return null;
  const lowered = text.toLowerCase();
  if (!/(install|add|connect|enable|set\s*up)\b/i.test(lowered)) return null;
  // Exclude deregister-style phrases
  if (/(deregister|uninstall|remove|disconnect)\b/i.test(lowered)) return null;
  // Must mention composio/tool/integration context or be a clear "install X" pattern
  if (!/(composio|tool|integration|service)\b/i.test(lowered) &&
    !/\b(?:install|add|connect|enable|set\s*up)\s+[a-z]/i.test(lowered)) return null;

  // Try quoted slug first
  const quotedMatch = text.match(/"([^"]+)"/);
  if (quotedMatch) {
    const slug = normaliseToolSlugToken(String(quotedMatch[1]).trim());
    if (slug) return { toolSlug: slug };
  }

  // Direct match: "install todoist", "add the gmail tool", "connect google calendar"
  const directMatch = text.match(/\b(?:install|add|connect|enable|set\s*up)\s+(?:(?:the|a|an)\s+)?(?:composio\s+)?(?:tool\s+)?([a-z][a-z0-9_ -]*)/i);
  const rawSlug = String(directMatch?.[1] || "").trim()
    .replace(/\s*tools?\s*$/i, "") // strip trailing "tool"
  // Real tool slugs are 1–3 words max (e.g. "gmail", "google calendar", "semantic scholar")
  const slugWords = rawSlug.split(/\s+/).filter(Boolean);
  if (slugWords.length > 3) return null;
  // Reject if any word is a common English word — real Composio slugs are product/service names
  const slugStopWords = /^(a|an|the|my|some|any|this|that|it|its|from|to|in|on|for|with|about|at|by|of|random|please|just|here|there|all|every|each|no|not|but|or|and|so|yet)$/i;
  if (slugWords.some(w => slugStopWords.test(w))) return null;
  const slug = normaliseToolSlugToken(rawSlug.replace(/\s+/g, ""));
  if (!slug) return null;
  return { toolSlug: slug };
}

function collectObjectRecordsDeep(value, maxRecords = 300) {
  const queue = [value];
  const seen = new Set();
  const records = [];
  while (queue.length && records.length < maxRecords) {
    const current = queue.shift();
    if (!current || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (!Array.isArray(current)) {
      records.push(current);
    }
    Object.values(current).forEach((next) => {
      if (next && typeof next === "object") queue.push(next);
    });
  }
  return records;
}

function firstNonEmptyString(record, keys = []) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function normaliseEmailField(value, { allowUnknown = false } = {}) {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  const lowered = trimmed.toLowerCase();
  if (lowered === "string" || lowered === "null" || lowered === "undefined") return "";
  if (!allowUnknown && (lowered === "(unknown)" || lowered === "unknown")) return "";
  return trimmed;
}

function normaliseEmailTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const asDate = new Date(value);
    if (!Number.isNaN(asDate.getTime())) return asDate.toISOString();
  }
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^\d{12,16}$/.test(trimmed)) {
    const millis = Number.parseInt(trimmed, 10);
    if (Number.isFinite(millis)) {
      const asDate = new Date(millis);
      if (!Number.isNaN(asDate.getTime())) return asDate.toISOString();
    }
  }
  const parsed = new Date(trimmed);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  return trimmed;
}

function extractEmailRecords(result, maxRecords = 600) {
  const records = collectObjectRecordsDeep(result, Math.max(50, Math.min(1000, maxRecords)));
  const items = [];
  records.forEach((record) => {
    const subject = normaliseEmailField(
      firstNonEmptyString(record, ["subject", "title", "subject_line"])
    );
    const from = normaliseEmailField(
      firstNonEmptyString(record, ["from", "sender", "from_name", "from_email", "author"]),
      { allowUnknown: true }
    );
    const date = normaliseEmailTimestamp(
      firstNonEmptyString(record, [
        "date",
        "received_at",
        "internalDate",
        "internal_date",
        "created_at",
        "timestamp",
        "sent_at"
      ])
    );
    const preview = normaliseEmailField(
      firstNonEmptyString(record, ["snippet", "preview", "body_preview", "summary"]),
      { allowUnknown: true }
    );
    const messageId = normaliseEmailField(
      firstNonEmptyString(record, [
        "message_id",
        "messageId",
        "id",
        "gmail_message_id",
        "msg_id",
        "mail_id"
      ])
    );
    const threadId = normaliseEmailField(
      firstNonEmptyString(record, ["thread_id", "threadId", "gmail_thread_id"])
    );

    // Keep only rows that look like a real email payload.
    if (!subject && !preview) return;
    if (!from && !messageId && !threadId) return;

    items.push({ subject, from, date, preview, messageId, threadId });
  });

  const deduped = [];
  const seen = new Set();
  items.forEach((item) => {
    const key = item.messageId || `${item.subject}|${item.from}|${item.date}|${item.preview}`;
    if (seen.has(key)) return;
    seen.add(key);
    deduped.push(item);
  });

  const sorted = [...deduped].sort((left, right) => {
    const leftTs = Date.parse(left.date || "");
    const rightTs = Date.parse(right.date || "");
    if (Number.isFinite(leftTs) && Number.isFinite(rightTs) && leftTs !== rightTs) {
      return rightTs - leftTs;
    }
    return 0;
  });
  return sorted.slice(0, Math.max(1, maxRecords));
}

function summariseEmailRecords(items, maxResults = 5) {
  const top = (Array.isArray(items) ? items : []).slice(0, Math.max(1, maxResults));
  if (!top.length) {
    return "I checked live email tools but couldn't parse a readable message list from the response.";
  }

  const lines = top.map((item, index) => {
    const subject = item.subject || "(no subject)";
    const from = item.from ? `From: ${item.from}` : "From: (unknown)";
    const date = item.date ? `Date: ${item.date}` : "";
    const preview = item.preview ? `Preview: ${item.preview}` : "";
    return `${index + 1}. ${subject}\n   ${from}${date ? `\n   ${date}` : ""}${preview ? `\n   ${preview}` : ""}`;
  });
  return `Here are your latest ${top.length} email(s):\n\n${lines.join("\n\n")}`;
}

function extractInboxUnreadCount(result) {
  const records = collectObjectRecordsDeep(result, 800);
  for (const record of records) {
    const id = record?.id ?? record?.label_id ?? record?.labelId;
    if (typeof id === "string" && id.toUpperCase() === "INBOX") {
      const n = record?.messagesUnread ?? record?.messages_unread ?? record?.unread_count ?? record?.unreadCount;
      if (typeof n === "number" && Number.isFinite(n) && n >= 0) return n;
      const ns = typeof n === "string" && /^\d+$/.test(n.trim()) ? Number.parseInt(n.trim(), 10) : NaN;
      if (Number.isFinite(ns)) return ns;
    }
  }
  return null;
}

function extractEstimatedUnreadCount(result) {
  const records = collectObjectRecordsDeep(result, 800);
  const keys = [
    "messagesUnread",
    "messages_unread",
    "threadsUnread",
    "threads_unread",
    "unread_count",
    "unreadCount",
    "total_unread",
    "totalUnread"
  ];
  let best = null;
  records.forEach((record) => {
    keys.forEach((key) => {
      const value = record?.[key];
      const asNumber = typeof value === "number"
        ? value
        : (typeof value === "string" && /^\d+$/.test(value.trim()) ? Number.parseInt(value.trim(), 10) : NaN);
      if (!Number.isFinite(asNumber) || asNumber < 0) return;
      if (!Number.isFinite(best) || asNumber > best) best = asNumber;
    });
  });
  return Number.isFinite(best) ? best : null;
}

function summariseCalendarRecords(result) {
  // First try to extract events from the standard Google Calendar response shape
  const gcalItems = extractGoogleCalendarItems(result);
  if (gcalItems.length) {
    const top = gcalItems.slice(0, 15);
    const lines = top.map((item, index) => {
      const title = item.title || "(untitled event)";
      const parts = [item.start, item.end, item.location].filter(Boolean);
      const detail = parts.length ? ` — ${parts.join(" | ")}` : "";
      return `${index + 1}. ${title}${detail}`;
    });
    if (!top.length) {
      return "No events found for that time window.";
    }
    return `Here are your calendar event(s):\n${lines.join("\n")}`;
  }

  // Fallback: generic deep-record extraction (for non-Google calendar sources)
  const records = collectObjectRecordsDeep(result, 500);
  const items = [];
  records.forEach((record) => {
    const title = firstNonEmptyString(record, ["summary", "title", "name", "event", "subject"]);
    const start = extractCalendarDateTime(record.start) ||
      firstNonEmptyString(record, ["start_time", "start_datetime", "startTime", "dateTime"]);
    const end = extractCalendarDateTime(record.end) ||
      firstNonEmptyString(record, ["end_time", "end_datetime", "endTime"]);
    const location = firstNonEmptyString(record, ["location"]);
    if (!title && !start) return;
    items.push({ title, start: start ? `Start: ${start}` : "", end: end ? `End: ${end}` : "", location: location ? `Location: ${location}` : "" });
  });

  const deduped = [];
  const seen = new Set();
  items.forEach((item) => {
    const key = `${item.title}|${item.start}|${item.end}|${item.location}`;
    if (seen.has(key)) return;
    seen.add(key);
    deduped.push(item);
  });
  const top = deduped.slice(0, 15);
  if (!top.length) {
    return "No events found for that time window.";
  }

  const lines = top.map((item, index) => {
    const title = item.title || "(untitled event)";
    const parts = [item.start, item.end, item.location].filter(Boolean).join(" | ");
    return `${index + 1}. ${title}${parts ? ` — ${parts}` : ""}`;
  });
  return `Here are your calendar event(s):\n${lines.join("\n")}`;
}

/** Extract dateTime or date from a Google Calendar start/end object. */
function extractCalendarDateTime(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "object") {
    return value.dateTime || value.date || value.start || "";
  }
  return "";
}

/** Extract events from a Composio-wrapped Google Calendar response. */
function extractGoogleCalendarItems(result) {
  const parsed = typeof result === "string" ? safeJsonParse(result) : result;
  // Walk common Composio response nesting to find the items array
  const candidates = [
    parsed?.data?.results?.[0]?.response?.data?.items,
    parsed?.data?.results?.[0]?.response?.data_preview?.items,
    parsed?.data?.results?.[0]?.response?.items,
    parsed?.data?.items,
    parsed?.items
  ];
  for (const arr of candidates) {
    if (!Array.isArray(arr) || !arr.length) continue;
    // Verify it looks like calendar events (has summary or start)
    if (!arr[0]?.start && !arr[0]?.summary) continue;
    return arr.map(event => ({
      title: event.summary || event.title || "",
      start: formatCalendarTime(extractCalendarDateTime(event.start)),
      end: formatCalendarTime(extractCalendarDateTime(event.end)),
      location: event.location || ""
    })).filter(e => e.title || e.start);
  }
  return [];
}

/** Format an RFC3339 or date string into a human-readable form. */
function formatCalendarTime(dtStr) {
  if (!dtStr) return "";
  // All-day event: "2026-02-12"
  if (/^\d{4}-\d{2}-\d{2}$/.test(dtStr)) {
    try {
      const d = new Date(dtStr + "T00:00:00");
      return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    } catch { return dtStr; }
  }
  // Timed event: RFC3339
  try {
    const d = new Date(dtStr);
    if (isNaN(d.getTime())) return dtStr;
    return d.toLocaleString(undefined, {
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit"
    });
  } catch { return dtStr; }
}

async function runComposioMultiExecuteReadWithFallback(toolSlug, argumentCandidates) {
  const slug = String(toolSlug || "").trim().toUpperCase();
  const candidates = Array.isArray(argumentCandidates) ? argumentCandidates : [{}];
  let lastError = null;
  for (const args of candidates) {
    try {
      const result = await executeToolCall("COMPOSIO_MULTI_EXECUTE_TOOL", {
        tools: [{ tool_slug: slug, arguments: args && typeof args === "object" ? args : {} }]
      });
      if (isSuccessfulExternalToolResult(result)) return { ok: true, result, attemptedArgs: args };
      lastError = new Error("Tool returned an unsuccessful result");
    } catch (error) {
      lastError = error;
      const message = String(error?.message || "").toLowerCase();
      if (/validation|invalid|required|schema/.test(message)) {
        continue;
      }
      return { ok: false, error };
    }
  }
  return { ok: false, error: lastError || new Error("Composio read call failed") };
}

function getStartOfLocalDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function addLocalDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

async function runDeterministicCalendarRead(intent) {
  const extensionAPI = extensionAPIRef;
  const client = extensionAPI ? await connectComposio(extensionAPI, { suppressConnectedToast: true }) : null;
  if (!client?.callTool) {
    return "Composio is not connected. Please reconnect Composio and try again.";
  }

  const baseDay = addLocalDays(getStartOfLocalDay(new Date()), Number.isFinite(intent?.dayOffset) ? intent.dayOffset : 0);
  // Build RFC3339 timestamps with local timezone offset (not UTC "Z")
  // so Google Calendar interprets the window in the user's local timezone.
  const tzOffset = -baseDay.getTimezoneOffset();
  const tzSign = tzOffset >= 0 ? "+" : "-";
  const tzHH = String(Math.floor(Math.abs(tzOffset) / 60)).padStart(2, "0");
  const tzMM = String(Math.abs(tzOffset) % 60).padStart(2, "0");
  const tzSuffix = `${tzSign}${tzHH}:${tzMM}`;
  const yyyy = baseDay.getFullYear();
  const mm = String(baseDay.getMonth() + 1).padStart(2, "0");
  const dd = String(baseDay.getDate()).padStart(2, "0");
  const timeMin = `${yyyy}-${mm}-${dd}T00:00:00${tzSuffix}`;
  const timeMax = `${yyyy}-${mm}-${dd}T23:59:59${tzSuffix}`;
  debugLog("[Chief flow] Calendar read:", { timeMin, timeMax, dayOffset: intent?.dayOffset ?? 0 });

  // GOOGLECALENDAR_EVENTS_LIST uses camelCase params.
  // Omit maxResults — Composio's Python backend casts JS numbers to float
  // which fails their validator. Default (250) is fine for a day view.
  const args = {
    timeMin,
    timeMax,
    orderBy: "startTime",
    singleEvents: true
  };
  const attempt = await runComposioMultiExecuteReadWithFallback("GOOGLECALENDAR_EVENTS_LIST", [args]);
  if (!attempt.ok) {
    return "I couldn't fetch calendar events from Composio right now. Please confirm the Google Calendar connection is active and try again.";
  }
  return summariseCalendarRecords(attempt.result);
}

async function runDeterministicEmailRead(intent) {
  const extensionAPI = extensionAPIRef;
  const client = extensionAPI ? await connectComposio(extensionAPI, { suppressConnectedToast: true }) : null;
  if (!client?.callTool) {
    debugLog("[Chief flow] Email read: Composio client unavailable.");
    return "Composio is not connected. Please reconnect Composio and try again.";
  }

  const unreadOnly = intent?.unreadOnly === true;
  const urgentOnly = intent?.urgentOnly === true;
  const maxAllowed = unreadOnly ? 200 : 20;
  const count = Number.isFinite(intent?.maxResults) ? Math.max(1, Math.min(maxAllowed, intent.maxResults)) : 5;
  const searchTerms = [];
  if (unreadOnly) searchTerms.push("in:inbox is:unread");
  if (urgentOnly) searchTerms.push("(urgent OR asap OR \"action required\" OR deadline)");
  if (!unreadOnly) searchTerms.push("in:inbox");
  const q = searchTerms.join(" ").trim();
  debugLog("[Chief flow] Email read request:", { count, unreadOnly, urgentOnly, query: q || "(none)" });
  const fallbackArgs = [
    { max_results: count, ...(q ? { query: q } : {}), verbose: false, include_payload: true },
    { max_results: count, ...(q ? { query: q } : {}), verbose: true, include_payload: true },
    { max_results: count, ...(q ? { query: q } : {}) },
    {}
  ];

  let bestResult = null;
  let bestParsedEmails = [];
  let bestUnreadEstimate = null;
  let lastError = null;
  for (const args of fallbackArgs) {
    try {
      const result = await executeToolCall("COMPOSIO_MULTI_EXECUTE_TOOL", {
        tools: [{ tool_slug: "GMAIL_FETCH_EMAILS", arguments: args && typeof args === "object" ? args : {} }]
      });
      if (!isSuccessfulExternalToolResult(result)) {
        lastError = new Error("Email read call returned unsuccessful result");
        continue;
      }
      const parsedEmails = extractEmailRecords(result, 100);
      const unreadEstimate = unreadOnly ? extractEstimatedUnreadCount(result) : null;
      if (
        parsedEmails.length > bestParsedEmails.length ||
        (!Number.isFinite(bestUnreadEstimate) && Number.isFinite(unreadEstimate))
      ) {
        bestResult = result;
        bestParsedEmails = parsedEmails;
        bestUnreadEstimate = unreadEstimate;
      }
      if (bestParsedEmails.length >= count && (!unreadOnly || Number.isFinite(bestUnreadEstimate))) {
        break;
      }
    } catch (error) {
      lastError = error;
      const message = String(error?.message || "").toLowerCase();
      if (/validation|invalid|required|schema/.test(message)) continue;
      break;
    }
  }

  if (!bestResult) {
    debugLog("[Chief flow] Email read failed:", String(lastError?.message || "Unknown error"));
    return "I couldn't fetch emails from Composio right now. Please confirm the Gmail connection is active and try again.";
  }
  debugLog("[Chief flow] Email read parsed records:", {
    parsedCount: bestParsedEmails.length,
    requestedCount: count,
    unreadEstimate: bestUnreadEstimate
  });
  latestEmailActionCache = {
    updatedAt: Date.now(),
    messages: bestParsedEmails.slice(0, MAX_EMAIL_CACHE_MESSAGES),
    unreadEstimate: bestUnreadEstimate,
    requestedCount: count,
    returnedCount: bestParsedEmails.length,
    query: q
  };
  return summariseEmailRecords(bestParsedEmails, count);
}

async function runDeterministicEmailUnreadCount(intent = {}) {
  const threshold = Number.isFinite(intent?.threshold) ? Math.max(1, intent.threshold) : 1;
  debugLog("[Chief flow] Email unread count request:", { threshold });

  // ── Fast path: ids_only count (typically ~1-2s) ──────────────────────
  // GMAIL_FETCH_EMAILS with ids_only: true returns just message IDs
  // plus resultSizeEstimate — no hydration, no payload, very fast.
  try {
    const idsResult = await executeToolCall("COMPOSIO_MULTI_EXECUTE_TOOL", {
      tools: [{
        tool_slug: "GMAIL_FETCH_EMAILS",
        arguments: { ids_only: true, max_results: 500, query: "in:inbox is:unread" }
      }]
    });
    if (isSuccessfulExternalToolResult(idsResult)) {
      const parsed = typeof idsResult === "string" ? safeJsonParse(idsResult) : idsResult;
      const inner = parsed?.data?.results?.[0]?.response?.data
        ?? parsed?.data?.results?.[0]?.response
        ?? parsed;
      const msgArray = inner?.messages;
      const estimate = inner?.resultSizeEstimate;
      const hasMore = !!inner?.nextPageToken;
      // Prefer resultSizeEstimate, fall back to array length
      const count = Number.isFinite(estimate) ? estimate
        : Array.isArray(msgArray) ? msgArray.length
          : null;
      debugLog("[Chief flow] Email unread ids_only:", {
        count, estimate, idsReturned: Array.isArray(msgArray) ? msgArray.length : 0, hasMore
      });
      if (Number.isFinite(count)) {
        if (hasMore && count >= 500) {
          return `You have at least ${count} unread emails in your inbox right now.`;
        }
        if (count > threshold) {
          return `You have ${count} unread emails in your inbox right now.`;
        }
        if (count === 1) {
          return "You have 1 unread email right now.";
        }
        return "You currently have no unread emails.";
      }
    }
  } catch (e) {
    debugLog("[Chief flow] Email unread ids_only failed:", String(e?.message || e));
  }

  // ── Fallback 1: GMAIL_LIST_LABELS with include_details ─────────────
  // Returns messagesUnread per label including INBOX.
  try {
    const labelsResult = await executeToolCall("COMPOSIO_MULTI_EXECUTE_TOOL", {
      tools: [{ tool_slug: "GMAIL_LIST_LABELS", arguments: { include_details: true } }]
    });
    if (isSuccessfulExternalToolResult(labelsResult)) {
      const labelsUnread = extractInboxUnreadFromLabels(labelsResult);
      if (Number.isFinite(labelsUnread)) {
        debugLog("[Chief flow] Email unread from GMAIL_LIST_LABELS:", { labelsUnread });
        if (labelsUnread > threshold) {
          return `You have ${labelsUnread} unread emails in your inbox right now.`;
        }
        if (labelsUnread === 1) return "You have 1 unread email right now.";
        return "You currently have no unread emails.";
      }
    }
  } catch (e) {
    debugLog("[Chief flow] Email unread labels fallback failed:", String(e?.message || e));
  }

  // ── Fallback 2: full fetch (slow, but gives message previews) ──────
  debugLog("[Chief flow] Email unread falling back to full fetch.");
  const attemptText = await runDeterministicEmailRead({
    maxResults: 100,
    unreadOnly: true
  });
  const ageMs = Date.now() - Number(latestEmailActionCache?.updatedAt || 0);
  const records = Array.isArray(latestEmailActionCache?.messages) &&
    Number.isFinite(ageMs) &&
    ageMs >= 0 &&
    ageMs <= EMAIL_ACTION_CACHE_TTL_MS
    ? latestEmailActionCache.messages
    : [];
  const estimatedUnread = Number.isFinite(latestEmailActionCache?.unreadEstimate)
    ? latestEmailActionCache.unreadEstimate
    : null;
  if (!records.length) return attemptText;

  const unreadCount = Number.isFinite(estimatedUnread) ? estimatedUnread : records.length;
  debugLog("[Chief flow] Email unread count from full fetch:", {
    unreadCount, estimatedUnread, sampledMessages: records.length
  });
  if (!Number.isFinite(estimatedUnread) && records.length >= 100) {
    return `You have at least 100 unread emails (the fetched sample hit the limit).`;
  }
  if (!Number.isFinite(estimatedUnread)) {
    return `You have at least ${records.length} unread emails in your inbox.`;
  }
  if (unreadCount > threshold) {
    return `You have ${unreadCount} unread emails in your inbox right now.`;
  }
  if (unreadCount === 1) {
    const only = records[0];
    const subject = only?.subject || "(no subject)";
    const from = only?.from ? ` from ${only.from}` : "";
    return `You have 1 unread email: "${subject}"${from}.`;
  }
  return "You currently have no unread emails.";
}

/** Extract INBOX messagesUnread from a GMAIL_LIST_LABELS response. */
function extractInboxUnreadFromLabels(result) {
  try {
    const parsed = typeof result === "string" ? safeJsonParse(result) : result;
    // Walk common Composio response shapes to find the labels array
    const candidates = [
      parsed?.data?.results?.[0]?.response?.data?.labels,
      parsed?.data?.results?.[0]?.response?.data,
      parsed?.data?.results?.[0]?.response?.labels,
      parsed?.data?.labels,
      parsed?.labels
    ];
    for (const arr of candidates) {
      if (!Array.isArray(arr)) continue;
      const inbox = arr.find(l => l?.id === "INBOX" || l?.name === "INBOX");
      if (inbox) {
        const n = inbox.messagesUnread ?? inbox.messages_unread ?? inbox.unreadCount;
        if (Number.isFinite(n)) return n;
      }
    }
  } catch (e) {
    debugLog("[Chief flow] extractInboxUnreadFromLabels failed:", e?.message || e);
  }
  return null;
}

function resolveEmailDeleteTargetFromCache(intent) {
  const ageMs = Date.now() - Number(latestEmailActionCache?.updatedAt || 0);
  if (!Array.isArray(latestEmailActionCache?.messages) || !latestEmailActionCache.messages.length) return null;
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > EMAIL_ACTION_CACHE_TTL_MS) return null;

  const list = latestEmailActionCache.messages;
  if (Number.isFinite(intent?.targetIndex) && intent.targetIndex > 0) {
    const indexed = list[intent.targetIndex - 1];
    if (indexed) return indexed;
  }
  const hint = String(intent?.targetHint || "").trim().toLowerCase();
  if (!hint) return list[0] || null;
  const direct = list.find((item) => {
    const subject = String(item?.subject || "").toLowerCase();
    const from = String(item?.from || "").toLowerCase();
    return subject.includes(hint) || from.includes(hint);
  });
  if (direct) return direct;
  return null;
}

async function runDeterministicEmailDelete(intent) {
  const extensionAPI = extensionAPIRef;
  const client = extensionAPI ? await connectComposio(extensionAPI, { suppressConnectedToast: true }) : null;
  if (!client?.callTool) {
    return "Composio is not connected. Please reconnect Composio and try again.";
  }

  const target = resolveEmailDeleteTargetFromCache(intent);
  if (!target) {
    return "I don't have a recent resolvable email target. Please ask me to fetch your latest emails first, then say which one to delete.";
  }

  const messageId = String(target?.messageId || "").trim();
  const threadId = String(target?.threadId || "").trim();
  if (!messageId && !threadId) {
    return "I found the email but the provider response did not include a message ID I can delete safely. Please fetch again and choose a numbered item.";
  }

  const deleteCandidates = [
    {
      slug: "GMAIL_DELETE_MESSAGE",
      args: [
        { message_id: messageId },
        { id: messageId },
        { messageId: messageId }
      ]
    },
    {
      slug: "GMAIL_TRASH_MESSAGE",
      args: [
        { message_id: messageId },
        { id: messageId }
      ]
    },
    {
      slug: "GMAIL_DELETE_EMAIL",
      args: [
        { message_id: messageId },
        { id: messageId },
        { thread_id: threadId }
      ]
    }
  ];

  let lastError = null;
  for (const candidate of deleteCandidates) {
    for (const args of candidate.args) {
      const filteredArgs = Object.fromEntries(Object.entries(args).filter(([, value]) => String(value || "").trim()));
      if (!Object.keys(filteredArgs).length) continue;
      try {
        const result = await executeToolCall("COMPOSIO_MULTI_EXECUTE_TOOL", {
          tools: [{ tool_slug: candidate.slug, arguments: filteredArgs }]
        });
        if (isSuccessfulExternalToolResult(result)) {
          latestEmailActionCache = {
            ...latestEmailActionCache,
            updatedAt: Date.now(),
            messages: latestEmailActionCache.messages
              .filter((item) => String(item?.messageId || "") !== messageId)
              .slice(0, MAX_EMAIL_CACHE_MESSAGES)
          };
          const subject = target?.subject || "(no subject)";
          const from = target?.from ? ` from ${target.from}` : "";
          return `Deleted email: "${subject}"${from}.`;
        }
        lastError = new Error("Delete tool returned an unsuccessful result");
      } catch (error) {
        lastError = error;
        const message = String(error?.message || "").toLowerCase();
        if (/validation|invalid|required|schema|not found|unsupported/.test(message)) {
          continue;
        }
        return "There was an issue deleting that email through Composio. Please verify your Gmail connection and try again.";
      }
    }
  }
  const reason = String(lastError?.message || "").trim();
  if (reason) {
    return `I couldn't delete that email with the current Gmail tool schema (${reason}). Please refresh email results and try deleting by index.`;
  }
  return "I couldn't delete that email with the currently available Gmail tools.";
}

async function runDeterministicMemorySave(intent) {
  const pageKey = String(intent?.page || "memory").toLowerCase();
  const content = String(intent?.content || "").trim();
  if (!content) throw new Error("No memory content to save.");
  const result = await updateChiefMemory({
    page: pageKey,
    action: "append",
    content
  });
  const pageNameByKey = {
    memory: "Chief of Staff/Memory",
    inbox: "Chief of Staff/Inbox",
    skills: "Chief of Staff/Skills",
    projects: "Chief of Staff/Projects",
    decisions: "Chief of Staff/Decisions",
    lessons: "Chief of Staff/Lessons Learned"
  };
  const label = pageNameByKey[pageKey] || String(result?.page || "Chief of Staff/Memory");
  return `Saved to [[${label}]]${result?.uid ? ` (uid: ${result.uid})` : ""}.`;
}

async function runDeterministicSkillInvocation(intent, options = {}) {
  const { suppressToasts = false } = options;
  const skillName = String(intent?.skillName || "").trim();
  if (!skillName) {
    return "Please provide a skill name, for example: use skill Weekly Planning on my next two weeks.";
  }
  const skill = await findSkillEntryByName(skillName, { force: true });
  if (!skill) {
    const available = (await getSkillEntries({ force: true }))
      .map((entry) => entry.title)
      .slice(0, 12);
    const suffix = available.length ? ` Available skills: ${available.join(", ")}` : " No skills are currently loaded.";
    return `I couldn't find a skill named "${skillName}".${suffix}`;
  }

  const skillPrompt = String(intent?.targetText || "").trim() || `Apply the "${skill.title}" skill to this request: ${intent?.originalPrompt || ""}`;
  showInfoToastIfAllowed("Skill", `Applying: ${skill.title}`, suppressToasts);

  // Detect daily-page-write skills by name or content
  const skillNameLower = String(skill.title || "").toLowerCase();
  const skillContentLower = String(skill.content || "").toLowerCase();
  const isDailyPageWriteSkill =
    /daily.briefing/.test(skillNameLower) ||
    /daily.page|daily.briefing/.test(skillContentLower);

  let systemPromptSuffix = `\n\nYou must prioritize this skill for this turn.`;
  if (isDailyPageWriteSkill) {
    systemPromptSuffix += `\n\nIMPORTANT: Do NOT call roam_create_blocks or roam_get_daily_page. The system will write your output to the daily page automatically. Just produce the briefing content as structured markdown with headings (#### for sections) and numbered/bulleted lists. Do NOT include any preamble, confirmation, or conversational text — output ONLY the structured briefing content.`;
  }

  const systemPrompt = `${await buildDefaultSystemPrompt(skillPrompt)}

## Active Skill (Explicitly Requested)
${skill.content}
${systemPromptSuffix}`;

  const result = await runAgentLoop(skillPrompt, {
    systemPrompt,
    powerMode: true,
    onToolCall: (name) => {
      showInfoToastIfAllowed("Using tool", name, suppressToasts);
    }
  });
  const responseText = String(result?.text || "").trim() || "No response generated.";

  // If it's a daily-page-write skill, write the output to the DNP from code.
  if (isDailyPageWriteSkill) {
    // Strip LLM preamble/postamble — keep only lines starting with #, -, *, or digit
    const contentLines = responseText.split("\n");
    const firstStructuredLine = contentLines.findIndex(l => /^#{1,6}\s|^[-*]\s|^\d+[.)]\s/.test(l.trim()));
    const lastStructuredLine = (() => {
      for (let j = contentLines.length - 1; j >= 0; j--) {
        if (/^#{1,6}\s|^[-*]\s|^\d+[.)]\s|^\s+[-*]\s/.test(contentLines[j].trim())) return j;
      }
      return -1;
    })();
    const cleanedText = firstStructuredLine >= 0 && lastStructuredLine >= firstStructuredLine
      ? contentLines.slice(firstStructuredLine, lastStructuredLine + 1).join("\n").trim()
      : responseText;

    if (cleanedText.length > 40) {
      try {
        const heading = `[[Chief of Staff Daily Briefing]]`;
        const writeResult = await writeStructuredResponseToTodayDailyPage(heading, cleanedText);
        showInfoToastIfAllowed("Saved to Roam", `Added under ${writeResult.pageTitle}.`, suppressToasts);
        return `Briefing written to today's daily page under ${heading}.`;
      } catch (error) {
        debugLog("[Chief flow] Skill auto-write to DNP failed:", error?.message || error);
      }
    } else {
      debugLog("[Chief flow] Skill response doesn't look like briefing content, skipping DNP write:", responseText.slice(0, 200));
    }
  }

  return responseText;
}

async function getDeterministicConnectionSummary(extensionAPI) {
  const client = await connectComposio(extensionAPI, { suppressConnectedToast: true });
  if (client?.callTool) {
    await reconcileInstalledToolsWithComposio(extensionAPI);
  }

  const state = getToolsConfigState(extensionAPI);
  const installed = state.installedTools.filter((tool) => tool.installState === "installed");
  const pending = state.installedTools.filter((tool) => tool.installState === "pending_auth");
  const failed = state.installedTools.filter((tool) => tool.installState === "failed");

  if (!installed.length && !pending.length && !failed.length) {
    return "No Composio tools are currently tracked as connected. Install a tool from the command palette to get started.";
  }

  const formatToolList = (tools) =>
    tools.map((tool) => String(tool.label || tool.slug || "").trim()).filter(Boolean).join(", ");

  const lines = [];
  if (installed.length) lines.push(`Connected: ${formatToolList(installed)}`);
  if (pending.length) lines.push(`Pending auth: ${formatToolList(pending)}`);
  if (failed.length) lines.push(`Failed: ${formatToolList(failed)}`);
  return lines.join("\n");
}

function isLikelyReadOnlyToolSlug(toolSlug) {
  const slug = String(toolSlug || "").toUpperCase();
  if (!slug) return false;
  const readTokens = [
    "GET",
    "LIST",
    "SEARCH",
    "FIND",
    "FETCH",
    "READ",
    "QUERY",
    "LOOKUP",
    "RETRIEVE",
    "VIEW",
    "DESCRIBE",
    "DETAILS",
    "SHOW"
  ];
  return readTokens.some((token) => slug.includes(token));
}

function getUnknownMultiExecuteToolSlugs(args) {
  const tools = Array.isArray(args?.tools) ? args.tools : [];
  return tools
    .map((tool) => String(tool?.tool_slug || "").toUpperCase().trim())
    .filter(Boolean)
    .filter((slug) => !COMPOSIO_SAFE_MULTI_EXECUTE_SLUG_ALLOWLIST.has(slug));
}

async function confirmUnknownMultiExecuteToolSlugs(args) {
  const unknownSlugs = getUnknownMultiExecuteToolSlugs(args);
  if (!unknownSlugs.length) return true;
  return promptToolExecutionApproval("COMPOSIO_MULTI_EXECUTE_TOOL (unknown slugs)", {
    unknown_tool_slugs: unknownSlugs
  });
}

function isPotentiallyMutatingTool(toolName, args) {
  const name = String(toolName || "").toUpperCase();
  if (!name) return false;

  if (name === "COMPOSIO_SEARCH_TOOLS" || name === "COMPOSIO_GET_CONNECTED_ACCOUNTS") {
    return false;
  }

  if (name === "COS_UPDATE_MEMORY") {
    return true;
  }

  // cos_email_delete is a wrapper whose inner COMPOSIO_MULTI_EXECUTE_TOOL call handles approval.
  if (name === "COS_EMAIL_DELETE") {
    return false;
  }

  // ROAM_DELETE_BLOCK, ROAM_UPDATE_BLOCK, and ROAM_BT_MODIFY_TASK are destructive
  // and MUST require approval. Only skip approval for low-risk creation operations.
  const roamLowRiskCreationTools = new Set([
    "ROAM_CREATE_BLOCK",
    "ROAM_CREATE_BLOCKS"
  ]);
  if (roamLowRiskCreationTools.has(name)) {
    return false;
  }

  // Force approval for destructive Roam operations
  if (name === "ROAM_DELETE_BLOCK" || name === "ROAM_UPDATE_BLOCK" || name === "ROAM_BT_MODIFY_TASK") {
    return true;
  }

  if (name.includes("MANAGE_CONNECTIONS")) {
    const action = String(args?.action || "").toLowerCase();
    const safeManageActions = new Set(["list", "status", "check", "get"]);
    return !safeManageActions.has(action);
  }

  // External extension tools — safe default is mutating unless name suggests read-only
  const externalTools = getExternalExtensionTools();
  if (externalTools.some(t => t.name.toUpperCase() === name)) {
    return !/\b(GET|LIST|SEARCH|FETCH|STATUS|CHECK)\b/i.test(name);
  }

  if (name === "COMPOSIO_MULTI_EXECUTE_TOOL") {
    const tools = Array.isArray(args?.tools) ? args.tools : [];
    if (!tools.length) return true;
    const allReadOnly = tools.every((tool) => isLikelyReadOnlyToolSlug(tool?.tool_slug));
    return !allReadOnly;
  }

  const sensitiveTokens = [
    "CREATE",
    "MODIFY",
    "UPDATE",
    "DELETE",
    "REMOVE",
    "SEND",
    "POST",
    "WRITE",
    "MUTATE",
    "DISCONNECT",
    "CONNECT",
    "EXECUTE"
  ];
  return sensitiveTokens.some((token) => name.includes(token));
}

async function executeToolCall(toolName, args) {
  const upperToolName = String(toolName || "").toUpperCase();
  let effectiveArgs = args || {};
  if (upperToolName === "COMPOSIO_MULTI_EXECUTE_TOOL") {
    debugLog("[Chief flow] MULTI_EXECUTE raw args:", JSON.stringify(args, null, 2));
    effectiveArgs = normaliseComposioMultiExecuteArgs(effectiveArgs);
    debugLog("[Chief flow] MULTI_EXECUTE normalised args:", JSON.stringify(effectiveArgs, null, 2));

    // Intercept: if tool slugs match local extension tools, execute locally
    // instead of routing through Composio. This handles LLM confusion where it wraps
    // local extension tools (e.g. cc_convert) in COMPOSIO_MULTI_EXECUTE_TOOL.
    const extTools = getExternalExtensionTools();
    const batchTools = Array.isArray(effectiveArgs?.tools) ? effectiveArgs.tools : [];
    if (batchTools.length > 0) {
      const findLocalTool = (slug) => {
        const lower = slug.toLowerCase();
        return extTools.find(et => et.name.toLowerCase() === lower
          || lower.endsWith("_" + et.name.toLowerCase()));
      };
      const findRegistryTool = (slug) => {
        // Check raw registry for tools that exist but may lack execute (diagnostic)
        const lower = slug.toLowerCase();
        const registry = getExtensionToolsRegistry();
        for (const [, ext] of Object.entries(registry)) {
          if (!ext || !Array.isArray(ext.tools)) continue;
          for (const t of ext.tools) {
            if (!t?.name) continue;
            if (t.name.toLowerCase() === lower || lower.endsWith("_" + t.name.toLowerCase())) return t;
          }
        }
        return null;
      };

      const localMatches = batchTools.map(bt => findLocalTool(String(bt?.tool_slug || "")));
      if (localMatches.every(Boolean)) {
        debugLog("[Chief flow] MULTI_EXECUTE intercepted — all slugs match local extension tools, executing locally");
        const results = [];
        for (let i = 0; i < batchTools.length; i++) {
          const localTool = localMatches[i];
          const toolArgs = batchTools[i]?.arguments || {};
          try {
            const result = await localTool.execute(toolArgs);
            results.push({ tool: localTool.name, result });
          } catch (e) {
            results.push({ tool: localTool.name, error: e?.message || `Failed: ${localTool.name}` });
          }
        }
        return { successful: true, data: { results } };
      }

      // Check if slugs match registry tools that lack execute functions — return clear error
      const registryMatches = batchTools.map(bt => findRegistryTool(String(bt?.tool_slug || "")));
      const missingExecute = registryMatches.filter((t, i) => t && !localMatches[i]);
      if (missingExecute.length > 0) {
        const names = missingExecute.map(t => t.name).join(", ");
        debugLog(`[Chief flow] MULTI_EXECUTE blocked — tools found in registry but missing execute(): ${names}`);
        return {
          successful: false,
          data: {
            error: `Tools ${names} are registered in RoamExtensionTools but missing an execute() function. The extension author needs to add execute() to each tool.`
          }
        };
      }
    }

    const unknownApproved = await confirmUnknownMultiExecuteToolSlugs(effectiveArgs);
    if (!unknownApproved) {
      throw new Error("User denied unknown tool slugs in COMPOSIO_MULTI_EXECUTE_TOOL");
    }
  }

  const isMutating = isPotentiallyMutatingTool(toolName, effectiveArgs);
  const extensionAPI = extensionAPIRef;
  if (isMutating && extensionAPI && isDryRunEnabled(extensionAPI)) {
    consumeDryRunMode(extensionAPI);
    showInfoToast("Dry run", `Simulated mutating call: ${toolName}`);
    return {
      dry_run: true,
      simulated: true,
      tool_name: toolName,
      arguments: effectiveArgs
    };
  }

  if (isMutating && !approvedToolsThisSession.has(toolName)) {
    const approved = await promptToolExecutionApproval(toolName, effectiveArgs);
    if (!approved) {
      throw new Error(`User denied execution for ${toolName}`);
    }
    approvedToolsThisSession.add(toolName);
    debugLog("[Chief flow] Tool approved and whitelisted for session:", toolName);
  }

  const roamTool = getRoamNativeTools().find((tool) => tool.name === toolName)
    || getBetterTasksTools().find((tool) => tool.name === toolName)
    || getCosIntegrationTools().find((tool) => tool.name === toolName)
    || getExternalExtensionTools().find((tool) => tool.name === toolName)
    || getComposioMetaToolsForLlm().find((tool) => tool.name === toolName);
  if (roamTool?.execute) {
    return roamTool.execute(args || {});
  }

  if (!mcpClient?.callTool) {
    throw new Error("MCP client not connected");
  }
  const result = await mcpClient.callTool({
    name: toolName,
    arguments: effectiveArgs
  });
  const text = result?.content?.[0]?.text;
  if (typeof text === "string") {
    try {
      const parsed = JSON.parse(text);
      // Record response shape for Composio tool calls
      if (upperToolName === "COMPOSIO_MULTI_EXECUTE_TOOL" && parsed?.successful) {
        const slugs = Array.isArray(effectiveArgs?.tools)
          ? effectiveArgs.tools.map(t => t?.tool_slug).filter(Boolean)
          : [];
        slugs.forEach(slug => recordToolResponseShape(slug, parsed));
      }
      return parsed;
    } catch (error) {
      return { text };
    }
  }
  return result;
}

function extractToolCalls(provider, response) {
  if (provider === "anthropic") {
    return (response?.content || [])
      .filter((block) => block?.type === "tool_use")
      .map((block) => ({
        id: block.id,
        name: block.name,
        arguments: block.input || {}
      }));
  }
  if (provider === "openai") {
    const message = response?.choices?.[0]?.message;
    return (message?.tool_calls || []).map((toolCall) => {
      let parsedArgs = {};
      try {
        parsedArgs = JSON.parse(toolCall?.function?.arguments || "{}");
      } catch (error) {
        parsedArgs = {};
      }
      return {
        id: toolCall.id,
        name: toolCall?.function?.name,
        arguments: parsedArgs
      };
    });
  }
  return [];
}

function extractTextResponse(provider, response) {
  if (provider === "anthropic") {
    return (response?.content || [])
      .filter((block) => block?.type === "text")
      .map((block) => block.text || "")
      .join("\n")
      .trim();
  }
  if (provider === "openai") {
    return String(response?.choices?.[0]?.message?.content || "").trim();
  }
  return "";
}

function isLikelyLiveDataReadIntent(userMessage) {
  const text = String(userMessage || "").toLowerCase().trim();
  if (!text) return false;

  // Skill update/edit requests are not live data reads even if they mention calendar/email
  if (/\b(update|edit|improve|optimise|optimize|change|modify)\b.*\bskill\b/i.test(text)) return false;
  if (/\bskill\b.*\b(update|edit|improve|optimise|optimize|change|modify)\b/i.test(text)) return false;

  const explicitPhrases = [
    "most recent emails",
    "latest emails",
    "recent emails",
    "my inbox",
    "unread emails",
    "what's on my calendar",
    "whats on my calendar",
    "calendar today",
    "calendar tomorrow",
    "upcoming events",
    "my schedule",
    "connected tools",
    "connection status",
    "connected accounts"
  ];
  if (explicitPhrases.some((phrase) => text.includes(phrase))) return true;

  const readVerbs = ["what", "show", "list", "summar", "find", "fetch", "get", "check"];
  const actionVerbs = [
    "delete",
    "remove",
    "archive",
    "trash",
    "reply",
    "send",
    "compose",
    "draft",
    "mark",
    "move",
    "update",
    "edit",
    "cancel",
    "reschedule",
    "connect",
    "disconnect"
  ];
  const liveDataNouns = [
    "email",
    "emails",
    "inbox",
    "calendar",
    "event",
    "events",
    "schedule",
    "message",
    "messages",
    "connection",
    "connections",
    "account",
    "accounts",
    "slack",
    "gmail",
    "jira",
    "github"
  ];

  const wordMatch = (word) => new RegExp(`\\b${word}\\b`).test(text);
  const hasReadVerb = readVerbs.some(wordMatch);
  const hasActionVerb = actionVerbs.some(wordMatch);
  const hasLiveDataNoun = liveDataNouns.some(wordMatch);
  return hasLiveDataNoun && (hasReadVerb || hasActionVerb);
}

function isExternalDataToolCall(toolName) {
  const name = String(toolName || "").toUpperCase();
  if (!name) return false;
  return (
    name.startsWith("COMPOSIO_") ||
    name.startsWith("COS_EMAIL_") ||
    name.startsWith("COS_CALENDAR_") ||
    name === "COS_UPDATE_MEMORY" ||
    name === "COS_GET_SKILL" ||
    name === "ROAM_SEARCH" ||
    name === "ROAM_GET_PAGE" ||
    name === "ROAM_GET_DAILY_PAGE" ||
    name === "ROAM_BT_SEARCH_TASKS" ||
    name === "ROAM_SEARCH_BLOCKS"
  );
}

function isSuccessfulExternalToolResult(result) {
  if (result == null) return false;
  if (typeof result !== "object") return true;
  const errorValue = result?.error;
  if (typeof errorValue === "string") return errorValue.trim().length === 0;
  return !Boolean(errorValue);
}

function formatAssistantMessage(provider, response) {
  if (provider === "anthropic") {
    return { role: "assistant", content: response?.content || [] };
  }
  if (provider === "openai") {
    return {
      role: "assistant",
      content: response?.choices?.[0]?.message?.content || "",
      tool_calls: response?.choices?.[0]?.message?.tool_calls || []
    };
  }
  return { role: "assistant", content: "" };
}

function formatToolResults(provider, toolResults) {
  if (provider === "anthropic") {
    return [
      {
        role: "user",
        content: toolResults.map(({ toolCall, result }) => ({
          type: "tool_result",
          tool_use_id: toolCall.id,
          content: safeJsonStringify(result, MAX_TOOL_RESULT_CHARS)
        }))
      }
    ];
  }
  if (provider === "openai") {
    return toolResults.map(({ toolCall, result }) => ({
      role: "tool",
      tool_call_id: toolCall.id,
      content: safeJsonStringify(result, MAX_TOOL_RESULT_CHARS)
    }));
  }
  return [];
}

function extractComposioSessionIdFromToolResult(result) {
  const direct = String(result?.session_id || result?.session?.id || "").trim();
  if (direct) return direct;
  const text = result?.content?.[0]?.text;
  if (typeof text !== "string") return "";
  try {
    const parsed = JSON.parse(text);
    return String(parsed?.session_id || parsed?.session?.id || "").trim();
  } catch (error) {
    return "";
  }
}

function normaliseToolkitSlug(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function extractCandidateToolkitSlugsFromComposioSearch(result) {
  const text = result?.content?.[0]?.text;
  if (typeof text !== "string") return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return [];
  }

  const keys = [
    "toolkit_slug",
    "toolkit",
    "toolkitSlug",
    "app_slug",
    "app",
    "appName",
    "app_name"
  ];
  const seen = new Set();
  const slugs = [];
  const queue = [parsed];
  let visited = 0;
  while (queue.length && visited < COMPOSIO_TOOLKIT_SEARCH_BFS_MAX_NODES) {
    visited += 1;
    const current = queue.shift();
    if (!current || typeof current !== "object") continue;
    keys.forEach((key) => {
      const value = current[key];
      if (typeof value !== "string") return;
      const slug = normaliseToolkitSlug(value);
      if (!slug || seen.has(slug)) return;
      seen.add(slug);
      slugs.push(slug);
    });
    Object.values(current).forEach((value) => {
      if (Array.isArray(value)) {
        value.forEach((item) => queue.push(item));
      } else if (value && typeof value === "object") {
        queue.push(value);
      }
    });
  }
  return slugs;
}

async function resolveComposioToolkitSlugForInstall(client, requestedSlug, extensionAPI = extensionAPIRef) {
  const requested = normaliseToolkitSlug(requestedSlug);
  if (!requested || !client?.callTool) {
    return {
      requestedSlug: requested,
      resolvedSlug: requested,
      suggestions: []
    };
  }

  const cachedCatalog = getComposioToolkitCatalogCache(extensionAPI);
  const cacheAgeMs = Date.now() - (cachedCatalog.fetchedAt || 0);
  const cacheIsFresh =
    cachedCatalog.fetchedAt > 0 &&
    cacheAgeMs >= 0 &&
    cacheAgeMs <= COMPOSIO_TOOLKIT_CATALOG_CACHE_TTL_MS;
  const cachedResolution = resolveToolkitSlugFromSuggestions(requested, cachedCatalog.slugs);
  const cachedHasMatch = cachedResolution.resolvedSlug !== requested;

  if (cacheIsFresh && cachedResolution.suggestions.length > 0 && cachedHasMatch) {
    return cachedResolution;
  }

  try {
    const searchResult = await client.callTool({
      name: "COMPOSIO_SEARCH_TOOLS",
      arguments: {
        queries: [{ use_case: requested }]
      }
    });
    const discovered = extractCandidateToolkitSlugsFromComposioSearch(searchResult);
    if (discovered.length) {
      const mergedCatalog = mergeComposioToolkitCatalogSlugs(extensionAPI, discovered, { touchFetchedAt: true });
      return resolveToolkitSlugFromSuggestions(requested, mergedCatalog.slugs);
    }
    return cachedResolution;
  } catch (error) {
    return cachedResolution;
  }
}

function withComposioSessionArgs(toolName, args, sessionId) {
  const name = String(toolName || "").toUpperCase();
  const id = String(sessionId || "").trim();
  if (!name.startsWith("COMPOSIO_") || !id) return args || {};
  const nextArgs = args && typeof args === "object" ? { ...args } : {};
  if (!String(nextArgs.session_id || "").trim()) {
    nextArgs.session_id = id;
  }
  const existingSession = nextArgs.session && typeof nextArgs.session === "object" ? nextArgs.session : {};
  if (!String(existingSession.id || "").trim()) {
    nextArgs.session = { ...existingSession, id };
  }
  return nextArgs;
}

function shouldRetryLlmStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

async function fetchLlmJsonWithRetry(url, init, providerLabel, options = {}) {
  const { signal } = options;
  let lastError = null;
  for (let attempt = 1; attempt <= LLM_MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, { ...init, ...(signal ? { signal } : {}) });
      if (!response.ok) {
        const errorText = (await response.text()).slice(0, 500);
        if (shouldRetryLlmStatus(response.status) && attempt < LLM_MAX_RETRIES) {
          const delay = LLM_RETRY_BASE_DELAY_MS * (2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
          await sleep(delay, signal);
          continue;
        }
        if (response.status === 400) {
          debugLog(`[Chief flow] ${providerLabel} 400 error:`, errorText.slice(0, 500));
        }
        if (response.status === 429) {
          throw new Error(`${providerLabel} rate limit hit (input tokens/min). Try again in ~60s or shorten the request.`);
        }
        throw new Error(`${providerLabel} API error ${response.status}: ${errorText}`);
      }
      return response.json();
    } catch (error) {
      if (error?.name === "AbortError") throw error; // don't retry aborted requests
      lastError = error;
      if (attempt >= LLM_MAX_RETRIES) break;
      const delay = LLM_RETRY_BASE_DELAY_MS * (2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
      await sleep(delay, signal);
    }
  }
  throw lastError || new Error(`${providerLabel} API request failed`);
}

async function callAnthropic(apiKey, model, system, messages, tools, options = {}) {
  return fetchLlmJsonWithRetry(
    getProxiedLlmUrl(LLM_API_ENDPOINTS.anthropic),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model,
        max_tokens: ANTHROPIC_MAX_OUTPUT_TOKENS,
        system,
        messages,
        tools: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          input_schema: tool.input_schema
        }))
      })
    },
    "Anthropic",
    { signal: options.signal }
  );
}

async function callOpenAI(apiKey, model, system, messages, tools, options = {}) {
  return fetchLlmJsonWithRetry(
    getProxiedLlmUrl(LLM_API_ENDPOINTS.openai),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: system }, ...messages],
        tools: tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.input_schema
          }
        })),
        max_tokens: OPENAI_MAX_OUTPUT_TOKENS
      })
    },
    "OpenAI",
    { signal: options.signal }
  );
}

/**
 * Streaming OpenAI call — returns { textContent, toolCalls, usage } after
 * piping text chunks to onTextChunk(delta). Tool calls are collected and
 * returned at the end. Falls back to non-streaming on error.
 */
async function callOpenAIStreaming(apiKey, model, system, messages, tools, onTextChunk, options = {}) {
  const response = await fetch(getProxiedLlmUrl(LLM_API_ENDPOINTS.openai), {
    ...(options.signal ? { signal: options.signal } : {}),
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: system }, ...messages],
      tools: tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema
        }
      })),
      max_tokens: OPENAI_MAX_OUTPUT_TOKENS,
      stream: true,
      stream_options: { include_usage: true }
    })
  });

  if (!response.ok) {
    const errorText = (await response.text()).slice(0, 300);
    throw new Error(`OpenAI streaming error ${response.status}: ${errorText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let textContent = "";
  const toolCallDeltas = {}; // index -> { id, name, arguments }
  let usage = null;

  while (true) {
    let chunkTimeoutId;
    const chunkTimeout = new Promise((_, reject) => {
      chunkTimeoutId = setTimeout(() => reject(new Error("OpenAI streaming chunk timeout")), LLM_STREAM_CHUNK_TIMEOUT_MS);
    });
    let done, value;
    try {
      ({ done, value } = await Promise.race([reader.read(), chunkTimeout]));
    } finally {
      clearTimeout(chunkTimeoutId);
    }
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() || ""; // keep incomplete line in buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === "data: [DONE]") continue;
      if (!trimmed.startsWith("data: ")) continue;

      let parsed;
      try { parsed = JSON.parse(trimmed.slice(6)); } catch { continue; }

      // Usage comes in the final chunk
      if (parsed.usage) {
        usage = parsed.usage;
      }

      const delta = parsed.choices?.[0]?.delta;
      if (!delta) continue;

      // Text content
      if (delta.content) {
        textContent += delta.content;
        if (onTextChunk) onTextChunk(delta.content);
      }

      // Tool call deltas — accumulate arguments
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCallDeltas[idx]) {
            toolCallDeltas[idx] = { id: tc.id || "", name: tc.function?.name || "", arguments: "" };
          }
          if (tc.id) toolCallDeltas[idx].id = tc.id;
          if (tc.function?.name) toolCallDeltas[idx].name = tc.function.name;
          if (tc.function?.arguments) toolCallDeltas[idx].arguments += tc.function.arguments;
        }
      }
    }
  }

  const toolCalls = Object.values(toolCallDeltas)
    .filter((tc) => tc.name)
    .map((tc) => {
      let args = {};
      try { args = JSON.parse(tc.arguments); } catch { /* ignore */ }
      return { id: tc.id, name: tc.name, arguments: args };
    });

  return { textContent, toolCalls, usage };
}

async function callLlm(provider, apiKey, model, system, messages, tools, options = {}) {
  if (provider === "openai") return callOpenAI(apiKey, model, system, messages, tools, options);
  return callAnthropic(apiKey, model, system, messages, tools, options);
}

async function runAgentLoop(userMessage, options = {}) {
  const {
    maxIterations = MAX_AGENT_ITERATIONS,
    systemPrompt = null,
    onToolCall = null,
    onToolResult = null,
    onTextChunk = null,
    powerMode = false
  } = options;

  const extensionAPI = extensionAPIRef;
  if (!extensionAPI) throw new Error("Extension API not ready");

  const provider = getLlmProvider(extensionAPI);
  const apiKey = getApiKeyForProvider(extensionAPI, provider);
  const baseModel = getLlmModel(extensionAPI, provider);
  const model = powerMode ? getPowerModel(provider) : baseModel;
  if (!apiKey) {
    throw new Error("No LLM API key configured. Set it in Chief of Staff settings.");
  }

  setupExtensionBroadcastListeners();
  const tools = await getAvailableToolSchemas();
  const system = systemPrompt || await buildDefaultSystemPrompt(userMessage);
  const priorMessages = getConversationMessages();

  // Page-change detection: if the user navigated since the last turn, inject a notice
  // so the LLM knows previous page-specific results (reading time, word count, etc.) are stale.
  const currentPageCtx = await getCurrentPageContext();
  let pageChangeNotice = "";
  if (priorMessages.length > 0 && lastKnownPageContext && currentPageCtx) {
    if (currentPageCtx.uid !== lastKnownPageContext.uid) {
      pageChangeNotice = `[Note: The user has navigated to a different page since the last message. Previous page: "${lastKnownPageContext.title}" (${lastKnownPageContext.uid}). Current page: "${currentPageCtx.title}" (${currentPageCtx.uid}). Any previous tool results about page content are now stale — call tools again for the current page.]`;
      debugLog("[Chief flow] Page change detected:", lastKnownPageContext.uid, "→", currentPageCtx.uid);
    }
  }
  if (currentPageCtx) lastKnownPageContext = { uid: currentPageCtx.uid, title: currentPageCtx.title };

  const effectiveUserMessage = pageChangeNotice ? `${pageChangeNotice}\n\n${userMessage}` : userMessage;
  const messages = [...priorMessages, { role: "user", content: effectiveUserMessage }];
  const requiresLiveDataTool = isLikelyLiveDataReadIntent(userMessage);
  let sawSuccessfulExternalDataToolResult = false;
  let composioSessionId = "";
  let prunablePrefixCount = priorMessages.length;
  prunablePrefixCount = enforceAgentMessageBudgetInPlace(messages, { prunablePrefixCount });
  debugLog("[Chief flow] runAgentLoop start:", {
    provider,
    model,
    toolCount: Array.isArray(tools) ? tools.length : 0,
    promptPreview: String(userMessage || "").slice(0, 140)
  });
  // Estimate token usage for cost awareness
  const systemChars = system.length;
  const toolsChars = JSON.stringify(tools).length;
  const messagesChars = JSON.stringify(messages).length;
  const totalInputChars = systemChars + toolsChars + messagesChars;
  const estInputTokens = Math.round(totalInputChars / 4); // rough 4 chars/token
  debugLog("[Chief flow] Token estimate (input):", {
    systemChars,
    toolsChars,
    messagesChars,
    totalInputChars,
    estInputTokens,
    estCostCents: (estInputTokens / 1000 * getModelCostRates(model).inputPerM / 1000).toFixed(3)
  });
  const trace = {
    startedAt: Date.now(),
    finishedAt: null,
    provider,
    model,
    promptPreview: String(userMessage || "").slice(0, 180),
    priorContextTurns: conversationTurns.length,
    iterations: 0,
    toolCalls: [],
    resultTextPreview: "",
    error: null
  };
  lastAgentRunTrace = trace;
  if (approximateMessageChars(messages) > MAX_AGENT_MESSAGES_CHAR_BUDGET) {
    const finalText = getAgentOverBudgetMessage();
    debugLog("[Chief flow] runAgentLoop early exit: over budget before first call.");
    trace.finishedAt = Date.now();
    trace.resultTextPreview = finalText.slice(0, 400);
    return {
      text: finalText,
      messages
    };
  }

  // Create an AbortController so in-flight LLM fetches can be cancelled on unload
  activeAgentAbortController = new AbortController();

  try {
    for (let index = 0; index < maxIterations; index += 1) {
      trace.iterations = index + 1;
      prunablePrefixCount = enforceAgentMessageBudgetInPlace(messages, { prunablePrefixCount });
      if (approximateMessageChars(messages) > MAX_AGENT_MESSAGES_CHAR_BUDGET) {
        const finalText = getAgentOverBudgetMessage();
        trace.finishedAt = Date.now();
        trace.resultTextPreview = finalText.slice(0, 400);
        return {
          text: finalText,
          messages
        };
      }
      const useStreaming = onTextChunk && provider === "openai";
      let response, toolCalls, streamedText;

      if (useStreaming) {
        const streamResult = await callOpenAIStreaming(apiKey, model, system, messages, tools, onTextChunk, { signal: activeAgentAbortController?.signal });
        streamedText = streamResult.textContent || "";
        toolCalls = streamResult.toolCalls || [];
        const usage = streamResult.usage;
        if (usage) {
          const inputTokens = usage.prompt_tokens || 0;
          const outputTokens = usage.completion_tokens || 0;
          trace.totalInputTokens = (trace.totalInputTokens || 0) + inputTokens;
          trace.totalOutputTokens = (trace.totalOutputTokens || 0) + outputTokens;
          sessionTokenUsage.totalInputTokens += inputTokens;
          sessionTokenUsage.totalOutputTokens += outputTokens;
          sessionTokenUsage.totalRequests += 1;
          const callCost = (inputTokens / 1_000_000 * getModelCostRates(model).inputPerM) + (outputTokens / 1_000_000 * getModelCostRates(model).outputPerM);
          sessionTokenUsage.totalCostUsd += callCost;
          debugLog("[Chief flow] API usage (stream):", {
            inputTokens, outputTokens,
            callCostCents: (callCost * 100).toFixed(3),
            sessionTotals: {
              input: sessionTokenUsage.totalInputTokens,
              output: sessionTokenUsage.totalOutputTokens,
              requests: sessionTokenUsage.totalRequests,
              costCents: (sessionTokenUsage.totalCostUsd * 100).toFixed(2)
            }
          });
        }
        response = {
          choices: [{
            message: {
              role: "assistant",
              content: streamedText || null,
              tool_calls: toolCalls.length ? toolCalls.map((tc, i) => ({
                id: tc.id || `call_${i}`,
                type: "function",
                function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
              })) : undefined
            }
          }],
          usage: streamResult.usage
        };
      } else {
        response = await callLlm(provider, apiKey, model, system, messages, tools, { signal: activeAgentAbortController?.signal });
        const usage = response?.usage;
        if (usage) {
          const inputTokens = usage.prompt_tokens || usage.input_tokens || 0;
          const outputTokens = usage.completion_tokens || usage.output_tokens || 0;
          trace.totalInputTokens = (trace.totalInputTokens || 0) + inputTokens;
          trace.totalOutputTokens = (trace.totalOutputTokens || 0) + outputTokens;
          sessionTokenUsage.totalInputTokens += inputTokens;
          sessionTokenUsage.totalOutputTokens += outputTokens;
          sessionTokenUsage.totalRequests += 1;
          const { inputPerM: costPerMInput, outputPerM: costPerMOutput } = getModelCostRates(model);
          const callCost = (inputTokens / 1_000_000 * costPerMInput) + (outputTokens / 1_000_000 * costPerMOutput);
          sessionTokenUsage.totalCostUsd += callCost;
          debugLog("[Chief flow] API usage:", {
            inputTokens, outputTokens,
            callCostCents: (callCost * 100).toFixed(3),
            sessionTotals: {
              input: sessionTokenUsage.totalInputTokens,
              output: sessionTokenUsage.totalOutputTokens,
              requests: sessionTokenUsage.totalRequests,
              costCents: (sessionTokenUsage.totalCostUsd * 100).toFixed(2)
            }
          });
        }
        toolCalls = extractToolCalls(provider, response);
      }

      debugLog("[Chief flow] runAgentLoop iteration:", {
        iteration: index + 1,
        toolCalls: toolCalls.length,
        tools: toolCalls.map((tc) => ({
          name: tc.name,
          args: safeJsonStringify(tc.arguments, 200)
        }))
      });

      if (!toolCalls.length) {
        let finalText = useStreaming ? streamedText : extractTextResponse(provider, response);

        // Hallucination guard: if the model claims to have performed an action but made
        // zero tool calls in the entire loop, inject a correction and retry once.
        if (trace.toolCalls.length === 0 && index === 0) {
          const actionClaimPattern = /\b(Done[!.]|I've\s+(added|removed|changed|created|updated|deleted|set|applied|configured|enabled|disabled|turned|executed|moved|copied|sent|posted|modified|installed|fixed)|has been\s+(added|removed|changed|created|updated|deleted|applied|configured|enabled|disabled))/i;
          if (actionClaimPattern.test(finalText)) {
            debugLog("[Chief flow] runAgentLoop hallucination guard triggered — model claimed action with 0 tool calls, retrying.");
            messages.push(formatAssistantMessage(provider, response));
            messages.push({ role: "user", content: "You claimed to perform an action but did not make any tool call. That response was not shown to the user. Please actually call the appropriate tool to complete the request." });
            continue;
          }
        }

        if (requiresLiveDataTool && !sawSuccessfulExternalDataToolResult) {
          finalText = "I can't answer that reliably without checking live tools first. Please retry, and I'll fetch the real data before responding.";
          debugLog("[Chief flow] runAgentLoop text blocked: missing successful external tool result.");
        }
        trace.finishedAt = Date.now();
        trace.resultTextPreview = String(finalText || "").slice(0, 400);
        updateChatPanelCostIndicator();
        return {
          text: finalText,
          messages
        };
      }


      messages.push(formatAssistantMessage(provider, response));
      const toolResults = [];
      for (const toolCall of toolCalls) {
        const isExternalToolCall = isExternalDataToolCall(toolCall.name);
        if (onToolCall) onToolCall(toolCall.name, toolCall.arguments);
        const startedAt = Date.now();
        let result;
        let errorMessage = "";
        const toolArgs = withComposioSessionArgs(toolCall.name, toolCall.arguments, composioSessionId);
        try {
          result = await executeToolCall(toolCall.name, toolArgs);
          const discoveredSessionId = extractComposioSessionIdFromToolResult(result);
          if (discoveredSessionId) composioSessionId = discoveredSessionId;
        } catch (error) {
          errorMessage = error?.message || "Tool call failed";
          const isComposioTool = String(toolCall.name || "").toUpperCase().startsWith("COMPOSIO_");
          const isValidationError = /validation|invalid/i.test(errorMessage);
          if (isComposioTool && isValidationError && composioSessionId) {
            try {
              const retryArgs = withComposioSessionArgs(toolCall.name, toolArgs, composioSessionId);
              result = await executeToolCall(toolCall.name, retryArgs);
              errorMessage = "";
              const discoveredSessionId = extractComposioSessionIdFromToolResult(result);
              if (discoveredSessionId) composioSessionId = discoveredSessionId;
            } catch (retryError) {
              errorMessage = retryError?.message || errorMessage;
              result = { error: errorMessage };
            }
          } else {
            result = { error: errorMessage };
          }
        }
        const durationMs = Date.now() - startedAt;
        debugLog("[Chief flow] tool result:", {
          tool: toolCall.name,
          durationMs,
          error: errorMessage || null,
          result: errorMessage ? null : safeJsonStringify(result, 400)
        });
        trace.toolCalls.push({
          name: toolCall.name,
          argumentsPreview: safeJsonStringify(toolArgs, 350),
          startedAt,
          durationMs,
          error: errorMessage
        });
        if (isExternalToolCall && isSuccessfulExternalToolResult(result)) {
          sawSuccessfulExternalDataToolResult = true;
        }
        if (onToolResult) onToolResult(toolCall.name, result);
        toolResults.push({ toolCall, result });
      }
      messages.push(...formatToolResults(provider, toolResults));
      prunablePrefixCount = enforceAgentMessageBudgetInPlace(messages, { prunablePrefixCount });
      if (approximateMessageChars(messages) > MAX_AGENT_MESSAGES_CHAR_BUDGET) {
        const finalText = getAgentOverBudgetMessage();
        debugLog("[Chief flow] runAgentLoop exit: over budget after tool results.");
        trace.finishedAt = Date.now();
        trace.resultTextPreview = finalText.slice(0, 400);
        return {
          text: finalText,
          messages
        };
      }
    }

    trace.finishedAt = Date.now();
    trace.error = "Agent loop exceeded maximum iterations";
    throw new Error("Agent loop exceeded maximum iterations");
  } catch (error) {
    trace.finishedAt = Date.now();
    trace.error = error?.message || "Agent loop failed";
    throw error;
  } finally {
    activeAgentAbortController = null;
  }
}

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
  while (queue.length && visited < COMPOSIO_INSTALLED_TOOLS_BFS_MAX_NODES) {
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
    debugLog("[Chief of Staff] Installed tools BFS capped:", {
      maxNodes: COMPOSIO_INSTALLED_TOOLS_BFS_MAX_NODES
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

function invalidateInstalledToolsFetchCache() {
  installedToolsFetchCache.expiresAt = 0;
  installedToolsFetchCache.promise = null;
  installedToolsFetchCache.data = null;
}

async function fetchInstalledToolsFromComposio(clientOverride = null) {
  const client = clientOverride || mcpClient;
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
      debugLog("[Chief of Staff] Composio tool-check meta:", {
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

async function reconcileInstalledToolsWithComposio(extensionAPI) {
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
        schemaVersion: TOOLS_SCHEMA_VERSION,
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

function buildSettingsConfig(extensionAPI) {
  return {
    tabTitle: "Chief of Staff",
    settings: [
      {
        id: SETTINGS_KEYS.composioMcpUrl,
        name: "Composio MCP URL",
        description: "MCP endpoint URL used to connect this extension to Composio.",
        action: {
          type: "input",
          value: getSettingString(extensionAPI, SETTINGS_KEYS.composioMcpUrl, DEFAULT_COMPOSIO_MCP_URL),
          placeholder: DEFAULT_COMPOSIO_MCP_URL
        }
      },
      {
        id: SETTINGS_KEYS.composioApiKey,
        name: "Composio API Key",
        description: "API key sent as the x-api-key header for Composio MCP requests.",
        action: {
          type: "input",
          value: getSettingString(extensionAPI, SETTINGS_KEYS.composioApiKey, DEFAULT_COMPOSIO_API_KEY),
          placeholder: "ak_..."
        }
      },
      {
        id: SETTINGS_KEYS.assistantName,
        name: "Assistant Name",
        description: "Display name used in chat UI and assistant toasts.",
        action: {
          type: "input",
          value: getAssistantDisplayName(extensionAPI),
          placeholder: DEFAULT_ASSISTANT_NAME
        }
      },
      {
        id: SETTINGS_KEYS.llmProvider,
        name: "LLM Provider",
        description: "AI provider for Chief of Staff reasoning.",
        action: {
          type: "select",
          items: ["anthropic", "openai"],
          value: getLlmProvider(extensionAPI)
        }
      },
      {
        id: SETTINGS_KEYS.openaiApiKey,
        name: "OpenAI API Key",
        description: "Your OpenAI API key. Required for voice dictation (Whisper) and OpenAI models.",
        action: {
          type: "input",
          value: getSettingString(extensionAPI, SETTINGS_KEYS.openaiApiKey, "") || getSettingString(extensionAPI, SETTINGS_KEYS.llmApiKey, ""),
          placeholder: "sk-..."
        }
      },
      {
        id: SETTINGS_KEYS.anthropicApiKey,
        name: "Anthropic API Key",
        description: "Your Anthropic API key. Required when LLM Provider is set to Anthropic.",
        action: {
          type: "input",
          value: getSettingString(extensionAPI, SETTINGS_KEYS.anthropicApiKey, ""),
          placeholder: "sk-ant-..."
        }
      },
      {
        id: SETTINGS_KEYS.llmModel,
        name: "LLM Model",
        description: "Model to use. Leave blank for default.",
        action: {
          type: "input",
          value: getSettingString(extensionAPI, SETTINGS_KEYS.llmModel, ""),
          placeholder: DEFAULT_LLM_MODELS.anthropic
        }
      },
      {
        id: SETTINGS_KEYS.debugLogging,
        name: "Debug Logging",
        description: "Enable verbose console logs for troubleshooting.",
        action: {
          type: "switch",
          value: isDebugLoggingEnabled(extensionAPI)
        }
      },
      {
        id: SETTINGS_KEYS.dryRunMode,
        name: "Dry Run (one-shot)",
        description: "When enabled, the next mutating tool call is simulated WITHOUT approval prompt. This setting auto-disables after one use.",
        action: {
          type: "switch",
          value: isDryRunEnabled(extensionAPI)
        }
      }
    ]
  };
}

async function connectComposio(extensionAPI, options = {}) {
  const { suppressConnectedToast = false } = options;
  if (mcpClient) {
    debugLog("Composio client already connected.");
    return mcpClient;
  }
  // Backoff after recent failure to avoid hammering a down server
  if (composioLastFailureAt && (Date.now() - composioLastFailureAt) < COMPOSIO_CONNECT_BACKOFF_MS) {
    debugLog("Composio connect skipped (backoff after recent failure).");
    return null;
  }
  if (connectInFlightPromise) {
    debugLog("Composio connection already in progress.");
    // Wait for in-flight connection and return its result
    const result = await connectInFlightPromise;
    return result; // Will be mcpClient or null
  }

  const promise = (async () => {
    try {
      const composioMcpUrl = getSettingString(
        extensionAPI,
        SETTINGS_KEYS.composioMcpUrl,
        DEFAULT_COMPOSIO_MCP_URL
      );
      const composioApiKey = getSettingString(
        extensionAPI,
        SETTINGS_KEYS.composioApiKey,
        DEFAULT_COMPOSIO_API_KEY
      );
      const headers = composioApiKey ? { "x-api-key": composioApiKey } : {};
      composioTransportAbortController = new AbortController();

      const transportFetch = async (input, init = {}) => {
        const method = String(init?.method || "GET").toUpperCase();
        const requestUrl = String(
          typeof input === "string"
            ? input
            : input?.url || ""
        );
        return fetch(input, { ...init, signal: composioTransportAbortController?.signal });
      };

      const transport = new StreamableHTTPClientTransport(
        new URL(composioMcpUrl),
        {
          fetch: transportFetch,
          requestInit: {
            headers
          }
        }
      );

      const client = new Client({
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
        }, COMPOSIO_MCP_CONNECT_TIMEOUT_MS);
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
      mcpClient = client;
      composioLastFailureAt = 0;
      invalidateInstalledToolsFetchCache();
      debugLog("Connected to Composio!");
      if (!suppressConnectedToast) showConnectedToast();
      await reconcileInstalledToolsWithComposio(extensionAPI);
      // Discover schemas for all connected toolkits in background
      discoverAllConnectedToolkitSchemas(extensionAPI).catch(() => { });

      return mcpClient;
    } catch (error) {
      mcpClient = null;
      composioLastFailureAt = Date.now();
      if (composioTransportAbortController) {
        composioTransportAbortController.abort();
        composioTransportAbortController = null;
      }
      console.error("Failed to connect to Composio:", error);
      return null;
    } finally {
      connectInFlightPromise = null;
    }
  })();

  // Assign immediately so concurrent callers see the in-flight promise
  connectInFlightPromise = promise;
  return promise;
}

function shouldAttemptComposioAutoConnect(extensionAPI) {
  const composioMcpUrl = getSettingString(
    extensionAPI,
    SETTINGS_KEYS.composioMcpUrl,
    DEFAULT_COMPOSIO_MCP_URL
  );
  const composioApiKey = getSettingString(
    extensionAPI,
    SETTINGS_KEYS.composioApiKey,
    DEFAULT_COMPOSIO_API_KEY
  );
  const hasRealUrl =
    composioMcpUrl &&
    composioMcpUrl !== DEFAULT_COMPOSIO_MCP_URL &&
    /^https?:\/\//i.test(composioMcpUrl);
  const hasRealKey =
    composioApiKey &&
    composioApiKey !== DEFAULT_COMPOSIO_API_KEY &&
    composioApiKey.length > 8;
  return Boolean(hasRealUrl && hasRealKey);
}

function scheduleComposioAutoConnect(extensionAPI) {
  clearComposioAutoConnectTimer();
  if (!shouldAttemptComposioAutoConnect(extensionAPI)) return;
  composioAutoConnectTimeoutId = window.setTimeout(() => {
    composioAutoConnectTimeoutId = null;
    connectComposio(extensionAPI, { suppressConnectedToast: true });
  }, COMPOSIO_AUTO_CONNECT_DELAY_MS);
}

async function disconnectComposio(options = {}) {
  const { suppressDisconnectedToast = false } = options;
  if (connectInFlightPromise) {
    debugLog("Composio connection is in progress; try again in a moment.");
    return;
  }
  if (!mcpClient) {
    debugLog("No active Composio client to disconnect.");
    return;
  }
  try {
    await mcpClient.close();
    debugLog("Disconnected from Composio.");
    if (!suppressDisconnectedToast) showDisconnectedToast();
  } catch (error) {
    console.error("Failed to disconnect from Composio:", error);
  } finally {
    mcpClient = null;
    if (composioTransportAbortController) {
      composioTransportAbortController.abort();
      composioTransportAbortController = null;
    }
    invalidateInstalledToolsFetchCache();
  }
}

async function reconnectComposio(extensionAPI) {
  if (connectInFlightPromise) {
    debugLog("Composio connection is in progress; try again in a moment.");
    showInfoToast("Reconnect pending", "Composio connection is already in progress. Try again in a moment.");
    return;
  }
  await disconnectComposio({ suppressDisconnectedToast: true });
  const client = await connectComposio(extensionAPI, { suppressConnectedToast: true });
  if (client) showReconnectedToast();
}

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

function startToolAuthPolling(extensionAPI, toolSlug) {
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
    pollState.timeoutId = window.setTimeout(runPoll, AUTH_POLL_INTERVAL_MS);
  };

  const runPoll = async () => {
    if (pollState.running || pollState.stopped) return;
    pollState.running = true;
    try {
      // Check stopped before async work
      if (pollState.stopped) return;
      const client = mcpClient || await connectComposio(extensionAPI, { suppressConnectedToast: true });
      // Check again after async operation
      if (pollState.stopped || !client?.callTool) return;
      debugLog("[Chief of Staff] Auth poll tick:", key);
      const remoteInstalledTools = await fetchInstalledToolsFromComposioCached(client, {
        ttlMs: COMPOSIO_AUTH_POLL_REMOTE_CACHE_TTL_MS
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
      showInfoToast("Authentication complete", `${key} is now connected and ready.`);
      clearAuthPollForSlug(key);
      // Discover toolkit schemas in background
      discoverToolkitSchema(inferToolkitFromSlug(key), { force: true }).catch(() => { });
    } catch (error) {
      console.error("[Chief of Staff] Auth poll error:", { toolSlug: key, error });
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
    showInfoToast("Authentication pending", `${key} is still waiting for completion. Use refresh to re-check.`);
    clearAuthPollForSlug(key);
  }, AUTH_POLL_TIMEOUT_MS);

  authPollStateBySlug.set(key, pollState);
  runPoll();
}

async function installComposioTool(extensionAPI, requestedSlug) {
  const toolSlug = normaliseToolkitSlug(requestedSlug);
  if (!toolSlug) {
    showInfoToast("Install cancelled", "No tool slug entered.");
    return;
  }

  const client = await connectComposio(extensionAPI, { suppressConnectedToast: true });
  if (!client?.callTool) {
    showErrorToast("Install failed", "Composio is not connected.");
    return;
  }

  const resolution = await resolveComposioToolkitSlugForInstall(client, toolSlug, extensionAPI);
  const installSlug = resolution?.resolvedSlug || toolSlug;
  const suggestions = Array.isArray(resolution?.suggestions) ? resolution.suggestions : [];
  mergeComposioToolkitCatalogSlugs(extensionAPI, [toolSlug, installSlug], { touchFetchedAt: false });
  if (installSlug !== toolSlug) {
    showInfoToast("Slug resolved", `Using ${installSlug} for requested ${toolSlug}.`);
  } else if (suggestions.length > 0 && !suggestions.includes(toolSlug)) {
    const hint = suggestions.slice(0, 5).join(", ");
    showInfoToast("Possible slug mismatch", `Closest known toolkit slugs: ${hint}`);
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
    debugLog("[Chief of Staff] Composio install meta:", {
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
          showInfoToast("Auth required", `Open this link to finish ${installSlug}: ${url}`);
        }
      });
      showInfoToast("Authentication required", `Finish ${installSlug} setup in the opened tab.`);
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
    showConnectedToast();
    showInfoToast("Tool installed", `${installSlug} is now available.`);
    // Discover toolkit schemas in background (non-blocking)
    discoverToolkitSchema(inferToolkitFromSlug(installSlug)).catch(() => { });
  } catch (error) {
    upsertInstalledTool(extensionAPI, {
      slug: installSlug,
      label: installSlug,
      installState: "failed",
      lastError: error?.message || "Unknown install error"
    });
    showErrorToast("Install failed", `Could not install ${installSlug}.`);
    console.error("Failed to install Composio tool:", error);
  }
}

async function promptInstallComposioTool(extensionAPI) {
  const toolSlug = await promptToolSlugWithToast("");
  if (!toolSlug) {
    showInfoToast("Install cancelled", "No tool slug entered.");
    return;
  }
  await installComposioTool(extensionAPI, toolSlug);
}

async function promptDeregisterComposioTool(extensionAPI) {
  const client = await connectComposio(extensionAPI, { suppressConnectedToast: true });
  if (!client?.callTool) {
    showErrorToast("Deregister failed", "Composio is not connected.");
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
    showInfoToast("Nothing to deregister", "No installed or pending-auth tools found.");
    return;
  }

  const toolSlug = await promptInstalledToolSlugWithToast(removableTools, {
    title: "Deregister Composio Tool",
    confirmLabel: "Uninstall"
  });
  if (!toolSlug) {
    showInfoToast("Deregister cancelled", "No tool selected.");
    return;
  }
  await deregisterComposioTool(extensionAPI, toolSlug);
}

async function testComposioToolConnection(extensionAPI, requestedSlug) {
  const toolSlug = (requestedSlug || "").trim().toUpperCase();
  if (!toolSlug) {
    showInfoToast("Test cancelled", "No tool selected.");
    return;
  }

  const client = await connectComposio(extensionAPI, { suppressConnectedToast: true });
  if (!client?.callTool) {
    showErrorToast("Test failed", "Composio is not connected.");
    return;
  }

  const isConnected = await checkToolConnectedViaComposio(client, toolSlug);

  if (isConnected) {
    showInfoToast("Tool connected", `${toolSlug} is reachable. Composio session is connected.`);
  } else {
    const localState = getToolsConfigState(extensionAPI);
    const hasLocalInstalledRecord = localState.installedTools.some(
      (tool) =>
        normaliseToolSlugToken(tool?.slug) === normaliseToolSlugToken(toolSlug) &&
        tool.installState === "installed"
    );

    if (hasLocalInstalledRecord) {
      showInfoToast(
        "Connection uncertain",
        `${toolSlug} is marked installed locally, but Composio did not return a definitive match.`
      );
      return;
    }
    showErrorToast("Test failed", `${toolSlug} was not found in connected Composio tools.`);
  }
}

async function promptTestComposioTool(extensionAPI) {
  const client = await connectComposio(extensionAPI, { suppressConnectedToast: true });
  if (!client?.callTool) {
    showErrorToast("Test failed", "Composio is not connected.");
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
    showInfoToast("No tools available", "No installed tools found to test.");
    return;
  }

  const toolSlug = await promptInstalledToolSlugWithToast(selectableTools, {
    title: "Test Composio Tool Connection",
    confirmLabel: "Test"
  });
  if (!toolSlug) {
    showInfoToast("Test cancelled", "No tool selected.");
    return;
  }

  await testComposioToolConnection(extensionAPI, toolSlug);
}

async function refreshToolAuthStatus(extensionAPI) {
  const client = await connectComposio(extensionAPI, { suppressConnectedToast: true });
  if (!client?.callTool) {
    showErrorToast("Refresh failed", "Composio is not connected.");
    return;
  }

  const state = getToolsConfigState(extensionAPI);
  const pendingTools = state.installedTools.filter((tool) => tool.installState === "pending_auth");
  if (!pendingTools.length) {
    showInfoToast("Nothing pending", "No tools are currently waiting for authentication.");
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
    showInfoToast("Auth refreshed", `${activatedCount} tool(s) are now connected.`);
  } else {
    showInfoToast("Still pending", "No pending tools have completed authentication yet.");
  }
}

async function deregisterComposioTool(extensionAPI, requestedSlug) {
  const toolSlug = (requestedSlug || "").trim().toUpperCase();
  if (!toolSlug) {
    showInfoToast("Deregister cancelled", "No tool slug entered.");
    return;
  }

  const client = await connectComposio(extensionAPI, { suppressConnectedToast: true });
  if (!client?.callTool) {
    showErrorToast("Deregister failed", "Composio is not connected.");
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
      debugLog("[Chief of Staff] Composio deregister meta:", {
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
    showErrorToast("Deregister failed", `Could not deregister ${toolSlug}.`);
    return;
  }

  invalidateInstalledToolsFetchCache();
  const state = getToolsConfigState(extensionAPI);
  const nextInstalledTools = state.installedTools.filter((tool) => tool.slug !== toolSlug);
  saveToolsConfigState(extensionAPI, {
    ...state,
    installedTools: nextInstalledTools
  });
  await reconcileInstalledToolsWithComposio(extensionAPI);
  showInfoToast("Tool deregistered", `${toolSlug} has been deregistered.`);
}

function showStoredToolsConfig(extensionAPI) {
  const state = getToolsConfigState(extensionAPI);
  console.info("Chief of Staff tools config:", state);
  showInfoToast("Tools config logged", "Open browser console to view stored tool config.");
}

async function showMemorySnapshot() {
  const content = await getAllMemoryContent({ force: true });
  if (!content) {
    showInfoToast("No memory", "Memory pages are empty or not created yet.");
    return;
  }
  console.info("[Chief of Staff] Memory snapshot:\n", content);
  showInfoToast("Memory logged", `${content.length} chars loaded. See console.`);
}

async function showSkillsSnapshot() {
  const fullContent = await getSkillsContent({ force: true });
  const indexContent = await getSkillsIndexContent({ force: true });
  if (!fullContent) {
    showInfoToast("No skills", "Skills page is empty or not created yet.");
    return;
  }
  console.info("[Chief of Staff] Skills snapshot (full):\n", fullContent);
  console.info("[Chief of Staff] Skills snapshot (index):\n", indexContent);
  const detected = Number.isFinite(skillsPromptCache.detectedCount) ? skillsPromptCache.detectedCount : 0;
  const injected = Number.isFinite(skillsPromptCache.injectedCount) ? skillsPromptCache.injectedCount : 0;
  showInfoToast("Skills logged", `${detected} detected, ${injected} injected into prompt. See console.`);
}

async function refreshSkillsFromGraph() {
  invalidateSkillsPromptCache();
  const entries = await getSkillEntries({ force: true });
  await getSkillsIndexContent({ force: true });
  if (!entries.length) {
    showInfoToast("Skills refreshed", "No skills found on Chief of Staff/Skills.");
    return;
  }
  const preview = entries.slice(0, 5).map((entry) => entry.title).join(", ");
  const detected = Number.isFinite(skillsPromptCache.detectedCount) ? skillsPromptCache.detectedCount : entries.length;
  const injected = Number.isFinite(skillsPromptCache.injectedCount) ? skillsPromptCache.injectedCount : entries.length;
  showInfoToast(
    "Skills refreshed",
    `Detected ${detected} skill(s), injected ${injected} into prompt: ${preview}${entries.length > 5 ? ", ..." : ""}`
  );
}

async function bootstrapSkillsPage() {
  const title = SKILLS_PAGE_TITLE;
  const existingUid = getPageUidByTitle(title);
  if (existingUid) {
    showInfoToast("Skills exist", "Skills page already exists.");
    return;
  }
  const pageUid = await ensurePageUidByTitle(title);
  const starterSkills = [
    {
      name: "Weekly Planning",
      steps: [
        "Trigger: user asks planning/prioritisation for the week",
        "Approach: list outcomes, sequence actions, identify blockers, assign next actions",
        "Output format: concise bullets with priorities and due dates"
      ]
    },
    {
      name: "Decision Review",
      steps: [
        "Trigger: user asks for recommendation between options",
        "Approach: compare options, tradeoffs, risks, and reversibility",
        "Output format: recommendation + rationale + next action"
      ]
    },
    {
      name: "Structured Daily Briefing",
      steps: [
        "Trigger: user asks for a daily briefing or morning summary",
        "Approach: gather calendar events via cos_calendar_read, email signals via cos_email_fetch, and urgent tasks via bt_search",
        "Output: produce a structured briefing with sections: \"Calendar\", \"Email\", \"Tasks\", and \"Top Priorities\". The system will write this to today's daily page automatically.",
        "Keep each section concise and actionable. Prefer tool calls over guessing."
      ]
    }
  ];
  for (let index = 0; index < starterSkills.length; index += 1) {
    const skill = starterSkills[index];
    const parentUid = await createRoamBlock(pageUid, String(skill.name || "").trim(), index);
    for (let childIndex = 0; childIndex < skill.steps.length; childIndex += 1) {
      await createRoamBlock(parentUid, skill.steps[childIndex], childIndex);
    }
  }
  invalidateSkillsPromptCache();
  showInfoToast("Skills initialised", "Created Chief of Staff/Skills using name + child blocks format.");
}

async function runBootstrapMemoryPages() {
  try {
    const result = await bootstrapMemoryPages();
    if (result.createdCount > 0) {
      showInfoToast("Memory initialised", `Created ${result.createdCount} memory page(s).`);
      // Register pull watches for newly created pages
      registerMemoryPullWatches();
    } else {
      showInfoToast("Memory exists", "All memory pages already exist.");
    }
  } catch (error) {
    showErrorToast("Bootstrap failed", error?.message || "Unknown error");
  }
}

function showLastRunTrace() {
  if (!lastAgentRunTrace) {
    showInfoToast("No trace yet", "Run an Ask command first.");
    return;
  }
  console.info("Chief of Staff last run trace:", lastAgentRunTrace);
  const toolCount = Array.isArray(lastAgentRunTrace.toolCalls) ? lastAgentRunTrace.toolCalls.length : 0;
  const statusLabel = lastAgentRunTrace.error ? "with errors" : "success";
  showInfoToast("Run trace logged", `${toolCount} tool call(s), ${statusLabel}. See console.`);
}

function getChiefRuntimeStats() {
  const pollStates = Array.from(authPollStateBySlug.values());
  const activePolls = pollStates.filter((state) => !state?.stopped).length;
  const runningPolls = pollStates.filter((state) => state?.running && !state?.stopped).length;
  const chatPanelsInDom = document?.querySelectorAll?.("[data-chief-chat-panel='true']")?.length || 0;
  const chatInputNodes = document?.querySelectorAll?.("[data-chief-chat-input]")?.length || 0;
  const chatMessageNodes = document?.querySelectorAll?.("[data-chief-chat-messages]")?.length || 0;
  const chatSendNodes = document?.querySelectorAll?.("[data-chief-chat-send]")?.length || 0;
  const toastPromptInputs = document?.querySelectorAll?.("[data-chief-tool-input],[data-chief-input],[data-chief-tool-select]")?.length || 0;
  const installedToolsCount = extensionAPIRef
    ? getToolsConfigState(extensionAPIRef).installedTools.length
    : 0;
  const catalogCache = getComposioToolkitCatalogCache(extensionAPIRef);
  const catalogAgeMs = catalogCache?.fetchedAt ? Date.now() - catalogCache.fetchedAt : null;
  return {
    timestamp: new Date().toISOString(),
    mcpConnected: Boolean(mcpClient?.callTool),
    connectInFlight: Boolean(connectInFlightPromise),
    autoConnectTimerPending: Boolean(composioAutoConnectTimeoutId),
    startupAuthPollTimeouts: startupAuthPollTimeoutIds.length,
    authPollsTracked: authPollStateBySlug.size,
    authPollsActive: activePolls,
    authPollsRunningNow: runningPolls,
    chatPanelRefExists: Boolean(chatPanelContainer),
    chatPanelsInDom,
    chatInputNodes,
    chatMessageNodes,
    chatSendNodes,
    toastPromptInputs,
    installedToolsCount,
    toolkitCatalogCacheSlugs: Array.isArray(catalogCache?.slugs) ? catalogCache.slugs.length : 0,
    toolkitCatalogCacheAgeMs: Number.isFinite(catalogAgeMs) ? catalogAgeMs : null
  };
}

function showRuntimeStats() {
  const stats = getChiefRuntimeStats();
  console.info("Chief of Staff runtime stats:", stats);
  const summary = `polls ${stats.authPollsActive}/${stats.authPollsTracked}, panels ${stats.chatPanelsInDom}, connected ${stats.mcpConnected ? "yes" : "no"}`;
  showInfoToast("Runtime stats logged", `${summary}. See console.`);
}

function clearConversationContextWithToast() {
  clearConversationContext({ persist: true });
  clearChatPanelHistory();
  showInfoToast("Context cleared", "Conversation memory has been reset.");
}

function getUserFacingLlmErrorMessage(error, context = "Request") {
  const raw = String(error?.message || "").trim();
  const lowered = raw.toLowerCase();
  if (error?.name === "AbortError") {
    return `${context} was cancelled.`;
  }
  if (lowered.includes("rate limit")) {
    return `${context} hit provider rate limits. Wait ~60s, or switch LLM provider in settings and retry.`;
  }
  // Truncate verbose API error bodies to avoid leaking raw response details
  if (raw.length > 200) return `${context} failed: ${raw.slice(0, 180)}…`;
  if (raw) return raw;
  return `${context} failed due to an unknown error.`;
}

function buildAskResult(prompt, responseText) {
  return {
    text: responseText,
    messages: [{ role: "user", content: prompt }]
  };
}

function publishAskResponse(prompt, responseText, assistantName, suppressToasts = false) {
  appendConversationTurn(prompt, responseText);
  showInfoToastIfAllowed(assistantName, String(responseText || "").slice(0, 280), suppressToasts);
  debugLog("[Chief of Staff] Ask response:", responseText);
  return buildAskResult(prompt, responseText);
}

async function tryRunDeterministicAskIntent(prompt, context = {}) {
  const {
    suppressToasts = false,
    assistantName = getAssistantDisplayName(),
    installedToolSlugsForIntents = [],
    offerWriteToDailyPage = false
  } = context;
  debugLog("[Chief flow] Deterministic router: evaluating.");

  if (extensionAPIRef && isConnectionStatusIntent(prompt)) {
    debugLog("[Chief flow] Deterministic route matched: connection_status");
    const summaryText = await getDeterministicConnectionSummary(extensionAPIRef);
    return publishAskResponse(prompt, summaryText, assistantName, suppressToasts);
  }

  const deregisterIntent = parseComposioDeregisterIntent(prompt, {
    installedSlugs: installedToolSlugsForIntents
  });
  if (extensionAPIRef && deregisterIntent?.toolSlug) {
    debugLog("[Chief flow] Deterministic route matched: composio_deregister", {
      toolSlug: deregisterIntent.toolSlug
    });
    const targetSlug = String(deregisterIntent.toolSlug || "").trim().toUpperCase();
    await deregisterComposioTool(extensionAPIRef, targetSlug);
    const stateAfter = getToolsConfigState(extensionAPIRef);
    const stillTracked = stateAfter.installedTools.some(
      (tool) => normaliseToolSlugToken(tool?.slug) === normaliseToolSlugToken(targetSlug)
    );
    const responseText = stillTracked
      ? `I attempted to deregister ${targetSlug}, but it still appears in local tool state. Check the latest toast for details.`
      : `${targetSlug} has been deregistered (or was already removed).`;
    return publishAskResponse(prompt, responseText, assistantName, suppressToasts);
  }

  const installIntent = parseComposioInstallIntent(prompt);
  if (extensionAPIRef && installIntent?.toolSlug) {
    debugLog("[Chief flow] Deterministic route matched: composio_install", {
      toolSlug: installIntent.toolSlug
    });
    const targetSlug = String(installIntent.toolSlug || "").trim().toUpperCase();
    try {
      await installComposioTool(extensionAPIRef, targetSlug);
      const stateAfter = getToolsConfigState(extensionAPIRef);
      const installed = stateAfter.installedTools.find(
        (tool) => normaliseToolSlugToken(tool?.slug) === normaliseToolSlugToken(targetSlug)
      );
      const state = installed?.installState || "";
      const responseText = state === "pending_auth"
        ? `${targetSlug} requires authentication. A browser tab should have opened — complete the setup there, then try using the tool.`
        : state === "failed"
          ? `${targetSlug} installation failed. Check the toasts for details.`
          : `${targetSlug} has been installed and is now available.`;
      return publishAskResponse(prompt, responseText, assistantName, suppressToasts);
    } catch (error) {
      const responseText = `Failed to install ${targetSlug}: ${error?.message || "Unknown error"}. Check the Composio connection and try again.`;
      return publishAskResponse(prompt, responseText, assistantName, suppressToasts);
    }
  }

  const memorySaveIntent = parseMemorySaveIntent(prompt);
  if (memorySaveIntent) {
    debugLog("[Chief flow] Deterministic route matched: memory_save");
    const responseText = await runDeterministicMemorySave(memorySaveIntent);
    return publishAskResponse(prompt, responseText, assistantName, suppressToasts);
  }

  const skillIntent = parseSkillInvocationIntent(prompt);
  // Also detect natural-language briefing requests and route to the Daily Briefing skill
  const briefingIntent = !skillIntent && /\b(daily\s*)?briefing\b/i.test(prompt)
    ? { skillName: "Daily Briefing", targetText: "", originalPrompt: prompt }
    : null;
  const resolvedSkillIntent = skillIntent || briefingIntent;
  if (resolvedSkillIntent) {
    debugLog("[Chief flow] Deterministic route matched: skill_invoke", {
      skillName: resolvedSkillIntent?.skillName || "",
      viaBriefingShortcut: Boolean(briefingIntent)
    });
    const responseText = await runDeterministicSkillInvocation(resolvedSkillIntent, { suppressToasts });
    const result = publishAskResponse(prompt, responseText, assistantName, suppressToasts);

    if (offerWriteToDailyPage) {
      const shouldWrite = await promptWriteToDailyPage();
      if (shouldWrite) {
        try {
          const writeResult = await writeResponseToTodayDailyPage(prompt, responseText);
          showInfoToast("Saved to Roam", `Added under ${writeResult.pageTitle}.`);
        } catch (error) {
          showErrorToast("Write failed", error?.message || "Could not write to daily page.");
        }
      }
    }

    return result;
  }

  debugLog("[Chief flow] Deterministic router: no match.");
  return null;
}

async function askChiefOfStaff(userMessage, options = {}) {
  const { offerWriteToDailyPage = false, suppressToasts = false, onTextChunk = null } = options;
  const prompt = String(userMessage || "").trim();
  if (!prompt) return;
  debugLog("[Chief flow] askChiefOfStaff start:", {
    promptPreview: prompt.slice(0, 160),
    offerWriteToDailyPage,
    suppressToasts
  });
  const assistantName = getAssistantDisplayName();
  const hasContext = conversationTurns.length > 0;
  const installedToolSlugsForIntents = extensionAPIRef
    ? getToolsConfigState(extensionAPIRef).installedTools.map((tool) => tool?.slug)
    : [];

  const deterministicResult = await tryRunDeterministicAskIntent(prompt, {
    suppressToasts,
    assistantName,
    installedToolSlugsForIntents,
    offerWriteToDailyPage
  });
  if (deterministicResult) {
    debugLog("[Chief flow] askChiefOfStaff completed via deterministic route.");
    return deterministicResult;
  }
  debugLog("[Chief flow] Falling back to runAgentLoop.");

  showInfoToastIfAllowed(
    "Context",
    hasContext ? "Using recent conversation context." : "Starting fresh context.",
    suppressToasts
  );
  showInfoToastIfAllowed("Thinking...", prompt.slice(0, 72), suppressToasts);
  const result = await runAgentLoop(prompt, {
    onToolCall: (name) => {
      showInfoToastIfAllowed("Using tool", name, suppressToasts);
    },
    onTextChunk
  });
  const responseText = String(result?.text || "").trim() || "No response generated.";
  appendConversationTurn(prompt, responseText);
  showInfoToastIfAllowed(assistantName, responseText.slice(0, 280), suppressToasts);
  debugLog("[Chief of Staff] Ask response:", responseText);
  debugLog("[Chief flow] askChiefOfStaff completed via runAgentLoop.");

  if (offerWriteToDailyPage) {
    const shouldWrite = await promptWriteToDailyPage();
    if (shouldWrite) {
      try {
        const writeResult = await writeResponseToTodayDailyPage(prompt, responseText);
        showInfoToast("Saved to Roam", `Added under ${writeResult.pageTitle}.`);
      } catch (error) {
        showErrorToast("Write failed", error?.message || "Could not write to daily page.");
      }
    }
  }

  return result;
}

async function promptAskChiefOfStaff() {
  const assistantName = getAssistantDisplayName();
  const userMessage = await promptTextWithToast({
    title: `${assistantName}: Ask`,
    placeholder: `What should I focus on today?`,
    confirmLabel: "Ask"
  });
  if (!userMessage) return;
  try {
    await askChiefOfStaff(userMessage, { offerWriteToDailyPage: true });
  } catch (error) {
    showErrorToast("Ask failed", getUserFacingLlmErrorMessage(error, "Ask"));
    console.error("[Chief of Staff] Ask error:", error);
  }
}

function registerCommandPaletteCommands(extensionAPI) {
  if (commandPaletteRegistered) return;
  if (!extensionAPI?.ui?.commandPalette?.addCommand) return;

  extensionAPI.ui.commandPalette.addCommand({
    label: "Chief of Staff: Ask",
    callback: () => promptAskChiefOfStaff()
  });
  extensionAPI.ui.commandPalette.addCommand({
    label: "Chief of Staff: Toggle Chat Panel",
    callback: () => toggleChatPanel()
  });
  extensionAPI.ui.commandPalette.addCommand({
    label: "Chief of Staff: Bootstrap Memory Pages",
    callback: async () => {
      await runBootstrapMemoryPages();
    }
  });
  extensionAPI.ui.commandPalette.addCommand({
    label: "Chief of Staff: Bootstrap Skills Page",
    callback: async () => {
      try {
        await bootstrapSkillsPage();
        // Register pull watch for newly created skills page
        registerMemoryPullWatches();
      } catch (error) {
        showErrorToast("Skills bootstrap failed", error?.message || "Unknown error");
      }
    }
  });
  extensionAPI.ui.commandPalette.addCommand({
    label: "Chief of Staff: Show Memory Snapshot",
    callback: async () => showMemorySnapshot()
  });
  extensionAPI.ui.commandPalette.addCommand({
    label: "Chief of Staff: Show Skills Snapshot",
    callback: async () => showSkillsSnapshot()
  });
  extensionAPI.ui.commandPalette.addCommand({
    label: "Chief of Staff: Refresh Skills Cache",
    callback: async () => refreshSkillsFromGraph()
  });
  extensionAPI.ui.commandPalette.addCommand({
    label: "Chief of Staff: Connect Composio",
    callback: () => connectComposio(extensionAPI)
  });
  extensionAPI.ui.commandPalette.addCommand({
    label: "Chief of Staff: Disconnect Composio",
    callback: () => disconnectComposio()
  });
  extensionAPI.ui.commandPalette.addCommand({
    label: "Chief of Staff: Reconnect Composio",
    callback: () => reconnectComposio(extensionAPI)
  });
  extensionAPI.ui.commandPalette.addCommand({
    label: "Chief of Staff: Install Composio Tool",
    callback: () => promptInstallComposioTool(extensionAPI)
  });
  extensionAPI.ui.commandPalette.addCommand({
    label: "Chief of Staff: Deregister Composio Tool",
    callback: () => promptDeregisterComposioTool(extensionAPI)
  });
  extensionAPI.ui.commandPalette.addCommand({
    label: "Chief of Staff: Test Composio Tool Connection",
    callback: () => promptTestComposioTool(extensionAPI)
  });
  extensionAPI.ui.commandPalette.addCommand({
    label: "Chief of Staff: Refresh Tool Auth Status",
    callback: () => refreshToolAuthStatus(extensionAPI)
  });
  extensionAPI.ui.commandPalette.addCommand({
    label: "Chief of Staff: Show Stored Tool Config",
    callback: () => showStoredToolsConfig(extensionAPI)
  });
  extensionAPI.ui.commandPalette.addCommand({
    label: "Chief of Staff: Show Last Run Trace",
    callback: () => showLastRunTrace()
  });
  extensionAPI.ui.commandPalette.addCommand({
    label: "Chief of Staff: Debug Runtime Stats",
    callback: () => showRuntimeStats()
  });
  extensionAPI.ui.commandPalette.addCommand({
    label: "Chief of Staff: Reset Token Usage Stats",
    callback: () => {
      sessionTokenUsage.totalInputTokens = 0;
      sessionTokenUsage.totalOutputTokens = 0;
      sessionTokenUsage.totalRequests = 0;
      sessionTokenUsage.totalCostUsd = 0;
      showInfoToast("Stats reset", "Token usage counters cleared.");
      debugLog("[Chief of Staff] Token usage stats reset");
    }
  });
  extensionAPI.ui.commandPalette.addCommand({
    label: "Chief of Staff: Clear Conversation Context",
    callback: () => clearConversationContextWithToast()
  });
  extensionAPI.ui.commandPalette.addCommand({
    label: "Chief of Staff: Discover Toolkit Schemas",
    callback: async () => {
      showInfoToast("Discovering schemas", "Fetching schemas for all connected toolkits…");
      try {
        await discoverAllConnectedToolkitSchemas(extensionAPI, { force: true });
        const registry = getToolkitSchemaRegistry();
        const count = Object.keys(registry.toolkits || {}).length;
        const toolCount = Object.values(registry.toolkits || {})
          .reduce((sum, tk) => sum + Object.keys(tk.tools || {}).length, 0);
        showInfoToast("Schemas updated", `${count} toolkit(s), ${toolCount} tool(s) cached.`);
        debugLog("[Chief of Staff] Schema registry:", JSON.stringify(registry, null, 2));
      } catch (error) {
        showErrorToast("Discovery failed", error?.message || "Unknown error");
      }
    }
  });
  extensionAPI.ui.commandPalette.addCommand({
    label: "Chief of Staff: Show Schema Registry",
    callback: () => {
      const registry = getToolkitSchemaRegistry();
      const toolkits = Object.values(registry.toolkits || {});
      if (!toolkits.length) {
        showInfoToast("No schemas", "No toolkit schemas cached. Run 'Discover Toolkit Schemas' first.");
        return;
      }
      const summary = toolkits.map(tk => {
        const tools = Object.values(tk.tools || {});
        const withSchema = tools.filter(t => t.input_schema).length;
        const age = tk.discoveredAt ? Math.round((Date.now() - tk.discoveredAt) / 3600000) : "?";
        return `${tk.toolkit}: ${tools.length} tools (${withSchema} with schema), ${age}h ago`;
      }).join("\n");
      console.info("[Chief of Staff] Schema registry:\n", summary);
      console.info("[Chief of Staff] Full registry:", registry);
      showInfoToast("Schema registry", `${toolkits.length} toolkit(s). See console for details.`);
    }
  });

  commandPaletteRegistered = true;
}

function registerMemoryPullWatches() {
  const api = getRoamAlphaApi();
  if (!api?.data?.addPullWatch || !api?.data?.removePullWatch) {
    debugLog("[Chief flow] Pull watches: API not available, skipping.");
    return;
  }

  const allPages = [...getActiveMemoryPageTitles(), SKILLS_PAGE_TITLE];
  const pullPattern = "[:block/children :block/string {:block/children ...}]";
  const alreadyWatched = new Set(activePullWatches.map(w => w.pageTitle));
  let newCount = 0;

  for (const pageTitle of allPages) {
    if (alreadyWatched.has(pageTitle)) continue;

    const isSkills = pageTitle === SKILLS_PAGE_TITLE;
    const cacheType = isSkills ? "skills" : "memory";
    const entityId = `[:node/title "${escapeForDatalog(pageTitle)}"]`;

    const callback = function (_before, _after) {
      // Guard against firing during/after unload
      if (unloadInProgress) return;

      // Debounce: rapid edits only trigger one invalidation
      if (pullWatchDebounceTimers[cacheType]) {
        clearTimeout(pullWatchDebounceTimers[cacheType]);
      }
      pullWatchDebounceTimers[cacheType] = setTimeout(() => {
        // Check again in case unload happened during debounce
        if (unloadInProgress) {
          delete pullWatchDebounceTimers[cacheType];
          return;
        }
        delete pullWatchDebounceTimers[cacheType];
        if (isSkills) {
          debugLog("[Chief flow] Pull watch fired: invalidating skills cache for", pageTitle);
          invalidateSkillsPromptCache();
        } else {
          debugLog("[Chief flow] Pull watch fired: invalidating memory cache for", pageTitle);
          invalidateMemoryPromptCache();
        }
      }, 1500); // 1.5s debounce
    };

    try {
      api.data.addPullWatch(pullPattern, entityId, callback);
      activePullWatches.push({
        pullPattern,
        entityId,
        callback,
        pageTitle
      });
      newCount++;
      debugLog("[Chief flow] Pull watch registered:", pageTitle);
    } catch (error) {
      console.warn("[Chief of Staff] Failed to add pull watch for", pageTitle, error?.message || error);
    }
  }
  debugLog("[Chief flow] Pull watches: registered", newCount, "new,", activePullWatches.length, "total watchers");
}

function teardownPullWatches() {
  // Clear timers FIRST to prevent callbacks firing during teardown
  for (const key of Object.keys(pullWatchDebounceTimers)) {
    clearTimeout(pullWatchDebounceTimers[key]);
  }
  pullWatchDebounceTimers = {};

  // Then remove watches — use window.roamAlphaAPI directly (not getRoamAlphaApi())
  // because the throwing helper breaks unload if Roam tears down its API first.
  const api = window.roamAlphaAPI;
  for (const watch of activePullWatches) {
    try {
      if (api?.data?.removePullWatch) {
        api.data.removePullWatch(watch.pullPattern, watch.entityId, watch.callback);
      }
    } catch { /* ignore */ }
  }
  activePullWatches.length = 0;
  debugLog("[Chief flow] Pull watches: all removed");
}

function onload({ extensionAPI }) {
  if (extensionAPIRef !== null) return;
  unloadInProgress = false;
  debugLog("Chief of Staff loaded");
  removeOrphanChiefPanels();
  clearStartupAuthPollTimers();
  roamNativeToolsCache = null;
  invalidateMemoryPromptCache();
  invalidateSkillsPromptCache();
  extensionAPIRef = extensionAPI;
  setChiefNamespaceGlobals();
  loadConversationContext(extensionAPI);
  loadChatPanelHistory(extensionAPI);
  ensureToolsConfigState(extensionAPI);
  const state = getToolsConfigState(extensionAPI);
  state.installedTools
    .filter((tool) => tool.installState === "pending_auth")
    .forEach((tool, index) => {
      const delayMs = index * 2000;
      const timeoutId = window.setTimeout(() => {
        const timeoutIndex = startupAuthPollTimeoutIds.indexOf(timeoutId);
        if (timeoutIndex >= 0) startupAuthPollTimeoutIds.splice(timeoutIndex, 1);
        startToolAuthPolling(extensionAPI, tool.slug);
      }, delayMs);
      startupAuthPollTimeoutIds.push(timeoutId);
    });
  if (extensionAPI?.settings?.panel?.create) {
    extensionAPI.settings.panel.create(buildSettingsConfig(extensionAPI));
  }
  registerCommandPaletteCommands(extensionAPI);
  scheduleComposioAutoConnect(extensionAPI);
  // Register live watches on memory/skills pages for auto-invalidation
  try { registerMemoryPullWatches(); } catch (e) {
    console.warn("[Chief of Staff] Pull watch setup failed:", e?.message || e);
  }
  setupExtensionBroadcastListeners();
  // Restore chat panel if it was open before reload
  try {
    if (localStorage.getItem("chief-of-staff-panel-open") === "1") {
      setChatPanelOpen(true);
    }
  } catch { /* ignore */ }
}

function onunload() {
  if (extensionAPIRef === null) return;
  unloadInProgress = true;
  debugLog("Chief of Staff unloaded");
  teardownExtensionBroadcastListeners();
  // Abort any in-flight LLM requests immediately
  if (activeAgentAbortController) {
    activeAgentAbortController.abort();
    activeAgentAbortController = null;
  }
  const api = extensionAPIRef;
  extensionAPIRef = null;
  invalidateMemoryPromptCache();
  invalidateSkillsPromptCache();
  flushPersistChatPanelHistory(api);
  activeToastKeyboards.forEach((kb) => kb.detach());
  activeToastKeyboards.clear();
  destroyChatPanel();
  clearConversationContext();
  clearStartupAuthPollTimers();
  clearComposioAutoConnectTimer();
  clearAllAuthPolls();
  invalidateInstalledToolsFetchCache();
  roamNativeToolsCache = null;
  toolkitSchemaRegistryCache = null;
  if (connectInFlightPromise) {
    connectInFlightPromise.finally(() => {
      if (!unloadInProgress) return;
      disconnectComposio({ suppressDisconnectedToast: true });
    });
  } else {
    disconnectComposio({ suppressDisconnectedToast: true });
  }
  clearChiefNamespaceGlobals();
  teardownPullWatches();
  commandPaletteRegistered = false;
}

export default { onload, onunload };
