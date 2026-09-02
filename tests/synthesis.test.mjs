import test from "node:test";
import assert from "node:assert/strict";
import {
  initSynthesis,
  parseRoamDateTitle,
  normaliseText,
  jaccard,
  parseCorrectionEntries,
  clusterCorrections,
  buildProposals,
  filterNewProposals,
  isPinned,
  flagStaleEntries,
  buildReportBlocks,
  initialSynthesisState,
  runSynthesisChunk,
  getSynthesisResult,
  __resetSynthesisForTests,
  SYNTHESIS_INTERVAL_MS,
  SYNTHESIS_CLUSTER_THRESHOLD,
  MEMORY_STALE_DAYS,
} from "../src/synthesis.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// Tracks the real clock deliberately. The unit tests below pass `{ nowMs: NOW }`
// explicitly, but the two full-run tests drive runSynthesisChunk, which has no
// nowMs seam and calls Date.now() internally. Pinning NOW to a literal date made
// those fixtures age against the real clock and fail permanently once it drifted
// past SYNTHESIS_WINDOW_DAYS (30) from the pin — which is what happened.
const NOW = Date.now();

function daysAgoTitle(days) {
  // Produce a Roam-style title for NOW - days (ordinal suffix included)
  const d = new Date(NOW - days * DAY_MS);
  const day = d.getDate();
  const suffix = day % 10 === 1 && day !== 11 ? "st" : day % 10 === 2 && day !== 12 ? "nd" : day % 10 === 3 && day !== 13 ? "rd" : "th";
  const month = d.toLocaleString("en-US", { month: "long" });
  return `${month} ${day}${suffix}, ${d.getFullYear()}`;
}

// ═════════════════════════════════════════════════════════════════════════════
// parseRoamDateTitle
// ═════════════════════════════════════════════════════════════════════════════

test("parseRoamDateTitle parses ordinal daily-note titles", () => {
  const ms = parseRoamDateTitle("March 30th, 2026");
  assert.equal(new Date(ms).getMonth(), 2);
  assert.equal(new Date(ms).getDate(), 30);
  assert.equal(new Date(ms).getFullYear(), 2026);
});

test("parseRoamDateTitle handles st/nd/rd suffixes", () => {
  assert.ok(parseRoamDateTitle("July 1st, 2026"));
  assert.ok(parseRoamDateTitle("July 2nd, 2026"));
  assert.ok(parseRoamDateTitle("July 3rd, 2026"));
});

test("parseRoamDateTitle returns null for garbage", () => {
  assert.equal(parseRoamDateTitle("not a date"), null);
  assert.equal(parseRoamDateTitle(""), null);
  assert.equal(parseRoamDateTitle(null), null);
});

// ═════════════════════════════════════════════════════════════════════════════
// normaliseText / jaccard
// ═════════════════════════════════════════════════════════════════════════════

test("normaliseText lowercases, strips punctuation and sanitised ref chars", () => {
  assert.equal(normaliseText('Fix the ⟦Daily Briefing⟧ header!'), "fix the daily briefing header");
  assert.equal(normaliseText("  Multiple   spaces\tand,commas. "), "multiple spaces and commas");
});

test("jaccard computes token overlap", () => {
  const a = new Set(["a", "b", "c"]);
  const b = new Set(["b", "c", "d"]);
  assert.equal(jaccard(a, b), 0.5);
  assert.equal(jaccard(new Set(), new Set()), 0);
  assert.equal(jaccard(a, a), 1);
});

// ═════════════════════════════════════════════════════════════════════════════
// parseCorrectionEntries
// ═════════════════════════════════════════════════════════════════════════════

