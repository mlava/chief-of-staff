// ═══════════════════════════════════════════════════════════════════════════════
// LLM Providers Module
// ═══════════════════════════════════════════════════════════════════════════════
//
// Extracted from index.js. Houses provider selection, model tier mapping, API
// key handling, provider cooldown/failover, PII scrubbing, retry logic, and the
// actual Anthropic/OpenAI/Gemini/Mistral API call functions.
//
// Initialise once via initLlmProviders({ ... }).
// ═══════════════════════════════════════════════════════════════════════════════

import {
  LLM_API_ENDPOINTS,
  DEFAULT_LLM_MODELS,
  POWER_LLM_MODELS,
  LUDICROUS_LLM_MODELS
} from "./aibom-config.js";

// ── DI container ─────────────────────────────────────────────────────────────
let deps = {};

export function initLlmProviders(injected) {
  deps = injected;
}

// ── Module state ─────────────────────────────────────────────────────────────
const providerCooldowns = {}; // { provider: expiryTimestampMs } — bounded at ~4 entries (one per provider)

// ── Provider Selection & Model Mapping ───────────────────────────────────────

// Built-in providers — fixed at compile time. Custom providers
// (LM Studio, Ollama, OpenAI-compatible servers) are configured at runtime
// via custom-llm-${n}-* settings; see listCustomProviderIds below.
export const BUILTIN_LLM_PROVIDERS = ["anthropic", "openai", "gemini", "mistral", "groq"];

// Kept for back-compat: index.js uses this for the autoresearch judge,
// which intentionally selects from built-in providers only.
export const VALID_LLM_PROVIDERS = BUILTIN_LLM_PROVIDERS;

// Mirrors remote-mcp-count semantics. Bumping this is safe and additive.
const CUSTOM_LLM_SLOT_CAP = 3;

// Local URLs that bypass the Roam CORS proxy (browser secure-context exception
// for loopback addresses).
const LOCALHOST_URL_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i;

export function isLocalhostUrl(url) {
  return LOCALHOST_URL_RE.test(String(url || "").trim());
}

export function isCustomProvider(provider) {
  return typeof provider === "string" && provider.startsWith("custom-");
}

export function listCustomProviderIds(extensionAPI) {
  if (!extensionAPI?.settings?.get) return [];
  const raw = extensionAPI.settings.get("custom-llm-count");
  const count = Math.min(CUSTOM_LLM_SLOT_CAP, Math.max(0, parseInt(raw, 10) || 0));
  const ids = [];
  for (let i = 1; i <= count; i++) {
    const baseUrl = deps.getSettingString(extensionAPI, `custom-llm-${i}-base-url`, "").trim();
    if (baseUrl) ids.push(`custom-${i}`);
  }
  return ids;
}

export function getCustomProviderConfig(extensionAPI, provider) {
  if (!isCustomProvider(provider) || !extensionAPI) return null;
  const slot = parseInt(provider.slice("custom-".length), 10);
  if (!Number.isFinite(slot) || slot < 1 || slot > CUSTOM_LLM_SLOT_CAP) return null;
  const baseUrl = deps.getSettingString(extensionAPI, `custom-llm-${slot}-base-url`, "").trim();
  if (!baseUrl) return null;
  const miniModel = deps.getSettingString(extensionAPI, `custom-llm-${slot}-mini-model`, "").trim();
  const powerModel = deps.getSettingString(extensionAPI, `custom-llm-${slot}-power-model`, "").trim();
  const ludicrousModel = deps.getSettingString(extensionAPI, `custom-llm-${slot}-ludicrous-model`, "").trim();
  return {
    slot,
    name: deps.getSettingString(extensionAPI, `custom-llm-${slot}-name`, "").trim() || `Custom ${slot}`,
    baseUrl,
    apiKey: deps.getSettingString(extensionAPI, `custom-llm-${slot}-api-key`, "").trim(),
    miniModel,
    powerModel: powerModel || miniModel,
    ludicrousModel: ludicrousModel || powerModel || miniModel || null,
    includeInFailover: deps.getSettingBool(extensionAPI, `custom-llm-${slot}-include-in-failover`, false),
    noFailover: deps.getSettingBool(extensionAPI, `custom-llm-${slot}-no-failover`, false),
    useProxy: deps.getSettingBool(extensionAPI, `custom-llm-${slot}-use-proxy`, false),
    disableToolCalling: deps.getSettingBool(extensionAPI, `custom-llm-${slot}-disable-tool-calling`, false)
  };
}

// True when the request to this provider should omit the `tools` field entirely.
// Used for OpenRouter free models or small local models that don't support tool
// calling — sending an empty or non-empty `tools` list still makes them 404.
export function shouldOmitToolsForProvider(provider) {
  if (!isCustomProvider(provider)) return false;
  const cfg = getCustomProviderConfig(deps.extensionAPIRef, provider);
  return !!cfg?.disableToolCalling;
}

export function getValidProviders(extensionAPI) {
  return [...BUILTIN_LLM_PROVIDERS, ...listCustomProviderIds(extensionAPI)];
}

