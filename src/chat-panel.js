/**
 * chat-panel.js — Chat panel UI and toast utilities.
 *
 * Extracted from index.js to reduce monolith size. All external
 * dependencies are injected via `initChatPanel(deps)` so this module
 * has zero direct imports from index.js (mirrors the onboarding pattern).
 */

import iziToast from "izitoast";

// ── Dependency injection ────────────────────────────────────────────
let deps = {};

export function initChatPanel(injected) {
  deps = injected;
}

// ── Constants (duplicated from index.js to keep module self-contained) ──
const CHIEF_PANEL_CLEANUP_REGISTRY_KEY = "__chiefOfStaffPanelCleanupRegistry";
const CHAT_PANEL_SELECTORS = {
  messages: "[data-chief-chat-messages]",
  input: "[data-chief-chat-input]",
  send: "[data-chief-chat-send]"
};
const MAX_CHAT_PANEL_MESSAGES = 80;
const CHAT_PANEL_STORAGE_KEY = "chief-of-staff-panel-geometry";

// ── Module-scoped state ─────────────────────────────────────────────
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
let chatInputHistoryIndex = -1;
let chatInputDraft = "";
const activeToastKeyboards = new Set();
let chatPanelPersistTimeoutId = null;
let chatThinkingTimerId = null;
let chatWorkingTimerId = null;

// ── Accessors (for index.js to read module-scoped state) ────────────
export function getChatPanelIsOpen() { return chatPanelIsOpen; }
export function getChatPanelContainer() { return chatPanelContainer; }
export function getChatPanelMessages() { return chatPanelMessages; }
export function getChatPanelIsSending() { return chatPanelIsSending; }

// ── Theme detection & observer ──────────────────────────────────────
// Adapts to Blueprint (.bp3-dark), Roam Studio (data-theme="dark"),
// third-party themes, and system preference. Samples Roam's computed
// styles and sets --cos-* custom properties on the panel element.

let cosThemeObserver = null;
let cosThemeSyncTimer = null;
let cosThemeVerifyTimer = null;
let cosThemeMediaHandler = null;
let cosThemeToggleHandler = null;
let cosLastThemeDark = null;

function isDarkMode() {
  const body = document.body;
  const root = document.documentElement;
  return (
    body?.classList.contains("bp3-dark") ||
    root?.classList.contains("bp3-dark") ||
    body?.dataset.theme === "dark" ||
    root?.dataset.theme === "dark"
  );
}

function getToastTheme() {
  return isDarkMode() ? "dark" : "light";
}

// Parse any CSS colour to {r,g,b} or null
function parseColorToRgb(value) {
  if (!value || typeof value !== "string") return null;
  const str = value.trim();
  if (str.startsWith("#")) {
    let hex = str.slice(1);
    if (hex.length === 3) hex = hex.split("").map(c => c + c).join("");
    if (hex.length === 6) {
      const n = parseInt(hex, 16);
      if (Number.isNaN(n)) return null;
      return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
    }
    return null;
  }
  const m = str.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  return m ? { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]) } : null;
}

// Relative luminance (0 = black, 1 = white)
function computeLuminance(rgb) {
  if (!rgb) return 0.5;
  const f = c => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(rgb.r) + 0.7152 * f(rgb.g) + 0.0722 * f(rgb.b);
}

// Sample background colour from Roam's layout elements
function sampleRoamBackground() {
  const selectors = [
    ".roam-main",
    ".roam-body-main",
    ".roam-body .bp3-card",
    ".rm-all-pages",
    ".roam-article",
    ".roam-body",
    "#app > div",
    "#app",
  ];
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (!el) continue;
    const bg = window.getComputedStyle(el).backgroundColor;
    if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
  }
  return null;
}

// Pick first non-empty/non-inherit CSS value, or the default
function pickCssValue(fallback, ...candidates) {
  for (const c of candidates) {
    if (!c) continue;
    const v = (typeof c === "string" ? c : String(c)).trim();
    if (v && v !== "initial" && v !== "inherit" && v !== "unset") return v;
  }
  return fallback;
}

/**
 * Sync theme by sampling Roam's computed styles and setting --cos-* on the panel.
 * Called on panel open and whenever the theme changes.
 */
