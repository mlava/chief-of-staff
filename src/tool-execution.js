/**
 * tool-execution.js — Tool execution dispatcher, approval gating, LLM response
 * parsing, message format conversion, write detection, and Composio session helpers.
 *
 * Extracted from index.js. All external dependencies are injected via initToolExecution().
 */

// ── Module-scoped state ──────────────────────────────────────────────────────
const TOOL_APPROVAL_TTL_MS = 15 * 60 * 1000; // 15 minutes
const approvedToolsThisSession = new Map(); // approvalKey -> approvedAt timestamp
const approvedWritePageUids = new Map(); // pageUid -> approvedAt timestamp (scoped page approval for create tools)

// ── Dependencies (injected via init) ────────────────────────────────────────
let deps = {};

export function initToolExecution(injected) {
  deps = injected;
}

// ── Approval management ─────────────────────────────────────────────────────

export function clearToolApprovals() {
  approvedToolsThisSession.clear();
  approvedWritePageUids.clear();
}

function pruneExpiredToolApprovals(now = Date.now()) {
  for (const [approvalKey, approvedAt] of approvedToolsThisSession.entries()) {
    if (!Number.isFinite(approvedAt) || (now - approvedAt) >= TOOL_APPROVAL_TTL_MS) {
      approvedToolsThisSession.delete(approvalKey);
    }
  }
  for (const [pageUid, approvedAt] of approvedWritePageUids.entries()) {
    if (!Number.isFinite(approvedAt) || (now - approvedAt) >= TOOL_APPROVAL_TTL_MS) {
      approvedWritePageUids.delete(pageUid);
    }
  }
}

export function hasValidToolApproval(approvalKey, now = Date.now()) {
  pruneExpiredToolApprovals(now);
  const approvedAt = approvedToolsThisSession.get(approvalKey);
  if (!Number.isFinite(approvedAt)) return false;
  return (now - approvedAt) < TOOL_APPROVAL_TTL_MS;
}

function rememberToolApproval(approvalKey, now = Date.now()) {
  pruneExpiredToolApprovals(now);
  approvedToolsThisSession.set(approvalKey, now);
}

function hasPageWriteApproval(pageUid, now = Date.now()) {
  const approvedAt = approvedWritePageUids.get(pageUid);
  if (!Number.isFinite(approvedAt)) return false;
  return (now - approvedAt) < TOOL_APPROVAL_TTL_MS;
}

function rememberPageWriteApproval(pageUids, now = Date.now()) {
  for (const uid of pageUids) {
    approvedWritePageUids.set(uid, now);
  }
}

// ── Fuzzy tool name matching ────────────────────────────────────────────────

/**
 * Find the closest matching tool name for a hallucinated name.
 * Uses word-overlap scoring: splits both names on _ and scores shared words.
 * Returns the best match if it shares at least 2 words with the query, else null.
 */
export function findClosestToolName(query, knownNames) {
  if (!query || !knownNames?.length) return null;
  const qWords = query.toLowerCase().split("_").filter(Boolean);
  let bestName = null;
  let bestScore = 0;
  for (const name of knownNames) {
    const nWords = name.toLowerCase().split("_").filter(Boolean);
    // Count shared words
    let shared = 0;
    for (const w of qWords) {
      if (nWords.includes(w)) shared++;
    }
    // Prefer matches with more shared words; break ties by shorter total length diff
    if (shared > bestScore || (shared === bestScore && bestName && Math.abs(name.length - query.length) < Math.abs(bestName.length - query.length))) {
      bestScore = shared;
      bestName = name;
    }
  }
  // Require at least 2 shared words to suggest (avoids spurious matches)
  return bestScore >= 2 ? bestName : null;
}

// ── Composio read-only slug classification ──────────────────────────────────

function isLikelyReadOnlyToolSlug(toolSlug) {
  const slug = String(toolSlug || "").toUpperCase();
  if (!slug) return false;
  const mutatingTokens = ["DELETE", "REMOVE", "SEND", "CREATE", "UPDATE", "MODIFY", "WRITE", "POST", "TRASH", "MOVE", "EXECUTE"];
  if (mutatingTokens.some((token) => slug.includes(token))) return false;
  const readTokens = [
    "GET",
    "LIST",
    "SEARCH",
    "FIND",
    "FETCH",
    "READ",
    "QUERY",
    "LOOKUP",
    "RETRIEVE",
    "VIEW",
    "DESCRIBE",
    "DETAILS",
    "SHOW"
  ];
  return readTokens.some((token) => slug.includes(token));
}

function getUnknownMultiExecuteToolSlugs(args) {
  const tools = Array.isArray(args?.tools) ? args.tools : [];
  return tools
    .map((tool) => String(tool?.tool_slug || "").toUpperCase().trim())
    .filter(Boolean)
    .filter((slug) => !deps.getComposioSafeMultiExecuteSlugAllowlist().has(slug));
}

async function confirmUnknownMultiExecuteToolSlugs(args) {
  const unknownSlugs = getUnknownMultiExecuteToolSlugs(args);
  if (!unknownSlugs.length) return true;
  return deps.promptToolExecutionApproval("COMPOSIO_MULTI_EXECUTE_TOOL (unknown slugs)", {
    unknown_tool_slugs: unknownSlugs
  });
}

// ── Tool resolution ─────────────────────────────────────────────────────────

