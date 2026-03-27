import test from "node:test";
import assert from "node:assert/strict";
import {
  shouldSkipClassification,
  evaluateConfidence,
  hasTemporalScopeShift,
  buildClassificationUserMessage,
} from "../src/intent-classifier.js";

// ═════════════════════════════════════════════════════════════════════════════
// shouldSkipClassification
// ═════════════════════════════════════════════════════════════════════════════

test("shouldSkipClassification — skips when effectiveTier is power", () => {
  const result = shouldSkipClassification("do something", { effectiveTier: "power" });
  assert.equal(result.skip, true);
  assert.equal(result.reason, "explicit-tier-override");
});

test("shouldSkipClassification — skips when effectiveTier is ludicrous", () => {
  const result = shouldSkipClassification("do something", { effectiveTier: "ludicrous" });
  assert.equal(result.skip, true);
  assert.equal(result.reason, "explicit-tier-override");
});

test("shouldSkipClassification — skips when powerFlag is set", () => {
  const result = shouldSkipClassification("do something", { effectiveTier: "mini", powerFlag: true });
  assert.equal(result.skip, true);
  assert.equal(result.reason, "explicit-tier-override");
});

test("shouldSkipClassification — skips when ludicrousFlag is set", () => {
  const result = shouldSkipClassification("do something", { effectiveTier: "mini", ludicrousFlag: true });
  assert.equal(result.skip, true);
  assert.equal(result.reason, "explicit-tier-override");
});

test("shouldSkipClassification — skips when lessonFlag is set", () => {
  const result = shouldSkipClassification("teach me about blocks", { lessonFlag: true });
  assert.equal(result.skip, true);
  assert.equal(result.reason, "lesson-mode");
});

test("shouldSkipClassification — skips when routing matched a skill with score >= 0.5", () => {
  const result = shouldSkipClassification("run weekly review", {
    routingMatchedSkill: "Weekly Review",
    routingSkillMatchScore: 0.6
  });
  assert.equal(result.skip, true);
  assert.equal(result.reason, "skill-match");
});

test("shouldSkipClassification — does NOT skip when routing skill score < 0.5", () => {
  const result = shouldSkipClassification("run something", {
    routingMatchedSkill: "Weekly Review",
    routingSkillMatchScore: 0.3
  });
  assert.equal(result.skip, false);
});

test("shouldSkipClassification — skips short follow-up in conversation", () => {
  const result = shouldSkipClassification("yes please", {
    hasContext: true,
    conversationTurnCount: 2
  });
  assert.equal(result.skip, true);
  assert.equal(result.reason, "follow-up");
});

test("shouldSkipClassification — skips short follow-up: go ahead", () => {
  const result = shouldSkipClassification("go ahead", {
    hasContext: true,
    conversationTurnCount: 1
  });
  assert.equal(result.skip, true);
  assert.equal(result.reason, "follow-up");
});

test("shouldSkipClassification — does NOT skip follow-up with temporal shift", () => {
  const result = shouldSkipClassification("do the same for next week", {
    hasContext: true,
    conversationTurnCount: 2
  });
  assert.equal(result.skip, false);
});

test("shouldSkipClassification — does NOT skip follow-up with 'do that for' scope change", () => {
  const result = shouldSkipClassification("do that for a different page", {
    hasContext: true,
    conversationTurnCount: 1
  });
  assert.equal(result.skip, false);
});

test("shouldSkipClassification — does NOT skip follow-up with 'same for' scope change", () => {
  const result = shouldSkipClassification("same for the marketing page", {
    hasContext: true,
    conversationTurnCount: 2
  });
  assert.equal(result.skip, false);
});

test("shouldSkipClassification — does NOT skip follow-up with 'repeat for' scope change", () => {
  const result = shouldSkipClassification("repeat for last month", {
    hasContext: true,
    conversationTurnCount: 1
  });
  assert.equal(result.skip, false);
});

