/**
 * inbox.js — Inbox-as-input-channel for Chief of Staff
 *
 * Pull watch on Chief of Staff/Inbox page, detecting new blocks via delta
 * diffing and full scan fallback. Sequential processing queue with backpressure.
 * Items processed via askChiefOfStaff() in read-only mode, then moved to today's
 * Daily Notes Page.
 *
 * DI initialised via initInbox(injected) — called from onload().
 */

// ── Constants ──────────────────────────────────────────────────────────

const INBOX_MAX_ITEMS_PER_SCAN = 8;   // Prevent large inbox bursts from flooding the queue
const INBOX_MAX_PENDING_ITEMS = 40;   // Hard cap on queued+in-flight inbox items
const INBOX_FULL_SCAN_COOLDOWN_MS = 60_000; // Avoid repeated idle full scans

// Safety caps for inbox block tree writes — mirror the limits in index.js's
// shared write helpers so inbox doesn't bypass the extension's own safety layer.
const INBOX_BLOCK_TREE_MAX_DEPTH = 30;
const INBOX_BLOCK_TREE_MAX_BLOCKS = 50;
const INBOX_MAX_BLOCK_CHARS = 20_000;

// ── Module state ───────────────────────────────────────────────────────

const inboxProcessingSet = new Set();  // block UIDs currently being processed
let inboxProcessingQueue = Promise.resolve(); // sequential processing chain
const inboxQueuedSet = new Set();      // block UIDs already queued to prevent duplicate growth
let inboxPendingQueueCount = 0;        // queued + in-flight inbox items
let inboxCatchupScanTimeoutId = null;  // deferred full scan once queue drains
let inboxLastFullScanAt = 0;           // timestamp of last full q-based inbox scan
let inboxLastFullScanUidSignature = ""; // signature of top-level inbox UIDs at last full scan
let inboxStaticUIDs = null;            // lazily populated — instruction block UIDs to skip

// ── Dependency injection ───────────────────────────────────────────────

let deps = {};

/**
 * Inject external dependencies from index.js onload().
 *
 * Required deps:
 *   getRoamAlphaApi, escapeForDatalog, debugLog, showInfoToast,
 *   invalidateMemoryPromptCache, askChiefOfStaff, clearConversationContext,
 *   isUnloadInProgress   (getter fn, not raw boolean)
 */
export function initInbox(injected) {
  deps = injected || {};
}

// ── Pure / testable helpers ────────────────────────────────────────────

export function collectInboxBlockMap(node) {
  // Walk top-level children of a pullWatch tree → Map<uid, string>
  const map = new Map();
  if (!node) return map;
  const children = node[":block/children"] || [];
  for (const child of children) {
    const uid = child[":block/uid"];
    const str = child[":block/string"] ?? "";
    if (uid) map.set(uid, str);
  }
  return map;
}

export function getInboxProcessingTierSuffix(promptText) {
  const text = String(promptText || "");
  const lower = text.toLowerCase();
  const lines = text.split(/\n/).length;

  // Escalate to power for complex, synthesis-heavy requests.
  // Keep default at /mini to reduce cost/latency for simple inbox captures.
  const complexitySignals = [
    /\bweekly review\b/,
    /\bweekly planning\b/,
    /\bend[- ]of[- ]day\b/,
    /\bretrospective\b/,
    /\bdaily briefing\b/,
    /\bcatch me up\b/,
    /\bresume context\b/,
    /\bdeep research\b/,
    /\bmulti[- ]step\b/,
    /\btriage\b/
  ];
  const looksComplex =
    text.length > 700 ||
    lines > 10 ||
    complexitySignals.some((re) => re.test(lower));

  // Inbox runs in read-only mode — ludicrous is overkill. Power handles complex
  // synthesis; mini handles simple captures and short queries.
  return looksComplex ? "/power" : "/mini";
}

// ── State accessors (for pull watch callback & lifecycle) ──────────────

