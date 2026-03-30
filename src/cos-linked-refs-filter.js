// ═══════════════════════════════════════════════════════════════════════════════
// COS Linked Refs Filter
// ═══════════════════════════════════════════════════════════════════════════════
//
// Auto-removes Chief of Staff namespace pages from linked references on every
// non-COS page the user visits.  Merge-not-replace — never overwrites existing
// user filters.  Applies once per page per session so manual changes are
// respected.
//
// DI via initCosLinkedRefsFilter({ debugLog, getExtensionAPI, getSettingBool,
//   SETTING_KEY }).
// ═══════════════════════════════════════════════════════════════════════════════

let deps = {};

// ── Internal state ──────────────────────────────────────────────────────────

const appliedPages = new Set();   // UIDs already processed this session
let cosPageTitles = [];           // cached "Chief of Staff/*" page titles
let hashChangeHandler = null;     // listener ref for teardown

// ── Helpers ─────────────────────────────────────────────────────────────────

function discoverCosPages() {
  try {
    const results = window.roamAlphaAPI?.data?.q?.(
      '[:find ?title :where [?p :node/title ?title] (or [(= ?title "Chief of Staff")] [(clojure.string/starts-with? ?title "Chief of Staff/")])]'
    );
    return (results || []).map(r => r[0]);
  } catch (e) {
    deps.debugLog?.("[COS filter] discoverCosPages failed:", e?.message || e);
    return [];
  }
}

async function maybeApplyFiltersForUid(uid) {
  if (!uid || appliedPages.has(uid)) return;

  const api = window.roamAlphaAPI;
  if (!api?.ui?.filters?.getPageLinkedRefsFilters) return;

  // Resolve page title — skip blocks (no :node/title)
  const data = api.data?.pull?.("[:node/title]", [":block/uid", uid]);
  const title = data?.[":node/title"];
  if (!title) return;

  // Skip COS namespace pages — they should remain fully browsable
  if (title === "Chief of Staff" || title.startsWith("Chief of Staff/")) return;

  // Check setting (default: enabled)
  const extensionAPI = deps.getExtensionAPI?.();
  if (extensionAPI && deps.getSettingBool?.(extensionAPI, deps.SETTING_KEY, true) === false) return;

  // Mark early so concurrent calls don't double-apply
  appliedPages.add(uid);

  try {
    const existing = api.ui.filters.getPageLinkedRefsFilters({ page: { title } });
    const existingRemoves = existing?.removes || [];
    const merged = [...new Set([...existingRemoves, ...cosPageTitles])];

    // No-op if all COS pages are already filtered
    if (merged.length === existingRemoves.length) return;

    await api.ui.filters.setPageLinkedRefsFilters({
      page: { title },
      filters: {
        includes: existing?.includes || [],
        removes: merged,
      },
    });
    deps.debugLog?.(`[COS filter] Applied ${merged.length - existingRemoves.length} filter(s) to "${title}"`);
  } catch (e) {
    // Roll back so next visit retries
    appliedPages.delete(uid);
    deps.debugLog?.("[COS filter] Failed to apply filters:", e?.message || e);
  }
}

function handleNavigation() {
  // Primary: extract UID from URL hash (fast path for page navigation)
  const hashMatch = window.location.hash.match(/\/page\/([a-zA-Z0-9_-]+)/);
  let uid = hashMatch?.[1] || null;

  // Fallback: Roam API (covers Daily Notes view where hash has no /page/)
  if (!uid) {
    try {
      uid = window.roamAlphaAPI?.ui?.mainWindow?.getOpenPageOrBlockUid?.() || null;
    } catch { /* ignore */ }
  }

  if (uid) maybeApplyFiltersForUid(uid);
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

export function initCosLinkedRefsFilter(injected) {
  deps = injected;

  // Seed default so Roam's switch UI renders correctly on first use
  const extensionAPI = deps.getExtensionAPI?.();
  if (extensionAPI) {
    const stored = extensionAPI.settings.get(deps.SETTING_KEY);
    if (stored !== true && stored !== false) {
      extensionAPI.settings.set(deps.SETTING_KEY, true);
    }
  }

  // Feature-detect filter API
  if (!window.roamAlphaAPI?.ui?.filters?.getPageLinkedRefsFilters) {
    deps.debugLog?.("[COS filter] Filter API not available — skipping");
    return;
  }

  cosPageTitles = discoverCosPages();
  if (cosPageTitles.length === 0) {
    deps.debugLog?.("[COS filter] No COS pages found — skipping");
    return;
  }
  deps.debugLog?.(`[COS filter] Discovered ${cosPageTitles.length} COS page(s)`);

  // Apply to current page immediately
  handleNavigation();

  // Listen for future navigations
  hashChangeHandler = () => handleNavigation();
  window.addEventListener("hashchange", hashChangeHandler);
}

export function teardownCosLinkedRefsFilter() {
  if (hashChangeHandler) {
    window.removeEventListener("hashchange", hashChangeHandler);
    hashChangeHandler = null;
  }
  appliedPages.clear();
  cosPageTitles = [];
  deps = {};
}
