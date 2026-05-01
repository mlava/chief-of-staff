import test from "node:test";
import assert from "node:assert/strict";
import {
  initLlmProviders,
  isCustomProvider,
  isLocalhostUrl,
  isOpenAICompatible,
  listCustomProviderIds,
  getCustomProviderConfig,
  getValidProviders,
  getApiKeyForProvider,
  getLlmProvider,
  getLlmModel,
  getPowerModel,
  getLudicrousModel,
  getModelCostRates,
  resolveOpenAIEndpoint,
  buildEffectiveFailoverChain,
  getFailoverProviders,
  shouldOmitToolsForProvider,
  BUILTIN_LLM_PROVIDERS,
  VALID_LLM_PROVIDERS,
} from "../src/llm-providers.js";

// ── Test helpers ─────────────────────────────────────────────────────────────

const SETTINGS_KEYS = {
  llmProvider: "llm-provider",
  llmApiKey: "llm-api-key",
  openaiApiKey: "openai-api-key",
  anthropicApiKey: "anthropic-api-key",
  geminiApiKey: "gemini-api-key",
  mistralApiKey: "mistral-api-key",
  groqApiKey: "groq-api-key",
  piiScrubEnabled: "pii-scrub-enabled",
  advisorEnabled: "cos-advisor-enabled",
  advisorMaxUses: "cos-advisor-max-uses",
  advisorMiniOnly: "cos-advisor-mini-only",
};

const FAILOVER_CHAINS = {
  mini: ["gemini", "mistral", "openai", "anthropic", "groq"],
  power: ["gemini", "mistral", "openai", "anthropic", "groq"],
  ludicrous: ["gemini", "openai", "mistral", "anthropic", "groq"],
};

const LLM_MODEL_COSTS = {
  "claude-haiku-4-5-20251001": [1.00, 5.00],
  "gpt-5.4-mini": [0.75, 4.50],
};

function makeExtensionAPI(overrides = {}) {
  const store = { ...overrides };
  return {
    settings: {
      get: (k) => store[k],
      set: (k, v) => { store[k] = v; },
    },
    _store: store,
  };
}

function initWithExt(ext) {
  initLlmProviders({
    extensionAPIRef: ext,
    SETTINGS_KEYS,
    FAILOVER_CHAINS,
    LLM_MODEL_COSTS,
    DEFAULT_LLM_PROVIDER: "anthropic",
    PROVIDER_COOLDOWN_MS: 60_000,
    LLM_RESPONSE_TIMEOUT_MS: 90_000,
    LLM_MAX_RETRIES: 3,
    LLM_RETRY_BASE_DELAY_MS: 100,
    STANDARD_MAX_OUTPUT_TOKENS: 1200,
    getSettingString: (e, k, fallback) => {
      const v = e?.settings?.get?.(k);
      return v == null ? (fallback ?? "") : String(v);
    },
    getSettingBool: (e, k, fallback) => {
      const v = e?.settings?.get?.(k);
      return typeof v === "boolean" ? v : !!fallback;
    },
    getProxiedLlmUrl: (url) => `https://proxy.example/${url}`,
    debugLog: () => {},
    sleep: async () => {},
    sanitiseLlmPayloadText: (s) => s,
    sanitiseLlmMessages: (m) => m,
    tryRecoverJsonArgs: () => ({}),
  });
  return ext;
}

// ── isCustomProvider / isLocalhostUrl ────────────────────────────────────────

test("isCustomProvider detects custom-N IDs", () => {
  assert.equal(isCustomProvider("custom-1"), true);
  assert.equal(isCustomProvider("custom-3"), true);
  assert.equal(isCustomProvider("openai"), false);
  assert.equal(isCustomProvider("anthropic"), false);
  assert.equal(isCustomProvider(""), false);
  assert.equal(isCustomProvider(null), false);
});

test("isLocalhostUrl matches loopback variants", () => {
  assert.equal(isLocalhostUrl("http://localhost:1234/v1"), true);
  assert.equal(isLocalhostUrl("http://127.0.0.1:11434/v1"), true);
  assert.equal(isLocalhostUrl("https://localhost/v1"), true);
  assert.equal(isLocalhostUrl("http://[::1]:1234"), true);
  assert.equal(isLocalhostUrl("https://api.together.xyz/v1"), false);
  assert.equal(isLocalhostUrl("http://example.com"), false);
  assert.equal(isLocalhostUrl(""), false);
});