export function getInboxStaticUIDs() {
  if (inboxStaticUIDs) return inboxStaticUIDs;
  // Snapshot current Inbox children as "static" instruction blocks to skip
  const api = deps.getRoamAlphaApi?.();
  const rows = api?.data?.q?.(
    '[:find ?uid :where [?p :node/title "Chief of Staff/Inbox"] [?p :block/children ?b] [?b :block/uid ?uid]]'
  ) || [];
  inboxStaticUIDs = new Set(rows.map(r => r[0]).filter(Boolean));

  deps.debugLog?.("[Chief flow] Inbox static UIDs:", inboxStaticUIDs.size);
  return inboxStaticUIDs;
}

export function resetInboxStaticUIDs() {
  inboxStaticUIDs = null;
}

export function primeInboxStaticUIDs() {
  // Initialise static UID snapshot as early as possible on load, so user-added
  // items right after reload are not accidentally captured as static.
  try {
    if (inboxStaticUIDs) return;
    getInboxStaticUIDs();
  } catch (e) {
    console.warn("[Chief of Staff] Failed to prime inbox static UIDs:", e?.message || e);
  }
}

export function setInboxStaticUIDs(uidSet) {
  inboxStaticUIDs = uidSet;
}

export function getInboxBlockStringIfExists(uid) {
  const safeUid = String(uid || "").trim();
  if (!safeUid) return null;
  const api = deps.getRoamAlphaApi ? deps.getRoamAlphaApi() : (typeof window !== "undefined" ? window.roamAlphaAPI : null);
  const data = api?.data?.pull?.("[:block/string :node/title]", [":block/uid", safeUid]);
  if (!data || data[":node/title"]) return null;
  if (typeof data[":block/string"] !== "string") return null;
  return data[":block/string"];
}

export function clearInboxCatchupScanTimer() {
  if (!inboxCatchupScanTimeoutId) return;
  clearTimeout(inboxCatchupScanTimeoutId);
  inboxCatchupScanTimeoutId = null;
}

export function getInboxProxySignature(childCount) {
  const queuedSig = [...inboxQueuedSet].sort().join("|");
  const processingSig = [...inboxProcessingSet].sort().join("|");
  return `${childCount}::${queuedSig}::${processingSig}`;
}

export function shouldRunInboxFullScanFallback(afterMapSize) {
  const now = Date.now();
  if ((now - inboxLastFullScanAt) < INBOX_FULL_SCAN_COOLDOWN_MS) return false;
  if (!Number.isFinite(afterMapSize) || afterMapSize < 0) return true;

  // Fast signature proxy: top-level UID count + known queued/in-flight UIDs.
  // If this hasn't changed, a full scan is unlikely to find new candidates.
  return getInboxProxySignature(afterMapSize) !== inboxLastFullScanUidSignature;
}

export function getInboxCandidateBlocksFromChildrenRows(inboxChildren) {
  const staticUIDs = getInboxStaticUIDs();
  const newBlocks = [];
  for (const child of inboxChildren) {
    const uid = child[":block/uid"];
    const str = (child[":block/string"] || "").trim();
    if (!uid || !str) continue;        // skip empty / cursor blocks
    if (staticUIDs.has(uid)) continue;  // skip instruction blocks
    if (inboxProcessingSet.has(uid)) continue; // already in flight
    if (inboxQueuedSet.has(uid)) continue;     // already queued
    newBlocks.push({ uid, string: str });
  }
  return newBlocks;
}

export function enqueueInboxCandidates(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return 0;
  deps.invalidateMemoryPromptCache?.();
  const before = inboxPendingQueueCount;
  enqueueInboxItems(blocks);
  return Math.max(0, inboxPendingQueueCount - before);
}

// ── Full scan & scheduling ─────────────────────────────────────────────

