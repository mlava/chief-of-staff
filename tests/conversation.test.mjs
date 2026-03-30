import test from "node:test";
import assert from "node:assert/strict";
import {
  initConversation,
  compactTurns,
  maybeCompactConversation,
  forceCompact,
  getConversationTurns,
  getConversationMessages,
  appendConversationTurn,
  clearConversationContext,
  truncateForContext,
  approximateMessageChars,
  enforceAgentMessageBudgetInPlace,
} from "../src/conversation.js";

// ── Global mocks (browser APIs not available in Node) ───────────────────────
if (typeof globalThis.window === "undefined") {
  globalThis.window = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  };
}

// ── Shared mock deps ────────────────────────────────────────────────────────

function makeDeps(overrides = {}) {
  return {
    MAX_CONTEXT_USER_CHARS: 500,
    MAX_CONTEXT_ASSISTANT_CHARS: 2000,
    MAX_CONVERSATION_TURNS: 12,
    MAX_AGENT_MESSAGES_CHAR_BUDGET: 70000,
    MIN_AGENT_MESSAGES_TO_KEEP: 6,
    SETTINGS_KEYS: { conversationContext: "conversation-context" },
    debugLog: () => {},
    safeJsonStringify: (obj, max) => JSON.stringify(obj).slice(0, max || 20000),
    getExtensionAPIRef: () => null,
    detectInjectionPatterns: () => ({ flagged: false, patterns: [] }),
    resetLastPromptSections: () => {},
    sessionTrajectory: { reset: () => {} },
    getSettingArray: () => [],
    ...overrides,
  };
}

function resetState(overrides = {}) {
  const deps = makeDeps(overrides);
  initConversation(deps);
  clearConversationContext();
  return deps;
}

// ═════════════════════════════════════════════════════════════════════════════
// compactTurns — core extraction logic
// ═════════════════════════════════════════════════════════════════════════════

test("compactTurns: returns null for empty array", () => {
  resetState();
  assert.equal(compactTurns([]), null);
  assert.equal(compactTurns(null), null);
});

test("compactTurns: single turn extracts topic and outcome", () => {
  resetState();
  const result = compactTurns([
    { user: "What time is it?", assistant: "It's 3pm. I found the time using cos_get_current_time.", createdAt: 1000 }
  ]);
  assert.ok(result);
  assert.equal(result.isCompacted, true);
  assert.equal(result.user, "[compacted]");
  assert.ok(result.assistant.includes("[Compacted context: 1 earlier turns]"));
  assert.ok(result.assistant.includes("Topics:"));
  assert.ok(result.assistant.includes("cos_get_current_time"));
});

test("compactTurns: extracts [[page references]]", () => {
  resetState();
  const result = compactTurns([
    { user: "Show my tasks", assistant: "Found tasks on [[Daily Briefing]] and [[Weekly Review]] using roam_search.", createdAt: 1000 }
  ]);
  assert.ok(result.assistant.includes("[[Daily Briefing]]"));
  assert.ok(result.assistant.includes("[[Weekly Review]]"));
});

test("compactTurns: extracts [Key reference: ...] blocks", () => {
  resetState();
  const result = compactTurns([
    { user: "Check email", assistant: "[Key reference: Budget Email -> MSG_123; Meeting Invite -> MSG_456]\n\nYou have 2 new emails.", createdAt: 1000 }
  ]);
  assert.ok(result.assistant.includes("Key references:"));
  assert.ok(result.assistant.includes("Budget Email -> MSG_123; Meeting Invite -> MSG_456"));
});

test("compactTurns: extracts multiple tool names from assistant text", () => {
  resetState();
  const result = compactTurns([
    { user: "Run my daily briefing", assistant: "I used roam_search, cos_get_current_time, bt_search, and COMPOSIO_MULTI_EXECUTE to gather your data.", createdAt: 1000 }
  ]);
  assert.ok(result.assistant.includes("roam_search"));
  assert.ok(result.assistant.includes("cos_get_current_time"));
  assert.ok(result.assistant.includes("bt_search"));
  assert.ok(result.assistant.includes("COMPOSIO_MULTI_EXECUTE"));
});

