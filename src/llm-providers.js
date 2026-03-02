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

export const VALID_LLM_PROVIDERS = ["anthropic", "openai", "gemini", "mistral"];

export function isOpenAICompatible(provider) {
  return provider === "openai" || provider === "gemini" || provider === "mistral";
}

export function getLlmProvider(extensionAPI) {
  const raw = deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.llmProvider, deps.DEFAULT_LLM_PROVIDER).toLowerCase();
  return VALID_LLM_PROVIDERS.includes(raw) ? raw : "anthropic";
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
  const keyMap = {
    openai: deps.SETTINGS_KEYS.openaiApiKey,
    anthropic: deps.SETTINGS_KEYS.anthropicApiKey,
    gemini: deps.SETTINGS_KEYS.geminiApiKey,
    mistral: deps.SETTINGS_KEYS.mistralApiKey
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
  return DEFAULT_LLM_MODELS[provider] || DEFAULT_LLM_MODELS.anthropic;
}

export function getPowerModel(provider) {
  return POWER_LLM_MODELS[provider] || POWER_LLM_MODELS.anthropic;
}

export function getLudicrousModel(provider) {
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
  const chain = deps.FAILOVER_CHAINS[tier] || deps.FAILOVER_CHAINS.mini;
  const startIdx = chain.indexOf(primaryProvider);
  const rotated = startIdx >= 0
    ? [...chain.slice(startIdx + 1), ...chain.slice(0, startIdx)]
    : chain.filter(p => p !== primaryProvider);
  return rotated.filter(p => !!getApiKeyForProvider(extensionAPI, p) && !isProviderCoolingDown(p));
}

