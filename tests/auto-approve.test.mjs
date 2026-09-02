import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyAutoApprove,
  normaliseAutoApproveMode,
  AUTO_APPROVE_GRAPH_WRITE_TOOLS,
  AUTO_APPROVE_SINGLE_DELETE_TOOLS,
} from "../src/security-core.js";
import {
  initToolExecution,
  executeToolCall,
  clearToolApprovals,
  resetAutoApproveCount,
  getAutoApproveCount,
  AUTO_APPROVE_MAX_PER_RUN,
} from "../src/tool-execution.js";

// ── classifyAutoApprove: mode off ───────────────────────────────────────────

test("mode off: every tool prompts, including reversible graph writes", () => {
  assert.equal(classifyAutoApprove("roam_create_block", { parent_uid: "p" }, "off"), "prompt");
  assert.equal(classifyAutoApprove("roam_update_block", { uid: "b" }, "off"), "prompt");
  assert.equal(classifyAutoApprove("roam_delete_block", { uid: "b" }, "off"), "prompt");
});

// ── classifyAutoApprove: mode graph ─────────────────────────────────────────

test("mode graph: cos_schedule_block unschedule prompts like delete", () => {
  assert.equal(classifyAutoApprove("cos_schedule_block", { action: "unschedule", title: "gym" }, "graph"), "prompt");
  assert.equal(classifyAutoApprove("cos_schedule_block", { action: "place", start: "09:00", end: "10:00", title: "gym" }, "graph"), "auto");
});

test("mode full: cos_schedule_block unschedule auto-approves", () => {
  assert.equal(classifyAutoApprove("cos_schedule_block", { action: "unschedule", title: "gym" }, "full"), "auto");
});

test("mode graph: reversible graph writes auto-approve", () => {
  for (const name of ["roam_create_block", "roam_create_blocks", "roam_update_block",
    "roam_batch_write", "roam_create_todo", "roam_modify_todo", "roam_create_page",
    "cos_schedule_block"]) {
    assert.equal(classifyAutoApprove(name, {}, "graph"), "auto", name);
  }
});

test("mode graph: deletes still prompt", () => {
  assert.equal(classifyAutoApprove("roam_delete_block", { uid: "b1" }, "graph"), "prompt");
});

test("mode graph: external side effects still prompt", () => {
  assert.equal(classifyAutoApprove("GMAIL_SEND", {}, "graph"), "prompt");
  assert.equal(classifyAutoApprove("GOOGLECALENDAR_CREATE_EVENT", {}, "graph"), "prompt");
  assert.equal(classifyAutoApprove("cos_cron_delete", {}, "graph"), "prompt");
  assert.equal(classifyAutoApprove("cos_cron_delete_jobs", {}, "graph"), "prompt");
  assert.equal(classifyAutoApprove("roam_upload_file", { url: "https://x" }, "graph"), "prompt");
  assert.equal(classifyAutoApprove("cos_update_memory", { content: "x" }, "graph"), "prompt");
  assert.equal(classifyAutoApprove("cos_write_draft_skill", {}, "graph"), "prompt");
});

// ── classifyAutoApprove: mode full ──────────────────────────────────────────

test("mode full: single roam_delete_block auto-approves", () => {
  assert.equal(classifyAutoApprove("roam_delete_block", { uid: "b1" }, "full"), "auto");
});

test("mode full: delete with children-wipe flag prompts", () => {
  assert.equal(classifyAutoApprove("roam_delete_block", { uid: "b1", delete_children: true }, "full"), "prompt");
  assert.equal(classifyAutoApprove("roam_delete_block", { uid: "b1", recursive: true }, "full"), "prompt");
});

test("mode full: bulk delete (4 uids) prompts", () => {
  assert.equal(
    classifyAutoApprove("roam_delete_block", { uids: ["a", "b", "c", "d"] }, "full"),
    "prompt"
  );
});

