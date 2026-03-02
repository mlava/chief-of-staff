import test from "node:test";
import assert from "node:assert/strict";
import {
  initInbox,
  collectInboxBlockMap,
  getInboxProcessingTierSuffix,
  getInboxStaticUIDs,
  resetInboxStaticUIDs,
  setInboxStaticUIDs,
  clearInboxCatchupScanTimer,
  getInboxProxySignature,
  shouldRunInboxFullScanFallback,
  getInboxCandidateBlocksFromChildrenRows,
  enqueueInboxCandidates,
  enqueueInboxItems,
  runFullInboxScan,
  handleInboxPullWatchEvent,
  cleanupInbox,
  getInboxProcessingQueue,
  getInboxPendingQueueCount,
} from "../src/inbox.js";

// ── Test helpers ─────────────────────────────────────────────────────────────

function stubDeps(overrides = {}) {
  return {
    getRoamAlphaApi: () => ({
      data: {
        q: () => [],
        pull: () => null,
      },
    }),
    escapeForDatalog: (s) => String(s).replace(/"/g, '\\"'),
    debugLog: () => {},
    showInfoToast: () => {},
    invalidateMemoryPromptCache: () => {},
    askChiefOfStaff: async () => ({ text: "done" }),
    clearConversationContext: () => {},
    isUnloadInProgress: () => false,
    ...overrides,
  };
}

test.beforeEach(() => {
  cleanupInbox();
  initInbox(stubDeps());
});

// ── collectInboxBlockMap ─────────────────────────────────────────────────────

test("collectInboxBlockMap returns empty map for null input", () => {
  const m = collectInboxBlockMap(null);
  assert.equal(m.size, 0);
});

test("collectInboxBlockMap returns empty map for node without children", () => {
  const m = collectInboxBlockMap({});
  assert.equal(m.size, 0);
});

test("collectInboxBlockMap extracts uid → string from children", () => {
  const node = {
    ":block/children": [
      { ":block/uid": "abc", ":block/string": "hello" },
      { ":block/uid": "def", ":block/string": "world" },
    ],
  };
  const m = collectInboxBlockMap(node);
  assert.equal(m.size, 2);
  assert.equal(m.get("abc"), "hello");
  assert.equal(m.get("def"), "world");
});

test("collectInboxBlockMap skips children without uid", () => {
  const node = {
    ":block/children": [
      { ":block/string": "orphan" },
      { ":block/uid": "ok", ":block/string": "valid" },
    ],
  };
  const m = collectInboxBlockMap(node);
  assert.equal(m.size, 1);
  assert.equal(m.get("ok"), "valid");
});

test("collectInboxBlockMap treats missing string as empty string", () => {
  const node = {
    ":block/children": [{ ":block/uid": "x" }],
  };
  const m = collectInboxBlockMap(node);
  assert.equal(m.get("x"), "");
});

// ── getInboxProcessingTierSuffix ──────────────────────────────────────────────

test("getInboxProcessingTierSuffix returns /power for simple text", () => {
  assert.equal(getInboxProcessingTierSuffix("remind me to buy milk"), "/power");
});

test("getInboxProcessingTierSuffix returns /ludicrous for weekly review", () => {
  assert.equal(getInboxProcessingTierSuffix("Run my weekly review"), "/ludicrous");
});

test("getInboxProcessingTierSuffix returns /ludicrous for daily briefing", () => {
  assert.equal(getInboxProcessingTierSuffix("Give me a daily briefing"), "/ludicrous");
});

test("getInboxProcessingTierSuffix returns /ludicrous for deep research", () => {
  assert.equal(getInboxProcessingTierSuffix("Do deep research on AI trends"), "/ludicrous");
});

test("getInboxProcessingTierSuffix returns /ludicrous for long text (>700 chars)", () => {
  const longText = "a".repeat(701);
  assert.equal(getInboxProcessingTierSuffix(longText), "/ludicrous");
});

test("getInboxProcessingTierSuffix returns /ludicrous for many lines (>10)", () => {
  const multiLine = Array(12).fill("line").join("\n");
  assert.equal(getInboxProcessingTierSuffix(multiLine), "/ludicrous");
});

test("getInboxProcessingTierSuffix handles null/undefined gracefully", () => {
  assert.equal(getInboxProcessingTierSuffix(null), "/power");
  assert.equal(getInboxProcessingTierSuffix(undefined), "/power");
  assert.equal(getInboxProcessingTierSuffix(""), "/power");
});

test("getInboxProcessingTierSuffix detects triage keyword", () => {
  assert.equal(getInboxProcessingTierSuffix("triage my inbox"), "/ludicrous");
});

test("getInboxProcessingTierSuffix detects end-of-day keyword", () => {
  assert.equal(getInboxProcessingTierSuffix("do my end-of-day review"), "/ludicrous");
  assert.equal(getInboxProcessingTierSuffix("end of day wrap up"), "/ludicrous");
});

test("getInboxProcessingTierSuffix detects multi-step keyword", () => {
  assert.equal(getInboxProcessingTierSuffix("multi-step analysis"), "/ludicrous");
  assert.equal(getInboxProcessingTierSuffix("multi step plan"), "/ludicrous");
});

// ── getInboxStaticUIDs / resetInboxStaticUIDs / setInboxStaticUIDs ────────────

test("getInboxStaticUIDs queries Roam and caches result", () => {
  let queryCalls = 0;
  initInbox(stubDeps({
    getRoamAlphaApi: () => ({
      data: {
        q: () => { queryCalls++; return [["uid1"], ["uid2"]]; },
      },
    }),
  }));
  const uids = getInboxStaticUIDs();
  assert.equal(uids.size, 2);
  assert.ok(uids.has("uid1"));
  assert.ok(uids.has("uid2"));

  // Second call should use cache (no additional query)
  getInboxStaticUIDs();
  assert.equal(queryCalls, 1);
});

test("resetInboxStaticUIDs clears cache", () => {
  setInboxStaticUIDs(new Set(["a"]));
  assert.equal(getInboxStaticUIDs().size, 1);
  resetInboxStaticUIDs();
  // After reset, getInboxStaticUIDs queries Roam again (returning empty in stub)
  const uids = getInboxStaticUIDs();
  assert.equal(uids.size, 0);
});

test("setInboxStaticUIDs directly sets the UIDs", () => {
  setInboxStaticUIDs(new Set(["x", "y", "z"]));
  assert.equal(getInboxStaticUIDs().size, 3);
});

// ── getInboxProxySignature ────────────────────────────────────────────────────

test("getInboxProxySignature builds deterministic signature", () => {
  cleanupInbox();
  const sig = getInboxProxySignature(5);
  assert.equal(sig, "5::::");
});

// ── shouldRunInboxFullScanFallback ────────────────────────────────────────────

test("shouldRunInboxFullScanFallback returns true when no prior scan", () => {
  cleanupInbox();
  assert.ok(shouldRunInboxFullScanFallback(3));
});

test("shouldRunInboxFullScanFallback returns false during cooldown", () => {
  cleanupInbox();
  initInbox(stubDeps());
  // Run a full scan to set the timestamp
  runFullInboxScan("test");
  // Immediately check — should be within cooldown
  assert.equal(shouldRunInboxFullScanFallback(0), false);
});

test("shouldRunInboxFullScanFallback returns true for negative afterMapSize", () => {
  cleanupInbox();
  assert.ok(shouldRunInboxFullScanFallback(-1));
});

// ── getInboxCandidateBlocksFromChildrenRows ──────────────────────────────────

test("getInboxCandidateBlocksFromChildrenRows filters static UIDs", () => {
  setInboxStaticUIDs(new Set(["static1"]));
  const children = [
    { ":block/uid": "static1", ":block/string": "instruction" },
    { ":block/uid": "new1", ":block/string": "new item" },
  ];
  const result = getInboxCandidateBlocksFromChildrenRows(children);
  assert.equal(result.length, 1);
  assert.equal(result[0].uid, "new1");
});

test("getInboxCandidateBlocksFromChildrenRows skips empty blocks", () => {
  setInboxStaticUIDs(new Set());
  const children = [
    { ":block/uid": "a", ":block/string": "" },
    { ":block/uid": "b", ":block/string": "   " },
    { ":block/uid": "c", ":block/string": "valid" },
  ];
  const result = getInboxCandidateBlocksFromChildrenRows(children);
  assert.equal(result.length, 1);
  assert.equal(result[0].uid, "c");
});

test("getInboxCandidateBlocksFromChildrenRows skips blocks without uid", () => {
  setInboxStaticUIDs(new Set());
  const children = [
    { ":block/string": "no uid" },
    { ":block/uid": "ok", ":block/string": "has uid" },
  ];
  const result = getInboxCandidateBlocksFromChildrenRows(children);
  assert.equal(result.length, 1);
});

// ── enqueueInboxItems ─────────────────────────────────────────────────────────

test("enqueueInboxItems increments pending count", () => {
  cleanupInbox();
  initInbox(stubDeps({
    askChiefOfStaff: async () => new Promise(() => {}), // never resolves
  }));
  const blocks = [
    { uid: "q1", string: "task 1" },
    { uid: "q2", string: "task 2" },
  ];
  enqueueInboxItems(blocks);
  assert.equal(getInboxPendingQueueCount(), 2);
});

test("enqueueInboxItems skips duplicate UIDs", () => {
  cleanupInbox();
  initInbox(stubDeps({
    askChiefOfStaff: async () => new Promise(() => {}),
  }));
  enqueueInboxItems([{ uid: "dup", string: "first" }]);
  enqueueInboxItems([{ uid: "dup", string: "duplicate" }]);
  assert.equal(getInboxPendingQueueCount(), 1);
});

test("enqueueInboxItems skips blocks without uid", () => {
  cleanupInbox();
  initInbox(stubDeps());
  enqueueInboxItems([{ string: "no uid" }]);
  assert.equal(getInboxPendingQueueCount(), 0);
});

test("enqueueInboxItems respects INBOX_MAX_PENDING_ITEMS cap", () => {
  cleanupInbox();
  initInbox(stubDeps({
    askChiefOfStaff: async () => new Promise(() => {}),
  }));
  // Queue 50 items — should cap at 40
  const blocks = Array.from({ length: 50 }, (_, i) => ({
    uid: `cap-${i}`,
    string: `item ${i}`,
  }));
  enqueueInboxItems(blocks);
  assert.equal(getInboxPendingQueueCount(), 40);
});

// ── enqueueInboxCandidates ───────────────────────────────────────────────────

test("enqueueInboxCandidates returns count of newly enqueued items", () => {
  cleanupInbox();
  let invalidated = false;
  initInbox(stubDeps({
    invalidateMemoryPromptCache: () => { invalidated = true; },
    askChiefOfStaff: async () => new Promise(() => {}),
  }));
  const count = enqueueInboxCandidates([
    { uid: "c1", string: "candidate 1" },
    { uid: "c2", string: "candidate 2" },
  ]);
  assert.equal(count, 2);
  assert.ok(invalidated, "should invalidate memory prompt cache");
});

test("enqueueInboxCandidates returns 0 for empty array", () => {
  assert.equal(enqueueInboxCandidates([]), 0);
});

test("enqueueInboxCandidates returns 0 for null", () => {
  assert.equal(enqueueInboxCandidates(null), 0);
});

// ── runFullInboxScan ──────────────────────────────────────────────────────────

test("runFullInboxScan returns count of new blocks found", () => {
  cleanupInbox();
  setInboxStaticUIDs(new Set(["static1"]));
  initInbox(stubDeps({
    getRoamAlphaApi: () => ({
      data: {
        q: () => [["new1", "task"], ["static1", "keep"]],
      },
    }),
    askChiefOfStaff: async () => new Promise(() => {}),
  }));
  const found = runFullInboxScan("test");
  assert.equal(found, 1); // only "new1" is new
});

test("runFullInboxScan returns 0 when inbox is empty", () => {
  cleanupInbox();
  setInboxStaticUIDs(new Set());
  initInbox(stubDeps({
    getRoamAlphaApi: () => ({
      data: { q: () => [] },
    }),
  }));
  const found = runFullInboxScan("test");
  assert.equal(found, 0);
});

// ── handleInboxPullWatchEvent ─────────────────────────────────────────────────

test("handleInboxPullWatchEvent debounces with 5s timeout", () => {
  const timers = {};
  handleInboxPullWatchEvent(null, null, timers);
  assert.ok(timers["inbox"] !== undefined, "should set debounce timer");
});

test("handleInboxPullWatchEvent clears previous debounce timer", () => {
  const timers = {};
  handleInboxPullWatchEvent(null, null, timers);
  const first = timers["inbox"];
  handleInboxPullWatchEvent(null, null, timers);
  const second = timers["inbox"];
  assert.notEqual(first, second, "timer should be replaced");
});

// ── cleanupInbox ──────────────────────────────────────────────────────────────

test("cleanupInbox resets all state", () => {
  cleanupInbox();
  initInbox(stubDeps({
    askChiefOfStaff: async () => new Promise(() => {}),
  }));
  enqueueInboxItems([{ uid: "cleanup1", string: "test" }]);
  assert.equal(getInboxPendingQueueCount(), 1);

  cleanupInbox();
  assert.equal(getInboxPendingQueueCount(), 0);
  assert.equal(getInboxStaticUIDs().size, 0); // queries empty stub
});

test("cleanupInbox resolves processing queue", async () => {
  cleanupInbox();
  const queue = getInboxProcessingQueue();
  // Should be a resolved promise after cleanup
  await queue; // should not hang
});

// ── getInboxProcessingQueue / getInboxPendingQueueCount ──────────────────────

test("getInboxProcessingQueue returns a promise", () => {
  assert.ok(getInboxProcessingQueue() instanceof Promise);
});

test("getInboxPendingQueueCount returns 0 after cleanup", () => {
  cleanupInbox();
  assert.equal(getInboxPendingQueueCount(), 0);
});
