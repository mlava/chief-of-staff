/**
 * Graph Hygiene — idle-time scans for orphan pages and stale links.
 *
 * Two background tasks run during idle time:
 * 1. Orphan page detection — pages with zero incoming references
 * 2. Stale link detection — block/page refs pointing to deleted content
 *
 * Results are cached in module state and exposed via getOrphanPagesResult()
 * and getStaleLinkResult(). Summaries are persisted to [[Chief of Staff/Graph Hygiene]].
 *
 * Initialised via initGraphHygiene(deps). Both features are gated behind
 * individual settings toggles (off by default).
 */

// ── DI container ────────────────────────────────────────────────────────────
let deps = {};

export function initGraphHygiene(injected) {
  deps = injected || {};
}

// ── Constants ────────────────────────────────────────────────────────────────
export const ORPHAN_SCAN_INTERVAL_MS = 60 * 60 * 1000;       // 1 hour
export const STALE_LINK_SCAN_INTERVAL_MS = 60 * 60 * 1000;   // 1 hour

const HYGIENE_PAGE_TITLE = "Chief of Staff/Graph Hygiene";
const ORPHAN_BATCH_SIZE = 200;
const STALE_LINK_BATCH_SIZE = 100;
const MAX_RESULTS = 200;
const DEADLINE_MARGIN_MS = 5;

// Daily note title pattern: "January 1st, 2026"
const DAILY_NOTE_REGEX = /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(st|nd|rd|th),\s+\d{4}$/;

// System page prefixes to exclude from orphan detection
const EXCLUDED_PREFIXES = ["Chief of Staff/", "roam/", "cos/"];

// ── Module state ─────────────────────────────────────────────────────────────
let orphanPagesResult = null;
let staleLinksResult = null;

// ── Helpers ──────────────────────────────────────────────────────────────────

function getQueryApi() {
  const api = deps.getRoamAlphaApi?.();
  if (!api?.data?.q) return null;
  return api.data;
}

function isExcludedPage(title) {
  if (!title) return true;
  if (DAILY_NOTE_REGEX.test(title)) return true;
  for (const prefix of EXCLUDED_PREFIXES) {
    if (title.startsWith(prefix)) return true;
  }
  return false;
}

function sanitise(text) {
  return String(text || "")
    .replace(/\[\[/g, "\u27E6").replace(/\]\]/g, "\u27E7")
    .replace(/\{\{/g, "\u2983").replace(/\}\}/g, "\u2984");
}

// ── Orphan Page Scan (Idle Task) ─────────────────────────────────────────────

/**
 * Idle task processChunk: scan pages for zero incoming references.
 *
 * @param {{ allPages: Array|null, offset: number, orphans: Array, startedAt: number }} state
 * @param {{ timeRemaining: () => number }} deadline
 * @returns {{ state: object, done: boolean }}
 */
