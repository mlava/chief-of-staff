export const LLM_API_ENDPOINTS = {
  anthropic: "https://api.anthropic.com/v1/messages",
  openai: "https://api.openai.com/v1/chat/completions",
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
  mistral: "https://api.mistral.ai/v1/chat/completions",
  groq: "https://api.groq.com/openai/v1/chat/completions"
};

export const DEFAULT_LLM_MODELS = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-5.4-mini",
  gemini: "gemini-3.1-flash-lite-preview",
  mistral: "mistral-small-latest",
  groq: "llama-3.3-70b-versatile"
};

export const POWER_LLM_MODELS = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-4.1",
  gemini: "gemini-3-flash-preview",
  mistral: "mistral-medium-latest",
  groq: "llama-3.3-70b-versatile"
};

export const LUDICROUS_LLM_MODELS = {
  mistral: "mistral-large-2512",
  openai: "gpt-5.4",
  gemini: "gemini-3.1-pro-preview-customtools",
  anthropic: "claude-opus-4-6",
  groq: "llama-3.3-70b-versatile"
};
