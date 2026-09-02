/**
 * mutation-ledger.js — COS-scoped undo ledger (roadmap #131).
 *
 * Records every reversible mutation Chief of Staff makes during a
 * user-initiated run (blocks created, blocks updated with before-images) so
 * `/undo` can reverse the whole batch — without touching the user's own
 * edits, which belong to Roam's native undo (Ctrl/Cmd+Z).
 *
 * Design (docs/PLAN-131-undo.md):
 *   - Single slot, in-memory, session-scoped: the batch from the most recent
 *     run that recorded at least one mutation. A new run's first recorded
 *     mutation replaces the previous batch; read-only runs (including /undo
 *     itself) never clobber it.
 *   - Lazy batch open: setLedgerRunContext() marks a new run context but the
 *     batch is only opened when the first mutation is actually recorded.
 *   - Drift detection: each entry stores an after-image; at undo time, blocks
 *     whose current text no longer matches are skipped and reported, never
 *     destroyed.
 *   - v1 reverses creates and updates only. Deletes/moves and non-Roam
 *     mutations (Composio, MCP, extension tools) are recorded as
 *     non-reversible actions so the summary and report stay honest.
 *
 * DI via initMutationLedger(deps): { getRoamAlphaApi, debugLog,
 * withRoamWriteRetry }. Recording functions are try/catch-wrapped — a ledger
 * failure must never fail the tool call it observes.
 */

let deps = {};

export function initMutationLedger(injectedDeps) {
  deps = injectedDeps;
}

// ── State ────────────────────────────────────────────────────────────────────

let contextCounter = 0;
let activeContext = null;   // { id, prompt } | null — current run, set per user-initiated run
let currentBatch = null;    // see openBatchIfNeeded() for shape
let batchIdCounter = 0;

// Tools whose successful results feed the ledger as CREATES.
const CREATE_TOOLS = new Set([
  "roam_create_block", "roam_create_blocks", "roam_batch_write",
  "roam_create_page", "roam_create_todo", "cos_schedule_block",
]);

// Tools recorded as UPDATES (before-image captured pre-execution, keyed on args.uid).
export const UPDATE_TOOLS = new Set([
  "roam_update_block", "roam_modify_todo", "roam_link_mention",
]);

// Roam mutations v1 declines to reverse (subtree/position restoration is hard).
const DECLINED_TOOLS = new Set(["roam_delete_block", "roam_move_block"]);

// Fields captured for before-images. :block/props is read-merge-written by
// roam_update_block, so capturing it keeps prop patches reversible too.
const BEFORE_IMAGE_PULL = "[:block/string :block/heading :block/open :block/text-align :block/children-view-type :block/props]";

// Map of uid → before-image captured just before an update executes. Entries
// are promoted into the batch when the update succeeds, and dropped when a
// new context opens (a failed update never promotes its capture).
let pendingBeforeImages = new Map();

// ── Roam access helpers ──────────────────────────────────────────────────────

function pullBlock(uid) {
  const api = deps.getRoamAlphaApi?.();
  if (!api) return null;
  try {
    return api.pull?.(BEFORE_IMAGE_PULL, [":block/uid", uid])
      ?? api.data?.pull?.(BEFORE_IMAGE_PULL, [":block/uid", uid])
      ?? null;
  } catch (err) {
    deps.debugLog?.("[Undo ledger] pull failed for", uid, err?.message);
    return null;
  }
}

function currentBlockString(uid) {
  const data = pullBlock(uid);
  if (!data) return null;
  const str = data[":block/string"];
  return typeof str === "string" ? str : null;
}

// ── Run context ──────────────────────────────────────────────────────────────

/**
 * Mark the start of a user-initiated run. Cheap; does NOT clear the previous
 * batch — that only happens when this run records its first mutation, so
 * read-only runs never cost the user their undoable batch.
 */
export function setLedgerRunContext(prompt) {
  contextCounter += 1;
  activeContext = { id: contextCounter, prompt: String(prompt || "").slice(0, 200) };
  pendingBeforeImages = new Map();
  deps.debugLog?.("[Undo ledger] Run context set:", activeContext.id);
}

function openBatchIfNeeded() {
  if (!activeContext) return null; // cron/inbox/background runs: ledger inactive
  if (currentBatch && currentBatch.contextId === activeContext.id) return currentBatch;
  batchIdCounter += 1;
  currentBatch = {
    id: batchIdCounter,
    contextId: activeContext.id,
    prompt: activeContext.prompt,
    startedAt: Date.now(),
    creates: [],   // { uid, afterString, toolName, isPage, pageTitle? } in creation order
    updates: [],   // { uid, before: {...}, touched: [...], afterString, toolName }
    declined: [],  // { toolName, summary } — deletes/moves (recorded, not reversed)
    others: [],    // { label } — non-Roam mutations (Composio/MCP/extension)
  };
  deps.debugLog?.("[Undo ledger] Opened batch", currentBatch.id, "for:", currentBatch.prompt);
  return currentBatch;
}

