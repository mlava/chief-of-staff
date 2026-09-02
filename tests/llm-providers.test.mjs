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
  getConfiguredLlmModelTargets,
  classifyModelSmokeError,
  smokeTestConfiguredLlmModels,
  summariseModelSmokeResults,
  BUILTIN_LLM_PROVIDERS,
  VALID_LLM_PROVIDERS,
  getOpenAiApiKey,
  CODEX_PROVIDER_ID,
  isCodexProvider,
  callCodexResponsesStreaming,
  callAnthropic,
  filterToolsByRelevance,
  dropBypassToolsForTimedBlock,
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
  grokApiKey: "grok-api-key",
  kimiApiKey: "kimi-api-key",
  kimiCodingApiKey: "kimi-coding-api-key",
  deepseekApiKey: "deepseek-api-key",
  ollamaApiKey: "ollama-api-key",
  ollamaBaseUrl: "ollama-base-url",
  ollamaMiniModel: "ollama-mini-model",
  ollamaPowerModel: "ollama-power-model",
  ollamaLudicrousModel: "ollama-ludicrous-model",
  piiScrubEnabled: "pii-scrub-enabled",
  advisorEnabled: "cos-advisor-enabled",
  advisorMaxUses: "cos-advisor-max-uses",
  advisorMiniOnly: "cos-advisor-mini-only",
};

