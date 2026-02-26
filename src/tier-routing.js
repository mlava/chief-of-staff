// ─── Tier Routing: Complexity-Based Model Selection ──────────────────────────
//
// Three scoring strategies that replace the binary mini/power regex-based
// escalation with a nuanced 0–1 complexity score.
//
// Integration point: `askChiefOfStaff()` calls `computeRoutingScore()` which
// returns { score, tier, signals } before `runAgentLoopWithFailover`.
//
// Tuning: adjust TIER_THRESHOLDS and per-signal weights empirically using
// lastAgentRunTrace data. The thresholds below are starting points.

// ─── Constants ───────────────────────────────────────────────────────────────

const TIER_THRESHOLDS = {
  power: 0.45,     // score >= 0.45 → power tier
  ludicrous: 0.90  // score >= 0.90 → ludicrous (if enabled) — raised from 0.82 to reserve for truly novel reasoning
};

// Relative weights for each scoring strategy (must sum to 1.0)
const STRATEGY_WEIGHTS = {
  toolCount: 0.40,
  promptComplexity: 0.35,
  trajectory: 0.25
};

// ─── Strategy 1: Tool-Count Heuristic ────────────────────────────────────────
//
// Estimates how many distinct tool calls the prompt is likely to need by:
//   a) Matching against skill definitions (which list their Sources)
//   b) Detecting tool-adjacent keywords in the prompt
//
// Input:
//   prompt        — raw user message
//   skillEntries  — array from getSkillEntries(), each { title, content }
//   knownToolNames — Set of all registered tool names
//   parseSkillSources — the existing function that extracts sources from skill content
//
// Returns: { score: 0–1, estimatedTools: number, matchedSkill: string|null }

function scoreToolCount(prompt, { skillEntries = [], knownToolNames = new Set(), parseSkillSources = null } = {}) {
  const lower = prompt.toLowerCase();
  let estimatedTools = 0;
  let matchedSkill = null;

  // Phase 1: Check if prompt matches a known skill → use its source count
  if (parseSkillSources && skillEntries.length > 0) {
    let bestMatch = null;
    let bestScore = 0;

    for (const entry of skillEntries) {
      const titleLower = (entry.title || "").toLowerCase();
      const titleWords = titleLower.split(/\s+/).filter(w => w.length > 2);

      // Simple word-overlap scoring between prompt and skill title
      let overlap = 0;
      for (const word of titleWords) {
        if (lower.includes(word)) overlap += 1;
      }
      const matchScore = titleWords.length > 0 ? overlap / titleWords.length : 0;

      if (matchScore > bestScore && matchScore >= 0.5) {
        bestScore = matchScore;
        bestMatch = entry;
      }
    }

    if (bestMatch) {
      matchedSkill = bestMatch.title;
      const sources = parseSkillSources(bestMatch.content, knownToolNames);
      estimatedTools = sources.length;
    }
  }

  // Phase 2: If no skill matched, estimate from keyword signals
  if (estimatedTools === 0) {
    const toolSignals = [
      // Multi-source gathering patterns
      { pattern: /\b(calendar|schedule|meeting|events?)\b/i, tools: 1 },
      { pattern: /\b(email|gmail|inbox|messages?)\b/i, tools: 1 },
      { pattern: /\b(tasks?|todos?|overdue|due\s+(?:today|this\s+week))\b/i, tools: 1 },
      { pattern: /\b(projects?|project\s+status)\b/i, tools: 2 },
      { pattern: /\b(search|find|look\s*up)\b/i, tools: 1 },
      { pattern: /\b(create|add|make|write|save)\b/i, tools: 1 },
      { pattern: /\b(update|modify|change|edit)\b/i, tools: 1 },
      { pattern: /\b(delete|remove|cancel)\b/i, tools: 1 },
      { pattern: /\b(memory|remember|recall)\b/i, tools: 1 },
      { pattern: /\b(weather|forecast)\b/i, tools: 1 },
      // Compound intent indicators (suggest multi-tool)
      { pattern: /\b(and\s+then|after\s+that|also|plus)\b/i, tools: 1 },
      { pattern: /\b(compare|versus|vs\.?|trade-?offs?)\b/i, tools: 1 },
    ];

    for (const signal of toolSignals) {
      if (signal.pattern.test(prompt)) {
        estimatedTools += signal.tools;
      }
    }
  }

  // Map tool count to 0–1 score
  // 0 tools → 0.0, 1–2 → 0.1–0.3, 3–5 → 0.4–0.6, 6+ → 0.7–1.0
  let score;
  if (estimatedTools === 0) score = 0.0;
  else if (estimatedTools <= 2) score = 0.1 + (estimatedTools / 2) * 0.2;
  else if (estimatedTools <= 5) score = 0.3 + ((estimatedTools - 2) / 3) * 0.3;
  else score = Math.min(1.0, 0.6 + ((estimatedTools - 5) / 5) * 0.4);

  return { score, estimatedTools, matchedSkill };
}


