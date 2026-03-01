// roam-native-tools.js — 28 Roam tool definitions, extracted from index.js
// All external dependencies are injected via initRoamNativeTools().

let deps = {};
let roamNativeToolsCache = null;

export function initRoamNativeTools(injected) {
  deps = injected;
}

export function resetRoamNativeToolsCache() {
  roamNativeToolsCache = null;
}

export function getRoamNativeTools() {
  if (roamNativeToolsCache) return roamNativeToolsCache;
  roamNativeToolsCache = [
    {
      name: "roam_search",
      isMutating: false,
      description: "Search Roam block text content and return matching blocks with page context.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Case-insensitive text to search for." },
          max_results: { type: "number", description: "Maximum matches to return. Default 20." }
        },
        required: ["query"]
      },
      execute: async ({ query, max_results = 20 } = {}) => {
        const api = deps.getRoamAlphaApi();
        const queryText = String(query || "").trim().toLowerCase();
        if (!queryText) return [];
        const escapedQuery = deps.escapeForDatalog(queryText);
        const limit = Number.isFinite(max_results) ? Math.max(1, Math.min(500, max_results)) : 20;
        const hardCap = Math.max(200, limit);
        // NOTE: clojure.string/lower-case is broken in Roam's Datascript engine
        // (returns empty results) and re-find #"..." reader syntax is unsupported.
        // Strategy: query with multiple case variants via (or ...) clause,
        // then filter case-insensitively in JS as a safety net.
        const originalCase = deps.escapeForDatalog(String(query || "").trim());
        const lowerCase = escapedQuery; // already lowercase + escaped
        const titleCase = deps.escapeForDatalog(
          String(query || "").trim().replace(/\b\w/g, c => c.toUpperCase())
        );
        // Build (or ...) clause with distinct case variants
        const variants = [...new Set([originalCase, lowerCase, titleCase])];
        const orClauses = variants.map(v => `[(clojure.string/includes? ?str "${v}")]`).join("\n            ");
        const baseQuery = `[:find ?uid ?str ?page-title
          :where
          [?b :block/string ?str]
          [?b :block/uid ?uid]
          [?b :block/page ?p]
          [?p :node/title ?page-title]
          (or
            ${orClauses})]`;
        let results;
        try {
          results = await deps.queryRoamDatalog(`${baseQuery.slice(0, -1)}
          :limit ${hardCap}]`);
        } catch (error) {
          console.warn("[Chief of Staff] Roam :limit unsupported; running unbounded roam_search scan.");
          results = await deps.queryRoamDatalog(baseQuery, api);
        }
        // Final case-insensitive filter in JS (catches any case the variants missed)
        const allResults = Array.isArray(results) ? results : [];
        const filtered = allResults.filter(([, text]) => text && text.toLowerCase().includes(queryText));
        const capped = filtered.slice(0, limit).map(([uid, text, page]) => ({ uid, text, page }));
        if (filtered.length > limit) {
          capped.push({ _note: `Showing ${limit} of ${filtered.length} matches. Increase max_results (up to 500) to see more.` });
        } else if (capped.length === 0) {
          capped.push({ _note: `No matches found for "${String(args.query || "").slice(0, 80)}". Try a different or broader query.` });
        }
        return capped;
      }
    },
    {
      name: "roam_find_todos",
      isMutating: false,
      description: "Find TODO and DONE checkbox blocks, optionally scoped to a specific page. Uses Roam's internal reference graph for reliable detection — always prefer this over roam_search when looking for TODOs.",
      input_schema: {
        type: "object",
        properties: {
          page_title: { type: "string", description: "Scope to a specific page title. Omit to search entire graph." },
          page_uid: { type: "string", description: "Scope to a specific page UID. Takes priority over page_title." },
          status: { type: "string", enum: ["TODO", "DONE", "any"], description: "Filter by status. Default: 'TODO'." },
          max_results: { type: "number", description: "Maximum results. Default 50." }
        }
      },
      execute: async ({ page_title, page_uid, status = "TODO", max_results = 50 } = {}) => {
        const limit = Number.isFinite(max_results) ? Math.max(1, Math.min(500, max_results)) : 50;
        const validStatus = ["TODO", "DONE", "any"].includes(status) ? status : "TODO";

        // Build page scope clause if provided
        const pUid = String(page_uid || "").trim();
        const pTitle = String(page_title || "").trim();
        let pageWhere = "";
        if (pUid) {
          pageWhere = `[?p :block/uid "${deps.escapeForDatalog(pUid)}"] [?b :block/page ?p]`;
        } else if (pTitle) {
          pageWhere = `[?p :node/title "${deps.escapeForDatalog(pTitle)}"] [?b :block/page ?p]`;
        } else {
          pageWhere = "[?b :block/page ?p]";
        }

        // Use :block/refs to find blocks referencing the TODO/DONE page node.
        // This is how Roam natively tracks {{[[TODO]]}} / {{[[DONE]]}} — far more
        // reliable than string matching which breaks on Roam's curly-bracket syntax.
        const statuses = validStatus === "any" ? ["TODO", "DONE"] : [validStatus];
        let allResults = [];

        for (const s of statuses) {
          const q = `[:find ?uid ?str ?page-title
            :where
            [?ref-page :node/title "${s}"]
            [?b :block/refs ?ref-page]
            [?b :block/string ?str]
            [?b :block/uid ?uid]
            ${pageWhere}
            [?p :node/title ?page-title]]`;
          try {
            const rows = await deps.queryRoamDatalog(q);
            if (Array.isArray(rows)) {
              for (const [uid, text, page] of rows) {
                // Strip the {{[[TODO]]}} / {{[[DONE]]}} prefix for cleaner display
                const cleanText = String(text || "")
                  .replace(/\{\{\[\[TODO\]\]\}\}\s*/, "")
                  .replace(/\{\{\[\[DONE\]\]\}\}\s*/, "");
                allResults.push({
                  uid,
                  text: cleanText,
                  raw: text,
                  status: s,
                  page
                });
              }
            }
          } catch (err) {
            console.warn(`[Chief of Staff] roam_find_todos query failed for ${s}:`, err?.message || err);
          }
        }

        const total = allResults.length;
        return {
          todos: allResults.slice(0, limit),
          count: Math.min(allResults.length, limit),
          total,
          scope: pUid || pTitle || "entire graph"
        };
      }
    },
    {
      name: "roam_get_page",
      isMutating: false,
      description: "Get a page block tree by exact page title or UID. Provide one of title or uid.",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Exact page title." },
          uid: { type: "string", description: "Page UID." }
        }
      },
      execute: async ({ title, uid } = {}) => {
        const pageTitle = String(title || "").trim();
        const pageUid = String(uid || "").trim();
        if (!pageTitle && !pageUid) throw new Error("Either title or uid is required");
        return pageUid ? deps.getPageTreeByUidAsync(pageUid) : deps.getPageTreeByTitleAsync(pageTitle);
      }
    },
    {
      name: "roam_get_daily_page",
      isMutating: false,
      description: "Get today's daily page (or a provided date) with full block tree.",
      input_schema: {
        type: "object",
        properties: {
          date: { type: "string", description: "Optional ISO date string (YYYY-MM-DD)." }
        }
      },
      execute: async ({ date } = {}) => {
        const targetDate = date ? new Date(date) : new Date();
        if (Number.isNaN(targetDate.getTime())) throw new Error("Invalid date value");
        return deps.getPageTreeByTitleAsync(deps.formatRoamDate(targetDate));
      }
    },
    {
      name: "roam_open_page",
      isMutating: false,
      description: "Open a page in Roam's main window by title or UID. Use this when the user asks to navigate to, open, or go to a page.",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Page title to open (e.g. 'January 6th, 2026')." },
          uid: { type: "string", description: "Page or block UID to open. Takes priority over title." }
        }
      },
      execute: async ({ title, uid } = {}) => {
        const api = deps.getRoamAlphaApi();
        const pageUid = String(uid || "").trim();
        const pageTitle = String(title || "").trim();
        if (!pageUid && !pageTitle) throw new Error("Either title or uid is required");

        if (pageUid) {
          await api.ui.mainWindow.openPage({ page: { uid: pageUid } });
          return { success: true, opened: pageUid };
        }
        // Resolve title to UID
        const rows = await deps.queryRoamDatalog(`[:find ?uid :where [?p :node/title "${deps.escapeForDatalog(pageTitle)}"] [?p :block/uid ?uid]]`) || [];
        if (!rows.length) throw new Error(`Page not found: "${pageTitle}"`);
        const resolvedUid = String(rows[0]?.[0] || "").trim();
        if (!resolvedUid) throw new Error(`Could not resolve UID for "${pageTitle}"`);
        await api.ui.mainWindow.openPage({ page: { uid: resolvedUid } });
        return { success: true, opened: pageTitle, uid: resolvedUid };
      }
    },
    {
      name: "roam_create_block",
      isMutating: true,
      description: "Create a new block in Roam under a parent block/page UID.",
      input_schema: {
        type: "object",
        properties: {
          parent_uid: { type: "string", description: "Parent block or page UID." },
          text: { type: "string", description: "Block text content." },
          order: { type: "string", description: "\"first\" or \"last\". Default \"last\"." }
        },
        required: ["parent_uid", "text"]
      },
      execute: async ({ parent_uid, text, order = "last" } = {}) => {
        const parentUid = String(parent_uid || "").trim();
        if (!parentUid) throw new Error("parent_uid is required");
        deps.requireRoamUidExists(parentUid, "parent_uid");
        const uid = await deps.createRoamBlock(parentUid, text, order);
        return {
          success: true,
          uid,
          parent_uid: parentUid
        };
      }
    },
    {
      name: "roam_delete_block",
      isMutating: true,
      description: "Delete a block (and all its children) from Roam by UID. Use this to delete Better Tasks or any other block. Requires the block's UID.",
      input_schema: {
        type: "object",
        properties: {
          uid: { type: "string", description: "Block UID to delete." }
        },
        required: ["uid"]
      },
      execute: async ({ uid } = {}) => {
        const blockUid = String(uid || "").trim();
        if (!blockUid) throw new Error("uid is required");
        deps.requireRoamUidExists(blockUid, "uid");
        const api = deps.getRoamAlphaApi();
        if (!api?.deleteBlock) throw new Error("Roam deleteBlock API unavailable");
        // Guard: refuse to delete page-level entities or Chief of Staff system pages
        const escapedUid = deps.escapeForDatalog(blockUid);
        const pageTitle = await deps.queryRoamDatalog(`[:find ?t . :where [?e :block/uid "${escapedUid}"] [?e :node/title ?t]]`);
        if (pageTitle) {
          const systemPages = [...deps.getActiveMemoryPageTitles(), deps.SKILLS_PAGE_TITLE];
          if (systemPages.includes(pageTitle)) {
            throw new Error(`Refusing to delete Chief of Staff system page: "${pageTitle}"`);
          }
          throw new Error(`UID "${blockUid}" is a page ("${pageTitle}"). Use Roam to delete pages directly.`);
        }
        await deps.withRoamWriteRetry(() => api.deleteBlock({ block: { uid: blockUid } }));
        return { success: true, deleted_uid: blockUid };
      }
    },
    {
      name: "roam_update_block",
      isMutating: true,
      description: "Update an existing block in Roam by UID. Can change text, heading level, children view type, text alignment, open/collapsed state, and block props (key/value attributes like BT_attrDue, BT_attrProject, etc.).",
      input_schema: {
        type: "object",
        properties: {
          uid: { type: "string", description: "Block UID to update." },
          text: { type: "string", description: "New text content for the block. Omit to leave text unchanged." },
          heading: { type: "integer", enum: [0, 1, 2, 3], description: "Heading level: 0 = normal text, 1 = H1, 2 = H2, 3 = H3. Omit to leave unchanged." },
          "children-view-type": { type: "string", enum: ["bullet", "numbered", "document"], description: "How child blocks render: bullet (default), numbered, or document. Omit to leave unchanged." },
          "text-align": { type: "string", enum: ["left", "center", "right", "justify"], description: "Text alignment. Omit to leave unchanged." },
          open: { type: "boolean", description: "true = expanded, false = collapsed. Omit to leave unchanged." },
          props: {
            type: "object",
            description: "Block props to set or remove (merged with existing props). Each key is a prop name (e.g. BT_attrDue, BT_attrProject). Set a value to null to delete that prop.",
            additionalProperties: true
          }
        },
        required: ["uid"]
      },
      execute: async ({ uid, text, heading, "children-view-type": childrenViewType, "text-align": textAlign, open, props } = {}) => {
        const blockUid = String(uid || "").trim();
        if (!blockUid) throw new Error("uid is required");
        deps.requireRoamUidExists(blockUid, "uid");
        const api = deps.requireRoamUpdateBlockApi(deps.getRoamAlphaApi());
        const blockPayload = { uid: blockUid };
        if (text !== undefined) blockPayload.string = deps.truncateRoamBlockText(String(text ?? ""));
        if (heading !== undefined) {
          const h = Number(heading);
          if (![0, 1, 2, 3].includes(h)) throw new Error("heading must be 0, 1, 2, or 3");
          blockPayload.heading = h;
        }
        if (childrenViewType !== undefined) {
          if (!["bullet", "numbered", "document"].includes(childrenViewType)) throw new Error("children-view-type must be bullet, numbered, or document");
          blockPayload["children-view-type"] = childrenViewType;
        }
        if (textAlign !== undefined) {
          if (!["left", "center", "right", "justify"].includes(textAlign)) throw new Error("text-align must be left, center, right, or justify");
          blockPayload["text-align"] = textAlign;
        }
        if (open !== undefined) blockPayload.open = !!open;
        if (props !== undefined) {
          if (typeof props !== "object" || props === null || Array.isArray(props)) throw new Error("props must be a plain object");
          // Reject non-serialisable values (functions, symbols, circular refs)
          try { JSON.stringify(props); } catch { throw new Error("props must be JSON-serialisable (no functions, circular references, or symbols)"); }
          // Read-merge-write: read current props, merge patch, write back.
          // This avoids clobbering unrelated props on the block.
          const pullData = api.pull?.("[:block/props]", [":block/uid", blockUid])
            ?? api.data?.pull?.("[:block/props]", [":block/uid", blockUid]);
          const currentProps = pullData?.[":block/props"] || {};
          blockPayload.props = { ...currentProps, ...props };
        }
        if (Object.keys(blockPayload).length <= 1) throw new Error("At least one property to update must be provided (text, heading, children-view-type, text-align, open, or props)");
        await deps.withRoamWriteRetry(() => api.updateBlock({ block: blockPayload }));
        return { success: true, updated_uid: blockUid };
      }
    },
    {
      name: "roam_move_block",
      isMutating: true,
      description: "Move an existing block to a new parent in Roam.",
      input_schema: {
        type: "object",
        properties: {
          uid: { type: "string", description: "Block UID to move." },
          parent_uid: { type: "string", description: "New parent block or page UID." },
          order: { type: "string", description: "\"first\" or \"last\". Default \"last\"." }
        },
        required: ["uid", "parent_uid"]
      },
      execute: async ({ uid, parent_uid, order = "last" } = {}) => {
        const blockUid = String(uid || "").trim();
        const parentUid = String(parent_uid || "").trim();
        if (!blockUid) throw new Error("uid is required");
        if (!parentUid) throw new Error("parent_uid is required");
        if (blockUid === parentUid) throw new Error("Cannot move a block under itself");
        deps.requireRoamUidExists(blockUid, "uid");
        deps.requireRoamUidExists(parentUid, "parent_uid");
        // Guard against moving a block under one of its own descendants (creates cycles)
        let ancestor = parentUid;
        for (let i = 0; i < 30; i++) {
          const puid = await deps.queryRoamDatalog(
            `[:find ?puid . :where [?b :block/uid "${deps.escapeForDatalog(ancestor)}"] [?b :block/parent ?p] [?p :block/uid ?puid]]`
          );
          if (!puid) break;
          if (puid === blockUid) throw new Error("Cannot move a block under its own descendant");
          ancestor = puid;
        }
        const api = deps.getRoamAlphaApi();
        if (!api?.moveBlock) throw new Error("Roam moveBlock API unavailable");
        await deps.withRoamWriteRetry(() => api.moveBlock({
          location: { "parent-uid": parentUid, order: order === "first" ? 0 : "last" },
          block: { uid: blockUid }
        }));
        return { success: true, moved_uid: blockUid, new_parent_uid: parentUid };
      }
    },
    {
      name: "roam_get_block_children",
      isMutating: false,
      description: "Get a block and its full child tree by UID.",
      input_schema: {
        type: "object",
        properties: {
          uid: { type: "string", description: "Block UID." }
        },
        required: ["uid"]
      },
      execute: async ({ uid } = {}) => {
        const blockUid = String(uid || "").trim();
        if (!blockUid) throw new Error("uid is required");
        const escapedUid = deps.escapeForDatalog(blockUid);
        const result = await deps.queryRoamDatalog(`[:find (pull ?b ${deps.BLOCK_TREE_PULL_PATTERN}) .
          :where [?b :block/uid "${escapedUid}"]]`);
        if (!result) return { uid: blockUid, text: null, children: [] };
        return deps.flattenBlockTree(result);
      }
    },
    {
      name: "roam_get_block_context",
      isMutating: false,
      description: "Get a block's surrounding context: the block itself, its parent chain up to the page, and its siblings. Useful for understanding where a block lives before acting on it. UIDs are returned as ((uid)) block references and page titles as [[title]] — preserve this exact notation when presenting results.",
      input_schema: {
        type: "object",
        properties: {
          uid: { type: "string", description: "Block UID to get context for." }
        },
        required: ["uid"]
      },
      execute: async ({ uid } = {}) => {
        const blockUid = String(uid || "").trim();
        if (!blockUid) throw new Error("uid is required");
        const escaped = deps.escapeForDatalog(blockUid);

        const getOrder = (b) => { const o = b?.[":block/order"] ?? b?.["block/order"] ?? b?.order; return Number.isFinite(o) ? o : 0; };
        const getTitle = (b) => b?.[":node/title"] ?? b?.["node/title"] ?? b?.title ?? null;

        // Get the block itself + its children
        const block = await deps.queryRoamDatalog(`[:find (pull ?b [:block/uid :block/string :block/order {:block/children [:block/uid :block/string :block/order]}]) .
          :where [?b :block/uid "${escaped}"]]`);
        if (!block) return { uid: blockUid, error: "Block not found" };

        const blockText = deps.getBlockString(block);
        const blockOrder = getOrder(block);

        // Format block as "((uid)): text" display string
        const fmtBlock = (uid, text) => `((${uid})): ${text.slice(0, 200)}`;
        const fmtPage = (uid, title) => `[[${title}]] ((${uid}))`;

        // Block's own children
        const ownChildren = deps.getBlockChildren(block)
          .map(c => ({ block: fmtBlock(deps.getBlockUid(c), deps.getBlockString(c)), order: getOrder(c) }))
          .sort((a, b) => a.order - b.order)
          .map(c => c.block);

        // Walk up the parent chain using sequential queries.
        // Note: :block/parent is reliable in Datalog WHERE clauses but NOT in pull specs
        // (see ROAM_EXTENSION_PATTERNS.md "Avoid unreliable :block/parent pulls").
        // Each iteration issues one query that finds the parent and pulls its data + children.
        const chain = [];
        let siblings = [];
        const MAX_DEPTH = 10;
        let currentUid = blockUid;
        for (let i = 0; i < MAX_DEPTH; i++) {
          const escapedCurrent = deps.escapeForDatalog(currentUid);
          const parent = await deps.queryRoamDatalog(`[:find (pull ?p [:block/uid :block/string :block/order :node/title
              {:block/children [:block/uid :block/string :block/order]}]) .
            :where [?b :block/uid "${escapedCurrent}"] [?b :block/parent ?p]]`);
          if (!parent) break;

          const parentUid = deps.getBlockUid(parent);
          const parentTitle = getTitle(parent);
          const parentText = deps.getBlockString(parent);

          // On first iteration, extract siblings (excluding the block itself)
          if (i === 0) {
            siblings = deps.getBlockChildren(parent)
              .map(c => ({ block: fmtBlock(deps.getBlockUid(c), deps.getBlockString(c)), order: getOrder(c), uid: deps.getBlockUid(c) }))
              .filter(c => c.uid !== blockUid)
              .sort((a, b) => a.order - b.order)
              .map(c => c.block);
          }

          const label = parentTitle != null
            ? fmtPage(parentUid, parentTitle)
            : fmtBlock(parentUid, parentText);
          chain.push(label);
          if (parentTitle != null) break; // reached page level
          currentUid = parentUid;
        }

        // Nest the ancestor chain: page > grandparent > parent
        let ancestorTree = null;
        for (let i = chain.length - 1; i >= 0; i--) {
          if (ancestorTree) {
            ancestorTree = { block: chain[i], parent: ancestorTree };
          } else {
            ancestorTree = { block: chain[i] };
          }
        }

        return {
          block: fmtBlock(blockUid, blockText),
          order: blockOrder,
          parent: ancestorTree,
          siblings,
          children: ownChildren,
          depth: chain.length
        };
      }
    },
    {
      name: "roam_get_page_metadata",
      isMutating: false,
      description: "Get metadata for a page: creation time, last edit time, word count, block count, and reference count.",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Exact page title." },
          uid: { type: "string", description: "Page UID. Takes priority over title." }
        }
      },
      execute: async ({ title, uid } = {}) => {
        const pageUid = String(uid || "").trim();
        const pageTitle = String(title || "").trim();
        if (!pageUid && !pageTitle) throw new Error("Either title or uid is required");

        const whereClause = pageUid
          ? `[?p :block/uid "${deps.escapeForDatalog(pageUid)}"]`
          : `[?p :node/title "${deps.escapeForDatalog(pageTitle)}"]`;

        // Page-level times and title
        const pageMeta = await deps.queryRoamDatalog(`[:find (pull ?p [:node/title :block/uid :create/time :edit/time]) .
          :where ${whereClause}]`);
        if (!pageMeta) return { title: pageTitle || pageUid, found: false };

        const resolvedTitle = pageMeta[":node/title"] || pageTitle || "";
        const resolvedUid = pageMeta[":block/uid"] || pageUid || "";
        const createTime = pageMeta[":create/time"] || null;
        const editTime = pageMeta[":edit/time"] || null;

        // Block count via aggregate (avoids materialising all block strings just to count rows)
        const blockCountRow = await deps.queryRoamDatalog(`[:find (count ?b) .
          :where ${whereClause}
          [?b :block/page ?p]]`);
        const blockCount = typeof blockCountRow === "number" ? blockCountRow : 0;

        // Word count: fetches all block strings on the page. This is inherently expensive
        // on large pages (1,000+ blocks) but irreducible — you can't count words without
        // reading the text. The word-count extension (wc_get_page_count) pays the same cost
        // via an ancestor-rule query that is arguably heavier. This tool is only invoked by
        // the LLM on explicit request, never in a hot loop, and the Roam API 20-second
        // query timeout provides a natural ceiling.
        const blockStrings = await deps.queryRoamDatalog(`[:find ?str
          :where ${whereClause}
          [?b :block/page ?p]
          [?b :block/string ?str]]`);
        let wordCount = 0;
        if (Array.isArray(blockStrings)) {
          for (const [str] of blockStrings) {
            if (str) wordCount += String(str).split(/\s+/).filter(Boolean).length;
          }
        }

        // Reference count — how many blocks across the graph reference this page
        const refRows = await deps.queryRoamDatalog(`[:find (count ?b) .
          :where ${whereClause}
          [?b :block/refs ?p]]`);
        const referenceCount = typeof refRows === "number" ? refRows : 0;

        return {
          title: resolvedTitle,
          uid: resolvedUid,
          created: createTime ? new Date(createTime).toISOString() : null,
          edited: editTime ? new Date(editTime).toISOString() : null,
          block_count: blockCount,
          word_count: wordCount,
          reference_count: referenceCount
        };
      }
    },
    {
      name: "roam_get_recent_changes",
      isMutating: false,
      description: "Get pages and optionally blocks modified within a time window, sorted by most recent first.",
      input_schema: {
        type: "object",
        properties: {
          hours: { type: "number", description: "Look-back window in hours. Default 24." },
          exclude_daily_notes: { type: "boolean", description: "Exclude daily note pages (e.g. 'February 15th, 2026'). Default false." },
          include_blocks: { type: "boolean", description: "Include recently edited blocks per page. Default false." },
          max_blocks_per_page: { type: "number", description: "Max blocks per page when include_blocks is true. Default 5." },
          limit: { type: "number", description: "Max pages to return. Default 20." }
        }
      },
      execute: async ({ hours = 24, exclude_daily_notes = false, include_blocks = false, max_blocks_per_page = 5, limit = 20 } = {}) => {
        const validHours = Number.isFinite(hours) ? Math.max(0.01, Math.min(8760, hours)) : 24;
        const validLimit = Number.isFinite(limit) ? Math.max(1, Math.min(500, limit)) : 20;
        const validBlockCap = Number.isFinite(max_blocks_per_page) ? Math.max(1, Math.min(20, max_blocks_per_page)) : 5;
        const floor = Date.now() - (validHours * 60 * 60 * 1000);
        const results = await deps.queryRoamDatalog(
          `[:find ?title ?uid ?time
            :where
            [?p :node/title ?title]
            [?p :block/uid ?uid]
            [?p :edit/time ?time]
            [(> ?time ${floor})]]`
        );
        if (!results?.length) return { pages: [], count: 0, total: 0 };

        let pages = results
          .map(([title, uid, time]) => ({ title, uid, edited: new Date(time).toISOString() }))
          .sort((a, b) => new Date(b.edited) - new Date(a.edited));

        if (exclude_daily_notes) {
          const api = deps.getRoamAlphaApi();
          if (api?.util?.pageTitleToDate) {
            pages = pages.filter(p => !api.util.pageTitleToDate(p.title));
          }
        }

        const total = pages.length;
        const trimmed = pages.slice(0, validLimit);

        if (include_blocks) {
          const cap = validBlockCap;
          for (const page of trimmed) {
            try {
              const blocks = await deps.queryRoamDatalog(
                `[:find ?string ?uid ?time
                  :where
                  [?p :block/uid "${page.uid}"]
                  [?b :block/page ?p]
                  [?b :block/string ?string]
                  [?b :block/uid ?uid]
                  [?b :edit/time ?time]
                  [(> ?time ${floor})]]`
              );
              page.blocks = (blocks || [])
                .map(([string, uid, time]) => ({ text: string, uid, edited: new Date(time).toISOString() }))
                .sort((a, b) => new Date(b.edited) - new Date(a.edited))
                .slice(0, cap);
            } catch (err) {
              page.blocks = [];
              page.blockError = err?.message || "Failed to fetch blocks";
            }
          }
        }

        return { pages: trimmed, count: trimmed.length, total };
      }
    },
    {
      name: "roam_link_suggestions",
      isMutating: false,
      description: "Scan all blocks on a page for existing page titles that aren't linked. Returns suggestions grouped by block with UIDs. To create a link, call roam_link_mention with the block uid and title from the results.",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Page title to scan." },
          uid: { type: "string", description: "Page UID. Takes priority over title." },
          min_title_length: { type: "number", description: "Minimum page title length to consider. Default 3." }
        }
      },
      execute: async ({ title, uid, min_title_length = 3 } = {}) => {
        const pageUid = String(uid || "").trim();
        const pageTitle = String(title || "").trim();
        if (!pageUid && !pageTitle) throw new Error("Either title or uid is required");

        const minLen = Number.isFinite(min_title_length) ? Math.max(1, min_title_length) : 3;
        const whereClause = pageUid
          ? `[?p :block/uid "${deps.escapeForDatalog(pageUid)}"]`
          : `[?p :node/title "${deps.escapeForDatalog(pageTitle)}"]`;

        // Verify page exists
        const pageCheck = await deps.queryRoamDatalog(`[:find ?uid . :where ${whereClause} [?p :block/uid ?uid]]`);
        if (!pageCheck) {
          return { found: false, title: pageTitle || pageUid, error: "Page not found" };
        }

        // Get all block strings on the page
        const blockRows = await deps.queryRoamDatalog(`[:find ?uid ?str
          :where ${whereClause}
          [?b :block/page ?p]
          [?b :block/uid ?uid]
          [?b :block/string ?str]]`);
        if (!Array.isArray(blockRows) || !blockRows.length) {
          return { found: true, title: pageTitle || pageUid, blocks_scanned: 0, suggestions: [] };
        }

        // Performance note: this fetches ALL page titles in the graph. On large graphs
        // (5,000+ pages) this is an expensive query. We considered three mitigations:
        //   1. Adding a :limit or .slice() cap — rejected because silently dropping titles
        //      gives incomplete results without telling the user, breaking the tool's promise.
        //   2. Moving the JS-side filters (daily pages, short titles, single lowercase words)
        //      into the Datalog query — not feasible, Datascript doesn't support regex in :where.
        //   3. Removing the tool entirely — the LLM can spot unlinked mentions via roam_get_page
        //      and call roam_link_mention directly, but the dedicated scan is significantly more
        //      reliable and thorough.
        // We accept the cost because: (a) the aggressive JS-side filtering below (daily pages,
        // short titles, single-word lowercase) reduces the candidate set to typically <200 even
        // on large graphs; (b) this tool is only invoked on explicit user request, never in a
        // hot loop; (c) the Roam API 20-second query timeout provides a natural ceiling.
        const titleQueryStart = performance.now();
        const titleRows = await deps.queryRoamDatalog(`[:find ?t :where [?p :node/title ?t]]`);
        deps.debugLog?.("[Roam tools] roam_link_suggestions: all-pages query took", Math.round(performance.now() - titleQueryStart), "ms,", Array.isArray(titleRows) ? titleRows.length : 0, "titles");
        if (!Array.isArray(titleRows) || !titleRows.length) {
          return { found: true, title: pageTitle || pageUid, blocks_scanned: blockRows.length, suggestions: [] };
        }

        // Filter candidate titles: skip short, daily pages, the page itself,
        // and noisy single-word titles. Single-word titles only pass if they are:
        //   - ALL CAPS (acronyms like "CHEST", "API")
        //   - Mixed internal case (camelCase/PascalCase like "SmartBlock", "YouTube")
        // Regular Title Case single words ("Evening", "Article") are filtered as noise.
        // Multi-word titles always pass ("San Francisco", "Better Tasks").
        const selfTitle = (pageTitle || "").toLowerCase();
        const candidateTitles = [];
        for (const [t] of titleRows) {
          if (!t || t.length < minLen) continue;
          if (t.toLowerCase() === selfTitle) continue;
          if (/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d/.test(t)) continue;
          // Single-word filter: only pass acronyms (ALL CAPS) or mixed-case (internal uppercase)
          if (!/\s/.test(t)) {
            const isAllCaps = /^[A-Z][A-Z0-9]+$/.test(t);
            const hasMixedCase = /[a-z]/.test(t) && /[A-Z]/.test(t.slice(1));
            if (!isAllCaps && !hasMixedCase) continue;
          }
          candidateTitles.push(t);
        }
        if (!candidateTitles.length) return { title: pageTitle || pageUid, suggestions: [] };

        // Pre-compile regexes for all candidates
        const candidateRegexes = [];
        for (const t of candidateTitles) {
          try {
            const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            candidateRegexes.push({ title: t, re: new RegExp(`\\b${escaped}\\b`, "i") });
          } catch { /* skip */ }
        }

        // Scan each block
        const results = [];
        for (const [bUid, bStr] of blockRows) {
          const text = String(bStr || "");
          if (!text.trim()) continue;

          // Collect already-linked titles in this block
          const linkedTitles = new Set();
          let match;
          const linkPattern = /\[\[([^\]]+)\]\]/g;
          while ((match = linkPattern.exec(text)) !== null) linkedTitles.add(match[1].toLowerCase());
          const hashBracketPattern = /#\[\[([^\]]+)\]\]/g;
          while ((match = hashBracketPattern.exec(text)) !== null) linkedTitles.add(match[1].toLowerCase());
          const tagPattern = /#([^\s\[\]]+)/g;
          while ((match = tagPattern.exec(text)) !== null) linkedTitles.add(match[1].toLowerCase());

          const blockSuggestions = [];
          for (const { title: t, re } of candidateRegexes) {
            if (linkedTitles.has(t.toLowerCase())) continue;
            if (re.test(text)) blockSuggestions.push(t);
          }
          if (blockSuggestions.length) {
            results.push({ uid: bUid, text: text.slice(0, 120), suggestions: blockSuggestions });
          }
        }

        const totalSuggestions = results.reduce((sum, r) => sum + r.suggestions.length, 0);
        return { found: true, title: pageTitle || pageUid, blocks_scanned: blockRows.length, blocks_with_suggestions: results.length, total_suggestions: totalSuggestions, results };
      }
    },
    {
      name: "roam_link_mention",
      isMutating: true,
      description: "Atomically wrap an unlinked mention of a page title in [[...]] within a block. Reads the block text, finds the first unlinked occurrence, replaces it, and updates the block.",
      input_schema: {
        type: "object",
        properties: {
          uid: { type: "string", description: "Block UID containing the unlinked mention." },
          title: { type: "string", description: "Page title to link (e.g. 'San Francisco'). Will be wrapped as [[San Francisco]]." }
        },
        required: ["uid", "title"]
      },
      execute: async ({ uid, title } = {}) => {
        const blockUid = String(uid || "").trim();
        const pageTitle = String(title || "").trim();
        if (!blockUid) throw new Error("uid is required");
        if (!pageTitle) throw new Error("title is required");

        // Read current block text
        const rows = await deps.queryRoamDatalog(
          `[:find ?str . :where [?b :block/uid "${deps.escapeForDatalog(blockUid)}"] [?b :block/string ?str]]`
        );
        if (rows == null) throw new Error(`Block not found: ${blockUid}`);
        const originalText = String(rows);

        // Build regex that matches the title but NOT inside existing [[...]] or #[[...]]
        const escaped = pageTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp(`\\b${escaped}\\b`, "i");

        // Strip out existing [[...]] and #[[...]] to find unlinked positions.
        // Replace linked references with \x00 placeholders of equal length to preserve indices.
        // Assumes Roam block text never contains literal null bytes (safe in practice).
        const placeholderText = originalText.replace(/\#?\[\[[^\]]*\]\]/g, (m) => "\x00".repeat(m.length));

        const match = re.exec(placeholderText);
        if (!match) {
          return { success: false, uid: blockUid, title: pageTitle, error: "No unlinked mention found in block text." };
        }

        // Replace at the matched position in the original text
        const before = originalText.slice(0, match.index);
        const original = originalText.slice(match.index, match.index + match[0].length);
        const after = originalText.slice(match.index + match[0].length);
        const newText = `${before}[[${original}]]${after}`;

        // Re-read block text to guard against concurrent edits (TOCTOU)
        const freshRows = await deps.queryRoamDatalog(
          `[:find ?str . :where [?b :block/uid "${deps.escapeForDatalog(blockUid)}"] [?b :block/string ?str]]`
        );
        if (String(freshRows) !== originalText) {
          return { success: false, uid: blockUid, title: pageTitle, error: "Block text changed since initial read — aborting to avoid overwriting concurrent edits." };
        }

        const api = deps.requireRoamUpdateBlockApi(deps.getRoamAlphaApi());
        await deps.withRoamWriteRetry(() => api.updateBlock({ block: { uid: blockUid, string: deps.truncateRoamBlockText(newText) } }));
        return { success: true, uid: blockUid, title: pageTitle, updated_text: newText.slice(0, 200) };
      }
    },
    {
      name: "roam_create_blocks",
      isMutating: true,
      description: "Create multiple blocks (with optional nested children). Use parent_uid + blocks for a single location, or batches for multiple independent locations in one call.",
      input_schema: {
        type: "object",
        properties: {
          parent_uid: { type: "string", description: "Parent block or page UID (single-location mode)." },
          blocks: {
            type: "array",
            description: "List of block definitions (single-location mode).",
            items: {
              type: "object",
              properties: {
                text: { type: "string" },
                children: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      text: { type: "string" },
                      children: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            text: { type: "string" }
                          },
                          required: ["text"]
                        }
                      }
                    },
                    required: ["text"]
                  }
                }
              },
              required: ["text"]
            }
          },
          batches: {
            type: "array",
            description: "Array of { parent_uid, blocks } for writing to multiple locations in one call.",
            items: {
              type: "object",
              properties: {
                parent_uid: { type: "string", description: "Parent block or page UID." },
                blocks: { type: "array", description: "Block definitions for this parent.", items: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }
              },
              required: ["parent_uid", "blocks"]
            }
          }
        }
      },
      execute: async ({ parent_uid, blocks, batches } = {}) => {
        // Normalise into a list of { parentUid, blocks } work items
        const workItems = [];
        if (Array.isArray(batches) && batches.length) {
          for (const batch of batches) {
            const pUid = String(batch?.parent_uid || "").trim();
            if (!pUid) throw new Error("Each batch requires a parent_uid");
            if (!Array.isArray(batch.blocks) || !batch.blocks.length) throw new Error(`Batch for ${pUid}: blocks must be a non-empty array`);
            workItems.push({ parentUid: pUid, blocks: batch.blocks });
          }
        } else {
          const parentUid = String(parent_uid || "").trim();
          if (!parentUid) throw new Error("parent_uid is required (or use batches)");
          if (!Array.isArray(blocks) || !blocks.length) throw new Error("blocks must be a non-empty array");
          workItems.push({ parentUid, blocks });
        }

        // Validate all target UIDs exist before any writes
        for (const { parentUid } of workItems) {
          deps.requireRoamUidExists(parentUid, "parent_uid");
        }

        const allBlocks = workItems.flatMap(w => w.blocks);
        const totalNodes = deps.countBlockTreeNodes(allBlocks);
        if (totalNodes > deps.MAX_CREATE_BLOCKS_TOTAL) {
          throw new Error(`Too many blocks (${totalNodes}). Maximum is ${deps.MAX_CREATE_BLOCKS_TOTAL} per call.`);
        }

        const results = [];
        for (const { parentUid, blocks: batchBlocks } of workItems) {
          const created = [];
          for (let index = 0; index < batchBlocks.length; index += 1) {
            const uid = await deps.createRoamBlockTree(parentUid, batchBlocks[index], index);
            created.push(uid);
          }
          results.push({ parent_uid: parentUid, created_count: created.length, created_uids: created });
        }
        return {
          success: true,
          total_created: results.reduce((sum, r) => sum + r.created_count, 0),
          results
        };
      }
    },
    {
      name: "roam_batch_write",
      isMutating: true,
      description: "Write structured content as nested blocks under a parent. Accepts markdown — headings become parent blocks, list items become children. Handles nesting and chunking automatically. Use this instead of multiple roam_create_block/roam_create_blocks calls when writing structured content like reviews, briefings, or outlines.",
      input_schema: {
        type: "object",
        properties: {
          parent_uid: { type: "string", description: "UID of the page or block to write under." },
          markdown: { type: "string", description: "Markdown content. Use ## headings for sections, - lists for items, **bold** for emphasis. Headings create parent blocks; list items nest as children." },
          order: { type: "string", description: "Where to insert: 'first' or 'last'. Default 'last'." }
        },
        required: ["parent_uid", "markdown"]
      },
      execute: async ({ parent_uid, markdown, order = "last" } = {}) => {
        const parentUid = String(parent_uid || "").trim();
        if (!parentUid) throw new Error("parent_uid is required");
        deps.requireRoamUidExists(parentUid, "parent_uid");
        const md = String(markdown || "").trim();
        if (!md) throw new Error("markdown content is required");
        if (md.length > 50000) throw new Error(`Markdown too large (${md.length} chars). Maximum is 50,000 characters.`);
        // Try Roam's native fromMarkdown first; fall back to our own parser if it fails.
        // fromMarkdown can throw internal errors ("n.map is not a function") on some markdown inputs;
        // these are bugs in Roam's parser, not transient — skip straight to fallback.
        try {
          const api = deps.getRoamAlphaApi();
          if (!api?.data?.block?.fromMarkdown) {
            throw new Error("Roam fromMarkdown API unavailable.");
          }
          const result = await api.data.block.fromMarkdown({
            location: { "parent-uid": parentUid, order: order === "first" ? 0 : "last" },
            "markdown-string": md
          });
          return { success: true, parent_uid: parentUid, uids: result };
        } catch (fmError) {
          // Fallback: Roam has no batch API beyond fromMarkdown, so we create blocks
          // sequentially via createRoamBlockTree. This path is rarely hit (only when
          // Roam's parser throws) and the block count is safety-capped.
          deps.debugLog("[Chief flow] fromMarkdown failed, using fallback parser:", fmError?.message);
          const blockTree = deps.parseMarkdownToBlockTree(md);
          if (!blockTree.length) throw fmError;
          const fallbackNodeCount = deps.countBlockTreeNodes(blockTree);
          if (fallbackNodeCount > deps.MAX_CREATE_BLOCKS_TOTAL) {
            throw new Error(`Fallback parser produced ${fallbackNodeCount} blocks, exceeding the ${deps.MAX_CREATE_BLOCKS_TOTAL} safety cap.`);
          }
          const uids = [];
          for (let i = 0; i < blockTree.length; i++) {
            const uid = await deps.createRoamBlockTree(parentUid, blockTree[i], i);
            uids.push(uid);
          }
          return { success: true, parent_uid: parentUid, uids, fallback: true };
        }
      }
    },
    {
      name: "cos_get_skill",
      isMutating: false,
      description: "Load the full instructions for a specific skill by name. Use this before applying any skill. Returns the complete skill content from the Skills page.",
      input_schema: {
        type: "object",
        properties: {
          skill_name: {
            type: "string",
            description: "Name of the skill to load (must match a name from the Available Skills list)."
          }
        },
        required: ["skill_name"]
      },
      execute: async (args = {}) => {
        const name = String(args?.skill_name || "").trim();
        if (!name) return JSON.stringify({ error: "skill_name is required" });
        const entry = await deps.findSkillEntryByName(name, { force: false });
        if (!entry) {
          const entries = await deps.getSkillEntries({ force: false });
          const available = entries.map((e) => e.title).join(", ");
          return JSON.stringify({ error: `Skill "${name}" not found. Available: ${available}` });
        }
        return JSON.stringify({
          skill_name: entry.title,
          block_uid: entry.uid || null,
          content: entry.content,
          children_content: entry.childrenContent || ""
        });
      }
    },
    {
      name: "cos_write_draft_skill",
      isMutating: true,
      description: "Write a draft skill definition to the Chief of Staff/Skills page. Creates the skill name as a top-level block with nested children for description, triggers, sources, and instructions. Handles page UID lookup and block nesting automatically.",
      input_schema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Skill name with (Draft) suffix, e.g. 'Project Task Auto-Triage (Draft)'."
          },
          content: {
            type: "string",
            description: "Skill body as indented markdown list items. Each '- ' item becomes a child block. Use indentation for nesting. Example:\n- Description of what the skill does\n- Triggers: \"phrase 1\", \"phrase 2\"\n- Sources\n  - tool_name — what data it provides\n- Instructions\n  - Step 1\n  - Step 2"
          }
        },
        required: ["name", "content"]
      },
      execute: async ({ name, content } = {}) => {
        const skillName = String(name || "").trim();
        if (!skillName) throw new Error("name is required");
        const text = String(content || "").trim();
        if (!text) throw new Error("content is required");

        const pageUid = await deps.ensurePageUidByTitle(deps.SKILLS_PAGE_TITLE);
        if (!pageUid) throw new Error("Could not resolve Skills page UID.");

        // Create top-level skill block
        const skillUid = await deps.createRoamBlock(pageUid, skillName, "last");

        // Parse content into block tree and create nested children
        const normalisedText = text.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
        const blockTree = deps.parseMarkdownToBlockTree(normalisedText);
        const totalNodes = deps.countBlockTreeNodes(blockTree);
        if (totalNodes > deps.MAX_CREATE_BLOCKS_TOTAL) {
          throw new Error(`Skill content too large (${totalNodes} blocks). Maximum is ${deps.MAX_CREATE_BLOCKS_TOTAL}.`);
        }
        for (let i = 0; i < blockTree.length; i++) {
          await deps.createRoamBlockTree(skillUid, blockTree[i], i);
        }

        deps.invalidateSkillsPromptCache();
        return {
          success: true,
          skill_name: skillName,
          block_uid: skillUid,
          children_created: blockTree.length
        };
      }
    },
    {
      name: "cos_get_current_time",
      isMutating: false,
      description: "Get the current date and time. Returns ISO timestamp, day of week, and Roam-formatted daily note page titles for today, tomorrow, and yesterday.",
      input_schema: { type: "object", properties: {} },
      execute: async () => {
        const now = new Date();
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const yesterday = new Date(now);
        yesterday.setDate(yesterday.getDate() - 1);
        const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
        const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const localTime = now.toLocaleString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true });
        const localDate = now.toLocaleDateString("en-US", { timeZone: tz, weekday: "long", year: "numeric", month: "long", day: "numeric" });
        return {
          currentTime: `${localDate} ${localTime}`,
          iso: now.toISOString(),
          dayOfWeek: dayNames[now.getDay()],
          today: deps.formatRoamDate(now),
          tomorrow: deps.formatRoamDate(tomorrow),
          yesterday: deps.formatRoamDate(yesterday),
          timezone: tz,
          unix: Math.floor(now.getTime() / 1000)
        };
      }
    },
    {
      name: "cos_update_memory",
      isMutating: true,
      description: "Append or update Chief of Staff memory pages. Pages: memory, inbox, skills, projects, decisions, lessons. Actions: append (default), replace_block (needs block_uid), replace_children (replaces all children of a skill block — needs block_uid, skills page only).",
      input_schema: {
        type: "object",
        properties: {
          page: {
            type: "string",
            description: "Target memory page: memory, inbox, skills, projects, decisions, or lessons."
          },
          action: {
            type: "string",
            description: "append (default), replace_block, or replace_children (skills page only — rewrites all child blocks under the given block_uid)."
          },
          content: {
            type: "string",
            description: "Content to write. For replace_children (skills): use markdown list items with ACTUAL NEWLINES between items (- item1\\n- item2), NOT a single line. Do not include the skill name."
          },
          block_uid: {
            type: "string",
            description: "Required for replace_block: block UID to replace."
          }
        },
        required: ["page", "action", "content"]
      },
      execute: async (args = {}) => deps.updateChiefMemory(args)
    },
    {
      name: "roam_get_backlinks",
      isMutating: false,
      description: "Get all blocks that reference a page (backlinks). Returns the referring blocks with their page context.",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Page title to find backlinks for." },
          uid: { type: "string", description: "Page UID. Takes priority over title." },
          max_results: { type: "number", description: "Maximum backlinks to return. Default 50." }
        }
      },
      execute: async ({ title, uid, max_results = 50 } = {}) => {
        const pageUid = String(uid || "").trim();
        const pageTitle = String(title || "").trim();
        if (!pageUid && !pageTitle) throw new Error("Either title or uid is required");
        const limit = Number.isFinite(max_results) ? Math.max(1, Math.min(500, max_results)) : 50;

        const whereClause = pageUid
          ? `[?p :block/uid "${deps.escapeForDatalog(pageUid)}"]`
          : `[?p :node/title "${deps.escapeForDatalog(pageTitle)}"]`;
        // Note: Datascript doesn't support :limit in :find clauses, so the full result set
        // is materialised and truncated in JS. For heavily-referenced pages (1,000+ backlinks)
        // this fetches more rows than needed. We return `total` so the LLM knows truncation
        // occurred. The Roam API 20-second query timeout provides a natural ceiling, and the
        // max_results parameter (capped at 500) keeps the returned payload bounded.
        const results = await deps.queryRoamDatalog(`[:find ?ref-uid ?ref-str ?ref-page-title
          :where
          ${whereClause}
          [?b :block/refs ?p]
          [?b :block/uid ?ref-uid]
          [?b :block/string ?ref-str]
          [?b :block/page ?rp]
          [?rp :node/title ?ref-page-title]]`);
        if (!Array.isArray(results) || !results.length) return { title: pageTitle || pageUid, backlinks: [] };
        const backlinks = results.slice(0, limit).map(([bUid, bStr, bPage]) => ({
          uid: bUid, text: String(bStr || ""), page: String(bPage || "")
        }));
        return { title: pageTitle || pageUid, count: backlinks.length, total: results.length, backlinks };
      }
    },
    {
      name: "roam_undo",
      isMutating: true,
      description: "Undo the last action in Roam. Use when the user asks to undo a recent change.",
      input_schema: { type: "object", properties: {} },
      execute: async () => {
        const api = deps.getRoamAlphaApi();
        if (!api?.data?.undo) {
          throw new Error("Roam undo API unavailable");
        }
        const result = await api.data.undo();
        deps.debugLog("[Chief flow] roam_undo: data.undo() returned:", result);
        await new Promise(r => setTimeout(r, 150));
        return { success: true, action: "undo" };
      }
    },
    {
      name: "roam_redo",
      isMutating: true,
      description: "Redo the last undone action in Roam. Use when the user asks to redo something they just undid.",
      input_schema: { type: "object", properties: {} },
      execute: async () => {
        const api = deps.getRoamAlphaApi();
        if (!api?.data?.redo) {
          throw new Error("Roam redo API unavailable");
        }
        const result = await api.data.redo();
        deps.debugLog("[Chief flow] roam_redo: data.redo() returned:", result);
        await new Promise(r => setTimeout(r, 150));
        return { success: true, action: "redo" };
      }
    },
    {
      name: "roam_get_focused_block",
      isMutating: false,
      description: "Get the block currently focused (being edited) in Roam.",
      input_schema: { type: "object", properties: {} },
      execute: async () => {
        const api = deps.getRoamAlphaApi();
        if (!api?.ui?.getFocusedBlock) throw new Error("Roam getFocusedBlock API unavailable");
        const result = api.ui.getFocusedBlock();
        if (!result || !result["block-uid"]) return { focused: false };
        return { focused: true, uid: result["block-uid"] };
      }
    },
    {
      name: "roam_open_right_sidebar",
      isMutating: false,
      description: "Open the right sidebar in Roam.",
      input_schema: { type: "object", properties: {} },
      execute: async () => {
        const api = deps.getRoamAlphaApi();
        if (!api?.ui?.rightSidebar?.open) throw new Error("Roam right sidebar open API unavailable");
        await api.ui.rightSidebar.open();
        return { success: true };
      }
    },
    {
      name: "roam_close_right_sidebar",
      isMutating: false,
      description: "Close the right sidebar in Roam.",
      input_schema: { type: "object", properties: {} },
      execute: async () => {
        const api = deps.getRoamAlphaApi();
        if (!api?.ui?.rightSidebar?.close) throw new Error("Roam right sidebar close API unavailable");
        await api.ui.rightSidebar.close();
        return { success: true };
      }
    },
    {
      name: "roam_open_left_sidebar",
      isMutating: false,
      description: "Open the left sidebar in Roam (navigation panel with daily notes, graph overview, shortcuts, etc.).",
      input_schema: { type: "object", properties: {} },
      execute: async () => {
        const api = deps.getRoamAlphaApi();
        if (!api?.ui?.leftSidebar?.open) throw new Error("Roam left sidebar open API unavailable");
        await api.ui.leftSidebar.open();
        return { success: true };
      }
    },
    {
      name: "roam_close_left_sidebar",
      isMutating: false,
      description: "Close the left sidebar in Roam (navigation panel).",
      input_schema: { type: "object", properties: {} },
      execute: async () => {
        const api = deps.getRoamAlphaApi();
        if (!api?.ui?.leftSidebar?.close) throw new Error("Roam left sidebar close API unavailable");
        await api.ui.leftSidebar.close();
        return { success: true };
      }
    },
    {
      name: "roam_get_right_sidebar_windows",
      isMutating: false,
      description: "Get the list of currently open right sidebar windows in Roam.",
      input_schema: { type: "object", properties: {} },
      execute: async () => {
        const api = deps.getRoamAlphaApi();
        if (!api?.ui?.rightSidebar?.getWindows) throw new Error("Roam sidebar API unavailable");
        const windows = api.ui.rightSidebar.getWindows();
        if (!Array.isArray(windows) || !windows.length) return { windows: [] };
        const items = windows.map(w => ({
          type: w?.type || w?.["window-type"] || "unknown",
          uid: w?.["block-uid"] || w?.["page-uid"] || w?.uid || null,
          order: w?.order ?? null
        }));
        return { count: items.length, windows: items };
      }
    },
    {
      name: "roam_add_right_sidebar_window",
      isMutating: false,
      description: "Add a window to the right sidebar. Supports outline, block, mentions, graph, and search-query types.",
      input_schema: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["mentions", "block", "outline", "graph", "search-query"], description: "Window type." },
          block_uid: { type: "string", description: "Block or page UID. Required for all types except search-query." },
          search_query: { type: "string", description: "Search string. Required when type is search-query." },
          order: { type: "number", description: "Position in sidebar. Optional — defaults to top." }
        },
        required: ["type"]
      },
      execute: async ({ type, block_uid, search_query, order } = {}) => {
        const api = deps.getRoamAlphaApi();
        if (!api?.ui?.rightSidebar?.addWindow) throw new Error("Roam sidebar addWindow API unavailable");
        const windowDef = { type };
        if (type === "search-query") {
          if (!search_query) throw new Error("search_query is required for search-query type");
          windowDef["search-query-str"] = search_query;
        } else {
          if (!block_uid) throw new Error("block_uid is required for this window type");
          // Resolve page title to UID if needed (LLMs often pass titles instead of UIDs)
          let resolvedUid = block_uid;
          const looksLikeUid = /^[a-zA-Z0-9_-]{9,10}$/.test(block_uid);
          if (!looksLikeUid) {
            // Strip [[ ]] wrapper if present
            const cleanTitle = block_uid.replace(/^\[\[/, "").replace(/\]\]$/, "").trim();
            try {
              const rows = await deps.queryRoamDatalog(`[:find ?uid :where [?p :node/title "${deps.escapeForDatalog(cleanTitle)}"] [?p :block/uid ?uid]]`);
              if (rows && rows.length > 0 && rows[0][0]) {
                resolvedUid = rows[0][0];
              } else {
                throw new Error(`Could not find page with title "${cleanTitle}" — provide a valid block or page UID`);
              }
            } catch (e) {
              if (e.message.includes("Could not find page")) throw e;
              throw new Error(`Failed to resolve "${block_uid}" to a UID: ${e.message}`);
            }
          }
          windowDef["block-uid"] = resolvedUid;
        }
        if (order != null) windowDef.order = order;
        // Ensure sidebar is open before adding a window (open() is idempotent — no-op if already open)
        if (api.ui.rightSidebar.open) await api.ui.rightSidebar.open();
        await api.ui.rightSidebar.addWindow({ window: windowDef });
        return { success: true, type, uid: windowDef["block-uid"] || search_query };
      }
    },
    {
      name: "roam_remove_right_sidebar_window",
      isMutating: false,
      description: "Remove a window from the right sidebar.",
      input_schema: {
        type: "object",
        properties: {
          type: { type: "string", enum: ["mentions", "block", "outline", "graph", "search-query"], description: "Window type." },
          block_uid: { type: "string", description: "Block or page UID. Required for all types except search-query." },
          search_query: { type: "string", description: "Search string. Required when type is search-query." }
        },
        required: ["type"]
      },
      execute: async ({ type, block_uid, search_query } = {}) => {
        const api = deps.getRoamAlphaApi();
        if (!api?.ui?.rightSidebar?.removeWindow) throw new Error("Roam sidebar removeWindow API unavailable");
        const windowDef = { type };
        if (type === "search-query") {
          if (!search_query) throw new Error("search_query is required for search-query type");
          windowDef["search-query-str"] = search_query;
        } else {
          if (!block_uid) throw new Error("block_uid is required for this window type");
          // Resolve page title to UID if needed (LLMs often pass titles instead of UIDs)
          let resolvedUid = block_uid;
          const looksLikeUid = /^[a-zA-Z0-9_-]{9,10}$/.test(block_uid);
          if (!looksLikeUid) {
            const cleanTitle = block_uid.replace(/^\[\[/, "").replace(/\]\]$/, "").trim();
            try {
              const rows = await deps.queryRoamDatalog(`[:find ?uid :where [?p :node/title "${deps.escapeForDatalog(cleanTitle)}"] [?p :block/uid ?uid]]`);
              if (rows && rows.length > 0 && rows[0][0]) {
                resolvedUid = rows[0][0];
              } else {
                throw new Error(`Could not find page with title "${cleanTitle}" — provide a valid block or page UID`);
              }
            } catch (e) {
              if (e.message.includes("Could not find page")) throw e;
              throw new Error(`Failed to resolve "${block_uid}" to a UID: ${e.message}`);
            }
          }
          windowDef["block-uid"] = resolvedUid;
        }
        await api.ui.rightSidebar.removeWindow({ window: windowDef });
        return { success: true, type, removed: windowDef["block-uid"] || search_query };
      }
    },

    // ---- Plain TODO management tools ----

    {
      name: "roam_search_todos",
      isMutating: false,
      description: "Search for TODO/DONE items in the Roam graph. Returns blocks containing {{[[TODO]]}} or {{[[DONE]]}} markers with page context. Use this for plain Roam checkboxes — not Better Tasks.",
      input_schema: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["TODO", "DONE", "ANY"], description: "Filter by status: TODO (open), DONE (completed), or ANY (both). Default TODO." },
          query: { type: "string", description: "Optional text to filter results. Case-insensitive substring match on block text." },
          page_title: { type: "string", description: "Limit search to tasks on a specific page (by exact title). Optional — searches all pages if omitted." },
          max_results: { type: "number", description: "Maximum results to return. Default 50." }
        }
      },
      execute: async ({ status = "TODO", query, page_title, max_results = 50 } = {}) => {
        const limit = Number.isFinite(max_results) ? Math.max(1, Math.min(500, max_results)) : 50;
        const hardCap = Math.max(200, limit);
        const statusFilter = String(status || "TODO").toUpperCase();

        let markerClause;
        if (statusFilter === "DONE") {
          markerClause = '[(clojure.string/includes? ?str "{{[[DONE]]}}")]';
        } else if (statusFilter === "ANY") {
          markerClause = '(or [(clojure.string/includes? ?str "{{[[TODO]]}}")] [(clojure.string/includes? ?str "{{[[DONE]]}}")])';
        } else {
          markerClause = '[(clojure.string/includes? ?str "{{[[TODO]]}}")]';
        }

        let pageClause = "";
        if (page_title) {
          const escapedTitle = deps.escapeForDatalog(String(page_title).trim());
          pageClause = `[?page :node/title "${escapedTitle}"]`;
        }

        // NOTE: clojure.string/lower-case is broken in Roam's Datascript engine.
        // Use (or ...) with case variants and filter in JS.
        let textFilter = "";
        const queryText = String(query || "").trim().toLowerCase();
        if (queryText) {
          const originalCase = deps.escapeForDatalog(String(query || "").trim());
          const lowerCase = deps.escapeForDatalog(queryText);
          const titleCase = deps.escapeForDatalog(
            String(query || "").trim().replace(/\b\w/g, c => c.toUpperCase())
          );
          const variants = [...new Set([originalCase, lowerCase, titleCase])];
          const orClauses = variants.map(v => `[(clojure.string/includes? ?str "${v}")]`).join("\n            ");
          textFilter = `(or
            ${orClauses})`;
        }

        const datalogQuery = `[:find ?uid ?str ?page-title
          :where
          [?b :block/string ?str]
          [?b :block/uid ?uid]
          [?b :block/page ?page]
          [?page :node/title ?page-title]
          ${markerClause}
          ${pageClause}
          ${textFilter}`;

        let results;
        try {
          results = await deps.queryRoamDatalog(`${datalogQuery}\n          :limit ${hardCap}]`);
        } catch (error) {
          console.warn("[Chief of Staff] Roam :limit unsupported; running unbounded roam_search_todos scan.");
          results = await deps.queryRoamDatalog(`${datalogQuery}]`);
        }

        const allResults = Array.isArray(results) ? results : [];
        return (queryText
          ? allResults.filter(([, text]) => text && text.toLowerCase().includes(queryText))
          : allResults)
          .slice(0, limit)
          .map(([uid, text, page]) => ({ uid, text, page }));
      }
    },
    {
      name: "roam_create_todo",
      isMutating: true,
      description: "Create a new TODO item as a block in Roam. The block text will be prefixed with {{[[TODO]]}}. By default places on today's daily page.",
      input_schema: {
        type: "object",
        properties: {
          text: { type: "string", description: "The TODO item text (without the {{[[TODO]]}} prefix — it will be added automatically)." },
          parent_uid: { type: "string", description: "Parent block or page UID to place the TODO under. If omitted, uses today's daily page." },
          order: { type: "string", description: "\"first\" or \"last\". Default \"last\"." }
        },
        required: ["text"]
      },
      execute: async ({ text, parent_uid, order = "last" } = {}) => {
        const todoText = String(text || "").trim();
        if (!todoText) throw new Error("text is required");

        let targetUid = String(parent_uid || "").trim();
        if (!targetUid) {
          const { pageUid } = await deps.ensureDailyPageUid();
          targetUid = pageUid;
        } else {
          deps.requireRoamUidExists(targetUid, "parent_uid");
        }

        const blockText = `{{[[TODO]]}} ${todoText}`;
        const uid = await deps.createRoamBlock(targetUid, blockText, order);
        return { success: true, uid, parent_uid: targetUid, text: blockText };
      }
    },
    {
      name: "roam_modify_todo",
      isMutating: true,
      description: "Modify an existing TODO/DONE item. Can toggle status between TODO and DONE, update the text, or both. Always re-search with roam_search_todos to get the current UID before modifying.",
      input_schema: {
        type: "object",
        properties: {
          uid: { type: "string", description: "Block UID of the TODO/DONE item to modify." },
          status: { type: "string", enum: ["TODO", "DONE"], description: "New status. Toggles the {{[[TODO]]}}/{{[[DONE]]}} marker." },
          text: { type: "string", description: "New text content (without the status marker — it will be managed automatically). If omitted, only status is changed." }
        },
        required: ["uid"]
      },
      execute: async ({ uid, status, text } = {}) => {
        const blockUid = String(uid || "").trim();
        if (!blockUid) throw new Error("uid is required");

        const currentText = await deps.queryRoamDatalog(
          `[:find ?str . :where [?b :block/uid "${deps.escapeForDatalog(blockUid)}"] [?b :block/string ?str]]`
        );
        if (currentText == null) throw new Error(`Block not found: ${blockUid}`);
        const blockStr = String(currentText);

        const todoMarker = "{{[[TODO]]}}";
        const doneMarker = "{{[[DONE]]}}";
        let currentStatus = null;
        if (blockStr.includes(todoMarker)) currentStatus = "TODO";
        else if (blockStr.includes(doneMarker)) currentStatus = "DONE";
        const stripped = blockStr.replaceAll(todoMarker, "").replaceAll(doneMarker, "").trim();

        const newStatus = status ? String(status).toUpperCase() : currentStatus;
        if (newStatus !== "TODO" && newStatus !== "DONE") {
          throw new Error("Block does not contain a TODO/DONE marker and no status was provided");
        }

        const newContent = (text != null) ? String(text).trim() : stripped;
        const newMarker = newStatus === "DONE" ? doneMarker : todoMarker;
        const newBlockStr = `${newMarker} ${newContent}`;

        const api = deps.requireRoamUpdateBlockApi(deps.getRoamAlphaApi());
        await deps.withRoamWriteRetry(() =>
          api.updateBlock({ block: { uid: blockUid, string: deps.truncateRoamBlockText(newBlockStr) } })
        );
        return {
          success: true,
          uid: blockUid,
          previous_status: currentStatus,
          new_status: newStatus,
          text: newBlockStr.slice(0, 200)
        };
      }
    }
  ];
  return roamNativeToolsCache;
}