const FAILOVER_CHAINS = {
  mini: ["gemini", "mistral", "openai", "anthropic", "groq", "grok", "kimi", "kimi-coding", "deepseek", "ollama"],
  power: ["gemini", "mistral", "openai", "anthropic", "groq", "grok", "kimi", "kimi-coding", "deepseek", "ollama"],
  ludicrous: ["gemini", "openai", "mistral", "anthropic", "groq", "grok", "kimi", "kimi-coding", "deepseek", "ollama"],
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

function initWithExt(ext, extraDeps = {}) {
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
    ...extraDeps,
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
  assert.equal(isOpenAICompatible("grok"), true);
  assert.equal(isOpenAICompatible("kimi"), true);
  assert.equal(isOpenAICompatible("kimi-coding"), true);
  assert.equal(isOpenAICompatible("deepseek"), true);
  assert.equal(isOpenAICompatible("ollama"), true);
  assert.equal(isOpenAICompatible("custom-1"), true);
  assert.equal(isOpenAICompatible("anthropic"), false);
});
test("BUILTIN_LLM_PROVIDERS includes grok, kimi, kimi-coding, deepseek, ollama after the original five", () => {
  assert.deepEqual(BUILTIN_LLM_PROVIDERS, ["anthropic", "openai", "gemini", "mistral", "groq", "grok", "kimi", "kimi-coding", "deepseek", "ollama"]);
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
test("getApiKeyForProvider reads grok-api-key and kimi-api-key", () => {
  const ext = initWithExt(makeExtensionAPI({
    "grok-api-key": "key-grok",
    "kimi-api-key": "key-kimi",
  }));
  assert.equal(getApiKeyForProvider(ext, "grok"), "key-grok");
  assert.equal(getApiKeyForProvider(ext, "kimi"), "key-kimi");
});

test("getOpenAiApiKey does not treat a legacy sk- key as OpenAI when provider is kimi or grok", () => {
  const kimiExt = initWithExt(makeExtensionAPI({
    "llm-provider": "kimi",
    "llm-api-key": "sk-moonshot-key",
  }));
  assert.equal(getOpenAiApiKey(kimiExt), "");
  const grokExt = initWithExt(makeExtensionAPI({
    "llm-provider": "grok",
    "llm-api-key": "sk-moonshot-key",
  }));
  assert.equal(getOpenAiApiKey(grokExt), "");
  // OpenAI provider still picks up the legacy sk- key
  const openaiExt = initWithExt(makeExtensionAPI({
    "llm-provider": "openai",
    "llm-api-key": "sk-oa-key",
  }));
  assert.equal(getOpenAiApiKey(openaiExt), "sk-oa-key");
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
test("resolveOpenAIEndpoint routes grok and kimi through the proxied vendor URLs", () => {
  initWithExt(makeExtensionAPI());
  assert.equal(
    resolveOpenAIEndpoint("grok"),
    "https://proxy.example/https://api.x.ai/v1/chat/completions"
  );
  assert.equal(
    resolveOpenAIEndpoint("kimi"),
    "https://proxy.example/https://api.moonshot.ai/v1/chat/completions"
  );
});

test("built-in model getters return grok and kimi tier defaults", () => {
  const ext = initWithExt(makeExtensionAPI());
  assert.equal(getLlmModel(ext, "grok"), "grok-4.3");
  assert.equal(getPowerModel(ext, "grok"), "grok-4.6");
  assert.equal(getLudicrousModel(ext, "grok"), "grok-4.6");
  assert.equal(getLlmModel(ext, "kimi"), "kimi-k2.5");
  assert.equal(getPowerModel(ext, "kimi"), "kimi-k2.7-code");
  assert.equal(getLudicrousModel(ext, "kimi"), "kimi-k3");
});

test("failover chains start with gemini and append kimi-coding, deepseek, ollama at the end", () => {
  const ext = initWithExt(makeExtensionAPI());
  for (const tier of ["mini", "power", "ludicrous"]) {
    const chain = buildEffectiveFailoverChain(ext, tier);
    assert.equal(chain[0], "gemini");
    assert.deepEqual(chain.slice(-3), ["kimi-coding", "deepseek", "ollama"]);
  }
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
  // Chain is [gemini, mistral, openai, anthropic, groq, grok, kimi, kimi-coding,
  //          deepseek, ollama, custom-1]; primary at end → rotation puts
  // everything before it first. Only the keyed providers survive the truthiness
  // filter (grok/kimi/kimi-coding/deepseek/ollama have no key in this fixture).
  const result = getFailoverProviders("custom-1", ext, "mini");
  assert.deepEqual(result, ["gemini", "mistral", "openai", "anthropic", "groq"]);
});

// ── Model smoke tests ────────────────────────────────────────────────────────

test("getConfiguredLlmModelTargets returns keyed built-in and custom tier models", () => {
  const ext = initWithExt(makeExtensionAPI({
    "anthropic-api-key": "sk-ant",
    "openai-api-key": "sk-oa",
    "custom-llm-count": 1,
    "custom-llm-1-base-url": "http://localhost:1234/v1",
    "custom-llm-1-mini-model": "mini-local",
    "custom-llm-1-power-model": "power-local",
    "custom-llm-1-ludicrous-model": "power-local",
  }));
  const targets = getConfiguredLlmModelTargets(ext);
  assert.deepEqual(
    targets.map(t => `${t.provider}:${t.tier}:${t.model}`),
    [
      `anthropic:mini:${getLlmModel(ext, "anthropic")}`,
      `anthropic:power:${getPowerModel(ext, "anthropic")}`,
      `anthropic:ludicrous:${getLudicrousModel(ext, "anthropic")}`,
      `openai:mini:${getLlmModel(ext, "openai")}`,
      `openai:power:${getPowerModel(ext, "openai")}`,
      `openai:ludicrous:${getLudicrousModel(ext, "openai")}`,
      "custom-1:mini:mini-local",
      "custom-1:power:power-local",
      "custom-1:ludicrous:power-local",
    ]
  );
});

test("classifyModelSmokeError marks missing/deprecated model errors as invalid_model", () => {
  assert.deepEqual(
    classifyModelSmokeError(new Error("API error 404: model gpt-old does not exist or is deprecated")),
    { status: "invalid_model", retryable: false }
  );
  assert.deepEqual(
    classifyModelSmokeError(new Error("rate limit hit")),
    { status: "rate_limited", retryable: true }
  );
  assert.deepEqual(
    classifyModelSmokeError(new Error("API error 401: bad key")),
    { status: "auth_error", retryable: false }
  );
});

test("smokeTestConfiguredLlmModels calls each target and records invalid models without throwing", async () => {
  const ext = initWithExt(makeExtensionAPI({
    "openai-api-key": "sk-oa",
  }));
  const calls = [];
  const results = await smokeTestConfiguredLlmModels(ext, {
    targets: [
      { provider: "openai", tier: "mini", model: "good-model", apiKey: "sk-oa" },
      { provider: "openai", tier: "power", model: "bad-model", apiKey: "sk-oa" },
    ],
    callFn: async ({ provider, model, messages, tools, options }) => {
      calls.push({ provider, model, messages, tools, options });
      if (model === "bad-model") throw new Error("OpenAI API error 404: model does not exist");
      return { choices: [{ message: { content: "OK" } }] };
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].messages[0].content, "OK");
  assert.deepEqual(calls[0].tools, []);
  assert.equal(results.results[0].status, "ok");
  assert.equal(results.results[1].status, "invalid_model");
  assert.match(results.results[1].message, /does not exist/);
});

test("summariseModelSmokeResults reports invalid models for settings UI", () => {
  const summary = summariseModelSmokeResults({
    finishedAt: "2026-06-17T00:00:00.000Z",
    results: [
      { status: "ok", provider: "openai", tier: "mini", model: "good" },
      { status: "invalid_model", provider: "gemini", tier: "power", model: "bad" },
      { status: "skipped", provider: "groq", tier: "mini", model: "llama" },
    ],
  });
  assert.match(summary, /Last checked/);
  assert.match(summary, /1 OK/);
  assert.match(summary, /1 invalid/);
  assert.match(summary, /gemini\/power bad/);
});

// ── ChatGPT subscription (openai-codex) provider ─────────────────────────────

const codexDeps = (connected) => ({
  isCodexConnected: () => connected,
  getValidCodexToken: async () => ({ accessToken: "sub_at", accountId: "acct_7" }),
  getCodexInstructions: async () => "OFFICIAL CODEX PROMPT",
  LLM_STREAM_CHUNK_TIMEOUT_MS: 60_000,
});

test("isCodexProvider detects the codex id only", () => {
  assert.equal(isCodexProvider(CODEX_PROVIDER_ID), true);
  assert.equal(isCodexProvider("openai"), false);
  assert.equal(isCodexProvider("custom-1"), false);
  assert.equal(isCodexProvider(null), false);
});

test("codex is NOT in BUILTIN_LLM_PROVIDERS or failover chains", () => {
  assert.equal(BUILTIN_LLM_PROVIDERS.includes(CODEX_PROVIDER_ID), false);
  const ext = initWithExt(makeExtensionAPI(), codexDeps(true));
  for (const tier of ["mini", "power", "ludicrous"]) {
    assert.equal(buildEffectiveFailoverChain(ext, tier).includes(CODEX_PROVIDER_ID), false);
  }
});

test("getApiKeyForProvider returns placeholder when connected, empty when not", () => {
  const ext = initWithExt(makeExtensionAPI(), codexDeps(true));
  assert.equal(getApiKeyForProvider(ext, CODEX_PROVIDER_ID), "chatgpt-subscription");
  initWithExt(ext, codexDeps(false));
  assert.equal(getApiKeyForProvider(ext, CODEX_PROVIDER_ID), "");
});

test("getValidProviders includes codex only when connected", () => {
  const ext = initWithExt(makeExtensionAPI(), codexDeps(true));
  assert.ok(getValidProviders(ext).includes(CODEX_PROVIDER_ID));
  initWithExt(ext, codexDeps(false));
  assert.equal(getValidProviders(ext).includes(CODEX_PROVIDER_ID), false);
});

test("getLlmProvider round-trips a saved openai-codex selection even when disconnected", () => {
  const ext = initWithExt(makeExtensionAPI({ "llm-provider": "openai-codex" }), codexDeps(false));
  assert.equal(getLlmProvider(ext), "openai-codex");
});

test("codex is zero-cost and OpenAI-compatible; tiers mirror the openai API lineup", () => {
  const ext = initWithExt(makeExtensionAPI(), codexDeps(true));
  assert.deepEqual(getModelCostRates("gpt-5.5", CODEX_PROVIDER_ID), { inputPerM: 0, outputPerM: 0 });
  assert.equal(isOpenAICompatible(CODEX_PROVIDER_ID), true);
  assert.equal(getLlmModel(ext, CODEX_PROVIDER_ID), "gpt-5.6-luna");
  assert.equal(getPowerModel(ext, CODEX_PROVIDER_ID), "gpt-5.6-terra");
  assert.equal(getLudicrousModel(ext, CODEX_PROVIDER_ID), "gpt-5.6-sol");
});

test("failover works FROM codex to keyed providers; codex is never a failover TARGET", () => {
  const ext = initWithExt(
    makeExtensionAPI({ "openai-api-key": "sk-x", "gemini-api-key": "g-x" }),
    codexDeps(true)
  );
  const fromCodex = getFailoverProviders(CODEX_PROVIDER_ID, ext, "mini");
  assert.deepEqual(fromCodex, ["gemini", "openai"]); // chain order, keyed only
  const fromGemini = getFailoverProviders("gemini", ext, "mini");
  assert.equal(fromGemini.includes(CODEX_PROVIDER_ID), false);
});

function sseResponse(events) {
  const text = events.map((e) => `data: ${JSON.stringify(e)}\n`).join("\n") + "\n";
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }),
  };
}

test("callCodexResponsesStreaming: headers, streamed text, tool call, mapped usage", async (t) => {
  const ext = initWithExt(makeExtensionAPI(), codexDeps(true));
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, opts) => {
    captured = { url: String(url), opts };
    return sseResponse([
      { type: "response.output_text.delta", delta: "Hello " },
      { type: "response.output_text.delta", delta: "world" },
      { type: "response.output_item.done", item: { type: "function_call", call_id: "c1", name: "roam_search", arguments: "{\"query\":\"x\"}" } },
      { type: "response.completed", response: { usage: { input_tokens: 42, output_tokens: 7 } } },
    ]);
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const chunks = [];
  const result = await callCodexResponsesStreaming(
    "gpt-5.5", "system prompt", [{ role: "user", content: "hi" }],
    [{ name: "roam_search", description: "d", input_schema: { type: "object" } }],
    (d) => chunks.push(d)
  );

  assert.match(captured.url, /^https:\/\/proxy\.example\/https:\/\/chatgpt\.com\/backend-api\/codex\/responses$/);
  assert.equal(captured.opts.headers.Authorization, "Bearer sub_at");
  assert.equal(captured.opts.headers["chatgpt-account-id"], "acct_7");
  assert.equal(captured.opts.headers["OpenAI-Beta"], "responses=experimental");
  assert.equal(captured.opts.headers.originator, "codex_cli_rs");
  const body = JSON.parse(captured.opts.body);
  assert.equal(body.instructions, "OFFICIAL CODEX PROMPT"); // codex backend rejects arbitrary instructions
  assert.equal(body.input[0].role, "developer");
  assert.equal(body.input[0].content[0].text, "system prompt"); // host system prompt rides in input
  assert.equal(body.store, false);
  assert.equal(body.max_output_tokens, undefined); // unsupported by codex backend
  assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
  assert.equal(body.tools[0].name, "roam_search"); // flat, not nested

  assert.equal(result.textContent, "Hello world");
  assert.deepEqual(chunks, ["Hello ", "world"]);
  assert.deepEqual(result.toolCalls, [{ id: "c1", name: "roam_search", arguments: { query: "x" } }]);
  assert.deepEqual(result.usage, { prompt_tokens: 42, completion_tokens: 7, total_tokens: 49 });
});

test("callCodexResponsesStreaming: 429 surfaces the weekly-cap message", async (t) => {
  initWithExt(makeExtensionAPI(), codexDeps(true));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false, status: 429,
    headers: { get: (h) => (h === "retry-after" ? "3600" : null) },
    text: async () => "quota exceeded",
  });
  t.after(() => { globalThis.fetch = originalFetch; });
  await assert.rejects(
    callCodexResponsesStreaming("gpt-5.5", "s", [], [], null),
    /weekly usage cap.*not an API rate limit/s
  );
});