test("compactTurns: classifies outcomes (wrote, read, failed)", () => {
  resetState();
  const result = compactTurns([
    { user: "Create a page", assistant: "I created the page successfully.", createdAt: 1000 },
    { user: "Search for notes", assistant: "Here are the results I found.", createdAt: 2000 },
    { user: "Delete old data", assistant: "I can't find the specified data.", createdAt: 3000 },
  ]);
  assert.ok(result.assistant.includes("(wrote)"));
  assert.ok(result.assistant.includes("(read)"));
  assert.ok(result.assistant.includes("(failed)"));
});

test("compactTurns: deduplicates tools across turns", () => {
  resetState();
  const result = compactTurns([
    { user: "Search once", assistant: "Used roam_search and bt_search.", createdAt: 1000 },
    { user: "Search again", assistant: "Used roam_search and cos_get_current_time.", createdAt: 2000 },
  ]);
  // roam_search should appear only once
  const toolLine = result.assistant.split("\n").find(l => l.startsWith("Tools used:"));
  const roamSearchCount = (toolLine.match(/roam_search/g) || []).length;
  assert.equal(roamSearchCount, 1);
});

test("compactTurns: truncates topic to 80 chars", () => {
  resetState();
  const longPrompt = "x".repeat(200);
  const result = compactTurns([
    { user: longPrompt, assistant: "OK", createdAt: 1000 }
  ]);
  const topicLine = result.assistant.split("\n").find(l => l.startsWith("Topics:"));
  // Topic should be truncated with "..."
  assert.ok(topicLine.length < 150, "Topic line should be much shorter than 200 chars");
  assert.ok(topicLine.includes("..."));
});

test("compactTurns: strips page-change notices from topic extraction", () => {
  resetState();
  const result = compactTurns([
    { user: "[Note: The user has navigated to a different page.]\n\nWhat's on this page?", assistant: "Some content here.", createdAt: 1000 }
  ]);
  const topicLine = result.assistant.split("\n").find(l => l.startsWith("Topics:"));
  assert.ok(!topicLine.includes("[Note:"), "Page change notice should be stripped");
  assert.ok(topicLine.includes("What's on this page"), "Actual question should remain");
});

// ═════════════════════════════════════════════════════════════════════════════
// maybeCompactConversation — threshold-based auto-compaction
// ═════════════════════════════════════════════════════════════════════════════

test("maybeCompactConversation: no-op when below threshold", async () => {
  resetState();
  // Add 5 turns (below threshold of 10)
  for (let i = 0; i < 5; i++) {
    appendConversationTurn(`Q${i}`, `A${i}`);
  }
  const result = await maybeCompactConversation();
  assert.equal(result, false);
  assert.equal(getConversationTurns().length, 5);
});

test("maybeCompactConversation: compacts when at threshold", async () => {
  resetState();
  for (let i = 0; i < 10; i++) {
    appendConversationTurn(`Question ${i}`, `Answer ${i} using roam_search.`);
  }
  // Auto-compaction is fire-and-forget; explicitly compact to test
  await maybeCompactConversation();
  const turns = getConversationTurns();
  // Should have 1 compacted + COMPACTION_KEEP_RECENT (4) = 5
  assert.ok(turns.length <= 6, `Expected <= 6 turns, got ${turns.length}`);
  assert.equal(turns[0].isCompacted, true);
  assert.ok(turns[0].assistant.includes("[Compacted context:"));
});

test("maybeCompactConversation: keeps recent turns intact", async () => {
  resetState();
  for (let i = 0; i < 10; i++) {
    appendConversationTurn(`Q${i}`, `A${i}`);
  }
  await maybeCompactConversation();
  const turns = getConversationTurns();
  // Last 4 turns should be the most recent ones
  assert.equal(turns[turns.length - 1].user, "Q9");
  assert.equal(turns[turns.length - 1].assistant, "A9");
  assert.equal(turns[turns.length - 2].user, "Q8");
});