export function resolveToolByName(toolName) {
  return deps.getRoamNativeTools().find(t => t.name === toolName)
    || deps.getBetterTasksTools().find(t => t.name === toolName)
    || deps.getCosIntegrationTools().find(t => t.name === toolName)
    || deps.getCronTools().find(t => t.name === toolName)
    || deps.getExternalExtensionTools().find(t => t.name === toolName)
    || (deps.getLocalMcpToolsCache() || []).find(t => t.name === toolName)
    || deps.getComposioMetaToolsForLlm().find(t => t.name === toolName)
    || null;
}

// ── Mutation classification ─────────────────────────────────────────────────

// Regex patterns for heuristic read-only detection. Uses (?:^|[^a-zA-Z0-9]) instead of \b
// because \b treats _ as a word character, missing tokens in names like "zotero_get_collections".
const readOnlyTokenPattern = /(?:^|[^a-zA-Z0-9])(GET|LIST|SEARCH|FETCH|STATUS|CHECK|READ|QUERY|FIND|DESCRIBE)(?:[^a-zA-Z0-9]|$)/i;
const readOnlyTokenPatternShort = /(?:^|[^a-zA-Z0-9])(GET|LIST|SEARCH|FETCH|STATUS|CHECK)(?:[^a-zA-Z0-9]|$)/i;

export function isPotentiallyMutatingTool(toolName, args, toolObj) {
  const name = String(toolName || "").toUpperCase();
  if (!name) return false;

  // Priority 1: explicit isMutating flag on the tool object.
  // Covers all Roam native, COS, cron, BT, annotated local MCP, and extension tools
  // with readOnly hint (translated to isMutating during discovery).
  const tool = toolObj || resolveToolByName(toolName);
  if (tool && typeof tool.isMutating === "boolean") {
    return tool.isMutating;
  }

  // Priority 2: args-dependent meta-tools (no static isMutating).

  if (name.includes("MANAGE_CONNECTIONS")) {
    const action = String(args?.action || "").toLowerCase();
    const safeManageActions = new Set(["list", "status", "check", "get"]);
    return !safeManageActions.has(action);
  }

  if (name === "COMPOSIO_MULTI_EXECUTE_TOOL") {
    const tools = Array.isArray(args?.tools) ? args.tools : [];
    if (!tools.length) return true;
    const allReadOnly = tools.every((t) => isLikelyReadOnlyToolSlug(t?.tool_slug));
    return !allReadOnly;
  }

  // LOCAL_MCP_EXECUTE: check inner tool's isMutating / heuristic
  if (name === "LOCAL_MCP_EXECUTE") {
    const innerName = String(args?.tool_name || "");
    if (!innerName) return true;
    const cache = deps.getLocalMcpToolsCache() || [];
    const innerTool = cache.find(t => t.name === innerName);
    if (innerTool && typeof innerTool.isMutating === "boolean") {
      return innerTool.isMutating;
    }
    return !readOnlyTokenPattern.test(innerName);
  }

  // Priority 3: heuristic fallback for tools with isMutating undefined
  // (external extension tools that haven't opted in, unannotated local MCP tools).

  const externalTools = deps.getExternalExtensionTools();
  if (externalTools.some(t => t.name.toUpperCase() === name)) {
    return !readOnlyTokenPatternShort.test(name);
  }

  const localTools = deps.getLocalMcpToolsCache() || [];
  if (localTools.some(t => t.name.toUpperCase() === name)) {
    return !readOnlyTokenPattern.test(name);
  }

  // Final fallback: sensitive-token check for completely unknown tools
  const sensitiveTokens = [
    "CREATE", "MODIFY", "UPDATE", "DELETE", "REMOVE",
    "SEND", "POST", "WRITE", "MUTATE", "DISCONNECT",
    "CONNECT", "EXECUTE"
  ];
  return sensitiveTokens.some((token) => name.includes(token));
}

// ── Scoped page approval ────────────────────────────────────────────────────

// These tools use page-scoped approval: first write to a page needs user confirmation,
// subsequent writes to the same page within TTL are auto-approved.
const SCOPED_PAGE_APPROVAL_TOOLS = new Set([
  "roam_create_block", "roam_create_blocks", "roam_batch_write"
]);

function resolvePageUidForBlock(blockUid) {
  // Given a UID, return the page-level UID it belongs to.
  // If the UID itself is a page, return it directly.
  const api = deps.getRoamAlphaApi();
  if (!api?.q) return blockUid;
  const escaped = deps.escapeForDatalog(blockUid);
  // Check if this UID is already a page
  const isPage = api.q(`[:find ?t . :where [?e :block/uid "${escaped}"] [?e :node/title ?t]]`);
  if (isPage) return blockUid;
  // Otherwise, find the page this block belongs to
  const pageUid = api.q(`[:find ?pu . :where [?b :block/uid "${escaped}"] [?b :block/page ?p] [?p :block/uid ?pu]]`);
  return pageUid || blockUid;
}

function extractTargetPageUids(toolName, args) {
  // Extract all page UIDs that a create tool will write to.
  const parentUid = String(args?.parent_uid || "").trim();
  if (toolName === "roam_create_blocks" && Array.isArray(args?.batches)) {
    // Multi-location mode: each batch has its own parent_uid
    const uids = new Set();
    for (const batch of args.batches) {
      const batchUid = String(batch?.parent_uid || "").trim();
      if (batchUid) uids.add(resolvePageUidForBlock(batchUid));
    }
    // Also include top-level parent_uid if present
    if (parentUid) uids.add(resolvePageUidForBlock(parentUid));
    return [...uids];
  }
  if (parentUid) return [resolvePageUidForBlock(parentUid)];
  return [];
}