// ─── Strategy 2: Prompt Complexity Scoring ───────────────────────────────────
//
// Analyses the raw prompt text for complexity signals using cheap string ops.
// No LLM call needed.
//
// Input: prompt — raw user message
// Returns: { score: 0–1, signals: string[] }

function scorePromptComplexity(prompt) {
  const signals = [];
  let rawScore = 0;

  const words = prompt.split(/\s+/).length;
  const lower = prompt.toLowerCase();

  // 1. Length — longer prompts tend to be more complex
  if (words > 100) { rawScore += 2.0; signals.push("long_prompt"); }
  else if (words > 50) { rawScore += 1.0; signals.push("medium_prompt"); }
  else if (words > 25) { rawScore += 0.5; }

  // 2. Entity count — people, projects, page refs
  const pageRefs = (prompt.match(/\[\[[^\]]+\]\]/g) || []).length;
  const atMentions = (prompt.match(/@\w+/g) || []).length;
  const properNouns = (prompt.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g) || []).length;
  const entityCount = pageRefs + atMentions + Math.floor(properNouns / 2);
  if (entityCount >= 4) { rawScore += 2.0; signals.push("many_entities"); }
  else if (entityCount >= 2) { rawScore += 1.0; signals.push("multiple_entities"); }

  // 3. Temporal reasoning — relative dates, ranges, comparisons across time
  const temporalPatterns = [
    /\b(this\s+week|next\s+week|last\s+week|past\s+\d+\s+days?)\b/i,
    /\b(since|until|between|from\s+\w+\s+to)\b/i,
    /\b(yesterday|tomorrow|today|tonight|this\s+morning)\b/i,
    /\b(overdue|upcoming|deadline|due\s+(date|by|before))\b/i,
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i,
  ];
  const temporalHits = temporalPatterns.filter(p => p.test(prompt)).length;
  if (temporalHits >= 2) { rawScore += 1.5; signals.push("temporal_reasoning"); }
  else if (temporalHits === 1) { rawScore += 0.5; }

  // 4. Conditional / comparative language — reasoning required
  if (/\b(should\s+i|would\s+it\s+be|is\s+it\s+worth|pros?\s+and\s+cons?|trade-?offs?)\b/i.test(prompt)) {
    rawScore += 1.5; signals.push("deliberation");
  }
  if (/\b(compare|versus|vs\.?|better|worse|alternatively)\b/i.test(prompt)) {
    rawScore += 1.5; signals.push("comparison");
  }
  // Compound signal: comparing across multiple data sources is almost always power-tier work
  if (entityCount >= 2 && signals.includes("comparison")) {
    rawScore += 1.5; signals.push("multi_entity_comparison");
  }
  if (/\b(if|unless|assuming|depending\s+on|in\s+case)\b/i.test(prompt)) {
    rawScore += 0.5; signals.push("conditional");
  }

  // 5. Multi-step intent — chained actions
  const chainMarkers = (lower.match(/\b(and\s+then|after\s+that|once\s+(?:that'?s?|you'?ve?)|then\s+also|next|finally|first|second|third)\b/gi) || []).length;
  if (chainMarkers >= 3) { rawScore += 2.0; signals.push("multi_step_chain"); }
  else if (chainMarkers >= 1) { rawScore += 0.75; signals.push("sequenced"); }

  // 6. Ambiguity markers — model needs to clarify or reason
  if (/\b(not\s+sure|maybe|i\s+think|probably|might|could\s+be|vague|unclear)\b/i.test(prompt)) {
    rawScore += 1.0; signals.push("ambiguous");
  }

  // 7. Synthesis / creative output — needs higher reasoning capacity
  if (/\b(summarise|summarize|synthesise|synthesize|analyse|analyze|review|reflect|retrospective|retro)\b/i.test(prompt)) {
    rawScore += 1.5; signals.push("synthesis");
  }
  if (/\b(plan|strategy|prioriti[sz]e|roadmap|architect)\b/i.test(prompt)) {
    rawScore += 1.0; signals.push("planning");
  }
  if (/\b(draft|compose|write|author)\b/i.test(lower) && words > 15) {
    rawScore += 0.75; signals.push("composition");
  }

  // 8. Negation of simplicity — "don't just X, actually Y"
  if (/\b(don'?t\s+just|not\s+just|more\s+than\s+just|actually|thoroughly|comprehensive|in[- ]depth)\b/i.test(prompt)) {
    rawScore += 1.0; signals.push("explicit_depth");
  }

  // Normalise to 0–1 (ceiling at rawScore 10)
  const score = Math.min(1.0, rawScore / 10);

  return { score, signals };
}