test("parseCorrectionEntries parses diff-scan headers with children", () => {
  const tree = [{
    text: '[[June 12th, 2026]] **skill:Daily Briefing** — 2 edits, 1 deletion',
    uid: "hdr1",
    children: [
      { text: 'edited ((abc123def)): "old text" → "new text"', uid: "c1" },
      { text: 'deleted ((xyz789ghi)): "gone text"', uid: "c2" },
    ]
  }];
  const { records, skippedCount } = parseCorrectionEntries(tree);
  assert.equal(records.length, 2);
  assert.equal(skippedCount, 0);
  assert.equal(records[0].kind, "diff");
  assert.equal(records[0].type, "edited");
  assert.equal(records[0].source, "skill:Daily Briefing");
  assert.equal(records[0].uid, "abc123def");
  assert.equal(records[0].original, "old text");
  assert.equal(records[0].current, "new text");
  assert.equal(records[1].type, "deleted");
  assert.equal(records[1].current, "");
  assert.ok(records[0].dateMs > 0);
});

test("parseCorrectionEntries parses intent feedback lines", () => {
  const tree = [{
    text: '[[July 1st, 2026]] **intent-overridden**: "add milk to list" — classified as: "create task" → user said: "add to groceries page"',
    uid: "i1",
    children: []
  }];
  const { records } = parseCorrectionEntries(tree);
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, "intent");
  assert.equal(records[0].type, "overridden");
  assert.equal(records[0].prompt, "add milk to list");
  assert.equal(records[0].classifiedIntent, "create task");
  assert.equal(records[0].userOverride, "add to groceries page");
  assert.equal(records[0].uid, "i1");
});

test("parseCorrectionEntries parses intent line without override or classification", () => {
  const tree = [{ text: '[[July 1st, 2026]] **intent-dismissed**: "some prompt"', uid: "i2", children: [] }];
  const { records } = parseCorrectionEntries(tree);
  assert.equal(records.length, 1);
  assert.equal(records[0].classifiedIntent, "");
  assert.equal(records[0].userOverride, "");
});

test("parseCorrectionEntries ignores description blocks silently, counts other junk", () => {
  const tree = [
    { text: "ℹ️ User feedback — blocks you edited…", uid: "d1", children: [] },
    { text: "random note someone typed here", uid: "j1", children: [] },
  ];
  const { records, skippedCount } = parseCorrectionEntries(tree);
  assert.equal(records.length, 0);
  assert.equal(skippedCount, 1);
});

test("parseCorrectionEntries counts unparseable diff children", () => {
  const tree = [{
    text: '[[June 12th, 2026]] **chat-pin** — 1 edit',
    uid: "h",
    children: [{ text: "not a valid child line", uid: "c" }]
  }];
  const { records, skippedCount } = parseCorrectionEntries(tree);
  assert.equal(records.length, 0);
  assert.equal(skippedCount, 1);
});

test("parseCorrectionEntries handles empty input", () => {
  assert.deepEqual(parseCorrectionEntries([]), { records: [], skippedCount: 0 });
  assert.deepEqual(parseCorrectionEntries(null), { records: [], skippedCount: 0 });
});

// ═════════════════════════════════════════════════════════════════════════════
// clusterCorrections
// ═════════════════════════════════════════════════════════════════════════════

function intentRecord(overrides = {}) {
  return {
    kind: "intent", type: "dismissed", dateTitle: daysAgoTitle(5),
    dateMs: NOW - 5 * DAY_MS, uid: "u1", prompt: "add milk",
    classifiedIntent: "create task", userOverride: "", ...overrides
  };
}

function diffRecord(overrides = {}) {
  return {
    kind: "diff", type: "edited", source: "skill:Daily Briefing",
    dateTitle: daysAgoTitle(5), dateMs: NOW - 5 * DAY_MS, uid: "u1",
    original: "weather section shows celsius temperatures", current: "x", ...overrides
  };
}

test("clusterCorrections qualifies at threshold, not below", () => {
  const two = [intentRecord({ uid: "a" }), intentRecord({ uid: "b" })];
  assert.equal(clusterCorrections(two, { nowMs: NOW }).length, 0);

  const three = [...two, intentRecord({ uid: "c" })];
  const clusters = clusterCorrections(three, { nowMs: NOW });
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].count, 3);
  assert.equal(clusters[0].kind, "intent");
});