test("mode full: email, money, and external side effects still prompt", () => {
  assert.equal(classifyAutoApprove("GMAIL_SEND", {}, "full"), "prompt");
  assert.equal(classifyAutoApprove("STRIPE_CREATE_PAYMENT", {}, "full"), "prompt");
  assert.equal(classifyAutoApprove("cos_cron_delete", {}, "full"), "prompt");
  assert.equal(classifyAutoApprove("roam_upload_file", {}, "full"), "prompt");
  assert.equal(classifyAutoApprove("cos_update_memory", {}, "full"), "prompt");
});

// ── Meta-tools classify on the resolved inner name ──────────────────────────

test("COMPOSIO_MULTI_EXECUTE_TOOL with GMAIL_SEND inner prompts in full mode", () => {
  const args = { tools: [{ tool_slug: "GMAIL_SEND", arguments: { to: "x@y.z" } }] };
  assert.equal(classifyAutoApprove("COMPOSIO_MULTI_EXECUTE_TOOL", args, "full"), "prompt");
});

test("COMPOSIO_MULTI_EXECUTE_TOOL: batch is as dangerous as its most dangerous member", () => {
  const args = {
    tools: [
      { tool_slug: "roam_create_block", arguments: {} },
      { tool_slug: "GMAIL_SEND", arguments: {} },
    ],
  };
  assert.equal(classifyAutoApprove("COMPOSIO_MULTI_EXECUTE_TOOL", args, "graph"), "prompt");
});

