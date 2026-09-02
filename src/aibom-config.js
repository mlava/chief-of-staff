export const LLM_API_ENDPOINTS = {
  anthropic: "https://api.anthropic.com/v1/messages",
  openai: "https://api.openai.com/v1/chat/completions",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  mistral: "https://api.mistral.ai/v1/chat/completions",
  groq: "https://api.groq.com/openai/v1/chat/completions",
  grok: "https://api.x.ai/v1/chat/completions",
  kimi: "https://api.moonshot.ai/v1/chat/completions",
  // Kimi Code (kimi.com/code) — separate OpenAI-compatible host. Keys
  // starting with `sk-kimi` 401 on api.moonshot.ai but 200 on api.kimi.com/coding/v1.
  "kimi-coding": "https://api.kimi.com/coding/v1/chat/completions",
  deepseek: "https://api.deepseek.com/v1/chat/completions",
  // Ollama endpoint is resolved at runtime against the `ollama-base-url`
  // setting (default Ollama Cloud, local http://127.0.0.1:11434/v1). See
  // resolveOpenAIEndpoint in llm-providers.js.
  ollama: "https://ollama.com/v1/chat/completions",
  // ChatGPT-subscription (Codex device OAuth) — Responses API, not chat
  // completions. Single swap point if the Roam CORS proxy can't pass it.
  "openai-codex": "https://chatgpt.com/backend-api/codex/responses"
};

export const DEFAULT_LLM_MODELS = {
  anthropic: "claude-haiku-4-5",
  // Luna: small model of the 5.6 family (no 5.6-mini/nano exists), repriced
  // 2026-07-31 to $0.20/$1.20 — 73% cheaper than gpt-5.4-mini ($0.75/$4.50).
  // Tool-call reliability unproven at swap time; auto-escalation is the net.
  openai: "gpt-5.6-luna",
  gemini: "gemini-3.1-flash-lite",
  mistral: "mistral-small-latest",
  groq: "llama-3.3-70b-versatile",
  grok: "grok-4.3",
  kimi: "kimi-k2.5",
  // Kimi Code: one model id serves mini and power tiers; the highspeed
  // variant is the ludicrous-tier upgrade.
  "kimi-coding": "kimi-for-coding",
  deepseek: "deepseek-chat",
  // Ollama Cloud defaults — overridable via ollama-mini-model /
  // ollama-power-model / ollama-ludicrous-model settings (llm-providers.js).
  ollama: "deepseek-v4-flash",
  // Mirrors the openai API tiers — the codex backend accepts the general
  // lineup (confirmed via Hermes model picker), and lighter models preserve
  // the subscription's weekly quota on trivial queries.
  "openai-codex": "gpt-5.6-luna"
};

export const POWER_LLM_MODELS = {
  // Sonnet 5: near-Opus agentic quality at sonnet-4-6's sticker price
  // ($2/$10 intro through 2026-08-31). callAnthropic pins thinking off for it.
  anthropic: "claude-sonnet-5",
  openai: "gpt-5.6-terra",
  // 3.6-flash: newer stable, same input as 3.5-flash, 17% cheaper output ($7.50 vs $9.00)
  gemini: "gemini-3.6-flash",
  mistral: "mistral-medium-latest",
  groq: "llama-3.3-70b-versatile",
  grok: "grok-4.6",
  kimi: "kimi-k2.7-code",
  "kimi-coding": "kimi-for-coding",
  deepseek: "deepseek-reasoner",
  ollama: "deepseek-v4-pro",
  "openai-codex": "gpt-5.6-terra"
};

export const LUDICROUS_LLM_MODELS = {
  // Opus 5: strict upgrade over Opus 4.8 at identical $5/$25. Thinking is pinned
  // off in callAnthropic so the 8,192-token budget stays available for output.
  anthropic: "claude-opus-5",
  openai: "gpt-5.6-sol",
  gemini: "gemini-3.1-pro-preview-customtools",
  mistral: "mistral-medium-latest",
  groq: "llama-3.3-70b-versatile",
  grok: "grok-4.6",
  kimi: "kimi-k3",
  "kimi-coding": "kimi-for-coding-highspeed",
  deepseek: "deepseek-reasoner",
  ollama: "glm-5.2",
  "openai-codex": "gpt-5.6-sol"
};