test("callCodexResponsesStreaming: dead/missing token error surfaces before any fetch", async (t) => {
  initWithExt(makeExtensionAPI(), {
    ...codexDeps(true),
    getValidCodexToken: async () => { throw new Error("ChatGPT subscription auth expired (HTTP 400). Reconnect via command palette."); },
  });
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => { fetchCount++; return {}; };
  t.after(() => { globalThis.fetch = originalFetch; });
  await assert.rejects(callCodexResponsesStreaming("gpt-5.5", "s", [], [], null), /expired.*Reconnect/s);
  assert.equal(fetchCount, 0);
});

test("callLlm wraps codex streaming into chat-completions response shape", async (t) => {
  initWithExt(makeExtensionAPI(), codexDeps(true));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => sseResponse([
    { type: "response.output_text.delta", delta: "answer" },
    { type: "response.output_item.done", item: { type: "function_call", call_id: "c2", name: "t", arguments: "{}" } },
    { type: "response.completed", response: { usage: { input_tokens: 1, output_tokens: 2 } } },
  ]);
  t.after(() => { globalThis.fetch = originalFetch; });
  const { callLlm } = await import("../src/llm-providers.js");
  const res = await callLlm(CODEX_PROVIDER_ID, "ignored", "gpt-5.5", "s", [], []);
  assert.equal(res.choices[0].message.content, "answer");
  assert.equal(res.choices[0].message.tool_calls[0].function.name, "t");
  assert.equal(res.usage.prompt_tokens, 1);
});

