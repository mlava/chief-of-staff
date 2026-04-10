// ── Intent Classifier ─────────────────────────────────────────────────────
// Lightweight LLM-based intent classification with confidence scoring.
// Inserted between tier routing and the agent loop. Low-confidence or
// high-risk queries trigger clarification/confirmation before token burn.
// Non-blocking, non-fatal — all errors fall through to normal agent loop.

let deps = {};

export function initIntentClassifier(injected) { deps = injected; }

// ── Constants ─────────────────────────────────────────────────────────────

const CLASSIFICATION_MAX_OUTPUT_TOKENS = 200;

const CLASSIFICATION_SYSTEM_PROMPT = `You are an intent classifier for a Roam Research AI assistant. Given the user's message and context, determine what they want done.

Respond with ONLY a JSON object:
{"intent":"<1-sentence description>","confidence":<0.0-1.0>,"ambiguity":"<null or what's unclear>","estimated_tools":<number>,"risk":"<low|medium|high>","interpretations":["<alt 1>","<alt 2>"]}

Risk: low=read-only/chat, medium=writing 1-2 pages/email drafts, high=bulk mutations/sending emails/>5 tools.
Include 2-3 "interpretations" only when confidence < 0.60. Otherwise set to null.`;

// ── Skip Condition Helpers ────────────────────────────────────────────────

const SIMPLE_READ_PATTERN = /^(what|show|check|get|list|how many|when|where)\b.{0,60}$/i;
const CONJUNCTION_PATTERN = /\b(and then|also|after that|then also|as well as)\b/i;
const TEMPORAL_SCOPE_SHIFT = /\b(next|last|previous|this|other|different|instead|also|but)\s+(week|month|day|year|quarter|time|one|project|page)\b/i;
const SCOPE_CHANGE_PATTERN = /\b(same\s+for|do\s+that\s+for|now\s+do|repeat\s+for)\b/i;

/**
 * Checks whether a follow-up prompt contains a temporal or scope shift
 * that makes it ambiguous despite being short.
 * @param {string} prompt
 * @returns {boolean}
 */
export function hasTemporalScopeShift(prompt) {
  return TEMPORAL_SCOPE_SHIFT.test(prompt) || SCOPE_CHANGE_PATTERN.test(prompt);
}

/**
 * Determines whether the intent classification LLM call should be skipped.
 * Pure function — no side effects, fully testable.
 *
 * @param {string} prompt
 * @param {object} options
 * @returns {{ skip: boolean, reason: string }}
 */
export function shouldSkipClassification(prompt, options = {}) {
  const {
    hasContext = false,
    conversationTurnCount = 0,
    effectiveTier = "mini",
    ludicrousFlag = false,
    powerFlag = false,
    lessonFlag = false,
    routingMatchedSkill = null,
    routingSkillMatchScore = 0,
  } = options;

  // 1. User explicitly chose a non-mini tier
  if (effectiveTier !== "mini" || ludicrousFlag || powerFlag) {
    return { skip: true, reason: "explicit-tier-override" };
  }

  // 2. Lesson mode
  if (lessonFlag) {
    return { skip: true, reason: "lesson-mode" };
  }

  // 3. Tier routing already matched a skill with decent confidence
  if (routingMatchedSkill && routingSkillMatchScore >= 0.5) {
    return { skip: true, reason: "skill-match" };
  }

  // 4. Short follow-up in an established conversation (without scope change)
  const wordCount = prompt.trim().split(/\s+/).length;
  if (hasContext && conversationTurnCount > 0 && wordCount < 15 && !hasTemporalScopeShift(prompt)) {
    return { skip: true, reason: "follow-up" };
  }

  // 5. Simple read query (single-intent, no conjunctions)
  if (SIMPLE_READ_PATTERN.test(prompt.trim()) && !CONJUNCTION_PATTERN.test(prompt)) {
    return { skip: true, reason: "simple-read" };
  }

  return { skip: false, reason: "" };
}

// ── Confidence Evaluation ─────────────────────────────────────────────────

/**
 * Evaluates a classification result and determines the action to take.
 * Pure function — no side effects, fully testable.
 *
 * @param {object} classification - { confidence: number, risk: string }
 * @returns {{ action: "proceed"|"confirm"|"clarify", reason: string }}
 */
export function evaluateConfidence(classification) {
  const { confidence = 0, risk = "low" } = classification || {};

  // High confidence — auto-proceed regardless of risk
  if (confidence >= 0.85) {
    return { action: "proceed", reason: "high-confidence" };
  }

  // Medium confidence
  if (confidence >= 0.60) {
    if (risk === "low") {
      return { action: "proceed", reason: "medium-confidence-low-risk" };
    }
    return { action: "confirm", reason: "medium-confidence-elevated-risk" };
  }

  // Low confidence — always clarify
  return { action: "clarify", reason: "low-confidence" };
}

// ── Classification Prompt Building ────────────────────────────────────────

/**
 * Builds the user message for the classification LLM call.
 * Exported for testing.
 *
 * @param {string} prompt
 * @param {object} options
 * @returns {string}
 */
export function buildClassificationUserMessage(prompt, options = {}) {
  const { skillNames = [], recentTurnsSummary = null } = options;

  let msg = `User message: ${prompt}`;

  if (recentTurnsSummary) {
    msg += `\nConversation context (last 2 turns): ${recentTurnsSummary}`;
  }

  const skills = Array.isArray(skillNames) && skillNames.length > 0
    ? skillNames.join(", ")
    : "none";
  msg += `\nAvailable skills: ${skills}`;
  msg += "\nTool categories: Roam graph, tasks, calendar, email, memory, web fetch, MCP integrations";

  return msg;
}

// ── Response Parsing ──────────────────────────────────────────────────────