export function scanOrphanPages(state, deadline) {
  const queryApi = getQueryApi();
  if (!queryApi) return { state: { allPages: null, offset: 0, orphans: [], startedAt: 0 }, done: true };

  let { allPages, offset, orphans, startedAt } = state;
  orphans = orphans || [];
  offset = offset || 0;
  startedAt = startedAt || Date.now();

  // First chunk: fetch all pages
  if (!allPages) {
    try {
      const raw = queryApi.q("[:find ?title ?uid :where [?p :node/title ?title] [?p :block/uid ?uid]]");
      allPages = Array.isArray(raw) ? raw.filter(r => !isExcludedPage(r[0])) : [];
      deps.debugLog?.(`[Graph Hygiene] Orphan scan: ${allPages.length} candidate pages (filtered from ${raw?.length || 0})`);
    } catch (err) {
      deps.debugLog?.("[Graph Hygiene] Failed to fetch pages:", err?.message);
      return { state: { allPages: null, offset: 0, orphans: [], startedAt: 0 }, done: true };
    }
  }

  if (allPages.length === 0) {
    return { state: { allPages: null, offset: 0, orphans: [], startedAt: 0 }, done: true };
  }

  // Process pages in batches
  let processed = 0;
  while (offset < allPages.length && deadline.timeRemaining() > DEADLINE_MARGIN_MS && processed < ORPHAN_BATCH_SIZE) {
    const [title, uid] = allPages[offset];
    offset++;
    processed++;

    try {
      const escaped = title.replace(/"/g, '\\"');
      const refs = queryApi.q(`[:find (count ?b) . :where [?p :node/title "${escaped}"] [?b :block/refs ?p]]`);
      if (!refs || refs === 0) {
        // Also count child blocks for context
        const blockCount = queryApi.q(`[:find (count ?c) . :where [?p :block/uid "${uid}"] [?c :block/page ?p]]`);
        orphans.push({ title, uid, blockCount: blockCount || 0 });
      }
    } catch (err) {
      deps.debugLog?.("[Graph Hygiene] Orphan check error for page:", title, err?.message);
    }
  }

  const done = offset >= allPages.length;

  if (done) {
    // Sort by title, cap stored list at MAX_RESULTS but preserve true count
    orphans.sort((a, b) => a.title.localeCompare(b.title));
    const totalOrphans = orphans.length;
    const cappedOrphans = orphans.length > MAX_RESULTS ? orphans.slice(0, MAX_RESULTS) : orphans;

    orphanPagesResult = {
      pages: cappedOrphans,
      orphanCount: totalOrphans,
      scannedAt: Date.now(),
      totalPages: allPages.length,
      scanDurationMs: Date.now() - startedAt
    };

    deps.debugLog?.(`[Graph Hygiene] Orphan scan complete: ${totalOrphans} orphans found out of ${allPages.length} pages (showing ${cappedOrphans.length})`);

    // Persist summary (fire-and-forget)
    persistOrphanSummary(cappedOrphans, totalOrphans, allPages.length).catch(err => {
      deps.debugLog?.("[Graph Hygiene] Persist error (non-fatal):", err?.message);
    });
  }

  return {
    state: { allPages: done ? null : allPages, offset: done ? 0 : offset, orphans: done ? [] : orphans, startedAt },
    done
  };
}

// ── Stale Link Scan (Idle Task) ──────────────────────────────────────────────

const BLOCK_REF_PATTERN = /\(\(([a-zA-Z0-9_-]{9,12})\)\)/g;
const PAGE_REF_PATTERN = /\[\[([^\]]+)\]\]/g;

/**
 * Idle task processChunk: scan blocks for broken block/page references.
 *
 * @param {{ allBlocks: Array|null, offset: number, staleLinks: Array, checkedUids: Object, checkedTitles: Object, startedAt: number }} state
 * @param {{ timeRemaining: () => number }} deadline
 * @returns {{ state: object, done: boolean }}
 */