// ── listCustomProviderIds ────────────────────────────────────────────────────

test("listCustomProviderIds returns empty when no slots configured", () => {
  const ext = initWithExt(makeExtensionAPI());
  assert.deepEqual(listCustomProviderIds(ext), []);
});

test("listCustomProviderIds filters out slots with empty base URL", () => {
  const ext = initWithExt(makeExtensionAPI({
    "custom-llm-count": 3,
    "custom-llm-1-base-url": "http://localhost:1234/v1",
    "custom-llm-2-base-url": "",
    "custom-llm-3-base-url": "http://localhost:11434/v1",
  }));
  assert.deepEqual(listCustomProviderIds(ext), ["custom-1", "custom-3"]);
});

test("listCustomProviderIds caps at 3 slots", () => {
  const ext = initWithExt(makeExtensionAPI({
    "custom-llm-count": 99,
    "custom-llm-1-base-url": "http://localhost:1234/v1",
    "custom-llm-2-base-url": "http://localhost:11434/v1",
    "custom-llm-3-base-url": "https://openrouter.ai/api/v1",
    "custom-llm-4-base-url": "http://should-not-appear/v1",
  }));
  assert.deepEqual(listCustomProviderIds(ext), ["custom-1", "custom-2", "custom-3"]);
});

// ── getCustomProviderConfig ──────────────────────────────────────────────────

test("getCustomProviderConfig returns null for blank base URL", () => {
  const ext = initWithExt(makeExtensionAPI({ "custom-llm-count": 1 }));
  assert.equal(getCustomProviderConfig(ext, "custom-1"), null);
});

test("getCustomProviderConfig returns null for non-custom provider", () => {
  const ext = initWithExt(makeExtensionAPI());
  assert.equal(getCustomProviderConfig(ext, "openai"), null);
});

test("getCustomProviderConfig populates all fields and applies model fallbacks", () => {
  const ext = initWithExt(makeExtensionAPI({
    "custom-llm-count": 1,
    "custom-llm-1-name": "  LM Studio  ",
    "custom-llm-1-base-url": "  http://localhost:1234/v1  ",
    "custom-llm-1-api-key": "sk-test",
    "custom-llm-1-mini-model": "llama3.2",
    // power-model and ludicrous-model intentionally blank
    "custom-llm-1-include-in-failover": true,
    "custom-llm-1-no-failover": true,
    "custom-llm-1-use-proxy": false,
  }));
  const cfg = getCustomProviderConfig(ext, "custom-1");
  assert.equal(cfg.slot, 1);
  assert.equal(cfg.name, "LM Studio");
  assert.equal(cfg.baseUrl, "http://localhost:1234/v1");
  assert.equal(cfg.apiKey, "sk-test");
  assert.equal(cfg.miniModel, "llama3.2");
  // Power and ludicrous fall back to mini when blank
  assert.equal(cfg.powerModel, "llama3.2");
  assert.equal(cfg.ludicrousModel, "llama3.2");
  assert.equal(cfg.includeInFailover, true);
  assert.equal(cfg.noFailover, true);
  assert.equal(cfg.useProxy, false);
});

test("getCustomProviderConfig synthesises a default name when blank", () => {
  const ext = initWithExt(makeExtensionAPI({
    "custom-llm-count": 1,
    "custom-llm-1-base-url": "http://localhost:1234/v1",
    "custom-llm-1-mini-model": "x",
  }));
  assert.equal(getCustomProviderConfig(ext, "custom-1").name, "Custom 1");
});

// ── isOpenAICompatible ───────────────────────────────────────────────────────

test("isOpenAICompatible includes built-ins and custom slots", () => {
  assert.equal(isOpenAICompatible("openai"), true);
  assert.equal(isOpenAICompatible("gemini"), true);
  assert.equal(isOpenAICompatible("custom-1"), true);
  assert.equal(isOpenAICompatible("anthropic"), false);
});