const VALID_RISK_VALUES = new Set(["low", "medium", "high"]);

/**
 * Parses and validates the classification JSON from the LLM response text.
 * @param {string} text
 * @returns {object|null}
 */
function parseClassificationResponse(text) {
  let str = String(text || "").trim();

  // Strip markdown code fences if the model wrapped its JSON.
  // Haiku in particular sometimes returns ```json\n{...}\n``` despite
  // being instructed to return raw JSON. Strip the fence then parse.
  const fenceMatch = str.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```\s*$/i);
  if (fenceMatch) {
    str = fenceMatch[1].trim();
  }

  // Try direct JSON parse first (clean response, or de-fenced)
  let parsed = null;
  try {
    parsed = JSON.parse(str);
  } catch (_) {
    // Fall back to extractBalancedJsonObjects (handles stray prose/preamble)
    const objects = deps.extractBalancedJsonObjects(str);
    if (objects.length > 0) {
      parsed = objects[0].parsed;
    }
  }

  if (!parsed || typeof parsed !== "object") return null;

  // Validate required fields
  if (typeof parsed.intent !== "string" || !parsed.intent) return null;
  if (typeof parsed.confidence !== "number" || parsed.confidence < 0 || parsed.confidence > 1) return null;
  if (typeof parsed.estimated_tools !== "number" || parsed.estimated_tools < 0) return null;
  if (!VALID_RISK_VALUES.has(parsed.risk)) return null;

  return {
    intent: parsed.intent,
    confidence: parsed.confidence,
    ambiguity: parsed.ambiguity || null,
    estimatedTools: Math.round(parsed.estimated_tools),
    risk: parsed.risk,
    interpretations: Array.isArray(parsed.interpretations)
      ? parsed.interpretations.filter(i => typeof i === "string" && i.trim())
      : null,
  };
}

// ── Module State ──────────────────────────────────────────────────────────

let cachedClassification = null;

export function clearIntentCache() { cachedClassification = null; }
export function getCachedClassification() { return cachedClassification; }

// ── Main Classification ───────────────────────────────────────────────────

/**
 * Classifies user intent via a single mini-tier LLM call.
 * Returns null on any error (never blocks the agent loop).
 *
 * @param {string} prompt
 * @param {object} options
 * @returns {Promise<object|null>}
 */
export async function classifyIntent(prompt, options = {}) {
  try {
    // Check feature toggle
    const extensionAPI = deps.getExtensionAPIRef();
    if (!extensionAPI) return null;
    const enabled = deps.getSettingBool(extensionAPI, deps.SETTINGS_KEYS.intentGateEnabled, false);
    if (!enabled) {
      return { skipped: true, skipReason: "feature-disabled" };
    }

    // Return cached result if prompt hasn't changed (failover restart)
    if (cachedClassification && cachedClassification._prompt === prompt) {
      return cachedClassification;
    }

    // Check skip conditions (pure, no LLM call)
    const skipCheck = shouldSkipClassification(prompt, options);
    if (skipCheck.skip) {
      deps.recordUsageStat("intentSkipped");
      const result = { skipped: true, skipReason: skipCheck.reason };
      cachedClassification = { ...result, _prompt: prompt };
      return result;
    }

    // Select provider — same provider + mini model as user's configured
    const provider = deps.getLlmProvider(extensionAPI);
    if (deps.isProviderCoolingDown(provider)) {
      deps.debugLog("[Intent] Provider on cooldown, skipping classification.");
      return null;
    }
    const apiKey = deps.getApiKeyForProvider(extensionAPI, provider);
    if (!apiKey) {
      deps.debugLog("[Intent] No API key for provider, skipping classification.");
      return null;
    }
    const model = deps.getLlmModel(extensionAPI, provider);

    // Build classification messages
    const userMessage = buildClassificationUserMessage(prompt, options);

    deps.debugLog("[Intent] Classifying intent:", provider, model);

    // Single LLM call — no tools, short output
    const response = await deps.callLlm(
      provider,
      apiKey,
      model,
      CLASSIFICATION_SYSTEM_PROMPT,
      [{ role: "user", content: userMessage }],
      [], // no tools
      { maxOutputTokens: CLASSIFICATION_MAX_OUTPUT_TOKENS }
    );

    // Extract text from response (provider-agnostic)
    let responseText = "";
    if (deps.isOpenAICompatible(provider)) {
      responseText = response?.choices?.[0]?.message?.content || "";
    } else {
      // Anthropic format
      const textBlocks = (response?.content || []).filter(b => b.type === "text");
      responseText = textBlocks.map(b => b.text).join("") || "";
    }

    // Track cost
    const usage = response?.usage || {};
    const inputTokens = usage.input_tokens || usage.prompt_tokens || 0;
    const outputTokens = usage.output_tokens || usage.completion_tokens || 0;
    const costRates = deps.getModelCostRates(model);
    const cost = (inputTokens / 1_000_000 * costRates.inputPerM)
      + (outputTokens / 1_000_000 * costRates.outputPerM);
    deps.recordCostEntry("intent-" + model, inputTokens, outputTokens, cost);
    deps.accumulateSessionTokens(inputTokens, outputTokens, cost);

    // Parse classification
    const classification = parseClassificationResponse(responseText);
    if (!classification) {
      deps.debugLog("[Intent] Failed to parse classification from:", responseText.slice(0, 200));
      return null;
    }

    // Record stat and cache
    deps.recordUsageStat("intentClassifications");
    cachedClassification = { ...classification, skipped: false, skipReason: null, _prompt: prompt };
    return cachedClassification;

  } catch (err) {
    deps.debugLog("[Intent] Classification failed (non-fatal):", err?.message || err);
    return null;
  }
}