export function syncCosTheme() {
  const panel = chatPanelContainer;
  if (!panel) return;

  const markerDark = isDarkMode();
  const systemDark = window.matchMedia?.("(prefers-color-scheme: dark)")?.matches;

  const computed = window.getComputedStyle(document.body);
  const layoutBg = sampleRoamBackground();

  // Luminance-based fallback: sample the actual rendered background.
  // Handles Roam Studio themes that apply dark colours without setting
  // .bp3-dark or data-theme="dark".
  const layoutBgRgb = parseColorToRgb(layoutBg);
  const layoutLum = layoutBgRgb ? computeLuminance(layoutBgRgb) : null;
  const luminanceDark = layoutLum !== null ? layoutLum < 0.4 : false;

  // When layoutBg is null (elements not found or transparent during CSS
  // transitions), we have no luminance signal.  In that case, preserve the
  // last known theme state rather than defaulting to light — this prevents
  // the panel from flickering light→dark→light during animated transitions.
  const hasLuminanceSignal = layoutLum !== null;
  let finalDark;
  if (markerDark || systemDark) {
    finalDark = true;
  } else if (hasLuminanceSignal) {
    finalDark = luminanceDark;
  } else if (cosLastThemeDark !== null) {
    finalDark = cosLastThemeDark;
  } else {
    finalDark = false;
  }

  // Skip if nothing changed
  if (finalDark === cosLastThemeDark) return;
  cosLastThemeDark = finalDark;

  // Detect whether Roam is using Blueprint or Roam Studio for fallback colours
  const isBlueprint = !!document.querySelector(".blueprint-dm-toggle");

  // Sample key colours from Roam's CSS variables.
  // When luminance-based detection fires (custom theme dark, no markers),
  // prefer the actual layout background over the CSS variable which can be stale.
  const roamBg = luminanceDark && !markerDark
    ? pickCssValue(null, layoutBg, computed.getPropertyValue("--background-color"), computed.backgroundColor)
    : pickCssValue(null, computed.getPropertyValue("--background-color"), layoutBg, computed.backgroundColor);

  const roamText = pickCssValue(
    null,
    computed.getPropertyValue("--bp3-text-color"),
    computed.color
  );

  const roamBorder = pickCssValue(
    null,
    computed.getPropertyValue("--bp3-border-color"),
    computed.getPropertyValue("--border-color")
  );

  if (finalDark) {
    // --- Dark mode: derive panel colours from sampled Roam background ---
    const darkFallbackBg = isBlueprint ? "#202B33" : "#1e293b";
    let panelBg = roamBg || darkFallbackBg;
    const bgRgb = parseColorToRgb(panelBg);
    const luminance = bgRgb ? computeLuminance(bgRgb) : null;

    // Clamp overly-light backgrounds in dark mode
    if (bgRgb && luminance > 0.5) panelBg = darkFallbackBg;

    // Ensure text has sufficient contrast against panel background.
    // Some custom themes have muted text colours that work on the page
    // but become unreadable on the panel's darker surface.
    const highContrastFallback = isBlueprint ? "#F5F8FA" : "#e2e8f0";
    let textColor = roamText || highContrastFallback;
    const textRgb = parseColorToRgb(textColor);
    const textLum = textRgb ? computeLuminance(textRgb) : null;
    const bgLum = bgRgb ? computeLuminance(parseColorToRgb(panelBg) || bgRgb) : null;
    if (textLum !== null && bgLum !== null) {
      // WCAG contrast ratio: (L1 + 0.05) / (L2 + 0.05) where L1 > L2
      const hi = Math.max(textLum, bgLum);
      const lo = Math.min(textLum, bgLum);
      const contrast = (hi + 0.05) / (lo + 0.05);
      if (contrast < 3.5) textColor = highContrastFallback;
    }
    const borderColor = roamBorder || (isBlueprint ? "rgba(255,255,255,0.24)" : "rgba(148,163,184,0.25)");

    panel.style.setProperty("--cos-panel-bg", panelBg);
    panel.style.setProperty("--cos-panel-text", textColor);
    panel.style.setProperty("--cos-border", borderColor);
    panel.style.setProperty("--cos-border-subtle", borderColor);
    panel.style.setProperty("--cos-muted", isBlueprint ? "rgba(255,255,255,0.65)" : "rgba(148,163,184,0.6)");
    panel.style.setProperty("--cos-input-bg", "rgba(0,0,0,0.2)");
    panel.style.setProperty("--cos-code-bg", "rgba(0,0,0,0.25)");
    panel.style.setProperty("--cos-code-text", "#cbd5e1");
    panel.style.setProperty("--cos-shadow", "rgba(0,0,0,0.4)");
    panel.style.setProperty("--cos-tool-preview-bg", "rgba(0,0,0,0.2)");
    panel.style.setProperty("--cos-toast-input-border", borderColor);
  } else {
    // --- Light mode: clear all inline overrides, let CSS defaults apply ---
    const vars = [
      "--cos-panel-bg", "--cos-panel-text", "--cos-border", "--cos-border-subtle",
      "--cos-muted", "--cos-input-bg", "--cos-code-bg", "--cos-code-text",
      "--cos-shadow", "--cos-tool-preview-bg", "--cos-toast-input-border"
    ];
    for (const v of vars) panel.style.removeProperty(v);
  }
}

function triggerCosThemeResync(delay = 0) {
  if (cosThemeSyncTimer) clearTimeout(cosThemeSyncTimer);
  if (cosThemeVerifyTimer) clearTimeout(cosThemeVerifyTimer);
  cosThemeSyncTimer = setTimeout(() => {
    cosLastThemeDark = null;
    syncCosTheme();
    cosThemeSyncTimer = null;
    // Verification re-sample after CSS transitions settle (Roam Studio ~2-4s)
    cosThemeVerifyTimer = setTimeout(() => {
      cosLastThemeDark = null;
      syncCosTheme();
      // Third pass for very slow Roam Studio transitions
      cosThemeVerifyTimer = setTimeout(() => {
        cosLastThemeDark = null;
        syncCosTheme();
        cosThemeVerifyTimer = null;
      }, 1500);
    }, 1500);
  }, Math.max(800, delay));
}

/**
 * Start observing theme changes. Call once after panel is created.
 */
