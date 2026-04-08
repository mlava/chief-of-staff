// ── Skill Autoresearch Loop (#98) ─────────────────────────────────────────
// Karpathy Loop pattern for automatic skill optimization.
// Generates synthetic test cases, scores baseline, iteratively mutates and
// evaluates, presents accept/revert. All mutations in-memory until accepted.
// DI via initSkillAutoresearch(deps). No Roam writes during the loop.

import { persistAuditLogEntry } from "./usage-tracking.js";

let deps = {};

export function initSkillAutoresearch(injected) { deps = injected; }

// ── Constants ────────────────────────────────────────────────────────────

export const OPTIMIZATION_DEFAULTS = {
  maxTestCases: 5,
  maxEvalCriteria: 5,
  maxIterations: 20,
  consecutiveDiscardLimit: 3,
  regressionThreshold: 2,
  wallCriterionFailLimit: 3,
  baselineToolCallingTimeoutMs: 120_000,  // generous for baseline (populates cache)
  toolCallingTimeoutMs: 90_000,           // shorter for mutations (cache-assisted)
  iterationWallClockMs: 150_000,
  defaultBudgetUsd: 2.0,
  simulationMaxTokens: 1200,
  mutationMaxTokens: 2000,
  setupMaxTokens: 2500,
};

// Phase A: structural sub-aspects (guaranteed first, skipped if section exists)
const STRUCTURAL_ASPECTS = ["add_rubric", "add_constraints", "add_or_fix_sources"];
// Phase B: refinement aspects (normal cycling after structural phase)
const REFINEMENT_ASPECTS = [
  "approach_specificity",
  "output_format",
  "constraint_tightening",
  "edge_case_handling",
  "trigger_clarity",
];

const STOP_REASONS = {
  budget: "budget_exhausted",
  perfect: "perfect_score",
  plateau: "plateau",
  maxIterations: "max_iterations",
  dailyCap: "daily_cap_exceeded",
  error: "error",
};

// ── Concurrency Guard ────────────────────────────────────────────────────

let activeOptimization = null;

export function isOptimizationRunning() { return activeOptimization !== null; }

// ── Intent Parsing ───────────────────────────────────────────────────────

/**
 * Parses user message for skill optimization intent.
 * Matches: "optimize my X skill", "improve skill X", "refine X", "enhance the X skill"
 * Also supports British spelling (optimise).
 * @param {string} userMessage
 * @returns {{ skillName: string }|null}
 */
export function parseSkillOptimizeIntent(userMessage) {
  let text = String(userMessage || "").trim();
  if (!text) return null;

  // Extract flags before matching (so they don't interfere with quotes/name)
  const withTools = /\s+--with-tools(?:\s|$)/i.test(text);
  const powerMutations = /\s+--power(?:-mutations)?(?:\s|$)/i.test(text);
  text = text.replace(/\s+--with-tools(?:\s|$)/i, " ").replace(/\s+--power(?:-mutations)?(?:\s|$)/i, " ").trim();

  // "optimize my Daily Briefing skill", "improve the research skill", "optimise skill: X"
  const m = text.match(
    /^(?:please\s+)?(?:optimi[sz]e|improve|refine|enhance)\s+(?:my\s+)?(?:the\s+)?(?:skill:?\s+)?["\u201C\u201D\u2018\u2019']?(.+?)["\u201C\u201D\u2018\u2019']?\s*$/i
  );
  if (!m) return null;
  const name = m[1].replace(/\s+skill$/i, "").trim();
  if (!name) return null;
  return { skillName: name, withTools, powerMutations };
}

// ── LLM Response Text Extraction ─────────────────────────────────────────

function extractResponseText(response, provider) {
  if (deps.isOpenAICompatible(provider)) {
    return response?.choices?.[0]?.message?.content || "";
  }
  // Anthropic format
  const textBlocks = (response?.content || []).filter(b => b.type === "text");
  return textBlocks.map(b => b.text).join("") || "";
}

function extractUsage(response) {
  const usage = response?.usage || {};
  return {
    inputTokens: usage.input_tokens || usage.prompt_tokens || 0,
    outputTokens: usage.output_tokens || usage.completion_tokens || 0,
  };
}

// ── Cost Tracking ────────────────────────────────────────────────────────

function trackCallCost(state, response, model, label) {
  const { inputTokens, outputTokens } = extractUsage(response);
  const rates = deps.getModelCostRates(model);
  const cost = (inputTokens / 1_000_000 * rates.inputPerM) + (outputTokens / 1_000_000 * rates.outputPerM);
  state.totalCostUsd += cost;
  state.totalInputTokens += inputTokens;
  state.totalOutputTokens += outputTokens;
  deps.recordCostEntry("autoresearch-" + label, inputTokens, outputTokens, cost);
  deps.accumulateSessionTokens(inputTokens, outputTokens, cost);
  if (!state.model) state.model = model;
  if (typeof deps.updateChatPanelCostIndicator === "function") deps.updateChatPanelCostIndicator();
  return cost;
}

function shouldStopForBudget(state, budgetUsd) {
  if (state.totalCostUsd >= budgetUsd) return STOP_REASONS.budget;
  const capCheck = deps.isDailyCapExceeded();
  if (capCheck.exceeded) return STOP_REASONS.dailyCap;
  return null;
}

// ── Phase 1: Setup ───────────────────────────────────────────────────────

const SETUP_SYSTEM_PROMPT = `You are generating test cases and evaluation criteria for a Roam Research AI skill.
Given the skill definition below, generate:
1. 4-5 realistic user prompts that exercise different aspects of the skill. Include at least 2 challenging edge cases (ambiguous input, missing context, boundary conditions). Avoid trivially easy prompts.
2. 4-5 binary evaluation criteria that test the QUALITY and STRUCTURE of the response, not just whether it exists. Focus on:
   - Structural requirements (sections, formatting, ordering that the skill specifies)
   - Content quality (specificity, actionability, appropriate level of detail)
   - Constraint adherence (length limits, required disclaimers, scope boundaries)
   - Edge case handling (graceful degradation, appropriate "I don't know" responses)

IMPORTANT: Do NOT include criteria about tool calls, data fetching, or external API access. This is a text-only evaluation — the response will be generated without any tool access.

Return JSON only:
{
  "testCases": [{"prompt": "user request text", "expectedBehavior": "what a good response should do"}],
  "evalCriteria": [{"id": "snake_case_id", "prompt": "Does the response...? (yes/no question)"}]
}

Keep criteria specific, binary (unambiguous pass/fail), and hard enough that a mediocre skill definition would fail at least 30% of them.`;

/**
 * Generates test cases and eval criteria from a skill definition.
 * Single LLM call (mini tier).
 */
async function generateTestCasesAndCriteria(state, skillContent, miniModel, maxTestCases) {
  const tcCap = maxTestCases || OPTIMIZATION_DEFAULTS.maxTestCases;
  const response = await deps.callLlmMini(
    SETUP_SYSTEM_PROMPT,
    [{ role: "user", content: `Skill definition:\n\n${skillContent}` }],
    { maxOutputTokens: OPTIMIZATION_DEFAULTS.setupMaxTokens }
  );

  trackCallCost(state, response, miniModel, "setup");

  const text = extractResponseText(response, deps.getMiniProvider());
  let parsed = null;

  // Strip code fences
  const stripped = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "").trim();
  try {
    parsed = JSON.parse(stripped);
  } catch (_) {
    if (deps.extractBalancedJsonObjects) {
      const objects = deps.extractBalancedJsonObjects(stripped);
      if (objects.length > 0) parsed = objects[0].parsed;
    }
  }

  const testCases = Array.isArray(parsed?.testCases)
    ? parsed.testCases
        .filter(tc => tc?.prompt && tc?.expectedBehavior)
        .slice(0, tcCap)
    : [];

  const evalCriteria = Array.isArray(parsed?.evalCriteria)
    ? parsed.evalCriteria
        .filter(ec => ec?.id && ec?.prompt)
        .slice(0, OPTIMIZATION_DEFAULTS.maxEvalCriteria)
    : [];

  if (testCases.length === 0) {
    deps.debugLog("[Autoresearch] Setup parse failed — raw response:", String(text || "").slice(0, 500));
  }

  return { testCases, evalCriteria };
}