// ── getValidProviders ────────────────────────────────────────────────────────

test("getValidProviders returns built-ins only when no custom slots configured", () => {
  const ext = initWithExt(makeExtensionAPI());
  assert.deepEqual(getValidProviders(ext), BUILTIN_LLM_PROVIDERS);
});

test("getValidProviders appends configured custom slots", () => {
  const ext = initWithExt(makeExtensionAPI({
    "custom-llm-count": 2,
    "custom-llm-1-base-url": "http://localhost:1234/v1",
    "custom-llm-2-base-url": "http://localhost:11434/v1",
  }));
  assert.deepEqual(getValidProviders(ext), [...BUILTIN_LLM_PROVIDERS, "custom-1", "custom-2"]);
});

test("VALID_LLM_PROVIDERS preserves the built-in list (back-compat)", () => {
  assert.deepEqual(VALID_LLM_PROVIDERS, BUILTIN_LLM_PROVIDERS);
});

// ── getApiKeyForProvider ─────────────────────────────────────────────────────

test("getApiKeyForProvider returns placeholder when custom slot has no API key", () => {
  const ext = initWithExt(makeExtensionAPI({
    "custom-llm-count": 1,
    "custom-llm-1-base-url": "http://localhost:1234/v1",
    "custom-llm-1-mini-model": "x",
  }));
  assert.equal(getApiKeyForProvider(ext, "custom-1"), "lm-studio-no-auth");
});

test("getApiKeyForProvider returns the real key when custom slot configures one", () => {
  const ext = initWithExt(makeExtensionAPI({
    "custom-llm-count": 1,
    "custom-llm-1-base-url": "https://openrouter.ai/api/v1",
    "custom-llm-1-api-key": "sk-real-key",
    "custom-llm-1-mini-model": "x",
  }));
  assert.equal(getApiKeyForProvider(ext, "custom-1"), "sk-real-key");
});

test("getApiKeyForProvider still resolves built-in providers from per-provider keys", () => {
  const ext = initWithExt(makeExtensionAPI({
    "anthropic-api-key": "sk-ant-real",
  }));
  assert.equal(getApiKeyForProvider(ext, "anthropic"), "sk-ant-real");
});

// ── getLlmProvider ───────────────────────────────────────────────────────────

test("getLlmProvider accepts a configured custom slot", () => {
  const ext = initWithExt(makeExtensionAPI({
    "llm-provider": "custom-1",
    "custom-llm-count": 1,
    "custom-llm-1-base-url": "http://localhost:1234/v1",
    "custom-llm-1-mini-model": "x",
  }));
  assert.equal(getLlmProvider(ext), "custom-1");
});

test("getLlmProvider falls back to anthropic when saved custom slot is no longer configured", () => {
  const ext = initWithExt(makeExtensionAPI({
    "llm-provider": "custom-2",
    // custom-llm-count not set, slot not configured
  }));
  assert.equal(getLlmProvider(ext), "anthropic");
});

test("getLlmProvider extracts canonical slot ID from compound display label", () => {
  const ext = initWithExt(makeExtensionAPI({
    "llm-provider": "custom-1 — LM Studio",
    "custom-llm-count": 1,
    "custom-llm-1-base-url": "http://localhost:1234/v1",
    "custom-llm-1-mini-model": "x",
  }));
  assert.equal(getLlmProvider(ext), "custom-1");
});

test("getLlmProvider survives slot rename via compound label parsing", () => {
  // Saved value carries the OLD name; current config has a NEW name.
  // The canonical slot ID is still recoverable from the prefix.
  const ext = initWithExt(makeExtensionAPI({
    "llm-provider": "custom-1 — LM Studio",
    "custom-llm-count": 1,
    "custom-llm-1-name": "Local Gemma",
    "custom-llm-1-base-url": "http://localhost:1234/v1",
    "custom-llm-1-mini-model": "x",
  }));
  assert.equal(getLlmProvider(ext), "custom-1");
});

// ── Model getters with custom providers ──────────────────────────────────────