// ── Main tool execution dispatcher ──────────────────────────────────────────

export async function executeToolCall(toolName, args, { readOnly = false } = {}) {
  // Tool name normalisation: LLMs (especially gemini-2.5-flash) sometimes hallucinate
  // hyphens in tool names (e.g. "cos_get-current-time" instead of "cos_get_current_time").
  // Normalise hyphens to underscores before dispatch to catch these cases.
  const normalisedToolName = String(toolName || "").replace(/-/g, "_");
  if (normalisedToolName !== String(toolName || "")) {
    deps.debugLog(`[Chief flow] Tool name normalised: "${toolName}" → "${normalisedToolName}"`);
  }
  toolName = normalisedToolName;
  const upperToolName = normalisedToolName.toUpperCase();
  let effectiveArgs = args || {};
  if (upperToolName === "COMPOSIO_MULTI_EXECUTE_TOOL") {
    deps.debugLog("[Chief flow] MULTI_EXECUTE raw args:", JSON.stringify(args, null, 2));
    effectiveArgs = deps.normaliseComposioMultiExecuteArgs(effectiveArgs);
    deps.debugLog("[Chief flow] MULTI_EXECUTE normalised args:", JSON.stringify(effectiveArgs, null, 2));

    // Intercept: if tool slugs match local extension tools, execute locally
    // instead of routing through Composio. This handles LLM confusion where it wraps
    // local extension tools (e.g. cc_convert) in COMPOSIO_MULTI_EXECUTE_TOOL.
    const extTools = deps.getExternalExtensionTools();
    const batchTools = Array.isArray(effectiveArgs?.tools) ? effectiveArgs.tools : [];
    if (batchTools.length > 0) {
      const findLocalTool = (slug) => {
        const lower = slug.toLowerCase();
        return extTools.find(et => et.name.toLowerCase() === lower
          || lower.endsWith("_" + et.name.toLowerCase()));
      };
      const findRegistryTool = (slug) => {
        // Check raw registry for tools that exist but may lack execute (diagnostic)
        const lower = slug.toLowerCase();
        const registry = deps.getExtensionToolsRegistry();
        for (const [, ext] of Object.entries(registry)) {
          if (!ext || !Array.isArray(ext.tools)) continue;
          for (const t of ext.tools) {
            if (!t?.name) continue;
            if (t.name.toLowerCase() === lower || lower.endsWith("_" + t.name.toLowerCase())) return t;
          }
        }
        return null;
      };

      const localMatches = batchTools.map(bt => findLocalTool(String(bt?.tool_slug || "")));
      if (localMatches.every(Boolean)) {
        deps.debugLog("[Chief flow] MULTI_EXECUTE intercepted — all slugs match local extension tools, executing locally");
        const results = [];
        for (let i = 0; i < batchTools.length; i++) {
          const localTool = localMatches[i];
          const toolArgs = batchTools[i]?.arguments || {};
          try {
            const result = await localTool.execute(toolArgs);
            results.push({ tool: localTool.name, result });
          } catch (e) {
            results.push({ tool: localTool.name, error: e?.message || `Failed: ${localTool.name}` });
          }
        }
        return { successful: true, data: { results } };
      }

      // Check if slugs match registry tools that lack execute functions — return clear error
      const registryMatches = batchTools.map(bt => findRegistryTool(String(bt?.tool_slug || "")));
      const missingExecute = registryMatches.filter((t, i) => t && !localMatches[i]);
      if (missingExecute.length > 0) {
        const names = missingExecute.map(t => t.name).join(", ");
        deps.debugLog(`[Chief flow] MULTI_EXECUTE blocked — tools found in registry but missing execute(): ${names}`);
        return {
          successful: false,
          data: {
            error: `Tools ${names} are registered in RoamExtensionTools but missing an execute() function. The extension author needs to add execute() to each tool.`
          }
        };
      }
    }

    const unknownApproved = await confirmUnknownMultiExecuteToolSlugs(effectiveArgs);
    if (!unknownApproved) {
      throw new Error("User denied unknown tool slugs in COMPOSIO_MULTI_EXECUTE_TOOL");
    }
  }

  // ── Composio slug interceptor ──────────────────────────────────────────────
  // LLMs sometimes call Composio tool slugs (e.g. GMAIL_FETCH_EMAILS) directly
  // instead of wrapping them in COMPOSIO_MULTI_EXECUTE_TOOL. Detect this and
  // auto-rewrite so the call succeeds via the Composio MCP transport.
  const preResolvedTool = resolveToolByName(toolName);
  if (!preResolvedTool && upperToolName && /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(upperToolName)) {
    const matchedSchema = deps.getToolSchema(upperToolName);
    if (matchedSchema) {
      deps.debugLog(`[Chief flow] Composio slug interceptor: rewriting direct call "${toolName}" → COMPOSIO_MULTI_EXECUTE_TOOL`);
      const wrappedArgs = {
        tools: [{ tool_slug: upperToolName, arguments: effectiveArgs }]
      };
      return executeToolCall("COMPOSIO_MULTI_EXECUTE_TOOL", wrappedArgs, { readOnly });
    }
  }

  const resolvedTool = preResolvedTool;
  const isMutating = isPotentiallyMutatingTool(toolName, effectiveArgs, resolvedTool);

  // Defence-in-depth: block tools not on the read-only allowlist when the agent loop
  // is in read-only mode (inbox-triggered). Primary enforcement is tool filtering in
  // runAgentLoop; this catches edge cases like hallucinated tool names.
  // Extension tools with explicit readOnly: true (isMutating === false) are auto-allowed.
  if (readOnly && !deps.INBOX_READ_ONLY_TOOL_ALLOWLIST.has(toolName)) {
    const isExplicitlyReadOnly = resolvedTool && resolvedTool.isMutating === false;
    if (!isExplicitlyReadOnly) {
      return { error: "Read-only mode: this tool is blocked for inbox-triggered requests. Summarise your findings for the human to act on." };
    }
  }

  const extensionAPI = deps.getExtensionAPI();
  if (isMutating && extensionAPI && deps.isDryRunEnabled(extensionAPI)) {
    deps.consumeDryRunMode(extensionAPI);
    deps.showInfoToast("Dry run", `Simulated mutating call: ${toolName}`);
    return {
      dry_run: true,
      simulated: true,
      tool_name: toolName,
      arguments: effectiveArgs
    };
  }

  // For meta-tools, key approval on the specific inner tool/slug
  // so approving e.g. GMAIL_SEND doesn't silently approve GOOGLECALENDAR_DELETE.
  const approvalKey = toolName === "COMPOSIO_MULTI_EXECUTE_TOOL"
    ? `${toolName}::${(Array.isArray(effectiveArgs?.tools) ? effectiveArgs.tools : []).map(t => t?.tool_slug || "").filter(Boolean).sort().join(",")}`
    : toolName === "LOCAL_MCP_EXECUTE"
      ? `LOCAL_MCP_EXECUTE::${effectiveArgs?.tool_name || ""}`
      : toolName;
  const now = Date.now();
  if (isMutating) {
    // Scoped page approval for block-creation tools: approve once per page,
    // then subsequent writes to that same page are auto-approved within TTL.
    if (SCOPED_PAGE_APPROVAL_TOOLS.has(toolName)) {
      const targetPageUids = extractTargetPageUids(toolName, effectiveArgs);
      const unapprovedPages = targetPageUids.filter(uid => !hasPageWriteApproval(uid, now));
      if (unapprovedPages.length > 0) {
        const approved = await deps.promptToolExecutionApproval(toolName, effectiveArgs);
        if (!approved) {
          throw new Error(`User denied execution for ${toolName}`);
        }
        // Approve all target pages (including already-approved ones, to refresh TTL)
        rememberPageWriteApproval(targetPageUids, Date.now());
        deps.debugLog("[Chief flow] Page write approved for UIDs (15m TTL):", targetPageUids.join(", "));
      } else {
        deps.debugLog("[Chief flow] Page write auto-approved (previously approved pages):", targetPageUids.join(", "));
      }
    } else if (!hasValidToolApproval(approvalKey, now)) {
      const approved = await deps.promptToolExecutionApproval(toolName, effectiveArgs);
      if (!approved) {
        throw new Error(`User denied execution for ${toolName}`);
      }
      rememberToolApproval(approvalKey, Date.now());
      deps.debugLog("[Chief flow] Tool approved and whitelisted for session (15m TTL):", approvalKey);
    }
  }

  // LOCAL_MCP_ROUTE discovery tool: returns a server's tool catalog from cache
  if (toolName === "LOCAL_MCP_ROUTE") {
    deps.setSessionUsedLocalMcp(true);
    return deps.buildLocalMcpRouteTool().execute(effectiveArgs || {});
  }

  // LOCAL_MCP_EXECUTE meta-tool: dispatch to the inner tool by name
  if (toolName === "LOCAL_MCP_EXECUTE") {
    deps.setSessionUsedLocalMcp(true);
    const innerName = effectiveArgs?.tool_name;
    if (!innerName) throw new Error("LOCAL_MCP_EXECUTE requires tool_name");
    const cache = deps.getLocalMcpToolsCache() || [];
    // Exact match first, then try stripping server-name prefix (LLMs sometimes send "server.tool_name")
    let tool = cache.find(t => t.name === innerName);
    if (!tool) {
      const dotIdx = innerName.indexOf(".");
      if (dotIdx > 0) {
        const stripped = innerName.slice(dotIdx + 1);
        tool = cache.find(t => t.name === stripped);
        if (tool) deps.debugLog(`[Local MCP] META normalised "${innerName}" → "${stripped}"`);
      }
    }
    if (!tool) {
      // Fuzzy match: find the closest tool name and suggest it in the error
      const allNames = cache.map(t => t.name);
      const closest = findClosestToolName(innerName, allNames);
      const suggestion = closest ? ` Did you mean "${closest}"?` : "";
      deps.debugLog(`[Local MCP] META tool not found: "${innerName}", closest: ${closest || "(none)"}`);
      return { error: `Tool "${innerName}" not found.${suggestion} Use LOCAL_MCP_ROUTE to discover available tools.` };
    }
    // Pre-validate: reject path-style or display-name values in key/ID parameters.
    // Models frequently invent "parentKey/childName" paths or pass display names
    // instead of the actual alphanumeric key — each failed attempt costs a full LLM iteration.
    const innerArgs = effectiveArgs.arguments || {};
    const schemaProps = tool.input_schema?.properties;
    if (schemaProps) {
      for (const [pName] of Object.entries(schemaProps)) {
        if (!/(?:_key|_id|Key|Id)$/i.test(pName)) continue;
        const val = innerArgs[pName];
        if (typeof val !== "string") continue;
        if (val.includes("/")) {
          deps.debugLog(`[Local MCP] Rejected path-style key: ${pName}="${val}"`);
          return {
            error: `Parameter "${pName}" received "${val}" which looks like a path. `
              + `This parameter expects a single alphanumeric identifier (e.g. "NADHRMVD"), not a path. `
              + `Check the collection tree or conversation context [Key reference: ...] for the correct key.`
          };
        }
        if (val.includes(" ")) {
          deps.debugLog(`[Local MCP] Rejected display-name key: ${pName}="${val}"`);
          return {
            error: `Parameter "${pName}" received "${val}" which looks like a display name. `
              + `This parameter expects a single alphanumeric identifier (e.g. "NADHRMVD"), not a name. `
              + `Check the collection tree or conversation context [Key reference: ...] for the correct key.`
          };
        }
      }
    }
    deps.debugLog(`[Local MCP] META dispatch: ${tool.name}`, innerArgs);
    return tool.execute(innerArgs);
  }

  const roamTool = resolvedTool;
  if (roamTool?.execute) {
    // Track direct MCP tool usage so sessionUsedLocalMcp is set for follow-up routing
    if (roamTool._isDirect && roamTool._serverName) deps.setSessionUsedLocalMcp(true);
    // Invalidate BT project cache when a BT write tool fires (project counts may change)
    if (deps.getBtProjectsCache() && toolName.startsWith("roam_bt_") && !toolName.includes("search") && !toolName.includes("get_")) {
      deps.setBtProjectsCache(null);
    }
    return roamTool.execute(args || {});
  }

  const mcpClientRef = deps.getMcpClient();
  if (!mcpClientRef?.callTool) {
    throw new Error("MCP client not connected");
  }
  const result = await mcpClientRef.callTool({
    name: toolName,
    arguments: effectiveArgs
  });
  const text = result?.content?.[0]?.text;
  if (typeof text === "string") {
    try {
      const parsed = JSON.parse(text);
      // Record response shape for Composio tool calls
      if (upperToolName === "COMPOSIO_MULTI_EXECUTE_TOOL" && parsed?.successful) {
        const slugs = Array.isArray(effectiveArgs?.tools)
          ? effectiveArgs.tools.map(t => t?.tool_slug).filter(Boolean)
          : [];
        slugs.forEach(slug => deps.recordToolResponseShape(slug, parsed));
      }
      return parsed;
    } catch (error) {
      return { text };
    }
  }
  return result;
}

