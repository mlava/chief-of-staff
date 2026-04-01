// =============================================================================
// agent-loop.js — Agent Loop + Failover Handler
// =============================================================================
// Extracted from index.js following the DI pattern from composio-ui.js and
// deterministic-router.js. Contains the core reasoning loop (runAgentLoop),
// the failover orchestrator (runAgentLoopWithFailover), escalation error
// classes, and associated module-scoped state.
//
// Pure move-and-wire refactoring — no behaviour changes.
//
// DI pattern: call initAgentLoop(deps) once from onload().
// =============================================================================

// ── Direct imports from already-extracted modules ───────────────────────────

import {
  formatAssistantMessage, extractToolCalls, extractTextResponse,
  executeToolCall, isExternalDataToolCall, isSuccessfulExternalToolResult,
  formatToolResults, extractComposioSessionIdFromToolResult,
  withComposioSessionArgs, convertMessagesForProvider,
  detectWrittenBlocksInMessages, detectSuccessfulWriteToolCallsInMessages,
  isLikelyLiveDataReadIntent
} from "./tool-execution.js";

import {
  callLlm, callOpenAIStreaming, getModelCostRates, getApiKeyForProvider,
  getLlmProvider, getLlmModel, getPowerModel, getLudicrousModel,
  isProviderCoolingDown, setProviderCooldown, getFailoverProviders,
  isFailoverEligibleError, isOpenAICompatible, filterToolsByRelevance
} from "./llm-providers.js";

import {
  getConversationTurns, getConversationMessages,
  getLastKnownPageContext, setLastKnownPageContext,
  approximateMessageChars, enforceAgentMessageBudgetInPlace, getAgentOverBudgetMessage,
  getSessionUsedLocalMcp, setSessionUsedLocalMcp,
  getSessionClaimedActionCount, incrementSessionClaimedActionCount
} from "./conversation.js";

import {
  detectClaimedActionWithoutToolCall
} from "./security.js";

import {
  isDailyCapExceeded, accumulateSessionTokens, recordCostEntry,
  getSessionTokenUsage, recordUsageStat
} from "./usage-tracking.js";

import { buildDefaultSystemPrompt } from "./system-prompt.js";
import { getLocalMcpToolsCache, getLocalMcpTools } from "./local-mcp.js";
import { getRemoteMcpToolsCache, getRemoteMcpTools } from "./remote-mcp.js";
import { getToolkitSchemaRegistry } from "./composio-mcp.js";
// parseSkillSources injected via deps (avoids transitive izitoast dependency from deterministic-router → chat-panel)

// ── Dependency injection ────────────────────────────────────────────────────

let deps = {};

export function initAgentLoop(injected) {
  deps = injected;
}

// ── Module-scoped state (moved from index.js) ───────────────────────────────

let lastAgentRunTrace = null;
let activeAgentAbortController = null;

// ── State accessors — used by index.js for runtime stats and cleanup ────────

export function getLastAgentRunTrace() { return lastAgentRunTrace; }
export function setLastAgentRunTrace(t) { lastAgentRunTrace = t; }
export function getActiveAgentAbortController() { return activeAgentAbortController; }

// ── Error classes ───────────────────────────────────────────────────────────

/**
 * Mitigation 3: Custom error class for "claimed action without tool call" escalation.
 * When the hallucination guard fires on a mini-tier gemini model, we throw this to
 * signal runAgentLoopWithFailover to restart at power tier instead of retrying same model.
 */
export class ClaimedActionEscalationError extends Error {
  constructor(message, context) {
    super(message);
    this.name = "ClaimedActionEscalationError";
    this.escalationContext = context || {};
  }
}

/**
 * Thrown when the model returns 0 output tokens even after a retry nudge.
 * Signals runAgentLoopWithFailover to restart at power tier.
 */
export class EmptyResponseEscalationError extends Error {
  constructor(message, context) {
    super(message);
    this.name = "EmptyResponseEscalationError";
    this.escalationContext = context || {};
  }
}

/**
 * Thrown when the live data guard fires twice on mini tier (model refuses to
 * call data tools even after a retry nudge). Escalates to power tier.
 */