// ─── Strategy 4: Conversation Trajectory Tracking ────────────────────────────
//
// Accumulates a complexity score across the conversation session. Each turn's
// actual outcome (tool calls, iterations, provider used) feeds back into a
// running score that influences routing for subsequent turns.
//
// State is stored in a module-scoped object, reset when conversation is cleared.
//
// The trajectory score for the NEXT turn is based on:
//   - Tool calls in prior turns (weighted by recency)
//   - Agent iterations used (proxy for reasoning difficulty)
//   - Whether prior turns needed escalation or failover
//   - Whether the current prompt looks like a follow-up to a complex turn

const sessionTrajectory = {
  turns: [],  // { toolCount, iterations, tier, escalated, timestamp }
  reset() { this.turns = []; }
};

/**
 * Record the outcome of a completed agent run.
 * Call this after runAgentLoopWithFailover returns (or in the trace finalisation).
 *
 * @param {object} traceData
 * @param {number} traceData.toolCallCount              — number of tool calls in this run
 * @param {number} traceData.uniqueToolCount            — number of distinct tool names called
 * @param {number} traceData.successfulUniqueToolCount  — distinct tool names that succeeded (no error)
 * @param {number} traceData.iterations                 — agent loop iterations used
 * @param {string} traceData.tier                       — actual tier used (mini/power/ludicrous)
 * @param {boolean} traceData.escalated                 — whether auto-escalation occurred
 * @param {boolean} traceData.failedOver                — whether provider failover occurred
 */
function recordTurnOutcome(traceData) {
  const tc = traceData.toolCallCount || 0;
  const utc = traceData.uniqueToolCount ?? tc;
  sessionTrajectory.turns.push({
    toolCount: tc,
    uniqueToolCount: utc,
    successfulUniqueToolCount: traceData.successfulUniqueToolCount ?? utc,
    iterations: traceData.iterations || 0,
    tier: traceData.tier || "mini",
    escalated: Boolean(traceData.escalated),
    failedOver: Boolean(traceData.failedOver),
    timestamp: Date.now()
  });

  // Keep only last 8 turns to bound memory
  if (sessionTrajectory.turns.length > 8) {
    sessionTrajectory.turns = sessionTrajectory.turns.slice(-8);
  }
}

/**
 * Compute a trajectory-based complexity score for the next turn.
 *
 * @param {string} prompt — the incoming user message
 * @returns {{ score: number, signals: string[] }}
 */