// ── LLM response parsing ────────────────────────────────────────────────────

export function extractToolCalls(provider, response) {
  if (provider === "anthropic") {
    return (response?.content || [])
      .filter((block) => block?.type === "tool_use")
      .map((block) => ({
        id: block.id,
        name: block.name,
        arguments: block.input || {}
      }));
  }
  if (deps.isOpenAICompatible(provider)) {
    const message = response?.choices?.[0]?.message;
    const rawCalls = message?.tool_calls;
    return (Array.isArray(rawCalls) ? rawCalls : []).map((toolCall) => {
      let parsedArgs = {};
      try {
        parsedArgs = JSON.parse(toolCall?.function?.arguments || "{}");
      } catch (error) {
        parsedArgs = {};
      }
      return {
        id: toolCall.id,
        name: toolCall?.function?.name,
        arguments: parsedArgs
      };
    });
  }
  return [];
}

export function extractTextResponse(provider, response) {
  if (provider === "anthropic") {
    return (response?.content || [])
      .filter((block) => block?.type === "text")
      .map((block) => block.text || "")
      .join("\n")
      .trim();
  }
  if (deps.isOpenAICompatible(provider)) {
    return String(response?.choices?.[0]?.message?.content || "").trim();
  }
  return "";
}

// ── Live data guard ─────────────────────────────────────────────────────────