test("shouldSkipClassification — does NOT skip long follow-up (>= 15 words)", () => {
  const result = shouldSkipClassification(
    "actually I want you to do something completely different from what we discussed earlier please",
    { hasContext: true, conversationTurnCount: 3 }
  );
  assert.equal(result.skip, false);
});

test("shouldSkipClassification — skips simple read query", () => {
  const result = shouldSkipClassification("what meetings today");
  assert.equal(result.skip, true);
  assert.equal(result.reason, "simple-read");
});

test("shouldSkipClassification — skips simple read: show my tasks", () => {
  const result = shouldSkipClassification("show my tasks");
  assert.equal(result.skip, true);
  assert.equal(result.reason, "simple-read");
});

test("shouldSkipClassification — skips simple read: check email", () => {
  const result = shouldSkipClassification("check email");
  assert.equal(result.skip, true);
  assert.equal(result.reason, "simple-read");
});

test("shouldSkipClassification — does NOT skip read query with conjunctions", () => {
  const result = shouldSkipClassification("check email and then summarise tasks");
  assert.equal(result.skip, false);
});

test("shouldSkipClassification — does NOT skip ambiguous prompt", () => {
  const result = shouldSkipClassification("clean up my stuff");
  assert.equal(result.skip, false);
});

test("shouldSkipClassification — does NOT skip complex prompt", () => {
  const result = shouldSkipClassification(
    "compare my task completion this week vs last week and email me a summary"
  );
  assert.equal(result.skip, false);
});

test("shouldSkipClassification — does NOT skip without context even if short", () => {
  // Short but no conversation context — not a follow-up, and not a simple read
  const result = shouldSkipClassification("do that thing", { hasContext: false });
  assert.equal(result.skip, false);
});

// ═════════════════════════════════════════════════════════════════════════════
// hasTemporalScopeShift
// ═════════════════════════════════════════════════════════════════════════════

test("hasTemporalScopeShift — detects 'next week'", () => {
  assert.equal(hasTemporalScopeShift("do it for next week"), true);
});

test("hasTemporalScopeShift — detects 'last month'", () => {
  assert.equal(hasTemporalScopeShift("same thing but last month"), true);
});

test("hasTemporalScopeShift — detects 'same for'", () => {
  assert.equal(hasTemporalScopeShift("same for project alpha"), true);
});

test("hasTemporalScopeShift — detects 'repeat for'", () => {
  assert.equal(hasTemporalScopeShift("repeat for Q2"), true);
});

test("hasTemporalScopeShift — no match on plain follow-up", () => {
  assert.equal(hasTemporalScopeShift("yes please"), false);
});

test("hasTemporalScopeShift — detects 'different project'", () => {
  assert.equal(hasTemporalScopeShift("try a different project"), true);
});

// ═════════════════════════════════════════════════════════════════════════════
// evaluateConfidence
// ═════════════════════════════════════════════════════════════════════════════

test("evaluateConfidence — high confidence + low risk → proceed", () => {
  const result = evaluateConfidence({ confidence: 0.95, risk: "low" });
  assert.equal(result.action, "proceed");
  assert.equal(result.reason, "high-confidence");
});

test("evaluateConfidence — high confidence + high risk → proceed (confidence overrides)", () => {
  const result = evaluateConfidence({ confidence: 0.95, risk: "high" });
  assert.equal(result.action, "proceed");
  assert.equal(result.reason, "high-confidence");
});

test("evaluateConfidence — boundary 0.85 + any risk → proceed", () => {
  const result = evaluateConfidence({ confidence: 0.85, risk: "high" });
  assert.equal(result.action, "proceed");
  assert.equal(result.reason, "high-confidence");
});

test("evaluateConfidence — 0.84 + low risk → proceed", () => {
  const result = evaluateConfidence({ confidence: 0.84, risk: "low" });
  assert.equal(result.action, "proceed");
  assert.equal(result.reason, "medium-confidence-low-risk");
});