test("clusterCorrections excludes records outside the window", () => {
  const records = [
    intentRecord({ uid: "a" }),
    intentRecord({ uid: "b" }),
    intentRecord({ uid: "c", dateMs: NOW - 45 * DAY_MS }),
  ];
  assert.equal(clusterCorrections(records, { nowMs: NOW, windowDays: 30 }).length, 0);
});

test("clusterCorrections keeps null-date records in-window", () => {
  const records = [
    intentRecord({ uid: "a" }),
    intentRecord({ uid: "b" }),
    intentRecord({ uid: "c", dateMs: null }),
  ];
  assert.equal(clusterCorrections(records, { nowMs: NOW }).length, 1);
});

test("clusterCorrections separates intent types into distinct clusters", () => {
  const records = [
    intentRecord({ uid: "a" }), intentRecord({ uid: "b" }), intentRecord({ uid: "c" }),
    intentRecord({ uid: "d", type: "overridden" }),
    intentRecord({ uid: "e", type: "overridden" }),
    intentRecord({ uid: "f", type: "overridden" }),
  ];
  const clusters = clusterCorrections(records, { nowMs: NOW });
  assert.equal(clusters.length, 2);
  assert.notEqual(clusters[0].key, clusters[1].key);
});

test("clusterCorrections picks shortest prompt as sample and first non-empty override", () => {
  const records = [
    intentRecord({ uid: "a", prompt: "a much longer prompt about milk" }),
    intentRecord({ uid: "b", prompt: "add milk" }),
    intentRecord({ uid: "c", prompt: "medium prompt milk", userOverride: "use groceries" }),
  ];
  const [cluster] = clusterCorrections(records, { nowMs: NOW });
  assert.equal(cluster.samplePrompt, "add milk");
  assert.equal(cluster.userOverride, "use groceries");
});

test("clusterCorrections marks cohesive diff clusters and extracts shared tokens", () => {
  const records = [
    diffRecord({ uid: "a", original: "weather section shows celsius temperatures today" }),
    diffRecord({ uid: "b", original: "weather section shows celsius temps" }),
    diffRecord({ uid: "c", original: "the weather section shows celsius again" }),
  ];
  const [cluster] = clusterCorrections(records, { nowMs: NOW });
  assert.equal(cluster.cohesive, true);
  assert.ok(cluster.sharedTokens.includes("weather"));
  assert.ok(cluster.sharedTokens.includes("celsius"));
});

test("clusterCorrections marks unrelated diff edits non-cohesive but still qualifying", () => {
  const records = [
    diffRecord({ uid: "a", original: "completely different text one" }),
    diffRecord({ uid: "b", original: "another unrelated sentence here" }),
    diffRecord({ uid: "c", original: "third thing nobody expects" }),
  ];
  const [cluster] = clusterCorrections(records, { nowMs: NOW });
  assert.equal(cluster.cohesive, false);
  assert.equal(cluster.count, 3);
});

test("clusterCorrections handles empty input", () => {
  assert.deepEqual(clusterCorrections([], { nowMs: NOW }), []);
  assert.deepEqual(clusterCorrections(null, { nowMs: NOW }), []);
});

// ═════════════════════════════════════════════════════════════════════════════
// buildProposals
// ═════════════════════════════════════════════════════════════════════════════

test("buildProposals drafts intent template with override", () => {
  const records = [
    intentRecord({ uid: "a" }), intentRecord({ uid: "b" }),
    intentRecord({ uid: "c", userOverride: "add to groceries" }),
  ];
  const [p] = buildProposals(clusterCorrections(records, { nowMs: NOW }));
  assert.match(p.text, /do not treat it as "create task"/);
  assert.match(p.text, /Prefer: "add to groceries"/);
  assert.equal(p.evidenceUids.length, 3);
});