export function runFullInboxScan(reason = "watch") {
  const inboxApi = deps.getRoamAlphaApi?.();
  const escapeForDatalog = deps.escapeForDatalog;
  const inboxChildren = (inboxApi?.data?.q?.(
    '[:find ?uid ?str :where [?p :node/title "Chief of Staff/Inbox"] [?p :block/children ?b] [?b :block/uid ?uid] [?b :block/string ?str]]'
  ) || []).map(([uid, str]) => ({ ":block/uid": uid, ":block/string": str }));
  inboxLastFullScanAt = Date.now();
  const staticUIDs = getInboxStaticUIDs();
  deps.debugLog?.("[Chief flow] Inbox pull result:", inboxChildren.length, "children, static:", staticUIDs.size, "processing:", inboxProcessingSet.size, "reason:", reason);

  const newBlocks = getInboxCandidateBlocksFromChildrenRows(inboxChildren);
  if (newBlocks.length > 0) {
    const bounded = newBlocks.slice(0, INBOX_MAX_ITEMS_PER_SCAN);
    deps.debugLog?.("[Chief flow] Inbox: detected", newBlocks.length, "new block(s), enqueueing", bounded.length, ":", bounded.map(b => b.string.slice(0, 60)), "reason:", reason);
    enqueueInboxCandidates(bounded);
  }
  // Store signature AFTER enqueuing so it reflects the post-enqueue state of
  // inboxQueuedSet/inboxProcessingSet. Otherwise the next shouldRunInboxFullScanFallback
  // check would see a different signature and allow a redundant scan.
  inboxLastFullScanUidSignature = getInboxProxySignature(inboxChildren.length);
  return newBlocks.length;
}

export function scheduleInboxCatchupScan(delayMs = 1200) {
  if (deps.isUnloadInProgress?.() || inboxCatchupScanTimeoutId) return;
  inboxCatchupScanTimeoutId = setTimeout(() => {
    inboxCatchupScanTimeoutId = null;
    if (deps.isUnloadInProgress?.()) return;
    if (inboxPendingQueueCount > 0) return;
    try {
      runFullInboxScan("catchup");
    } catch (e) {
      console.warn("[Chief of Staff] Inbox catchup scan failed:", e?.message || e);
    }
  }, delayMs);
}

// ── Item processing ────────────────────────────────────────────────────