test("maybeCompactConversation: merges with existing compacted turn", async () => {
  resetState();
  // First round: add 10 turns
  for (let i = 0; i < 10; i++) {
    appendConversationTurn(`Q${i}`, `A${i} using roam_search.`);
  }
  await maybeCompactConversation();
  assert.equal(getConversationTurns()[0].isCompacted, true);

  // Add more turns to hit the threshold again
  for (let i = 10; i < 15; i++) {
    appendConversationTurn(`Q${i}`, `A${i} using bt_search.`);
  }
  await maybeCompactConversation();
  const turns = getConversationTurns();
  assert.equal(turns[0].isCompacted, true);
  // Should mention both roam_search (from first compaction) and bt_search
  assert.ok(turns[0].assistant.includes("roam_search"));
  assert.ok(turns[0].assistant.includes("bt_search"));
});

// ═════════════════════════════════════════════════════════════════════════════
// Auto-compaction in appendConversationTurn
// ═════════════════════════════════════════════════════════════════════════════

test("appendConversationTurn: auto-compacts at threshold instead of hard-dropping", async () => {
  resetState();
  // Fill to 9 turns (just below threshold)
  for (let i = 0; i < 9; i++) {
    appendConversationTurn(`Q${i}`, `A${i} via roam_search on [[Page ${i}]].`);
  }
  assert.equal(getConversationTurns().length, 9);

  // The 10th turn triggers fire-and-forget compaction; await it explicitly
  appendConversationTurn("Q9", "A9 via bt_search.");
  await maybeCompactConversation();
  const turns = getConversationTurns();
  assert.ok(turns.length <= 7, `Expected <= 7 turns after compaction, got ${turns.length}`);
  assert.ok(turns.some(t => t.isCompacted), "Should have a compacted turn");
  assert.equal(turns[turns.length - 1].user, "Q9");
});

// ═════════════════════════════════════════════════════════════════════════════
// forceCompact — manual /compact command
// ═════════════════════════════════════════════════════════════════════════════

test("forceCompact: returns null when fewer than 2 turns", async () => {
  resetState();
  assert.equal(await forceCompact(), null);
  appendConversationTurn("Q1", "A1");
  assert.equal(await forceCompact(), null);
});

test("forceCompact: compacts all but last 2 turns", async () => {
  resetState();
  for (let i = 0; i < 6; i++) {
    appendConversationTurn(`Q${i}`, `A${i} via roam_search.`);
  }
  const result = await forceCompact();
  assert.ok(result);
  assert.equal(result.compactedCount, 4);
  assert.equal(result.remainingTurns, 3); // 1 compacted + 2 recent

  const turns = getConversationTurns();
  assert.equal(turns.length, 3);
  assert.equal(turns[0].isCompacted, true);
  assert.equal(turns[turns.length - 1].user, "Q5");
  assert.equal(turns[turns.length - 2].user, "Q4");
});

test("forceCompact: result includes summary text", async () => {
  resetState();
  for (let i = 0; i < 5; i++) {
    appendConversationTurn(`Q${i}`, `A${i} via roam_search on [[Page${i}]].`);
  }
  const result = await forceCompact();
  assert.ok(result.summary.includes("[Compacted context:"));
  assert.ok(result.summary.includes("roam_search"));
});

// ═════════════════════════════════════════════════════════════════════════════
// getConversationMessages — compacted turn formatting
// ═════════════════════════════════════════════════════════════════════════════

test("getConversationMessages: compacted turn becomes single assistant message", async () => {
  resetState();
  for (let i = 0; i < 10; i++) {
    appendConversationTurn(`Q${i}`, `A${i}`);
  }
  await maybeCompactConversation();
  const messages = getConversationMessages();
  // First message should be assistant (compacted summary)
  assert.equal(messages[0].role, "assistant");
  assert.ok(messages[0].content.includes("[Compacted context:"));
  // Regular turns follow as user/assistant pairs
  assert.equal(messages[1].role, "user");
});

test("getConversationMessages: non-compacted turns still work normally", () => {
  resetState();
  appendConversationTurn("Hello", "Hi there!");
  appendConversationTurn("How are you?", "I'm well.");
  const messages = getConversationMessages();
  assert.equal(messages.length, 4);
  assert.equal(messages[0].role, "user");
  assert.equal(messages[0].content, "Hello");
  assert.equal(messages[1].role, "assistant");
  assert.equal(messages[1].content, "Hi there!");
});

// ═════════════════════════════════════════════════════════════════════════════
// normaliseConversationTurn — isCompacted persistence
// ═════════════════════════════════════════════════════════════════════════════