test("getLlmModel / getPowerModel / getLudicrousModel resolve custom slot tier IDs", () => {
  const ext = initWithExt(makeExtensionAPI({
    "custom-llm-count": 1,
    "custom-llm-1-base-url": "http://localhost:1234/v1",
    "custom-llm-1-mini-model": "mini-id",
    "custom-llm-1-power-model": "power-id",
    "custom-llm-1-ludicrous-model": "ludi-id",
  }));
  assert.equal(getLlmModel(ext, "custom-1"), "mini-id");
  assert.equal(getPowerModel(ext, "custom-1"), "power-id");
  assert.equal(getLudicrousModel(ext, "custom-1"), "ludi-id");
});

test("Power/ludicrous fall back to mini when blank", () => {
  const ext = initWithExt(makeExtensionAPI({
    "custom-llm-count": 1,
    "custom-llm-1-base-url": "http://localhost:1234/v1",
    "custom-llm-1-mini-model": "only-mini",
  }));
  assert.equal(getPowerModel(ext, "custom-1"), "only-mini");
  assert.equal(getLudicrousModel(ext, "custom-1"), "only-mini");
});

test("Built-in model getters unchanged", () => {
  const ext = initWithExt(makeExtensionAPI());
  // The built-in fallback returns the anthropic entry when missing — we test
  // the path runs without throwing and returns a non-empty string.
  // (Actual model values come from aibom-config.js DEFAULT_LLM_MODELS table.)
  assert.equal(typeof getLlmModel(ext, "openai"), "string");
});

// ── getModelCostRates ────────────────────────────────────────────────────────

test("getModelCostRates returns zero rates for custom providers", () => {
  assert.deepEqual(getModelCostRates("any-model", "custom-1"), { inputPerM: 0, outputPerM: 0 });
});

test("getModelCostRates returns the table value for known built-in models", () => {
  initWithExt(makeExtensionAPI());
  assert.deepEqual(getModelCostRates("claude-haiku-4-5-20251001"), { inputPerM: 1.00, outputPerM: 5.00 });
});

test("getModelCostRates falls back to mid-range when model unknown and provider is built-in", () => {
  initWithExt(makeExtensionAPI());
  assert.deepEqual(getModelCostRates("unknown-model"), { inputPerM: 2.5, outputPerM: 10.0 });
});

// ── resolveOpenAIEndpoint ────────────────────────────────────────────────────

test("resolveOpenAIEndpoint appends /chat/completions to custom base URL and bypasses proxy by default", () => {
  initWithExt(makeExtensionAPI({
    "custom-llm-count": 1,
    "custom-llm-1-base-url": "http://localhost:1234/v1",
    "custom-llm-1-mini-model": "x",
  }));
  assert.equal(resolveOpenAIEndpoint("custom-1"), "http://localhost:1234/v1/chat/completions");
});

test("resolveOpenAIEndpoint strips trailing slashes from custom base URL", () => {
  initWithExt(makeExtensionAPI({
    "custom-llm-count": 1,
    "custom-llm-1-base-url": "https://openrouter.ai/api/v1////",
    "custom-llm-1-mini-model": "x",
  }));
  assert.equal(resolveOpenAIEndpoint("custom-1"), "https://openrouter.ai/api/v1/chat/completions");
});

test("resolveOpenAIEndpoint honours useProxy for non-localhost URLs", () => {
  initWithExt(makeExtensionAPI({
    "custom-llm-count": 1,
    "custom-llm-1-base-url": "https://api.example.com/v1",
    "custom-llm-1-mini-model": "x",
    "custom-llm-1-use-proxy": true,
  }));
  assert.equal(
    resolveOpenAIEndpoint("custom-1"),
    "https://proxy.example/https://api.example.com/v1/chat/completions"
  );
});

test("resolveOpenAIEndpoint never proxies localhost even when useProxy is set", () => {
  initWithExt(makeExtensionAPI({
    "custom-llm-count": 1,
    "custom-llm-1-base-url": "http://localhost:1234/v1",
    "custom-llm-1-mini-model": "x",
    "custom-llm-1-use-proxy": true,
  }));
  assert.equal(resolveOpenAIEndpoint("custom-1"), "http://localhost:1234/v1/chat/completions");
});

