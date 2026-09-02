import test from "node:test";
import assert from "node:assert/strict";
import { initRoamNativeTools, getRoamNativeTools, resetRoamNativeToolsCache, ROAM_CORE_TOOLS } from "../src/roam-native-tools.js";

/** Minimal deps stub for roam_create_page — override per test. */
function stubDeps(overrides = {}) {
  return {
    getRoamAlphaApi: () => ({}),
    queryRoamDatalog: async () => [],
    requireRoamUpdateBlockApi: () => {},
    requireRoamUidExists: async () => {},
    escapeForDatalog: (s) => s,
    truncateRoamBlockText: (s) => s,
    getBlockUid: () => null,
    getBlockString: () => "",
    getBlockChildren: () => [],
    createRoamBlock: async () => "mock-uid",
    createRoamBlockTree: async () => "mock-tree-uid",
    withRoamWriteRetry: async (fn) => fn(),
    ensurePageUidByTitle: async () => "PAGEuid123",
    ensureDailyPageUid: async () => "mock-daily-uid",
    // Mirrors index.js resolveWriteParentUid: a title/[[ref]] resolves to a
    // created page uid; a real uid passes through.
    resolveWriteParentUid: async (raw) => {
      const s = String(raw || "").trim();
      if (!s) throw new Error("parent_uid is required");
      if (/^[A-Za-z0-9_-]{9}$/.test(s)) return s;
      return "RESOLVED-PAGE-UID";
    },
    getPageTreeByUidAsync: async () => ({}),
    getPageTreeByTitleAsync: async () => ({ title: "x", uid: null, children: [] }),
    flattenBlockTree: () => [],
    countBlockTreeNodes: () => 0,
    parseMarkdownToBlockTree: () => [],
    formatRoamDate: () => "March 16th, 2026",
    updateChiefMemory: async () => {},
    getActiveMemoryPageTitles: () => [],
    getSkillEntries: () => [],
    findSkillEntryByName: () => null,
    invalidateSkillsPromptCache: () => {},
    debugLog: () => {},
    BLOCK_TREE_PULL_PATTERN: "",
    MAX_CREATE_BLOCKS_TOTAL: 100,
    SKILLS_PAGE_TITLE: "Chief of Staff/Skills",
    ...overrides,
  };
}

function getTool(depsOverrides = {}) {
  resetRoamNativeToolsCache();
  initRoamNativeTools(stubDeps(depsOverrides));
  const tool = getRoamNativeTools().find(t => t.name === "roam_create_page");
  assert.ok(tool, "roam_create_page tool should exist");
  return tool;
}

function getNamedTool(name, depsOverrides = {}) {
  resetRoamNativeToolsCache();
  initRoamNativeTools(stubDeps(depsOverrides));
  const tool = getRoamNativeTools().find(t => t.name === name);
  assert.ok(tool, `${name} tool should exist`);
  return tool;
}

test("roam_create_page is a mutating tool", () => {
  const tool = getTool();
  assert.equal(tool.isMutating, true);
});

test("roam_create_page creates an empty page and returns its uid", async () => {
  const tool = getTool();
  const result = await tool.execute({ title: "BBQ Shelter" });
  assert.equal(result.success, true);
  assert.equal(result.page_uid, "PAGEuid123");
  assert.equal(result.title, "BBQ Shelter");
  assert.equal(result.created, true);
  assert.deepEqual(result.uids, []);
});

test("roam_create_page strips surrounding [[ ]] from the title", async () => {
  let seenTitle = null;
  const tool = getTool({ ensurePageUidByTitle: async (t) => { seenTitle = t; return "U"; } });
  const result = await tool.execute({ title: "[[Project Alpha]]" });
  assert.equal(seenTitle, "Project Alpha");
  assert.equal(result.title, "Project Alpha");
});

test("roam_create_page reports created:false when the page already exists", async () => {
  const tool = getTool({
    getPageTreeByTitleAsync: async () => ({ title: "Existing", uid: "EXISTINGuid", children: [] }),
    ensurePageUidByTitle: async () => "EXISTINGuid",
  });
  const result = await tool.execute({ title: "Existing" });
  assert.equal(result.created, false);
  assert.equal(result.page_uid, "EXISTINGuid");
});

test("roam_create_page populates markdown under the PAGE uid via fromMarkdown", async () => {
  let fromMarkdownArg = null;
  const tool = getTool({
    getRoamAlphaApi: () => ({
      data: { block: { fromMarkdown: async (arg) => { fromMarkdownArg = arg; return ["b1", "b2"]; } } },
    }),
  });
  const result = await tool.execute({ title: "Notes", markdown: "## Overview\n- point" });
  assert.equal(fromMarkdownArg.location["parent-uid"], "PAGEuid123", "content must land under the page uid, not a daily-note block");
  assert.deepEqual(result.uids, ["b1", "b2"]);
});

test("roam_create_page falls back to the local parser when fromMarkdown throws", async () => {
  const tool = getTool({
    getRoamAlphaApi: () => ({
      data: { block: { fromMarkdown: async () => { throw new Error("n.map is not a function"); } } },
    }),
    parseMarkdownToBlockTree: () => [{ text: "Overview", children: [] }],
    countBlockTreeNodes: () => 1,
    createRoamBlockTree: async () => "fallback-uid",
  });
  const result = await tool.execute({ title: "Notes", markdown: "## Overview" });
  assert.deepEqual(result.uids, ["fallback-uid"]);
});