// ── callAnthropic: Sonnet 5 / Opus 5 thinking gate ───────────────────────────

test("callAnthropic pins thinking off on Sonnet 5 and Opus 5, leaves other models untouched", async (t) => {
  initWithExt(makeExtensionAPI());
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, opts) => {
    captured = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ content: [] }) };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  // Sonnet 5 and Opus 5 default to adaptive thinking when the field is omitted —
  // billed, and counted against max_tokens — so the request must pin it off.
  await callAnthropic("sk-x", "claude-sonnet-5", "sys", [], []);
  assert.deepEqual(captured.thinking, { type: "disabled" });
  await callAnthropic("sk-x", "claude-opus-5", "sys", [], []);
  assert.deepEqual(captured.thinking, { type: "disabled" });

  // Pre-5 models keep today's shape (no thinking field at all).
  await callAnthropic("sk-x", "claude-opus-4-8", "sys", [], []);
  assert.equal(captured.thinking, undefined);
  await callAnthropic("sk-x", "claude-haiku-4-5", "sys", [], []);
  assert.equal(captured.thinking, undefined);
});

// ── Kimi Code / DeepSeek / Ollama providers ───────────────────────────────────

test("kimi-coding endpoint routes through the proxied kimi.com/coding host", () => {
  initWithExt(makeExtensionAPI());
  assert.equal(
    resolveOpenAIEndpoint("kimi-coding"),
    "https://proxy.example/https://api.kimi.com/coding/v1/chat/completions"
  );
});

