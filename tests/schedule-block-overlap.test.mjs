import test from "node:test";
import assert from "node:assert/strict";
import {
  buildScheduleBlockTool,
  isOverlapScheduleIntent,
  parseOverlapAnchor,
  findScheduleSlotByTitle,
  clearLastScheduleCollision,
  getLastScheduleCollision,
  parseSlotLine,
  isAllowOverlappingPhrase,
  isShortOverlapConfirmation,
  buildForcedScheduleToolCall,
} from "../src/schedule-block.js";

const NAUTILUS_STRING = "{{roam/render: ((roam-render-Nautilus-Log-cljs))}}";
const SMARTBLOCK_STRING = "{{⏱:SmartBlock:Double timestamp buttons2}}";

function fmtRoamDate(date) {
  const months = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  const day = date.getDate();
  const suffix = day === 1 || day === 21 || day === 31 ? "st"
    : day === 2 || day === 22 ? "nd"
      : day === 3 || day === 23 ? "rd" : "th";
  return `${months[date.getMonth()]} ${day}${suffix}, ${date.getFullYear()}`;
}

function makeFakeGraph() {
  let counter = 0;
  const blocks = new Map();
  const pages = new Map();
  const genUid = () => `uid${String(++counter).padStart(3, "0")}`;
  const childrenOf = (parentUid) =>
    [...blocks.entries()]
      .filter(([, b]) => b.parent === parentUid)
      .map(([uid, b]) => ({ uid, string: b.string, order: b.order }))
      .sort((a, b) => a.order - b.order);
  const insertBlock = (parentUid, text, order = "last") => {
    const siblings = childrenOf(parentUid);
    let numeric;
    if (order === "last") numeric = siblings.length;
    else if (order === "first") numeric = 0;
    else numeric = Math.max(0, Math.min(Number(order), siblings.length));
    for (const sib of siblings) {
      if (sib.order >= numeric) blocks.get(sib.uid).order += 1;
    }
    const uid = genUid();
    blocks.set(uid, { string: String(text), parent: parentUid, order: numeric });
    return uid;
  };
  const addPage = (title) => {
    if (pages.has(title)) return pages.get(title);
    const uid = genUid();
    pages.set(title, uid);
    blocks.set(uid, { string: title, parent: null, order: 0, isPage: true });
    return uid;
  };
  const api = {
    data: {
      pull: (_pattern, ref) => {
        const uid = ref[1];
        if (!blocks.has(uid)) return null;
        const entity = {
          ":block/uid": uid,
          ":block/children": childrenOf(uid).map((c) => ({
            ":block/uid": c.uid,
            ":block/string": c.string,
            ":block/order": c.order,
          })),
        };
        const block = blocks.get(uid);
        if (block.isPage) entity[":node/title"] = block.string;
        return entity;
      },
    },
    updateBlock: async ({ block }) => {
      const b = blocks.get(block.uid);
      if (!b) throw new Error(`updateBlock: block ${block.uid} not found`);
      b.string = block.string;
      return true;
    },
  };
  const deps = {
    getRoamAlphaApi: () => api,
    createRoamBlock: async (parentUid, text, order = "last") => insertBlock(parentUid, text, order),
    withRoamWriteRetry: async (fn) => fn(),
    ensureDailyPageUid: async (date = new Date()) => {
      const pageTitle = fmtRoamDate(date);
      return { pageUid: addPage(pageTitle), pageTitle };
    },
    ensurePageUidByTitle: async (title) => addPage(title),
    formatRoamDate: fmtRoamDate,
    queryRoamDatalog: async () =>
      [...blocks.entries()]
        .filter(([, b]) => typeof b.string === "string" && b.string.includes("{{[[TODO]]}}") && !b.isPage)
        .map(([uid, b]) => [uid, b.string]),
    escapeForDatalog: (v) => String(v || ""),
    requireRoamUidExists: (uid, label = "UID") => {
      if (!blocks.has(uid)) throw new Error(`${label} "${uid}" not found in graph.`);
    },
    truncateRoamBlockText: (t) => String(t || ""),
    debugLog: () => {},
    getSettingBool: (key, fallback) => fallback,
  };
  const todoCount = () =>
    [...blocks.values()].filter((b) => typeof b.string === "string" && b.string.includes("{{[[TODO]]}}")).length;
  return { deps, blocks, pages, addPage, insertBlock, childrenOf, todoCount };
}