// Standard BINARY_CHECKS (answered_question, tools_before_claims, etc.) are NOT
// merged here — they test agent-loop behaviour (tool calls, data grounding) that
// LLM-only simulation cannot exercise. Only skill-specific criteria are used.

// ── Simulation ───────────────────────────────────────────────────────────

/**
 * Simulates a skill run: LLM-only (no tool calls).
 * Returns the raw response text. Used for skills without Sources/Tools.
 */
async function simulateSkillRun(state, skillContent, testPrompt, miniModel) {
  const system = `You are an AI assistant with the following skill loaded:\n\n${skillContent}\n\nApply this skill to answer the user's request. Respond as if you were the assistant executing this skill.\n\nIMPORTANT: You do not have access to external tools or APIs in this simulation. If the skill references tool calls or data lookups, write the response as if those calls succeeded and returned plausible data. Focus on demonstrating the correct structure, formatting, and reasoning that the skill specifies.`;
  const response = await deps.callLlmMini(
    system,
    [{ role: "user", content: testPrompt }],
    { maxOutputTokens: OPTIMIZATION_DEFAULTS.simulationMaxTokens }
  );
  trackCallCost(state, response, miniModel, "simulate");
  return extractResponseText(response, deps.getMiniProvider());
}

/**
 * Simulates a skill run with full tool-calling via the agent loop.
 * Used for skills with Sources/Tools sections.
 * Read tools execute normally; write tools are excluded from the whitelist.
 * Returns the final response text.
 */
async function simulateSkillRunWithTools(state, skillContent, testPrompt, toolResultCache, timeoutMs, allowFailover) {
  const knownNames = typeof deps.getKnownToolNames === "function"
    ? await deps.getKnownToolNames()
    : new Set();

  // Parse Sources/Tools from skill content (same as deterministic router)
  const sources = typeof deps.parseSkillSources === "function"
    ? deps.parseSkillSources(skillContent, knownNames)
    : [];
  const parsedTools = typeof deps.parseSkillTools === "function"
    ? deps.parseSkillTools(skillContent, knownNames)
    : [];

  // Build tool whitelist: skill's declared tools MINUS write tools.
  // This lets read tools (calendar, email, weather, search) execute normally
  // while preventing Roam writes during simulation.
  const writeTools = deps.WRITE_TOOL_NAMES || new Set();
  const simulationTools = parsedTools.length > 0
    ? new Set(parsedTools.filter(t => !writeTools.has(t)))
    : undefined;

  // Build gathering guard (if Sources: section exists)
  const gatheringGuard = sources.length > 0
    ? { expectedSources: sources, source: "pre-loop" }
    : null;

  // Build system prompt with skill content injected
  const basePrompt = typeof deps.buildSystemPrompt === "function"
    ? await deps.buildSystemPrompt(testPrompt)
    : "";
  const systemPrompt = `${basePrompt}\n\n## Active Skill (Autoresearch Simulation)\n${skillContent}\n\nApply this skill to answer the user's request.\n\nNote: Write tools (roam_batch_write, roam_create_block, etc.) are not available in this simulation. Produce your output as text instead of writing to Roam.`;

  // Run agent loop in isolation, with wall-clock timeout.
  // NOT readOnlyTools — we want real tool execution for read tools.
  // Write tools are excluded via the whitelist above.
  const effectiveTimeout = timeoutMs || OPTIMIZATION_DEFAULTS.toolCallingTimeoutMs;
  let result;
  try {
    result = await Promise.race([
      deps.runAgentLoop(testPrompt, {
        initialMessages: [{ role: "user", content: testPrompt }],
        systemPrompt,
        toolWhitelist: simulationTools,
        gatheringGuard,
        skipApproval: true,
        maxIterations: 12,
        skillBudgetUsd: 0.15,
        tier: "mini",
        preferProvider: "openai",
        disableFailover: !allowFailover,
        toolResultCache: toolResultCache || undefined,
        excludeProviders: new Set(["groq", "gemini", "mistral"]),
      }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("SIMULATION_TIMEOUT")), effectiveTimeout)
      ),
    ]);
  } catch (err) {
    if (err?.message === "SIMULATION_TIMEOUT") {
      deps.debugLog("[Autoresearch] Tool-calling simulation timed out after", effectiveTimeout / 1000, "s — scoring as empty response");
      return { text: "", timedOut: true };
    }
    throw err;
  }

  // Track cost from trace (agent loop handles accumulateSessionTokens internally)
  const trace = typeof deps.getLastAgentRunTrace === "function"
    ? deps.getLastAgentRunTrace()
    : null;
  if (trace?.cost) state.totalCostUsd += trace.cost;

  return { text: result?.text || "", timedOut: false };
}

// ── Scoring ──────────────────────────────────────────────────────────────

/**
 * Runs all test case simulations. LLM-only runs in parallel; tool-calling
 * runs sequentially (shared abort controller and trace state).
 * Returns { responses: string[], inconclusive: boolean }.
 * inconclusive=true when first tool-calling test case times out or wall-clock
 * deadline exceeded — caller should skip scoring and not count toward plateau.
 */
async function simulateAllTestCases(state, skillContent, testCases, miniModel, wallClockDeadline, toolResultCache, timeoutMs, allowFailover) {
  const budgetStop = shouldStopForBudget(state, state.budgetUsd);
  if (budgetStop) return { responses: [], inconclusive: false };

  if (state.useToolCalling) {
    // Sequential — tool-calling uses shared agent loop state
    const responses = [];
    let inconclusive = false;
    for (const tc of testCases) {
      if (shouldStopForBudget(state, state.budgetUsd)) break;
      if (wallClockDeadline && Date.now() > wallClockDeadline) {
        inconclusive = true;
        deps.debugLog("[Autoresearch] Iteration wall-clock exceeded before test case", responses.length + 1);
        break;
      }
      const result = await simulateSkillRunWithTools(state, skillContent, tc.prompt, toolResultCache, timeoutMs, allowFailover);
      if (result.timedOut && responses.length === 0) {
        inconclusive = true;
        deps.debugLog("[Autoresearch] First test case timed out — skipping remaining, marking inconclusive");
        break;
      }
      responses.push(result.text);
    }
    return { responses, inconclusive };
  }

  // LLM-only: parallel (no timeout fast-fail needed)
  const promises = testCases.map(tc => simulateSkillRun(state, skillContent, tc.prompt, miniModel));
  return { responses: await Promise.all(promises), inconclusive: false };
}

/**
 * Scores all test case responses in parallel for speed.
 * Budget checked once before the batch, not per-call.
 */
async function scoreAllTestCases(state, responses, testCases, evalCriteria, judgeConfig) {
  const budgetStop = shouldStopForBudget(state, state.budgetUsd);
  if (budgetStop) return [];

  const promises = responses.map((resp, i) =>
    deps.scoreWithBinaryChecks(resp, evalCriteria, judgeConfig).then(({ results, cost }) => {
      state.totalCostUsd += cost;
      return { testCaseIdx: i, prompt: testCases[i].prompt, results };
    })
  );
  return Promise.all(promises);
}

/**
 * Computes aggregate pass rate from scored results.
 * Optional excludedIds (Set) removes structurally unprovable criteria from
 * both numerator and denominator so they don't drag down scores.
 * @returns {number} 0.0 to 1.0
 */