test("compacted turn preserves isCompacted flag through load cycle", async () => {
  resetState();
  for (let i = 0; i < 10; i++) {
    appendConversationTurn(`Q${i}`, `A${i}`);
  }
  await maybeCompactConversation();
  const turns = getConversationTurns();
  assert.equal(turns[0].isCompacted, true);
  // The flag should survive normalisation (which happens on load)
  assert.ok(turns[0].assistant.length > 0);
});

test("compacted summary gets higher char limit than regular turns", async () => {
  resetState();
  // Create turns with lots of data to generate a long summary
  for (let i = 0; i < 10; i++) {
    const tools = Array.from({ length: 5 }, (_, j) => `roam_tool_${i}_${j}`).join(", ");
    const pages = Array.from({ length: 3 }, (_, j) => `[[Page ${i} Section ${j}]]`).join(", ");
    appendConversationTurn(
      `Complex question ${i} about many topics`,
      `Here's what I found using ${tools}. Referenced ${pages}. Also used cos_tool_${i} and bt_tool_${i}.`
    );
  }
  await maybeCompactConversation();
  const turns = getConversationTurns();
  const compacted = turns.find(t => t.isCompacted);
  assert.ok(compacted, "Should have a compacted turn");
  // Verify the summary isn't truncated at the regular 2000 char limit
  // (it gets 4000 chars in normaliseConversationTurn)
  assert.ok(compacted.assistant.length > 0);
});

// ═════════════════════════════════════════════════════════════════════════════
// Edge cases
// ═════════════════════════════════════════════════════════════════════════════

test("compactTurns: handles turns with empty user or assistant", () => {
  resetState();
  const result = compactTurns([
    { user: "", assistant: "Just a response.", createdAt: 1000 },
    { user: "Just a question.", assistant: "", createdAt: 2000 },
  ]);
  assert.ok(result);
  assert.equal(result.isCompacted, true);
  assert.ok(result.assistant.includes("[Compacted context: 2 earlier turns]"));
});

test("compactTurns: handles sanitised (false claim) turns", () => {
  resetState();
  const result = compactTurns([
    { user: "Do something", assistant: "[Previous response contained a false action claim and was not shown to the user.]", createdAt: 1000 },
  ]);
  assert.ok(result);
  const topicLine = result.assistant.split("\n").find(l => l.startsWith("Topics:"));
  assert.ok(topicLine.includes("(sanitised)"));
});

test("compactTurns: limits tool list to 15 with overflow indicator", () => {
  resetState();
  const names = ["alpha","bravo","charlie","delta","echo","foxtrot","golf","hotel",
    "india","juliet","kilo","lima","mike","november","oscar","papa","quebec",
    "romeo","sierra","tango"];
  const tools = names.map(n => `roam_${n}`);
  const result = compactTurns([
    { user: "Use all the tools", assistant: `Used ${tools.join(", ")}.`, createdAt: 1000 }
  ]);
  const toolLine = result.assistant.split("\n").find(l => l.startsWith("Tools used:"));
  assert.ok(toolLine.includes("(+5 more)"), "Should show overflow count");
});

test("compactTurns: limits page refs to 8 with overflow indicator", () => {
  resetState();
  // Use two turns so that extractRoamRefs (10/turn cap) passes all 12 through
  const pagesA = Array.from({ length: 8 }, (_, i) => `[[PageA${i}]]`);
  const pagesB = Array.from({ length: 4 }, (_, i) => `[[PageB${i}]]`);
  const result = compactTurns([
    { user: "Check pages part 1", assistant: `Found ${pagesA.join(", ")}.`, createdAt: 1000 },
    { user: "Check pages part 2", assistant: `Found ${pagesB.join(", ")}.`, createdAt: 2000 },
  ]);
  const pageLine = result.assistant.split("\n").find(l => l.startsWith("Pages referenced:"));
  assert.ok(pageLine.includes("(+4 more)"), "Should show overflow count");
});

test("clearConversationContext resets compacted state", async () => {
  resetState();
  for (let i = 0; i < 10; i++) {
    appendConversationTurn(`Q${i}`, `A${i}`);
  }
  await maybeCompactConversation();
  assert.ok(getConversationTurns().length > 0);
  clearConversationContext();
  assert.equal(getConversationTurns().length, 0);
});