export function observeCosThemeChanges() {
  syncCosTheme();

  // MutationObserver on body/html for class and data-theme changes.
  // Head stylesheet mutations are throttled more aggressively because Roam
  // Studio themes fire dozens of mutations during animated transitions.
  if (!cosThemeObserver) {
    let headMutationTimer = null;
    const cb = (mutations) => {
      const isBodyOrHtml = mutations.some(m =>
        m.target === document.body || m.target === document.documentElement
      );
      if (isBodyOrHtml) {
        // Class or data-theme change on body/html → high confidence signal
        triggerCosThemeResync(800);
      } else {
        // Head/stylesheet change → likely animated transition.  Use a longer
        // debounce and don't interrupt an already-scheduled resync.
        if (!cosThemeSyncTimer && !headMutationTimer) {
          headMutationTimer = setTimeout(() => {
            headMutationTimer = null;
            triggerCosThemeResync(1200);
          }, 2000);
        }
      }
    };
    cosThemeObserver = new MutationObserver(cb);
    try {
      const targets = [document.body, document.documentElement, document.head].filter(Boolean);
      for (const target of targets) {
        const opts = target === document.head
          ? { childList: true, subtree: true, attributes: true, attributeFilter: ["href", "data-theme"] }
          : { attributes: true, attributeFilter: ["class", "data-theme"], subtree: false };
        cosThemeObserver.observe(target, opts);
      }
    } catch (err) {
      console.warn("[COS theme] MutationObserver setup error:", err);
      cosThemeObserver = null;
    }
  } else {
    // observer already exists, skip setup
  }

  // prefers-color-scheme media query
  if (!cosThemeMediaHandler && window.matchMedia) {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    cosThemeMediaHandler = () => triggerCosThemeResync(0);
    mq.addEventListener?.("change", cosThemeMediaHandler);
  }

  // Listen for clicks on Roam Studio / Blueprint dark-mode toggle buttons
  if (!cosThemeToggleHandler) {
    cosThemeToggleHandler = (e) => {
      if (e.target.closest(".roamstudio-dm-toggle, .blueprint-dm-toggle")) {
        triggerCosThemeResync(2000); // Roam Studio transitions take 2-4s to settle
      }
    };
    document.body?.addEventListener("click", cosThemeToggleHandler, true);
  }
}

/**
 * Stop observing theme changes. Call on panel teardown.
 */
export function teardownCosThemeObserver() {
  if (cosThemeObserver) { cosThemeObserver.disconnect(); cosThemeObserver = null; }
  if (cosThemeSyncTimer) { clearTimeout(cosThemeSyncTimer); cosThemeSyncTimer = null; }
  if (cosThemeVerifyTimer) { clearTimeout(cosThemeVerifyTimer); cosThemeVerifyTimer = null; }
  if (cosThemeMediaHandler && window.matchMedia) {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.removeEventListener?.("change", cosThemeMediaHandler);
    cosThemeMediaHandler = null;
  }
  if (cosThemeToggleHandler) {
    document.body?.removeEventListener("click", cosThemeToggleHandler, true);
    cosThemeToggleHandler = null;
  }
  cosLastThemeDark = null;
}

// ── Toast wrappers ──────────────────────────────────────────────────
export function showConnectedToast() {
  if (!iziToast?.success) return;
  const assistantName = deps.escapeHtml(deps.getAssistantDisplayName());
  iziToast.success({
    title: "Connected",
    message: assistantName + " connected to Composio.",
    position: "topRight",
    timeout: 2500,
    theme: getToastTheme()
  });
}

export function showDisconnectedToast() {
  if (!iziToast?.success) return;
  const assistantName = deps.escapeHtml(deps.getAssistantDisplayName());
  iziToast.success({
    title: "Disconnected",
    message: assistantName + " disconnected from Composio.",
    position: "topRight",
    timeout: 2500,
    theme: getToastTheme()
  });
}

export function showReconnectedToast() {
  if (!iziToast?.success) return;
  const assistantName = deps.escapeHtml(deps.getAssistantDisplayName());
  iziToast.success({
    title: "Reconnected",
    message: assistantName + " reconnected to Composio.",
    position: "topRight",
    timeout: 2500,
    theme: getToastTheme()
  });
}

export function showInfoToast(title, message) {
  if (!iziToast?.info) return;
  iziToast.info({
    title: deps.escapeHtml(title),
    message: deps.escapeHtml(message),
    position: "topRight",
    timeout: 4500,
    theme: getToastTheme()
  });
}

export function showErrorToast(title, message) {
  if (!iziToast?.error) return;
  iziToast.error({
    title: deps.escapeHtml(title),
    message: deps.escapeHtml(message),
    position: "topRight",
    timeout: 3500,
    theme: getToastTheme()
  });
}

export function showInfoToastIfAllowed(title, message, suppressToasts = false) {
  if (suppressToasts) return;
  showInfoToast(title, message);
}

export function showErrorToastIfAllowed(title, message, suppressToasts = false) {
  if (suppressToasts) return;
  showErrorToast(title, message);
}

// ── Panel cleanup registry ──────────────────────────────────────────
function getChiefPanelCleanupRegistry() {
  if (typeof window === "undefined") return {};
  const existing = window[CHIEF_PANEL_CLEANUP_REGISTRY_KEY];
  if (existing && typeof existing === "object") return existing;
  const created = {};
  window[CHIEF_PANEL_CLEANUP_REGISTRY_KEY] = created;
  return created;
}

function registerChiefPanelCleanup(panelEl, cleanupFn) {
  if (!panelEl || typeof cleanupFn !== "function") return;
  const panelId = String(panelEl.getAttribute("data-chief-panel-id") || "").trim();
  if (!panelId) return;
  const registry = getChiefPanelCleanupRegistry();
  registry[panelId] = cleanupFn;
}

function unregisterChiefPanelCleanup(panelEl) {
  if (!panelEl) return;
  const panelId = String(panelEl.getAttribute("data-chief-panel-id") || "").trim();
  if (!panelId) return;
  const registry = getChiefPanelCleanupRegistry();
  delete registry[panelId];
}

function invokeAndUnregisterChiefPanelCleanup(panelEl) {
  if (!panelEl) return;
  const panelId = String(panelEl.getAttribute("data-chief-panel-id") || "").trim();
  if (!panelId) return;
  const registry = getChiefPanelCleanupRegistry();
  const cleanupFn = registry[panelId];
  if (typeof cleanupFn === "function") {
    try { cleanupFn(); } catch { /* ignore */ }
  }
  delete registry[panelId];
}

export function removeOrphanChiefPanels() {
  if (!document?.querySelectorAll) return;
  const panels = Array.from(document.querySelectorAll("[data-chief-chat-panel='true']"));
  panels.forEach((panel) => {
    if (panel === chatPanelContainer) return;
    invokeAndUnregisterChiefPanelCleanup(panel);
    panel.remove();
  });
}