// ── Recording ────────────────────────────────────────────────────────────────

/**
 * Capture a before-image ahead of an update-type tool executing. Fire-and-
 * forget safe: failures log and disable reversal for that entry only.
 */
export function captureBeforeImage(toolName, args) {
  try {
    if (!activeContext || !UPDATE_TOOLS.has(toolName)) return;
    const uid = String(args?.uid || "").trim();
    if (!uid) return;
    const data = pullBlock(uid);
    if (!data || typeof data[":block/string"] !== "string") return;
    pendingBeforeImages.set(uid, {
      string: data[":block/string"],
      heading: data[":block/heading"],
      open: data[":block/open"],
      textAlign: data[":block/text-align"],
      childrenViewType: data[":block/children-view-type"],
      props: data[":block/props"],
    });
  } catch (err) {
    deps.debugLog?.("[Undo ledger] captureBeforeImage error (non-fatal):", err?.message);
  }
}

function extractCreatedUids(toolName, args, result) {
  switch (toolName) {
    case "roam_create_block":
    case "roam_create_todo":
      return result?.uid ? [result.uid] : [];
    case "roam_create_blocks":
      return (result?.results || []).flatMap((r) => r?.created_uids || []);
    case "roam_batch_write":
    case "roam_create_page":
      return Array.isArray(result?.uids) ? result.uids : [];
    case "cos_schedule_block": {
      // Parent first so reverse-order deletion removes it last (after the
      // slot). A reschedule updates an existing slot in place — not a create.
      const uids = [];
      if (result?.created_parent && result?.parent_uid) uids.push(result.parent_uid);
      if (result?.created_todo && result?.task_uid) uids.push(result.task_uid);
      if (result?.rescheduled !== true && result?.slot_uid) uids.push(result.slot_uid);
      return uids;
    }
    default:
      return [];
  }
}

// Which update fields did this call actually touch? Reversal restores only
// these, so untouched fields are never clobbered with defaults.
function touchedUpdateFields(toolName, args) {
  if (toolName !== "roam_update_block") return ["string"]; // modify_todo / link_mention rewrite text
  const touched = [];
  if (args?.text !== undefined) touched.push("string");
  if (args?.heading !== undefined) touched.push("heading");
  if (args?.["children-view-type"] !== undefined) touched.push("childrenViewType");
  if (args?.["text-align"] !== undefined) touched.push("textAlign");
  if (args?.open !== undefined) touched.push("open");
  if (args?.props !== undefined) touched.push("props");
  return touched;
}

function isSuccessfulResult(result) {
  if (!result || typeof result !== "object") return false;
  if (result.error) return false;
  if (result.success === false) return false;
  if (result.dry_run) return false;
  return true;
}

/**
 * Record the outcome of a successful mutating tool call. Called from the
 * executeToolCall hook (and the router's fast-path write site) AFTER the tool
 * resolves. No-ops outside an active run context or on failed results.
 * Mutating tools outside the extraction map (COS tools, direct MCP tools,
 * extension tools) are recorded as non-reversible actions when the caller
 * passes { isMutating: true }.
 */