test("evaluateConfidence — 0.70 + medium risk → confirm", () => {
  const result = evaluateConfidence({ confidence: 0.70, risk: "medium" });
  assert.equal(result.action, "confirm");
  assert.equal(result.reason, "medium-confidence-elevated-risk");
});

test("evaluateConfidence — 0.70 + high risk → confirm", () => {
  const result = evaluateConfidence({ confidence: 0.70, risk: "high" });
  assert.equal(result.action, "confirm");
  assert.equal(result.reason, "medium-confidence-elevated-risk");
});

test("evaluateConfidence — boundary 0.60 + low risk → proceed", () => {
  const result = evaluateConfidence({ confidence: 0.60, risk: "low" });
  assert.equal(result.action, "proceed");
  assert.equal(result.reason, "medium-confidence-low-risk");
});

test("evaluateConfidence — boundary 0.60 + medium risk → confirm", () => {
  const result = evaluateConfidence({ confidence: 0.60, risk: "medium" });
  assert.equal(result.action, "confirm");
  assert.equal(result.reason, "medium-confidence-elevated-risk");
});

test("evaluateConfidence — 0.59 + low risk → clarify", () => {
  const result = evaluateConfidence({ confidence: 0.59, risk: "low" });
  assert.equal(result.action, "clarify");
  assert.equal(result.reason, "low-confidence");
});

test("evaluateConfidence — 0.30 + high risk → clarify", () => {
  const result = evaluateConfidence({ confidence: 0.30, risk: "high" });
  assert.equal(result.action, "clarify");
  assert.equal(result.reason, "low-confidence");
});

test("evaluateConfidence — 0.0 + low risk → clarify", () => {
  const result = evaluateConfidence({ confidence: 0.0, risk: "low" });
  assert.equal(result.action, "clarify");
  assert.equal(result.reason, "low-confidence");
});

test("evaluateConfidence — missing fields default safely", () => {
  const result = evaluateConfidence({});
  assert.equal(result.action, "clarify");
  assert.equal(result.reason, "low-confidence");
});

test("evaluateConfidence — null input defaults safely", () => {
  const result = evaluateConfidence(null);
  assert.equal(result.action, "clarify");
  assert.equal(result.reason, "low-confidence");
});

// ═════════════════════════════════════════════════════════════════════════════
// buildClassificationUserMessage
// ═════════════════════════════════════════════════════════════════════════════

test("buildClassificationUserMessage — includes prompt", () => {
  const msg = buildClassificationUserMessage("search my tasks");
  assert.ok(msg.includes("User message: search my tasks"));
});

test("buildClassificationUserMessage — includes skill names", () => {
  const msg = buildClassificationUserMessage("run something", {
    skillNames: ["Weekly Review", "Quick Add"]
  });
  assert.ok(msg.includes("Available skills: Weekly Review, Quick Add"));
});

test("buildClassificationUserMessage — shows 'none' when no skills", () => {
  const msg = buildClassificationUserMessage("hello", { skillNames: [] });
  assert.ok(msg.includes("Available skills: none"));
});

test("buildClassificationUserMessage — includes conversation summary when provided", () => {
  const msg = buildClassificationUserMessage("do more", {
    recentTurnsSummary: "User asked about tasks | User asked about email"
  });
  assert.ok(msg.includes("Conversation context (last 2 turns):"));
  assert.ok(msg.includes("User asked about tasks"));
});

test("buildClassificationUserMessage — no conversation block when no summary", () => {
  const msg = buildClassificationUserMessage("hello");
  assert.ok(!msg.includes("Conversation context"));
});

test("buildClassificationUserMessage — always includes tool categories", () => {
  const msg = buildClassificationUserMessage("anything");
  assert.ok(msg.includes("Tool categories: Roam graph, tasks, calendar, email, memory, web fetch, MCP integrations"));
});