// ── Chat panel message / history ────────────────────────────────────
export function refreshChatPanelElementRefs() {
  if (!chatPanelContainer) return;
  chatPanelMessages = chatPanelContainer.querySelector(CHAT_PANEL_SELECTORS.messages);
  chatPanelInput = chatPanelContainer.querySelector(CHAT_PANEL_SELECTORS.input);
  chatPanelSendButton = chatPanelContainer.querySelector(CHAT_PANEL_SELECTORS.send);
}

function hasValidChatPanelElementRefs() {
  return Boolean(chatPanelMessages && chatPanelInput && chatPanelSendButton);
}

export function createChatPanelMessageElement(role, text, { variant } = {}) {
  const item = document.createElement("div");
  item.classList.add("chief-msg", role === "user" ? "chief-msg--user" : "chief-msg--assistant");
  if (variant === "scheduled") item.classList.add("chief-msg--scheduled");
  item.innerHTML = deps.renderMarkdownToSafeHtml(text);
  deps.sanitizeChatDom(item);
  return item;
}

export function appendChatPanelMessage(role, text) {
  refreshChatPanelElementRefs();
  if (!chatPanelMessages) return;
  const item = createChatPanelMessageElement(role, text);
  chatPanelMessages.appendChild(item);
  chatPanelMessages.scrollTop = chatPanelMessages.scrollHeight;
  return item;
}

/**
 * Extract a short human-friendly label from a full model ID string.
 * e.g. "claude-haiku-4-5-20251001" → "haiku", "gemini-2.5-flash-lite" → "flash-lite"
 */
function shortModelLabel(modelId) {
  if (!modelId || typeof modelId !== "string") return "";
  const id = modelId.toLowerCase();
  // Anthropic
  if (id.includes("opus"))   return "opus";
  if (id.includes("sonnet")) return "sonnet";
  if (id.includes("haiku"))  return "haiku";
  // Gemini — check flash-lite before flash
  if (id.includes("flash-lite")) return "flash-lite";
  if (id.includes("flash"))      return "flash";
  // OpenAI
  if (id.includes("gpt-5-mini")) return "gpt-5-mini";
  if (id.includes("gpt-5.2"))    return "gpt-5.2";
  if (id.includes("gpt-4.1"))    return "gpt-4.1";
  // Mistral
  if (id.includes("mistral-small"))  return "mistral-small";
  if (id.includes("mistral-medium")) return "mistral-medium";
  if (id.includes("mistral-large"))  return "mistral-large";
  // Fallback: return raw ID
  return modelId;
}

/**
 * Get or create the footer row at the bottom of an assistant message.
 * Houses the model label (left) and save button (right) on the same line.
 */
function getOrCreateMessageFooter(messageEl) {
  let footer = messageEl.querySelector(".chief-msg-footer");
  if (!footer) {
    footer = document.createElement("div");
    footer.className = "chief-msg-footer";
    messageEl.appendChild(footer);
  }
  return footer;
}

/**
 * Append a small model-name indicator to an assistant message element.
 * Shows on hover using the same pattern as the save button.
 */
export function addModelIndicator(messageEl, modelId) {
  if (!messageEl || !modelId) return;
  const label = shortModelLabel(modelId);
  if (!label) return;
  const footer = getOrCreateMessageFooter(messageEl);
  const span = document.createElement("span");
  span.className = "chief-msg-model";
  span.textContent = label;
  span.title = modelId;
  footer.appendChild(span);
}

export function addSaveToDailyPageButton(messageEl, promptText, responseText) {
  if (!messageEl) return;
  const footer = getOrCreateMessageFooter(messageEl);
  const btn = document.createElement("button");
  btn.className = "chief-msg-save-btn";
  btn.title = "Save to today's daily page";
  btn.textContent = "\u{1F4CC}";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.textContent = "\u23F3";
    try {
      const writeResult = await deps.writeResponseToTodayDailyPage(promptText, responseText);
      btn.textContent = "\u2713";
      btn.classList.add("chief-msg-save-btn--done");
      showInfoToast("Saved to Roam", "Added under " + writeResult.pageTitle + ".");
    } catch (error) {
      btn.textContent = "\u{1F4CC}";
      btn.disabled = false;
      showErrorToast("Write failed", error?.message || "Could not write to daily page.");
    }
  });
  footer.appendChild(btn);
}

function normaliseChatPanelMessage(input) {
  const role = String(input?.role || "").toLowerCase() === "user" ? "user" : "assistant";
  const text = String(input?.text || "").trim();
  if (!text) return null;
  return {
    role,
    text: deps.truncateForContext(text, 2000),
    createdAt: Number.isFinite(input?.createdAt) ? input.createdAt : Date.now()
  };
}

function persistChatPanelHistory() {
  const extensionAPI = deps.getExtensionAPIRef();
  extensionAPI?.settings?.set?.(deps.SETTINGS_KEYS.chatPanelHistory, chatPanelHistory);
}

export function loadChatPanelHistory() {
  const extensionAPI = deps.getExtensionAPIRef();
  const raw = deps.getSettingArray(extensionAPI, deps.SETTINGS_KEYS.chatPanelHistory, []);
  const normalised = raw
    .map(normaliseChatPanelMessage)
    .filter(Boolean);
  chatPanelHistory = normalised.slice(normalised.length - MAX_CHAT_PANEL_MESSAGES);
}

export function appendChatPanelHistory(role, text) {
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
    persistChatPanelHistory();
  }, 5000);
}