export class LiveDataEscalationError extends Error {
  constructor(message, context) {
    super(message);
    this.name = "LiveDataEscalationError";
    this.escalationContext = context || {};
  }
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

/**
 * Reset module-scoped state during extension unload.
 * Mirrors the direct variable nulling that index.js onunload() previously did.
 */
export function cleanupAgentLoop() {
  if (activeAgentAbortController) {
    activeAgentAbortController.abort();
    activeAgentAbortController = null;
  }
  lastAgentRunTrace = null;
}

// ── Core agent loop ─────────────────────────────────────────────────────────

/**
 * Mitigation 1: Enhanced claimed-action detection.
 * Builds a richer pattern that includes registered extension tool names and their
 * natural-language equivalents. Returns { detected: boolean, matchedToolHint: string }.
 */

export async function runAgentLoop(userMessage, options = {}) {
  const {
    maxIterations: initialMaxIterations = deps.MAX_AGENT_ITERATIONS,
    systemPrompt = null,
    onToolCall = null,
    onToolResult = null,
    onTextChunk = null,
    powerMode = false,
    providerOverride = null,
    initialMessages = null,
    tier = null,
    gatheringGuard: initialGatheringGuard = null,
    readOnlyTools = false,
    skipApproval = false,
    carryoverWriteReplayGuard = null,
    toolWhitelist = null,
    skillBudgetUsd = null
  } = options;
  let maxIterations = initialMaxIterations;
  let gatheringGuard = initialGatheringGuard;

  const extensionAPI = deps.getExtensionAPIRef();
  if (!extensionAPI) throw new Error("Extension API not ready");

  const provider = providerOverride || getLlmProvider(extensionAPI);
  const apiKey = getApiKeyForProvider(extensionAPI, provider);
  const baseModel = getLlmModel(extensionAPI, provider);
  const effectiveTier = tier || (powerMode ? "power" : "mini");
  const model = effectiveTier === "ludicrous" ? (getLudicrousModel(provider) || getPowerModel(provider))
    : effectiveTier === "power" ? getPowerModel(provider)
      : baseModel;
  const maxOutputTokens = effectiveTier === "ludicrous" ? deps.LUDICROUS_MAX_OUTPUT_TOKENS
    : effectiveTier === "power" ? deps.SKILL_MAX_OUTPUT_TOKENS
      : deps.getVerbosityMaxOutputTokens(extensionAPI);
  if (!apiKey) {
    throw new Error("No LLM API key configured. Set it in Chief of Staff settings.");
  }

  const allTools = await deps.getAvailableToolSchemas();
  let tools;
  if (readOnlyTools) {
    tools = allTools.filter(t => deps.INBOX_READ_ONLY_TOOL_ALLOWLIST.has(t.name) || t.isMutating === false);
  } else if (toolWhitelist) {
    // Per-skill tool whitelist: only include whitelisted tools + always-available core tools
    tools = allTools.filter(t =>
      toolWhitelist.has(t.name) || t.name.startsWith("cos_") || deps.ROAM_CORE_TOOLS.has(t.name)
    );
  } else {
    tools = filterToolsByRelevance(allTools, userMessage);
  }

  const readOnlyAddendum = readOnlyTools
    ? `\n\nIMPORTANT: You are running in read-only mode (triggered by an inbox item). You can search, read, and gather information, but you CANNOT create, update, move, or delete any blocks, send emails, or perform any mutating actions. Summarise your findings clearly. The human will review and act on your summary.`
    : "";
  const system = (systemPrompt || await buildDefaultSystemPrompt(userMessage)) + readOnlyAddendum;

  // Build messages array: use carried-over messages (failover) or build fresh
  let messages;
  let prunablePrefixCount = 0;
  if (initialMessages) {
    messages = [...initialMessages];
    // For carried-over context, nothing is prunable — it's all essential
  } else {
    const priorMessages = getConversationMessages();

    // Page-change detection: if the user navigated since the last turn, inject a notice
    // so the LLM knows previous page-specific results (reading time, word count, etc.) are stale.
    const currentPageCtx = await deps.getCurrentPageContext();
    let pageChangeNotice = "";
    const prevPageCtx = getLastKnownPageContext();
    if (priorMessages.length > 0 && prevPageCtx && currentPageCtx) {
      if (currentPageCtx.uid !== prevPageCtx.uid) {
        pageChangeNotice = `[Note: The user has navigated to a different page since the last message. Previous page: "${prevPageCtx.title}" (${prevPageCtx.uid}). Current page: "${currentPageCtx.title}" (${currentPageCtx.uid}). Any previous tool results about page content are now stale — call tools again for the current page.]`;
        deps.debugLog("[Chief flow] Page change detected:", prevPageCtx.uid, "→", currentPageCtx.uid);
      }
    }
    if (currentPageCtx) setLastKnownPageContext({ uid: currentPageCtx.uid, title: currentPageCtx.title });

    const effectiveUserMessage = pageChangeNotice ? `${pageChangeNotice}\n\n${userMessage}` : userMessage;
    messages = [...priorMessages, { role: "user", content: effectiveUserMessage }];
    prunablePrefixCount = priorMessages.length;
  }
  const requiresLiveDataTool = isLikelyLiveDataReadIntent(userMessage, { sessionUsedLocalMcp: getSessionUsedLocalMcp() });
  // On failover (Mode A carryover), the carried-over messages already contain tool results
  // from the previous provider's loop. Pre-seed the flag so the guard doesn't fire again.
  let sawSuccessfulExternalDataToolResult = !!(initialMessages && initialMessages.some(m =>
    (m.role === "tool" && m.content && !m.content.includes('"error"')) ||
    (m.role === "user" && Array.isArray(m.content) && m.content.some(b => b.type === "tool_result" && !b.is_error))
  ));
  // Track whether an external data tool was attempted (even if it errored).
  // If the model called the right tool but it failed (e.g. rate limit, network error),
  // the live data guard should let the model report that error rather than blocking.
  let sawExternalDataToolAttempt = false;
  let liveDataGuardFired = false;
  let toolErrorNudgeFired = false;
  let deferralNudgeFired = false;
  let mcpFabricationGuardFired = false;
  let emptyResponseRetried = false;
  let composioSessionId = "";
  const mcpResultTexts = []; // collect LOCAL_MCP_EXECUTE result texts for context enrichment
  const systemOverheadChars = system.length + JSON.stringify(tools).length;
  prunablePrefixCount = enforceAgentMessageBudgetInPlace(messages, { prunablePrefixCount, systemOverheadChars });
  deps.debugLog("[Chief flow] runAgentLoop start:", {
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
  deps.debugLog("[Chief flow] Token estimate (input):", {
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
    priorContextTurns: getConversationTurns().length,
    iterations: 0,
    toolCalls: [],
    resultTextPreview: "",
    error: null,
    guardsFired: []
  };
  lastAgentRunTrace = trace;
  let gatheringGuardFired = false;
  const gatheringCallNames = [];
  const toolCallCounts = new Map(); // Per-tool execution count across the entire loop (PI-1)
  const toolConsecutiveErrors = new Map(); // toolName -> { error, count } — detects retry loops
  const MAX_CONSECUTIVE_TOOL_ERRORS = 2; // Bail after 2 consecutive failures with same tool+error
  const toolStaleResults = new Map(); // rateLimitKey -> { fingerprint, count } — detects futile polling
  const MAX_STALE_RESULT_REPEATS = 2; // After 2 identical results from same tool, block further calls
  let totalGuardBlocks = 0; // Counts how many times the consecutive error guard or stale result guard fires
  const MAX_GUARD_BLOCKS_BEFORE_LOOP_BREAK = 3; // After 3 guard blocks, force-exit the agent loop
  let forceExitAgentLoop = false; // Set by guard block limit to break out of outer for loop
  if (approximateMessageChars(messages) > deps.MAX_AGENT_MESSAGES_CHAR_BUDGET) {
    const finalText = getAgentOverBudgetMessage();
    deps.debugLog("[Chief flow] runAgentLoop early exit: over budget before first call.");
    trace.finishedAt = Date.now();
    trace.resultTextPreview = finalText.slice(0, 400);
    return {
      text: finalText,
      messages,
      mcpResultTexts
    };
  }

  // Create an AbortController so in-flight LLM fetches can be cancelled on unload.
  // Abort any prior controller first to prevent orphaned in-flight requests
  // when concurrent agent loops are started (e.g. chat + inbox).
  if (activeAgentAbortController) {
    activeAgentAbortController.abort();
  }
  activeAgentAbortController = new AbortController();

  // Cache external extension tools for the duration of this agent loop run
  // to avoid repeated registry iteration and closure allocation per tool call.
  deps.clearExternalExtensionToolsCache();
  deps.getExternalExtensionTools(); // populates cache

  // Check for newly discovered extensions and notify user
  if (!readOnlyTools) {
    const discoveryRegistry = deps.getExtensionToolsRegistry();
    const discoveryConfig = deps.getExtToolsConfig();
    const newExts = [];
    for (const [extKey, ext] of Object.entries(discoveryRegistry)) {
      if (!ext || !Array.isArray(ext.tools) || !ext.tools.length) continue;
      if (!(extKey in discoveryConfig)) {
        const label = String(ext.name || extKey).trim();
        newExts.push({ key: extKey, label });
        discoveryConfig[extKey] = { enabled: false };
      }
    }
    if (newExts.length) {
      deps.setExtToolsConfig(deps.getExtensionAPIRef(), discoveryConfig);
      // Re-populate cache after config change
      deps.clearExternalExtensionToolsCache();
      deps.getExternalExtensionTools();
      const assistName = deps.getAssistantDisplayName();
      if (newExts.length === 1) {
        deps.showRawToast({
          class: "cos-toast",
          theme: deps.getToastTheme(),
          title: "New extension found",
          message: `<b>${deps.escapeHtml(newExts[0].label)}</b> has tools available. Review in ${deps.escapeHtml(assistName)} settings to enable.`,
          position: "topRight", timeout: 8000, close: true
        });
      } else {
        deps.showRawToast({
          class: "cos-toast",
          theme: deps.getToastTheme(),
          title: "Extensions found",
          message: `Found <b>${newExts.length}</b> Roam extensions with available tools. Review in ${deps.escapeHtml(assistName)} settings to enable.`,
          position: "topRight", timeout: 8000, close: true
        });
      }
    }
  }

  // Local MCP tools are listed at connect time and cached in localMcpClients Map.
  // getLocalMcpTools() reads from the Map synchronously — no per-loop async calls.

  try {
    for (let index = 0; index < maxIterations; index += 1) {
      if (forceExitAgentLoop) {
        deps.debugLog("[Chief flow] Force-exiting agent loop (guard block limit reached)");
        break;
      }
      // Daily spending cap — halt before making another LLM call
      const capCheck = isDailyCapExceeded();
      if (capCheck.exceeded) {
        const capMsg = `Daily spending cap reached ($${capCheck.spent.toFixed(2)} of $${capCheck.cap.toFixed(2)} limit). To continue, increase or remove the cap in Settings → Advanced → Daily Spending Cap.`;
        deps.debugLog("[Chief flow] Daily cap exceeded, halting agent loop", capCheck);
        trace.finishedAt = Date.now();
        trace.resultTextPreview = capMsg.slice(0, 400);
        trace.capExceeded = true;
        return { text: capMsg, messages, mcpResultTexts };
      }
      trace.iterations = index + 1;
      prunablePrefixCount = enforceAgentMessageBudgetInPlace(messages, { prunablePrefixCount });
      if (approximateMessageChars(messages) > deps.MAX_AGENT_MESSAGES_CHAR_BUDGET) {
        const finalText = getAgentOverBudgetMessage();
        trace.finishedAt = Date.now();
        trace.resultTextPreview = finalText.slice(0, 400);
        return {
          text: finalText,
          messages,
          mcpResultTexts
        };
      }
      const useStreaming = onTextChunk && isOpenAICompatible(provider);
      let response, toolCalls, streamedText;

      if (useStreaming) {
        const streamResult = await callOpenAIStreaming(apiKey, model, system, messages, tools, onTextChunk, { signal: activeAgentAbortController?.signal, maxOutputTokens }, provider);
        streamedText = streamResult.textContent || "";
        toolCalls = streamResult.toolCalls || [];
        const usage = streamResult.usage;
        if (usage) {
          const inputTokens = usage.prompt_tokens || 0;
          const outputTokens = usage.completion_tokens || 0;
          trace.totalInputTokens = (trace.totalInputTokens || 0) + inputTokens;
          trace.totalOutputTokens = (trace.totalOutputTokens || 0) + outputTokens;
          const callCost = (inputTokens / 1_000_000 * getModelCostRates(model).inputPerM) + (outputTokens / 1_000_000 * getModelCostRates(model).outputPerM);
          accumulateSessionTokens(inputTokens, outputTokens, callCost);
          recordCostEntry(model, inputTokens, outputTokens, callCost);
          trace.cost = (trace.cost || 0) + callCost;
          const _stu = getSessionTokenUsage();
          deps.debugLog("[Chief flow] API usage (stream):", {
            inputTokens, outputTokens,
            callCostCents: (callCost * 100).toFixed(3),
            sessionTotals: {
              input: _stu.totalInputTokens,
              output: _stu.totalOutputTokens,
              requests: _stu.totalRequests,
              costCents: (_stu.totalCostUsd * 100).toFixed(2)
            }
          });
          // Post-call cap proximity check
          const postCapCheck = isDailyCapExceeded();
          if (postCapCheck.exceeded) {
            deps.debugLog("[Chief flow] Daily cap now exceeded after this call — next iteration will halt", postCapCheck);
          }
        }
        response = {
          choices: [{
            message: {
              role: "assistant",
              content: streamedText || null,
              tool_calls: toolCalls.length ? toolCalls.map((tc, i) => {
                const call = {
                  id: tc.id || `call_${i}`,
                  type: "function",
                  function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
                };
                // Gemini 3: preserve thought_signature for multi-turn tool calling.
                // Must be echoed back in extra_content.google.thought_signature format.
                if (tc.extra_content) {
                  call.extra_content = tc.extra_content;
                } else if (tc.thought_signature) {
                  call.extra_content = { google: { thought_signature: tc.thought_signature } };
                }
                return call;
              }) : undefined
            }
          }],
          usage: streamResult.usage
        };
      } else {
        response = await callLlm(provider, apiKey, model, system, messages, tools, { signal: activeAgentAbortController?.signal, maxOutputTokens });
        const usage = response?.usage;
        if (usage) {
          const inputTokens = usage.prompt_tokens || usage.input_tokens || 0;
          const outputTokens = usage.completion_tokens || usage.output_tokens || 0;
          // Anthropic cache tokens: cache_creation at 1.25x, cache_read at 0.1x input rate
          const cacheCreationTokens = usage.cache_creation_input_tokens || 0;
          const cacheReadTokens = usage.cache_read_input_tokens || 0;
          const totalInputTokens = inputTokens + cacheCreationTokens + cacheReadTokens;
          trace.totalInputTokens = (trace.totalInputTokens || 0) + totalInputTokens;
          trace.totalOutputTokens = (trace.totalOutputTokens || 0) + outputTokens;
          trace.totalCacheReadTokens = (trace.totalCacheReadTokens || 0) + cacheReadTokens;
          trace.totalCacheCreationTokens = (trace.totalCacheCreationTokens || 0) + cacheCreationTokens;
          const { inputPerM: costPerMInput, outputPerM: costPerMOutput } = getModelCostRates(model);
          const callCost = (inputTokens / 1_000_000 * costPerMInput)
            + (cacheCreationTokens / 1_000_000 * costPerMInput * 1.25)
            + (cacheReadTokens / 1_000_000 * costPerMInput * 0.10)
            + (outputTokens / 1_000_000 * costPerMOutput);
          accumulateSessionTokens(totalInputTokens, outputTokens, callCost, cacheReadTokens, cacheCreationTokens);
          recordCostEntry(model, totalInputTokens, outputTokens, callCost);
          trace.cost = (trace.cost || 0) + callCost;
          const _stu2 = getSessionTokenUsage();
          deps.debugLog("[Chief flow] API usage:", {
            inputTokens, outputTokens,
            ...(cacheReadTokens > 0 || cacheCreationTokens > 0 ? { cacheReadTokens, cacheCreationTokens } : {}),
            callCostCents: (callCost * 100).toFixed(3),
            sessionTotals: {
              input: _stu2.totalInputTokens,
              output: _stu2.totalOutputTokens,
              requests: _stu2.totalRequests,
              costCents: (_stu2.totalCostUsd * 100).toFixed(2)
            }
          });
          // Post-call cap proximity check
          const postCapCheck = isDailyCapExceeded();
          if (postCapCheck.exceeded) {
            deps.debugLog("[Chief flow] Daily cap now exceeded after this call — next iteration will halt", postCapCheck);
          }
        }
        toolCalls = extractToolCalls(provider, response);
      }

      deps.debugLog("[Chief flow] runAgentLoop iteration:", {
        iteration: index + 1,
        toolCalls: toolCalls.length,
        tools: toolCalls.map((tc) => ({
          name: tc.name,
          args: deps.safeJsonStringify(tc.arguments, 200)
        }))
      });

      // Per-skill budget check — fires once, then allows one final synthesis iteration
      if (skillBudgetUsd != null && trace.cost >= skillBudgetUsd && !trace.budgetExceeded) {
        deps.debugLog("[Chief flow] Skill budget exceeded, allowing one final synthesis call", { cost: trace.cost, budget: skillBudgetUsd });
        trace.budgetExceeded = true;
        messages.push(formatAssistantMessage(provider, response));
        messages.push({
          role: "user",
          content: "BUDGET REACHED — you have exceeded the skill's cost budget. Do NOT call any more tools. "
            + "Synthesise a response from the data you have already gathered. "
            + "If sections are incomplete, note what is missing and suggest the user re-run with a higher Budget: value."
        });
        continue;
      }

      if (!toolCalls.length) {
        // Gathering completeness guard — check before allowing final response
        if (gatheringGuard && !gatheringGuardFired) {
          const missed = deps.checkGatheringCompleteness(gatheringGuard.expectedSources, gatheringCallNames);
          if (missed.length > 0) {
            gatheringGuardFired = true;
            trace.guardsFired.push("gathering");
            deps.debugLog("[Chief flow] Gathering guard fired (no-tool exit):", missed);
            messages.push(formatAssistantMessage(provider, response));
            messages.push({
              role: "user",
              content: `Gathering incomplete. You still need to call these sources before synthesising:\n${missed.map(d => `- ${d}`).join("\n")}\n\nPlease call the missing tools now, then proceed with synthesis and writing.`
            });
            continue;
          }
        }

        let finalText = useStreaming ? streamedText : extractTextResponse(provider, response);

        // PI-2: System prompt leakage guard — redact if the model is dumping its instructions
        finalText = deps.guardAgainstSystemPromptLeakage(finalText);

        // Empty response guard: if the model returned 0 output tokens, retry once with a nudge.
        // Case 1: empty after successful tool calls — flash-lite sometimes returns nothing after receiving tool results.
        // Case 2: empty on first iteration with no tool calls — model occasionally returns 0 tokens for simple queries.
        // If the retry also returns empty, escalate to power tier (similar to claimed-action escalation).
        if (!finalText?.trim()) {
          const hasSuccessfulToolCalls = trace.toolCalls.some(tc => !tc.error);
          const isFirstIterationEmpty = index === 0 && toolCalls.length === 0 && trace.toolCalls.length === 0;
          const isRetryIterationEmpty = emptyResponseRetried && toolCalls.length === 0;
          if (hasSuccessfulToolCalls || isFirstIterationEmpty || isRetryIterationEmpty) {
            if (!emptyResponseRetried) {
              // First empty response — retry with a nudge
              emptyResponseRetried = true;
              const reason = hasSuccessfulToolCalls ? "after successful tool calls" : "on first iteration (no tool calls)";
              deps.debugLog("[Chief flow] runAgentLoop empty response guard — 0 output tokens " + reason + " (iteration " + (index + 1) + "), retrying.");
              messages.push(formatAssistantMessage(provider, response));
              const nudge = hasSuccessfulToolCalls
                ? "You returned an empty response after calling tools successfully. The tool results above contain the data needed. Please summarise the results for the user."
                : "You returned an empty response. Please respond to the user's request.";
              messages.push({ role: "user", content: nudge });
              continue;
            } else if (effectiveTier === "mini") {
              // Retry also returned empty on mini tier — escalate to power
              deps.debugLog("[Chief flow] Empty response escalation: mini-tier returned 0 output tokens twice, escalating to power tier.");
              throw new EmptyResponseEscalationError(
                "Mini-tier returned 0 output tokens on both initial and retry attempts",
                { provider, tier: effectiveTier, iterations: index + 1 }
              );
            }
          }
        }

        // Hallucination guard (enhanced): if the model claims to have performed an action but made
        // zero *successful* tool calls in the entire loop, inject a correction and retry.
        // Mitigation 1: Uses detectClaimedActionWithoutToolCall() for richer pattern matching
        //   including extension tool names and natural-language result claims.
        // Mitigation 2: Tracks sessionClaimedActionCount for context hygiene — repeated fires
        //   signal that conversation context is poisoned with hallucinated claims.
        // Mitigation 3: On gemini mini tier, throws ClaimedActionEscalationError to trigger
        //   auto-escalation to power tier in runAgentLoopWithFailover.
        const successfulToolCalls = trace.toolCalls.filter(tc => !tc.error);
        if (successfulToolCalls.length === 0 && !gatheringGuardFired) {
          const claimCheck = detectClaimedActionWithoutToolCall(finalText, tools);
          if (claimCheck.detected) {
            incrementSessionClaimedActionCount();
            recordUsageStat("claimedActionFires");
            trace.guardsFired.push("claimedAction");
            const toolHint = claimCheck.matchedToolHint ? ` (expected tool: ${claimCheck.matchedToolHint})` : "";
            deps.debugLog("[Chief flow] runAgentLoop hallucination guard triggered — model claimed action with 0 successful tool calls" + toolHint + " (iteration " + (index + 1) + ", session count: " + getSessionClaimedActionCount() + "), retrying.");

            // Mitigation 3: If this is gemini on mini tier and we've seen this pattern,
            // throw an escalation error so the failover handler can restart at power tier.
            // Only escalate on the first fire per loop — a second fire means even the retry failed.
            if (provider === "gemini" && effectiveTier === "mini" && getSessionClaimedActionCount() >= 2) {
              deps.debugLog("[Chief flow] Claimed-action escalation: gemini mini-tier repeated failure (session count: " + getSessionClaimedActionCount() + "), escalating to power tier.");
              throw new ClaimedActionEscalationError(
                "Gemini mini-tier repeated claimed-action-without-tool-call failure",
                { provider, model, tier: effectiveTier, sessionClaimedActionCount: getSessionClaimedActionCount(), matchedToolHint: claimCheck.matchedToolHint }
              );
            }

            const nudge = claimCheck.matchedToolHint
              ? `You claimed to perform an action but no tool call succeeded. That response was not shown to the user. Please call the "${claimCheck.matchedToolHint}" tool to actually complete the request.`
              : "You claimed to perform an action but no tool call succeeded. That response was not shown to the user. Please actually call the appropriate tool to complete the request.";
            messages.push(formatAssistantMessage(provider, response));
            messages.push({ role: "user", content: nudge });
            continue;
          }
        }

        // MCP data fabrication guard: in active MCP sessions, if the model produces
        // a long response without any successful tool call, it's almost certainly hallucinating
        // external data (e.g. fabricating file contents, collection items, issue details).
        // This catches cases where isLikelyLiveDataReadIntent misses terse follow-ups like "the powerpoint".
        if (getSessionUsedLocalMcp() && successfulToolCalls.length === 0 && !mcpFabricationGuardFired && finalText.length > 1500) {
          mcpFabricationGuardFired = true;
          trace.guardsFired.push("fabrication");
          deps.debugLog("[Chief flow] runAgentLoop MCP fabrication guard triggered — long response (" + finalText.length + " chars) with 0 tool calls in MCP session (iteration " + (index + 1) + "), retrying.");
          messages.push(formatAssistantMessage(provider, response));
          messages.push({ role: "user", content: "You produced a detailed response without calling any tool. That response was not shown to the user. In this session you have access to external tools — you MUST call LOCAL_MCP_ROUTE then LOCAL_MCP_EXECUTE to fetch real data before answering. Never fabricate or infer data." });
          continue;
        }

        if (requiresLiveDataTool && !sawSuccessfulExternalDataToolResult) {
          // If the model called the right tool but it errored (e.g. rate limit, network
          // failure), let it report the error to the user rather than blocking the response.
          if (sawExternalDataToolAttempt && !toolErrorNudgeFired) {
            // Tool was called but errored — give the model one chance to report the
            // failure gracefully instead of asking the user to debug configuration.
            toolErrorNudgeFired = true;
            trace.guardsFired.push("toolErrorNudge");
            deps.debugLog("[Chief flow] runAgentLoop tool-error nudge — external tool attempted but errored (iteration " + (index + 1) + "), retrying with guidance.");
            messages.push(formatAssistantMessage(provider, response));
            messages.push({ role: "user", content: "The tool call failed. That response was not shown to the user. Explain to the user clearly and concisely what went wrong (e.g. the service returned an error). Suggest what they can do (retry later, check their API key in settings, or try a different approach). Do NOT ask the user to debug code, inspect logs, or fix configuration files." });
            continue;
          } else if (sawExternalDataToolAttempt) {
            deps.debugLog("[Chief flow] runAgentLoop live-data guard skipped — external tool errored, nudge already fired (iteration " + (index + 1) + ").");
          } else if (!liveDataGuardFired) {
            liveDataGuardFired = true;
            trace.guardsFired.push("liveData");
            deps.debugLog("[Chief flow] runAgentLoop live-data guard triggered — no external tool result (iteration " + (index + 1) + "), retrying with hint.");
            messages.push(formatAssistantMessage(provider, response));
            messages.push({ role: "user", content: "You responded without calling any data tool. That response was not shown to the user. You MUST call the appropriate tool (e.g. roam_search, roam_get_page, roam_get_daily_page, LOCAL_MCP_ROUTE, COMPOSIO_MULTI_EXECUTE_TOOL) to fetch live data before answering." });
            continue;
          } else if (effectiveTier === "mini") {
            deps.debugLog("[Chief flow] Live-data escalation: mini-tier failed to call data tools after retry, escalating to power tier.");
            throw new LiveDataEscalationError(
              "Mini-tier failed to ground response in live data after retry",
              { provider, model, tier: effectiveTier }
            );
          } else {
            finalText = "I can't answer that reliably without checking live tools first. Please retry, and I'll fetch the real data before responding.";
            deps.debugLog("[Chief flow] runAgentLoop text blocked: missing successful external tool result (after retry).");
          }
        }

        // Post-guard deferral check: if the live data guard fired, tools were called
        // successfully on retry, but the model still defers instead of synthesizing
        // an answer — nudge it once to actually use the results.
        if (liveDataGuardFired && sawSuccessfulExternalDataToolResult && !deferralNudgeFired && finalText) {
          const deferralPattern = /\b(i['']ll\s+(check|get back|look into|let you know|find out)|let me (check|look|get back|find)|i('ll| will)\s+investigate|i need to\s+(check|look|verify)|once i\s+(check|have|get)|i('ll| will)\s+get\s+back)\b/i;
          if (deferralPattern.test(finalText)) {
            deferralNudgeFired = true;
            trace.guardsFired.push("deferralNudge");
            deps.debugLog("[Chief flow] runAgentLoop deferral nudge — model deferred after successful tool calls (iteration " + (index + 1) + "), retrying.");
            messages.push(formatAssistantMessage(provider, response));
            messages.push({ role: "user", content: "You already retrieved data via tool calls but then deferred instead of answering. That response was not shown to the user. Synthesize the tool results you already have into a direct, concrete answer now." });
            continue;
          }
        }

        trace.finishedAt = Date.now();
        trace.resultTextPreview = String(finalText || "").slice(0, 400);
        deps.updateChatPanelCostIndicator();
        return {
          text: finalText,
          messages,
          mcpResultTexts
        };
      }

      messages.push(formatAssistantMessage(provider, response));
      const toolResults = [];
      let iterToolExecutionCount = 0; // Reset per-iteration (PI-4)
      for (const toolCall of toolCalls) {
        // Gathering completeness guard — intercept first write tool (pre-loop guards only;
        // mid-loop guards from cos_get_skill reads should not block writes since the LLM
        // may be editing/auditing a skill rather than executing it)
        const isWriteCall_gathering = deps.WRITE_TOOL_NAMES.has(toolCall.name) || (toolCall.name === "ROAM_EXECUTE" && deps.WRITE_TOOL_NAMES.has(toolCall.arguments?.tool_name));
        if (gatheringGuard && gatheringGuard.source !== "mid-loop" && !gatheringGuardFired && isWriteCall_gathering) {
          const missed = deps.checkGatheringCompleteness(gatheringGuard.expectedSources, gatheringCallNames);
          if (missed.length > 0) {
            gatheringGuardFired = true;
            trace.guardsFired.push("gathering");
            deps.debugLog("[Chief flow] Gathering guard fired (write intercepted):", toolCall.name, missed);
            toolResults.push({
              toolCall,
              result: {
                error: `Gathering incomplete. Before writing, please call these missing sources:\n${missed.map(d => `- ${d}`).join("\n")}\n\nThen proceed with synthesis and writing.`
              }
            });
            trace.toolCalls.push({
              name: toolCall.name,
              argumentsPreview: "(blocked by gathering guard)",
              startedAt: Date.now(),
              durationMs: 0,
              error: "Gathering incomplete"
            });
            continue;
          }
        }
        gatheringCallNames.push(toolCall.name);
        // For LOCAL/REMOTE_MCP_EXECUTE and ROAM_EXECUTE calls, also push the inner tool_name
        // so that MCP-based and routed Roam skill sources get counted
        if ((toolCall.name === "LOCAL_MCP_EXECUTE" || toolCall.name === "REMOTE_MCP_EXECUTE" || toolCall.name === "ROAM_EXECUTE" || toolCall.name === "EXT_EXECUTE") && toolCall.arguments?.tool_name) {
          gatheringCallNames.push(toolCall.arguments.tool_name);
        }
        // For COMPOSIO_MULTI_EXECUTE_TOOL calls, also push individual tool slugs
        // so that Composio-based sources (e.g. GMAIL_FETCH_EMAILS) get counted.
        // LLMs sometimes use "actions"/"action_slug" instead of "tools"/"tool_slug" —
        // the normaliser fixes this before execution, but tracking runs on raw args.
        if (toolCall.name === "COMPOSIO_MULTI_EXECUTE_TOOL") {
          const batchTools = Array.isArray(toolCall.arguments?.tools) ? toolCall.arguments.tools
            : Array.isArray(toolCall.arguments?.actions) ? toolCall.arguments.actions : [];
          for (const bt of batchTools) {
            const slug = bt?.tool_slug || bt?.action_slug;
            if (slug) gatheringCallNames.push(slug);
          }
        }

        const isWriteCall_replay = deps.WRITE_TOOL_NAMES.has(toolCall.name) || (toolCall.name === "ROAM_EXECUTE" && deps.WRITE_TOOL_NAMES.has(toolCall.arguments?.tool_name));
        if (carryoverWriteReplayGuard?.active && isWriteCall_replay) {
          const fp = (() => {
            try { return `${toolCall.name}::${JSON.stringify(toolCall.arguments || {})}`; } catch { return `${toolCall.name}::{}`; }
          })();
          const seenSameWrite = carryoverWriteReplayGuard.fingerprints?.has(fp);
          const seenAnyWrite = carryoverWriteReplayGuard.hasPriorWrite;
          if (seenSameWrite || seenAnyWrite) {
            const reason = seenSameWrite ? "duplicate write replay blocked after provider failover"
              : "write blocked after prior successful write in failover carryover";
            deps.debugLog("[Chief flow] Carryover write replay guard:", toolCall.name, reason);
            toolResults.push({
              toolCall,
              result: {
                error: `Write blocked to prevent duplicate changes after provider failover. A previous provider already completed a write in this request. Do not write again; summarise what was already completed.`
              }
            });
            trace.toolCalls.push({
              name: toolCall.name,
              argumentsPreview: deps.safeJsonStringify(toolCall.arguments, 350),
              startedAt: Date.now(),
              durationMs: 0,
              error: "Blocked by carryover write replay guard"
            });
            continue;
          }
        }

        // Per-iteration execution cap — prevents one LLM response from overwhelming the message budget.
        // Skills with a gathering guard get a higher cap so they can fetch all sources in parallel.
        const effectiveIterCap = gatheringGuard ? deps.MAX_TOOL_CALLS_PER_ITERATION_SKILL : deps.MAX_TOOL_CALLS_PER_ITERATION;
        if (iterToolExecutionCount >= effectiveIterCap) {
          deps.debugLog("[Chief flow] Per-iteration tool cap reached:", toolCall.name, `(${iterToolExecutionCount}/${effectiveIterCap})`);
          toolResults.push({
            toolCall,
            result: { error: `Too many tool calls in one step (limit: ${effectiveIterCap}). Split your work across multiple steps.` }
          });
          trace.toolCalls.push({
            name: toolCall.name,
            argumentsPreview: deps.safeJsonStringify(toolCall.arguments, 350),
            startedAt: Date.now(),
            durationMs: 0,
            error: "Per-iteration cap"
          });
          continue;
        }

        // Per-tool rate limit — prevents the same tool from being called excessively across the loop
        // LOCAL_MCP_EXECUTE uses a composite key so each inner tool gets its own bucket
        const rateLimitKey = toolCall.name === "LOCAL_MCP_EXECUTE"
          ? `LOCAL_MCP_EXECUTE::${toolCall.arguments?.tool_name || ""}`
          : toolCall.name;
        const priorCallCount = toolCallCounts.get(rateLimitKey) || 0;
        if (priorCallCount >= deps.MAX_CALLS_PER_TOOL_PER_LOOP) {
          deps.debugLog("[Chief flow] Per-tool rate limit reached:", toolCall.name, `(${priorCallCount}/${deps.MAX_CALLS_PER_TOOL_PER_LOOP})`);
          toolResults.push({
            toolCall,
            result: { error: `Tool "${toolCall.name}" has been called ${priorCallCount} times in this request (limit: ${deps.MAX_CALLS_PER_TOOL_PER_LOOP}). Use a different approach or tool.` }
          });
          trace.toolCalls.push({
            name: toolCall.name,
            argumentsPreview: deps.safeJsonStringify(toolCall.arguments, 350),
            startedAt: Date.now(),
            durationMs: 0,
            error: "Per-tool rate limit"
          });
          continue;
        }

        // Consecutive error guard — bail early if the same tool keeps failing
        const consec = toolConsecutiveErrors.get(toolCall.name);
        if (consec && consec.count >= MAX_CONSECUTIVE_TOOL_ERRORS) {
          totalGuardBlocks++;
          deps.debugLog("[Chief flow] Consecutive error guard:", toolCall.name, `(${consec.count} failures with: "${consec.error}", totalGuardBlocks: ${totalGuardBlocks})`);
          toolResults.push({
            toolCall,
            result: { error: `Tool "${toolCall.name}" has failed ${consec.count} consecutive times with the same error: "${consec.error}". Do NOT retry this tool with the same arguments. Use a different tool or approach, or proceed with the data you already have.` }
          });
          trace.toolCalls.push({
            name: toolCall.name,
            argumentsPreview: deps.safeJsonStringify(toolCall.arguments, 350),
            startedAt: Date.now(),
            durationMs: 0,
            error: "Consecutive error guard"
          });
          // After too many guard blocks, hard-exit both loops to prevent wasting API calls
          if (totalGuardBlocks >= MAX_GUARD_BLOCKS_BEFORE_LOOP_BREAK) {
            deps.debugLog("[Chief flow] Guard block limit reached (" + totalGuardBlocks + "), force-exiting agent loop");
            forceExitAgentLoop = true;
            break; // breaks inner toolCalls loop; forceExitAgentLoop breaks outer index loop on next check
          }
          continue;
        }

        // Stale-result guard — blocks futile polling when the same tool returns identical results
        const staleEntry = toolStaleResults.get(rateLimitKey);
        if (staleEntry && staleEntry.count >= MAX_STALE_RESULT_REPEATS) {
          totalGuardBlocks++;
          // Build a follow-up hint so the model can tell the user how to check later.
          // For LOCAL_MCP_EXECUTE, surface the inner tool name + arguments.
          let followUpHint = "";
          try {
            const innerToolName = toolCall.arguments?.tool_name || toolCall.name;
            const innerArgs = toolCall.arguments?.arguments || toolCall.arguments || {};
            const argSnippet = deps.safeJsonStringify(innerArgs, 300);
            followUpHint = ` To check later, the user can ask you to call "${innerToolName}" with arguments: ${argSnippet}`;
          } catch (_) { /* best-effort */ }
          deps.debugLog("[Chief flow] Stale-result guard:", rateLimitKey, `(${staleEntry.count} identical results, totalGuardBlocks: ${totalGuardBlocks})`);
          toolResults.push({
            toolCall,
            result: { error: `Tool "${toolCall.name}" has returned the same result ${staleEntry.count} times — the operation is likely still in progress or unchanged. Do NOT call this tool again. Move on: summarise what you have accomplished so far and tell the user the status of the pending operation so they can ask you to check on it later.${followUpHint}` }
          });
          trace.toolCalls.push({
            name: toolCall.name,
            argumentsPreview: deps.safeJsonStringify(toolCall.arguments, 350),
            startedAt: Date.now(),
            durationMs: 0,
            error: "Stale-result guard"
          });
          if (totalGuardBlocks >= MAX_GUARD_BLOCKS_BEFORE_LOOP_BREAK) {
            deps.debugLog("[Chief flow] Guard block limit reached (" + totalGuardBlocks + "), force-exiting agent loop");
            forceExitAgentLoop = true;
            break;
          }
          continue;
        }

        const isExternalToolCall = isExternalDataToolCall(toolCall.name);
        // Track that the model attempted an external data tool (even if it errors).
        // LOCAL_MCP_ROUTE / REMOTE_MCP_ROUTE are discovery-only — don't count as a data attempt.
        if (isExternalToolCall && toolCall.name !== "LOCAL_MCP_ROUTE" && toolCall.name !== "REMOTE_MCP_ROUTE") {
          sawExternalDataToolAttempt = true;
        }
        if (onToolCall) onToolCall(toolCall.name, toolCall.arguments);
        const startedAt = Date.now();
        let result;
        let errorMessage = "";
        const toolArgs = withComposioSessionArgs(toolCall.name, toolCall.arguments, composioSessionId);
        try {
          result = await executeToolCall(toolCall.name, toolArgs, { readOnly: readOnlyTools, skipApproval });
          const discoveredSessionId = extractComposioSessionIdFromToolResult(result);
          if (discoveredSessionId) composioSessionId = discoveredSessionId;
        } catch (error) {
          errorMessage = error?.message || "Tool call failed";
          const isComposioTool = String(toolCall.name || "").toUpperCase().startsWith("COMPOSIO_");
          const isValidationError = /validation|invalid/i.test(errorMessage);
          if (isComposioTool && isValidationError && composioSessionId) {
            try {
              const retryArgs = withComposioSessionArgs(toolCall.name, toolArgs, composioSessionId);
              result = await executeToolCall(toolCall.name, retryArgs, { readOnly: readOnlyTools, skipApproval });
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
        iterToolExecutionCount++;
        toolCallCounts.set(rateLimitKey, (toolCallCounts.get(rateLimitKey) || 0) + 1);
        recordUsageStat("toolCall", toolCall.name);
        deps.debugLog("[Chief flow] tool result:", {
          tool: toolCall.name,
          durationMs,
          error: errorMessage || null,
          result: errorMessage ? null : deps.safeJsonStringify(result, 400)
        });
        // Track consecutive errors for retry loop detection
        if (errorMessage) {
          const prev = toolConsecutiveErrors.get(toolCall.name);
          if (prev && prev.error === errorMessage) {
            prev.count += 1;
          } else {
            toolConsecutiveErrors.set(toolCall.name, { error: errorMessage, count: 1 });
          }
        } else {
          toolConsecutiveErrors.delete(toolCall.name);
          // Track stale (identical) results for futile-polling detection.
          // Compute a lightweight fingerprint: first 200 chars of the stringified result.
          // If the same tool returns the same fingerprint, increment; otherwise reset.
          const resultStr = typeof result === "string" ? result : deps.safeJsonStringify(result, 200);
          const fingerprint = (resultStr || "").slice(0, 200);
          const prevStale = toolStaleResults.get(rateLimitKey);
          if (prevStale && prevStale.fingerprint === fingerprint) {
            prevStale.count += 1;
            deps.debugLog("[Chief flow] Stale-result tracker:", rateLimitKey, "identical result count:", prevStale.count);
          } else {
            toolStaleResults.set(rateLimitKey, { fingerprint, count: 1 });
          }
        }
        // Dynamic gathering guard activation when LLM fetches a skill
        if (toolCall.name === "cos_get_skill" && result && !result.error && !gatheringGuard) {
          const skillText = typeof result === "string" ? result : deps.safeJsonStringify(result, 10000);
          let skillContent = skillText;
          try {
            const parsed = JSON.parse(skillText);
            if (parsed?.content) skillContent = parsed.content;
          } catch (_) { /* use raw text */ }
          deps.debugLog("[Chief flow] Gathering guard skillText preview:", String(skillContent).slice(0, 500));
          // Use unfiltered tool schemas so category-gated tools (cos_cron_*, roam_bt_*, etc.)
          // are recognised as valid sources even when filtered out of the active tool set.
          // Also include ALL MCP tools (routed servers) so namespaced names are recognised.
          const allToolSchemas = await deps.getAvailableToolSchemas();
          const knownToolNames = new Set(
            (Array.isArray(allToolSchemas) ? allToolSchemas : []).map(t => t?.name).filter(Boolean)
          );
          for (const t of getLocalMcpTools()) knownToolNames.add(t.name);
          for (const t of getRemoteMcpTools()) knownToolNames.add(t.name);
          // Include Composio installed tool slugs (mid-loop)
          const midLoopRegistry = getToolkitSchemaRegistry();
          for (const tk of Object.values(midLoopRegistry.toolkits || {})) {
            for (const slug of Object.keys(tk.tools || {})) knownToolNames.add(slug);
          }
          const expectedSources = deps.parseSkillSources(skillContent, knownToolNames);
          deps.debugLog("[Chief flow] Gathering guard parsed sources:", expectedSources.length, expectedSources);
          if (expectedSources.length > 0) {
            gatheringGuard = { expectedSources, source: "mid-loop" };
            // Dynamically boost iteration cap so skills with many sources can complete.
            // Need: remaining sources + 1 synthesis + 1 buffer for retries.
            const neededIterations = index + 1 + expectedSources.length + 2;
            if (neededIterations > maxIterations && neededIterations <= deps.MAX_AGENT_ITERATIONS_SKILL) {
              deps.debugLog(`[Chief flow] Gathering guard boosting maxIterations: ${maxIterations} → ${neededIterations} (${expectedSources.length} sources at iteration ${index + 1})`);
              maxIterations = neededIterations;
            }
          }
        }
        trace.toolCalls.push({
          name: toolCall.name,
          argumentsPreview: deps.safeJsonStringify(toolArgs, 350),
          startedAt,
          durationMs,
          error: errorMessage
        });
        // LOCAL_MCP_ROUTE / REMOTE_MCP_ROUTE are discovery only — don't let them satisfy the live data guard.
        // Only actual data-fetching tools (LOCAL_MCP_EXECUTE, REMOTE_MCP_EXECUTE, etc.) should count.
        if (isExternalToolCall && toolCall.name !== "LOCAL_MCP_ROUTE" && toolCall.name !== "REMOTE_MCP_ROUTE" && isSuccessfulExternalToolResult(result)) {
          sawSuccessfulExternalDataToolResult = true;
        }
        if (onToolResult) onToolResult(toolCall.name, result);
        // Track meta-routed MCP tool usage for fabrication guard and follow-up auto-escalation
        if (toolCall.name === "LOCAL_MCP_ROUTE" || toolCall.name === "LOCAL_MCP_EXECUTE") {
          setSessionUsedLocalMcp(true);
        }
        // Collect LOCAL_MCP_EXECUTE result text for context enrichment
        if (toolCall.name === "LOCAL_MCP_EXECUTE" && !errorMessage) {
          const txt = typeof result === "string" ? result : result?.text || (typeof result === "object" ? JSON.stringify(result) : "");
          if (txt && mcpResultTexts.length < 20) mcpResultTexts.push(txt.slice(0, deps.MAX_TOOL_RESULT_CHARS));
        }
        toolResults.push({ toolCall, result });
      }
      messages.push(...formatToolResults(provider, toolResults));
      prunablePrefixCount = enforceAgentMessageBudgetInPlace(messages, { prunablePrefixCount });
      if (approximateMessageChars(messages) > deps.MAX_AGENT_MESSAGES_CHAR_BUDGET) {
        const finalText = getAgentOverBudgetMessage();
        deps.debugLog("[Chief flow] runAgentLoop exit: over budget after tool results.");
        trace.finishedAt = Date.now();
        trace.resultTextPreview = finalText.slice(0, 400);
        return {
          text: finalText,
          messages,
          mcpResultTexts
        };
      }
      const lastToolResult = toolResults[toolResults.length - 1];
      const isWriteCall_last = deps.WRITE_TOOL_NAMES.has(lastToolResult?.toolCall?.name) || (lastToolResult?.toolCall?.name === "ROAM_EXECUTE" && deps.WRITE_TOOL_NAMES.has(lastToolResult?.toolCall?.arguments?.tool_name));
      if (toolResults.length === 1 && isWriteCall_last && !lastToolResult?.result?.error) {
        const toolName = lastToolResult.toolCall.name;
        const resultData = lastToolResult.result;
        let finalText;
        if (toolName === "cos_write_draft_skill") {
          finalText = `Draft skill "${resultData?.skill_name || "skill"}" written to Skills page.`;
        } else if (toolName === "cos_update_memory") {
          const page = resultData?.page || "memory";
          const action = resultData?.action || "updated";
          finalText = `${page} ${action} successfully.`;
        } else if (toolName === "cos_cron_create" && resultData?.created) {
          const cronType = resultData.type || "job";
          const cronName = resultData.name || "";
          const cronWhen = resultData.nextRunLocal || resultData.nextRun || "";
          if (cronType === "reminder") {
            finalText = cronWhen ? `Reminder set — I'll notify you at ${cronWhen}.` : `Reminder set.`;
          } else {
            finalText = cronWhen
              ? `Scheduled ${cronType}${cronName ? ` "${cronName}"` : ""} — next run at ${cronWhen}.`
              : `Scheduled ${cronType}${cronName ? ` "${cronName}"` : ""} successfully.`;
          }
        } else if (toolName === "cos_cron_update" && resultData?.updated) {
          finalText = `Job "${resultData.id || "job"}" updated.`;
        } else if (toolName === "cos_cron_delete" && resultData?.deleted) {
          finalText = `Job "${resultData.id || "job"}" deleted.`;
        } else if (toolName === "cos_cron_delete_jobs" && Array.isArray(resultData?.deleted)) {
          const names = resultData.deleted.map(d => `"${d.name || d.id}"`).join(", ");
          finalText = `Deleted ${resultData.deleted.length} job(s): ${names}.`;
          if (resultData.notFound?.length) finalText += ` Not found: ${resultData.notFound.join(", ")}.`;
        } else {
          finalText = `Written successfully.`;
        }
        deps.debugLog("[Chief flow] runAgentLoop short-circuit: write tool succeeded, skipping final LLM call.");
        trace.finishedAt = Date.now();
        trace.resultTextPreview = finalText;
        deps.updateChatPanelCostIndicator();
        return { text: finalText, messages, mcpResultTexts };
      }
      if (toolCalls.length > 0 && index < maxIterations - 1) {
        deps.debugLog("[Chief flow] runAgentLoop pausing before continuing to next iteration after tool calls.");
        await new Promise(r => setTimeout(r, 500));
      }
    }

    // If we force-exited due to guard block limit, return a graceful message
    // instead of throwing (which would trigger failover and waste more API calls)
    if (forceExitAgentLoop) {
      const guardMsg = "I encountered repeated tool errors and stopped retrying to avoid wasting resources. Please try rephrasing your request or check that the tools/data you're referencing are available.";
      trace.finishedAt = Date.now();
      trace.error = "Force-exited: consecutive error guard limit";
      trace.resultTextPreview = guardMsg;
      deps.updateChatPanelCostIndicator();
      return { text: guardMsg, messages, mcpResultTexts };
    }

    trace.finishedAt = Date.now();
    trace.error = "Agent loop exceeded maximum iterations";
    throw new Error("Agent loop exceeded maximum iterations");
  } catch (error) {
    trace.finishedAt = Date.now();
    trace.error = error?.message || "Agent loop failed";
    // Attach accumulated context for failover carryover (last 6 messages, capped at 20K chars)
    const carryMessages = messages.slice(-6);
    let totalChars = 0;
    const trimmedCarry = [];
    for (let i = carryMessages.length - 1; i >= 0; i--) {
      const msgStr = JSON.stringify(carryMessages[i]);
      if (totalChars + msgStr.length > 20000) break;
      totalChars += msgStr.length;
      trimmedCarry.unshift(carryMessages[i]);
    }
    // Strip orphaned tool result messages from the front — if slicing cut between
    // an assistant message with tool_calls and its tool result messages, the results
    // become orphaned and OpenAI rejects with "messages with role 'tool' must be a
    // response to a preceding message with 'tool_calls'".
    while (trimmedCarry.length > 0) {
      const first = trimmedCarry[0];
      // OpenAI format: role === "tool"
      if (first.role === "tool") { trimmedCarry.shift(); continue; }
      // Anthropic format: role === "user" with only tool_result blocks
      if (first.role === "user" && Array.isArray(first.content)
        && first.content.every(b => b.type === "tool_result")) { trimmedCarry.shift(); continue; }
      break;
    }
    error.agentContext = {
      accumulatedMessages: trimmedCarry,
      iteration: trace.iterations,
      provider,
      canCarryOver: trace.iterations > 1,
      tier: effectiveTier
    };
    throw error;
  } finally {
    activeAgentAbortController = null;
    deps.clearExternalExtensionToolsCache();
    // Always refresh cost indicator — costs accrue on every API call,
    // not just successful completions. Without this, failover / error
    // paths leave the tooltip stale until the next successful request.
    deps.updateChatPanelCostIndicator();
  }
}

// ── Failover handler ────────────────────────────────────────────────────────

export async function runAgentLoopWithFailover(userMessage, options = {}) {
  const extensionAPI = deps.getExtensionAPIRef();
  const baseTier = options.tier || (options.powerMode ? "power" : "mini");
  const { excludeProviders = null, preferProvider = null } = options;

  // Use chain order to pick primary provider for all tiers.
  // This ensures auto-escalation (e.g. mini→power) stays on a working provider,
  // rather than falling back to user's default which may not have a valid key/proxy.
  let primaryProvider;
  if (!options.providerOverride) {
    let chain = deps.FAILOVER_CHAINS[baseTier] || deps.FAILOVER_CHAINS.mini;
    // Per-skill provider exclusions (e.g. Models: -Gemini)
    if (excludeProviders?.size > 0) {
      chain = chain.filter(p => !excludeProviders.has(p));
    }
    // Per-skill provider preference (e.g. Models: +Mistral)
    if (preferProvider) {
      const preferred = chain.find(p => p === preferProvider && extensionAPI && !!getApiKeyForProvider(extensionAPI, p) && !isProviderCoolingDown(p));
      if (preferred) primaryProvider = preferred;
    }
    if (!primaryProvider) {
      primaryProvider = chain.find(p => extensionAPI && !!getApiKeyForProvider(extensionAPI, p) && !isProviderCoolingDown(p))
        || (extensionAPI ? getLlmProvider(extensionAPI) : deps.DEFAULT_LLM_PROVIDER);
    }
  } else {
    primaryProvider = options.providerOverride;
  }
  let fallbacks = (options.disableFailover || !extensionAPI)
    ? [] : getFailoverProviders(primaryProvider, extensionAPI, baseTier);
  // Also filter fallbacks by exclusion list
  if (excludeProviders?.size > 0) {
    fallbacks = fallbacks.filter(p => !excludeProviders.has(p));
  }

  // First attempt: primary provider
  let lastError;
  try {
    return await runAgentLoop(userMessage, { ...options, providerOverride: primaryProvider, tier: baseTier });
  } catch (error) {
    // Mitigation 3: Claimed-action escalation — restart at power tier on same provider
    if (error instanceof ClaimedActionEscalationError) {
      const esc = error.escalationContext || {};
      deps.debugLog(`[Chief flow] Claimed-action escalation: ${esc.provider} ${esc.tier} → power (session count: ${esc.sessionClaimedActionCount}, hint: ${esc.matchedToolHint || "none"})`);
      recordUsageStat("tierEscalations");
      deps.showInfoToast("Upgrading model", "Switching to power tier for better tool-call reliability\u2026");
      return await runAgentLoop(userMessage, {
        ...options,
        providerOverride: primaryProvider,
        tier: "power",
        powerMode: true
      });
    }
    if (error instanceof EmptyResponseEscalationError) {
      const esc = error.escalationContext || {};
      deps.debugLog(`[Chief flow] Empty response escalation: ${esc.provider} ${esc.tier} → power`);
      deps.showInfoToast("Upgrading model", "Mini tier unresponsive, switching to power tier\u2026");
      return await runAgentLoop(userMessage, {
        ...options,
        providerOverride: primaryProvider,
        tier: "power",
        powerMode: true
      });
    }
    if (error instanceof LiveDataEscalationError) {
      const esc = error.escalationContext || {};
      deps.debugLog(`[Chief flow] Live-data escalation: ${esc.provider} ${esc.tier} → power`);
      recordUsageStat("tierEscalations");
      deps.showInfoToast("Upgrading model", "Switching to power tier for better data grounding\u2026");
      return await runAgentLoop(userMessage, {
        ...options,
        providerOverride: primaryProvider,
        tier: "power",
        powerMode: true
      });
    }
    lastError = error;
    if (!isFailoverEligibleError(error)) throw error;
    setProviderCooldown(primaryProvider);
  }

  // Failover through same-tier chain — Mode A (context carryover) or Mode B (fresh restart)
  const ctx = lastError.agentContext;
  for (let i = 0; i < fallbacks.length; i += 1) {
    const nextProvider = fallbacks[i];
    const failedProvider = i === 0 ? primaryProvider : fallbacks[i - 1];

    deps.debugLog(`[Chief flow] Provider failover: ${failedProvider} \u2192 ${nextProvider} (${baseTier})`, lastError?.message);
    deps.showInfoToast("Switching provider", `${failedProvider} unavailable, trying ${nextProvider}\u2026`);

    try {
      if (ctx?.canCarryOver && ctx.accumulatedMessages?.length > 0) {
        // Mode A: carry accumulated context forward to the next provider
        const converted = convertMessagesForProvider(ctx.accumulatedMessages, ctx.provider, nextProvider);
        const writtenBlocks = detectWrittenBlocksInMessages(ctx.accumulatedMessages);
        const priorSuccessfulWrites = detectSuccessfulWriteToolCallsInMessages(ctx.accumulatedMessages);
        let continuationMsg = deps.FAILOVER_CONTINUATION_MESSAGE;
        if (writtenBlocks.length > 0 || priorSuccessfulWrites.length > 0) {
          const names = [...new Set(priorSuccessfulWrites.map(w => w.name))].join(", ");
          continuationMsg += `\n\nWARNING: The previous model already completed a write action in this request${names ? ` (${names})` : ""}. Do NOT call write tools again — the data may already be saved. Focus on producing a text summary of what was accomplished.`;
        }
        converted.push({ role: "user", content: continuationMsg });
        deps.debugLog(`[Chief flow] Mode A carryover: ${ctx.accumulatedMessages.length} msgs, iter ${ctx.iteration}, tier ${baseTier}${(writtenBlocks.length || priorSuccessfulWrites.length) ? ", double-write guard active" : ""}`);
        return await runAgentLoop(userMessage, {
          ...options,
          providerOverride: nextProvider,
          initialMessages: converted,
          maxIterations: options.maxIterations || deps.MAX_AGENT_ITERATIONS,
          powerMode: true,
          tier: baseTier,
          carryoverWriteReplayGuard: {
            active: priorSuccessfulWrites.length > 0,
            hasPriorWrite: priorSuccessfulWrites.length > 0,
            fingerprints: new Set(priorSuccessfulWrites.map(w => w.fingerprint))
          }
        });
      } else {
        // Mode B: fresh restart — no useful context to carry
        deps.debugLog("[Chief flow] Mode B fresh restart");
        return await runAgentLoop(userMessage, { ...options, providerOverride: nextProvider, tier: baseTier });
      }
    } catch (error) {
      // Claimed-action escalation from a fallback provider — same handling as primary
      if (error instanceof ClaimedActionEscalationError) {
        const esc = error.escalationContext || {};
        deps.debugLog(`[Chief flow] Claimed-action escalation in fallback: ${esc.provider} ${esc.tier} → power`);
        recordUsageStat("tierEscalations");
        deps.showInfoToast("Upgrading model", "Switching to power tier for better tool-call reliability\u2026");
        return await runAgentLoop(userMessage, {
          ...options,
          providerOverride: nextProvider,
          tier: "power",
          powerMode: true
        });
      }
      if (error instanceof EmptyResponseEscalationError) {
        const esc = error.escalationContext || {};
        deps.debugLog(`[Chief flow] Empty response escalation in fallback: ${esc.provider} ${esc.tier} → power`);
        deps.showInfoToast("Upgrading model", "Mini tier unresponsive, switching to power tier\u2026");
        return await runAgentLoop(userMessage, {
          ...options,
          providerOverride: nextProvider,
          tier: "power",
          powerMode: true
        });
      }
      if (error instanceof LiveDataEscalationError) {
        const esc = error.escalationContext || {};
        deps.debugLog(`[Chief flow] Live-data escalation in fallback: ${esc.provider} ${esc.tier} → power`);
        recordUsageStat("tierEscalations");
        deps.showInfoToast("Upgrading model", "Switching to power tier for better data grounding\u2026");
        return await runAgentLoop(userMessage, {
          ...options,
          providerOverride: nextProvider,
          tier: "power",
          powerMode: true
        });
      }
      lastError = error;
      // Keep the original ctx — intermediate providers may have added broken tool call
      // attempts (JSON parse errors, etc.) that pollute the message history with noise.
      // Always carry over the clean context from the first provider that gathered real data.
      if (!isFailoverEligibleError(error)) throw error;
      setProviderCooldown(nextProvider);
    }
  }

  // Ludicrous escalation: only from power tier, only with carryover, only if setting enabled
  if (baseTier === "power" && ctx?.canCarryOver && ctx.accumulatedMessages?.length > 0) {
    const ludicrousEnabled = extensionAPI
      && deps.getSettingBool(extensionAPI, deps.SETTINGS_KEYS.ludicrousModeEnabled, false);
    if (ludicrousEnabled) {
      const ludicrousFallbacks = getFailoverProviders(primaryProvider, extensionAPI, "ludicrous");
      if (ludicrousFallbacks.length > 0) {
        deps.debugLog("[Chief flow] Escalating to ludicrous mode \u2014 all power providers exhausted");
        deps.showInfoToast("Ludicrous mode", "All power providers exhausted, escalating\u2026");

        for (const nextProvider of ludicrousFallbacks) {
          try {
            const converted = convertMessagesForProvider(ctx.accumulatedMessages, ctx.provider, nextProvider);
            const writtenBlocks = detectWrittenBlocksInMessages(ctx.accumulatedMessages);
            const priorSuccessfulWrites = detectSuccessfulWriteToolCallsInMessages(ctx.accumulatedMessages);
            let continuationMsg = deps.FAILOVER_CONTINUATION_MESSAGE;
            if (writtenBlocks.length > 0 || priorSuccessfulWrites.length > 0) {
              const names = [...new Set(priorSuccessfulWrites.map(w => w.name))].join(", ");
              continuationMsg += `\n\nWARNING: The previous model already completed a write action in this request${names ? ` (${names})` : ""}. Do NOT call write tools again — the data may already be saved. Focus on producing a text summary of what was accomplished.`;
            }
            converted.push({ role: "user", content: continuationMsg });
            deps.debugLog(`[Chief flow] Ludicrous carryover: ${ctx.accumulatedMessages.length} msgs \u2192 ${nextProvider}${(writtenBlocks.length || priorSuccessfulWrites.length) ? ", double-write guard active" : ""}`);
            return await runAgentLoop(userMessage, {
              ...options,
              providerOverride: nextProvider,
              initialMessages: converted,
              maxIterations: options.maxIterations || deps.MAX_AGENT_ITERATIONS,
              tier: "ludicrous",
              carryoverWriteReplayGuard: {
                active: priorSuccessfulWrites.length > 0,
                hasPriorWrite: priorSuccessfulWrites.length > 0,
                fingerprints: new Set(priorSuccessfulWrites.map(w => w.fingerprint))
              }
            });
          } catch (error) {
            lastError = error;
            if (!isFailoverEligibleError(error)) throw error;
            setProviderCooldown(nextProvider);
          }
        }
      }
    }
  }

  throw lastError;
}