function setupParent(g) {
  const pageUid = g.addPage("August 27th, 2026");
  const parentUid = g.insertBlock(pageUid, NAUTILUS_STRING);
  return { pageUid, parentUid };
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

test("isOverlapScheduleIntent true/false table", () => {
  const trueCases = [
    "schedule laundry same time as movie night",
    "both at the same time please",
    "overlap with lunch",
    "do it in parallel",
    "alongside standup",
    "while watching movie night",
    "during lunch",
    "overlap",
    "concurrently",
    "double-book me",
    "that's ok we can do both at the same time",
  ];
  for (const t of trueCases) assert.equal(isOverlapScheduleIntent(t), true, `expected true: ${t}`);

  const falseCases = [
    "during the day",
    "during the week",
    "during the month",
    "during the year",
    "during the morning",
    "during the afternoon",
    "during the evening",
    "during the night",
    "that's ok",
    "schedule a cron every 5 min",
    "schedule gaming 9pm to midnight",
  ];
  for (const t of falseCases) assert.equal(isOverlapScheduleIntent(t), false, `expected false: ${t}`);
});

test("parseOverlapAnchor extracts names and strips noise", () => {
  assert.equal(parseOverlapAnchor("schedule laundry same time as movie night today"), "movie night");
  assert.equal(parseOverlapAnchor("during lunch"), "lunch");
  assert.equal(parseOverlapAnchor("while watching movie night"), "movie night");
  assert.equal(parseOverlapAnchor("overlap with standup please"), "standup");
});

test("allow overlapping timed blocks is confirm phrase, not an anchor", () => {
  assert.equal(isAllowOverlappingPhrase("allow overlapping timed blocks"), true);
  assert.equal(isAllowOverlappingPhrase("yes, allow overlapping"), true);
  assert.equal(isAllowOverlappingPhrase("allow overlap"), true);
  assert.equal(isAllowOverlappingPhrase("overlap with lunch"), false);
  assert.equal(parseOverlapAnchor("allow overlapping timed blocks"), null);
  assert.equal(parseOverlapAnchor("yes, allow overlapping timed blocks."), null);
  assert.equal(isShortOverlapConfirmation("allow overlapping timed blocks"), true);
  assert.equal(isShortOverlapConfirmation("yes, allow overlapping"), true);
});

test("follow-up allow overlapping timed blocks reuses the first refused window", async () => {
  clearLastScheduleCollision();
  const g = makeFakeGraph();
  const { pageUid, parentUid } = setupParent(g);
  const todo = g.insertBlock(pageUid, "{{[[TODO]]}} standup");
  g.insertBlock(parentUid, `09:00 - 10:00 (**60'**) ((${todo}))`);
  const tool = buildScheduleBlockTool(g.deps);

  const refused = await tool.execute({
    date: "August 27th, 2026", start: "09:00", end: "10:00", title: "Deep work",
  });
  assert.equal(refused.success, false);

  const forced = buildForcedScheduleToolCall("allow overlapping timed blocks");
  assert.deepEqual(forced, {
    name: "cos_schedule_block",
    arguments: { start: "09:00", end: "10:00", title: "Deep work", collide: "allow" },
  });

  g.deps.getAgentUserMessage = () => "allow overlapping timed blocks";
  const allowed = await tool.execute({
    date: "August 27th, 2026", start: "11:00", end: "12:00", title: "Wrong",
  });

  assert.equal(allowed.success, true);
  assert.match(allowed.slot_string, /^09:00 - 10:00/);
  assert.equal(allowed.overlapped, true);
  // kind=task slot lines hold ((uid)); title lives on the TODO.
  const todoUid = allowed.task_uid;
  assert.ok(todoUid);
  assert.match(g.blocks.get(todoUid).string, /Deep work/i);
});

// ── Overlap writes ───────────────────────────────────────────────────────────

test("collide allow writes a second overlapping slot; existing unchanged", async () => {
  clearLastScheduleCollision();
  const g = makeFakeGraph();
  const { pageUid, parentUid } = setupParent(g);
  const movieTodo = g.insertBlock(pageUid, "{{[[TODO]]}} movie night");
  const existingSlot = g.insertBlock(parentUid, `19:00 - 21:00 (**120'**) ((${movieTodo}))`);
  const before = g.blocks.get(existingSlot).string;
  const tool = buildScheduleBlockTool(g.deps);

  const result = await tool.execute({
    date: "August 27th, 2026", start: "19:00", end: "21:00",
    title: "Laundry", collide: "allow",
  });

  assert.equal(result.success, true);
  assert.equal(result.overlapped, true);
  assert.equal(g.blocks.get(existingSlot).string, before);
  assert.equal(g.childrenOf(parentUid).length, 2);
  assert.equal(g.todoCount(), 2);
});

test("overlap intent forces allow even when args.collide is refuse", async () => {
  clearLastScheduleCollision();
  const g = makeFakeGraph();
  const { pageUid, parentUid } = setupParent(g);
  const movieTodo = g.insertBlock(pageUid, "{{[[TODO]]}} movie night");
  const existingSlot = g.insertBlock(parentUid, `19:00 - 21:00 (**120'**) ((${movieTodo}))`);
  const before = g.blocks.get(existingSlot).string;
  g.deps.getAgentUserMessage = () =>
    "that's ok we can do both at the same time schedule laundry same time as movie night";
  const tool = buildScheduleBlockTool(g.deps);

  const result = await tool.execute({
    date: "August 27th, 2026", start: "19:00", end: "21:00",
    title: "Laundry", collide: "refuse",
  });

  assert.equal(result.success, true);
  assert.equal(result.overlapped, true);
  assert.equal(g.blocks.get(existingSlot).string, before);
});

test("named anchor copies times from existing slot", async () => {
  clearLastScheduleCollision();
  const g = makeFakeGraph();
  const { pageUid, parentUid } = setupParent(g);
  g.insertBlock(parentUid, "19:00 - 21:00 (**120'**) movie night #Event");
  g.deps.getAgentUserMessage = () => "schedule laundry at the same time as movie night";
  const tool = buildScheduleBlockTool(g.deps);

  const result = await tool.execute({
    date: "August 27th, 2026", start: "21:00", end: "23:59", title: "Laundry",
  });

  assert.equal(result.success, true);
  assert.match(result.slot_string, /^19:00 - 21:00/);
});

test("user-text clocks beat the named anchor", async () => {
  clearLastScheduleCollision();
  const g = makeFakeGraph();
  const { parentUid } = setupParent(g);
  g.insertBlock(parentUid, `19:00 - 21:00 (**120'**) movie night #Event`);
  g.deps.getAgentUserMessage = () => "schedule laundry 20:00-21:00 same time as movie night";
  const tool = buildScheduleBlockTool(g.deps);

  const result = await tool.execute({
    date: "August 27th, 2026", start: "19:00", end: "21:00", title: "Laundry",
  });

  assert.equal(result.success, true);
  assert.match(result.slot_string, /^20:00 - 21:00/);
});

test("same-task overlap is still reschedule in place under collide allow", async () => {
  clearLastScheduleCollision();
  const g = makeFakeGraph();
  const { pageUid, parentUid } = setupParent(g);
  const todoUid = g.insertBlock(pageUid, "{{[[TODO]]}} laundry");
  const slotUid = g.insertBlock(parentUid, `19:00 - 21:00 (**120'**) ((${todoUid}))`);
  const tool = buildScheduleBlockTool(g.deps);

  const result = await tool.execute({
    date: "August 27th, 2026", start: "19:30", end: "20:30",
    title: "Laundry", task_uid: todoUid, collide: "allow",
  });

  assert.equal(result.success, true);
  assert.equal(result.rescheduled, true);
  assert.equal(result.slot_uid, slotUid);
  assert.equal(g.childrenOf(parentUid).length, 1);
});

test("event overlapping a task with allow: both remain", async () => {
  clearLastScheduleCollision();
  const g = makeFakeGraph();
  const { pageUid, parentUid } = setupParent(g);
  const todoUid = g.insertBlock(pageUid, "{{[[TODO]]}} standup prep");
  g.insertBlock(parentUid, `09:00 - 09:30 (**30'**) ((${todoUid}))`);
  const tool = buildScheduleBlockTool(g.deps);

  const result = await tool.execute({
    date: "August 27th, 2026", start: "09:00", end: "09:30",
    title: "standup", kind: "event", collide: "allow",
  });

  assert.equal(result.success, true);
  assert.equal(result.overlapped, true);
  assert.equal(g.childrenOf(parentUid).length, 2);
});

test("adjacent slots 21:00-22:00 vs 22:00-23:00 are not a collision", async () => {
  clearLastScheduleCollision();
  const g = makeFakeGraph();
  const { pageUid, parentUid } = setupParent(g);
  const todo = g.insertBlock(pageUid, "{{[[TODO]]}} movie night");
  g.insertBlock(parentUid, `21:00 - 22:00 (**60'**) ((${todo}))`);
  const tool = buildScheduleBlockTool(g.deps);

  const result = await tool.execute({
    date: "August 27th, 2026", start: "22:00", end: "23:00", title: "Laundry",
  });

  assert.equal(result.success, true);
  assert.equal(result.overlapped, undefined);
});

test("midnight wrap: refuse by default, allow writes both", async () => {
  clearLastScheduleCollision();
  const g = makeFakeGraph();
  const { pageUid, parentUid } = setupParent(g);
  const todo = g.insertBlock(pageUid, "{{[[TODO]]}} movie night");
  g.insertBlock(parentUid, `21:00 - 00:00 (**180'**) ((${todo}))`);
  const tool = buildScheduleBlockTool(g.deps);

  const refused = await tool.execute({
    date: "August 27th, 2026", start: "23:00", end: "01:00", title: "Laundry",
  });
  assert.equal(refused.success, false);
  assert.equal(g.childrenOf(parentUid).length, 1);

  const allowed = await tool.execute({
    date: "August 27th, 2026", start: "23:00", end: "01:00",
    title: "Laundry", collide: "allow",
  });
  assert.equal(allowed.success, true);
  assert.equal(g.childrenOf(parentUid).length, 2);
});

test("refuse still creates no orphan TODO", async () => {
  clearLastScheduleCollision();
  const g = makeFakeGraph();
  const { pageUid, parentUid } = setupParent(g);
  const todo = g.insertBlock(pageUid, "{{[[TODO]]}} movie night");
  g.insertBlock(parentUid, `19:00 - 21:00 (**120'**) ((${todo}))`);
  const beforeTodos = g.todoCount();
  const tool = buildScheduleBlockTool(g.deps);

  const result = await tool.execute({
    date: "August 27th, 2026", start: "19:30", end: "20:30", title: "Laundry",
  });

  assert.equal(result.success, false);
  assert.equal(g.todoCount(), beforeTodos);
});

test("follow-up overlap reuses the first refused window", async () => {
  clearLastScheduleCollision();
  const g = makeFakeGraph();
  const { pageUid, parentUid } = setupParent(g);
  const todo = g.insertBlock(pageUid, "{{[[TODO]]}} movie night");
  g.insertBlock(parentUid, `19:00 - 21:00 (**120'**) ((${todo}))`);
  const tool = buildScheduleBlockTool(g.deps);

  const refused = await tool.execute({
    date: "August 27th, 2026", start: "19:00", end: "21:00", title: "Laundry",
  });
  assert.equal(refused.success, false);

  g.deps.getAgentUserMessage = () => "overlap";
  const allowed = await tool.execute({
    date: "August 27th, 2026", start: "09:00", end: "10:00", title: "Laundry",
  });

  assert.equal(allowed.success, true);
  assert.match(allowed.slot_string, /^19:00 - 21:00/);
  assert.equal(allowed.overlapped, true);
});

test("missed named anchor does not reuse last refused window", async () => {
  clearLastScheduleCollision();
  const g = makeFakeGraph();
  const { pageUid, parentUid } = setupParent(g);
  const todo = g.insertBlock(pageUid, "{{[[TODO]]}} movie night");
  g.insertBlock(parentUid, `19:00 - 21:00 (**120'**) ((${todo}))`);
  const tool = buildScheduleBlockTool(g.deps);

  const refused = await tool.execute({
    date: "August 27th, 2026", start: "19:00", end: "21:00", title: "Laundry",
  });
  assert.equal(refused.success, false);

  g.deps.getAgentUserMessage = () => "schedule laundry during yoga";
  const allowed = await tool.execute({
    date: "August 27th, 2026", start: "09:00", end: "10:00", title: "Laundry", collide: "allow",
  });

  assert.equal(allowed.success, true);
  assert.match(allowed.slot_string, /^09:00 - 10:00/);
  assert.equal(allowed.overlapped, undefined);
});

test("stale last collision at is not reused on overlap follow-up", async () => {
  clearLastScheduleCollision();
  const g = makeFakeGraph();
  const { pageUid, parentUid } = setupParent(g);
  const todo = g.insertBlock(pageUid, "{{[[TODO]]}} movie night");
  g.insertBlock(parentUid, `19:00 - 21:00 (**120'**) ((${todo}))`);
  const tool = buildScheduleBlockTool(g.deps);

  const refused = await tool.execute({
    date: "August 27th, 2026", start: "19:00", end: "21:00", title: "Laundry",
  });
  assert.equal(refused.success, false);

  getLastScheduleCollision().at = Date.now() - (5 * 60 * 1000 + 1000);
  g.deps.getAgentUserMessage = () => "overlap";
  const result = await tool.execute({
    date: "August 27th, 2026", start: "09:00", end: "10:00", title: "Laundry", collide: "allow",
  });

  assert.equal(result.success, true);
  assert.match(result.slot_string, /^09:00 - 10:00/);
});

test("title fallback does not cross schedule parents", async () => {
  clearLastScheduleCollision();
  const g = makeFakeGraph();
  const { pageUid, parentUid } = setupParent(g);
  const pageUidB = g.addPage("August 28th, 2026");
  const parentUidB = g.insertBlock(pageUidB, NAUTILUS_STRING);
  const todo = g.insertBlock(pageUid, "{{[[TODO]]}} movie night");
  g.insertBlock(parentUid, `19:00 - 21:00 (**120'**) ((${todo}))`);
  const tool = buildScheduleBlockTool(g.deps);

  const refused = await tool.execute({
    date: "August 27th, 2026", start: "19:00", end: "21:00", title: "Laundry",
  });
  assert.equal(refused.success, false);

  g.deps.getAgentUserMessage = () => "overlap";
  await assert.rejects(
    () => tool.execute({
      date: "August 28th, 2026", parent_uid: parentUidB,
      start: "09:00", end: "10:00", collide: "allow",
    }),
    /title is required/
  );
});

test("schedule-allow-overlap setting: true allows, false refuses", async () => {
  clearLastScheduleCollision();
  const g = makeFakeGraph();
  const { pageUid, parentUid } = setupParent(g);
  const todo = g.insertBlock(pageUid, "{{[[TODO]]}} movie night");
  g.insertBlock(parentUid, `19:00 - 21:00 (**120'**) ((${todo}))`);
  g.deps.getSettingBool = (key, fallback) =>
    key === "schedule-allow-overlap" ? true : fallback;
  const tool = buildScheduleBlockTool(g.deps);

  const allowed = await tool.execute({
    date: "August 27th, 2026", start: "19:00", end: "21:00", title: "Laundry",
  });
  assert.equal(allowed.success, true);
  assert.equal(allowed.overlapped, true);

  clearLastScheduleCollision();
  const g2 = makeFakeGraph();
  const { pageUid: p2, parentUid: par2 } = setupParent(g2);
  const t2 = g2.insertBlock(p2, "{{[[TODO]]}} movie night");
  g2.insertBlock(par2, `19:00 - 21:00 (**120'**) ((${t2}))`);
  g2.deps.getSettingBool = (key, fallback) =>
    key === "schedule-allow-overlap" ? false : fallback;
  const tool2 = buildScheduleBlockTool(g2.deps);

  const refused = await tool2.execute({
    date: "August 27th, 2026", start: "19:00", end: "21:00", title: "Laundry",
  });
  assert.equal(refused.success, false);
});

test("align_with copies times when user text has no clocks", async () => {
  clearLastScheduleCollision();
  const g = makeFakeGraph();
  const { parentUid } = setupParent(g);
  g.insertBlock(parentUid, `19:00 - 21:00 (**120'**) movie night #Event`);
  const tool = buildScheduleBlockTool(g.deps);

  const result = await tool.execute({
    date: "August 27th, 2026", start: "09:00", end: "10:00",
    title: "Laundry", align_with: "movie night", collide: "allow",
  });

  assert.equal(result.success, true);
  assert.match(result.slot_string, /^19:00 - 21:00/);
});

test("user-text clocks beat align_with when both are set", async () => {
  clearLastScheduleCollision();
  const g = makeFakeGraph();
  const { parentUid } = setupParent(g);
  g.insertBlock(parentUid, `19:00 - 21:00 (**120'**) movie night #Event`);
  g.deps.getAgentUserMessage = () => "schedule laundry 20:00-21:00";
  const tool = buildScheduleBlockTool(g.deps);

  const result = await tool.execute({
    date: "August 27th, 2026", start: "19:00", end: "21:00",
    title: "Laundry", align_with: "movie night", collide: "allow",
  });

  assert.equal(result.success, true);
  assert.match(result.slot_string, /^20:00 - 21:00/);
});

test("title is never replaced by the anchor", async () => {
  clearLastScheduleCollision();
  const g = makeFakeGraph();
  const { pageUid, parentUid } = setupParent(g);
  g.insertBlock(parentUid, `19:00 - 21:00 (**120'**) movie night #Event`);
  g.deps.getAgentUserMessage = () => "schedule laundry at the same time as movie night";
  const tool = buildScheduleBlockTool(g.deps);

  const result = await tool.execute({
    date: "August 27th, 2026", start: "19:00", end: "21:00", title: "Laundry",
  });

  assert.equal(result.success, true);
  assert.equal(g.blocks.get(result.task_uid).string, "{{[[TODO]]}} Laundry");
});

// ── Stress extras ────────────────────────────────────────────────────────────

test("typo anchor movie nite does not fuzzy-match movie night", () => {
  const children = [
    { uid: "s1", string: "19:00 - 21:00 (**120'**) movie night #Event", order: 0 },
  ];
  assert.equal(findScheduleSlotByTitle(children, "movie nite"), null);
});

test("two existing overlaps: allow writes a third", async () => {
  clearLastScheduleCollision();
  const g = makeFakeGraph();
  const { pageUid, parentUid } = setupParent(g);
  const t1 = g.insertBlock(pageUid, "{{[[TODO]]}} movie night");
  const t2 = g.insertBlock(pageUid, "{{[[TODO]]}} lunch");
  g.insertBlock(parentUid, `19:00 - 21:00 (**120'**) ((${t1}))`);
  g.insertBlock(parentUid, `19:00 - 21:00 (**120'**) ((${t2}))`);
  const tool = buildScheduleBlockTool(g.deps);

  const result = await tool.execute({
    date: "August 27th, 2026", start: "19:00", end: "21:00",
    title: "Laundry", collide: "allow",
  });

  assert.equal(result.success, true);
  assert.equal(g.childrenOf(parentUid).length, 3);
});

test("SmartBlock buttons stay last after an overlapping insert", async () => {
  clearLastScheduleCollision();
  const g = makeFakeGraph();
  const { pageUid, parentUid } = setupParent(g);
  const todo = g.insertBlock(pageUid, "{{[[TODO]]}} movie night");
  g.insertBlock(parentUid, `19:00 - 21:00 (**120'**) ((${todo}))`);
  const smartUid = g.insertBlock(parentUid, SMARTBLOCK_STRING);
  const tool = buildScheduleBlockTool(g.deps);

  await tool.execute({
    date: "August 27th, 2026", start: "19:00", end: "21:00",
    title: "Laundry", collide: "allow",
  });

  const kids = g.childrenOf(parentUid);
  assert.equal(kids[kids.length - 1].uid, smartUid);
});

test("[sandbox] + overlap still pins the sandbox page", async () => {
  clearLastScheduleCollision();
  const g = makeFakeGraph();
  const todayUid = g.addPage(fmtRoamDate(new Date()));
  const todayNautilus = g.insertBlock(todayUid, NAUTILUS_STRING);
  const sandboxUid = g.addPage("COS Daily Plan Sandbox");
  const sandboxNautilus = g.insertBlock(sandboxUid, NAUTILUS_STRING);
  const todo = g.insertBlock(sandboxUid, "{{[[TODO]]}} movie night");
  g.insertBlock(sandboxNautilus, `19:00 - 21:00 (**120'**) ((${todo}))`);
  g.deps.getAgentUserMessage = () => "schedule laundry same time as movie night [sandbox]";
  const tool = buildScheduleBlockTool(g.deps);

  const result = await tool.execute({
    date: fmtRoamDate(new Date()), parent_uid: todayNautilus,
    start: "19:00", end: "21:00", title: "Laundry",
  });

  assert.equal(result.success, true);
  assert.equal(result.parent_uid, sandboxNautilus);
  assert.equal(g.childrenOf(todayNautilus).length, 0);
});

test("kind=event different titles allow both; same title reschedules", async () => {
  clearLastScheduleCollision();
  const g = makeFakeGraph();
  const { parentUid } = setupParent(g);
  const slotUid = g.insertBlock(parentUid, "19:00 - 21:00  movie night #Event");
  const tool = buildScheduleBlockTool(g.deps);

  const both = await tool.execute({
    date: "August 27th, 2026", start: "19:00", end: "21:00",
    title: "lunch", kind: "event", collide: "allow",
  });
  assert.equal(both.success, true);
  assert.equal(g.childrenOf(parentUid).length, 2);

  const reschedule = await tool.execute({
    date: "August 27th, 2026", start: "20:00", end: "22:00",
    title: "movie night", kind: "event", collide: "allow",
  });
  assert.equal(reschedule.success, true);
  assert.equal(reschedule.rescheduled, true);
  assert.equal(reschedule.slot_uid, slotUid);
  assert.equal(g.childrenOf(parentUid).length, 2);
});

test("collide ask returns colliding_string and does not write", async () => {
  clearLastScheduleCollision();
  const g = makeFakeGraph();
  const { pageUid, parentUid } = setupParent(g);
  const todo = g.insertBlock(pageUid, "{{[[TODO]]}} movie night");
  const existing = g.insertBlock(parentUid, `19:00 - 21:00 (**120'**) ((${todo}))`);
  const before = g.blocks.get(existing).string;
  const tool = buildScheduleBlockTool(g.deps);

  const result = await tool.execute({
    date: "August 27th, 2026", start: "19:00", end: "21:00",
    title: "Laundry", collide: "ask",
  });

  assert.equal(result.success, false);
  assert.equal(result.colliding_string, before);
  assert.match(result.error, /Ask the user: overlap or allow overlapping timed blocks to keep both/);
  assert.equal(g.childrenOf(parentUid).length, 1);
});

test("findScheduleSlotByTitle matches slot text and linked TODO", () => {
  const children = [
    { uid: "s1", string: "19:00 - 21:00 (**120'**) ((t1))", order: 0 },
  ];
  const extra = new Map([["t1", "{{[[TODO]]}} movie night prep"]]);
  const match = findScheduleSlotByTitle(children, "movie night", extra);
  assert.ok(match);
  assert.equal(parseSlotLine(match.child.string).start, "19:00");
});