export function scanStaleLinks(state, deadline) {
  const queryApi = getQueryApi();
  if (!queryApi) return { state: { allBlocks: null, offset: 0, staleLinks: [], checkedUids: {}, checkedTitles: {}, startedAt: 0 }, done: true };

  let { allBlocks, offset, staleLinks, checkedUids, checkedTitles, startedAt } = state;
  staleLinks = staleLinks || [];
  offset = offset || 0;
  checkedUids = checkedUids || {};
  checkedTitles = checkedTitles || {};
  startedAt = startedAt || Date.now();

  // First chunk: fetch all blocks containing link syntax
  if (!allBlocks) {
    try {
      const blockRefBlocks = queryApi.q('[:find ?uid ?str :where [?b :block/uid ?uid] [?b :block/string ?str] [(clojure.string/includes? ?str "((")]]') || [];
      const pageRefBlocks = queryApi.q('[:find ?uid ?str :where [?b :block/uid ?uid] [?b :block/string ?str] [(clojure.string/includes? ?str "[[")]]') || [];

      // Deduplicate by UID
      const seen = new Set();
      allBlocks = [];
      for (const [uid, str] of blockRefBlocks) {
        if (!seen.has(uid)) { seen.add(uid); allBlocks.push([uid, str]); }
      }
      for (const [uid, str] of pageRefBlocks) {
        if (!seen.has(uid)) { seen.add(uid); allBlocks.push([uid, str]); }
      }

      deps.debugLog?.(`[Graph Hygiene] Stale link scan: ${allBlocks.length} blocks with link syntax (${blockRefBlocks.length} with ((, ${pageRefBlocks.length} with [[)`);
    } catch (err) {
      deps.debugLog?.("[Graph Hygiene] Failed to fetch link blocks:", err?.message);
      return { state: { allBlocks: null, offset: 0, staleLinks: [], checkedUids: {}, checkedTitles: {}, startedAt: 0 }, done: true };
    }
  }

  if (allBlocks.length === 0) {
    return { state: { allBlocks: null, offset: 0, staleLinks: [], checkedUids: {}, checkedTitles: {}, startedAt: 0 }, done: true };
  }

  // Process blocks in batches
  let processed = 0;
  while (offset < allBlocks.length && deadline.timeRemaining() > DEADLINE_MARGIN_MS && processed < STALE_LINK_BATCH_SIZE) {
    const [blockUid, text] = allBlocks[offset];
    offset++;
    processed++;

    try {
      // Check block refs ((uid))
      let m;
      BLOCK_REF_PATTERN.lastIndex = 0;
      while ((m = BLOCK_REF_PATTERN.exec(text)) !== null) {
        const targetUid = m[1];
        if (!(targetUid in checkedUids)) {
          const exists = queryApi.pull("[:block/uid]", [":block/uid", targetUid]);
          checkedUids[targetUid] = !!exists;
        }
        if (!checkedUids[targetUid]) {
          staleLinks.push({
            type: "block_ref",
            targetUid,
            sourceUid: blockUid,
            sourceText: text.slice(0, 120)
          });
        }
      }

      // Check page refs [[Title]]
      PAGE_REF_PATTERN.lastIndex = 0;
      while ((m = PAGE_REF_PATTERN.exec(text)) !== null) {
        const title = m[1];
        if (!(title in checkedTitles)) {
          const escaped = title.replace(/"/g, '\\"');
          const exists = queryApi.q(`[:find ?p . :where [?p :node/title "${escaped}"]]`);
          checkedTitles[title] = !!exists;
        }
        if (!checkedTitles[title]) {
          staleLinks.push({
            type: "page_ref",
            targetTitle: title,
            sourceUid: blockUid,
            sourceText: text.slice(0, 120)
          });
        }
      }
    } catch (err) {
      deps.debugLog?.("[Graph Hygiene] Stale link check error for block:", blockUid, err?.message);
    }
  }

  const done = offset >= allBlocks.length;

  if (done) {
    if (staleLinks.length > MAX_RESULTS) staleLinks = staleLinks.slice(0, MAX_RESULTS);

    staleLinksResult = {
      links: staleLinks,
      scannedAt: Date.now(),
      totalBlocks: allBlocks.length,
      scanDurationMs: Date.now() - startedAt
    };

    deps.debugLog?.(`[Graph Hygiene] Stale link scan complete: ${staleLinks.length} stale links in ${allBlocks.length} blocks`);

    // Persist summary (fire-and-forget)
    persistStaleLinkSummary(staleLinks, allBlocks.length).catch(err => {
      deps.debugLog?.("[Graph Hygiene] Persist error (non-fatal):", err?.message);
    });
  }

  return {
    state: {
      allBlocks: done ? null : allBlocks,
      offset: done ? 0 : offset,
      staleLinks: done ? [] : staleLinks,
      checkedUids: done ? {} : checkedUids,
      checkedTitles: done ? {} : checkedTitles,
      startedAt
    },
    done
  };
}

// ── Persistence ──────────────────────────────────────────────────────────────

/**
 * Remove previous top-level blocks on the hygiene page whose text contains
 * the given marker (e.g. "**Orphan Pages**" or "**Stale Links**").
 * Latest scan supersedes the previous one — no point stacking entries.
 */
async function removePreviousEntries(pageUid, marker) {
  try {
    const api = deps.getRoamAlphaApi?.();
    if (!api?.data?.q) return;
    const children = api.data.q(
      `[:find ?uid ?str :where [?p :block/uid "${pageUid}"] [?p :block/children ?b] [?b :block/uid ?uid] [?b :block/string ?str]]`
    );
    if (!Array.isArray(children)) return;
    for (const [uid, str] of children) {
      if (str && str.includes(marker)) {
        await api.deleteBlock({ block: { uid } });
      }
    }
  } catch (err) {
    deps.debugLog?.("[Graph Hygiene] removePreviousEntries error (non-fatal):", err?.message);
  }
}

async function persistOrphanSummary(orphans, totalOrphans, totalPages) {
  if (!totalOrphans) return;

  const pageUid = await deps.ensurePageUidByTitle?.(HYGIENE_PAGE_TITLE);
  if (!pageUid) return;

  await removePreviousEntries(pageUid, "**Orphan Pages**");

  const dateStr = deps.formatRoamDate?.(new Date()) || new Date().toISOString().slice(0, 10);
  const headerText = `[[${dateStr}]] **Orphan Pages** — ${totalOrphans} page${totalOrphans === 1 ? "" : "s"} with zero incoming references (of ${totalPages} scanned)`;
  const insertOrder = deps.getFirstContentOrder ? deps.getFirstContentOrder(pageUid) : 0;
  const headerUid = await deps.createRoamBlock?.(pageUid, headerText, insertOrder);
  if (!headerUid) return;

  // Log up to 20 entries on the page (full list available via tool)
  const cap = Math.min(orphans.length, 20);
  for (let i = 0; i < cap; i++) {
    const p = orphans[i];
    const line = `${sanitise(p.title)} (${p.blockCount} block${p.blockCount === 1 ? "" : "s"})`;
    await deps.createRoamBlock?.(headerUid, line, "last");
  }
  if (orphans.length > 20) {
    await deps.createRoamBlock?.(headerUid, `…and ${orphans.length - 20} more. Use \`cos_get_orphan_pages\` for the full list.`, "last");
  }
}

async function persistStaleLinkSummary(staleLinks, totalBlocks) {
  if (!staleLinks.length) return;

  const pageUid = await deps.ensurePageUidByTitle?.(HYGIENE_PAGE_TITLE);
  if (!pageUid) return;

  await removePreviousEntries(pageUid, "**Stale Links**");

  const dateStr = deps.formatRoamDate?.(new Date()) || new Date().toISOString().slice(0, 10);
  const headerText = `[[${dateStr}]] **Stale Links** — ${staleLinks.length} broken reference${staleLinks.length === 1 ? "" : "s"} (${totalBlocks} blocks scanned)`;
  const insertOrder = deps.getFirstContentOrder ? deps.getFirstContentOrder(pageUid) : 0;
  const headerUid = await deps.createRoamBlock?.(pageUid, headerText, insertOrder);
  if (!headerUid) return;

  const cap = Math.min(staleLinks.length, 20);
  for (let i = 0; i < cap; i++) {
    const link = staleLinks[i];
    const line = link.type === "block_ref"
      ? `\`((${link.targetUid}))\` in block ((${link.sourceUid})) — block no longer exists`
      : `\`${sanitise("[[" + link.targetTitle + "]]")}\` in block ((${link.sourceUid})) — page no longer exists`;
    await deps.createRoamBlock?.(headerUid, line, "last");
  }
  if (staleLinks.length > 20) {
    await deps.createRoamBlock?.(headerUid, `…and ${staleLinks.length - 20} more. Use \`cos_get_stale_links\` for the full list.`, "last");
  }
}

// ── Accessors ────────────────────────────────────────────────────────────────

export function getOrphanPagesResult() { return orphanPagesResult; }
export function getStaleLinkResult() { return staleLinksResult; }