test("resolveOpenAIEndpoint throws for an unconfigured custom slot", () => {
  initWithExt(makeExtensionAPI({ "custom-llm-count": 0 }));
  assert.throws(() => resolveOpenAIEndpoint("custom-1"), /not configured/);
});

// ── buildEffectiveFailoverChain ──────────────────────────────────────────────

test("buildEffectiveFailoverChain returns built-in chain when no custom slots opted in", () => {
  const ext = initWithExt(makeExtensionAPI({
    "custom-llm-count": 1,
    "custom-llm-1-base-url": "http://localhost:1234/v1",
    "custom-llm-1-mini-model": "x",
    // include-in-failover not set → defaults to false
  }));
  assert.deepEqual(buildEffectiveFailoverChain(ext, "mini"), FAILOVER_CHAINS.mini);
});

test("buildEffectiveFailoverChain appends opted-in custom slots to end of chain", () => {
  const ext = initWithExt(makeExtensionAPI({
    "custom-llm-count": 2,
    "custom-llm-1-base-url": "http://localhost:1234/v1",
    "custom-llm-1-mini-model": "x",
    "custom-llm-1-include-in-failover": true,
    "custom-llm-2-base-url": "http://localhost:11434/v1",
    "custom-llm-2-mini-model": "x",
    "custom-llm-2-include-in-failover": false,
  }));
  assert.deepEqual(
    buildEffectiveFailoverChain(ext, "mini"),
    [...FAILOVER_CHAINS.mini, "custom-1"]
  );
});

// ── getFailoverProviders ─────────────────────────────────────────────────────

test("getFailoverProviders returns empty array when primary is custom slot with noFailover", () => {
  const ext = initWithExt(makeExtensionAPI({
    "custom-llm-count": 1,
    "custom-llm-1-base-url": "http://localhost:1234/v1",
    "custom-llm-1-mini-model": "x",
    "custom-llm-1-no-failover": true,
    // built-in keys present so the chain would otherwise have entries
    "anthropic-api-key": "sk-ant",
    "openai-api-key": "sk-oa",
    "gemini-api-key": "key-g",
    "mistral-api-key": "key-m",
    "groq-api-key": "key-q",
  }));
  assert.deepEqual(getFailoverProviders("custom-1", ext, "mini"), []);
});

test("shouldOmitToolsForProvider is true when slot has disable-tool-calling ON", () => {
  initWithExt(makeExtensionAPI({
    "custom-llm-count": 1,
    "custom-llm-1-base-url": "https://openrouter.ai/api/v1",
    "custom-llm-1-mini-model": "x",
    "custom-llm-1-disable-tool-calling": true,
  }));
  assert.equal(shouldOmitToolsForProvider("custom-1"), true);
});

test("shouldOmitToolsForProvider is false by default for custom slots", () => {
  initWithExt(makeExtensionAPI({
    "custom-llm-count": 1,
    "custom-llm-1-base-url": "https://openrouter.ai/api/v1",
    "custom-llm-1-mini-model": "x",
  }));
  assert.equal(shouldOmitToolsForProvider("custom-1"), false);
});

test("shouldOmitToolsForProvider is false for built-in providers", () => {
  initWithExt(makeExtensionAPI());
  assert.equal(shouldOmitToolsForProvider("anthropic"), false);
  assert.equal(shouldOmitToolsForProvider("openai"), false);
});

test("getFailoverProviders returns rotated chain when primary is custom slot WITHOUT noFailover", () => {
  const ext = initWithExt(makeExtensionAPI({
    "custom-llm-count": 1,
    "custom-llm-1-base-url": "http://localhost:1234/v1",
    "custom-llm-1-mini-model": "x",
    "custom-llm-1-include-in-failover": true, // appears in chain
    // Provide keys for all built-ins
    "anthropic-api-key": "sk-ant",
    "openai-api-key": "sk-oa",
    "gemini-api-key": "key-g",
    "mistral-api-key": "key-m",
    "groq-api-key": "key-q",
  }));
  // Chain is [gemini, mistral, openai, anthropic, groq, custom-1]; primary at end → rotation puts everything before it first
  const result = getFailoverProviders("custom-1", ext, "mini");
  assert.deepEqual(result, ["gemini", "mistral", "openai", "anthropic", "groq"]);
});