export function getModelCostRates(model) {
  const rates = deps.LLM_MODEL_COSTS[model];
  if (rates) return { inputPerM: rates[0], outputPerM: rates[1] };
  // Fallback: assume mid-range pricing
  return { inputPerM: 2.5, outputPerM: 10.0 };
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
    || msg.includes("error 500")
    || msg.includes("error 502")
    || msg.includes("error 503")
    || msg.includes("error 504")
    || msg.includes("timeout")
    || msg.includes("service_tier_capacity_exceeded")
    || msg.includes("overloaded");
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

export function scrubPiiFromText(text) {
  if (!text || typeof text !== "string") return text;
  let result = text;
  for (const { re, replacement, minLength, validator } of PII_SCRUB_PATTERNS) {
    re.lastIndex = 0; // reset stateful regex
    result = result.replace(re, (match) => {
      if (minLength && match.replace(/[\s\-]/g, "").length < minLength) return match;
      if (validator && !validator(match)) return match;
      return replacement;
    });
  }
  return result;
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
export function scrubPiiFromMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map(msg => {
    if (!msg) return msg;

    // Skip tool result messages — they contain structured data the model
    // needs to use as-is (calendar IDs, entity keys, API identifiers).
    // OpenAI format: role === "tool"
    if (msg.role === "tool") return msg;

    const scrubbed = { ...msg };

    // OpenAI format: content is a string
    if (typeof scrubbed.content === "string") {
      scrubbed.content = scrubPiiFromText(scrubbed.content);
    }
    // Anthropic format: content is an array of blocks
    else if (Array.isArray(scrubbed.content)) {
      scrubbed.content = scrubbed.content.map(block => {
        if (!block) return block;
        // Skip tool_result blocks — same rationale as role:"tool" above
        if (block.type === "tool_result") return block;
        const b = { ...block };
        if (typeof b.text === "string") b.text = scrubPiiFromText(b.text);
        if (typeof b.content === "string") b.content = scrubPiiFromText(b.content);
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
  const safeSystem = deps.sanitiseLlmPayloadText(system);
  const safeMessages = deps.sanitiseLlmMessages(messages);
  return fetchLlmJsonWithRetry(
    LLM_API_ENDPOINTS.anthropic,
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
        max_tokens: options.maxOutputTokens || deps.STANDARD_MAX_OUTPUT_TOKENS,
        system: safeSystem,
        messages: safeMessages,
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

export async function callOpenAI(apiKey, model, system, messages, tools, options = {}, provider = "openai") {
  const safeSystem = deps.sanitiseLlmPayloadText(system);
  const safeMessages = deps.sanitiseLlmMessages(messages);
  const maxTokens = options.maxOutputTokens || deps.STANDARD_MAX_OUTPUT_TOKENS;
  // OpenAI newer models (GPT-4.1, GPT-5) require max_completion_tokens; Gemini/Mistral use max_tokens
  const tokenParam = provider === "openai"
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
  return fetchLlmJsonWithRetry(
    deps.getProxiedLlmUrl(LLM_API_ENDPOINTS[provider] || LLM_API_ENDPOINTS.openai),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: safeSystem }, ...safeMessages],
        tools: tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.input_schema
          }
        })),
        ...tokenParam
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
export async function callOpenAIStreaming(apiKey, model, system, messages, tools, onTextChunk, options = {}, provider = "openai") {
  // DD-2: Scrub PII from content sent to external LLM APIs
  const scrubbedSystem = isPiiScrubEnabled() ? scrubPiiFromText(system) : system;
  const scrubbedMessages = isPiiScrubEnabled() ? scrubPiiFromMessages(messages) : messages;
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
  let response;
  try {
    response = await fetch(deps.getProxiedLlmUrl(LLM_API_ENDPOINTS[provider] || LLM_API_ENDPOINTS.openai), {
      signal: streamFetchSignal,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "system", content: safeSystem }, ...safeMessages],
        tools: tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.input_schema
          }
        })),
        ...tokenParam,
        stream: true,
        stream_options: { include_usage: true }
      })
    });
  } finally {
    clearTimeout(connectTimeoutId); // Connection established (or failed) — disarm connect timeout
  }

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
            let idx = tc.index ?? 0;
            if (idx < 0 || idx > 64) continue;

            // Gemini OpenAI-compat sometimes sends multiple parallel tool calls
            // at the same index. Detect when a new tool name or id arrives at an
            // already-occupied slot and redirect to a fresh slot to prevent
            // argument concatenation across different tools.
            const existing = toolCallDeltas[idx];
            if (existing) {
              const hasNewName = tc.function?.name && existing.name && tc.function.name !== existing.name;
              const hasNewId = tc.id && existing.id && tc.id !== existing.id;
              if (hasNewName || hasNewId) {
                const keys = Object.keys(toolCallDeltas).map(Number).filter(n => !isNaN(n));
                const newIdx = (keys.length > 0 ? Math.max(...keys) : -1) + 1;
                deps.debugLog("[Chief flow] Gemini parallel tool-call collision at index", tc.index ?? 0,
                  "— redirecting", tc.function?.name || tc.id, "to slot", newIdx,
                  "(existing:", existing.name + ")");
                idx = newIdx;
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
  const scrubbedSystem = isPiiScrubEnabled() ? scrubPiiFromText(system) : system;
  const scrubbedMessages = isPiiScrubEnabled() ? scrubPiiFromMessages(messages) : messages;
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
export function filterToolsByRelevance(tools, userMessage) {
  const text = String(userMessage || "").toLowerCase();

  // Only include optional tool categories when the query explicitly mentions them
  const needsBt = /\b(tasks?|todo|project|done|overdue|due|bt_|better\s*tasks?|assign|delegate|waiting.for)\b/.test(text);
  const needsCron = /\b(cron|schedule[ds]?|recurring|every\s+\d+\s+(min|hour)|hourly|timer|remind\s+me\s+in)\b/.test(text);
  const needsEmail = /\b(email|gmail|inbox|unread|mail|messages?|send|draft|compose)\b/.test(text);
  const needsCalendar = /\b(cal[ea]n[dn]a?[rt]|event|meeting|appointment|agenda|gcal)\b/.test(text);
  const needsComposio = /\b(composio|connect|integration|install|deregister|connected\s+tools?)\b/.test(text);

  const filtered = tools.filter(t => {
    const name = t.name || "";
    // Category-gated tools — only include if query explicitly needs them
    if (name.startsWith("roam_bt_")) return needsBt;
    if (name.startsWith("cos_cron_")) return needsCron;
    if (name.startsWith("COMPOSIO_")) return needsComposio;
    // Everything else (roam native, LOCAL_MCP_*, extension, direct MCP, cos_update_memory, cos_get_skill): always include
    return true;
  });

  if (filtered.length < tools.length) {
    deps.debugLog("[Chief flow] Tool filtering:", tools.length, "→", filtered.length, "tools");
  }
  return filtered;
}