function scoreTrajectory(prompt) {
  const signals = [];
  const turns = sessionTrajectory.turns;

  if (turns.length === 0) return { score: 0, signals: [] };

  // 1. Recency-weighted tool count average (recent turns count more)
  let weightedToolSum = 0;
  let weightSum = 0;
  for (let i = 0; i < turns.length; i++) {
    const recencyWeight = (i + 1) / turns.length; // 0.x for old, 1.0 for most recent
    weightedToolSum += turns[i].toolCount * recencyWeight;
    weightSum += recencyWeight;
  }
  const avgTools = weightSum > 0 ? weightedToolSum / weightSum : 0;

  if (avgTools >= 5) { signals.push("high_tool_trajectory"); }
  else if (avgTools >= 3) { signals.push("moderate_tool_trajectory"); }

  // 2. Recent iteration count (high iterations = model struggled)
  const recentTurns = turns.slice(-3);
  const avgIterations = recentTurns.reduce((s, t) => s + t.iterations, 0) / recentTurns.length;
  if (avgIterations >= 4) { signals.push("high_iteration_trajectory"); }

  // 3. Escalation history — if recent turns were escalated, follow-ups likely need power too
  const recentEscalations = recentTurns.filter(t => t.escalated || t.tier !== "mini").length;
  if (recentEscalations >= 2) { signals.push("repeated_escalation"); }

  // 4. Follow-up detection — short prompts after complex turns are likely continuations
  const lastTurn = turns[turns.length - 1];
  const words = prompt.split(/\s+/).length;
  const isShortFollowUp = words <= 12;
  // Guard retries (empty-response, live-data) inflate iteration count without
  // genuine complexity. A "struggling" turn — where the model hallucinated a
  // tool, explored random tools, and most calls failed — shouldn't poison the
  // trajectory for the next turn. We use successfulUniqueToolCount (distinct
  // tool names that returned without error) as the complexity signal:
  // - Same tool failing repeatedly (cos_get-current-time × 2): successfulUnique = 0
  // - Multiple tools called but most failed: successfulUnique = 1
  // - Genuinely complex multi-tool work: successfulUnique >= 2
  const successfulUnique = lastTurn?.successfulUniqueToolCount ?? lastTurn?.uniqueToolCount ?? lastTurn?.toolCount ?? 0;
  const lastWasComplex = lastTurn && (
    (lastTurn.toolCount >= 4 && successfulUnique >= 2) ||
    (lastTurn.iterations >= 3 && lastTurn.toolCount >= 2 && successfulUnique >= 2) ||
    lastTurn.tier !== "mini"
  );

  if (isShortFollowUp && lastWasComplex) {
    signals.push("complex_followup");
  }

  // 5. Write-after-read pattern — "now do X" after a gathering turn
  // Relaxed: removed iterations constraint — skill-driven gathering often uses
  // many iterations due to sequential tool calls, not because the model struggled.
  const isWriteIntent = /\b(apply|do|create|make|fix|update|write|save|implement|build|set\s*up|draft)\b/i.test(prompt);
  const lastWasGathering = lastTurn && lastTurn.toolCount >= 3;
  if (isWriteIntent && lastWasGathering) {
    signals.push("write_after_gather");
  }

  // Compute score from signals
  let rawScore = 0;

  // Tool trajectory contributes up to 3 points
  rawScore += Math.min(3, avgTools * 0.5);

  // Iteration trajectory contributes up to 2 points
  rawScore += Math.min(2, avgIterations * 0.4);

  // Escalation history contributes up to 2.5 points
  rawScore += recentEscalations * 0.8;

  // Follow-up boost
  if (signals.includes("complex_followup")) rawScore += 2.0;
  if (signals.includes("write_after_gather")) rawScore += 1.5;

  // Normalise to 0–1 (ceiling at rawScore 8)
  const score = Math.min(1.0, rawScore / 8);

  return { score, signals };
}


// ─── Composite Router ────────────────────────────────────────────────────────
//
// Combines all three strategies into a single routing decision.
//
// Returns:
//   {
//     score: number (0–1),
//     tier: "mini" | "power" | "ludicrous",
//     breakdown: { toolCount, promptComplexity, trajectory },
//     signals: string[],
//     reason: string
//   }

