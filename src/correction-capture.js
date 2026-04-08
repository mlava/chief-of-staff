/**
 * Correction Capture — tracks COS-written blocks and detects user edits.
 *
 * When COS writes blocks to the graph (skill outputs, chat pins), a snapshot
 * of the original text is recorded. An idle-time scanner periodically compares
 * stored originals against current block text to detect user corrections.
 * Corrections are persisted to [[Chief of Staff/Corrections]].
 *
 * Initialised via initCorrectionCapture(deps). Feature is gated behind
 * the "correction-capture-enabled" setting (off by default).
 */

// ── DI container ────────────────────────────────────────────────────────────
let deps = {};

export function initCorrectionCapture(injected) {
  deps = injected || {};
  loadTrackedWrites();
}

// ── Constants ────────────────────────────────────────────────────────────────
const TRACKED_WRITES_SETTINGS_KEY = "correction-tracked-writes";
const CORRECTIONS_PAGE_TITLE = "Chief of Staff/Corrections";
const MAX_TRACKED_WRITES = 100;
const TRACKED_WRITE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const PERSIST_DEBOUNCE_MS = 5000;

export const DIFF_SCAN_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

// ── Module state ─────────────────────────────────────────────────────────────
let trackedWrites = [];
let persistTimeoutId = null;

// ── Persistence ──────────────────────────────────────────────────────────────

function loadTrackedWrites() {
  try {
    const extensionAPI = deps.getExtensionAPIRef?.();
    if (!extensionAPI) return;
    const stored = extensionAPI.settings.get(TRACKED_WRITES_SETTINGS_KEY);
    if (Array.isArray(stored)) {
      // Evict stale entries on load
      const cutoff = Date.now() - TRACKED_WRITE_MAX_AGE_MS;
      trackedWrites = stored.filter(w => w?.timestamp > cutoff).slice(0, MAX_TRACKED_WRITES);
    }
  } catch (err) {
    deps.debugLog?.("[Corrections] Failed to load tracked writes:", err?.message);
  }
}

function saveTrackedWrites() {
  if (persistTimeoutId) clearTimeout(persistTimeoutId);
  persistTimeoutId = setTimeout(() => {
    persistTimeoutId = null;
    try {
      const extensionAPI = deps.getExtensionAPIRef?.();
      if (!extensionAPI) return;
      extensionAPI.settings.set(TRACKED_WRITES_SETTINGS_KEY, trackedWrites);
    } catch (err) {
      deps.debugLog?.("[Corrections] Failed to save tracked writes:", err?.message);
    }
  }, PERSIST_DEBOUNCE_MS);
}

// ── Write Tracking ───────────────────────────────────────────────────────────

/**
 * Record a COS write for later diff detection.
 * Called fire-and-forget after writeResponseToTodayDailyPage or
 * writeStructuredResponseToTodayDailyPage completes.
 *
 * @param {object} params
 * @param {string} params.parentUid  — UID of the parent block written
 * @param {string} params.pageTitle  — daily page title (e.g. "March 30th, 2026")
 * @param {Array}  params.blocks     — [{ uid, text }] of all created blocks
 * @param {string} params.source     — "chat-pin" | "skill:Daily Briefing" | etc.
 * @param {string} [params.promptPreview] — first ~120 chars of user prompt (for Review Queue matching)
 */
export function trackCosWrite({ parentUid, pageTitle, blocks, source, promptPreview }) {
  try {
    if (!parentUid || !Array.isArray(blocks) || blocks.length === 0) return;

    const entry = {
      parentUid,
      pageTitle: pageTitle || "",
      source: source || "unknown",
      promptPreview: promptPreview ? String(promptPreview).slice(0, 120) : "",
      timestamp: Date.now(),
      blocks: blocks
        .filter(b => b?.uid && b?.text)
        .map(b => ({ uid: b.uid, text: String(b.text) }))
    };

    if (entry.blocks.length === 0) return;

    trackedWrites.push(entry);

    // Evict old entries and enforce cap
    const cutoff = Date.now() - TRACKED_WRITE_MAX_AGE_MS;
    trackedWrites = trackedWrites.filter(w => w.timestamp > cutoff);
    if (trackedWrites.length > MAX_TRACKED_WRITES) {
      trackedWrites = trackedWrites.slice(trackedWrites.length - MAX_TRACKED_WRITES);
    }

    deps.debugLog?.("[Corrections] Tracked write:", source, entry.blocks.length, "blocks");
    saveTrackedWrites();
  } catch (err) {
    deps.debugLog?.("[Corrections] trackCosWrite error (non-fatal):", err?.message);
  }
}