export function isLikelyLiveDataReadIntent(userMessage, options = {}) {
  const text = String(userMessage || "").toLowerCase().trim();
  if (!text) return false;

  // Skill update/edit requests are not live data reads even if they mention calendar/email
  if (/\b(update|edit|improve|optimise|optimize|change|modify)\b.*\bskill\b/i.test(text)) return false;
  if (/\bskill\b.*\b(update|edit|improve|optimise|optimize|change|modify)\b/i.test(text)) return false;

  // Capability / meta questions about tool access are not live data reads
  // e.g. "do you have access to github?", "are you connected to zotero?"
  if (/\bhave access to\b/i.test(text)) return false;
  if (/\bare you connected to\b/i.test(text)) return false;
  if (/\b(do i have|do you have|is there|are there)\b.*\btools?\b/i.test(text)) return false;
  if (/\bwhat (tools?|capabilities|integrations?)\b/i.test(text)) return false;

  // Meta / reflective questions about prompting, strategy, or past interactions are not live data reads.
  if (/\b(what prompt|how should|how do i|how would|how can i|why did you|what went wrong|what happened|could you have|would have helped|should have|better way to|best way to)\b/i.test(text)) return false;
  if (/\b(help|advice|tips?|suggest|recommendation|explain|teach)\b.*\b(prompt|phras|ask|request|approach|strateg|technique)\b/i.test(text)) return false;

  const explicitPhrases = [
    "most recent emails",
    "latest emails",
    "recent emails",
    "my inbox",
    "unread emails",
    "what's on my calendar",
    "whats on my calendar",
    "calendar today",
    "calendar tomorrow",
    "upcoming events",
    "my schedule",
    "connected tools",
    "connection status",
    "connected accounts"
  ];
  if (explicitPhrases.some((phrase) => text.includes(phrase))) return true;

  const readVerbs = ["what", "show", "list", "summar", "find", "fetch", "get", "check", "search", "do", "does", "have", "has", "any", "tell", "how", "which", "who", "where"];
  const actionVerbs = [
    "run",
    "execute",
    "call",
    "use",
    "delete",
    "remove",
    "archive",
    "trash",
    "reply",
    "send",
    "compose",
    "draft",
    "mark",
    "move",
    "update",
    "edit",
    "cancel",
    "reschedule",
    "connect",
    "disconnect",
    "create",
    "add"
  ];
  const liveDataNouns = [
    "email",
    "emails",
    "inbox",
    "calendar",
    "event",
    "events",
    "schedule",
    "message",
    "messages",
    "connection",
    "connections",
    "account",
    "accounts",
    "slack",
    "gmail",
    "jira",
    "github",
    // Generic external-data nouns — these signal queries about data in external systems
    "collection",
    "collections",
    "item",
    "items",
    "library",
    "libraries",
    "repo",
    "repository",
    "repositories",
    "issue",
    "issues",
    "paper",
    "papers",
    "article",
    "articles",
    "document",
    "documents",
    "file",
    "files",
    "folder",
    "folders",
    "project",
    "projects",
    "commit",
    "commits",
    "branch",
    "branches",
    "citation",
    "citations",
    "reference",
    "references"
  ];

  // Dynamically add local MCP server names so queries like "list my zotero libraries"
  // trigger the guard (e.g. "zotero", "scholar-sidekick" → split on hyphens too).
  for (const [, entry] of deps.getLocalMcpClients()) {
    if (!entry?.serverName) continue;
    const sn = entry.serverName.toLowerCase();
    liveDataNouns.push(sn);
    // Also add individual words from hyphenated names (e.g. "scholar-sidekick" → "scholar", "sidekick")
    for (const part of sn.split(/[-_]/)) {
      if (part.length > 2 && !liveDataNouns.includes(part)) liveDataNouns.push(part);
    }
  }

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const wordMatch = (word) => new RegExp(`\\b${escapeRe(word)}\\b`).test(text);
  const hasReadVerb = readVerbs.some(wordMatch);
  const hasActionVerb = actionVerbs.some(wordMatch);
  const hasLiveDataNoun = liveDataNouns.some(wordMatch);

  // In an active MCP session, any substantive query should trigger the guard.
  // Follow-ups often reference external data by context without matching specific nouns
  if (options.sessionUsedLocalMcp && (text.length > 30 || text.includes("?"))) return true;

  return hasLiveDataNoun && (hasReadVerb || hasActionVerb);
}