test("deepseek endpoint routes through the proxied api.deepseek.com host", () => {
  initWithExt(makeExtensionAPI());
  assert.equal(
    resolveOpenAIEndpoint("deepseek"),
    "https://proxy.example/https://api.deepseek.com/v1/chat/completions"
  );
});

test("getApiKeyForProvider reads kimi-coding-api-key and deepseek-api-key", () => {
  const ext = initWithExt(makeExtensionAPI({
    "kimi-coding-api-key": "kc-key",
    "deepseek-api-key": "ds-key",
  }));
  assert.equal(getApiKeyForProvider(ext, "kimi-coding"), "kc-key");
  assert.equal(getApiKeyForProvider(ext, "deepseek"), "ds-key");
});

test("kimi-coding falls back to a sk-kimi… Moonshot key when the dedicated key is empty", () => {
  const ext = initWithExt(makeExtensionAPI({
    "kimi-api-key": "sk-kimi-some-machine-key",
    // kimi-coding-api-key intentionally blank
  }));
  assert.equal(getApiKeyForProvider(ext, "kimi-coding"), "sk-kimi-some-machine-key");
});

test("kimi (Moonshot) ignores a sk-kimi… key so /kimi asks for a real Moonshot key", () => {
  const ext = initWithExt(makeExtensionAPI({
    "kimi-api-key": "sk-kimi-some-machine-key",
  }));
  assert.equal(getApiKeyForProvider(ext, "kimi"), "");
});

