// Mid-list order: coerceBlockOrder, resolveBlockOrder, create/move after_uid

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  coerceBlockOrder,
  resolveBlockOrder,
  initRoamNativeTools,
  getRoamNativeTools,
  resetRoamNativeToolsCache,
} from "../src/roam-native-tools.js";

function makeFakeGraph() {
  let counter = 0;
  const blocks = new Map();
  const genUid = () => `uid${String(++counter).padStart(3, "0")}`;
  const childrenOf = (parentUid) =>
    [...blocks.entries()]
      .filter(([, b]) => b.parent === parentUid)
      .map(([uid, b]) => ({ uid, string: b.string, order: b.order }))
      .sort((a, b) => a.order - b.order);

  const insert = (parentUid, text, order = "last") => {
    const siblings = childrenOf(parentUid);
    let numeric;
    if (order === "last") numeric = siblings.length;
    else if (order === "first" || order === 0) numeric = 0;
    else numeric = Math.max(0, Math.min(Number(order), siblings.length));
    for (const sib of siblings) {
      if (sib.order >= numeric) blocks.get(sib.uid).order += 1;
    }
    const uid = genUid();
    blocks.set(uid, { string: String(text), parent: parentUid, order: numeric });
    return uid;
  };

  const pageUid = genUid();
  blocks.set(pageUid, { string: "Watch Order", parent: null, order: 0, isPage: true });

  return {
    pageUid,
    blocks,
    childrenOf,
    insert,
    move(uid, parentUid, order) {
      const b = blocks.get(uid);
      if (!b) throw new Error(`move: ${uid} not found`);
      const oldParent = b.parent;
      // vacate old slot
      for (const [id, sib] of blocks) {
        if (sib.parent === oldParent && sib.order > b.order) sib.order -= 1;
      }
      const siblings = childrenOf(parentUid).filter((c) => c.uid !== uid);
      let numeric;
      if (order === "last") numeric = siblings.length;
      else if (order === "first" || order === 0) numeric = 0;
      else numeric = Math.max(0, Math.min(Number(order), siblings.length));
      for (const sib of siblings) {
        if (sib.order >= numeric) blocks.get(sib.uid).order += 1;
      }
      b.parent = parentUid;
      b.order = numeric;
    },
  };
}

function stubDeps(g, overrides = {}) {
  return {
    resolveWriteParentUid: async (uid) => String(uid || "").trim(),
    createRoamBlock: async (parentUid, text, order) => g.insert(parentUid, text, order),
    requireRoamUidExists: (uid, label = "UID") => {
      if (!g.blocks.has(uid)) throw new Error(`${label} "${uid}" not found in graph.`);
    },
    escapeForDatalog: (v) => String(v || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"'),
    queryRoamDatalog: async (query) => {
      // Parent walk for move cycle guard
      const parentWalk = /:find \?puid \.[\s\S]*?\[?b :block\/uid "([^"]+)"\][\s\S]*?\[?b :block\/parent \?p\]/.exec(query);
      if (parentWalk) {
        const uid = parentWalk[1];
        const b = g.blocks.get(uid);
        return b?.parent || null;
      }
      // after_uid order + parent
      const afterQ = /:find \?ord \?puid[\s\S]*?\[?b :block\/uid "([^"]+)"\]/.exec(query);
      if (afterQ) {
        const uid = afterQ[1];
        const b = g.blocks.get(uid);
        if (!b || b.parent == null) return [];
        return [[b.order, b.parent]];
      }
      return [];
    },
    getRoamAlphaApi: () => ({
      moveBlock: async ({ location, block }) => {
        g.move(block.uid, location["parent-uid"], location.order);
      },
      deleteBlock: async () => {},
      util: { generateUID: () => "x" },
      createBlock: async () => {},
    }),
    withRoamWriteRetry: async (fn) => fn(),
    truncateRoamBlockText: (t) => String(t || ""),
    debugLog: () => {},
    getActiveMemoryPageTitles: () => [],
    SKILLS_PAGE_TITLE: "Skills",
    requireRoamUpdateBlockApi: (api) => api,
    ...overrides,
  };
}