// ── External data classification ────────────────────────────────────────────

export function isExternalDataToolCall(toolName) {
  const name = String(toolName || "");
  if (!name) return false;
  const upper = name.toUpperCase();
  if (
    upper.startsWith("COMPOSIO_") ||
    upper.startsWith("COS_CRON_") ||
    upper === "COS_UPDATE_MEMORY" ||
    upper === "COS_GET_SKILL" ||
    upper === "ROAM_SEARCH" ||
    upper === "ROAM_GET_PAGE" ||
    upper === "ROAM_GET_DAILY_PAGE" ||
    upper === "ROAM_GET_BLOCK_CHILDREN" ||
    upper === "ROAM_GET_BLOCK_CONTEXT" ||
    upper === "ROAM_GET_PAGE_METADATA" ||
    upper === "ROAM_GET_RECENT_CHANGES" ||
    upper === "ROAM_GET_BACKLINKS" ||
    upper === "ROAM_SEARCH_TODOS" ||
    upper === "ROAM_LINK_SUGGESTIONS" ||
    upper === "ROAM_BT_SEARCH_TASKS" ||
    upper === "ROAM_SEARCH_BLOCKS" ||
    upper === "LOCAL_MCP_ROUTE" ||
    upper === "LOCAL_MCP_EXECUTE"
  ) return true;
  // Direct-call local MCP tools (from servers ≤15 tools, exposed by original name)
  const localToolsCache = deps.getLocalMcpToolsCache();
  if (Array.isArray(localToolsCache) && localToolsCache.some(t => t.name === name)) return true;
  // Extension tools (registered via window.RoamExtensionTools, e.g. wp_get_featured_article)
  const extTools = deps.getExternalExtensionTools();
  if (Array.isArray(extTools) && extTools.some(t => t.name === name)) return true;
  // Composio slug interceptor: LLM called a Composio slug directly (e.g. GMAIL_FETCH_EMAILS)
  // which the executeToolCall interceptor will rewrite to COMPOSIO_MULTI_EXECUTE_TOOL.
  if (/^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(upper) && deps.getToolSchema(upper)) return true;
  return false;
}

export function isSuccessfulExternalToolResult(result) {
  if (result == null) return false;
  if (typeof result !== "object") return true;
  const errorValue = result?.error;
  if (typeof errorValue === "string") return errorValue.trim().length === 0;
  return !Boolean(errorValue);
}

// ── Message formatting ──────────────────────────────────────────────────────