export function flushPersistChatPanelHistory() {
  if (chatPanelPersistTimeoutId) {
    window.clearTimeout(chatPanelPersistTimeoutId);
    chatPanelPersistTimeoutId = null;
  }
  persistChatPanelHistory();
}

export function clearChatPanelHistory() {
  chatPanelHistory = [];
  flushPersistChatPanelHistory();
  if (chatPanelMessages) chatPanelMessages.textContent = "";
}

// ── Sending state & cost indicator ──────────────────────────────────
export function setChatPanelSendingState(isSending) {
  refreshChatPanelElementRefs();
  chatPanelIsSending = Boolean(isSending);
  if (chatPanelInput) chatPanelInput.disabled = chatPanelIsSending;
  if (chatPanelSendButton) {
    chatPanelSendButton.disabled = chatPanelIsSending;
    chatPanelSendButton.textContent = chatPanelIsSending ? "Thinking..." : "Send";
  }
}

function formatCostUsd(usd) {
  const cents = usd * 100;
  if (cents < 0.01) return "";
  return cents < 1
    ? cents.toFixed(2) + "\u00A2"
    : "$" + usd.toFixed(2);
}

export function updateChatPanelCostIndicator() {
  const el = document.querySelector("[data-chief-chat-cost]");
  if (!el) return;
  const session = deps.getSessionTokenUsage();
  const label = formatCostUsd(session.totalCostUsd);
  el.textContent = label;
  if (!label) {
    el.classList.remove("chief-cost-has-value");
  } else {
    el.classList.add("chief-cost-has-value");
  }
}

function buildCostTooltipContent() {
  const session = deps.getSessionTokenUsage();
  const summary = deps.getCostHistorySummary ? deps.getCostHistorySummary() : null;
  const fmt = (usd) => {
    if (usd < 0.0001) return "0¢";
    const cents = usd * 100;
    return cents < 1 ? cents.toFixed(2) + "¢" : "$" + usd.toFixed(2);
  };
  const tokFmt = (n) => n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);

  let html = `<div class="chief-cost-section">`;
  html += `<div class="chief-cost-heading">Session</div>`;
  html += `<div class="chief-cost-row"><span>Cost</span><span>${deps.escapeHtml(fmt(session.totalCostUsd))}</span></div>`;
  html += `<div class="chief-cost-row"><span>Input tokens</span><span>${tokFmt(session.totalInputTokens)}</span></div>`;
  html += `<div class="chief-cost-row"><span>Output tokens</span><span>${tokFmt(session.totalOutputTokens)}</span></div>`;
  html += `<div class="chief-cost-row"><span>Requests</span><span>${session.totalRequests}</span></div>`;
  html += `</div>`;

  if (summary) {
    html += `<div class="chief-cost-divider"></div>`;
    html += `<div class="chief-cost-section">`;
    html += `<div class="chief-cost-heading">Today</div>`;
    html += `<div class="chief-cost-row"><span>Cost</span><span>${deps.escapeHtml(fmt(summary.today.cost))}</span></div>`;
    html += `<div class="chief-cost-row"><span>Tokens</span><span>${tokFmt(summary.today.input + summary.today.output)}</span></div>`;
    html += `<div class="chief-cost-row"><span>Requests</span><span>${summary.today.requests}</span></div>`;

    if (summary.today.models && Object.keys(summary.today.models).length > 1) {
      for (const [m, d] of Object.entries(summary.today.models)) {
        const shortName = m.replace(/^claude-/, "").replace(/-20\d{6}$/, "").replace(/^gemini-/, "").replace(/-latest$/, "").replace(/-preview.*$/, "");
        html += `<div class="chief-cost-row chief-cost-model"><span>${deps.escapeHtml(shortName)}</span><span>${deps.escapeHtml(fmt(d.cost))}</span></div>`;
      }
    }
    html += `</div>`;

    html += `<div class="chief-cost-divider"></div>`;
    html += `<div class="chief-cost-section">`;
    html += `<div class="chief-cost-row"><span>7 days</span><span>${deps.escapeHtml(fmt(summary.week.cost))}</span></div>`;
    html += `<div class="chief-cost-row"><span>30 days</span><span>${deps.escapeHtml(fmt(summary.month.cost))}</span></div>`;
    html += `</div>`;
  }

  return html;
}

function toggleCostTooltip(anchorEl) {
  const existing = document.querySelector(".chief-cost-tooltip");
  if (existing) {
    existing.remove();
    return;
  }

  const tooltip = document.createElement("div");
  tooltip.className = "chief-cost-tooltip";
  tooltip.innerHTML = buildCostTooltipContent();

  // Position relative to anchor
  const rect = anchorEl.getBoundingClientRect();
  tooltip.style.position = "fixed";
  tooltip.style.top = (rect.bottom + 4) + "px";
  tooltip.style.left = rect.left + "px";
  tooltip.style.zIndex = "10001";

  document.body.appendChild(tooltip);

  // Close on click outside
  const closeHandler = (e) => {
    if (!tooltip.contains(e.target) && e.target !== anchorEl) {
      tooltip.remove();
      document.removeEventListener("mousedown", closeHandler);
    }
  };
  window.setTimeout(() => document.addEventListener("mousedown", closeHandler), 0);
}