function getTool(g, name) {
  resetRoamNativeToolsCache();
  initRoamNativeTools(stubDeps(g));
  return getRoamNativeTools().find((t) => t.name === name);
}

describe("coerceBlockOrder", () => {
  it("maps first/last/numbers/digit strings", () => {
    assert.equal(coerceBlockOrder("first"), 0);
    assert.equal(coerceBlockOrder("last"), "last");
    assert.equal(coerceBlockOrder(3), 3);
    assert.equal(coerceBlockOrder("12"), 12);
    assert.equal(coerceBlockOrder(undefined), "last");
    assert.equal(coerceBlockOrder("nope"), "last");
  });
});

describe("resolveBlockOrder", () => {
  it("returns sibling order + 1 for after_uid", async () => {
    const g = makeFakeGraph();
    const a = g.insert(g.pageUid, "A", 0);
    const b = g.insert(g.pageUid, "B", 1);
    const deps = stubDeps(g);
    assert.equal(await resolveBlockOrder(deps, { after_uid: a, parent_uid: g.pageUid }), 1);
    assert.equal(await resolveBlockOrder(deps, { after_uid: b, parent_uid: g.pageUid }), 2);
  });

  it("falls back to coerce when after_uid omitted", async () => {
    const deps = stubDeps(makeFakeGraph());
    assert.equal(await resolveBlockOrder(deps, { order: "5" }), 5);
    assert.equal(await resolveBlockOrder(deps, { order: "first" }), 0);
  });

  it("rejects after_uid under the wrong parent", async () => {
    const g = makeFakeGraph();
    const other = g.insert(g.pageUid, "heading", 0);
    const child = g.insert(other, "nested", 0);
    const deps = stubDeps(g);
    await assert.rejects(
      () => resolveBlockOrder(deps, { after_uid: child, parent_uid: g.pageUid }),
      /not "/
    );
  });
});

describe("roam_create_block mid-list", () => {
  beforeEach(() => resetRoamNativeToolsCache());
  afterEach(() => resetRoamNativeToolsCache());

  it("inserts after a sibling via after_uid", async () => {
    const g = makeFakeGraph();
    const winter = g.insert(g.pageUid, "Winter Soldier", 0);
    g.insert(g.pageUid, "Age of Ultron", 1);
    const tool = getTool(g, "roam_create_block");
    const result = await tool.execute({
      parent_uid: g.pageUid,
      text: "{{[[TODO]]}} Watch Agents of S.H.I.E.L.D. S1",
      after_uid: winter,
    });
    assert.equal(result.success, true);
    assert.equal(result.order, 1);
    const kids = g.childrenOf(g.pageUid).map((c) => c.string);
    assert.deepEqual(kids, [
      "Winter Soldier",
      "{{[[TODO]]}} Watch Agents of S.H.I.E.L.D. S1",
      "Age of Ultron",
    ]);
  });

  it("accepts numeric order string", async () => {
    const g = makeFakeGraph();
    g.insert(g.pageUid, "A", 0);
    g.insert(g.pageUid, "B", 1);
    const tool = getTool(g, "roam_create_block");
    const result = await tool.execute({
      parent_uid: g.pageUid,
      text: "MID",
      order: "1",
    });
    assert.equal(result.order, 1);
    assert.deepEqual(g.childrenOf(g.pageUid).map((c) => c.string), ["A", "MID", "B"]);
  });
});

describe("roam_move_block mid-list", () => {
  beforeEach(() => resetRoamNativeToolsCache());
  afterEach(() => resetRoamNativeToolsCache());

  it("moves a block after a sibling via after_uid", async () => {
    const g = makeFakeGraph();
    const a = g.insert(g.pageUid, "A", 0);
    g.insert(g.pageUid, "B", 1);
    const c = g.insert(g.pageUid, "C", 2);
    const tool = getTool(g, "roam_move_block");
    const result = await tool.execute({
      uid: c,
      parent_uid: g.pageUid,
      after_uid: a,
    });
    assert.equal(result.success, true);
    assert.equal(result.order, 1);
    assert.deepEqual(g.childrenOf(g.pageUid).map((x) => x.string), ["A", "C", "B"]);
  });
});