test("buildProposals drafts cohesive diff template with token hint", () => {
  const records = [
    diffRecord({ uid: "a", original: "weather celsius line" }),
    diffRecord({ uid: "b", original: "weather celsius block" }),
    diffRecord({ uid: "c", original: "weather celsius entry" }),
  ];
  const [p] = buildProposals(clusterCorrections(records, { nowMs: NOW }));
  assert.match(p.text, /^Proposed memory: skill:Daily Briefing outputs are corrected repeatedly \(3×/);
  assert.match(p.text, /weather/);
});

test("buildProposals is honest about non-cohesive clusters", () => {
  const records = [
    diffRecord({ uid: "a", original: "alpha one" }),
    diffRecord({ uid: "b", original: "beta two" }),
    diffRecord({ uid: "c", original: "gamma three" }),
  ];
  const [p] = buildProposals(clusterCorrections(records, { nowMs: NOW }));
  assert.match(p.text, /^Pattern only \(no draft\)/);
});

test("buildProposals caps evidence refs at 5", () => {
  const records = Array.from({ length: 8 }, (_, i) => intentRecord({ uid: `u${i}` }));
  const [p] = buildProposals(clusterCorrections(records, { nowMs: NOW }));
  assert.equal(p.evidenceUids.length, 5);
});

// ═════════════════════════════════════════════════════════════════════════════
// filterNewProposals
// ═════════════════════════════════════════════════════════════════════════════

test("filterNewProposals passes unseen proposals and records fingerprints", () => {
  const proposals = [{ key: "intent:dismissed:create task", count: 3, text: "x", evidenceUids: [] }];
  const { fresh, store } = filterNewProposals(proposals, [], NOW);
  assert.equal(fresh.length, 1);
  assert.equal(store.length, 1);
  assert.equal(store[0].key, "intent:dismissed:create task");
  assert.equal(store[0].count, 3);
});

test("filterNewProposals suppresses unchanged clusters", () => {
  const proposals = [{ key: "k1", count: 3, text: "x", evidenceUids: [] }];
  const stored = [{ key: "k1", count: 3, at: NOW - DAY_MS }];
  const { fresh, store } = filterNewProposals(proposals, stored, NOW);
  assert.equal(fresh.length, 0);
  assert.equal(store.length, 1);
});

test("filterNewProposals re-proposes grown clusters with grewFrom", () => {
  const proposals = [{ key: "k1", count: 5, text: "x", evidenceUids: [] }];
  const stored = [{ key: "k1", count: 3, at: NOW - DAY_MS }];
  const { fresh, store } = filterNewProposals(proposals, stored, NOW);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].grewFrom, 3);
  assert.equal(store[0].count, 5);
});

test("filterNewProposals expires fingerprints after 90 days", () => {
  const proposals = [{ key: "k1", count: 3, text: "x", evidenceUids: [] }];
  const stored = [{ key: "k1", count: 3, at: NOW - 91 * DAY_MS }];
  const { fresh } = filterNewProposals(proposals, stored, NOW);
  assert.equal(fresh.length, 1); // expired entry no longer suppresses
});

test("filterNewProposals caps the store at 50 newest", () => {
  const stored = Array.from({ length: 60 }, (_, i) => ({ key: `old${i}`, count: 3, at: NOW - i * 1000 }));
  const proposals = [{ key: "new", count: 3, text: "x", evidenceUids: [] }];
  const { store } = filterNewProposals(proposals, stored, NOW);
  assert.equal(store.length, 50);
  assert.ok(store.some(e => e.key === "new"));
});

test("filterNewProposals tolerates malformed stored data", () => {
  const proposals = [{ key: "k1", count: 3, text: "x", evidenceUids: [] }];
  const { fresh } = filterNewProposals(proposals, [null, {}, { key: "x" }, "junk"], NOW);
  assert.equal(fresh.length, 1);
});

// ═════════════════════════════════════════════════════════════════════════════
// isPinned / flagStaleEntries
// ═════════════════════════════════════════════════════════════════════════════

test("isPinned detects both pin syntaxes", () => {
  assert.equal(isPinned("Important fact #pinned"), true);
  assert.equal(isPinned("Important fact #[[COS Pinned]]"), true);
  assert.equal(isPinned("mentions pinnedness casually"), false);
  assert.equal(isPinned(""), false);
});