export function recordToolOutcome(toolName, args, result, { isMutating = false } = {}) {
  try {
    if (!activeContext || !isSuccessfulResult(result)) return;

    if (CREATE_TOOLS.has(toolName)) {
      const uids = extractCreatedUids(toolName, args, result).filter(Boolean);
      const isNewPage = toolName === "roam_create_page" && result.created === true && result.page_uid;
      if (!uids.length && !isNewPage) return;
      const batch = openBatchIfNeeded();
      if (!batch) return;
      // A page freshly created by roam_create_page is itself reversible.
      // Recorded BEFORE its child blocks: reversal iterates in reverse, so the
      // page is reached only after its children have been deleted.
      if (isNewPage) {
        batch.creates.push({
          uid: result.page_uid,
          afterString: null,
          toolName,
          isPage: true,
          pageTitle: result.title || "",
        });
      }
      for (const uid of uids) {
        batch.creates.push({
          uid,
          afterString: currentBlockString(uid),
          toolName,
          isPage: false,
        });
      }
      deps.debugLog?.("[Undo ledger] Recorded", uids.length, "create(s) from", toolName);
      return;
    }

    if (UPDATE_TOOLS.has(toolName)) {
      const uid = String(args?.uid || "").trim();
      if (!uid) return;
      const before = pendingBeforeImages.get(uid);
      pendingBeforeImages.delete(uid);
      if (!before) return; // capture failed — can't restore, don't pretend we can
      const batch = openBatchIfNeeded();
      if (!batch) return;
      batch.updates.push({
        uid,
        before,
        touched: touchedUpdateFields(toolName, args),
        afterString: currentBlockString(uid),
        toolName,
      });
      deps.debugLog?.("[Undo ledger] Recorded update to", uid, "from", toolName);
      return;
    }

    if (DECLINED_TOOLS.has(toolName)) {
      const batch = openBatchIfNeeded();
      if (!batch) return;
      const target = String(args?.uid || "").trim();
      batch.declined.push({
        toolName,
        summary: toolName === "roam_delete_block"
          ? `deleted block ${target}`
          : `moved block ${target}`,
      });
      return;
    }

    // Mutating tool outside the extraction map — name it so the undo summary
    // and report stay honest about what a reversal will NOT cover.
    if (isMutating && toolName !== "roam_undo") {
      recordOtherAction(String(toolName || "unknown tool"));
    }
  } catch (err) {
    deps.debugLog?.("[Undo ledger] recordToolOutcome error (non-fatal):", err?.message);
  }
}

/**
 * Record a successful non-Roam mutation (Composio, local/remote MCP,
 * extension tools) so the undo summary can name what it cannot reverse.
 */
export function recordOtherAction(label) {
  try {
    if (!activeContext) return;
    const batch = openBatchIfNeeded();
    if (!batch) return;
    const clean = String(label || "external action").slice(0, 120);
    if (!batch.others.some((o) => o.label === clean)) batch.others.push({ label: clean });
  } catch (err) {
    deps.debugLog?.("[Undo ledger] recordOtherAction error (non-fatal):", err?.message);
  }
}

// ── Reading ──────────────────────────────────────────────────────────────────

/** The current undoable batch (any recorded entries), or null. */
export function getUndoableBatch() {
  if (!currentBatch) return null;
  const { creates, updates, declined, others } = currentBatch;
  if (!creates.length && !updates.length && !declined.length && !others.length) return null;
  return currentBatch;
}

/** True when the batch has at least one entry /undo can actually reverse. */
export function batchHasReversibleEntries(batch) {
  return Boolean(batch && (batch.creates.length || batch.updates.length));
}

/** Markdown summary of what /undo will (and won't) reverse, for the confirm step. */
export function buildUndoSummary(batch) {
  if (!batch) return "";
  const lines = [`I can reverse my changes from: **"${batch.prompt}"**`, ""];
  const pageCreates = batch.creates.filter((c) => c.isPage);
  const blockCreates = batch.creates.filter((c) => !c.isPage);
  if (blockCreates.length) {
    lines.push(`- **Delete ${blockCreates.length} block${blockCreates.length === 1 ? "" : "s"} I created**`);
  }
  for (const p of pageCreates) {
    lines.push(`- **Delete the page [[${p.pageTitle}]] I created** (only if nothing else was added to it)`);
  }
  if (batch.updates.length) {
    lines.push(`- **Restore ${batch.updates.length} block${batch.updates.length === 1 ? "" : "s"} I edited** to their previous content`);
  }
  if (batch.declined.length) {
    lines.push("");
    lines.push("I can't safely auto-reverse these (please check them manually):");
    for (const d of batch.declined) lines.push(`- ${d.summary} (\`${d.toolName}\`)`);
  }
  if (batch.others.length) {
    lines.push("");
    lines.push("These actions from that run can't be reversed from here:");
    for (const o of batch.others) lines.push(`- ${o.label}`);
  }
  lines.push("");
  lines.push("Blocks you've edited since will be left alone. Your own edits are never touched — use Roam's native undo (Ctrl/Cmd+Z) for those.");
  return lines.join("\n");
}

// ── Reversal ─────────────────────────────────────────────────────────────────

async function safeWrite(fn) {
  if (typeof deps.withRoamWriteRetry === "function") return deps.withRoamWriteRetry(fn);
  return fn();
}

/**
 * Reverse the current batch: restore updated blocks to their before-images,
 * then delete created blocks in reverse creation order. Collects per-entry
 * results instead of throwing, so a partial reversal reports honestly.
 * Clears the batch on completion (no double-undo).
 */