test("roam_create_page rejects a missing title", async () => {
  const tool = getTool();
  await assert.rejects(() => tool.execute({ title: "   " }), /title is required/);
});

test("roam_create_page rejects oversized markdown", async () => {
  const tool = getTool();
  const huge = "x".repeat(50001);
  await assert.rejects(() => tool.execute({ title: "P", markdown: huge }), /Markdown too large/);
});

test("roam_create_page opens the page when open:true", async () => {
  let openedUid = null;
  const tool = getTool({
    getRoamAlphaApi: () => ({
      ui: { mainWindow: { openPage: async ({ page }) => { openedUid = page.uid; } } },
    }),
  });
  await tool.execute({ title: "P", open: true });
  assert.equal(openedUid, "PAGEuid123");
});

// ── Parent auto-resolution across create-under-parent tools ──────────────────

test("roam_create_block resolves a page-title parent before writing", async () => {
  let seenParent = null;
  const tool = getNamedTool("roam_create_block", {
    createRoamBlock: async (parentUid) => { seenParent = parentUid; return "newblock"; },
  });
  const result = await tool.execute({ parent_uid: "BBQ Shelter", text: "hi" });
  assert.equal(seenParent, "RESOLVED-PAGE-UID", "block must be written under the resolved page uid");
  assert.equal(result.parent_uid, "RESOLVED-PAGE-UID");
});

test("roam_create_block passes a real uid through unchanged", async () => {
  let seenParent = null;
  const tool = getNamedTool("roam_create_block", {
    createRoamBlock: async (parentUid) => { seenParent = parentUid; return "newblock"; },
  });
  await tool.execute({ parent_uid: "aHirk9S7g", text: "hi" });
  assert.equal(seenParent, "aHirk9S7g");
});

test("roam_create_blocks resolves each work-item parent before writing", async () => {
  const seen = [];
  const tool = getNamedTool("roam_create_blocks", {
    createRoamBlockTree: async (parentUid) => { seen.push(parentUid); return "u"; },
    countBlockTreeNodes: () => 1,
  });
  await tool.execute({ parent_uid: "Project Notes", blocks: [{ text: "a" }] });
  assert.deepEqual(seen, ["RESOLVED-PAGE-UID"]);
});

test("roam_batch_write resolves a page-title parent before writing", async () => {
  let seenParent = null;
  const tool = getNamedTool("roam_batch_write", {
    getRoamAlphaApi: () => ({
      data: { block: { fromMarkdown: async (arg) => { seenParent = arg.location["parent-uid"]; return ["b1"]; } } },
    }),
  });
  const result = await tool.execute({ parent_uid: "BBQ Shelter", markdown: "## Overview" });
  assert.equal(seenParent, "RESOLVED-PAGE-UID");
  assert.equal(result.parent_uid, "RESOLVED-PAGE-UID");
});

test("roam_create_page is a direct (core) tool, not orphaned behind ROAM_ROUTE", () => {
  assert.ok(ROAM_CORE_TOOLS.has("roam_create_page"),
    "roam_create_page must be in ROAM_CORE_TOOLS so the agent sees it directly");
});
test("roam_create_todo: [sandbox] disables the today-page default, no ensureDailyPageUid call", async () => {
  let dailyPageCalled = false;
  const tool = getNamedTool("roam_create_todo", {
    getAgentUserMessage: () => "add milk [sandbox]",
    ensureDailyPageUid: async () => { dailyPageCalled = true; return { pageUid: "DAILYUID", pageTitle: "t" }; },
  });
  const result = await tool.execute({ text: "milk" });
  assert.equal(
    result.error,
    "Sandbox session: parent_uid is required; the today-page default is disabled."
  );
  assert.equal(dailyPageCalled, false, "must not create/resolve today's page under sandbox");
});

test("roam_create_todo: today default unchanged without [sandbox]", async () => {
  const tool = getNamedTool("roam_create_todo", {
    getAgentUserMessage: () => "add milk",
    ensureDailyPageUid: async () => ({ pageUid: "DAILYUID", pageTitle: "t" }),
    createRoamBlock: async (parentUid, text) => {
      assert.equal(parentUid, "DAILYUID");
      return "NEWUID";
    },
  });
  const result = await tool.execute({ text: "milk" });
  assert.equal(result.success, true);
  assert.equal(result.parent_uid, "DAILYUID");
  assert.equal(result.text, "{{[[TODO]]}} milk");
});

test("roam_create_todo: [sandbox] with explicit parent_uid still writes", async () => {
  const tool = getNamedTool("roam_create_todo", {
    getAgentUserMessage: () => "add milk [sandbox]",
    createRoamBlock: async (parentUid) => {
      assert.equal(parentUid, "SANDBOXPG");
      return "NEWUID";
    },
  });
  const result = await tool.execute({ text: "milk", parent_uid: "SANDBOXPG" });
  assert.equal(result.success, true);
  assert.equal(result.parent_uid, "SANDBOXPG");
});