/**
 * Read back a block tree after a structured write to get all UIDs + text.
 * Returns flat array of { uid, text }.
 */
export function readBackBlockTree(parentUid) {
  try {
    const api = deps.getRoamAlphaApi?.();
    if (!api?.data?.pull) return [];
    const tree = api.data.pull(
      "[:block/uid :block/string {:block/children [:block/uid :block/string :block/order {:block/children [:block/uid :block/string :block/order {:block/children [:block/uid :block/string :block/order]}]}]}]",
      [":block/uid", parentUid]
    );
    if (!tree) return [];
    return flattenTree(tree);
  } catch (err) {
    deps.debugLog?.("[Corrections] readBackBlockTree error:", err?.message);
    return [];
  }
}

function flattenTree(node, results = []) {
  const uid = node?.[":block/uid"] || node?.uid || "";
  const text = node?.[":block/string"] || node?.string || "";
  if (uid && text) results.push({ uid, text });
  const children = node?.[":block/children"] || node?.children || [];
  if (Array.isArray(children)) {
    for (const child of children) flattenTree(child, results);
  }
  return results;
}

// ── Diff Scanning (Idle Task) ────────────────────────────────────────────────

/**
 * Idle task processChunk: scan tracked writes for user corrections.
 * Processes a batch of blocks per idle chunk, yielding when time runs out.
 *
 * @param {{ offset: number, corrections: Array }} state
 * @param {{ timeRemaining: () => number }} deadline
 * @returns {{ state: object, done: boolean }}
 */
export function scanForCorrections(state, deadline) {
  const corrections = state.corrections || [];
  let offset = state.offset || 0;

  // Flatten all tracked blocks into a single work list
  const allBlocks = [];
  for (const write of trackedWrites) {
    for (const block of write.blocks) {
      allBlocks.push({ ...block, source: write.source, pageTitle: write.pageTitle, promptPreview: write.promptPreview || "", writeTimestamp: write.timestamp });
    }
  }

  if (allBlocks.length === 0) {
    return { state: { offset: 0, corrections: [] }, done: true };
  }

  const api = deps.getRoamAlphaApi?.();
  if (!api?.data?.pull) {
    return { state: { offset: 0, corrections: [] }, done: true };
  }

  // Process blocks until time runs out or we finish
  while (offset < allBlocks.length && deadline.timeRemaining() > 10) {
    const block = allBlocks[offset];
    offset++;

    try {
      const current = api.data.pull("[:block/string]", [":block/uid", block.uid]);

      if (!current) {
        // Block was deleted by the user
        corrections.push({
          type: "deleted",
          uid: block.uid,
          source: block.source,
          pageTitle: block.pageTitle,
          promptPreview: block.promptPreview,
          original: block.text,
          current: null,
          detectedAt: Date.now()
        });
      } else {
        const currentText = current[":block/string"] || "";
        if (currentText !== block.text) {
          // Block was edited by the user
          corrections.push({
            type: "edited",
            uid: block.uid,
            source: block.source,
            pageTitle: block.pageTitle,
            promptPreview: block.promptPreview,
            original: block.text,
            current: currentText,
            detectedAt: Date.now()
          });
        }
        // If unchanged, no correction — skip
      }
    } catch (err) {
      deps.debugLog?.("[Corrections] Scan error for block", block.uid, err?.message);
    }
  }

  const done = offset >= allBlocks.length;

  if (done && corrections.length > 0) {
    // Persist corrections and clean up tracked writes
    persistCorrections(corrections).then(() => {
      // Cross-reference with Review Queue
      return appendCorrectionsToReviewQueue(corrections);
    }).catch(err => {
      deps.debugLog?.("[Corrections] Persist error (non-fatal):", err?.message);
    });

    // Remove corrected blocks from tracking (they've been captured)
    const correctedUids = new Set(corrections.map(c => c.uid));
    for (const write of trackedWrites) {
      write.blocks = write.blocks.filter(b => !correctedUids.has(b.uid));
    }
    // Remove empty write entries
    trackedWrites = trackedWrites.filter(w => w.blocks.length > 0);
    saveTrackedWrites();

    deps.debugLog?.("[Corrections] Scan complete:", corrections.length, "corrections found");
  } else if (done) {
    deps.debugLog?.("[Corrections] Scan complete: no corrections");
  }

  return { state: { offset: done ? 0 : offset, corrections: done ? [] : corrections }, done };
}