test("flagStaleEntries flags entries past the threshold", () => {
  const entries = [
    { uid: "a", text: "old fact", editTime: NOW - 200 * DAY_MS, pageTitle: "Chief of Staff/Memory" },
    { uid: "b", text: "fresh fact", editTime: NOW - 10 * DAY_MS, pageTitle: "Chief of Staff/Memory" },
  ];
  const flagged = flagStaleEntries(entries, { nowMs: NOW });
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].uid, "a");
  assert.equal(flagged[0].ageDays, 200);
});

test("flagStaleEntries boundary: exactly at threshold is not stale", () => {
  const entries = [{ uid: "a", text: "fact", editTime: NOW - MEMORY_STALE_DAYS * DAY_MS, pageTitle: "P" }];
  assert.equal(flagStaleEntries(entries, { nowMs: NOW }).length, 0);
});

test("flagStaleEntries skips pinned, description, and empty entries", () => {
  const old = NOW - 300 * DAY_MS;
  const entries = [
    { uid: "a", text: "keep me #pinned", editTime: old, pageTitle: "P" },
    { uid: "b", text: "ℹ️ description block", editTime: old, pageTitle: "P" },
    { uid: "c", text: "", editTime: old, pageTitle: "P" },
    { uid: "d", text: "genuinely stale", editTime: old, pageTitle: "P" },
  ];
  const flagged = flagStaleEntries(entries, { nowMs: NOW });
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].uid, "d");
});

test("flagStaleEntries skips entries with no edit time", () => {
  const entries = [{ uid: "a", text: "no timestamp", editTime: undefined, pageTitle: "P" }];
  assert.equal(flagStaleEntries(entries, { nowMs: NOW }).length, 0);
});

// ═════════════════════════════════════════════════════════════════════════════
// buildReportBlocks
// ═════════════════════════════════════════════════════════════════════════════

test("buildReportBlocks composes header counts and proposal blocks with evidence", () => {
  const report = buildReportBlocks({
    proposals: [{ key: "k", count: 3, kind: "intent", text: "Proposed memory: x", evidenceUids: ["u1", "u2"] }],
    staleMemory: [{ pageTitle: "Chief of Staff/Memory", uid: "m1", textPreview: "old", ageDays: 200 }],
    oldCorrectionsCount: 4,
    scannedCount: 12,
    skippedCount: 1,
    dateRef: "[[July 8th, 2026]]"
  });
  assert.match(report.header, /1 proposal, 1 stale memory candidate/);
  assert.match(report.header, /12 corrections scanned, 1 skipped/);
  assert.equal(report.children.length, 3);
  assert.match(report.children[0].text, /\*\*Proposal 1\*\*/);
  assert.equal(report.children[0].children[0].text, "evidence: ((u1)) ((u2))");
  assert.match(report.children[1].text, /Stale memory candidates/);
  assert.match(report.children[1].children[0].text, /\(\(m1\)\)/);
  assert.match(report.children[2].text, /older than 90 days: 4/);
});

test("buildReportBlocks includes grewFrom note", () => {
  const report = buildReportBlocks({
    proposals: [{ key: "k", count: 5, grewFrom: 3, kind: "intent", text: "x", evidenceUids: [] }],
    staleMemory: [], oldCorrectionsCount: 0, scannedCount: 5, skippedCount: 0,
    dateRef: "[[July 8th, 2026]]"
  });
  assert.match(report.children[0].text, /grew from 3 to 5/);
});

test("buildReportBlocks sanitises page refs in proposal text", () => {
  const report = buildReportBlocks({
    proposals: [{ key: "k", count: 3, kind: "diff", text: "mentions [[Some Page]] here", evidenceUids: [] }],
    staleMemory: [], oldCorrectionsCount: 0, scannedCount: 3, skippedCount: 0,
    dateRef: "[[July 8th, 2026]]"
  });
  assert.ok(!report.children[0].text.includes("[[Some Page]]"));
  assert.ok(report.children[0].text.includes("⟦Some Page⟧"));
});

// ═════════════════════════════════════════════════════════════════════════════
// runSynthesisChunk — gate behaviour (mocked deps)
// ═════════════════════════════════════════════════════════════════════════════

function makeMockSettings(initial = {}) {
  const store = { ...initial };
  return {
    get: (k) => store[k],
    set: (k, v) => { store[k] = v; },
    _store: store,
  };
}