async function processInboxItem(block) {
  if (deps.isUnloadInProgress?.()) return;
  if (!block?.uid || !block?.string?.trim()) return;
  if (inboxProcessingSet.has(block.uid)) return;

  // Each inbox item is independent — clear conversation context to prevent
  // cross-contamination between unrelated inbox items and subsequent user chats.
  deps.clearConversationContext?.();

  inboxProcessingSet.add(block.uid);
  try {
    const liveString = getInboxBlockStringIfExists(block.uid);
    if (liveString === null) {
      deps.debugLog?.("[Chief flow] Inbox skip — block no longer exists:", block.uid);
      return;
    }
    const promptText = String(liveString || "").trim();
    if (!promptText) {
      deps.debugLog?.("[Chief flow] Inbox skip — block empty at processing time:", block.uid);
      return;
    }

    deps.debugLog?.("[Chief flow] Inbox processing:", block.uid, JSON.stringify(promptText.slice(0, 120)));
    deps.showInfoToast?.("Inbox", `Processing: ${promptText.slice(0, 80)}`);

    // Run the agent loop with the block text as the prompt
    const tierSuffix = getInboxProcessingTierSuffix(promptText);
    deps.debugLog?.("[Chief flow] Inbox tier selected:", tierSuffix, "for", block.uid);
    const result = await deps.askChiefOfStaff?.(`${promptText} ${tierSuffix}`, {
      offerWriteToDailyPage: false,
      suppressToasts: true,
      readOnlyTools: true
    });

    // Reset prompt sections so subsequent user chat doesn't inherit inbox context
    deps.resetLastPromptSections?.();

    // Concurrency guard rejection — askChiefOfStaff returns undefined when
    // another request is in flight. Do NOT move the block; leave it in the inbox
    // so it will be retried on the next scan.
    if (result === undefined || result === null) {
      deps.debugLog?.("[Chief flow] Inbox skip — concurrency guard rejected, will retry:", block.uid);
      return;
    }
    const responseText = String(result?.text || result || "").trim()
      .replace(/\[Key reference:[^\]]*\]\s*/g, "")
      .replace(/\s*\(uid:[^)]*\)/g, "")
      .trim() || "Processed (no text response).";

    // Block may have been deleted while the model was running; skip move quietly.
    if (getInboxBlockStringIfExists(block.uid) === null) {
      deps.debugLog?.("[Chief flow] Inbox skip move — block deleted during processing:", block.uid);
      return;
    }

    // Guard against post-unload writes — if the extension was torn down while
    // askChiefOfStaff was running, skip the graph mutation.
    if (deps.isUnloadInProgress?.()) {
      deps.debugLog?.("[Chief flow] Inbox skip move — extension unloaded during processing:", block.uid);
      return;
    }
    // Move block to today's DNP under "Processed Chief of Staff items"
    await moveInboxBlockToDNP(block.uid, responseText);
    deps.debugLog?.("[Chief flow] Inbox processed and moved:", block.uid);
    deps.showInfoToast?.("Inbox", `Done: ${promptText.slice(0, 60)}`);
  } catch (e) {
    console.warn("[Chief of Staff] Inbox processing failed for", block.uid, e?.message || e);
    const msg = String(e?.message || "").toLowerCase();
    const likelyMissing = msg.includes("not found") || msg.includes("cannot move") || msg.includes("missing");
    if (!likelyMissing) {
      deps.showInfoToast?.("Inbox error", `Failed to process: ${String(block.string || "").slice(0, 60)}`);
    } else {
      deps.debugLog?.("[Chief flow] Inbox skip toast — likely deleted block:", block.uid, e?.message || e);
    }
  } finally {
    inboxProcessingSet.delete(block.uid);
  }
}

/**
 * Parse a markdown string into a tree of block nodes.
 * Returns an array of { text, heading?, children[] }.
 *
 * Recognised patterns (checked in priority order):
 *   ### Heading   → heading:3, depth 1
 *   ## Heading    → heading:2, depth 0
 *   # Heading     → heading:1, depth 0
 *   - / * / 1.   → plain block, depth driven by leading spaces
 *   plain text    → plain block, depth 0
 */