// Resolves the OpenAI-format chat completions endpoint for a given provider.
// Custom providers honour the per-slot base URL and useProxy flag; built-ins
// use the fixed LLM_API_ENDPOINTS table behind the Roam CORS proxy.
export function resolveOpenAIEndpoint(provider) {
  if (isCustomProvider(provider)) {
    const cfg = getCustomProviderConfig(deps.extensionAPIRef, provider);
    if (!cfg) throw new Error(`Custom LLM provider ${provider} is not configured`);
    const direct = `${cfg.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    // Local servers always bypass the proxy. Remote servers go direct unless
    // the user opts into the proxy (escape hatch for restrictive CORS).
    if (cfg.useProxy && !isLocalhostUrl(cfg.baseUrl)) return deps.getProxiedLlmUrl(direct);
    return direct;
  }
  return deps.getProxiedLlmUrl(LLM_API_ENDPOINTS[provider] || LLM_API_ENDPOINTS.openai);
}

// Returns the failover chain for a tier with opted-in custom providers
// appended. Built-in chain order is preserved.
export function buildEffectiveFailoverChain(extensionAPI, tier) {
  const base = deps.FAILOVER_CHAINS[tier] || deps.FAILOVER_CHAINS.mini;
  if (!extensionAPI) return [...base];
  const customs = listCustomProviderIds(extensionAPI).filter(id => {
    const cfg = getCustomProviderConfig(extensionAPI, id);
    return cfg?.includeInFailover === true;
  });
  return [...base, ...customs];
}

export function isOpenAICompatible(provider) {
  return provider === "openai" || provider === "gemini" || provider === "mistral" || provider === "groq"
    || isCustomProvider(provider);
}

export function getLlmProvider(extensionAPI) {
  const stored = deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.llmProvider, deps.DEFAULT_LLM_PROVIDER);
  // The settings dropdown may store a compound label like "custom-1 — LM Studio"
  // so the user sees the friendly name. Extract the canonical slot ID prefix.
  const slotMatch = stored.match(/^(custom-\d+)\b/i);
  const raw = slotMatch ? slotMatch[1].toLowerCase() : stored.toLowerCase();
  if (BUILTIN_LLM_PROVIDERS.includes(raw)) return raw;
  if (isCustomProvider(raw) && getCustomProviderConfig(extensionAPI, raw)) return raw;
  // Saved primary may have been a custom slot the user later removed.
  if (isCustomProvider(raw)) {
    deps.debugLog("[Chief flow] Saved custom provider", raw, "no longer configured; falling back to anthropic");
  }
  return "anthropic";
}

/**
 * Sanitise a string for use as an HTTP header value.
 * The fetch() API rejects any header value containing characters outside
 * the ISO-8859-1 range (U+0000–U+00FF). Copy-pasted API keys sometimes
 * include invisible Unicode characters (zero-width spaces, smart quotes,
 * BOM markers, etc.) that trigger this.
 */
export function sanitizeHeaderValue(value) {
  if (!value) return value;
  // Strip anything outside printable ASCII (0x20-0x7E) — API keys should
  // only ever contain alphanumeric chars, hyphens, and underscores.
  // eslint-disable-next-line no-control-regex
  return value.replace(/[^\x20-\x7E]/g, "");
}

export function getApiKeyForProvider(extensionAPI, provider) {
  if (isCustomProvider(provider)) {
    const cfg = getCustomProviderConfig(extensionAPI, provider);
    // OpenAI client convention requires a non-empty Bearer header value;
    // LM Studio and Ollama ignore it. Real keys are sent verbatim.
    return sanitizeHeaderValue(cfg?.apiKey || "lm-studio-no-auth");
  }
  const keyMap = {
    openai: deps.SETTINGS_KEYS.openaiApiKey,
    anthropic: deps.SETTINGS_KEYS.anthropicApiKey,
    gemini: deps.SETTINGS_KEYS.geminiApiKey,
    mistral: deps.SETTINGS_KEYS.mistralApiKey,
    groq: deps.SETTINGS_KEYS.groqApiKey
  };
  const settingKey = keyMap[provider];
  if (settingKey) {
    const providerKey = deps.getSettingString(extensionAPI, settingKey, "");
    if (providerKey) return sanitizeHeaderValue(providerKey);
  }
  // Fallback: legacy single-key field
  return sanitizeHeaderValue(deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.llmApiKey, ""));
}

/**
 * Get the OpenAI API key specifically (for Whisper, etc.).
 * Checks dedicated OpenAI field first, then legacy field if provider is OpenAI.
 */
export function getOpenAiApiKey(extensionAPI) {
  const dedicated = deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.openaiApiKey, "");
  if (dedicated) return sanitizeHeaderValue(dedicated);
  // Fallback: if the legacy key looks like an OpenAI key or provider is openai
  const legacy = deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.llmApiKey, "");
  if (legacy && (legacy.startsWith("sk-") || getLlmProvider(extensionAPI) === "openai")) return sanitizeHeaderValue(legacy);
  return "";
}

export function getLlmModel(extensionAPI, provider) {
  if (isCustomProvider(provider)) {
    return getCustomProviderConfig(extensionAPI, provider)?.miniModel || "";
  }
  return DEFAULT_LLM_MODELS[provider] || DEFAULT_LLM_MODELS.anthropic;
}

export function getPowerModel(extensionAPI, provider) {
  if (isCustomProvider(provider)) {
    return getCustomProviderConfig(extensionAPI, provider)?.powerModel || "";
  }
  return POWER_LLM_MODELS[provider] || POWER_LLM_MODELS.anthropic;
}

export function getLudicrousModel(extensionAPI, provider) {
  if (isCustomProvider(provider)) {
    return getCustomProviderConfig(extensionAPI, provider)?.ludicrousModel || null;
  }
  return LUDICROUS_LLM_MODELS[provider] || null;
}

// ── Provider Cooldown & Failover ─────────────────────────────────────────────

export function isProviderCoolingDown(provider) {
  const expiry = providerCooldowns[provider];
  if (!expiry) return false;
  if (Date.now() >= expiry) { delete providerCooldowns[provider]; return false; }
  return true;
}

export function setProviderCooldown(provider) {
  providerCooldowns[provider] = Date.now() + deps.PROVIDER_COOLDOWN_MS;
  // Sweep stale entries to prevent unbounded growth in long-lived tabs
  const now = Date.now();
  for (const key of Object.keys(providerCooldowns)) {
    if (now >= providerCooldowns[key]) delete providerCooldowns[key];
  }
}

export function getFailoverProviders(primaryProvider, extensionAPI, tier = "mini") {
  // Privacy mode: when the primary is a custom slot with no-failover ON,
  // do not fall over to any other provider — surface the error to the user.
  if (isCustomProvider(primaryProvider)) {
    const primaryCfg = getCustomProviderConfig(extensionAPI, primaryProvider);
    if (primaryCfg?.noFailover) return [];
  }
  const chain = buildEffectiveFailoverChain(extensionAPI, tier);
  const startIdx = chain.indexOf(primaryProvider);
  const rotated = startIdx >= 0
    ? [...chain.slice(startIdx + 1), ...chain.slice(0, startIdx)]
    : chain.filter(p => p !== primaryProvider);
  return rotated.filter(p => !!getApiKeyForProvider(extensionAPI, p) && !isProviderCoolingDown(p));
}

export function getModelCostRates(model, provider) {
  // Custom providers (LM Studio, Ollama, OpenAI-compatible servers) are
  // zero-cost by default. Avoids the mid-range fallback below silently
  // billing local models against the user's daily spending cap.
  if (isCustomProvider(provider)) return { inputPerM: 0, outputPerM: 0 };
  const rates = deps.LLM_MODEL_COSTS[model];
  if (rates) return { inputPerM: rates[0], outputPerM: rates[1] };
  // Fallback: assume mid-range pricing
  return { inputPerM: 2.5, outputPerM: 10.0 };
}

// ── Anthropic advisor tool (beta) ───────────────────────────────────────────
// Decides whether to inject the advisor server tool into a given Anthropic call.
// Anthropic-only; off by default; capped at mini tier unless the user opts in.
export function isAdvisorEnabledForCall(provider, tier) {
  if (provider !== "anthropic") return false;
  const ext = deps.extensionAPIRef;
  if (!ext) return false;
  if (!deps.getSettingBool(ext, deps.SETTINGS_KEYS.advisorEnabled, false)) return false;
  // Top tier already runs Opus — no advisor to consult.
  if (tier === "ludicrous") return false;
  // Optionally restrict to mini tier only.
  const miniOnly = deps.getSettingBool(ext, deps.SETTINGS_KEYS.advisorMiniOnly, true);
  if (miniOnly && tier !== "mini") return false;
  return true;
}

export function getAdvisorMaxUses() {
  const ext = deps.extensionAPIRef;
  const raw = ext ? deps.getSettingString(ext, deps.SETTINGS_KEYS.advisorMaxUses, "2") : "2";
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 && n <= 10 ? n : 2;
}

// True iff the advisor flag is on (regardless of provider/tier).
// Used by system-prompt.js to decide whether to include the advisor instruction.
// Cheaper than isAdvisorEnabledForCall because it doesn't need a tier value.
export function isAdvisorEnabledInSettings() {
  const ext = deps.extensionAPIRef;
  if (!ext) return false;
  return !!deps.getSettingBool(ext, deps.SETTINGS_KEYS.advisorEnabled, false);
}

// ── Retry & Error Classification ─────────────────────────────────────────────

export function shouldRetryLlmStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

export function isFailoverEligibleError(error) {
  if (error?.name === "AbortError") return false;
  const msg = String(error?.message || "").toLowerCase();
  return msg.includes("rate limit")
    || msg.includes("429")
    || msg.includes("error 413")
    || msg.includes("too large")
    || msg.includes("error 500")
    || msg.includes("error 502")
    || msg.includes("error 503")
    || msg.includes("error 504")
    || msg.includes("timeout")
    || msg.includes("service_tier_capacity_exceeded")
    || msg.includes("overloaded")
    // Local server unreachable (LM Studio off, Ollama not running) — let the
    // chain rotate to the next provider rather than dead-ending here.
    || msg.includes("failed to fetch")
    || msg.includes("err_connection_refused")
    || msg.includes("networkerror");
}

export async function fetchLlmJsonWithRetry(url, init, providerLabel, options = {}) {
  const { signal, timeout = deps.LLM_RESPONSE_TIMEOUT_MS } = options;
  let lastError = null;
  for (let attempt = 1; attempt <= deps.LLM_MAX_RETRIES; attempt += 1) {
    try {
      const timeoutSignal = AbortSignal.timeout(timeout);
      const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
      const response = await fetch(url, { ...init, signal: combinedSignal });
      if (!response.ok) {
        const errorText = (await response.text()).slice(0, 500);
        if (shouldRetryLlmStatus(response.status) && attempt < deps.LLM_MAX_RETRIES) {
          const delay = deps.LLM_RETRY_BASE_DELAY_MS * (2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
          await deps.sleep(delay, signal);
          continue;
        }
        if (response.status === 400) {
          deps.debugLog(`[Chief flow] ${providerLabel} 400 error:`, errorText.slice(0, 500));
        }
        if (response.status === 429) {
          throw new Error(`${providerLabel} rate limit hit (input tokens/min). Try again in ~60s or shorten the request.`);
        }
        throw new Error(`${providerLabel} API error ${response.status}: ${errorText}`);
      }
      return response.json();
    } catch (error) {
      if (signal?.aborted) throw error; // user-initiated abort — don't retry
      if (error?.name === "AbortError") throw error;
      if (error?.name === "TimeoutError") {
        lastError = new Error(`${providerLabel} API request timed out after ${timeout / 1000}s`);
        if (attempt >= deps.LLM_MAX_RETRIES) break;
        const delay = deps.LLM_RETRY_BASE_DELAY_MS * (2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
        await deps.sleep(delay, signal);
        continue;
      }
      lastError = error;
      if (attempt >= deps.LLM_MAX_RETRIES) break;
      const delay = deps.LLM_RETRY_BASE_DELAY_MS * (2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
      await deps.sleep(delay, signal);
    }
  }
  throw lastError || new Error(`${providerLabel} API request failed`);
}

// ── PII Scrubbing ────────────────────────────────────────────────────────────

export const PII_SCRUB_PATTERNS = [
  // Email addresses — broad pattern, catches most valid addresses
  { re: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g, replacement: "[EMAIL]" },
  // Phone numbers — international formats (+1-234-567-8901, +44 20 7946 0958, etc.)
  { re: /(?<![A-Za-z0-9])(?:\+?[1-9]\d{0,2}[\s.\-]?)?(?:\(?\d{2,4}\)?[\s.\-]?)?\d{3,4}[\s.\-]?\d{3,4}(?![A-Za-z0-9])/g, replacement: "[PHONE]", minLength: 7, validator: isLikelyPhoneNumber },
  // US Social Security Numbers — 123-45-6789 or 123 45 6789
  { re: /\b\d{3}[\s\-]\d{2}[\s\-]\d{4}\b/g, replacement: "[SSN]" },
  // Credit card numbers — 13-19 digits with optional separators
  { re: /\b(?:\d[\s\-]?){13,19}\b/g, replacement: "[CREDIT_CARD]", validator: luhnCheck },
  // IBAN — 2-letter country code + 2 check digits + up to 30 alphanumeric
  { re: /\b[A-Z]{2}\d{2}[\s]?[A-Z0-9]{4}[\s]?(?:[A-Z0-9]{4}[\s]?){1,7}[A-Z0-9]{1,4}\b/g, replacement: "[IBAN]" },
  // Australian Medicare number — 10-11 digits, first digit 2-6
  { re: /\b[2-6]\d{3}[\s]?\d{5}[\s]?\d{1,2}\b/g, replacement: "[MEDICARE]" },
  // Australian Tax File Number — 8-9 digits
  { re: /\b\d{3}[\s]?\d{3}[\s]?\d{2,3}\b/g, replacement: "[TFN]", minLength: 8 },
  // IP addresses (v4) — don't scrub common localhost/LAN
  { re: /\b(?!127\.0\.0\.1|0\.0\.0\.0|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3})(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\b/g, replacement: "[IP_ADDR]" },
];

// Luhn algorithm — validates credit card numbers to reduce false positives
export function luhnCheck(digits) {
  const cleaned = digits.replace(/[\s\-]/g, "");
  if (!/^\d{13,19}$/.test(cleaned)) return false;
  let sum = 0;
  let alternate = false;
  for (let i = cleaned.length - 1; i >= 0; i--) {
    let n = parseInt(cleaned[i], 10);
    if (alternate) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

// Reduce false positives on dates, timestamps, and bare digit sequences
export function isLikelyPhoneNumber(match) {
  const stripped = match.replace(/[\s.\-()]/g, "");
  // Bare 8-9 digit numbers without + or ( prefix are usually dates/timestamps/IDs
  if (/^\d{8,9}$/.test(stripped) && !/[+(]/.test(match)) return false;
  // YYYYMMDD date pattern
  if (/^\d{4}[01]\d[0-3]\d$/.test(stripped)) return false;
  // NNN-NN-NNNN or NNN.NN.NNNN — looks like date parts (2-4 digit groups)
  if (/^\d{2,4}[\s.\-]\d{1,2}[\s.\-]\d{2,4}$/.test(match.trim())) return false;
  return true;
}

export function scrubPiiFromText(text, { skipEmail = false } = {}) {
  if (!text || typeof text !== "string") return text;
  let result = text;
  for (const { re, replacement, minLength, validator } of PII_SCRUB_PATTERNS) {
    // When email tools are active, preserve email addresses so the LLM can
    // use them in tool calls (e.g. "send email to user@example.com").
    if (skipEmail && replacement === "[EMAIL]") continue;
    re.lastIndex = 0; // reset stateful regex
    result = result.replace(re, (match) => {
      if (minLength && match.replace(/[\s\-]/g, "").length < minLength) return match;
      if (validator && !validator(match)) return match;
      return replacement;
    });
  }
  return result;
}

// Returns true when the active tool set includes email-related tools
// (Gmail, Outlook, or any tool with "email" in its name/slug). When true,
// email addresses in user messages should NOT be scrubbed because the LLM
// needs them to populate recipient fields in tool calls.
const EMAIL_TOOL_RE = /\b(GMAIL_|OUTLOOK_|email)/i;

// Returns true when the active tool set includes calendar-related tools
// (Google Calendar MCP, Composio calendar, etc.). When true, email addresses
// should NOT be scrubbed because calendar IDs use email-format strings
// (e.g. "user@gmail.com", "family123@group.calendar.google.com") that the
// LLM must pass verbatim to list-events, create-event, etc.
const CALENDAR_TOOL_RE = /\b(list-events|search-events|create-events?|delete-event|update-event|get-event|get-freebusy|list-calendars|respond-to-event|GOOGLE_CALENDAR_|COMPOSIO.*CALENDAR)/i;

export function hasEmailTools(tools) {
  if (!Array.isArray(tools)) return false;
  return tools.some(t => EMAIL_TOOL_RE.test(t.name || ""));
}

export function hasCalendarTools(tools) {
  if (!Array.isArray(tools)) return false;
  return tools.some(t => CALENDAR_TOOL_RE.test(t.name || ""));
}

// Combined check: skip email scrubbing when email OR calendar tools are active.
// Calendar tools use email-format IDs (e.g. "user@gmail.com",
// "abc@group.calendar.google.com") that must be preserved.
export function shouldSkipEmailScrub(tools) {
  return hasEmailTools(tools) || hasCalendarTools(tools);
}

// Deep-scrubs PII from a messages array (both Anthropic and OpenAI formats).
// Returns a new array — does NOT mutate the input.
//
// Tool results (role:"tool" / type:"tool_result") are EXEMPT from scrubbing.
// Rationale: tool results contain structured API responses (calendar IDs,
// entity identifiers, etc.) that the model must reference verbatim in
// subsequent tool calls. Scrubbing email-format identifiers like Google
// Calendar IDs (e.g. "user@gmail.com", "abc@group.calendar.google.com")
// to "[EMAIL]" breaks downstream tool calls that depend on those exact values.
//
// When the active tool set includes email tools (Gmail, Outlook, etc.),
// email addresses in user messages are also preserved so the LLM can use
// them as recipient addresses in compose/draft/send tool calls.
export function scrubPiiFromMessages(messages, { tools } = {}) {
  if (!Array.isArray(messages)) return messages;
  const skipEmail = shouldSkipEmailScrub(tools);
  return messages.map(msg => {
    if (!msg) return msg;

    // Skip tool result messages — they contain structured data the model
    // needs to use as-is (calendar IDs, entity keys, API identifiers).
    // OpenAI format: role === "tool"
    if (msg.role === "tool") return msg;

    const scrubbed = { ...msg };

    // OpenAI format: content is a string
    if (typeof scrubbed.content === "string") {
      scrubbed.content = scrubPiiFromText(scrubbed.content, { skipEmail });
    }
    // Anthropic format: content is an array of blocks
    else if (Array.isArray(scrubbed.content)) {
      scrubbed.content = scrubbed.content.map(block => {
        if (!block) return block;
        // Skip tool_result blocks — same rationale as role:"tool" above
        if (block.type === "tool_result") return block;
        const b = { ...block };
        if (typeof b.text === "string") b.text = scrubPiiFromText(b.text, { skipEmail });
        if (typeof b.content === "string") b.content = scrubPiiFromText(b.content, { skipEmail });
        return b;
      });
    }
    return scrubbed;
  });
}

export function isPiiScrubEnabled() {
  return deps.getSettingBool(deps.extensionAPIRef, deps.SETTINGS_KEYS.piiScrubEnabled, true);
}

// ── LLM API Calls ────────────────────────────────────────────────────────────

export async function callAnthropic(apiKey, model, system, messages, tools, options = {}) {
  // Anthropic supports direct browser access via the anthropic-dangerous-direct-browser-access header,
  // so skip the CORS proxy (which returns 404 for api.anthropic.com).
  // DD-2: Defence-in-depth PII scrub — in case this function is ever called directly
  const skipEmail = shouldSkipEmailScrub(tools);
  const scrubbed = isPiiScrubEnabled() ? scrubPiiFromMessages(messages, { tools }) : messages;
  const safeSystem = deps.sanitiseLlmPayloadText(isPiiScrubEnabled() ? scrubPiiFromText(system, { skipEmail }) : system);
  const safeMessages = deps.sanitiseLlmMessages(scrubbed);

  // Advisor tool injection (Anthropic beta) — gated by setting + tier + non-empty
  // tools array. An empty tools array means this is a deterministic single-shot
  // scoring/classification call (eval judge, intent classifier), not an agentic
  // loop — those calls don't benefit from the advisor and shouldn't pay Opus rates.
  const tier = options.tier || "mini";
  const useAdvisor = tools.length > 0 && isAdvisorEnabledForCall("anthropic", tier);
  const advisorMaxUses = useAdvisor ? getAdvisorMaxUses() : 0;

  const headers = {
    "Content-Type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "anthropic-dangerous-direct-browser-access": "true"
  };
  if (useAdvisor) {
    headers["anthropic-beta"] = deps.ANTHROPIC_ADVISOR_BETA_HEADER;
  }

  // Build tools array. Last NORMAL tool gets cache_control; advisor tool is appended after
  // (it's a server-tool with a different shape and shouldn't carry cache_control).
  const mappedTools = tools.map((tool, i) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
    ...(i === tools.length - 1 ? { cache_control: { type: "ephemeral" } } : {})
  }));
  if (useAdvisor) {
    mappedTools.push({
      type: deps.ANTHROPIC_ADVISOR_TOOL_TYPE,
      name: "advisor",
      model: deps.ANTHROPIC_ADVISOR_MODEL,
      max_uses: advisorMaxUses
    });
    deps.debugLog("[advisor] tool injected", {
      tier,
      advisorModel: deps.ANTHROPIC_ADVISOR_MODEL,
      maxUses: advisorMaxUses
    });
  }

  // Bump max_tokens when advisor is in use — executor produces two output phases
  // (pre-advisor reasoning + post-advisor synthesis), so the default cap is too tight.
  const baseMaxTokens = options.maxOutputTokens || deps.STANDARD_MAX_OUTPUT_TOKENS;
  const effectiveMaxTokens = useAdvisor ? Math.max(baseMaxTokens, 2000) : baseMaxTokens;

  return fetchLlmJsonWithRetry(
    LLM_API_ENDPOINTS.anthropic,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        max_tokens: effectiveMaxTokens,
        system: [
          { type: "text", text: safeSystem, cache_control: { type: "ephemeral" } }
        ],
        messages: safeMessages,
        tools: mappedTools
      })
    },
    "Anthropic",
    { signal: options.signal }
  );
}

/**
 * Ensure a tool's input_schema is a clean JSON Schema object compatible
 * with all LLM providers. Strict providers like Groq reject advanced
 * JSON Schema features (Draft 6+, composition, schema-valued fields).
 *
 * Uses an allowlist of safe keywords rather than a blocklist, so any
 * unknown/new schema features are automatically stripped.
 */
const SAFE_SCHEMA_KEYS = new Set([
  "type", "properties", "required", "items", "enum", "description",
  "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems",
  "additionalProperties"
]);
function sanitiseToolSchema(schema) {
  if (!schema || typeof schema !== "object") return { type: "object", properties: {} };
  const defs = schema.$defs || schema.definitions || {};
  function resolve(node, depth) {
    if (!node || typeof node !== "object" || depth > 10) return node;
    if (Array.isArray(node)) return node.map(item => resolve(item, depth + 1));
    // Resolve $ref to inline definition
    if (node.$ref && typeof node.$ref === "string") {
      const match = node.$ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/);
      if (match && defs[match[1]]) return resolve(defs[match[1]], depth + 1);
      return { type: "string" }; // Unresolvable ref — fall back to string
    }
    // Collapse anyOf/oneOf → first element
    if (Array.isArray(node.anyOf) && node.anyOf.length) return resolve(node.anyOf[0], depth + 1);
    if (Array.isArray(node.oneOf) && node.oneOf.length) return resolve(node.oneOf[0], depth + 1);
    // Merge allOf into a single flat schema
    if (Array.isArray(node.allOf) && node.allOf.length) {
      const merged = {};
      for (const part of node.allOf) {
        const resolved = resolve(part, depth + 1);
        if (resolved && typeof resolved === "object") Object.assign(merged, resolved);
      }
      return merged;
    }
    const cleaned = {};
    for (const [key, val] of Object.entries(node)) {
      if (!SAFE_SCHEMA_KEYS.has(key)) continue;
      // additionalProperties: only keep as boolean (schema-valued form breaks Groq)
      if (key === "additionalProperties") {
        cleaned[key] = typeof val === "boolean" ? val : true;
        continue;
      }
      // "properties" is a map of user-defined names → schema objects;
      // preserve the property names and only sanitise each schema value
      if (key === "properties" && val && typeof val === "object" && !Array.isArray(val)) {
        const cleanedProps = {};
        for (const [propName, propSchema] of Object.entries(val)) {
          cleanedProps[propName] = resolve(propSchema, depth + 1);
        }
        cleaned[key] = cleanedProps;
        continue;
      }
      cleaned[key] = resolve(val, depth + 1);
    }
    return cleaned;
  }
  const clean = resolve(schema, 0);
  if (!clean.type) clean.type = "object";
  return clean;
}

export async function callOpenAI(apiKey, model, system, messages, tools, options = {}, provider = "openai") {
  // DD-2: Defence-in-depth PII scrub — in case this function is ever called directly
  const skipEmail = shouldSkipEmailScrub(tools);
  const scrubbed = isPiiScrubEnabled() ? scrubPiiFromMessages(messages, { tools }) : messages;
  const safeSystem = deps.sanitiseLlmPayloadText(isPiiScrubEnabled() ? scrubPiiFromText(system, { skipEmail }) : system);
  const safeMessages = deps.sanitiseLlmMessages(scrubbed);
  const maxTokens = options.maxOutputTokens || deps.STANDARD_MAX_OUTPUT_TOKENS;
  // OpenAI newer models (GPT-4.1, GPT-5) require max_completion_tokens; Gemini/Mistral use max_tokens
  const tokenParam = provider === "openai"
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
  const omitTools = shouldOmitToolsForProvider(provider);
  const requestBody = {
    model,
    messages: [{ role: "system", content: safeSystem }, ...safeMessages],
    ...tokenParam
  };
  if (!omitTools) {
    requestBody.tools = tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: sanitiseToolSchema(tool.input_schema)
      }
    }));
  }
  return fetchLlmJsonWithRetry(
    resolveOpenAIEndpoint(provider),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody)
    },
    provider,
    { signal: options.signal }
  );
}

/**
 * Streaming OpenAI call — returns { textContent, toolCalls, usage } after
 * piping text chunks to onTextChunk(delta). Tool calls are collected and
 * returned at the end. Falls back to non-streaming on error.
 */
export async function callOpenAIStreaming(apiKey, model, system, messages, tools, onTextChunk, options = {}, provider = "openai") {
  // DD-2: Scrub PII from content sent to external LLM APIs
  // Pass tools so email addresses are preserved when email/calendar tools are active
  const skipEmail = shouldSkipEmailScrub(tools);
  const scrubbedSystem = isPiiScrubEnabled() ? scrubPiiFromText(system, { skipEmail }) : system;
  const scrubbedMessages = isPiiScrubEnabled() ? scrubPiiFromMessages(messages, { tools }) : messages;
  // DD-2b: Strip known LLM control strings before sending to provider
  const safeSystem = deps.sanitiseLlmPayloadText(scrubbedSystem);
  const safeMessages = deps.sanitiseLlmMessages(scrubbedMessages);
  const maxTokens = options.maxOutputTokens || deps.STANDARD_MAX_OUTPUT_TOKENS;
  // OpenAI newer models (GPT-4.1, GPT-5) require max_completion_tokens; Gemini/Mistral use max_tokens
  const tokenParam = provider === "openai"
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
  // Clearable connect timeout: abort if the initial HTTP response doesn't arrive
  // within LLM_RESPONSE_TIMEOUT_MS. Unlike AbortSignal.timeout(), this is disarmed
  // once the response headers arrive, so it won't cap the streaming body read.
  const connectAbort = new AbortController();
  const connectTimeoutId = setTimeout(
    () => connectAbort.abort(new Error("Streaming connect timeout")),
    deps.LLM_RESPONSE_TIMEOUT_MS
  );
  const streamFetchSignal = options.signal
    ? AbortSignal.any([options.signal, connectAbort.signal])
    : connectAbort.signal;
  const omitTools = shouldOmitToolsForProvider(provider);
  const requestBody = {
    model,
    messages: [{ role: "system", content: safeSystem }, ...safeMessages],
    ...tokenParam,
    stream: true,
    stream_options: { include_usage: true }
  };
  if (!omitTools) {
    requestBody.tools = tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: sanitiseToolSchema(tool.input_schema)
      }
    }));
  }
  let response;
  try {
    response = await fetch(resolveOpenAIEndpoint(provider), {
      signal: streamFetchSignal,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody)
    });
  } finally {
    clearTimeout(connectTimeoutId); // Connection established (or failed) — disarm connect timeout
  }

  if (!response.ok) {
    const errorText = (await response.text()).slice(0, 800);
    // Common OpenRouter / restricted-provider failure: model has no tool-capable
    // backend. Surface a hint about the per-slot toggle so the user isn't stuck
    // grepping the error text.
    if (response.status === 404 && /No endpoints found that support tool use/i.test(errorText)) {
      throw new Error(
        `${provider} streaming error 404: this model has no tool-capable provider. `
        + `Either pick a model that supports tools (filter at https://openrouter.ai/models?supported_parameters=tools) `
        + `or enable "Disable tool calling" on this slot in settings. Original error: ${errorText}`
      );
    }
    // OpenRouter free models have aggressive rate limits — ~20 RPM and ~50/day
    // by default, lifted to 1000/day after buying $10 credit. Surface this
    // because the per-minute retry won't help if it's the daily cap.
    if (response.status === 429 && isCustomProvider(provider)) {
      const retryAfter = response.headers.get("retry-after");
      const retryHint = retryAfter ? ` Retry-After: ${retryAfter}s.` : "";
      throw new Error(
        `${provider} rate limit (HTTP 429).${retryHint} If using OpenRouter free models, this is likely the per-day cap (~50/day default, 1000/day with $10 credit purchased). `
        + `Either wait, switch to a less-popular free model, buy credit, or run the query through a local slot. Original error: ${errorText}`
      );
    }
    throw new Error(`${provider} streaming error ${response.status}: ${errorText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let textContent = "";
  const toolCallDeltas = {}; // index -> { id, name, arguments }
  const indexRedirects = {}; // original index -> redirected index (for collision continuations)
  let usage = null;

  const streamStartMs = Date.now();
  const STREAM_TOTAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 min hard cap on total stream duration
  try {
    while (true) {
      if (Date.now() - streamStartMs > STREAM_TOTAL_TIMEOUT_MS) {
        throw new Error("OpenAI streaming total timeout (5 min)");
      }
      let chunkTimeoutId;
      const chunkTimeout = new Promise((_, reject) => {
        chunkTimeoutId = setTimeout(() => reject(new Error("OpenAI streaming chunk timeout")), deps.LLM_STREAM_CHUNK_TIMEOUT_MS);
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

        // Text content — soft cap to prevent runaway accumulation
        if (delta.content) {
          if (textContent.length < 120000) textContent += delta.content;
          if (onTextChunk) onTextChunk(delta.content);
        }

        // Tool call deltas — accumulate arguments with bounds
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const origIdx = tc.index ?? 0;
            let idx = origIdx;
            if (idx < 0 || idx > 64) continue;

            // Gemini OpenAI-compat sometimes sends multiple parallel tool calls
            // at the same index. Detect when a new tool name or id arrives at an
            // already-occupied slot and redirect to a fresh slot to prevent
            // argument concatenation across different tools.
            //
            // When a collision redirect happens, subsequent arg-only chunks
            // (no name or id) at the original index must follow the redirect —
            // otherwise their arguments land in the wrong slot.
            const existing = toolCallDeltas[idx];
            if (existing) {
              const hasNewName = tc.function?.name && existing.name && tc.function.name !== existing.name;
              const hasNewId = tc.id && existing.id && tc.id !== existing.id;
              if (hasNewName || hasNewId) {
                const keys = Object.keys(toolCallDeltas).map(Number).filter(n => !isNaN(n));
                const newIdx = (keys.length > 0 ? Math.max(...keys) : -1) + 1;
                deps.debugLog("[Chief flow] Gemini parallel tool-call collision at index", origIdx,
                  "— redirecting", tc.function?.name || tc.id, "to slot", newIdx,
                  "(existing:", existing.name + ")");
                idx = newIdx;
                indexRedirects[origIdx] = newIdx;
              } else if (!tc.function?.name && !tc.id && indexRedirects[origIdx] !== undefined) {
                // Arg-only continuation chunk — follow the last redirect for this index
                idx = indexRedirects[origIdx];
              }
            }

            if (!toolCallDeltas[idx]) {
              toolCallDeltas[idx] = { id: tc.id || "", name: tc.function?.name || "", arguments: "" };
            }
            if (tc.id) toolCallDeltas[idx].id = tc.id;
            if (tc.function?.name) toolCallDeltas[idx].name = tc.function.name;
            if (tc.function?.arguments && toolCallDeltas[idx].arguments.length < 32768) {
              toolCallDeltas[idx].arguments += tc.function.arguments;
            }
            // Gemini 3 models require thought_signature to be echoed back for multi-turn tool calling.
            // Without it, subsequent API calls return 400 "Function call is missing a thought_signature".
            // In the OpenAI-compat SSE format, the signature is at tc.extra_content.google.thought_signature.
            const sig = tc.extra_content?.google?.thought_signature || tc.thought_signature;
            if (sig) {
              toolCallDeltas[idx].thought_signature = sig;
              // Preserve the full extra_content structure for echo-back
              if (tc.extra_content) toolCallDeltas[idx].extra_content = tc.extra_content;
              deps.debugLog("[Chief flow] Captured thought_signature for tool call index", idx, "(length:", sig.length + ")");
            }
          }
        }
      }
    }
  } finally {
    try { reader.cancel(); } catch { /* ignore */ }
  }

  const toolCalls = Object.values(toolCallDeltas)
    .filter((tc) => tc.name)
    .map((tc) => {
      let args = {};
      try { args = JSON.parse(tc.arguments); } catch (e) {
        deps.debugLog("[Chief flow] Tool argument JSON parse failed:", tc.name, e?.message);
        // Look up the tool's input_schema for schema-aware recovery
        const toolDef = Array.isArray(tools) ? tools.find(t =>
          (t.function?.name || t.name) === tc.name
        ) : null;
        const schema = toolDef?.function?.parameters || toolDef?.input_schema || null;
        args = deps.tryRecoverJsonArgs(tc.arguments, tc.name, schema);
      }
      const call = { id: tc.id, name: tc.name, arguments: args };
      // Gemini 3: carry thought_signature through to response reconstruction
      if (tc.thought_signature) call.thought_signature = tc.thought_signature;
      return call;
    });

  return { textContent, toolCalls, usage };
}

export async function callLlm(provider, apiKey, model, system, messages, tools, options = {}) {
  // DD-2: Scrub PII from content sent to external LLM APIs
  // Pass tools so email addresses are preserved when email/calendar tools are active
  const skipEmail = shouldSkipEmailScrub(tools);
  const scrubbedSystem = isPiiScrubEnabled() ? scrubPiiFromText(system, { skipEmail }) : system;
  const scrubbedMessages = isPiiScrubEnabled() ? scrubPiiFromMessages(messages, { tools }) : messages;
  if (isOpenAICompatible(provider)) return callOpenAI(apiKey, model, scrubbedSystem, scrubbedMessages, tools, options, provider);
  return callAnthropic(apiKey, model, scrubbedSystem, scrubbedMessages, tools, options);
}

// ── Tool Filtering ───────────────────────────────────────────────────────────

/**
 * Filter tool schemas by query relevance to reduce the tool count passed to the LLM.
 * Uses direct keyword matching — NO "include everything" fallback like detectPromptSections.
 * Optional categories (BT, cron, email, calendar, composio) are ONLY included when
 * the query explicitly mentions them. Core tools are always included.
 */
// Hard tool count cap — OpenAI enforces 128 max, Gemini has similar limits.
// When exceeded, drop direct MCP tools from the largest servers first (they
// contribute the most tools and can still be reached via meta-route/execute
// if a meta-tool exists for their category).
const MAX_TOOL_COUNT = 128;

// ── Tiered Disclosure (#63) ────────────────────────────────────────────────
// By default, MCP and extension tool schemas are NOT included in the tools API
// array (saving ~70-100k chars/call). They appear only as compact tier 2 lines
// in the system prompt (name + intent). The model accesses them via ROUTE/EXECUTE.
//
// "Promotion" elevates a server's tools to tier 3 (full schemas in the API array)
// when the user's intent matches that server's domain. This avoids extra round-trips
// for the common case while keeping the tools budget lean for unrelated queries.

// Common words that appear in many tool names/descriptions — too generic to trigger promotion.
const PROMOTION_STOP_WORDS = new Set([
  "search", "list", "find", "get", "create", "update", "delete", "remove", "query",
  "fetch", "read", "write", "send", "check", "status", "info", "data", "items",
  "result", "results", "text", "name", "type", "value", "content", "page", "note",
  "notes", "server", "tool", "tools", "from", "with", "that", "this", "have",
  "about", "using", "google", "your", "please", "help", "what", "show", "make"
]);

/**
 * Determine which MCP/extension server names should have their tools promoted
 * to tier 3 (full schemas in the tools API array) based on the user's message.
 *
 * Uses a two-tier keyword strategy:
 * - **Strong keywords** (server name parts): a single match promotes the server.
 *   E.g., "sentry" in the message promotes the Sentry MCP server.
 * - **Weak keywords** (tool name/description fragments): require 2+ distinct
 *   matches from the same server to promote. Prevents false positives from
 *   generic words like "search" or "list" that appear in many servers.
 *
 * Returns a Set of lowercase server names that should be promoted.
 * Non-promoted servers remain accessible via ROUTE/EXECUTE meta-tools.
 */
export function getPromotedServerNames(userMessage, localMcpTools, remoteMcpTools, extTools) {
  const promoted = new Set();
  const text = String(userMessage || "").toLowerCase();

  // Build server name → { strong: Set, weak: Set } keyword map.
  const serverKeywords = new Map(); // serverName (lowercase) → { strong, weak }

  const allSourceTools = [
    ...(localMcpTools || []),
    ...(remoteMcpTools || []),
    ...(extTools || [])
  ];

  for (const t of allSourceTools) {
    const serverName = (t._serverName || t._extensionName || "").toLowerCase();
    if (!serverName) continue;
    if (!serverKeywords.has(serverName)) {
      const strong = new Set();
      const weak = new Set();
      // Server name parts are strong keywords (e.g., "sentry", "zotero", "notebooklm")
      for (const word of serverName.split(/[\s_-]+/).filter(w => w.length > 2)) {
        if (!PROMOTION_STOP_WORDS.has(word)) strong.add(word);
      }
      // Multi-word server name as a phrase (e.g., "open brain", "scholar sidekick")
      if (serverName.includes(" ") && serverName.length > 5) {
        strong.add(serverName);
      }
      serverKeywords.set(serverName, { strong, weak });
    }
    const entry = serverKeywords.get(serverName);
    // Tool name domain-specific parts are weak keywords (need 2+ to promote)
    const toolName = (t._originalName || t.name || "").toLowerCase();
    for (const word of toolName.split(/[_-]+/).filter(w => w.length > 4)) {
      if (!PROMOTION_STOP_WORDS.has(word)) entry.weak.add(word);
    }
  }

  // Check user message against each server's keyword sets
  for (const [serverName, { strong, weak }] of serverKeywords) {
    // Strong match: any single server name keyword triggers promotion
    let strongHit = false;
    for (const kw of strong) {
      if (text.includes(kw)) {
        strongHit = true;
        break;
      }
    }
    if (strongHit) {
      promoted.add(serverName);
      continue;
    }
    // Weak match: need 2+ distinct keyword hits from tool names
    let weakHits = 0;
    for (const kw of weak) {
      if (text.includes(kw)) {
        weakHits++;
        if (weakHits >= 2) {
          promoted.add(serverName);
          break;
        }
      }
    }
  }

  return promoted;
}

export function filterToolsByRelevance(tools, userMessage) {
  const text = String(userMessage || "").toLowerCase();

  // Only include optional tool categories when the query explicitly mentions them
  const needsBt = /\b(tasks?|todo|project|done|overdue|due|bt_|better\s*tasks?|assign|delegate|waiting.for)\b/.test(text);
  const needsCron = /\b(cron|schedule[ds]?|recurring|every\s+\d+\s+(min|hour)|hourly|timer|remind\s+me\s+in)\b/.test(text);
  const needsEmail = /\b(email|gmail|inbox|unread|mail|draft)\b/.test(text);
  const needsCalendar = /\b(cal[ea]n[dn]a?[rt]|event|meeting|appointment|agenda|gcal)\b/.test(text);
  const needsComposio = /\b(composio|connect|integration|install|deregister|connected\s+tools?)\b/.test(text);

  const filtered = tools.filter(t => {
    const name = t.name || "";
    // Category-gated tools — only include if query explicitly needs them
    if (name.startsWith("roam_bt_")) return needsBt;
    if (name.startsWith("cos_cron_")) return needsCron;
    if (name.startsWith("COMPOSIO_")) return needsComposio || needsEmail || needsCalendar;
    // Everything else (roam native, LOCAL_MCP_*, extension, direct MCP, cos_update_memory, cos_get_skill): always include
    return true;
  });

  // Enforce hard cap to stay within provider limits (OpenAI: 128, Gemini: similar).
  // If over the limit, drop direct MCP tools from the largest servers first.
  // Core tools (roam_*, cos_*, ROAM_*, LOCAL_MCP_*, REMOTE_MCP_*) are never dropped.
  if (filtered.length > MAX_TOOL_COUNT) {
    const excess = filtered.length - MAX_TOOL_COUNT;
    // Identify droppable direct MCP tools (local or remote, non-meta)
    const droppable = [];
    for (let i = 0; i < filtered.length; i++) {
      const t = filtered[i];
      const name = t.name || "";
      const isMeta = name === "LOCAL_MCP_ROUTE" || name === "LOCAL_MCP_EXECUTE" ||
                     name === "REMOTE_MCP_ROUTE" || name === "REMOTE_MCP_EXECUTE";
      const isCore = name.startsWith("roam_") || name.startsWith("cos_") ||
                     name.startsWith("ROAM_") || name.startsWith("COMPOSIO_") ||
                     name.startsWith("roam_bt_") || isMeta;
      if (!isCore && (t._serverName || t._isDirect !== undefined)) {
        droppable.push({ index: i, serverName: t._serverName || "unknown" });
      }
    }
    // Sort droppable tools: tools from servers contributing the most direct tools go first
    const serverToolCounts = new Map();
    for (const d of droppable) {
      serverToolCounts.set(d.serverName, (serverToolCounts.get(d.serverName) || 0) + 1);
    }
    droppable.sort((a, b) => (serverToolCounts.get(b.serverName) || 0) - (serverToolCounts.get(a.serverName) || 0));
    // Drop excess tools from the top of the sorted list
    const dropIndices = new Set(droppable.slice(0, excess).map(d => d.index));
    const capped = filtered.filter((_, i) => !dropIndices.has(i));
    deps.debugLog("[Chief flow] Tool cap enforced:", filtered.length, "→", capped.length, `(dropped ${excess} direct MCP tools)`);
    return capped;
  }

  if (filtered.length < tools.length) {
    deps.debugLog("[Chief flow] Tool filtering:", tools.length, "→", filtered.length, "tools");
  }
  return filtered;
}