// ── Correction Persistence ───────────────────────────────────────────────────

async function persistCorrections(corrections) {
  if (!corrections.length) return;

  const pageUid = await deps.ensurePageUidByTitle?.(CORRECTIONS_PAGE_TITLE);
  if (!pageUid) return;

  // Group corrections by source
  const bySource = new Map();
  for (const c of corrections) {
    const key = c.source || "unknown";
    if (!bySource.has(key)) bySource.set(key, []);
    bySource.get(key).push(c);
  }

  const dateStr = deps.formatRoamDate?.(new Date()) || new Date().toISOString().slice(0, 10);

  for (const [source, corrs] of bySource) {
    const editCount = corrs.filter(c => c.type === "edited").length;
    const deleteCount = corrs.filter(c => c.type === "deleted").length;
    const parts = [];
    if (editCount > 0) parts.push(`${editCount} edit${editCount > 1 ? "s" : ""}`);
    if (deleteCount > 0) parts.push(`${deleteCount} deletion${deleteCount > 1 ? "s" : ""}`);

    // Sanitise for Roam (no [[]] or {{}} in correction text)
    const sanitise = (text) => String(text || "")
      .replace(/\[\[/g, "\u27E6").replace(/\]\]/g, "\u27E7")
      .replace(/\{\{/g, "\u2983").replace(/\}\}/g, "\u2984");

    const headerText = `[[${dateStr}]] **${sanitise(source)}** — ${parts.join(", ")}`;
    const insertOrder = deps.getFirstContentOrder ? deps.getFirstContentOrder(pageUid) : 0;
    const headerUid = await deps.createRoamBlock?.(pageUid, headerText, insertOrder);
    if (!headerUid) continue;

    for (const c of corrs) {
      const origPreview = sanitise(c.original || "").slice(0, 120);
      const currentPreview = c.current != null ? sanitise(c.current).slice(0, 120) : "(deleted)";
      const line = c.type === "deleted"
        ? `deleted ((${c.uid})): "${origPreview}"`
        : `edited ((${c.uid})): "${origPreview}" → "${currentPreview}"`;
      await deps.createRoamBlock?.(headerUid, line, "last");
    }
  }
}

// ── Dismissed Suggestion Tracking ─────────────────────────────────────────────

/**
 * Record when a user dismisses or rejects an intent classification suggestion.
 * These are lightweight entries (no block UIDs to track) — written directly
 * to [[Chief of Staff/Corrections]] as feedback signals.
 *
 * @param {object} params
 * @param {string} params.type         — "dismissed" | "rejected" | "overridden"
 * @param {string} params.originalPrompt — what the user originally typed
 * @param {string} params.classifiedIntent — what the classifier thought they meant
 * @param {string} [params.userOverride] — what the user replaced it with (if overridden)
 */
export async function trackDismissedSuggestion({ type, originalPrompt, classifiedIntent, userOverride }) {
  try {
    const extensionAPI = deps.getExtensionAPIRef?.();
    if (!extensionAPI) return;
    if (!deps.getSettingBool?.(extensionAPI, "correction-capture-enabled", false)) return;

    const pageUid = await deps.ensurePageUidByTitle?.(CORRECTIONS_PAGE_TITLE);
    if (!pageUid) return;

    const dateStr = deps.formatRoamDate?.(new Date()) || new Date().toISOString().slice(0, 10);
    const sanitise = (text) => String(text || "")
      .replace(/\[\[/g, "\u27E6").replace(/\]\]/g, "\u27E7")
      .replace(/\{\{/g, "\u2983").replace(/\}\}/g, "\u2984");

    const prompt = sanitise(String(originalPrompt || "").slice(0, 120));
    const intent = sanitise(String(classifiedIntent || "").slice(0, 120));

    let line = `[[${dateStr}]] **intent-${type}**: "${prompt}"`;
    if (classifiedIntent) line += ` — classified as: "${intent}"`;
    if (userOverride) line += ` → user said: "${sanitise(String(userOverride).slice(0, 120))}"`;

    const insertOrder = deps.getFirstContentOrder ? deps.getFirstContentOrder(pageUid) : 0;
    await deps.createRoamBlock?.(pageUid, line, insertOrder);
    deps.debugLog?.("[Corrections] Tracked dismissed suggestion:", type);
  } catch (err) {
    deps.debugLog?.("[Corrections] trackDismissedSuggestion error (non-fatal):", err?.message);
  }
}