export function parseMarkdownToBlocks(text) {
  const lines = String(text || "").split("\n");
  const root = { children: [] };
  // Stack entries: { node, depth }  (root is depth -1)
  const stack = [{ node: root, depth: -1 }];
  // Tracks the depth of the most recently seen heading so that plain text
  // and list items are placed one level under it rather than at a fixed depth.
  let currentHeadingDepth = -1;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;

    let blockText = "";
    let heading = null;
    let depth = 0;

    // Detect heading levels — most specific first to avoid partial matches
    const h3 = line.match(/^###(?!#)\s+(.+)/);
    const h2 = !h3 && line.match(/^##(?!#)\s+(.+)/);
    const h1 = !h3 && !h2 && line.match(/^#(?!#)\s+(.+)/);
    // List items: capture leading whitespace, marker, and content
    const listItem = !h3 && !h2 && !h1 && line.match(/^(\s*)([-*]|\d+\.)\s+(.+)/);
    // Bold-only lines (entire line is **bold** or __bold__) — LLMs often use
    // these as section headings instead of ##. Treat as implicit sub-headings.
    const boldOnly = !h3 && !h2 && !h1 && !listItem &&
      line.match(/^\*\*(.+)\*\*$|^__(.+)__$/);

    if (h3) {
      blockText = h3[1]; heading = 3; depth = 1;
      currentHeadingDepth = 1;
    } else if (h2) {
      blockText = h2[1]; heading = 2; depth = 0;
      currentHeadingDepth = 0;
    } else if (h1) {
      blockText = h1[1]; heading = 1; depth = 0;
      currentHeadingDepth = 0;
    } else if (boldOnly) {
      // Strip the bold markers and treat as an implicit heading at the next
      // level under the current heading context. Update currentHeadingDepth
      // so subsequent plain text and list items nest beneath it.
      blockText = (boldOnly[1] || boldOnly[2]).trim();
      depth = currentHeadingDepth + 1;
      currentHeadingDepth = depth;
    } else if (listItem) {
      const spaces = listItem[1].length;
      blockText = listItem[3];
      // Place list items one level under the current heading, plus indent
      depth = (currentHeadingDepth + 1) + Math.floor(spaces / 2);
    } else {
      blockText = line.trim();
      // Plain text sits one level under the current heading context
      depth = currentHeadingDepth + 1;
    }

    if (!blockText.trim()) continue;

    // Pop the stack until the top is a valid parent for this depth
    while (stack.length > 1 && stack[stack.length - 1].depth >= depth) {
      stack.pop();
    }

    const node = { text: blockText, heading, children: [] };
    stack[stack.length - 1].node.children.push(node);
    stack.push({ node, depth });
  }

  return root.children;
}

/**
 * Recursively create Roam blocks from a parseMarkdownToBlocks() tree.
 * Each node becomes a block parented to parentUid; children nest beneath it.
 *
 * Safety caps (matching the shared write helpers in index.js):
 * - Depth capped at INBOX_BLOCK_TREE_MAX_DEPTH (30)
 * - Total blocks capped at INBOX_BLOCK_TREE_MAX_BLOCKS (50)
 * - Block text truncated at INBOX_MAX_BLOCK_CHARS (20K)
 */
export async function createRoamBlockTree(api, parentUid, nodes, depth = 0, counter = { created: 0 }) {
  if (depth >= INBOX_BLOCK_TREE_MAX_DEPTH) return;
  for (const node of nodes) {
    if (counter.created >= INBOX_BLOCK_TREE_MAX_BLOCKS) {
      deps.debugLog?.("[Chief flow] Inbox block tree hit max block cap:", INBOX_BLOCK_TREE_MAX_BLOCKS);
      return;
    }
    const uid = api.util?.generateUID?.();
    if (!uid) continue;
    const safeText = String(node.text || "").slice(0, INBOX_MAX_BLOCK_CHARS);
    const blockDef = { uid, string: safeText };
    if (node.heading) blockDef.heading = node.heading;

    const createFn = () => api.data.block.create({
      location: { "parent-uid": parentUid, order: "last" },
      block: blockDef,
    });
    if (deps.withRoamWriteRetry) {
      await deps.withRoamWriteRetry(createFn);
    } else {
      await createFn();
    }
    counter.created++;

    if (node.children && node.children.length > 0) {
      await createRoamBlockTree(api, uid, node.children, depth + 1, counter);
    }
  }
}

async function moveInboxBlockToDNP(blockUid, responseText) {
  const api = deps.getRoamAlphaApi?.();
  if (!api) return;

  const today = new Date();
  const dnpUid = api.util?.dateToPageUid?.(today);
  if (!dnpUid) return;

  // Ensure DNP exists
  const dnpTitle = api.util?.dateToPageTitle?.(today);
  if (dnpTitle && api?.data?.pull && api?.data?.page?.create) {
    const dnpExists = api.data.pull("[:node/title]", [":block/uid", dnpUid]);
    if (!dnpExists?.[":node/title"]) {
      try {
        await api.data.page.create({ page: { title: dnpTitle } });
      } catch (_) { /* race or already exists */ }
    }
  }

  // Find or create "Processed Chief of Staff items" heading on DNP
  const headingText = "Processed Chief of Staff items";
  const escapeForDatalog = deps.escapeForDatalog;
  const existingHeading = api.data.q?.(
    `[:find ?uid . :where [?p :block/uid "${escapeForDatalog(dnpUid)}"] [?p :block/children ?b] [?b :block/string "${escapeForDatalog(headingText)}"] [?b :block/uid ?uid]]`
  );

  // Helper: route write through shared retry wrapper when available
  const retryWrite = deps.withRoamWriteRetry || (fn => fn());

  let headingUid = existingHeading;
  if (!headingUid) {
    headingUid = api.util?.generateUID?.();
    await retryWrite(() => api.data.block.create({
      location: { "parent-uid": dnpUid, order: "last" },
      block: { uid: headingUid, string: headingText, heading: 3 }
    }));
  }

  // Move the inbox block under the heading
  await retryWrite(() => api.data.block.move({
    location: { "parent-uid": headingUid, order: "last" },
    block: { uid: blockUid }
  }));

  // Write a processing-status child immediately after move so partial state
  // is explicit and visible in the graph if later writes fail.
  const statusUid = api.util?.generateUID?.();
  if (statusUid) {
    await retryWrite(() => api.data.block.create({
      location: { "parent-uid": blockUid, order: "last" },
      block: { uid: statusUid, string: "**[Chief of Staff]** Processing response..." }
    }));
  }

  // Add COS response as child of the moved block.
  // Parse markdown into a Roam block hierarchy rather than dumping raw text.
  // Wrapped in try/catch so a child-write failure doesn't leave a silently
  // incomplete result — the status marker above remains visible.
  if (responseText) {
    try {
      const nodes = parseMarkdownToBlocks(responseText);
      if (nodes.length > 0) {
        await createRoamBlockTree(api, blockUid, nodes);
      } else {
        // Fallback: response had no parseable structure — write as a single block
        await retryWrite(() => api.data.block.create({
          location: { "parent-uid": blockUid, order: "last" },
          block: { string: String(responseText || "").slice(0, INBOX_MAX_BLOCK_CHARS) },
        }));
      }
      // Success — remove the processing-status marker
      if (statusUid) {
        try { await retryWrite(() => api.deleteBlock({ block: { uid: statusUid } })); } catch (_) { /* non-fatal */ }
      }
    } catch (writeErr) {
      console.warn("[Chief of Staff] Inbox child write failed after move:", writeErr?.message || writeErr);
      // Update the status marker to reflect the failure
      if (statusUid) {
        try {
          await retryWrite(() => api.updateBlock({
            block: { uid: statusUid, string: `**[Chief of Staff]** Response write failed: ${String(writeErr?.message || "unknown error").slice(0, 200)}. Original response was generated but could not be saved.` }
          }));
        } catch (_markerErr) {
          console.warn("[Chief of Staff] Inbox failure marker update also failed:", _markerErr?.message || _markerErr);
        }
      }
    }
  } else {
    // No response text — remove the processing marker
    if (statusUid) {
      try { await retryWrite(() => api.deleteBlock({ block: { uid: statusUid } })); } catch (_) { /* non-fatal */ }
    }
  }
}

// ── Enqueue / queue management ─────────────────────────────────────────

export function enqueueInboxItems(newBlocks) {
  let accepted = 0;
  // Chain onto the sequential processing queue so items run one at a time
  for (const block of newBlocks) {
    const uid = String(block?.uid || "").trim();
    if (!uid) continue;
    if (inboxProcessingSet.has(uid) || inboxQueuedSet.has(uid)) continue;
    if (inboxPendingQueueCount >= INBOX_MAX_PENDING_ITEMS) {
      deps.debugLog?.("[Chief flow] Inbox queue at capacity; deferring remaining items.");
      break;
    }
    inboxQueuedSet.add(uid);
    inboxPendingQueueCount += 1;
    accepted += 1;
    inboxProcessingQueue = inboxProcessingQueue
      .then(async () => {
        try {
          await processInboxItem(block);
        } finally {
          inboxQueuedSet.delete(uid);
          inboxPendingQueueCount = Math.max(0, inboxPendingQueueCount - 1);
          if (inboxPendingQueueCount === 0) scheduleInboxCatchupScan(250);
        }
      })
      .catch((e) => {
        console.warn("[Chief of Staff] Inbox queue error for block", block?.uid, ":", e?.message || e);
      });
  }
  if (accepted < newBlocks.length) {
    deps.debugLog?.("[Chief flow] Inbox queue limited:", { accepted, dropped: newBlocks.length - accepted });
  }
}

// ── Pull watch callback (inbox portion) ────────────────────────────────

/**
 * Called from registerMemoryPullWatches() when the Inbox page fires.
 * Receives pullWatch _before / _after payloads.
 * Returns true if inbox handled the event (caller should skip memory/skills invalidation).
 */
export function handleInboxPullWatchEvent(_before, _after, pullWatchDebounceTimers) {
  if (pullWatchDebounceTimers["inbox"]) {
    clearTimeout(pullWatchDebounceTimers["inbox"]);
  }
  pullWatchDebounceTimers["inbox"] = setTimeout(() => {
    if (deps.isUnloadInProgress?.()) {
      delete pullWatchDebounceTimers["inbox"];
      return;
    }
    delete pullWatchDebounceTimers["inbox"];

    // Backpressure: when queue is saturated, skip this scan entirely.
    if (inboxPendingQueueCount >= INBOX_MAX_PENDING_ITEMS) {
      deps.debugLog?.("[Chief flow] Inbox queue at capacity; skipping inbox scan.");
      return;
    }

    // Fast path: use pullWatch delta first, avoiding full q scans on every
    // mutation while queue is draining.
    const beforeMap = collectInboxBlockMap(_before);
    const afterMap = collectInboxBlockMap(_after);
    const deltaBlocks = [];
    for (const [uid, str] of afterMap.entries()) {
      if (beforeMap.has(uid)) continue;
      deltaBlocks.push({ ":block/uid": uid, ":block/string": str });
    }
    const deltaCandidates = getInboxCandidateBlocksFromChildrenRows(deltaBlocks);
    if (deltaCandidates.length > 0) {
      const bounded = deltaCandidates.slice(0, INBOX_MAX_ITEMS_PER_SCAN);
      deps.debugLog?.("[Chief flow] Inbox delta: enqueueing", bounded.length, "of", deltaCandidates.length, "new block(s).");
      enqueueInboxCandidates(bounded);
    }

    // While queue has pending work, skip expensive full scans unless we
    // need a catch-up pass after the queue drains.
    if (inboxPendingQueueCount > 0) {
      if (deltaCandidates.length === 0) {
        deps.debugLog?.("[Chief flow] Inbox queue active; skipping full scan (no delta additions).");
      }
      scheduleInboxCatchupScan();
      return;
    }

    // When idle and delta found nothing, run full scan to catch remote/sync
    // changes that may not appear in pullWatch before/after payloads.
    if (deltaCandidates.length === 0) {
      if (shouldRunInboxFullScanFallback(afterMap.size)) {
        runFullInboxScan("watch-full-fallback");
      } else {
        deps.debugLog?.("[Chief flow] Inbox full scan skipped (cooldown/signature gate).");
      }
    }
  }, 5000); // 5s debounce — let batch writes settle
}

// ── Cleanup (called from onunload) ─────────────────────────────────────

export function cleanupInbox() {
  clearInboxCatchupScanTimer();
  inboxQueuedSet.clear();
  inboxProcessingSet.clear();
  inboxPendingQueueCount = 0;
  inboxProcessingQueue = Promise.resolve();
  inboxLastFullScanAt = 0;
  inboxLastFullScanUidSignature = "";
  inboxStaticUIDs = null;
}

/**
 * Return the current processing queue promise (for graceful shutdown).
 */
export function getInboxProcessingQueue() {
  return inboxProcessingQueue;
}

/**
 * Expose pending queue count for pull watch backpressure check.
 */
export function getInboxPendingQueueCount() {
  return inboxPendingQueueCount;
}