// ── Chat panel send handler ─────────────────────────────────────────
async function handleChatPanelSend() {
  refreshChatPanelElementRefs();
  if (chatPanelIsSending || !chatPanelInput) return;

  // If a background agent run is active (e.g. inbox processing on startup),
  // abort it so the user's chat message gets priority.
  const existingController = deps.getActiveAgentAbortController();
  if (existingController) {
    deps.debugLog("[Chief chat] Aborting background agent run to prioritise chat send");
    existingController.abort();
    // Wait up to 2s for the agent loop finally-block to null the controller
    for (let i = 0; i < 20 && deps.getActiveAgentAbortController(); i++) {
      await new Promise(r => setTimeout(r, 100));
    }
    if (deps.getActiveAgentAbortController()) {
      appendChatPanelMessage("assistant", "A background task is still running — please try again in a moment.");
      return;
    }
  }

  const message = String(chatPanelInput.value || "").trim();
  if (!message) return;

  if (/^\/clear$/i.test(message)) {
    chatPanelInput.value = "";
    clearChatPanelHistory();
    appendChatPanelMessage("assistant", "History cleared. Ask me anything and I'll continue from fresh chat history.");
    return;
  }

  appendChatPanelMessage("user", message);
  appendChatPanelHistory("user", message);
  chatPanelInput.value = "";
  chatInputHistoryIndex = -1;
  chatInputDraft = "";
  setChatPanelSendingState(true);

  let streamingEl = null;
  const streamChunks = [];
  let streamRenderPending = false;

  function ensureStreamingEl() {
    if (streamingEl) return;
    refreshChatPanelElementRefs();
    if (!chatPanelMessages) return;
    streamingEl = document.createElement("div");
    streamingEl.classList.add("chief-msg", "chief-msg--assistant");
    streamingEl.textContent = "";
    chatPanelMessages.appendChild(streamingEl);
  }

  function flushStreamRender() {
    streamRenderPending = false;
    if (!streamingEl || !document.body.contains(streamingEl)) return;
    const joined = streamChunks.join("").replace(/\[Key reference:[^\]]*\]\s*/g, "");
    const capped = joined.length > 60000 ? joined.slice(joined.length - 60000) : joined;
    streamingEl.innerHTML = deps.renderMarkdownToSafeHtml(capped);
    if (chatPanelMessages) chatPanelMessages.scrollTop = chatPanelMessages.scrollHeight;
  }

  ensureStreamingEl();
  if (streamingEl) {
    streamingEl.innerHTML = '<span class="chief-msg-thinking">Thinking</span>';
    if (chatPanelMessages) chatPanelMessages.scrollTop = chatPanelMessages.scrollHeight;
  }

  chatThinkingTimerId = setTimeout(() => {
    if (streamingEl && streamChunks.length === 0 && document.body.contains(streamingEl)) {
      streamingEl.innerHTML = '<span class="chief-msg-thinking">Still thinking</span>';
    }
  }, 5000);
  chatWorkingTimerId = setTimeout(() => {
    if (streamingEl && streamChunks.length === 0 && document.body.contains(streamingEl)) {
      streamingEl.innerHTML = '<span class="chief-msg-thinking">Still working</span>';
    }
  }, 15000);

  try {
    const result = await deps.askChiefOfStaff(message, {
      suppressToasts: true,
      onTextChunk: (chunk) => {
        clearTimeout(chatThinkingTimerId);
        clearTimeout(chatWorkingTimerId);
        if (chatPanelSendButton && chatPanelSendButton.textContent !== "Generating response...") {
          chatPanelSendButton.textContent = "Generating response...";
        }
        ensureStreamingEl();
        streamChunks.push(chunk);
        if (!streamRenderPending) {
          streamRenderPending = true;
          requestAnimationFrame(flushStreamRender);
        }
      }
    });
    const responseText = String(result?.text || "").trim().replace(/\[Key reference:[^\]]*\]\s*/g, "").trim() || "No response generated.";

    if (streamingEl && document.body.contains(streamingEl)) {
      // Safe: renderMarkdownToSafeHtml escapes all input; sanitizeChatDom strips unsafe attrs
      streamingEl.innerHTML = deps.renderMarkdownToSafeHtml(responseText);
      deps.sanitizeChatDom(streamingEl);
      const trace = typeof deps.getLastAgentRunTrace === "function" ? deps.getLastAgentRunTrace() : null;
      addModelIndicator(streamingEl, trace?.model);
      addSaveToDailyPageButton(streamingEl, message, responseText);
    }
    streamingEl = null;
    appendChatPanelHistory("assistant", responseText);
    updateChatPanelCostIndicator();
  } catch (error) {
    const errorText = deps.getUserFacingLlmErrorMessage(error, "Chat");
    if (streamingEl && document.body.contains(streamingEl)) {
      streamingEl.innerHTML = deps.renderMarkdownToSafeHtml("Error: " + errorText);
      deps.sanitizeChatDom(streamingEl);
    }
    streamingEl = null;
    appendChatPanelHistory("assistant", "Error: " + errorText);
    showErrorToastIfAllowed("Chat failed", errorText, true);
    updateChatPanelCostIndicator(); // reflect costs accrued before failure
  } finally {
    clearTimeout(chatThinkingTimerId);
    clearTimeout(chatWorkingTimerId);
    setChatPanelSendingState(false);
    if (chatPanelInput) chatPanelInput.focus();
  }
}

// ── Geometry persistence ────────────────────────────────────────────
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
  panelEl.style.width = w + "px";
  panelEl.style.height = h + "px";
  panelEl.style.left = l + "px";
  panelEl.style.top = t + "px";
  panelEl.style.right = "auto";
  panelEl.style.bottom = "auto";
}

function clampChatPanelToViewport(panelEl) {
  if (!panelEl) return;
  const rect = panelEl.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = rect.width || 360;
  const h = rect.height || 520;
  let changed = false;
  if (rect.left < 0 || rect.left > vw - Math.min(w, 40)) {
    panelEl.style.left = Math.max(0, Math.min(vw - w, vw - 40)) + "px";
    panelEl.style.right = "auto";
    changed = true;
  }
  if (rect.top < 0 || rect.top > vh - Math.min(h, 40)) {
    panelEl.style.top = Math.max(0, Math.min(vh - h, vh - 40)) + "px";
    panelEl.style.bottom = "auto";
    changed = true;
  }
  if (changed) saveChatPanelGeometry(panelEl);
}