test("built-in model getters return kimi-coding, deepseek, ollama tier defaults", () => {
  const ext = initWithExt(makeExtensionAPI());
  assert.equal(getLlmModel(ext, "kimi-coding"), "kimi-for-coding");
  assert.equal(getPowerModel(ext, "kimi-coding"), "kimi-for-coding");
  assert.equal(getLudicrousModel(ext, "kimi-coding"), "kimi-for-coding-highspeed");
  assert.equal(getLlmModel(ext, "deepseek"), "deepseek-chat");
  assert.equal(getPowerModel(ext, "deepseek"), "deepseek-reasoner");
  assert.equal(getLudicrousModel(ext, "deepseek"), "deepseek-reasoner");
  assert.equal(getLlmModel(ext, "ollama"), "deepseek-v4-flash");
  assert.equal(getPowerModel(ext, "ollama"), "deepseek-v4-pro");
  assert.equal(getLudicrousModel(ext, "ollama"), "glm-5.2");
});

// ── Ollama base URL + key + model overrides ──────────────────────────────────

test("ollama localhost empty key → lm-studio-no-auth; cloud empty key → empty string", () => {
  const localExt = initWithExt(makeExtensionAPI({
    "ollama-base-url": "http://127.0.0.1:11434/v1",
    // ollama-api-key intentionally blank
  }));
  assert.equal(getApiKeyForProvider(localExt, "ollama"), "lm-studio-no-auth");

  const cloudExt = initWithExt(makeExtensionAPI({
    "ollama-base-url": "https://ollama.com/v1",
    // ollama-api-key intentionally blank
  }));
  assert.equal(getApiKeyForProvider(cloudExt, "ollama"), "");

  // Default base URL (omitted setting) is the Ollama Cloud default.
  const defaultExt = initWithExt(makeExtensionAPI());
  assert.equal(getApiKeyForProvider(defaultExt, "ollama"), "");
});

test("ollama endpoint: localhost base goes direct; cloud base goes through the proxy", () => {
  const localExt = initWithExt(makeExtensionAPI({
    "ollama-base-url": "http://127.0.0.1:11434/v1",
  }));
  assert.equal(resolveOpenAIEndpoint("ollama"), "http://127.0.0.1:11434/v1/chat/completions");

  const cloudExt = initWithExt(makeExtensionAPI({
    "ollama-base-url": "https://ollama.com/v1",
  }));
  assert.equal(
    resolveOpenAIEndpoint("ollama"),
    "https://proxy.example/https://ollama.com/v1/chat/completions"
  );

  // Default base URL (omitted setting) is Ollama Cloud → proxied.
  const defaultExt = initWithExt(makeExtensionAPI());
  assert.equal(
    resolveOpenAIEndpoint("ollama"),
    "https://proxy.example/https://ollama.com/v1/chat/completions"
  );
});

test("ollama per-tier model settings override the aibom defaults when non-empty", () => {
  const ext = initWithExt(makeExtensionAPI({
    "ollama-mini-model": "local-mini",
    "ollama-power-model": "local-power",
    "ollama-ludicrous-model": "local-ludi",
  }));
  assert.equal(getLlmModel(ext, "ollama"), "local-mini");
  assert.equal(getPowerModel(ext, "ollama"), "local-power");
  assert.equal(getLudicrousModel(ext, "ollama"), "local-ludi");
});