function computeRoutingScore(prompt, options = {}) {
  const {
    skillEntries = [],
    knownToolNames = new Set(),
    parseSkillSourcesFn = null,
    ludicrousEnabled = false,
    mentionsDirectMcpServer = false,
    sessionUsedLocalMcp = false
  } = options;
  // Run each strategy
  const tc = scoreToolCount(prompt, {
    skillEntries,
    knownToolNames,
    parseSkillSources: parseSkillSourcesFn
  });
  const pc = scorePromptComplexity(prompt);
  const tr = scoreTrajectory(prompt);

  // Weighted composite
  let compositeScore =
    tc.score * STRATEGY_WEIGHTS.toolCount +
    pc.score * STRATEGY_WEIGHTS.promptComplexity +
    tr.score * STRATEGY_WEIGHTS.trajectory;

  // Skill-match boost: when a known multi-source skill is matched, the tool-count
  // signal alone is authoritative enough to push past the power threshold, even if
  // the prompt text is short/simple. Without this, "run my weekly review" (4 tools,
  // but only 6 words) would score below threshold because prompt complexity is low.
  // The boost scales with tool count: 3 tools → 0.20, 4+ → 0.25.
  if (tc.matchedSkill && tc.estimatedTools >= 3) {
    const boost = tc.estimatedTools >= 4 ? 0.25 : 0.20;
    compositeScore = Math.min(1.0, compositeScore + boost);
  }

  // Direct MCP server mention: add a soft tool-count signal instead of hard-escalating.
  // This nudges the score up when a direct MCP server is referenced, without
  // force-escalating simple queries like "what's on my calendar today?"
  if (options.mentionsDirectMcpServer) {
    compositeScore = Math.min(1.0, compositeScore + 0.08);
  }

  // Active MCP session follow-up: when a prior turn used Local MCP tools, add a
  // moderate boost. This replaces the former hard-escalation that force-promoted
  // every follow-up to power tier. The boost is larger than mentionsDirectMcpServer
  // because the session has already proven it needs MCP tools — but still soft enough
  // that trivial follow-ups ("thanks", "ok") won't cross the power threshold on
  // their own. Combined with trajectory signals (complex_followup, repeated_escalation),
  // substantive follow-ups will still reach power tier.
  const isMcpFollowUp = Boolean(options.sessionUsedLocalMcp);
  if (isMcpFollowUp) {
    compositeScore = Math.min(1.0, compositeScore + 0.15);
  }

  // Trajectory override: when a short follow-up clearly continues a complex turn,
  // the trajectory score alone should be sufficient to reach power threshold,
  // regardless of how simple the prompt text looks. Without this, "now apply those
  // changes" after a 9-iteration skill run scores ~0.24 because prompt complexity
  // and tool-count strategies both return near-zero for a 4-word prompt.
  if (tr.signals.includes("complex_followup") && tr.score >= 0.4) {
    compositeScore = Math.max(compositeScore, TIER_THRESHOLDS.power);
  }

  // Collect all signals
  const allSignals = [
    ...(tc.matchedSkill ? [`skill:${tc.matchedSkill}`] : []),
    ...pc.signals,
    ...tr.signals,
    ...(isMcpFollowUp ? ["mcp_session_followup"] : [])
  ];

  // Determine tier
  let tier = "mini";
  let reason = "below power threshold";

  if (ludicrousEnabled && compositeScore >= TIER_THRESHOLDS.ludicrous) {
    // Skill-ceiling cap: skill-driven work follows a prescribed tool sequence,
    // so power tier is always sufficient. Reserve ludicrous for truly novel
    // reasoning that stacks many complexity signals without a skill template.
    if (tc.matchedSkill) {
      tier = "power";
      reason = `skill-matched "${tc.matchedSkill}", capped at power (score was ${compositeScore.toFixed(2)})`;
    } else {
      tier = "ludicrous";
      reason = `score ${compositeScore.toFixed(2)} >= ${TIER_THRESHOLDS.ludicrous} (ludicrous)`;
    }
  } else if (compositeScore >= TIER_THRESHOLDS.power) {
    tier = "power";
    reason = `score ${compositeScore.toFixed(2)} >= ${TIER_THRESHOLDS.power} (power)`;
  } else {
    reason = `score ${compositeScore.toFixed(2)} < ${TIER_THRESHOLDS.power} (staying mini)`;
  }

  return {
    score: compositeScore,
    tier,
    breakdown: {
      toolCount: { score: tc.score, estimated: tc.estimatedTools, matchedSkill: tc.matchedSkill },
      promptComplexity: { score: pc.score, signals: pc.signals },
      trajectory: { score: tr.score, signals: tr.signals }
    },
    signals: allSignals,
    reason
  };
}


// ─── Exports ─────────────────────────────────────────────────────────────────

export {
  // Core router
  computeRoutingScore,

  // Individual strategies (for testing / tuning)
  scoreToolCount,
  scorePromptComplexity,
  scoreTrajectory,

  // Session state
  sessionTrajectory,
  recordTurnOutcome,

  // Config (importable for override)
  TIER_THRESHOLDS,
  STRATEGY_WEIGHTS
};