const FOREVER = { timeRemaining: () => 5000 };

test("gate: first run seeds lastRunAt and defers", () => {
  __resetSynthesisForTests();
  const settings = makeMockSettings();
  initSynthesis({
    getExtensionAPIRef: () => ({ settings }),
    getRoamAlphaApi: () => null,
    debugLog: () => {},
  });
  const { done } = runSynthesisChunk(initialSynthesisState(), FOREVER);
  assert.equal(done, true);
  assert.ok(Number.isFinite(settings._store["synthesis-last-run-at"]));
  assert.equal(getSynthesisResult(), null); // no run happened
});

test("gate: under-interval no-ops without touching lastRunAt", () => {
  __resetSynthesisForTests();
  const seeded = Date.now() - SYNTHESIS_INTERVAL_MS / 2;
  const settings = makeMockSettings({ "synthesis-last-run-at": seeded });
  initSynthesis({
    getExtensionAPIRef: () => ({ settings }),
    getRoamAlphaApi: () => null,
    debugLog: () => {},
  });
  const { done } = runSynthesisChunk(initialSynthesisState(), FOREVER);
  assert.equal(done, true);
  assert.equal(settings._store["synthesis-last-run-at"], seeded);
  assert.equal(getSynthesisResult(), null);
});

test("gate: over-interval proceeds, completes, advances lastRunAt and records result", () => {
  __resetSynthesisForTests();
  const before = Date.now() - SYNTHESIS_INTERVAL_MS - DAY_MS;
  const settings = makeMockSettings({ "synthesis-last-run-at": before });

  // Roam API mock: empty Corrections page, empty memory pages
  const queryApi = {
    q: () => null,       // no page uids found
    pull: () => null,
  };
  initSynthesis({
    getExtensionAPIRef: () => ({ settings }),
    getRoamAlphaApi: () => ({ data: queryApi }),
    debugLog: () => {},
  });

  let state = initialSynthesisState();
  let done = false;
  for (let i = 0; i < 10 && !done; i++) {
    const r = runSynthesisChunk(state, FOREVER);
    state = r.state;
    done = r.done;
  }
  assert.equal(done, true);
  assert.ok(settings._store["synthesis-last-run-at"] > before);
  const result = getSynthesisResult();
  assert.ok(result);
  assert.equal(result.proposalCount, 0);
  assert.equal(result.scannedCount, 0);
});

test("full run over mocked graph produces proposals and stale flags", () => {
  __resetSynthesisForTests();
  const settings = makeMockSettings({ "synthesis-last-run-at": Date.now() - SYNTHESIS_INTERVAL_MS - DAY_MS });

  const correctionsUid = "corrPageUid";
  const memoryUid = "memPageUid";
  const dateTitle = daysAgoTitle(3);

  const queryApi = {
    q: (query) => {
      if (query.includes('Chief of Staff/Corrections')) return correctionsUid;
      if (query.includes('Chief of Staff/Memory"')) return memoryUid;
      return null; // Decisions / Lessons Learned absent
    },
    pull: (pattern, ref) => {
      if (ref[1] === correctionsUid) {
        return {
          ":block/children": [
            { ":block/uid": "i1", ":block/order": 0, ":block/string": `[[${dateTitle}]] **intent-dismissed**: "check the weather" — classified as: "web search"` },
            { ":block/uid": "i2", ":block/order": 1, ":block/string": `[[${dateTitle}]] **intent-dismissed**: "check weather today" — classified as: "web search"` },
            { ":block/uid": "i3", ":block/order": 2, ":block/string": `[[${dateTitle}]] **intent-dismissed**: "weather please" — classified as: "web search"` },
          ]
        };
      }
      if (ref[1] === memoryUid) {
        return {
          ":block/children": [
            { ":block/uid": "m1", ":block/string": "very old preference", ":edit/time": Date.now() - 300 * DAY_MS },
            { ":block/uid": "m2", ":block/string": "pinned old preference #pinned", ":edit/time": Date.now() - 300 * DAY_MS },
            { ":block/uid": "m3", ":block/string": "fresh preference", ":edit/time": Date.now() - DAY_MS },
          ]
        };
      }
      return null;
    },
  };

  const toasts = [];
  initSynthesis({
    getExtensionAPIRef: () => ({ settings }),
    getRoamAlphaApi: () => ({ data: queryApi }),
    debugLog: () => {},
    // persistence deps resolve harmlessly
    ensurePageUidByTitle: async () => null,
    showInfoToast: (title, msg) => toasts.push(msg),
  });

  let state = initialSynthesisState();
  let done = false;
  for (let i = 0; i < 10 && !done; i++) {
    const r = runSynthesisChunk(state, FOREVER);
    state = r.state;
    done = r.done;
  }
  assert.equal(done, true);

  const result = getSynthesisResult();
  assert.equal(result.proposalCount, 1);       // one intent cluster of 3
  assert.equal(result.staleMemoryCount, 1);    // m1 only (m2 pinned, m3 fresh)
  assert.equal(result.scannedCount, 3);
  assert.equal(result.skippedCount, 0);

  // Fingerprints persisted for cross-run dedupe
  const fps = settings._store["synthesis-proposal-fingerprints"];
  assert.equal(fps.length, 1);
  assert.equal(fps[0].count, 3);
});