test("getOpenAiApiKey does not treat a legacy sk- key as OpenAI for kimi-coding or deepseek", () => {
  const kcExt = initWithExt(makeExtensionAPI({
    "llm-provider": "kimi-coding",
    "llm-api-key": "sk-kimi-key",
  }));
  assert.equal(getOpenAiApiKey(kcExt), "");
  const dsExt = initWithExt(makeExtensionAPI({
    "llm-provider": "deepseek",
    "llm-api-key": "sk-deepseek-key",
  }));
  assert.equal(getOpenAiApiKey(dsExt), "");
});
// ── Timed-block tool pack (filterToolsByRelevance + dropBypassToolsForTimedBlock)

const TIMED_BLOCK_TOOLS = [
  { name: "cos_schedule_block" },
  { name: "roam_create_block" },
  { name: "roam_create_blocks" },
  { name: "roam_batch_write" },
  { name: "roam_create_todo" },
  { name: "roam_update_block" },
  { name: "roam_search" },
  { name: "roam_get_page" },
  { name: "ROAM_ROUTE" },
  { name: "cos_cron_create" },
];

test("timed-block prompt: bypass + cron tools dropped, cos_schedule_block kept", () => {
  initLlmProviders({ debugLog: () => {} });
  const out = filterToolsByRelevance(
    TIMED_BLOCK_TOOLS,
    "schedule a gaming session 9pm to midnight [sandbox]"
  );
  const names = out.map((t) => t.name);
  assert.ok(!names.includes("roam_create_block"), "roam_create_block must be dropped");
  assert.ok(!names.includes("roam_create_blocks"), "roam_create_blocks must be dropped");
  assert.ok(!names.includes("roam_batch_write"), "roam_batch_write must be dropped");
  assert.ok(!names.includes("roam_create_todo"), "roam_create_todo must be dropped");
  assert.ok(!names.includes("roam_update_block"), "roam_update_block must be dropped");
  assert.ok(!names.includes("cos_cron_create"), "bare 'schedule' must not pull in cos_cron_*");
  assert.ok(names.includes("cos_schedule_block"));
  assert.ok(names.includes("roam_search"));
  assert.ok(names.includes("roam_get_page"));
  assert.ok(names.includes("ROAM_ROUTE"));
});

test("cron prompt: cos_cron_create still present", () => {
  initLlmProviders({ debugLog: () => {} });
  const out = filterToolsByRelevance(TIMED_BLOCK_TOOLS, "schedule a cron every 5 min");
  const names = out.map((t) => t.name);
  assert.ok(names.includes("cos_cron_create"));
  // Not a one-window intent → bypass tools untouched
  assert.ok(names.includes("roam_create_block"));
});

test("calendar question: roam_create_block still present", () => {
  initLlmProviders({ debugLog: () => {} });
  const out = filterToolsByRelevance(TIMED_BLOCK_TOOLS, "what's on my calendar");
  const names = out.map((t) => t.name);
  assert.ok(names.includes("roam_create_block"));
  assert.ok(!names.includes("cos_cron_create"), "calendar reads are not cron-like");
});

test("dropBypassToolsForTimedBlock: no-op for non-slot messages and after whitelist", () => {
  initLlmProviders({ debugLog: () => {} });
  // Non-slot message → identity
  assert.equal(dropBypassToolsForTimedBlock(TIMED_BLOCK_TOOLS, "hello there"), TIMED_BLOCK_TOOLS);
  // Slot message → drops even when the array came from a skill whitelist
  const whitelisted = [
    { name: "cos_schedule_block" },
    { name: "roam_create_block" }, // ROAM_CORE_TOOLS member a whitelist run keeps
    { name: "cos_cron_create" },
    { name: "roam_search" },
  ];
  const names = dropBypassToolsForTimedBlock(
    whitelisted,
    "schedule gaming 9pm to midnight [sandbox]"
  ).map((t) => t.name);
  assert.deepEqual(names, ["cos_schedule_block", "roam_search"]);
});