export async function executeUndo() {
  const batch = getUndoableBatch();
  if (!batch) return null;
  const api = deps.getRoamAlphaApi?.();
  const report = {
    restored: 0, deleted: 0, pagesDeleted: 0,
    skippedDrift: [], skippedMissing: [], pagesKept: [], failed: [],
    declined: batch.declined.map((d) => d.summary),
    others: batch.others.map((o) => o.label),
  };

  // 1. Restore updates (before-images), skipping drifted or missing blocks.
  for (const entry of batch.updates) {
    try {
      const current = currentBlockString(entry.uid);
      if (current == null) { report.skippedMissing.push(entry.uid); continue; }
      if (typeof entry.afterString === "string" && current !== entry.afterString) {
        report.skippedDrift.push(entry.uid);
        continue;
      }
      const block = { uid: entry.uid };
      const touched = new Set(entry.touched);
      if (touched.has("string")) block.string = entry.before.string;
      if (touched.has("heading")) block.heading = entry.before.heading ?? 0;
      if (touched.has("open")) block.open = entry.before.open ?? true;
      if (touched.has("textAlign")) block["text-align"] = entry.before.textAlign ?? "left";
      if (touched.has("childrenViewType")) block["children-view-type"] = entry.before.childrenViewType ?? "bullet";
      if (touched.has("props")) block.props = entry.before.props ?? {};
      await safeWrite(() => api.updateBlock({ block }));
      report.restored += 1;
    } catch (err) {
      report.failed.push(`${entry.uid}: ${err?.message || "restore failed"}`);
    }
  }

  // 2. Delete creates in reverse creation order (children before parents;
  //    a page entry, recorded last, is reached only after its child blocks).
  for (let i = batch.creates.length - 1; i >= 0; i -= 1) {
    const entry = batch.creates[i];
    try {
      if (entry.isPage) {
        // Delete the page only when it's empty — anything left means content
        // arrived after our run (or a drifted block we skipped): keep it.
        const data = pullBlock(entry.uid);
        if (!data) { report.skippedMissing.push(entry.uid); continue; }
        const remaining = api.pull?.("[{:block/children [:block/uid]}]", [":block/uid", entry.uid])
          ?? api.data?.pull?.("[{:block/children [:block/uid]}]", [":block/uid", entry.uid]);
        const childCount = remaining?.[":block/children"]?.length || 0;
        if (childCount > 0) { report.pagesKept.push(entry.pageTitle || entry.uid); continue; }
        await safeWrite(() => api.deletePage
          ? api.deletePage({ page: { uid: entry.uid } })
          : api.data.page.delete({ page: { uid: entry.uid } }));
        report.pagesDeleted += 1;
        continue;
      }
      const current = currentBlockString(entry.uid);
      if (current == null) { report.skippedMissing.push(entry.uid); continue; }
      if (typeof entry.afterString === "string" && current !== entry.afterString) {
        report.skippedDrift.push(entry.uid);
        continue;
      }
      await safeWrite(() => api.deleteBlock({ block: { uid: entry.uid } }));
      report.deleted += 1;
    } catch (err) {
      report.failed.push(`${entry.uid}: ${err?.message || "delete failed"}`);
    }
  }

  currentBatch = null;
  deps.debugLog?.("[Undo ledger] Undo executed:", report);
  return report;
}

/** Markdown report of an executeUndo() run, for the chat panel. */
export function buildUndoReport(report) {
  if (!report) return "Nothing to undo.";
  const lines = [];
  const done = [];
  if (report.deleted) done.push(`deleted ${report.deleted} created block${report.deleted === 1 ? "" : "s"}`);
  if (report.pagesDeleted) done.push(`deleted ${report.pagesDeleted} created page${report.pagesDeleted === 1 ? "" : "s"}`);
  if (report.restored) done.push(`restored ${report.restored} edited block${report.restored === 1 ? "" : "s"}`);
  lines.push(done.length ? `Undone — ${done.join(", ")}.` : "Nothing was reversed.");
  if (report.skippedDrift.length) {
    lines.push(`Left alone (edited since I wrote them): ${report.skippedDrift.length} block${report.skippedDrift.length === 1 ? "" : "s"}.`);
  }
  if (report.pagesKept.length) {
    lines.push(`Kept (contains other content): ${report.pagesKept.map((t) => `[[${t}]]`).join(", ")}.`);
  }
  if (report.declined.length) {
    lines.push(`Not auto-reversed (please check manually): ${report.declined.join("; ")}.`);
  }
  if (report.others.length) {
    lines.push(`Not reversed (outside /undo's reach): ${report.others.join("; ")}.`);
  }
  if (report.failed.length) {
    lines.push(`Failed: ${report.failed.join("; ")}.`);
  }
  return lines.join("\n\n");
}

/** Clear all ledger state (unload / tests). */
export function clearLedger() {
  activeContext = null;
  currentBatch = null;
  pendingBeforeImages = new Map();
}