export function formatAssistantMessage(provider, response) {
  if (provider === "anthropic") {
    return { role: "assistant", content: response?.content || [] };
  }
  if (deps.isOpenAICompatible(provider)) {
    const msg = response?.choices?.[0]?.message;
    const result = { role: "assistant", content: msg?.content ?? "" };
    // Only include tool_calls when present and non-empty — OpenAI rejects tool_calls: []
    if (Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0) {
      result.tool_calls = msg.tool_calls;
    }
    return result;
  }
  return { role: "assistant", content: "" };
}

export function formatToolResults(provider, toolResults) {
  if (provider === "anthropic") {
    return [
      {
        role: "user",
        content: toolResults.map(({ toolCall, result }) => {
          const raw = deps.safeJsonStringify(result, deps.MAX_TOOL_RESULT_CHARS);
          return {
            type: "tool_result",
            tool_use_id: toolCall.id,
            content: isExternalDataToolCall(toolCall.name) ? deps.wrapUntrustedWithInjectionScan(`tool:${toolCall.name}`, raw) : raw
          };
        })
      }
    ];
  }
  if (deps.isOpenAICompatible(provider)) {
    return toolResults.map(({ toolCall, result }) => {
      const raw = deps.safeJsonStringify(result, deps.MAX_TOOL_RESULT_CHARS);
      return {
        role: "tool",
        tool_call_id: toolCall.id,
        content: isExternalDataToolCall(toolCall.name) ? deps.wrapUntrustedWithInjectionScan(`tool:${toolCall.name}`, raw) : raw
      };
    });
  }
  return [];
}

/**
 * Convert accumulated messages from Anthropic content-block format to OpenAI format.
 * Used during failover context carryover when switching from Anthropic to an OpenAI-compatible provider.
 */
function convertAnthropicToOpenAI(messages) {
  const result = [];
  // Anthropic tool IDs (toolu_XXX) can contain underscores and be too long for some providers.
  // Remap to short alphanumeric IDs and update both tool_calls and tool_results consistently.
  const idMap = {}; // { anthropicId: newShortId }
  let idCounter = 0;
  function remapId(anthropicId) {
    if (!idMap[anthropicId]) {
      const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
      let id = "c";
      let n = idCounter++;
      while (id.length < 9) { id += chars[n % chars.length]; n = Math.floor(n / chars.length) + id.length; }
      idMap[anthropicId] = id;
    }
    return idMap[anthropicId];
  }

  for (const msg of messages) {
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const textParts = msg.content.filter(b => b.type === "text").map(b => b.text || "");
      const toolUseBlocks = msg.content.filter(b => b.type === "tool_use");
      const converted = {
        role: "assistant",
        content: textParts.join("\n") || null
      };
      if (toolUseBlocks.length) {
        converted.tool_calls = toolUseBlocks.map(b => ({
          id: remapId(b.id),
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input || {}) }
        }));
      }
      result.push(converted);
    } else if (msg.role === "user" && Array.isArray(msg.content) && msg.content.some(b => b.type === "tool_result")) {
      // Anthropic tool results: single user message with tool_result blocks → multiple tool messages
      for (const block of msg.content) {
        if (block.type === "tool_result") {
          result.push({ role: "tool", tool_call_id: remapId(block.tool_use_id), content: typeof block.content === "string" ? block.content : JSON.stringify(block.content) });
        }
      }
    } else {
      // Regular user/system message — ensure content is a string
      result.push({ ...msg, content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) });
    }
  }
  return result;
}

/**
 * Convert accumulated messages from OpenAI format to Anthropic content-block format.
 * Used during failover context carryover when switching from an OpenAI-compatible provider to Anthropic.
 */
function convertOpenAIToAnthropic(messages) {
  const result = [];
  let pendingToolResults = [];

  function flushToolResults() {
    if (pendingToolResults.length > 0) {
      result.push({ role: "user", content: pendingToolResults });
      pendingToolResults = [];
    }
  }

  for (const msg of messages) {
    if (msg.role === "tool") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: msg.tool_call_id,
        content: msg.content || ""
      });
      continue;
    }
    flushToolResults();

    if (msg.role === "assistant") {
      const content = [];
      if (msg.content) content.push({ type: "text", text: msg.content });
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          let input = {};
          try {
            input = typeof tc.function?.arguments === "string"
              ? JSON.parse(tc.function.arguments)
              : (tc.function?.arguments || {});
          } catch { /* use empty object */ }
          content.push({ type: "tool_use", id: tc.id, name: tc.function?.name || tc.name, input });
        }
      }
      result.push({ role: "assistant", content });
    } else {
      // User or system message
      result.push({ ...msg, content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) });
    }
  }
  flushToolResults();
  return result;
}

/**
 * Convert messages between provider formats for failover context carryover.
 * Returns a new array — does not mutate the input.
 */