// ── Eval Integration ─────────────────────────────────────────────────────────

const REVIEW_QUEUE_PAGE_TITLE = "Chief of Staff/Review Queue";

/**
 * After corrections are found, append a summary to the most recent Review Queue
 * entry for the same date. This cross-references user corrections with eval scores.
 */
async function appendCorrectionsToReviewQueue(corrections) {
  try {
    if (!corrections.length) return;
    const api = deps.getRoamAlphaApi?.();
    if (!api?.data?.q) return;

    // Check if Review Queue page exists — don't create it just for corrections
    const rqPageUid = api.data.q(
      '[:find ?uid . :where [?p :node/title "Chief of Staff/Review Queue"] [?p :block/uid ?uid]]'
    );
    if (!rqPageUid) return;

    // Collect unique prompt previews from corrections to match against Review Queue entries
    const promptPreviews = [...new Set(corrections.map(c => c.promptPreview).filter(Boolean))];
    if (promptPreviews.length === 0) return;

    // Find Review Queue entries whose Prompt: child block matches any correction prompt
    // Review Queue entries have child blocks like: Prompt: "run daily briefing"
    const allEntries = api.data.q(
      `[:find ?parentUid ?childStr :where
        [?p :node/title "Chief of Staff/Review Queue"]
        [?p :block/children ?b]
        [?b :block/uid ?parentUid]
        [?b :block/children ?c]
        [?c :block/string ?childStr]
        [(clojure.string/starts-with? ?childStr "Prompt:")]]`
    );
    if (!allEntries || allEntries.length === 0) return;

    // Match: find entries where the prompt text overlaps with a correction's promptPreview
    for (const [entryUid, promptLine] of allEntries) {
      const promptText = String(promptLine || "").replace(/^Prompt:\s*"?/, "").replace(/"?\s*$/, "").toLowerCase();
      if (!promptText) continue;

      const matched = promptPreviews.some(pp => {
        const ppLower = pp.toLowerCase();
        return promptText.includes(ppLower) || ppLower.includes(promptText);
      });
      if (!matched) continue;

      // Found a matching Review Queue entry — append correction summary
      const matchedCorrections = corrections.filter(c => c.promptPreview && promptPreviews.includes(c.promptPreview));
      const editCount = matchedCorrections.filter(c => c.type === "edited").length;
      const deleteCount = matchedCorrections.filter(c => c.type === "deleted").length;
      const parts = [];
      if (editCount > 0) parts.push(`${editCount} edit${editCount > 1 ? "s" : ""}`);
      if (deleteCount > 0) parts.push(`${deleteCount} deletion${deleteCount > 1 ? "s" : ""}`);
      if (parts.length === 0) continue;

      const sources = [...new Set(matchedCorrections.map(c => c.source || "unknown"))].join(", ");
      const correctionLine = `Corrections: ${parts.join(", ")} (${sources})`;

      await deps.createRoamBlock?.(entryUid, correctionLine, "last");
      deps.debugLog?.("[Corrections] Appended correction summary to Review Queue entry:", entryUid);
      break; // Only append to the first matching entry
    }
  } catch (err) {
    deps.debugLog?.("[Corrections] appendCorrectionsToReviewQueue error (non-fatal):", err?.message);
  }
}

// ── Accessors (for testing/debugging) ────────────────────────────────────────

export function getTrackedWrites() { return trackedWrites; }
export function clearTrackedWrites() {
  trackedWrites = [];
  saveTrackedWrites();
}