// ── Drag & resize behaviour ─────────────────────────────────────────
function installChatPanelDragBehavior(handleEl, panelEl) {
  let dragRafId = null;
  const onDragMove = (event) => {
    if (!chatPanelDragState || !document.body.contains(panelEl)) return;
    if (dragRafId) return;
    const cx = event.clientX;
    const cy = event.clientY;
    dragRafId = requestAnimationFrame(() => {
      dragRafId = null;
      if (!chatPanelDragState) return;
      panelEl.style.left = Math.max(0, cx - chatPanelDragState.offsetX) + "px";
      panelEl.style.top = Math.max(0, cy - chatPanelDragState.offsetY) + "px";
      panelEl.style.right = "auto";
      panelEl.style.bottom = "auto";
    });
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

  const GRIP = 6;
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
    if (resizeState) return;
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

  let resizeRafId = null;
  const onResizeMove = (event) => {
    if (!resizeState || !document.body.contains(panelEl)) return;
    if (resizeRafId) return;
    const cx = event.clientX;
    const cy = event.clientY;
    resizeRafId = requestAnimationFrame(() => {
      resizeRafId = null;
      if (!resizeState) return;
      const { edge, startX, startY, startLeft, startTop, startWidth, startHeight } = resizeState;
      const dx = cx - startX;
      const dy = cy - startY;
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
      panelEl.style.left = Math.max(0, newLeft) + "px";
      panelEl.style.top = Math.max(0, newTop) + "px";
      panelEl.style.width = newWidth + "px";
      panelEl.style.height = newHeight + "px";
      panelEl.style.right = "auto";
      panelEl.style.bottom = "auto";
    });
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
    if (dragRafId) { cancelAnimationFrame(dragRafId); dragRafId = null; }
    if (resizeRafId) { cancelAnimationFrame(resizeRafId); resizeRafId = null; }
    handleEl.removeEventListener("mousedown", onDragDown);
    panelEl.removeEventListener("mousemove", onPanelMouseMove);
    panelEl.removeEventListener("mousedown", onPanelMouseDown);
    window.removeEventListener("mousemove", onDragMove);
    window.removeEventListener("mouseup", onDragUp);
    window.removeEventListener("mousemove", onResizeMove);
    window.removeEventListener("mouseup", onResizeUp);
  };
}

// ── ensureChatPanel ─────────────────────────────────────────────────
export function ensureChatPanel() {
  const assistantName = deps.getAssistantDisplayName();
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
  container.setAttribute("data-chief-panel-id", Date.now() + "-" + Math.random().toString(36).slice(2, 9));

  applyChatPanelGeometry(container);

  const header = document.createElement("div");
  header.classList.add("chief-panel-header");

  const title = document.createElement("div");
  title.textContent = assistantName;
  title.classList.add("chief-panel-title");

  const costIndicator = document.createElement("span");
  costIndicator.setAttribute("data-chief-chat-cost", "true");
  costIndicator.className = "chief-cost-badge";
  costIndicator.textContent = "";
  costIndicator.title = "Click for cost breakdown";
  costIndicator.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleCostTooltip(costIndicator);
  });
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
      "History cleared. Ask me anything and I'll continue from fresh chat history."
    );
  };
  headerButtons.appendChild(clearButton);

  const closeButton = document.createElement("button");
  closeButton.textContent = "\u00D7";
  closeButton.classList.add("chief-panel-btn", "chief-panel-btn--close");
  closeButton.onclick = () => {
    setChatPanelOpen(false);
  };
  headerButtons.appendChild(closeButton);

  header.appendChild(headerButtons);

  const messages = document.createElement("div");
  messages.setAttribute("data-chief-chat-messages", "true");

  const composer = document.createElement("div");
  composer.classList.add("chief-panel-composer");

  const input = document.createElement("textarea");
  input.setAttribute("data-chief-chat-input", "true");
  input.placeholder = "Ask " + assistantName + "...";
  input.rows = 2;
  const inputKeydownHandler = (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      chatInputHistoryIndex = -1;
      chatInputDraft = "";
      handleChatPanelSend();
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      const userMessages = chatPanelHistory.filter(m => m.role === "user").map(m => m.text);
      if (!userMessages.length) return;
      if (event.key === "ArrowUp" && chatInputHistoryIndex === -1) {
        const el = event.target;
        if (el.selectionStart !== 0 || el.selectionStart !== el.selectionEnd) return;
      }
      if (event.key === "ArrowUp") {
        if (chatInputHistoryIndex === -1) {
          chatInputDraft = input.value || "";
          chatInputHistoryIndex = 0;
        } else if (chatInputHistoryIndex < userMessages.length - 1) {
          chatInputHistoryIndex += 1;
        } else {
          return;
        }
      } else {
        if (chatInputHistoryIndex <= -1) return;
        chatInputHistoryIndex -= 1;
      }
      event.preventDefault();
      if (chatInputHistoryIndex === -1) {
        input.value = chatInputDraft;
      } else {
        input.value = userMessages[userMessages.length - 1 - chatInputHistoryIndex] || "";
      }
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

  const messagesClickHandler = (e) => {
    const api = deps.getRoamAlphaApi();
    const pageRef = e.target.closest(".chief-page-ref");
    if (pageRef) {
      e.preventDefault();
      const pageTitle = pageRef.getAttribute("data-page-title");
      if (!pageTitle) return;
      if (e.shiftKey) {
        try {
          const escaped = deps.escapeForDatalog(pageTitle);
          const rows = api.q?.('[:find ?uid :where [?p :node/title "' + escaped + '"] [?p :block/uid ?uid]]') || [];
          const uid = String(rows?.[0]?.[0] || "").trim();
          if (uid) api.ui.rightSidebar.addWindow({ window: { type: "outline", "block-uid": uid } });
        } catch (err) { deps.debugLog("[Chief flow] Shift-click page ref error:", err); }
      } else {
        deps.openRoamPageByTitle(pageTitle);
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
      } catch (err) { deps.debugLog("[Chief flow] Block ref click error:", err); }
      return;
    }
  };
  messages.addEventListener("click", messagesClickHandler);

  chatPanelCleanupListeners = () => {
    input.removeEventListener("keydown", inputKeydownHandler);
    messages.removeEventListener("click", messagesClickHandler);
  };
  registerChiefPanelCleanup(container, () => {
    try { chatPanelCleanupDrag?.(); } catch { /* ignore */ }
    try { chatPanelCleanupListeners?.(); } catch { /* ignore */ }
  });
  if (chatPanelHistory.length) {
    const fragment = document.createDocumentFragment();
    const initialRenderCap = 30;
    const renderSlice = chatPanelHistory.length > initialRenderCap
      ? chatPanelHistory.slice(chatPanelHistory.length - initialRenderCap)
      : chatPanelHistory;
    renderSlice.forEach((entry) => {
      fragment.appendChild(createChatPanelMessageElement(entry.role, entry.text));
    });
    messages.appendChild(fragment);
    messages.scrollTop = messages.scrollHeight;
  } else {
    const greeting = "Hi — ask me anything. I keep context from this session, so follow-ups work.";
    appendChatPanelMessage("assistant", greeting);
    appendChatPanelHistory("assistant", greeting);
  }
  observeCosThemeChanges();
  return chatPanelContainer;
}