export function convertMessagesForProvider(messages, sourceProvider, targetProvider) {
  const sourceIsAnthropic = sourceProvider === "anthropic";
  const targetIsAnthropic = targetProvider === "anthropic";
  if (sourceIsAnthropic && !targetIsAnthropic) return convertAnthropicToOpenAI(messages);
  if (!sourceIsAnthropic && targetIsAnthropic) return convertOpenAIToAnthropic(messages);
  if (!sourceIsAnthropic && !targetIsAnthropic && sourceProvider !== targetProvider) {
    // Same format family but different providers (e.g. Mistral → OpenAI).
    // Normalise tool call IDs to call_N format and strip empty tool_calls arrays,
    // since providers may use incompatible ID formats.
    const idMap = {};
    let idCounter = 0;
    function remapId(origId) {
      if (!origId) return `call_${idCounter++}`;
      if (!idMap[origId]) idMap[origId] = `call_${idCounter++}`;
      return idMap[origId];
    }
    return messages.map(m => {
      const out = { ...m };
      if (out.role === "assistant") {
        if (Array.isArray(out.tool_calls) && out.tool_calls.length > 0) {
          out.tool_calls = out.tool_calls.map(tc => ({
            ...tc,
            id: remapId(tc.id)
          }));
        } else {
          delete out.tool_calls;
        }
      }
      if (out.role === "tool" && out.tool_call_id) {
        out.tool_call_id = remapId(out.tool_call_id);
      }
      return out;
    });
  }
  return messages.map(m => ({ ...m })); // same provider — shallow copy
}

// ── Write detection ─────────────────────────────────────────────────────────

/**
 * Scan accumulated messages for successful Roam write tool results.
 * Used during failover to warn the next provider not to duplicate writes.
 */
export function detectWrittenBlocksInMessages(messages) {
  const found = [];
  for (const msg of messages) {
    // OpenAI format: role === "tool"
    if (msg.role === "tool" && msg.content) {
      try {
        const parsed = typeof msg.content === "string" ? JSON.parse(msg.content) : msg.content;
        // roam_create_blocks returns created_uids; roam_batch_write returns uids
        if (parsed?.success === true && (parsed?.created_uids || parsed?.uids)) {
          found.push({ uids: parsed.created_uids || parsed.uids, parent: parsed.parent_uid || parsed.results?.[0]?.parent_uid });
        }
      } catch { /* ignore parse failures */ }
    }
    // Anthropic format: role === "user" with tool_result blocks
    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === "tool_result" && block.content) {
          try {
            const parsed = typeof block.content === "string" ? JSON.parse(block.content) : block.content;
            if (parsed?.success === true && (parsed?.created_uids || parsed?.uids)) {
              found.push({ uids: parsed.created_uids || parsed.uids, parent: parsed.parent_uid || parsed.results?.[0]?.parent_uid });
            }
          } catch { /* ignore parse failures */ }
        }
      }
    }
  }
  return found;
}

export function detectSuccessfulWriteToolCallsInMessages(messages) {
  const toolCallsById = new Map();
  const writes = [];

  const recordToolCall = (id, name, args) => {
    const toolId = String(id || "").trim();
    const toolName = String(name || "").trim();
    if (!toolId || !toolName) return;
    toolCallsById.set(toolId, { name: toolName, args: args || {} });
  };
  const stableArgsKey = (value) => {
    try { return JSON.stringify(value || {}); } catch { return "{}"; }
  };
  const pushIfSuccessfulWrite = (toolId, rawContent) => {
    const call = toolCallsById.get(String(toolId || "").trim());
    if (!call || !deps.WRITE_TOOL_NAMES.has(call.name)) return;
    let parsed = rawContent;
    try {
      if (typeof rawContent === "string") parsed = JSON.parse(rawContent);
    } catch {
      parsed = rawContent;
    }
    const isObj = parsed && typeof parsed === "object";
    const hasError = isObj && typeof parsed.error === "string" && parsed.error.trim();
    const explicitFailure = isObj && (parsed.success === false || parsed.successful === false);
    if (hasError || explicitFailure) return;
    writes.push({
      name: call.name,
      args: call.args || {},
      fingerprint: `${call.name}::${stableArgsKey(call.args)}`
    });
  };

  for (const msg of Array.isArray(messages) ? messages : []) {
    if (msg.role === "assistant") {
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          let args = {};
          try {
            args = typeof tc?.function?.arguments === "string"
              ? JSON.parse(tc.function.arguments)
              : (tc?.function?.arguments || tc?.arguments || {});
          } catch { args = {}; }
          recordToolCall(tc?.id, tc?.function?.name || tc?.name, args);
        }
      }
      if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block?.type === "tool_use") {
            recordToolCall(block.id, block.name, block.input || {});
          }
        }
      }
    }

    if (msg.role === "tool") {
      pushIfSuccessfulWrite(msg.tool_call_id, msg.content);
    }

    if (msg.role === "user" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block?.type === "tool_result") {
          pushIfSuccessfulWrite(block.tool_use_id, block.content);
        }
      }
    }
  }

  return writes;
}

// ── Composio session helpers ────────────────────────────────────────────────

export function extractComposioSessionIdFromToolResult(result) {
  const direct = String(result?.session_id || result?.session?.id || "").trim();
  if (direct) return direct;
  const text = result?.content?.[0]?.text;
  if (typeof text !== "string") return "";
  try {
    const parsed = JSON.parse(text);
    return String(parsed?.session_id || parsed?.session?.id || "").trim();
  } catch (error) {
    return "";
  }
}

export function withComposioSessionArgs(toolName, args, sessionId) {
  const name = String(toolName || "").toUpperCase();
  const id = String(sessionId || "").trim();
  if (!name.startsWith("COMPOSIO_") || !id) return args || {};
  const nextArgs = args && typeof args === "object" ? { ...args } : {};
  if (!String(nextArgs.session_id || "").trim()) {
    nextArgs.session_id = id;
  }
  const existingSession = nextArgs.session && typeof nextArgs.session === "object" ? nextArgs.session : {};
  if (!String(existingSession.id || "").trim()) {
    nextArgs.session = { ...existingSession, id };
  }
  return nextArgs;
}