export function computePassRate(scores, criteriaCount, excludedIds = null) {
  const exclude = excludedIds instanceof Set ? excludedIds : null;
  const effectiveCount = exclude ? criteriaCount - exclude.size : criteriaCount;
  if (!scores.length || effectiveCount <= 0) return 0;
  let totalPasses = 0;
  for (const s of scores) {
    totalPasses += (s.results || []).filter(r => r.pass && !(exclude?.has(r.id))).length;
  }
  return totalPasses / (scores.length * effectiveCount);
}

/**
 * Detects criteria that are structurally unprovable in tool-calling simulation.
 * A criterion is unprovable if it scored 0% across ALL test cases AND its text
 * references write capabilities (write, create, persist, etc.) that are blocked
 * in simulation mode.
 */
const WRITE_CAPABILITY_PATTERN = /(?:^|[\s_\-.])(write|written|wrote|create[ds]?|persist|saved?)(?:[\s_\-.,;]|$)/i;

export function detectUnprovableCriteria(baselineScores, evalCriteria, useToolCalling) {
  if (!useToolCalling) return new Set();
  const unprovable = new Set();
  for (const c of evalCriteria) {
    let total = 0, passes = 0;
    for (const s of baselineScores) {
      const r = (s.results || []).find(x => x.id === c.id);
      if (r) { total++; if (r.pass) passes++; }
    }
    if (total > 0 && passes === 0) {
      if (WRITE_CAPABILITY_PATTERN.test(c.prompt) || WRITE_CAPABILITY_PATTERN.test(c.id)) {
        unprovable.add(c.id);
      }
    }
  }
  return unprovable;
}

/**
 * Detects regression: a previously-passing criterion now fails on >= threshold test cases.
 */
export function detectRegression(baselineScores, candidateScores, threshold) {
  const t = threshold || OPTIMIZATION_DEFAULTS.regressionThreshold;
  // Build per-criterion pass counts for baseline
  const baselinePassById = {};
  for (const s of baselineScores) {
    for (const r of (s.results || [])) {
      if (r.pass) baselinePassById[r.id] = (baselinePassById[r.id] || 0) + 1;
    }
  }

  // Check candidate for newly failing criteria
  for (const [id, baselineCount] of Object.entries(baselinePassById)) {
    if (baselineCount < baselineScores.length) continue; // already had failures in baseline
    // This criterion passed on all baseline test cases — check for regression
    let candidateFailures = 0;
    for (const s of candidateScores) {
      const r = (s.results || []).find(x => x.id === id);
      if (r && !r.pass) candidateFailures++;
    }
    if (candidateFailures >= t) return { id, failures: candidateFailures };
  }
  return null;
}

// ── Phase 2: Mutation ────────────────────────────────────────────────────

/**
 * Detects which structural sections are present in the skill content.
 */
export function detectMissingSections(skillContent) {
  const text = String(skillContent || "");
  const sections = {
    trigger: /\bTrigger(?:s)?:/i.test(text),
    approach: /\bApproach:/i.test(text),
    output: /\bOutput(?:\s+format)?:/i.test(text),
    sources: /\bSources:/i.test(text),
    tools: /\bTools:/i.test(text),
    constraints: /\bConstraints:/i.test(text),
    rubric: /\bRubric:/i.test(text),
    models: /\bModels:/i.test(text),
  };
  const missing = Object.entries(sections).filter(([, present]) => !present).map(([name]) => name);
  return { sections, missing };
}

// ── Tool Reference Validation ────────────────────────────────────────────

/**
 * Extracts tool name references from Sources: and Tools: sections ONLY.
 * Does NOT scan inline Approach/Output text — too many false positives
 * from natural language (forward-looking, low-activity, include_blocks, etc.).
 */
function extractToolReferences(content) {
  const refs = new Set();
  const text = String(content || "");

  if (typeof deps.parseSkillSources === "function") {
    const sources = deps.parseSkillSources(text, null);
    for (const s of sources) {
      if (s.tool) refs.add(s.tool);
    }
  }
  if (typeof deps.parseSkillTools === "function") {
    const tools = deps.parseSkillTools(text, null);
    for (const t of tools) refs.add(t);
  }

  return [...refs];
}

/**
 * Validates tool references in Sources:/Tools: sections against the live
 * tool registry. Invalid names are stripped (not fuzzy-corrected — wrong
 * corrections like roam_get_recent_changes → roam_get_block_children are
 * worse than removing the reference entirely).
 *
 * @param {string} content - Mutated skill content
 * @returns {Promise<{content: string, fixes: [], stripped: string[]}>}
 */
export async function validateAndFixToolReferences(content) {
  const knownNames = typeof deps.getKnownToolNames === "function"
    ? await deps.getKnownToolNames()
    : new Set();
  if (knownNames.size === 0) return { content, fixes: [], stripped: [] };

  const refs = extractToolReferences(content);
  if (refs.length === 0) return { content, fixes: [], stripped: [] };

  const stripped = [];
  let fixedContent = content;

  for (const ref of refs) {
    if (knownNames.has(ref)) continue; // valid
    // Accept cross-source deduped names (e.g. sentry__search_issues) — the deduped
    // name may not exist yet if there's no collision, but the intent is valid
    if (ref.indexOf("__") > 0) continue;

    // Invalid tool name — strip from Sources:/Tools: sections ONLY (not Approach/Output text).
    // The global regex was previously stripping tool names from Approach prose too,
    // causing damage like "For sentry__search_issues use args:" → "For  use args:".
    const escapedRef = ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const lines = fixedContent.split("\n");
    let inSection = false;
    let sectionIndent = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*-?\s*(?:Sources|Tools)\s*(?:—|:)/i.test(lines[i])) {
        inSection = true;
        sectionIndent = (lines[i].match(/^(\s*)/)?.[1] || "").length;
        // Also strip from inline header (e.g. "Tools: a, invalid_tool, b")
        lines[i] = lines[i].replace(new RegExp(`(?:,\\s*)?\\b${escapedRef}\\b(?:\\s*,)?`, "g"), "");
        continue;
      }
      if (inSection) {
        const indent = (lines[i].match(/^(\s*)/)?.[1] || "").length;
        if (indent <= sectionIndent && lines[i].trim()) { inSection = false; continue; }
        lines[i] = lines[i].replace(new RegExp(`(?:,\\s*)?\\b${escapedRef}\\b(?:\\s*,)?`, "g"), "");
      }
    }
    fixedContent = lines.join("\n");
    stripped.push(ref);
  }

  // Post-process: remove blank/whitespace-only lines left in Sources/Tools sections
  if (stripped.length > 0) {
    const lines = fixedContent.split("\n");
    const cleaned = [];
    let inSection = false;
    let sectionIndent = -1;
    for (const line of lines) {
      if (/^\s*-?\s*(?:Sources|Tools)\s*(?:—|:)/i.test(line)) {
        inSection = true;
        sectionIndent = (line.match(/^(\s*)/)?.[1] || "").length;
        cleaned.push(line);
        continue;
      }
      if (inSection) {
        const indent = (line.match(/^(\s*)/)?.[1] || "").length;
        if (indent <= sectionIndent && line.trim()) {
          inSection = false;
          cleaned.push(line);
          continue;
        }
        // Skip blank/dash-only lines inside Sources/Tools sections
        const trimmed = line.trim().replace(/^-\s*/, "").trim();
        if (!trimmed) continue;
      }
      cleaned.push(line);
    }
    fixedContent = cleaned.join("\n");
  }

  return { content: fixedContent, fixes: [], stripped };
}

/**
 * Detects Sources lines with parameter hints that break parseSkillSources.
 * e.g. "roam_bt_search_tasks (status: TODO/DOING, due: today)" or "search_email — recent email signals"
 */