test("COMPOSIO_MULTI_EXECUTE_TOOL: empty or slug-less batch prompts", () => {
  assert.equal(classifyAutoApprove("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [] }, "graph"), "prompt");
  assert.equal(classifyAutoApprove("COMPOSIO_MULTI_EXECUTE_TOOL", {}, "graph"), "prompt");
  assert.equal(classifyAutoApprove("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{}] }, "graph"), "prompt");
});

test("LOCAL_MCP_EXECUTE: unknown inner tool prompts", () => {
  assert.equal(
    classifyAutoApprove("LOCAL_MCP_EXECUTE", { tool_name: "totally_unknown_tool" }, "graph"),
    "prompt"
  );
  assert.equal(classifyAutoApprove("LOCAL_MCP_EXECUTE", {}, "graph"), "prompt");
});

test("LOCAL_MCP_EXECUTE: allowlisted inner graph write auto-approves", () => {
  assert.equal(
    classifyAutoApprove("LOCAL_MCP_EXECUTE", { tool_name: "roam_create_block", arguments: {} }, "graph"),
    "auto"
  );
});

test("ROAM_EXECUTE: classifies on inner name", () => {
  assert.equal(
    classifyAutoApprove("ROAM_EXECUTE", { tool_name: "roam_batch_write", arguments: {} }, "graph"),
    "auto"
  );
  assert.equal(
    classifyAutoApprove("ROAM_EXECUTE", { tool_name: "roam_delete_block", arguments: { uid: "b" } }, "graph"),
    "prompt"
  );
});

// ── Unknown tools fail closed in every mode ─────────────────────────────────

test("unknown tool name prompts in all modes", () => {
  for (const mode of ["off", "graph", "full"]) {
    assert.equal(classifyAutoApprove("some_brand_new_tool", {}, mode), "prompt", mode);
    assert.equal(classifyAutoApprove("", {}, mode), "prompt", mode);
  }
});

// ── Injection: tool args cannot widen policy ────────────────────────────────

test("args.skip_approval / pre_approved never widen classification", () => {
  assert.equal(classifyAutoApprove("GMAIL_SEND", { skip_approval: true }, "graph"), "prompt");
  assert.equal(classifyAutoApprove("roam_delete_block", { uid: "b", skip_approval: true }, "graph"), "prompt");
  assert.equal(classifyAutoApprove("cos_cron_delete", { pre_approved: true }, "full"), "prompt");
  // ...and classification stays tool-name-driven for allowlisted tools
  assert.equal(classifyAutoApprove("roam_create_block", { skip_approval: true }, "graph"), "auto");
});

// ── Mode normalisation ──────────────────────────────────────────────────────

test("invalid mode strings are treated as off", () => {
  for (const bad of ["yes", "true", "on", "1", "", null, undefined, 42]) {
    assert.equal(normaliseAutoApproveMode(bad), "off", String(bad));
    assert.equal(classifyAutoApprove("roam_create_block", {}, bad), "prompt", String(bad));
  }
  assert.equal(normaliseAutoApproveMode("graph"), "graph");
  assert.equal(normaliseAutoApproveMode("full"), "full");
  assert.equal(normaliseAutoApproveMode("GRAPH"), "graph");
});

// ── Allowlist sanity ────────────────────────────────────────────────────────

test("allowlists contain only the documented tools", () => {
  assert.deepEqual([...AUTO_APPROVE_GRAPH_WRITE_TOOLS].sort(), [
    "cos_schedule_block",
    "roam_batch_write",
    "roam_create_block",
    "roam_create_blocks",
    "roam_create_page",
    "roam_create_todo",
    "roam_modify_todo",
    "roam_update_block",
  ]);
  assert.deepEqual([...AUTO_APPROVE_SINGLE_DELETE_TOOLS], ["roam_delete_block"]);
});

// ── executeToolCall gate ────────────────────────────────────────────────────

function makeGateDeps({ mode = "off", promptSpy, toastSpy } = {}) {
  const roamTools = [
    {
      name: "roam_create_block",
      isMutating: true,
      execute: async () => ({ success: true, uid: "b1" }),
    },
    {
      name: "roam_delete_block",
      isMutating: true,
      execute: async ({ uid } = {}) => ({ success: true, deleted_uid: uid }),
    },
  ];
  return {
    getRoamNativeTools: () => roamTools,
    getBetterTasksTools: () => [],
    getCosIntegrationTools: () => [],
    getCronTools: () => [],
    getExternalExtensionTools: () => [],
    getLocalMcpToolsCache: () => [],
    getRemoteMcpToolsCache: () => [],
    getComposioMetaToolsForLlm: () => [],
    getComposioSafeMultiExecuteSlugAllowlist: () => new Set(),
    isOpenAICompatible: (p) => p !== "anthropic",
    debugLog: () => {},
    getLocalMcpClients: () => new Map(),
    WRITE_TOOL_NAMES: new Set(["roam_create_block"]),
    INBOX_READ_ONLY_TOOL_ALLOWLIST: new Set(),
    getExtensionAPI: () => ({}),
    isDryRunEnabled: () => false,
    consumeDryRunMode: () => {},
    getSettingString: (_api, key, fallback) => (key === "auto-approve-mode" ? mode : fallback),
    SETTINGS_KEYS: { autoApproveMode: "auto-approve-mode" },
    getRoamAlphaApi: () => null,
    escapeForDatalog: (s) => s,
    getMcpClient: () => null,
    getBtProjectsCache: () => null,
    setBtProjectsCache: () => {},
    promptToolExecutionApproval: promptSpy,
    showInfoToast: toastSpy,
  };
}

test("gate: graph mode auto-approves roam_create_block without prompting", async () => {
  let promptCalls = 0;
  const toasts = [];
  initToolExecution(makeGateDeps({
    mode: "graph",
    promptSpy: async () => { promptCalls++; return true; },
    toastSpy: (title, message) => toasts.push(`${title}: ${message}`),
  }));
  resetAutoApproveCount();
  clearToolApprovals(); // module-level page/tool approval maps persist across tests
  const result = await executeToolCall("roam_create_block", { parent_uid: "p1", text: "hi" });
  assert.equal(result.success, true);
  assert.equal(promptCalls, 0, "promptToolExecutionApproval must not be called");
  assert.equal(getAutoApproveCount(), 1);
  assert.equal(toasts.length, 1, "passive toast must be shown — never silent");
  assert.match(toasts[0], /Auto-approved: roam_create_block/);
});

test("gate: full mode auto-approves a single roam_delete_block", async () => {
  let promptCalls = 0;
  const toasts = [];
  initToolExecution(makeGateDeps({
    mode: "full",
    promptSpy: async () => { promptCalls++; return true; },
    toastSpy: (title, message) => toasts.push(`${title}: ${message}`),
  }));
  resetAutoApproveCount();
  clearToolApprovals(); // module-level page/tool approval maps persist across tests
  const result = await executeToolCall("roam_delete_block", { uid: "b1" });
  assert.equal(result.success, true);
  assert.equal(promptCalls, 0);
  assert.equal(getAutoApproveCount(), 1);
  assert.match(toasts[0], /Auto-approved: roam_delete_block/);
});

test("gate: off mode still prompts, and args.skip_approval is ignored", async () => {
  let promptCalls = 0;
  initToolExecution(makeGateDeps({
    mode: "off",
    promptSpy: async () => { promptCalls++; return true; },
    toastSpy: () => {},
  }));
  resetAutoApproveCount();
  clearToolApprovals(); // module-level page/tool approval maps persist across tests
  const result = await executeToolCall("roam_create_block", {
    parent_uid: "p1",
    text: "hi",
    skip_approval: true, // injection attempt — must not be honored
  });
  assert.equal(result.success, true);
  assert.equal(promptCalls, 1, "approval prompt must still be shown");
  assert.equal(getAutoApproveCount(), 0);
});

test("gate: graph mode still prompts for roam_delete_block", async () => {
  let promptCalls = 0;
  initToolExecution(makeGateDeps({
    mode: "graph",
    promptSpy: async () => { promptCalls++; return true; },
    toastSpy: () => {},
  }));
  resetAutoApproveCount();
  clearToolApprovals(); // module-level page/tool approval maps persist across tests
  await executeToolCall("roam_delete_block", { uid: "b1" });
  assert.equal(promptCalls, 1);
  assert.equal(getAutoApproveCount(), 0);
});

test("cap: 12 auto-approvals per run, the 13th prompts", async () => {
  let promptCalls = 0;
  initToolExecution(makeGateDeps({
    mode: "graph",
    promptSpy: async () => { promptCalls++; return true; },
    toastSpy: () => {},
  }));
  resetAutoApproveCount();
  clearToolApprovals(); // module-level page/tool approval maps persist across tests
  for (let i = 0; i < AUTO_APPROVE_MAX_PER_RUN; i++) {
    await executeToolCall("roam_create_block", { parent_uid: "p1", text: `note ${i}` });
  }
  assert.equal(getAutoApproveCount(), AUTO_APPROVE_MAX_PER_RUN);
  assert.equal(promptCalls, 0);
  await executeToolCall("roam_create_block", { parent_uid: "p1", text: "one too many" });
  assert.equal(promptCalls, 1, "13th mutating call must prompt regardless of mode");
  assert.equal(getAutoApproveCount(), AUTO_APPROVE_MAX_PER_RUN, "cap counter does not grow past the cap");
});

test("cap: resetAutoApproveCount starts a fresh budget", async () => {
  let promptCalls = 0;
  initToolExecution(makeGateDeps({
    mode: "graph",
    promptSpy: async () => { promptCalls++; return true; },
    toastSpy: () => {},
  }));
  resetAutoApproveCount();
  clearToolApprovals(); // module-level page/tool approval maps persist across tests
  for (let i = 0; i < AUTO_APPROVE_MAX_PER_RUN; i++) {
    await executeToolCall("roam_create_block", { parent_uid: "p1", text: `note ${i}` });
  }
  resetAutoApproveCount(); // new run starts
  assert.equal(getAutoApproveCount(), 0);
  await executeToolCall("roam_create_block", { parent_uid: "p1", text: "fresh run" });
  assert.equal(promptCalls, 0, "new run gets a fresh auto-approval budget");
  assert.equal(getAutoApproveCount(), 1);
});