test("second run with unchanged clusters suppresses the proposal", () => {
  // Continues from the state left by the previous test's settings? No — fresh mock,
  // pre-seeded fingerprint simulating the previous run.
  __resetSynthesisForTests();
  const settings = makeMockSettings({
    "synthesis-last-run-at": Date.now() - SYNTHESIS_INTERVAL_MS - DAY_MS,
    "synthesis-proposal-fingerprints": [
      { key: "intent:dismissed:web search", count: 3, at: Date.now() - DAY_MS }
    ],
  });

  const dateTitle = daysAgoTitle(3);
  const queryApi = {
    q: (query) => query.includes('Chief of Staff/Corrections') ? "corrPageUid" : null,
    pull: (pattern, ref) => ref[1] === "corrPageUid" ? {
      ":block/children": [
        { ":block/uid": "i1", ":block/order": 0, ":block/string": `[[${dateTitle}]] **intent-dismissed**: "check the weather" — classified as: "web search"` },
        { ":block/uid": "i2", ":block/order": 1, ":block/string": `[[${dateTitle}]] **intent-dismissed**: "check weather today" — classified as: "web search"` },
        { ":block/uid": "i3", ":block/order": 2, ":block/string": `[[${dateTitle}]] **intent-dismissed**: "weather please" — classified as: "web search"` },
      ]
    } : null,
  };

  initSynthesis({
    getExtensionAPIRef: () => ({ settings }),
    getRoamAlphaApi: () => ({ data: queryApi }),
    debugLog: () => {},
    ensurePageUidByTitle: async () => null,
  });

  let state = initialSynthesisState();
  let done = false;
  for (let i = 0; i < 10 && !done; i++) {
    const r = runSynthesisChunk(state, FOREVER);
    state = r.state;
    done = r.done;
  }
  assert.equal(done, true);
  const result = getSynthesisResult();
  assert.equal(result.proposalCount, 0);
  assert.equal(result.suppressedCount, 1);
});

test("runSynthesisChunk yields mid-run when deadline is exhausted", () => {
  __resetSynthesisForTests();
  const settings = makeMockSettings({ "synthesis-last-run-at": Date.now() - SYNTHESIS_INTERVAL_MS - DAY_MS });
  initSynthesis({
    getExtensionAPIRef: () => ({ settings }),
    getRoamAlphaApi: () => ({ data: { q: () => null, pull: () => null } }),
    debugLog: () => {},
  });

  // Deadline that allows the gate through then expires
  let calls = 0;
  const stingy = { timeRemaining: () => (calls++ < 2 ? 5000 : 0) };
  const r = runSynthesisChunk(initialSynthesisState(), stingy);
  assert.equal(r.done, false);
  assert.notEqual(r.state.phase, "gate"); // progress was made and preserved
});