export function hasSourcesWithParameterHints(content) {
  const lines = String(content || "").split("\n");
  let inSources = false;
  let sourceIndent = -1;
  for (const line of lines) {
    if (!inSources) {
      if (/^\s*-?\s*Sources\s*(?:—|:)/i.test(line)) {
        inSources = true;
        sourceIndent = (line.match(/^(\s*)/)?.[1] || "").length;
      }
      continue;
    }
    const indent = (line.match(/^(\s*)/)?.[1] || "").length;
    if (indent <= sourceIndent && line.trim()) break; // back to top-level
    if (line.trim()) {
      // Check for parenthetical args, em-dash descriptions, or inline JSON
      if (/\w+\s*\(.*[:=].*\)/.test(line)) return true;
      if (/\w+\s+—\s+.+/.test(line)) return true;
      if (/`\{/.test(line)) return true;
    }
  }
  return false;
}

/**
 * Two-phase mutation aspect selection.
 * Phase A (structural): guaranteed first — add_rubric, add_constraints, add_or_fix_sources.
 *   Each is skipped if the section already exists (and is well-formed for sources).
 * Phase B (refinement): standard cycling after all structural aspects are tried/skipped.
 */
export function selectMutationAspect(failingSummary, triedAspects, skillContent, iteration) {
  // Phase A: structural sub-aspects (guaranteed first)
  if (skillContent) {
    const { sections } = detectMissingSections(skillContent);
    for (const aspect of STRUCTURAL_ASPECTS) {
      if (triedAspects.has(aspect)) continue;
      if (aspect === "add_rubric" && sections.rubric) continue;
      if (aspect === "add_constraints" && sections.constraints) continue;
      if (aspect === "add_or_fix_sources") {
        // Skip entirely if Sources already exists — it's locked during mutation
        // to protect hand-curated tool configuration
        if (sections.sources) continue;
      }
      return aspect;
    }
  }

  // Phase B: refinement cycling
  const untried = REFINEMENT_ASPECTS.filter(a => !triedAspects.has(a));
  if (untried.length > 0) return untried[0];
  const idx = (iteration || triedAspects.size) % REFINEMENT_ASPECTS.length;
  return REFINEMENT_ASPECTS[idx];
}

// ── Aspect → section routing ─────────────────────────────────────────────

export const ASPECT_SECTION_MAP = {
  add_rubric:            "Rubric",
  add_constraints:       "Constraints",
  add_or_fix_sources:    "Sources",
  approach_specificity:  "Approach",
  output_format:         "Output",
  constraint_tightening: "Constraints",
  edge_case_handling:    "Approach",
  trigger_clarity:       "Trigger",
};

const MUTATION_SYSTEM_PROMPT = `You are improving ONE section of a Roam Research AI skill definition.
Make one targeted addition or modification to address the failing criteria.

VALID SKILL SECTIONS (for reference):
- Trigger: when the skill should activate (natural language phrases)
- Approach: step-by-step execution logic
- Output: where output goes and what "done" looks like
- Sources: tools the assistant MUST call before producing output
- Tools: restricts which tools are available
- Constraints: four quadrants — Must Do, Must Not Do, Prefer, Escalate
- Rubric: 3-5 binary pass/fail quality criteria for post-run evaluation
- Models: provider preferences (+Mistral, -Gemini)
- Tier: mini, power, or ludicrous
- Budget: dollar cap per run (e.g. $0.05)

ROAM LIST FORMAT — all sections use indented list items:
- SectionName:
    - child item 1
    - child item 2

Return JSON only — NO explanation, NO other text:
{
  "section": "<the section name you are modifying or creating>",
  "content": "<complete updated section text, including the header line>"
}

Rules:
- content must start with "- SectionName:" on the first line (e.g. "- Rubric:")
- child items use 4-space indent with "- " prefix
- Return ONLY the named section — no other sections, no skill name heading
- Preserve all existing lines in the section unless they directly conflict with the improvement`;

/**
 * Extract a named section (Sources, Tools, Models) from skill content.
 * Returns { start, end, text } or null if not found.
 */
function extractSection(content, sectionName) {
  const lines = content.split("\n");
  const headerRe = new RegExp(`^\\s*-?\\s*${sectionName}\\s*(?:—|:)`, "i");
  let start = -1, headerIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    if (start < 0) {
      if (headerRe.test(lines[i])) {
        start = i;
        headerIndent = (lines[i].match(/^(\s*)/)?.[1] || "").length;
      }
      continue;
    }
    // End of section: same or lower indent with non-empty content
    const indent = (lines[i].match(/^(\s*)/)?.[1] || "").length;
    if (indent <= headerIndent && lines[i].trim()) {
      return { start, end: i, text: lines.slice(start, i).join("\n") };
    }
  }
  if (start >= 0) return { start, end: lines.length, text: lines.slice(start).join("\n") };
  return null;
}

/**
 * Replace a section in content, or append if not found.
 */
function replaceSection(content, sectionName, originalSectionText) {
  const current = extractSection(content, sectionName);
  if (current) {
    const lines = content.split("\n");
    const before = lines.slice(0, current.start);
    const after = lines.slice(current.end);
    return [...before, ...originalSectionText.split("\n"), ...after].join("\n");
  }
  // Section not present — append it
  return content + "\n" + originalSectionText;
}

/**
 * Parses a structured mutation diff from LLM response text.
 * Returns { section, content } or null if the response is not valid.
 */
export function parseMutationDiff(text) {
  if (!text) return null;
  const stripped = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "").trim();
  let parsed = null;
  try {
    parsed = JSON.parse(stripped);
  } catch (_) {
    if (typeof deps.extractBalancedJsonObjects === "function") {
      const objects = deps.extractBalancedJsonObjects(stripped);
      if (objects.length > 0) parsed = objects[0].parsed;
    }
  }
  if (!parsed || typeof parsed.section !== "string" || typeof parsed.content !== "string") return null;
  if (!parsed.section.trim() || !parsed.content.trim()) return null;
  return { section: parsed.section.trim(), content: parsed.content.trim() };
}

/**
 * Applies a section-level diff to skill content.
 * Replaces the named section entirely, or appends it if not present.
 */
export function applyMutationDiff(currentContent, diff) {
  if (!diff || !diff.section || !diff.content) return currentContent;
  return replaceSection(currentContent, diff.section, diff.content);
}

async function mutateSkill(state, currentContent, failingSummary, aspect, passRate, miniModel, usePowerMutation) {
  const targetSection = ASPECT_SECTION_MAP[aspect] || "Approach";

  // Provide the current section text as context so the LLM knows what it's replacing
  const currentSection = extractSection(currentContent, targetSection);
  const currentSectionText = currentSection
    ? currentSection.text
    : `(section "${targetSection}" does not yet exist — create it)`;

  let aspectGuidance;
  switch (aspect) {
    case "add_rubric":
      aspectGuidance = `Create a Rubric section with 3-5 binary pass/fail quality criteria derived from the skill's Approach and Output sections. Each criterion should test a specific, observable quality (e.g. "Does the output include all three required sections?").`;
      break;
    case "add_constraints":
      aspectGuidance = `Create a Constraints section with four quadrants:
    - Must Do: non-negotiable behaviours the assistant must always follow
    - Must Not Do: forbidden behaviours (e.g. "Do not send emails")
    - Prefer: soft preferences (e.g. "Prefer bullet points over paragraphs")
    - Escalate: conditions where the assistant should ask the user rather than proceeding
  Derive from the skill's existing Approach instructions and the failing criteria below.`;
      break;
    case "add_or_fix_sources": {
      const hasSources = /\bSources\s*(?:—|:)/i.test(currentContent);
      if (hasSources) {
        aspectGuidance = `Clean the Sources section. Each child line should contain ONLY the tool name (e.g. \`roam_bt_search_tasks\`, \`list_calendars\`), not parameter hints, descriptions, or inline JSON. Move parameter guidance to the Approach section instead. Keep the same tools, just clean the formatting.`;
      } else {
        aspectGuidance = `Create a Sources section listing the specific tool names this skill MUST call before producing output. Use exact tool names from the skill's Approach section (e.g. \`roam_search\`, \`list_calendars\`). One tool per line, no descriptions or parameters.`;
      }
      break;
    }
    case "approach_specificity":
      aspectGuidance = `Make the Approach section more specific. Add or clarify step-by-step instructions to address the failing criteria. Keep all existing steps.`;
      break;
    case "output_format":
      aspectGuidance = `Clarify or improve the Output section. Specify the expected structure, format, or completion criteria more precisely.`;
      break;
    case "constraint_tightening":
      aspectGuidance = `Add or tighten constraints in the Constraints section to address the failing criteria. Prefer adding a Must Do or Must Not Do entry over rewriting existing ones.`;
      break;
    case "edge_case_handling":
      aspectGuidance = `Extend the Approach section with explicit edge case handling — what the skill should do for ambiguous input, missing context, or boundary conditions.`;
      break;
    case "trigger_clarity":
      aspectGuidance = `Clarify or expand the Trigger section so it matches more of the intended user phrases while still being specific enough to avoid false positives.`;
      break;
    default:
      aspectGuidance = `Improve the "${targetSection}" section to address the failing criteria. Make one targeted change.`;
  }

  const userPrompt = `The current skill scores ${Math.round(passRate * 100)}% on evaluation criteria.

Failing test cases and criteria:
${failingSummary}

Current skill body (for context):
${currentContent}

Current "${targetSection}" section:
${currentSectionText}

${aspectGuidance}

Return JSON with the updated "${targetSection}" section.`;

  const callFn = usePowerMutation && typeof deps.callLlmPower === "function"
    ? deps.callLlmPower
    : deps.callLlmMini;
  const mutationModel = usePowerMutation && typeof deps.getPowerModel === "function"
    ? deps.getPowerModel()
    : miniModel;
  const mutationProvider = deps.getMiniProvider();

  const response = await callFn(
    MUTATION_SYSTEM_PROMPT,
    [{ role: "user", content: userPrompt }],
    { maxOutputTokens: OPTIMIZATION_DEFAULTS.mutationMaxTokens }
  );
  trackCallCost(state, response, mutationModel, "mutate");

  const text = extractResponseText(response, mutationProvider);
  const diff = parseMutationDiff(text);

  if (!diff) {
    deps.debugLog("[Autoresearch] Mutation returned invalid diff — no change. Raw response:", String(text || "").slice(0, 300));
    return currentContent;
  }

  deps.debugLog("[Autoresearch] Mutation diff:", diff.section,
    `(${diff.content.split("\n").length} lines)`);
  return applyMutationDiff(currentContent, diff);
}

/**
 * Builds a compact summary of failures for the mutation prompt.
 */
/**
 * Builds a compact summary of failures for the mutation prompt.
 * @param {Set<string>} [wallCriteria] - Criteria IDs to exclude (deprioritised after repeated failures)
 */
function buildFailingSummary(scores, testCases, evalCriteria, wallCriteria) {
  const lines = [];
  for (const s of scores) {
    const failures = (s.results || []).filter(r => !r.pass && !(wallCriteria?.has(r.id)));
    if (failures.length === 0) continue;
    const tc = testCases[s.testCaseIdx];
    const failDescs = failures.map(f => {
      const criterion = evalCriteria.find(c => c.id === f.id);
      const desc = criterion?.prompt || f.id;
      return `"${desc}"${f.reason ? " — " + f.reason : ""}`;
    });
    lines.push(`- Test "${tc?.prompt?.slice(0, 80)}":\n  FAILED: ${failDescs.join("; ")}`);
  }
  if (wallCriteria?.size > 0) {
    lines.push(`\n(Deprioritised — repeatedly unfixable: ${[...wallCriteria].join(", ")})`);
  }
  return lines.join("\n") || "No failures";
}

// ── Stopping Criteria ────────────────────────────────────────────────────

/**
 * Evaluates all stopping criteria.
 * @returns {{ stop: boolean, reason: string|null }}
 */
export function shouldStop(state, budgetUsd) {
  if (state.totalCostUsd >= budgetUsd) return { stop: true, reason: STOP_REASONS.budget };

  const capCheck = deps.isDailyCapExceeded();
  if (capCheck.exceeded) return { stop: true, reason: STOP_REASONS.dailyCap };

  if (state.currentBestPassRate >= 1.0) return { stop: true, reason: STOP_REASONS.perfect };

  if (state.consecutiveDiscards >= OPTIMIZATION_DEFAULTS.consecutiveDiscardLimit) {
    return { stop: true, reason: STOP_REASONS.plateau };
  }

  if (state.iteration >= OPTIMIZATION_DEFAULTS.maxIterations) {
    return { stop: true, reason: STOP_REASONS.maxIterations };
  }

  return { stop: false, reason: null };
}

// ── Phase 3: Debrief ─────────────────────────────────────────────────────

async function persistDebriefResults(state) {
  try {
    const dateStr = deps.formatRoamDate(new Date());

    // Eval Log entry
    const evalPageUid = await deps.ensurePageUidByTitle("Chief of Staff/Eval Log");
    if (evalPageUid) {
      const baselinePct = Math.round(state.baselinePassRate * 100);
      const finalPct = Math.round(state.currentBestPassRate * 100);
      const logLine = `[[${dateStr}]] **skill-optimize** [${state.skillName}] `
        + `baseline:${baselinePct}% \u2192 final:${finalPct}% `
        + `(${state.testCases.length} tests, ${state.evalCriteria.length} criteria, `
        + `${state.mutationsAccepted.length + state.mutationsDiscarded.length} mutations tried, `
        + `${state.mutationsAccepted.length} accepted, $${state.totalCostUsd.toFixed(2)})`;
      const evalInsertOrder = deps.getFirstContentOrder ? deps.getFirstContentOrder(evalPageUid) : 0;
      await deps.createRoamBlock(evalPageUid, logLine, evalInsertOrder);
    }

    // Decisions entry (only if improved)
    if (state.mutationsAccepted.length > 0) {
      const decisionsPageUid = await deps.ensurePageUidByTitle("Chief of Staff/Decisions");
      if (decisionsPageUid) {
        const baselinePct = Math.round(state.baselinePassRate * 100);
        const finalPct = Math.round(state.currentBestPassRate * 100);
        const acceptedSummary = state.mutationsAccepted
          .map(m => m.description || m.aspect.replace(/_/g, " "))
          .join(", ");
        const decisionLine = `[[${dateStr}]] Skill "${state.skillName}" optimised \u2014 `
          + `${baselinePct}% \u2192 ${finalPct}%. Accepted: ${acceptedSummary}.`;
        const decInsertOrder = deps.getFirstContentOrder ? deps.getFirstContentOrder(decisionsPageUid) : 0;
        await deps.createRoamBlock(decisionsPageUid, decisionLine, decInsertOrder);
      }
    }
    // Audit Log entry — makes optimization runs visible in the Activity tab
    // Non-blocking, non-fatal — errors swallowed to match persistAuditLogEntry's contract
    try {
      const baselinePctAudit = Math.round(state.baselinePassRate * 100);
      const finalPctAudit = Math.round(state.currentBestPassRate * 100);
      const syntheticTrace = {
        startedAt: state.startedAt || Date.now(),
        finishedAt: Date.now(),
        model: state.model || "autoresearch",
        iterations: state.iteration || 0,
        totalInputTokens: state.totalInputTokens || 0,
        totalOutputTokens: state.totalOutputTokens || 0,
        cost: state.totalCostUsd || 0,
        toolCalls: [],
      };
      await persistAuditLogEntry(syntheticTrace, `optimise ${state.skillName}`, {
        skillName: `Optimise: ${state.skillName} (${baselinePctAudit}%→${finalPctAudit}%)`
      });
    } catch (auditErr) {
      deps.debugLog("[Autoresearch] Audit log entry failed (non-fatal):", auditErr?.message);
    }

  } catch (err) {
    deps.debugLog("[Autoresearch] Debrief persistence failed (non-fatal):", err?.message);
  }
}

// ── Main Orchestrator ────────────────────────────────────────────────────

/**
 * Runs the full skill optimization loop.
 * All mutations stay in memory. Roam is only written to on accept.
 *
 * @param {string} skillName - Name of the skill to optimize
 * @param {object} [options]
 * @param {number} [options.budgetUsd] - Max spend (defaults to settings or OPTIMIZATION_DEFAULTS)
 * @param {boolean} [options.withTools] - Opt-in to tool-calling simulation (default: false, uses LLM-only)
 * @param {boolean} [options.powerMutations] - Use power-tier model for mutation calls (default: false)
 * @returns {Promise<{improved: boolean, baselineRate: number, finalRate: number, cost: number, reason: string}>}
 */
export async function runSkillOptimization(skillName, options = {}) {
  if (activeOptimization) {
    throw new Error(`Optimization already running for "${activeOptimization}". Wait for it to complete.`);
  }

  const extensionAPI = deps.getExtensionAPIRef();
  const budgetStr = deps.getSettingString(extensionAPI, deps.SETTINGS_KEYS.skillAutoresearchBudget, "2.00");
  const budgetUsd = options.budgetUsd || parseFloat(budgetStr) || OPTIMIZATION_DEFAULTS.defaultBudgetUsd;

  // Check daily cap before starting
  const capCheck = deps.isDailyCapExceeded();
  if (capCheck.exceeded) {
    throw new Error(`Daily spending cap reached ($${capCheck.spent.toFixed(2)}/$${capCheck.cap.toFixed(2)}). Cannot start optimization.`);
  }

  activeOptimization = skillName;
  deps.debugLog("[Autoresearch] Starting optimization:", skillName, "budget:", budgetUsd);

  const state = {
    skillName,
    blockUid: null,
    originalContent: null,
    currentBestContent: null,
    testCases: [],
    evalCriteria: [],
    baselineScores: [],
    currentBestScores: [],
    baselinePassRate: 0,
    currentBestPassRate: 0,
    mutationsAccepted: [],
    mutationsDiscarded: [],
    totalCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    budgetUsd,
    phase: "setup",
    iteration: 0,
    consecutiveDiscards: 0,
    startedAt: Date.now(),
    model: null,  // set after first LLM call to capture the model used
  };

  try {
    // ── Load skill ──────────────────────────────────────────────────
    const entry = await deps.findSkillEntryByName(skillName, { force: true });
    if (!entry) throw new Error(`Skill "${skillName}" not found.`);

    state.blockUid = entry.uid;
    state.originalContent = entry.childrenContent || "";
    state.currentBestContent = state.originalContent;

    if (!state.originalContent.trim()) {
      throw new Error(`Skill "${skillName}" has no content to optimize.`);
    }

    // ── Tool-calling mode: opt-in only ─────────────────────────────
    // LLM-only simulation is the default — it's fast, reliable, and tests
    // structure/reasoning/format which improves any skill. Tool-calling
    // simulation is slow and flaky for skills with many external tools.
    // Opt-in via: --with-tools flag, or settings toggle.
    const toolCallingSetting = typeof deps.getToolCallingSetting === "function"
      ? deps.getToolCallingSetting()
      : false;
    state.useToolCalling = !!(options.withTools || toolCallingSetting);
    if (state.useToolCalling) {
      deps.debugLog("[Autoresearch] Tool-calling mode enabled",
        options.withTools ? "(--with-tools flag)" : "(settings toggle)");
    }

    // ── Power-tier mutations: opt-in ──────────────────────────────
    // Uses power model (e.g. Sonnet, GPT-4.1) for mutation calls only.
    // Simulations and scoring stay on mini tier.
    const powerMutationSetting = typeof deps.getPowerMutationSetting === "function"
      ? deps.getPowerMutationSetting()
      : false;
    state.usePowerMutation = !!(options.powerMutations || powerMutationSetting);
    if (state.usePowerMutation) {
      deps.debugLog("[Autoresearch] Power-tier mutations enabled",
        options.powerMutations ? "(option flag)" : "(settings toggle)");
    }

    // Tool result cache: shared across all test cases and iterations.
    // Same tool+args returns cached result instead of re-executing.
    const toolCacheSetting = typeof deps.getToolCacheSetting === "function"
      ? deps.getToolCacheSetting()
      : true; // default ON when tool-calling is enabled
    const toolResultCache = (state.useToolCalling && toolCacheSetting) ? new Map() : null;
    if (toolResultCache) {
      deps.debugLog("[Autoresearch] Tool result cache enabled");
    }

    // ── Phase 1a: Generate test cases + criteria (with one retry) ───
    const miniModel = deps.getMiniModel();
    const maxTestCases = state.useToolCalling ? 3 : OPTIMIZATION_DEFAULTS.maxTestCases;
    let setupResult = await generateTestCasesAndCriteria(
      state, state.originalContent, miniModel, maxTestCases
    );

    if (setupResult.testCases.length === 0) {
      deps.debugLog("[Autoresearch] Setup failed to parse test cases, retrying once...");
      setupResult = await generateTestCasesAndCriteria(
        state, state.originalContent, miniModel, maxTestCases
      );
    }

    const { testCases, evalCriteria: rawCriteria } = setupResult;
    if (testCases.length === 0) {
      throw new Error("Failed to generate test cases from skill definition.");
    }

    state.testCases = testCases;
    state.evalCriteria = rawCriteria;

    deps.debugLog("[Autoresearch] Setup complete:", testCases.length, "test cases,", state.evalCriteria.length, "criteria");

    // ── Phase 1b: Run baseline ──────────────────────────────────────
    state.phase = "baseline";
    const judgeConfig = deps.getJudgeConfig();
    if (!judgeConfig) throw new Error("No LLM provider available for evaluation judge.");

    const baselineSimResult = await simulateAllTestCases(
      state, state.originalContent, state.testCases, miniModel, undefined, toolResultCache,
      OPTIMIZATION_DEFAULTS.baselineToolCallingTimeoutMs, false  // no failover for baseline
    );
    if (baselineSimResult.inconclusive) {
      deps.debugLog("[Autoresearch] Baseline simulation timed out — falling back to LLM-only mode");
      state.useToolCalling = false;
      const llmResult = await simulateAllTestCases(
        state, state.originalContent, state.testCases, miniModel
      );
      baselineSimResult.responses = llmResult.responses;
    }
    const baselineResponses = baselineSimResult.responses;

    state.baselineScores = await scoreAllTestCases(
      state, baselineResponses, state.testCases, state.evalCriteria, judgeConfig
    );

    // Detect structurally unprovable criteria (e.g. write-dependent in tool-calling mode)
    const excludedCriteria = detectUnprovableCriteria(state.baselineScores, state.evalCriteria, state.useToolCalling);
    state.excludedCriteria = excludedCriteria;
    if (excludedCriteria.size > 0) {
      deps.debugLog("[Autoresearch] Excluded unprovable criteria:", [...excludedCriteria].join(", "));
    }

    state.baselinePassRate = computePassRate(state.baselineScores, state.evalCriteria.length, excludedCriteria);
    state.currentBestScores = state.baselineScores;
    state.currentBestPassRate = state.baselinePassRate;

    deps.debugLog("[Autoresearch] Baseline pass rate:", Math.round(state.baselinePassRate * 100) + "%");

    // Log per-criterion pass rates for diagnostics
    const criterionPassCounts = {};
    for (const s of state.baselineScores) {
      for (const r of (s.results || [])) {
        if (!criterionPassCounts[r.id]) criterionPassCounts[r.id] = { pass: 0, fail: 0 };
        if (r.pass) criterionPassCounts[r.id].pass++;
        else criterionPassCounts[r.id].fail++;
      }
    }
    deps.debugLog("[Autoresearch] Baseline per-criterion:",
      Object.entries(criterionPassCounts).map(([id, c]) => `${id}: ${c.pass}/${c.pass + c.fail}`).join(", "));

    // ── Phase 2: Mutation loop ──────────────────────────────────────
    state.phase = "mutating";
    const triedAspects = new Set();
    const criterionFailStreak = {};  // id → consecutive mutation failures
    const wallCriteria = new Set();  // criteria deprioritised after repeated failures
    // Seed wall criteria with unprovable ones so they're excluded from mutation prompts
    for (const id of excludedCriteria) wallCriteria.add(id);

    while (true) {
      const stopCheck = shouldStop(state, budgetUsd);
      if (stopCheck.stop) {
        deps.debugLog("[Autoresearch] Stopping:", stopCheck.reason);
        state.stopReason = stopCheck.reason;
        break;
      }

      state.iteration++;
      const failingSummary = buildFailingSummary(state.currentBestScores, state.testCases, state.evalCriteria, wallCriteria);
      const aspect = selectMutationAspect(failingSummary, triedAspects, state.currentBestContent, state.iteration);
      triedAspects.add(aspect);

      deps.debugLog("[Autoresearch] Iteration", state.iteration, "— aspect:", aspect);

      // Mutate
      const mutatedContent = await mutateSkill(
        state, state.currentBestContent, failingSummary, aspect,
        state.currentBestPassRate, miniModel, state.usePowerMutation
      );

      if (!mutatedContent.trim() || mutatedContent === state.currentBestContent) {
        state.consecutiveDiscards++;
        state.mutationsDiscarded.push({ aspect, description: "no change produced" });
        continue;
      }

      // Validate and fix tool references before testing
      const validation = await validateAndFixToolReferences(mutatedContent);
      if (validation.stripped.length > 0) {
        deps.debugLog("[Autoresearch] Stripped invalid tool references:",
          validation.stripped.join(", "));
      }
      const validatedContent = validation.content;

      // Simulate mutated version
      const iterationStart = Date.now();
      const wallClockDeadline = iterationStart + OPTIMIZATION_DEFAULTS.iterationWallClockMs;
      const simResult = await simulateAllTestCases(
        state, validatedContent, state.testCases, miniModel, wallClockDeadline, toolResultCache,
        undefined, true  // allow failover for mutations (cache-assisted, cheaper)
      );
      if (simResult.inconclusive) {
        deps.debugLog("[Autoresearch] Iteration", state.iteration, "inconclusive (timeout/overtime) — not counting toward plateau");
        state.mutationsDiscarded.push({ aspect, description: "inconclusive (timeout)" });
        continue;  // Do NOT increment consecutiveDiscards
      }
      const mutatedResponses = simResult.responses;

      if (mutatedResponses.length < state.testCases.length) {
        // Budget stopped before simulation
        state.stopReason = STOP_REASONS.budget;
        break;
      }

      // Wall-clock check before scoring (the other expensive step)
      if (Date.now() > wallClockDeadline) {
        deps.debugLog("[Autoresearch] Iteration", state.iteration, "exceeded wall-clock cap before scoring — inconclusive");
        state.mutationsDiscarded.push({ aspect, description: "inconclusive (wall-clock cap)" });
        continue;
      }

      // Score mutated version
      const mutatedScores = await scoreAllTestCases(
        state, mutatedResponses, state.testCases, state.evalCriteria, judgeConfig
      );
      const mutatedPassRate = computePassRate(mutatedScores, state.evalCriteria.length, state.excludedCriteria);

      // Log per-criterion for this mutation
      const mutCriterionCounts = {};
      for (const s of mutatedScores) {
        for (const r of (s.results || [])) {
          if (!mutCriterionCounts[r.id]) mutCriterionCounts[r.id] = { pass: 0, fail: 0 };
          if (r.pass) mutCriterionCounts[r.id].pass++;
          else mutCriterionCounts[r.id].fail++;
        }
      }
      deps.debugLog("[Autoresearch] Mutation per-criterion:",
        Object.entries(mutCriterionCounts).map(([id, c]) => `${id}: ${c.pass}/${c.pass + c.fail}`).join(", "));

      // Helper: track which criteria caused a discard (for wall-criteria detection)
      const trackDiscardFailures = (scores) => {
        // Find criteria that failed in this mutation but passed in current best
        for (const s of scores) {
          for (const r of (s.results || [])) {
            if (!r.pass) {
              criterionFailStreak[r.id] = (criterionFailStreak[r.id] || 0) + 1;
              if (criterionFailStreak[r.id] >= OPTIMIZATION_DEFAULTS.wallCriterionFailLimit && !wallCriteria.has(r.id)) {
                wallCriteria.add(r.id);
                // Also exclude from pass-rate so the optimizer stops chasing an unachievable target.
                // Recalculate currentBestPassRate on the same exclusion basis so future comparisons
                // are apples-to-apples.
                state.excludedCriteria.add(r.id);
                state.currentBestPassRate = computePassRate(
                  state.currentBestScores, state.evalCriteria.length, state.excludedCriteria
                );
                deps.debugLog("[Autoresearch] Wall criterion detected:", r.id,
                  "— excluded from pass rate. Adjusted current best:", Math.round(state.currentBestPassRate * 100) + "%");
              }
            }
          }
        }
      };

      // Check for regression — discard mutation but continue the loop
      const regression = detectRegression(state.currentBestScores, mutatedScores);
      if (regression) {
        deps.debugLog("[Autoresearch] Regression detected:", regression.id, "failed on", regression.failures, "test cases — discarding mutation, continuing loop");
        state.consecutiveDiscards++;
        state.mutationsDiscarded.push({ aspect, description: `regression on ${regression.id}` });
        trackDiscardFailures(mutatedScores);
        continue;
      }

      // Accept if score strictly improves. On a tie, accept only if the mutation
      // does not grow the skill (size-neutral or shorter). Ties that add content
      // are rejected — they bloat the skill with no measurable benefit.
      const isTie = mutatedPassRate === state.currentBestPassRate;
      const isShorterOrEqual = validatedContent.length <= state.currentBestContent.length;
      if (mutatedPassRate > state.currentBestPassRate || (isTie && isShorterOrEqual)) {
        deps.debugLog("[Autoresearch] Mutation accepted:", aspect,
          Math.round(state.currentBestPassRate * 100) + "% ->", Math.round(mutatedPassRate * 100) + "%");
        state.currentBestContent = validatedContent;
        state.currentBestScores = mutatedScores;
        state.currentBestPassRate = mutatedPassRate;
        state.mutationsAccepted.push({ aspect, description: `${aspect.replace(/_/g, " ")} improvement` });
        state.consecutiveDiscards = 0;
        // Reset fail streaks on acceptance — the content changed
        for (const id of Object.keys(criterionFailStreak)) criterionFailStreak[id] = 0;
      } else {
        deps.debugLog("[Autoresearch] Mutation discarded:", aspect,
          "rate:", Math.round(mutatedPassRate * 100) + "%",
          "vs current best:", Math.round(state.currentBestPassRate * 100) + "%");
        state.consecutiveDiscards++;
        trackDiscardFailures(mutatedScores);
        state.mutationsDiscarded.push({ aspect, description: isTie ? "tie — content grew" : "no improvement" });
      }

      // Progress toast every 2 iterations so the user knows it's alive
      if (state.iteration % 2 === 0 && typeof deps.showProgressToast === "function") {
        const pct = Math.round(state.currentBestPassRate * 100);
        const accepted = state.mutationsAccepted.length;
        deps.showProgressToast(
          `Optimising "${state.skillName}"`,
          `Iteration ${state.iteration}: ${pct}% pass rate (${accepted} accepted, $${state.totalCostUsd.toFixed(2)} spent)`
        );
      }
    }

    if (toolResultCache) {
      deps.debugLog("[Autoresearch] Tool cache entries:", toolResultCache.size);
    }

    // ── Phase 3: Debrief ────────────────────────────────────────────
    state.phase = "debrief";
    const improved = state.currentBestPassRate > state.baselinePassRate;
    const baselinePct = Math.round(state.baselinePassRate * 100);
    const finalPct = Math.round(state.currentBestPassRate * 100);

    // Build per-criterion baseline summary for the chat report
    const baselineCriterionSummary = {};
    for (const s of state.baselineScores) {
      for (const r of (s.results || [])) {
        if (!baselineCriterionSummary[r.id]) baselineCriterionSummary[r.id] = { pass: 0, total: 0 };
        baselineCriterionSummary[r.id].total++;
        if (r.pass) baselineCriterionSummary[r.id].pass++;
      }
    }
    const criteriaLines = Object.entries(baselineCriterionSummary)
      .map(([id, c]) => {
        const finalC = {};
        for (const s of state.currentBestScores) {
          for (const r of (s.results || [])) {
            if (!finalC[r.id]) finalC[r.id] = { pass: 0, total: 0 };
            finalC[r.id].total++;
            if (r.pass) finalC[r.id].pass++;
          }
        }
        const f = finalC[id] || c;
        return `- ${id.replace(/_/g, " ")}: ${c.pass}/${c.total} \u2192 ${f.pass}/${f.total}`;
      })
      .join("\n");

    const mutationLog = [
      ...state.mutationsAccepted.map(m => `- **accepted**: ${m.description}`),
      ...state.mutationsDiscarded.map(m => `- discarded: ${m.description}`),
    ].join("\n");

    const statsLine = `${state.mutationsAccepted.length + state.mutationsDiscarded.length} mutations tried, `
      + `${state.mutationsAccepted.length} accepted, `
      + `$${state.totalCostUsd.toFixed(2)} spent, `
      + `stopped: ${state.stopReason || "complete"}`;

    if (improved) {
      // Determine accept/revert via toast or chat panel
      const panelOpen = typeof deps.getChatPanelIsOpen === "function" && deps.getChatPanelIsOpen();

      let userChoice;
      if (panelOpen) {
        // Post summary to chat panel with accept/revert prompt
        const chatSummary = `#### Skill "${state.skillName}" Optimised: ${baselinePct}% \u2192 ${finalPct}%\n\n`
          + `**Per-criterion:**\n${criteriaLines}\n\n`
          + `**Mutations:**\n${mutationLog}\n\n`
          + `**Stats:** ${statsLine}\n\n`
          + `**Optimised skill:**\n\`\`\`\n${state.currentBestContent}\n\`\`\``;
        deps.appendChatPanelMessage("assistant", chatSummary);

        // Still need accept/revert — use toast for the action buttons
        deps.debugLog("[Autoresearch] Awaiting user accept/revert for", state.skillName);
        userChoice = await deps.showOptimizationResultToast({
          title: `Accept "${state.skillName}"?`,
          message: `${baselinePct}% \u2192 ${finalPct}% — see chat for details`,
          onAccept: async () => {
            try {
              await deps.updateChiefMemory({
                page: "skills", action: "replace_children",
                block_uid: state.blockUid, content: state.currentBestContent,
              });
              deps.debugLog("[Autoresearch] Skill updated in Roam");
              deps.appendChatPanelMessage("assistant", `Skill "${state.skillName}" updated in Roam.`);
            } catch (err) {
              deps.debugLog("[Autoresearch] Accept write failed:", err?.message);
              deps.appendChatPanelMessage("assistant", `**Write failed** — copy the skill content above and paste manually.`);
            }
          },
          onRevert: () => {
            deps.debugLog("[Autoresearch] User reverted — no changes written");
            deps.appendChatPanelMessage("assistant", `Reverted — no changes written to "${state.skillName}".`);
          },
        });
      } else {
        // Panel closed — use toast only, post summary after action
        deps.debugLog("[Autoresearch] Awaiting user accept/revert for", state.skillName);
        userChoice = await deps.showOptimizationResultToast({
          title: `Skill "${state.skillName}" Optimised`,
          message: `${baselinePct}% \u2192 ${finalPct}% (${state.mutationsAccepted.length} accepted, $${state.totalCostUsd.toFixed(2)})`,
          onAccept: async () => {
            let writeFailed = false;
            try {
              await deps.updateChiefMemory({
                page: "skills", action: "replace_children",
                block_uid: state.blockUid, content: state.currentBestContent,
              });
              deps.debugLog("[Autoresearch] Skill updated in Roam");
            } catch (err) {
              writeFailed = true;
              deps.debugLog("[Autoresearch] Accept write failed:", err?.message);
            }
            if (typeof deps.appendChatPanelMessage === "function") {
              const header = writeFailed
                ? `**Skill write blocked** — copy the content below and paste manually:`
                : `**Optimised "${state.skillName}"** (${baselinePct}% \u2192 ${finalPct}%):`;
              deps.appendChatPanelMessage("assistant",
                `${header}\n\n**Per-criterion:**\n${criteriaLines}\n\n\`\`\`\n${state.currentBestContent}\n\`\`\``);
            }
          },
          onRevert: () => {
            deps.debugLog("[Autoresearch] User reverted — no changes written");
            deps.appendChatPanelMessage("assistant", `Reverted — no changes written to "${state.skillName}".`);
          },
        });
      }

      await persistDebriefResults(state);
      deps.debugLog("[Autoresearch] Debrief complete. User choice:", userChoice);
    } else {
      // No improvement — post summary to chat panel
      const alreadyPerfect = state.stopReason === STOP_REASONS.perfect
        && state.mutationsAccepted.length === 0
        && state.mutationsDiscarded.length === 0;
      const noImproveSummary = alreadyPerfect
        ? `#### Skill "${state.skillName}" — already at 100%\n\n**Baseline:** ${baselinePct}% — no iterations needed.\n\n**Per-criterion:**\n${criteriaLines}\n\n**Stats:** ${statsLine}`
        : `#### Skill "${state.skillName}" — no improvement found\n\n`
          + `**Baseline:** ${baselinePct}%\n\n`
          + `**Per-criterion:**\n${criteriaLines}\n\n`
          + `**Stats:** ${statsLine}`;
      if (typeof deps.appendChatPanelMessage === "function") {
        deps.appendChatPanelMessage("assistant", noImproveSummary);
      }

      const panelOpen = typeof deps.getChatPanelIsOpen === "function" && deps.getChatPanelIsOpen();
      if (!panelOpen) {
        deps.showOptimizationResultToast({
          title: `Skill "${state.skillName}"`,
          message: alreadyPerfect
            ? `Already at 100% \u2014 no iterations needed ($${state.totalCostUsd.toFixed(2)} spent).`
            : `Already performing well \u2014 no improvements found ($${state.totalCostUsd.toFixed(2)} spent).`,
          onAccept: () => {},
          onRevert: () => {},
        });
      }
      await persistDebriefResults(state);
    }

    state.phase = "done";
    return {
      improved,
      baselineRate: state.baselinePassRate,
      finalRate: state.currentBestPassRate,
      cost: state.totalCostUsd,
      reason: state.stopReason || (improved ? STOP_REASONS.perfect : STOP_REASONS.plateau),
      mutationsAccepted: state.mutationsAccepted.length,
      mutationsDiscarded: state.mutationsDiscarded.length,
    };
  } catch (err) {
    deps.debugLog("[Autoresearch] Optimization failed:", err?.message || err);
    throw err;
  } finally {
    activeOptimization = null;
  }
}
