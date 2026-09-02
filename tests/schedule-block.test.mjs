import test from "node:test";
import assert from "node:assert/strict";
import {
  durationMinutes,
  formatSlotPrefix,
  parseSlotLine,
  rangesOverlap,
  insertSlotChronologically,
  buildScheduleBlockTool,
  isSandboxUserMessage,
  resolveConfiguredScheduleParent,
  parseFlexibleTime,
  parseScheduleFieldsFromUserText,
  isCronLikeScheduleIntent,
  isScheduleSlotIntent,
  buildForcedScheduleToolCall,
  buildForcedScheduleToolCalls,
  parseMultipleScheduleWindows,
  isMoveIntent,
  isUnscheduleIntent,
  parseMoveTitle,
  parseUnscheduleTitle,
  findAllScheduleSlotsByTitle,
  findScheduleSlotByTitle,
  clearLastScheduleCollision,
  getLastScheduleCollision,
  COS_SCHEDULE_BLOCK_BUILD,
  parseDatePinFromUserText,
  isNoNewScheduleTitle,
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

/**
 * In-memory fake of the Roam surface the tool touches: a uid → block store
 * with parent/order, page registry, and the deps object the tool is built
 * with. No live graph, no window, no roamAlphaAPI global.
 */
function makeFakeGraph() {
  let counter = 0;
  const blocks = new Map(); // uid → { string, parent, order }
  const pages = new Map();  // title → uid

  const genUid = () => `uid${String(++counter).padStart(3, "0")}`;

  const childrenOf = (parentUid) =>
    [...blocks.entries()]
      .filter(([, b]) => b.parent === parentUid)
      .map(([uid, b]) => ({ uid, string: b.string, order: b.order }))
      .sort((a, b) => a.order - b.order);

  // Numeric order inserts shift later siblings down, like Roam's createBlock.
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
      pull: (pattern, ref) => {
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
    deleteBlock: async ({ block }) => {
      const uid = block?.uid;
      if (!blocks.has(uid)) throw new Error(`deleteBlock: block ${uid} not found`);
      blocks.delete(uid);
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
    // The module only issues the open-TODO scan; return [uid, string] rows.
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

// ── Pure helpers ─────────────────────────────────────────────────────────────

test("durationMinutes wraps midnight: 21:00 → 00:00 is 180 minutes", () => {
  assert.equal(durationMinutes("21:00", "00:00"), 180);
  assert.equal(durationMinutes("21:00", "24:00"), 180);
  assert.equal(formatSlotPrefix("21:00", "00:00"), "21:00 - 00:00 (**180'**)");
});

test("durationMinutes handles a plain same-day range", () => {
  assert.equal(durationMinutes("20:00", "21:00"), 60);
  assert.equal(formatSlotPrefix("20:00", "21:00"), "20:00 - 21:00 (**60'**)");
});

test("formatSlotPrefix never emits 24:00", () => {
  const prefix = formatSlotPrefix("21:00", "24:00");
  assert.ok(!prefix.includes("24:00"), `prefix "${prefix}" must not contain 24:00`);
  assert.equal(prefix, "21:00 - 00:00 (**180'**)");
});

test("parseSlotLine round-trips task slots, events, and rejects non-slots", () => {
  const task = parseSlotLine("21:00 - 00:00 (**180'**) ((abc123XYZ))");
  assert.deepEqual(
    { start: task.start, end: task.end, mins: task.mins, refUid: task.refUid, isEvent: task.isEvent },
    { start: "21:00", end: "00:00", mins: 180, refUid: "abc123XYZ", isEvent: false }
  );
  const event = parseSlotLine("19:00 - 21:00  Dinner with Anna #Event");
  assert.equal(event.isEvent, true);
  assert.equal(event.refUid, null);
  assert.equal(event.mins, 120);
  assert.equal(parseSlotLine("Schedule"), null);
  assert.equal(parseSlotLine(SMARTBLOCK_STRING), null);
});

test("rangesOverlap treats midnight wrap correctly", () => {
  assert.equal(rangesOverlap("21:00", "00:00", "23:00", "23:30"), true);
  assert.equal(rangesOverlap("21:00", "00:00", "00:00", "01:00"), false); // end-exclusive
  assert.equal(rangesOverlap("23:00", "01:00", "00:30", "02:00"), true);
  assert.equal(rangesOverlap("09:00", "10:00", "10:00", "11:00"), false);
});

test("insertSlotChronologically slots between existing entries and before SmartBlock", () => {
  const children = [
    { uid: "a", string: "09:00 - 10:00 (**60'**) ((t1))", order: 0 },
    { uid: "b", string: "13:00 - 14:00 (**60'**) ((t2))", order: 1 },
    { uid: "c", string: SMARTBLOCK_STRING, order: 2 },
  ];
  assert.equal(insertSlotChronologically(children, "11:00"), 1); // before 13:00
  assert.equal(insertSlotChronologically(children, "20:00"), 2); // before SmartBlock
  assert.equal(insertSlotChronologically([], "20:00"), "last");
});

// ── Tool execution against the fake graph ────────────────────────────────────

test("happy path: gaming 21:00-00:00 writes exact slot, creates TODO, keeps SmartBlock last", async () => {
  const g = makeFakeGraph();
  const tool = buildScheduleBlockTool(g.deps);
  const pageUid = g.addPage("August 26th, 2026");
  const parentUid = g.insertBlock(pageUid, NAUTILUS_STRING);
  const smartBlockUid = g.insertBlock(parentUid, SMARTBLOCK_STRING);

  const result = await tool.execute({
    date: "August 26th, 2026", start: "21:00", end: "24:00",
    title: "Gaming: league of legends",
  });

  assert.equal(result.success, true);
  assert.equal(result.created_todo, true);
  assert.equal(result.reused_todo, false);
  assert.equal(result.parent_uid, parentUid);
  assert.equal(result.slot_string, `21:00 - 00:00 (**180'**) ((${result.task_uid}))`);
  assert.equal(g.blocks.get(result.slot_uid).string, result.slot_string);
  assert.equal(g.blocks.get(result.task_uid).string, "{{[[TODO]]}} Gaming: league of legends");
  assert.equal(g.blocks.get(result.task_uid).parent, pageUid);

  const kids = g.childrenOf(parentUid);
  assert.equal(kids[kids.length - 1].uid, smartBlockUid, "SmartBlock buttons must stay last");
  assert.equal(kids[0].uid, result.slot_uid);
});

test("reuses an existing open TODO instead of creating a duplicate", async () => {
  const g = makeFakeGraph();
  const tool = buildScheduleBlockTool(g.deps);
  const pageUid = g.addPage("August 26th, 2026");
  g.insertBlock(pageUid, NAUTILUS_STRING);
  const todoUid = g.insertBlock(pageUid, "{{[[TODO]]}} play league of legends ranked");

  const result = await tool.execute({
    date: "August 26th, 2026", start: "21:00", end: "23:00",
    title: "League of Legends",
  });

  assert.equal(result.success, true);
  assert.equal(result.reused_todo, true);
  assert.equal(result.created_todo, false);
  assert.equal(result.task_uid, todoUid);
  assert.ok(result.slot_string.includes(`((${todoUid}))`));
  assert.equal(g.todoCount(), 1, "no second TODO may be created");
});

test("ref integrity: stored slot contains ((uid)) exactly, not escaped or triple-paren", async () => {
  const g = makeFakeGraph();
  const tool = buildScheduleBlockTool(g.deps);
  const pageUid = g.addPage("August 26th, 2026");
  g.insertBlock(pageUid, NAUTILUS_STRING);

  const result = await tool.execute({
    date: "August 26th, 2026", start: "08:00", end: "09:30", title: "Morning writing block",
  });

  const stored = g.blocks.get(result.slot_uid).string;
  assert.ok(stored.includes(`((${result.task_uid}))`), `stored "${stored}" must contain ((uid))`);
  assert.ok(!stored.includes("((("), "no triple parens");
  assert.ok(!stored.includes("\\("), "no escaped parens");
  assert.equal(parseSlotLine(stored).refUid, result.task_uid);
});

test("collision with a different task refuses and overwrites nothing", async () => {
  const g = makeFakeGraph();
  const tool = buildScheduleBlockTool(g.deps);
  const pageUid = g.addPage("August 26th, 2026");
  const parentUid = g.insertBlock(pageUid, NAUTILUS_STRING);
  const otherTodo = g.insertBlock(pageUid, "{{[[TODO]]}} deep work sprint");
  const existingSlot = g.insertBlock(parentUid, `20:00 - 22:00 (**120'**) ((${otherTodo}))`);
  const before = g.blocks.get(existingSlot).string;
  const childCountBefore = g.childrenOf(parentUid).length;

  const result = await tool.execute({
    date: "August 26th, 2026", start: "21:00", end: "23:00", title: "Evening yoga session",
  });

  assert.equal(result.success, false);
  assert.equal(result.colliding_uid, existingSlot);
  assert.equal(result.colliding_string, before);
  assert.match(result.error, /collision/i);
  assert.match(result.error, /\bmove\b/i, "collision copy must mention move");
  assert.match(result.error, /21:00-23:00/, "collision copy must include a time example");
  assert.equal(g.blocks.get(existingSlot).string, before, "existing slot must be untouched");
  assert.equal(g.childrenOf(parentUid).length, childCountBefore, "no slot may be written");
  assert.equal(g.todoCount(), 1, "no orphan TODO on refusal");
});

test("same task overlapping its own slot is a reschedule in place", async () => {
  const g = makeFakeGraph();
  const tool = buildScheduleBlockTool(g.deps);
  const pageUid = g.addPage("August 26th, 2026");
  const parentUid = g.insertBlock(pageUid, NAUTILUS_STRING);
  const todoUid = g.insertBlock(pageUid, "{{[[TODO]]}} league of legends session");
  const slotUid = g.insertBlock(parentUid, `21:00 - 22:00 (**60'**) ((${todoUid}))`);

  const result = await tool.execute({
    date: "August 26th, 2026", start: "21:30", end: "23:30",
    title: "irrelevant", task_uid: todoUid,
  });

  assert.equal(result.success, true);
  assert.equal(result.rescheduled, true);
  assert.equal(result.slot_uid, slotUid, "must update the existing slot block");
  assert.equal(g.blocks.get(slotUid).string, `21:30 - 23:30 (**120'**) ((${todoUid}))`);
  assert.equal(g.childrenOf(parentUid).length, 1, "no second slot");
});

test("kind=event writes #Event text and creates no TODO", async () => {
  const g = makeFakeGraph();
  const tool = buildScheduleBlockTool(g.deps);
  const pageUid = g.addPage("August 26th, 2026");
  const parentUid = g.insertBlock(pageUid, NAUTILUS_STRING);

  const result = await tool.execute({
    date: "August 26th, 2026", start: "19:00", end: "21:00",
    title: "Dinner with Anna", kind: "event",
  });

  assert.equal(result.success, true);
  assert.equal(result.slot_string, "19:00 - 21:00  Dinner with Anna #Event");
  assert.equal(g.blocks.get(result.slot_uid).string, result.slot_string);
  assert.equal(g.blocks.get(result.slot_uid).parent, parentUid);
  assert.equal(result.task_uid, null);
  assert.equal(result.created_todo, false);
  assert.equal(g.todoCount(), 0, "events must not create TODOs");
});

test("parent_uid sandbox override is used as the parent, skipping discovery", async () => {
  const g = makeFakeGraph();
  const tool = buildScheduleBlockTool(g.deps);
  const sandboxPage = g.addPage("Sandbox");
  const sandboxParent = g.insertBlock(sandboxPage, "Test schedule area");

  const result = await tool.execute({
    start: "10:00", end: "11:00", title: "Sandbox scheduling check",
    parent_uid: sandboxParent,
  });

  assert.equal(result.success, true);
  assert.equal(result.parent_uid, sandboxParent);
  assert.equal(g.blocks.get(result.slot_uid).parent, sandboxParent);
});

test("generic graph: creates a Schedule heading, never injects the Nautilus render", async () => {
  const g = makeFakeGraph();
  const tool = buildScheduleBlockTool(g.deps);
  const pageUid = g.addPage("August 26th, 2026");
  g.insertBlock(pageUid, "Some journal entry");

  const first = await tool.execute({
    date: "August 26th, 2026", start: "09:00", end: "10:00", title: "Weekly planning review",
  });
  assert.equal(first.success, true);
  assert.equal(first.created_parent, true);
  assert.equal(g.blocks.get(first.parent_uid).string, "Schedule");
  assert.equal(g.blocks.get(first.parent_uid).parent, pageUid);

  // Second call reuses the same heading — no duplicate parent.
  const second = await tool.execute({
    date: "August 26th, 2026", start: "11:00", end: "12:00", title: "Weekly planning review",
  });
  assert.equal(second.parent_uid, first.parent_uid);
  assert.equal(second.created_parent, false);

  const scheduleHeadings = g.childrenOf(pageUid).filter((c) => c.string === "Schedule");
  assert.equal(scheduleHeadings.length, 1);
  const nautilus = [...g.blocks.values()].filter((b) =>
    typeof b.string === "string" && b.string.includes("roam-render-Nautilus-Log-cljs"));
  assert.equal(nautilus.length, 0, "Nautilus render must never be injected on a generic graph");
});

test("new TODO goes to the project page when project is given", async () => {
  const g = makeFakeGraph();
  const tool = buildScheduleBlockTool(g.deps);
  const pageUid = g.addPage("August 26th, 2026");
  g.insertBlock(pageUid, NAUTILUS_STRING);

  const result = await tool.execute({
    date: "August 26th, 2026", start: "14:00", end: "15:00",
    title: "Draft launch announcement", project: "Project Apollo",
  });

  assert.equal(result.success, true);
  assert.equal(result.created_todo, true);
  assert.equal(g.blocks.get(result.task_uid).parent, g.pages.get("Project Apollo"));
});

test("missing start, end, or title is rejected", async () => {
  const g = makeFakeGraph();
  const tool = buildScheduleBlockTool(g.deps);
  await assert.rejects(() => tool.execute({ end: "10:00", title: "x" }), /start/);
  await assert.rejects(() => tool.execute({ start: "09:00", title: "x" }), /end/);
  await assert.rejects(() => tool.execute({ start: "09:00", end: "10:00" }), /title/);
  await assert.rejects(() => tool.execute({ start: "25:00", end: "26:00", title: "x" }), /start/);
});
// ── Sandbox pin + schedule-parent setting ────────────────────────────────────

test("isSandboxUserMessage matches [sandbox] case-insensitively", () => {
  assert.equal(isSandboxUserMessage("schedule gaming 21:00 [sandbox]"), true);
  assert.equal(isSandboxUserMessage("try [SANDBOX] first"), true);
  assert.equal(isSandboxUserMessage("schedule gaming 21:00"), false);
  assert.equal(isSandboxUserMessage(undefined), false);
  assert.equal(isSandboxUserMessage(null), false);
});

test("[sandbox] user text pins the slot to the sandbox page, ignoring model date/parent_uid", async () => {
  const g = makeFakeGraph();
  const todayTitle = fmtRoamDate(new Date());
  const todayUid = g.addPage(todayTitle);
  const todayNautilus = g.insertBlock(todayUid, NAUTILUS_STRING);
  const sandboxUid = g.addPage("COS Daily Plan Sandbox");
  const sandboxNautilus = g.insertBlock(sandboxUid, NAUTILUS_STRING);
  g.deps.getAgentUserMessage = () =>
    "HQ Today: schedule a gaming session 9 pm to midnight league of legends [sandbox]";
  const tool = buildScheduleBlockTool(g.deps);

  const result = await tool.execute({
    date: todayTitle, parent_uid: todayNautilus,
    start: "21:00", end: "00:00", title: "Gaming: league of legends",
  });

  assert.equal(result.success, true);
  assert.equal(result.parent_uid, sandboxNautilus, "slot must go under the sandbox page's Nautilus");
  assert.equal(g.blocks.get(result.slot_uid).parent, sandboxNautilus);
  assert.equal(g.childrenOf(todayNautilus).length, 0, "today's Nautilus must stay empty");
});

test("[sandbox] honours the schedule-sandbox-page setting override", async () => {
  const g = makeFakeGraph();
  const altUid = g.addPage("Alt Sandbox");
  const altNautilus = g.insertBlock(altUid, NAUTILUS_STRING);
  g.deps.getAgentUserMessage = () => "test [sandbox]";
  g.deps.getSettingString = (key, fallback) =>
    key === "schedule-sandbox-page" ? "Alt Sandbox" : fallback;
  const tool = buildScheduleBlockTool(g.deps);

  const result = await tool.execute({ start: "10:00", end: "11:00", title: "Sandbox override check" });

  assert.equal(result.success, true);
  assert.equal(result.parent_uid, altNautilus);
});

test("schedule-parent setting (page title) routes the slot under that page's schedule parent", async () => {
  const g = makeFakeGraph();
  const todayTitle = fmtRoamDate(new Date());
  const todayUid = g.addPage(todayTitle);
  const todayNautilus = g.insertBlock(todayUid, NAUTILUS_STRING);
  const teamUid = g.addPage("Team Plan");
  const teamNautilus = g.insertBlock(teamUid, NAUTILUS_STRING);
  g.deps.getSettingString = (key, fallback) =>
    key === "schedule-parent" ? "Team Plan" : fallback;
  const tool = buildScheduleBlockTool(g.deps);

  const result = await tool.execute({
    date: todayTitle, start: "14:00", end: "15:00", title: "Roadmap sync",
  });

  assert.equal(result.success, true);
  assert.equal(result.parent_uid, teamNautilus, "slot must go under Team Plan's Nautilus");
  assert.equal(g.blocks.get(result.slot_uid).parent, teamNautilus);
  assert.equal(g.childrenOf(todayNautilus).length, 0, "today's Nautilus must stay empty");
});

test("schedule-parent setting (page uid) resolves through the page's schedule parent, not raw page children", async () => {
  const g = makeFakeGraph();
  const teamUid = g.addPage("Team Plan");
  const teamNautilus = g.insertBlock(teamUid, NAUTILUS_STRING);
  g.deps.getSettingString = (key, fallback) =>
    key === "schedule-parent" ? teamUid : fallback;
  const tool = buildScheduleBlockTool(g.deps);

  const result = await tool.execute({
    start: "14:00", end: "15:00", title: "Roadmap sync",
  });

  assert.equal(result.success, true);
  assert.equal(result.parent_uid, teamNautilus, "a page uid must resolve to its schedule parent");
  assert.equal(g.blocks.get(result.slot_uid).parent, teamNautilus);
});

test("parent_uid pointing at a page resolves through findScheduleParent", async () => {
  const g = makeFakeGraph();
  const teamUid = g.addPage("Team Plan");
  const teamNautilus = g.insertBlock(teamUid, NAUTILUS_STRING);
  const tool = buildScheduleBlockTool(g.deps);

  const result = await tool.execute({
    start: "09:00", end: "10:00", title: "Standup", parent_uid: teamUid,
  });

  assert.equal(result.success, true);
  assert.equal(result.parent_uid, teamNautilus);
  assert.equal(g.blocks.get(result.slot_uid).parent, teamNautilus);
});

test("resolveConfiguredScheduleParent returns null for empty input", async () => {
  const g = makeFakeGraph();
  assert.equal(await resolveConfiguredScheduleParent(g.deps, "", "Schedule"), null);
  assert.equal(await resolveConfiguredScheduleParent(g.deps, "   ", "Schedule"), null);
});
// ── User-text clocks ─────────────────────────────────────────────────────────

test("build stamp bumped for the move build", () => {
  assert.equal(COS_SCHEDULE_BLOCK_BUILD, "20260829-overlap-allow");
});

test("parseFlexibleTime covers the full token table", () => {
  assert.equal(parseFlexibleTime("9pm"), "21:00");
  assert.equal(parseFlexibleTime("9 pm"), "21:00");
  assert.equal(parseFlexibleTime("9:00pm"), "21:00");
  assert.equal(parseFlexibleTime("9:00 pm"), "21:00");
  assert.equal(parseFlexibleTime("midnight"), "00:00");
  assert.equal(parseFlexibleTime("noon"), "12:00");
  assert.equal(parseFlexibleTime("12am"), "00:00");
  assert.equal(parseFlexibleTime("12pm"), "12:00");
  assert.equal(parseFlexibleTime("21:00"), "21:00");
  assert.equal(parseFlexibleTime("6:15"), "06:15");
  assert.equal(parseFlexibleTime("24:00"), "00:00");
  assert.equal(parseFlexibleTime("9:5"), null);
  assert.equal(parseFlexibleTime(""), null);
  assert.equal(parseFlexibleTime(null), null);
  assert.equal(parseFlexibleTime("25:00"), null);
  assert.equal(parseFlexibleTime("13pm"), null);
});

test("parseScheduleFieldsFromUserText: two times in order are start/end", () => {
  const f = parseScheduleFieldsFromUserText("schedule gaming 9pm to midnight [sandbox]");
  assert.equal(f.start, "21:00");
  assert.equal(f.end, "00:00");
  assert.equal(f.title, "gaming");
});

test("parseScheduleFieldsFromUserText: meridiem inheritance and bare hours", () => {
  const inherit = parseScheduleFieldsFromUserText("block out focus 6-7am");
  assert.equal(inherit.start, "06:00");
  assert.equal(inherit.end, "07:00");

  const bare = parseScheduleFieldsFromUserText("schedule call 7-7:30");
  assert.equal(bare.start, "07:00");
  assert.equal(bare.end, "07:30");

  const quarters = parseScheduleFieldsFromUserText("schedule review 6:15-6:45");
  assert.equal(quarters.start, "06:15");
  assert.equal(quarters.end, "06:45");
});

test("parseScheduleFieldsFromUserText: title strips verbs, [sandbox], HQ Today:", () => {
  const f = parseScheduleFieldsFromUserText(
    "HQ Today: schedule a gaming session 9 pm to midnight league of legends [sandbox]"
  );
  assert.equal(f.start, "21:00");
  assert.equal(f.end, "00:00");
  assert.ok(!/\[sandbox\]/i.test(f.title));
  assert.ok(!/HQ Today:/i.test(f.title));
  assert.ok(!/\b(schedule|from|to|until|at)\b/i.test(f.title));
  assert.ok(f.title.includes("gaming"));
  assert.ok(f.title.includes("league of legends"));

  const empty = parseScheduleFieldsFromUserText("schedule 9pm to 10pm");
  assert.equal(empty.title, "Timed block");
});

test("isNoNewScheduleTitle accepts both Timed block and legacy Scheduled block", () => {
  assert.equal(isNoNewScheduleTitle("Timed block"), true);
  assert.equal(isNoNewScheduleTitle("Scheduled block"), true);
  assert.equal(isNoNewScheduleTitle("gaming"), false);
});

test("parseScheduleFieldsFromUserText: bare hours after from/to/until are clocks", () => {
  const f = parseScheduleFieldsFromUserText("schedule gaming from 9 to 10pm");
  assert.equal(f.start, "21:00");
  assert.equal(f.end, "22:00");
  assert.ok(f.title.includes("gaming"));
});

test("parseScheduleFieldsFromUserText: start plus duration derives end", () => {
  const iso = parseScheduleFieldsFromUserText("block out 2 hours from 21:00 for gaming");
  assert.equal(iso.start, "21:00");
  assert.equal(iso.end, "23:00");
  assert.ok(iso.title.includes("gaming"));

  const pm = parseScheduleFieldsFromUserText("block out 2 hours from 9pm for gaming");
  assert.equal(pm.start, "21:00");
  assert.equal(pm.end, "23:00");
  assert.ok(pm.title.includes("gaming"));
});

test("execute: start plus duration writes correct slot line", async () => {
  const g = makeFakeGraph();
  const pageUid = g.addPage("August 27th, 2026");
  g.insertBlock(pageUid, NAUTILUS_STRING);
  g.deps.getAgentUserMessage = () => "block out 2 hours from 21:00 for gaming";
  const tool = buildScheduleBlockTool(g.deps);

  const result = await tool.execute({
    date: "August 27th, 2026", start: "09:00", end: "12:00", title: "Gaming",
  });

  assert.equal(result.success, true);
  assert.equal(result.slot_string, `21:00 - 23:00 (**120'**) ((${result.task_uid}))`);
});

test("parseScheduleFieldsFromUserText: duration numbers are not clocks", () => {
  const twoHour = parseScheduleFieldsFromUserText("schedule a 2 hour session 9pm to 11pm");
  assert.equal(twoHour.start, "21:00");
  assert.equal(twoHour.end, "23:00");

  const thirtyMin = parseScheduleFieldsFromUserText("schedule a 30 min break 3pm to 4pm");
  assert.equal(thirtyMin.start, "15:00");
  assert.equal(thirtyMin.end, "16:00");

  const trailing = parseScheduleFieldsFromUserText("schedule deep work 9pm to 11pm for 2 hours");
  assert.equal(trailing.start, "21:00");
  assert.equal(trailing.end, "23:00");
});

test("isCronLikeScheduleIntent: cron/job/recurring true, one-window false", () => {
  assert.equal(isCronLikeScheduleIntent("schedule a cron every 5 min"), true);
  assert.equal(isCronLikeScheduleIntent("set up a recurring reminder"), true);
  assert.equal(isCronLikeScheduleIntent("run this hourly"), true);
  assert.equal(isCronLikeScheduleIntent("remind me in 10 min"), true);
  assert.equal(isCronLikeScheduleIntent("add a crontab entry"), true);
  assert.equal(isCronLikeScheduleIntent("schedule a job that syncs nightly"), true);
  assert.equal(isCronLikeScheduleIntent("schedule a gaming session 9 pm to midnight"), false);
  assert.equal(isCronLikeScheduleIntent("what's on my calendar"), false);
});

test("isScheduleSlotIntent: two times + verb, not cron-like, not calendar reads", () => {
  assert.equal(isScheduleSlotIntent("schedule a gaming session 9 pm to midnight"), true);
  assert.equal(isScheduleSlotIntent("schedule gaming 9pm to midnight [sandbox]"), true);
  assert.equal(isScheduleSlotIntent("block out focus 6-7am"), true);
  assert.equal(isScheduleSlotIntent("put gym from 18:00 to 19:00"), true);
  assert.equal(isScheduleSlotIntent("time-block reading 20:00-21:00"), true);
  assert.equal(isScheduleSlotIntent("add laundry 19:00-21:00"), true);
  assert.equal(isScheduleSlotIntent("book a call 15:00-16:00"), true);
  assert.equal(isScheduleSlotIntent("timebox reading 20:00-21:00"), true);
  assert.equal(isScheduleSlotIntent("block out 2 hours from 9pm for gaming"), true);
  assert.equal(isScheduleSlotIntent("schedule a cron every 5 min"), false);
  assert.equal(isScheduleSlotIntent("what's on my calendar"), false);
  assert.equal(isScheduleSlotIntent("schedule something tomorrow"), false);
  assert.equal(isScheduleSlotIntent("add this to my google calendar 9-10"), false);
  assert.equal(isScheduleSlotIntent("plan my week"), false);
  assert.equal(isScheduleSlotIntent(""), false);
});

test("buildForcedScheduleToolCall: builds cos_schedule_block from user times", () => {
  const call = buildForcedScheduleToolCall("schedule gaming 9pm to midnight [sandbox]");
  assert.deepEqual(call, {
    name: "cos_schedule_block",
    arguments: { start: "21:00", end: "00:00", title: "gaming" }
  });

  const fallback = buildForcedScheduleToolCall("schedule 9pm to 10pm");
  assert.equal(fallback.arguments.title, "Timed block");

  assert.equal(buildForcedScheduleToolCall("what's on my calendar"), null);
  assert.equal(buildForcedScheduleToolCall("schedule a cron every 5 min"), null);
  assert.equal(buildForcedScheduleToolCall("schedule something tomorrow"), null);
});

test("buildForcedScheduleToolCall: overlap follow-up uses last refused window", async () => {
  clearLastScheduleCollision();
  const g = makeFakeGraph();
  const pageUid = g.addPage("August 27th, 2026");
  const parentUid = g.insertBlock(pageUid, NAUTILUS_STRING);
  const todo = g.insertBlock(pageUid, "{{[[TODO]]}} movie night");
  g.insertBlock(parentUid, `19:00 - 21:00 (**120'**) ((${todo}))`);
  const tool = buildScheduleBlockTool(g.deps);

  const refused = await tool.execute({
    date: "August 27th, 2026", start: "19:00", end: "21:00", title: "Laundry",
  });
  assert.equal(refused.success, false);

  const call = buildForcedScheduleToolCall("overlap");
  assert.deepEqual(call, {
    name: "cos_schedule_block",
    arguments: { start: "19:00", end: "21:00", title: "Laundry", collide: "allow" },
  });
});

test("buildForcedScheduleToolCall: allow overlapping timed blocks retries last window", async () => {
  clearLastScheduleCollision();
  const g = makeFakeGraph();
  const pageUid = g.addPage("August 27th, 2026");
  const parentUid = g.insertBlock(pageUid, NAUTILUS_STRING);
  const todo = g.insertBlock(pageUid, "{{[[TODO]]}} standup");
  g.insertBlock(parentUid, `09:00 - 10:00 (**60'**) ((${todo}))`);
  const tool = buildScheduleBlockTool(g.deps);

  const refused = await tool.execute({
    date: "August 27th, 2026", start: "09:00", end: "10:00", title: "Deep work",
  });
  assert.equal(refused.success, false);

  // Setting-name phrase must not be parsed as anchor "timed blocks".
  assert.deepEqual(buildForcedScheduleToolCall("allow overlapping timed blocks"), {
    name: "cos_schedule_block",
    arguments: { start: "09:00", end: "10:00", title: "Deep work", collide: "allow" },
  });
  assert.deepEqual(buildForcedScheduleToolCall("yes, allow overlapping"), {
    name: "cos_schedule_block",
    arguments: { start: "09:00", end: "10:00", title: "Deep work", collide: "allow" },
  });
});

test("buildForcedScheduleToolCall: overlap is null when last collision cleared", async () => {
  clearLastScheduleCollision();
  const g = makeFakeGraph();
  const pageUid = g.addPage("August 27th, 2026");
  const parentUid = g.insertBlock(pageUid, NAUTILUS_STRING);
  const todo = g.insertBlock(pageUid, "{{[[TODO]]}} movie night");
  g.insertBlock(parentUid, `19:00 - 21:00 (**120'**) ((${todo}))`);
  const tool = buildScheduleBlockTool(g.deps);

  await tool.execute({
    date: "August 27th, 2026", start: "19:00", end: "21:00", title: "Laundry",
  });
  clearLastScheduleCollision();
  assert.equal(buildForcedScheduleToolCall("overlap"), null);
});

test("buildForcedScheduleToolCall: timed-slot intent beats last collision", async () => {
  clearLastScheduleCollision();
  const g = makeFakeGraph();
  const pageUid = g.addPage("August 27th, 2026");
  const parentUid = g.insertBlock(pageUid, NAUTILUS_STRING);
  const todo = g.insertBlock(pageUid, "{{[[TODO]]}} movie night");
  g.insertBlock(parentUid, `19:00 - 21:00 (**120'**) ((${todo}))`);
  const tool = buildScheduleBlockTool(g.deps);

  await tool.execute({
    date: "August 27th, 2026", start: "19:00", end: "21:00", title: "Laundry",
  });

  const call = buildForcedScheduleToolCall("schedule gaming 9pm to midnight");
  assert.deepEqual(call, {
    name: "cos_schedule_block",
    arguments: { start: "21:00", end: "00:00", title: "gaming" },
  });
});

test("buildForcedScheduleToolCall: stale last collision returns null for overlap", async () => {
  clearLastScheduleCollision();
  const g = makeFakeGraph();
  const pageUid = g.addPage("August 27th, 2026");
  const parentUid = g.insertBlock(pageUid, NAUTILUS_STRING);
  const todo = g.insertBlock(pageUid, "{{[[TODO]]}} movie night");
  g.insertBlock(parentUid, `19:00 - 21:00 (**120'**) ((${todo}))`);
  const tool = buildScheduleBlockTool(g.deps);

  await tool.execute({
    date: "August 27th, 2026", start: "19:00", end: "21:00", title: "Laundry",
  });
  getLastScheduleCollision().at = Date.now() - (5 * 60 * 1000 + 1000);
  assert.equal(buildForcedScheduleToolCall("overlap"), null);
});

test("user-text clocks overwrite model start/end under [sandbox]", async () => {
  const g = makeFakeGraph();
  const todayTitle = fmtRoamDate(new Date());
  const todayUid = g.addPage(todayTitle);
  const todayNautilus = g.insertBlock(todayUid, NAUTILUS_STRING);
  const sandboxUid = g.addPage("COS Daily Plan Sandbox");
  const sandboxNautilus = g.insertBlock(sandboxUid, NAUTILUS_STRING);
  g.deps.getAgentUserMessage = () => "schedule gaming 9pm to midnight [sandbox]";
  const tool = buildScheduleBlockTool(g.deps);

  const result = await tool.execute({
    date: todayTitle, parent_uid: todayNautilus,
    start: "09:00", end: "12:00", title: "Gaming",
  });

  assert.equal(result.success, true);
  assert.equal(result.parent_uid, sandboxNautilus);
  assert.equal(result.slot_string, `21:00 - 00:00 (**180'**) ((${result.task_uid}))`);
  assert.equal(g.childrenOf(todayNautilus).length, 0, "today's Nautilus must stay empty");
});

test("user-text clocks overwrite model times even without [sandbox]", async () => {
  const g = makeFakeGraph();
  const todayTitle = fmtRoamDate(new Date());
  const todayUid = g.addPage(todayTitle);
  const nautilus = g.insertBlock(todayUid, NAUTILUS_STRING);
  g.deps.getAgentUserMessage = () => "schedule gaming 9pm to midnight";
  const tool = buildScheduleBlockTool(g.deps);

  const result = await tool.execute({
    date: todayTitle, start: "09:00", end: "12:00", title: "Gaming",
  });

  assert.equal(result.success, true);
  assert.equal(result.parent_uid, nautilus);
  assert.equal(result.slot_string, `21:00 - 00:00 (**180'**) ((${result.task_uid}))`);
});

test("model title is kept; only start/end are overwritten", async () => {
  const g = makeFakeGraph();
  g.deps.getAgentUserMessage = () => "schedule gaming 9pm to midnight";
  const tool = buildScheduleBlockTool(g.deps);

  const result = await tool.execute({ start: "09:00", end: "12:00", title: "Model Title Stays" });

  assert.equal(result.success, true);
  assert.equal(g.blocks.get(result.task_uid).string, "{{[[TODO]]}} Model Title Stays");
});

test("parseDatePinFromUserText pins today, tonight, and tomorrow", () => {
  const now = new Date(2026, 7, 27, 9, 0, 0);
  const tomorrow = parseDatePinFromUserText("schedule gaming tomorrow 9pm", now);
  assert.equal(tomorrow.getFullYear(), 2026);
  assert.equal(tomorrow.getMonth(), 7);
  assert.equal(tomorrow.getDate(), 28);
  assert.equal(tomorrow.getHours(), 12);

  const today = parseDatePinFromUserText("schedule tonight 9pm", now);
  assert.equal(today.getDate(), 27);

  assert.equal(parseDatePinFromUserText("schedule gaming 9pm to 10pm", now), null);
});

test("tomorrow in user text pins the daily page even when model passes today", async () => {
  const g = makeFakeGraph();
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const todayTitle = fmtRoamDate(today);
  const tomorrowTitle = fmtRoamDate(tomorrow);
  const todayUid = g.addPage(todayTitle);
  g.insertBlock(todayUid, NAUTILUS_STRING);
  const tomorrowUid = g.addPage(tomorrowTitle);
  const tomorrowNautilus = g.insertBlock(tomorrowUid, NAUTILUS_STRING);
  g.deps.getAgentUserMessage = () => "schedule gaming tomorrow 9pm to 10pm";
  const tool = buildScheduleBlockTool(g.deps);

  const result = await tool.execute({
    date: todayTitle, start: "21:00", end: "22:00", title: "Gaming",
  });

  assert.equal(result.success, true);
  assert.equal(result.parent_uid, tomorrowNautilus);
  assert.equal(g.blocks.get(result.slot_uid).parent, tomorrowNautilus);
});

test("[sandbox] still pins sandbox over tomorrow date pin", async () => {
  const g = makeFakeGraph();
  const todayTitle = fmtRoamDate(new Date());
  const todayUid = g.addPage(todayTitle);
  const todayNautilus = g.insertBlock(todayUid, NAUTILUS_STRING);
  const sandboxUid = g.addPage("COS Daily Plan Sandbox");
  const sandboxNautilus = g.insertBlock(sandboxUid, NAUTILUS_STRING);
  g.deps.getAgentUserMessage = () => "schedule gaming tomorrow 9pm to 10pm [sandbox]";
  const tool = buildScheduleBlockTool(g.deps);

  const result = await tool.execute({
    date: todayTitle, start: "21:00", end: "22:00", title: "Gaming",
  });

  assert.equal(result.success, true);
  assert.equal(result.parent_uid, sandboxNautilus);
  assert.equal(g.childrenOf(todayNautilus).length, 0);
});

// ── Move, unschedule, multi-window ───────────────────────────────────────────

test("collision then move 21:00-23:00 shifts colliding slot and places refused title", async () => {
  clearLastScheduleCollision();
  const g = makeFakeGraph();
  const pageUid = g.addPage("August 27th, 2026");
  const parentUid = g.insertBlock(pageUid, NAUTILUS_STRING);
  const movieTodo = g.insertBlock(pageUid, "{{[[TODO]]}} movie night");
  const movieSlot = g.insertBlock(parentUid, `19:00 - 21:00 (**120'**) ((${movieTodo}))`);
  const tool = buildScheduleBlockTool(g.deps);

  const refused = await tool.execute({
    date: "August 27th, 2026", start: "19:00", end: "21:00", title: "Laundry",
  });
  assert.equal(refused.success, false);

  g.deps.getAgentUserMessage = () => "move 21:00-23:00";
  const moved = await tool.execute({ action: "move", start: "21:00", end: "23:00" });

  assert.equal(moved.success, true);
  assert.equal(moved.moved, true);
  assert.equal(moved.moved_uid, movieSlot);
  assert.match(moved.moved_string, /^21:00 - 23:00/);
  assert.match(moved.slot_string, /^19:00 - 21:00/);
  assert.equal(g.childrenOf(parentUid).length, 2);
  assert.equal(g.todoCount(), 2);
});

test("collision then bare move writes nothing and asks for clocks", async () => {
  clearLastScheduleCollision();
  const g = makeFakeGraph();
  const pageUid = g.addPage("August 27th, 2026");
  const parentUid = g.insertBlock(pageUid, NAUTILUS_STRING);
  const movieTodo = g.insertBlock(pageUid, "{{[[TODO]]}} movie night");
  const movieSlot = g.insertBlock(parentUid, `19:00 - 21:00 (**120'**) ((${movieTodo}))`);
  const before = g.blocks.get(movieSlot).string;
  const tool = buildScheduleBlockTool(g.deps);

  await tool.execute({
    date: "August 27th, 2026", start: "19:00", end: "21:00", title: "Laundry",
  });

  g.deps.getAgentUserMessage = () => "move";
  const result = await tool.execute({ action: "move" });

  assert.equal(result.success, false);
  assert.match(result.error, /\bmove\b/i);
  assert.match(result.error, /21:00-23:00/);
  assert.equal(result.colliding_string, before);
  assert.equal(g.childrenOf(parentUid).length, 1);
});

test("move gaming to 22:00 reschedules in place keeping duration across midnight", async () => {
  clearLastScheduleCollision();
  const g = makeFakeGraph();
  const pageUid = g.addPage("August 27th, 2026");
  const parentUid = g.insertBlock(pageUid, NAUTILUS_STRING);
  const todo = g.insertBlock(pageUid, "{{[[TODO]]}} gaming session");
  const slotUid = g.insertBlock(parentUid, `21:00 - 00:00 (**180'**) ((${todo}))`);
  g.deps.getAgentUserMessage = () => "move gaming to 22:00";
  const tool = buildScheduleBlockTool(g.deps);

  const result = await tool.execute({ start: "22:00", end: "01:00", title: "gaming" });

  assert.equal(result.success, true);
  assert.equal(result.rescheduled, true);
  assert.equal(result.slot_uid, slotUid);
  assert.equal(g.blocks.get(slotUid).string, `22:00 - 01:00 (**180'**) ((${todo}))`);
  assert.equal(g.childrenOf(parentUid).length, 1);
});

test("remove the gaming block deletes slot but keeps TODO", async () => {
  clearLastScheduleCollision();
  const g = makeFakeGraph();
  const pageUid = g.addPage("August 27th, 2026");
  const parentUid = g.insertBlock(pageUid, NAUTILUS_STRING);
  const todo = g.insertBlock(pageUid, "{{[[TODO]]}} gaming session");
  const slotUid = g.insertBlock(parentUid, `21:00 - 00:00 (**180'**) ((${todo}))`);
  g.deps.getAgentUserMessage = () => "remove the gaming block";
  const tool = buildScheduleBlockTool(g.deps);

  const result = await tool.execute({ action: "unschedule", title: "gaming" });

  assert.equal(result.success, true);
  assert.equal(result.unscheduled, true);
  assert.equal(result.task_uid, todo);
  assert.equal(g.blocks.has(slotUid), false);
  assert.equal(g.blocks.has(todo), true);
  assert.equal(g.todoCount(), 1);
});

test("unschedule event removes #Event line only", async () => {
  clearLastScheduleCollision();
  const g = makeFakeGraph();
  const pageUid = g.addPage("August 27th, 2026");
  const parentUid = g.insertBlock(pageUid, NAUTILUS_STRING);
  const slotUid = g.insertBlock(parentUid, "19:00 - 21:00  movie night #Event");
  g.deps.getAgentUserMessage = () => "unschedule movie night";
  const tool = buildScheduleBlockTool(g.deps);

  const result = await tool.execute({ action: "unschedule", title: "movie night", kind: "event" });

  assert.equal(result.success, true);
  assert.equal(result.unscheduled, true);
  assert.equal(result.task_uid, null);
  assert.equal(g.blocks.has(slotUid), false);
  assert.equal(g.todoCount(), 0);
});

test("two matching titles: unschedule refuses", async () => {
  clearLastScheduleCollision();
  const g = makeFakeGraph();
  const pageUid = g.addPage("August 27th, 2026");
  const parentUid = g.insertBlock(pageUid, NAUTILUS_STRING);
  const t1 = g.insertBlock(pageUid, "{{[[TODO]]}} gaming");
  const t2 = g.insertBlock(pageUid, "{{[[TODO]]}} gaming backup");
  g.insertBlock(parentUid, `21:00 - 22:00 (**60'**) ((${t1}))`);
  g.insertBlock(parentUid, `22:00 - 23:00 (**60'**) ((${t2}))`);
  g.deps.getAgentUserMessage = () => "unschedule gaming";
  const tool = buildScheduleBlockTool(g.deps);

  await assert.rejects(
    () => tool.execute({ action: "unschedule", title: "gaming" }),
    /Multiple timed blocks match/
  );
  assert.equal(g.childrenOf(parentUid).length, 2);
});

test("parseMultipleScheduleWindows: two adjacent windows", () => {
  const windows = parseMultipleScheduleWindows("add gym 09:00-10:00 and reading 10:00-11:00");
  assert.equal(windows.length, 2);
  assert.equal(windows[0].title, "gym");
  assert.equal(windows[1].title, "reading");
});

test("multi-window execute writes both slots in chronological order", async () => {
  clearLastScheduleCollision();
  const g = makeFakeGraph();
  const pageUid = g.addPage("August 27th, 2026");
  const parentUid = g.insertBlock(pageUid, NAUTILUS_STRING);
  const smartUid = g.insertBlock(parentUid, SMARTBLOCK_STRING);
  const tool = buildScheduleBlockTool(g.deps);

  const first = await tool.execute({
    date: "August 27th, 2026", start: "09:00", end: "10:00", title: "gym",
  });
  const second = await tool.execute({
    date: "August 27th, 2026", start: "10:00", end: "11:00", title: "reading",
  });

  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(g.todoCount(), 2);
  const kids = g.childrenOf(parentUid).filter((c) => c.uid !== smartUid);
  assert.equal(kids.length, 2);
  assert.match(kids[0].string, /^09:00 - 10:00/);
  assert.match(kids[1].string, /^10:00 - 11:00/);
});

test("buildForcedScheduleToolCalls returns two calls for and-separated windows", () => {
  const calls = buildForcedScheduleToolCalls("add gym 09:00-10:00 and reading 10:00-11:00");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].arguments.title, "gym");
  assert.equal(calls[1].arguments.title, "reading");
});

test("buildForcedScheduleToolCalls: move by title does not need a prior collision", () => {
  clearLastScheduleCollision();
  const calls = buildForcedScheduleToolCalls("move gaming to 22:00");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].arguments.action, "move");
  assert.equal(calls[0].arguments.title, "gaming");
  assert.equal(calls[0].arguments.start, "22:00");
});

test("short title gym matches via substring", () => {
  const children = [{ uid: "s1", string: "09:00 - 10:00 (**60'**) ((t1))", order: 0 }];
  const extra = new Map([["t1", "{{[[TODO]]}} gym"]]);
  assert.ok(findScheduleSlotByTitle(children, "gym", extra));
});

test("movie nite does not match movie night", () => {
  const children = [{ uid: "s1", string: "19:00 - 21:00  movie night #Event", order: 0 }];
  assert.equal(findScheduleSlotByTitle(children, "movie nite"), null);
});