// ── Panel visibility / toggle / destroy ─────────────────────────────
export function isChatPanelActuallyVisible(panel) {
  if (!panel || !document?.body?.contains?.(panel)) return false;
  const style = window.getComputedStyle(panel);
  if (!style) return false;
  return style.display !== "none" && style.visibility !== "hidden";
}

export function setChatPanelOpen(nextOpen) {
  const panel = ensureChatPanel();
  if (!panel) return;
  refreshChatPanelElementRefs();
  // Re-append to end of body to guarantee the panel stacks on top of
  // anything Roam appended after our initial appendChild during onload.
  // Moving an already-attached node preserves all event listeners.
  if (nextOpen && panel.parentElement === document.body) {
    document.body.appendChild(panel);
  }
  panel.style.display = nextOpen ? "flex" : "none";
  if (nextOpen) {
    clampChatPanelToViewport(panel);
    syncCosTheme();
  }
  chatPanelIsOpen = nextOpen;
  if (nextOpen && chatPanelInput) chatPanelInput.focus();
  try { localStorage.setItem("chief-of-staff-panel-open", nextOpen ? "1" : "0"); } catch { /* ignore */ }
}

export function toggleChatPanel() {
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

export function destroyChatPanel() {
  teardownCosThemeObserver();
  unregisterChiefPanelCleanup(chatPanelContainer);
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
  clearTimeout(chatThinkingTimerId);
  clearTimeout(chatWorkingTimerId);
  chatThinkingTimerId = null;
  chatWorkingTimerId = null;
}

// ── Toast prompt / approval dialogs ─────────────────────────────────
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

export function promptToolSlugWithToast(defaultSlug = "") {
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
      theme: getToastTheme(),
      title: "Install Composio Tool",
      message: '<input data-chief-tool-input type="text" value="' + escapedValue + '" placeholder="GOOGLECALENDAR" />',
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

export function promptTextWithToast({
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

    const escapedValue = deps.escapeHtml(String(initialValue || ""));
    const escapedPlaceholder = deps.escapeHtml(String(placeholder || ""));
    const escapedConfirmLabel = deps.escapeHtml(String(confirmLabel || ""));
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
      theme: getToastTheme(),
      title: deps.escapeHtml(title),
      message: '<input data-chief-input type="text" value="' + escapedValue + '" placeholder="' + escapedPlaceholder + '" />',
      position: "center",
      timeout: false,
      close: false,
      overlay: true,
      drag: false,
      buttons: [
        [
          "<button>" + escapedConfirmLabel + "</button>",
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

export function promptInstalledToolSlugWithToast(
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

    const escapedConfirmLabel = deps.escapeHtml(String(confirmLabel || ""));
    const optionsHtml = installedTools
      .map((tool) => {
        const escapedSlug = deps.escapeHtml(String(tool.slug || ""));
        const escapedLabel = deps.escapeHtml(String(tool.label || tool.slug || ""));
        return '<option value="' + escapedSlug + '">' + escapedLabel + '</option>';
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
      theme: getToastTheme(),
      title: deps.escapeHtml(title),
      message: '<select data-chief-tool-select>' + optionsHtml + '</select>',
      position: "center",
      timeout: false,
      close: false,
      overlay: true,
      drag: false,
      buttons: [
        [
          "<button>" + escapedConfirmLabel + "</button>",
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

export function promptToolExecutionApproval(toolName, args) {
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

    const argsPreview = deps.safeJsonStringify(args, 600);
    const escapedToolName = deps.escapeHtml(String(toolName || ""));
    const escapedArgsPreview = deps.escapeHtml(String(argsPreview || ""));
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
      theme: getToastTheme(),
      title: "Approve tool action",
      message: '<div><strong>' + escapedToolName + '</strong></div><pre class="chief-tool-preview">' + escapedArgsPreview + '</pre>',
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

export function promptWriteToDailyPage() {
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
      theme: getToastTheme(),
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

export function detachAllToastKeyboards() {
  for (const kb of activeToastKeyboards) {
    try { kb.detach(); } catch { /* ignore */ }
  }
  activeToastKeyboards.clear();
}
