/**
 * deterministic-router.js — Fast-path intent matching for Chief of Staff.
 *
 * Handles common intents (search, navigation, memory saves, skill invocations,
 * tool listings, Composio install/deregister, undo/redo, etc.) without an LLM call.
 * Extracted from index.js — pure move-and-wire refactoring, no behaviour changes.
 *
 * DI pattern: call initDeterministicRouter(deps) once from onload().
 */

// ── Direct imports from already-extracted modules ──────────────────────────────

import { normaliseToolSlugToken, getToolsConfigState, getToolkitSchemaRegistry, getToolSchema } from "./composio-mcp.js";
import { installComposioTool, deregisterComposioTool, connectComposio, reconcileInstalledToolsWithComposio } from "./composio-ui.js";
import { getLocalMcpTools, formatToolListByServer, getLocalMcpClients } from "./local-mcp.js";
import { getRemoteMcpTools, getRemoteMcpClients } from "./remote-mcp.js";
import { getLatestWorkflowSuggestionsFromConversation, promptLooksLikeWorkflowDraftFollowUp, extractWorkflowSuggestionIndex } from "./conversation.js";
import { showInfoToastIfAllowed, promptWriteToDailyPage, promptToolExecutionApproval, appendChatPanelMessage } from "./chat-panel.js";
import { loadCronJobs, isValidCronExpression } from "./cron-scheduler.js";
import { buildDefaultSystemPrompt } from "./system-prompt.js";
import { wrapUntrustedWithInjectionScan } from "./security.js";
import { persistAuditLogEntry, recordUsageStat } from "./usage-tracking.js";

// ── Dependency injection ───────────────────────────────────────────────────────

let deps = {};

export function initDeterministicRouter(injected) {
  deps = injected;
}

// ── Intent parsers ─────────────────────────────────────────────────────────────

export function isConnectionStatusIntent(userMessage) {
  const text = String(userMessage || "").toLowerCase();
  if (!text) return false;

  const patterns = [
    "connected tools",
    "tool connections",
    "active connections",
    "connected apps",
    "composio apps",
    "apps from composio",
    "apps in composio",
    "apps do i have from composio",
    "what composio apps",
    "what apps do i have",
    "what is connected",
    "what's connected",
    "what tools are connected",
    "summarise my current connected tools",
    "summarize my current connected tools",
    "list my connected tools",
    "show my connected tools",
    "connection status"
  ];
  return patterns.some((pattern) => text.includes(pattern));
}

export function isDoctorIntent(userMessage) {
  const text = String(userMessage || "").toLowerCase().trim();
  if (!text) return false;
  const patterns = [
    "health check", "run diagnostics", "run a diagnostic", "doctor",
    "cos doctor", "what's wrong", "what is wrong", "system check",
    "system status", "check my setup", "self-diagnostic", "self diagnostic",
    "diagnose", "run doctor", "run health check", "check health",
    "extension health", "chief of staff health", "cos health"
  ];
  return patterns.some((p) => text.includes(p));
}

export function parseMemorySaveIntent(userMessage) {
  const text = String(userMessage || "").trim();
  if (!text) return null;

  const inboxDirectMatch = text.match(/^(?:note|capture|idea)\s*[:\-]\s*(.+)$/i);
  if (inboxDirectMatch) {
    const content = String(inboxDirectMatch[1] || "").trim();
    if (!content) return null;
    return { page: "inbox", content };
  }

  const saveIdeaMatch = text.match(/^(?:save|remember|record)\s+(?:this\s+)?idea\s*[:\-]\s*(.+)$/i);
  if (saveIdeaMatch) {
    const content = String(saveIdeaMatch[1] || "").trim();
    if (!content) return null;
    return { page: "inbox", content };
  }

  const saveNoteMatch = text.match(/^(?:save|remember|record)\s+(?:this\s+)?note\s*[:\-]\s*(.+)$/i);
  if (saveNoteMatch) {
    const content = String(saveNoteMatch[1] || "").trim();
    if (!content) return null;
    return { page: "inbox", content };
  }

  const lessonMatch = text.match(/^(?:remember|save|note|record)\s+(?:this\s+)?lesson\s*[:\-]\s*(.+)$/i);
  if (lessonMatch) {
    const content = String(lessonMatch[1] || "").trim();
    if (!content) return null;
    return { page: "lessons", content };
  }

  const decisionMatch = text.match(/^(?:remember|save|note|record)\s+(?:this\s+)?decision\s*[:\-]\s*(.+)$/i);
  if (decisionMatch) {
    const content = String(decisionMatch[1] || "").trim();
    if (!content) return null;
    return { page: "decisions", content };
  }

  const projectMatch = text.match(/^(?:remember|save|note|record)\s+(?:this\s+)?project(?:\s+update)?\s*[:\-]\s*(.+)$/i);
  if (projectMatch) {
    const content = String(projectMatch[1] || "").trim();
    if (!content) return null;
    return { page: "projects", content };
  }

  const genericRememberMatch = text.match(/^(?:remember|save|note|record)\s+(?:this|that)\s*[:\-]\s*(.+)$/i);
  if (genericRememberMatch) {
    const content = String(genericRememberMatch[1] || "").trim();
    if (!content) return null;
    return { page: "memory", content };
  }

  return null;
}

export function parseSkillInvocationIntent(userMessage) {
  const text = String(userMessage || "").trim();
  if (!text) return null;

  // Strip leading articles/possessives that aren't part of skill names
  const stripLeadingNoise = (s) => String(s || "").replace(/^(?:my|the|a)\s+/i, "").trim();

  const explicitMatch = text.match(/^(?:please\s+)?(?:use|apply|run)\s+(?:the\s+)?skill\s+["\u201C\u201D\u2018\u2019']?([^"\u201C\u201D\u2018\u2019']+?)["\u201C\u201D\u2018\u2019']?(?:\s+(?:on|for)\s+(.+))?$/i);
  if (explicitMatch) {
    return {
      skillName: stripLeadingNoise(explicitMatch[1]),
      targetText: String(explicitMatch[2] || "").trim(),
      originalPrompt: text
    };
  }

  const inverseMatch = text.match(/^(?:please\s+)?(?:use|apply|run)\s+(.+?)\s+skill(?:\s+(?:on|for)\s+(.+))?$/i);
  if (inverseMatch) {
    return {
      skillName: stripLeadingNoise(inverseMatch[1]),
      targetText: String(inverseMatch[2] || "").trim(),
      originalPrompt: text
    };
  }
  return null;
}

export function parseComposioDeregisterIntent(userMessage, options = {}) {
  const { installedSlugs = [] } = options;
  const text = String(userMessage || "").trim();
  if (!text) return null;
  const lowered = text.toLowerCase();
  if (!/(deregister|uninstall|remove|disconnect)/i.test(lowered)) return null;
  const installedSet = new Set(
    (Array.isArray(installedSlugs) ? installedSlugs : [])
      .map((value) => normaliseToolSlugToken(value))
      .filter(Boolean)
  );
  const hasComposioContext = /(composio|tool|connection|integration|app|connected)/i.test(lowered);
  // "uninstall" and "deregister" are unambiguous — they always mean tool removal.
  // "remove" and "disconnect" are ambiguous ("remove this block", "disconnect from wifi")
  // and need either Composio context words or the slug to be in the installed set.
  const isUnambiguousVerb = /\b(uninstall|deregister)\b/i.test(lowered);

  const quotedMatch = text.match(/"([^"]+)"/);
  const fromQuotes = normaliseToolSlugToken(String(quotedMatch?.[1] || "").trim());
  if (fromQuotes) {
    if (isUnambiguousVerb || hasComposioContext || installedSet.has(fromQuotes)) {
      return { toolSlug: fromQuotes };
    }
    return null;
  }

  const directMatch = text.match(/\b(?:deregister|uninstall|remove|disconnect)\s+(?:(?:the|a|an)\s+)?(?:composio\s+)?(?:tool\s+)?([a-z][a-z0-9_ -]*)/i);
  const rawSlug = String(directMatch?.[1] || "").trim()
    .replace(/\s*tools?\s*$/i, "")  // strip trailing "tool"
  // Real tool slugs are 1–3 words max
  const slugWords = rawSlug.split(/\s+/).filter(Boolean);
  if (slugWords.length > 3) return null;
  // Reject if any word is a common English word — real Composio slugs are product/service names
  const slugStopWords = /^(a|an|the|my|some|any|this|that|it|its|from|to|in|on|for|with|about|at|by|of|random|please|just|here|there|all|every|each|no|not|but|or|and|so|yet)$/i;
  if (slugWords.some(w => slugStopWords.test(w))) return null;
  const directSlug = normaliseToolSlugToken(rawSlug.replace(/\s+/g, ""));
  if (!directSlug) return null;
  if (!isUnambiguousVerb && !hasComposioContext && !installedSet.has(directSlug)) return null;
  return { toolSlug: directSlug };
}

export function parseComposioInstallIntent(userMessage) {
  const text = String(userMessage || "").trim();
  if (!text) return null;
  const lowered = text.toLowerCase();
  if (!/(install|add|connect|enable|set\s*up)\b/i.test(lowered)) return null;
  // Exclude deregister-style phrases
  if (/(deregister|uninstall|remove|disconnect)\b/i.test(lowered)) return null;

  // Exclude help / how-to questions — "how do I connect a remote MCP server?" is asking for
  // guidance, not requesting a Composio install. Only block "how" and "what/where" question
  // patterns (unambiguously instructional). "Can I connect todoist?" is a polite install request
  // so "can I" is intentionally NOT excluded.
  if (/\b(how\s+(do|can|to|does|should|would)|what\s+(is|are|does)|where\s+(is|are|do))\b/i.test(lowered)) return null;

  const hasComposioContext = /(composio|tool|integration|service)\b/i.test(lowered);
  // "install" is the only verb unambiguous enough to stand alone — nobody says "install" in
  // casual Roam conversation unless they mean a tool. "add", "connect", "enable", and "set up"
  // are everyday verbs ("connect my notes", "enable focus mode", "set up a weekly review") and
  // need explicit tool/integration context to avoid false Composio install triggers.
  const verb = lowered.match(/\b(install|add|connect|enable|set\s*up)\b/i)?.[1]?.toLowerCase() || "";
  const isAmbiguousVerb = verb !== "install";
  if (!hasComposioContext && isAmbiguousVerb) return null;
  // For "install", still require the verb + word pattern (reject bare "install" with no object)
  if (!hasComposioContext && !isAmbiguousVerb &&
    !/\binstall\s+[a-z]/i.test(lowered)) return null;

  // Try quoted slug first
  const quotedMatch = text.match(/"([^"]+)"/);
  if (quotedMatch) {
    const slug = normaliseToolSlugToken(String(quotedMatch[1]).trim());
    if (slug) return { toolSlug: slug };
  }

  // Direct match: "install todoist", "add the gmail tool", "connect google calendar"
  const directMatch = text.match(/\b(?:install|add|connect|enable|set\s*up)\s+(?:(?:the|a|an)\s+)?(?:composio\s+)?(?:tool\s+)?([a-z][a-z0-9_ -]*)/i);
  const rawSlug = String(directMatch?.[1] || "").trim()
    .replace(/\s*tools?\s*$/i, "") // strip trailing "tool"
  // Real tool slugs are 1–3 words max (e.g. "gmail", "google calendar", "semantic scholar")
  const slugWords = rawSlug.split(/\s+/).filter(Boolean);
  if (slugWords.length > 3) return null;
  // Reject if any word is a common English word or a common noun that clashes with natural prompts.
  // Real Composio slugs are product/service names (gmail, todoist, notion, google calendar).
  const slugStopWords = /^(a|an|the|my|some|any|this|that|it|its|from|to|in|on|for|with|about|at|by|of|random|please|just|here|there|all|every|each|no|not|but|or|and|so|yet|new|event|events?|task|tasks?|meeting|meetings?|note|notes?|reminder|reminders?|item|items?|entry|entries|block|blocks?|page|pages?|calendar|email|message|contact|file|link|date|time|appointment)$/i;
  // Reject only if ALL words are stopwords. Multi-word product names like
  // "google calendar" should pass because "google" is not a stopword.
  if (slugWords.every(w => slugStopWords.test(w))) return null;
  const slug = normaliseToolSlugToken(rawSlug.replace(/\s+/g, ""));
  if (!slug) return null;
  return { toolSlug: slug };
}

function collectObjectRecordsDeep(value, maxRecords = 300) {
  const queue = [value];
  const seen = new Set();
  const records = [];
  while (queue.length && records.length < maxRecords) {
    const current = queue.shift();
    if (!current || typeof current !== "object") continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (!Array.isArray(current)) {
      records.push(current);
    }
    Object.values(current).forEach((next) => {
      if (next && typeof next === "object") queue.push(next);
    });
  }
  return records;
}

function firstNonEmptyString(record, keys = []) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

// ── Calendar/email deterministic helpers removed — now using Local MCP tool discovery ──

async function runDeterministicMemorySave(intent) {
  const pageKey = String(intent?.page || "memory").toLowerCase();
  const content = String(intent?.content || "").trim();
  if (!content) throw new Error("No memory content to save.");
  const result = await deps.updateChiefMemory({
    page: pageKey,
    action: "append",
    content
  });
  const pageNameByKey = {
    memory: "Chief of Staff/Memory",
    inbox: "Chief of Staff/Inbox",
    skills: "Chief of Staff/Skills",
    projects: "Chief of Staff/Projects",
    decisions: "Chief of Staff/Decisions",
    lessons: "Chief of Staff/Lessons Learned",
    improvements: "Chief of Staff/Improvement Requests"
  };
  const label = pageNameByKey[pageKey] || String(result?.page || "Chief of Staff/Memory");
  return `Saved to [[${label}]]${result?.uid ? ` (uid: ${result.uid})` : ""}.`;
}

// ── Skill parsing ──────────────────────────────────────────────────────────────

export function parseSkillSources(skillContent, knownToolNames = null) {
  const lines = String(skillContent || "").split("\n");

  // Phase 1: find the "Sources" header and collect its direct child lines.
  // Sub-indented lines (deeper than the first child level) are continuations
  // of the previous source entry, not separate sources — skip them.
  let inSources = false;
  let sourceIndent = -1;
  let childIndent = -1; // indent of first direct child (set on first child line)
  const sourceLines = [];

  for (const line of lines) {
    if (!inSources) {
      if (/^\s*-?\s*Sources\s*(?:—|:)/i.test(line)) {
        inSources = true;
        sourceIndent = (line.match(/^(\s*)/)?.[1] || "").length;
      }
      continue;
    }
    const indent = (line.match(/^(\s*)/)?.[1] || "").length;
    if (indent <= sourceIndent && line.trim()) {
      break; // back to same or lower indent = end of sources
    }
    if (!line.trim()) continue;
    // First child sets the reference indent for direct children
    if (childIndent < 0) childIndent = indent;
    // Only collect direct children (at childIndent); skip deeper sub-children
    if (indent <= childIndent) {
      sourceLines.push(line.trim().replace(/^-\s*/, ""));
    }
    // else: sub-indented continuation line — skip (part of previous source)
  }

  if (!sourceLines.length) return [];

  // COS memory pages already loaded in system prompt — skip these
  const preloadedPages = new Set([
    ...deps.MEMORY_PAGE_TITLES_BASE,
    "Chief of Staff/Skills",
    "Chief of Staff/Projects"
  ]);

  // Phase 2: parse each child line into a source entry
  const sources = [];
  for (const seg of sourceLines) {
    const pageRefs = [...seg.matchAll(/\[\[([^\]]+)\]\]/g)].map(m => m[1]);

    // Strip markdown formatting (backticks) before tool name matching
    const cleanSeg = seg.replace(/`/g, "");

    // Check for known tool name prefix (try longest match first)
    // Support both underscore (roam_get_page) and hyphen (list-events) separators
    const toolThreeWord = cleanSeg.match(/^([\w]+[-_][\w]+[-_][\w]+)/)?.[1] || "";
    const toolTwoWord = cleanSeg.match(/^([\w]+[-_][\w]+)/)?.[1] || "";
    const toolOneWord = cleanSeg.match(/^([\w]+)/)?.[1] || "";
    const SOURCE_TOOL_NAME_MAP = deps.SOURCE_TOOL_NAME_MAP;
    // Normalise hyphens ↔ underscores so "list_calendars" matches "list-calendars" and vice-versa
    const lookupVariants = (key) => SOURCE_TOOL_NAME_MAP[key]
      || SOURCE_TOOL_NAME_MAP[key.replace(/_/g, "-")]
      || SOURCE_TOOL_NAME_MAP[key.replace(/-/g, "_")];
    const resolvedTool = lookupVariants(toolThreeWord)
      || lookupVariants(toolTwoWord)
      || lookupVariants(toolOneWord);

    if (resolvedTool) {
      sources.push({ tool: resolvedTool, description: seg });
      continue;
    }

    // Fallback: check live tool registry for extension tools not in the static map
    // Also try hyphen ↔ underscore variants against the live registry
    if (knownToolNames) {
      const tryLive = (key) => knownToolNames.has(key) ? key
        : knownToolNames.has(key.replace(/_/g, "-")) ? key.replace(/_/g, "-")
          : knownToolNames.has(key.replace(/-/g, "_")) ? key.replace(/-/g, "_")
            : null;
      const directMatch = tryLive(toolThreeWord)
        || tryLive(toolTwoWord)
        || tryLive(toolOneWord);
      if (directMatch) {
        sources.push({ tool: directMatch, description: seg });
        continue;
      }
      // Cross-source deduped names (e.g. sentry__search_issues): the deduped name
      // may not exist yet if servers were down at startup, but the original name
      // (search_issues) might. Accept the deduped name as-is so the gathering guard
      // recognises the intent even if the exact name isn't in the registry right now.
      const bestToken = toolThreeWord || toolTwoWord || toolOneWord;
      const dIdx = bestToken.indexOf("__");
      if (dIdx > 0) {
        sources.push({ tool: bestToken, description: seg });
        continue;
      }
    }

    // Inline meta-tool references (e.g. "GitHub Issues: Use Route: LOCAL_MCP_ROUTE(...)")
    // The source line describes a multi-step flow — register the meta-tool as the source.
    const metaToolMatch = cleanSeg.match(/\b(LOCAL_MCP_ROUTE|LOCAL_MCP_EXECUTE|REMOTE_MCP_ROUTE|REMOTE_MCP_EXECUTE)\b/);
    if (metaToolMatch) {
      sources.push({ tool: metaToolMatch[1], description: seg });
      continue;
    }

    // Pure page references (no tool prefix)
    if (pageRefs.length > 0) {
      for (const title of pageRefs) {
        if (preloadedPages.has(title)) continue;
        sources.push({ tool: "roam_get_page", description: `[[${title}]]` });
      }
      continue;
    }
    // Unrecognised source — log warning so skill authors can fix tool names
    console.warn(`[Chief flow] Gathering guard: unrecognised source "${seg}" — not enforced. Update skill to use a known tool name.`);
  }
  return sources;
}

// ── Skill tool whitelist parsing ──────────────────────────────────────────────

/**
 * Parse the optional `Tools:` field from skill content.
 * Returns an array of resolved LLM tool names, or empty array if no Tools: field.
 * Authors use shorthand names (bt_search, list-events); these are resolved via
 * SOURCE_TOOL_NAME_MAP and the live tool registry, same as parseSkillSources.
 */
export function parseSkillTools(skillContent, knownToolNames = null) {
  const lines = String(skillContent || "").split("\n");

  // Phase 1: find the "Tools" header and collect its child lines
  let inTools = false;
  let toolsIndent = -1;
  const toolLines = [];

  for (const line of lines) {
    if (!inTools) {
      if (/^\s*-?\s*Tools\s*(?:—|:)/i.test(line)) {
        // Inline tools on the same line as the header (e.g. "Tools: bt_search, roam_get_page")
        const inlineMatch = line.match(/Tools\s*(?:—|:)\s*(.+)/i);
        if (inlineMatch && inlineMatch[1].trim()) {
          toolLines.push(inlineMatch[1].trim());
        }
        inTools = true;
        toolsIndent = (line.match(/^(\s*)/)?.[1] || "").length;
      }
      continue;
    }
    const indent = (line.match(/^(\s*)/)?.[1] || "").length;
    if (indent > toolsIndent && line.trim()) {
      toolLines.push(line.trim().replace(/^-\s*/, ""));
    } else if (line.trim()) {
      break;
    }
  }

  if (!toolLines.length) return [];

  // Phase 2: split by commas and resolve each tool name
  const SOURCE_TOOL_NAME_MAP = deps.SOURCE_TOOL_NAME_MAP;
  const resolved = [];
  const seen = new Set();

  for (const raw of toolLines) {
    const tokens = raw.split(",").map(t => t.trim().replace(/`/g, "")).filter(Boolean);
    for (const token of tokens) {
      // Three-level matching (longest first), same as parseSkillSources
      const threeWord = token.match(/^([\w]+[-_][\w]+[-_][\w]+)/)?.[1] || "";
      const twoWord = token.match(/^([\w]+[-_][\w]+)/)?.[1] || "";
      const oneWord = token.match(/^([\w]+)/)?.[1] || "";

      // Normalise hyphens ↔ underscores so "list_calendars" matches "list-calendars" and vice-versa
      const lookupVariants = (key) => SOURCE_TOOL_NAME_MAP[key]
        || SOURCE_TOOL_NAME_MAP[key.replace(/_/g, "-")]
        || SOURCE_TOOL_NAME_MAP[key.replace(/-/g, "_")];
      const mapped = lookupVariants(threeWord)
        || lookupVariants(twoWord)
        || lookupVariants(oneWord);
      if (mapped && !seen.has(mapped)) {
        seen.add(mapped);
        resolved.push(mapped);
        continue;
      }

      // Fallback: check live tool registry (with hyphen ↔ underscore normalisation)
      if (knownToolNames) {
        const tryLive = (key) => knownToolNames.has(key) ? key
          : knownToolNames.has(key.replace(/_/g, "-")) ? key.replace(/_/g, "-")
            : knownToolNames.has(key.replace(/-/g, "_")) ? key.replace(/-/g, "_")
              : null;
        const direct = tryLive(threeWord)
          || tryLive(twoWord)
          || tryLive(oneWord);
        if (direct && !seen.has(direct)) {
          seen.add(direct);
          resolved.push(direct);
          continue;
        }
      }

      // Also accept the raw token verbatim (e.g. COMPOSIO slugs like WEATHERMAP_WEATHER)
      if (!seen.has(token)) {
        // Only accept if it looks like a tool name (alphanumeric + separators)
        if (/^[\w][\w-]*$/.test(token)) {
          seen.add(token);
          resolved.push(token);
        } else {
          console.warn(`[Chief flow] Skill tool whitelist: unrecognised tool "${token}" — skipped.`);
        }
      }
    }
  }
  return resolved;
}

/**
 * Parse optional Budget:, Tier:, and Iterations: fields from skill content.
 * All are single-value fields (not lists), so no indent-based parsing needed.
 * Returns { budgetUsd: number|null, tier: string|null, maxIterations: number|null }.
 */
export function parseSkillBudget(skillContent) {
  const text = String(skillContent || "");
  const result = { budgetUsd: null, tier: null, maxIterations: null };

  // Budget: $0.05 or Budget: 0.05
  const budgetMatch = text.match(/^\s*-?\s*Budget\s*(?:—|:)\s*\$?([\d.]+)/im);
  if (budgetMatch) {
    const val = parseFloat(budgetMatch[1]);
    if (!isNaN(val) && val > 0) result.budgetUsd = val;
  }

  // Tier: mini | power | ludicrous
  const tierMatch = text.match(/^\s*-?\s*Tier\s*(?:—|:)\s*(mini|power|ludicrous)/im);
  if (tierMatch) {
    result.tier = tierMatch[1].toLowerCase();
  }

  // Iterations: 6 (minimum 2: one for tool calls, one for synthesis)
  const iterMatch = text.match(/^\s*-?\s*Iterations\s*(?:—|:)\s*(\d+)/im);
  if (iterMatch) {
    const val = parseInt(iterMatch[1], 10);
    if (!isNaN(val) && val >= 1) result.maxIterations = Math.max(2, Math.min(val, deps.MAX_AGENT_ITERATIONS_SKILL));
  }

  return result;
}

// ── Skill constraint parsing ──────────────────────────────────────────────────

const CONSTRAINT_QUADRANTS = [
  { id: "mustDo", header: /^\s*-?\s*Must\s+Do\s*(?:—|:)/i },
  { id: "mustNotDo", header: /^\s*-?\s*Must\s+Not\s+Do\s*(?:—|:)/i },
  { id: "prefer", header: /^\s*-?\s*Prefer\s*(?:—|:)/i },
  { id: "escalate", header: /^\s*-?\s*Escalate\s*(?:—|:)/i },
];

/**
 * Parse optional Constraints: section with four quadrants (Must Do, Must Not Do,
 * Prefer, Escalate) from skill content.
 * Returns { mustDo: string[]|null, mustNotDo: string[]|null, prefer: string[]|null, escalate: string[]|null }
 */
export function parseSkillConstraints(skillContent) {
  const text = String(skillContent || "");
  const lines = text.split("\n");
  const result = { mustDo: null, mustNotDo: null, prefer: null, escalate: null };

  // Phase 1: find the Constraints header and collect its child lines
  let inConstraints = false;
  let constraintsIndent = -1;
  const constraintLines = [];

  for (const line of lines) {
    if (!inConstraints) {
      if (/^\s*-?\s*Constraints\s*(?:—|:)/i.test(line)) {
        inConstraints = true;
        constraintsIndent = (line.match(/^(\s*)/)?.[1] || "").length;
      }
      continue;
    }
    const indent = (line.match(/^(\s*)/)?.[1] || "").length;
    if (indent > constraintsIndent && line.trim()) {
      constraintLines.push(line);
    } else if (line.trim()) {
      break;
    }
  }

  if (!constraintLines.length) return result;

  // Phase 2: parse quadrant headers and their children
  let currentQuadrant = null;

  for (const line of constraintLines) {
    const trimmed = line.trim().replace(/^-\s*/, "");

    // Check if this line starts a quadrant
    let matched = false;
    for (const q of CONSTRAINT_QUADRANTS) {
      if (q.header.test(line)) {
        currentQuadrant = q.id;
        // Check for inline content after the header
        const inlineMatch = trimmed.match(/(?:Must\s+(?:Not\s+)?Do|Prefer|Escalate)\s*(?:—|:)\s*(.+)/i);
        if (inlineMatch && inlineMatch[1].trim()) {
          if (!result[currentQuadrant]) result[currentQuadrant] = [];
          result[currentQuadrant].push(inlineMatch[1].trim());
        }
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // Otherwise it's a child line of the current quadrant
    if (currentQuadrant && trimmed) {
      if (!result[currentQuadrant]) result[currentQuadrant] = [];
      result[currentQuadrant].push(trimmed);
    }
  }

  return result;
}

/**
 * Format parsed constraints into a system prompt section.
 * Returns empty string if no constraints are defined.
 */
function formatConstraintsPromptSection(constraints) {
  if (!constraints) return "";
  const { mustDo, mustNotDo, prefer, escalate } = constraints;
  if (!mustDo && !mustNotDo && !prefer && !escalate) return "";

  const sections = [];
  sections.push("\n\n## Skill Constraints (Binding)");

  if (mustDo && mustDo.length > 0) {
    sections.push("\n**MUST DO** (non-negotiable requirements):");
    for (const item of mustDo) sections.push(`- ${item}`);
  }
  if (mustNotDo && mustNotDo.length > 0) {
    sections.push("\n**MUST NOT DO** (hard prohibitions — violation is a failure):");
    for (const item of mustNotDo) sections.push(`- ${item}`);
  }
  if (prefer && prefer.length > 0) {
    sections.push("\n**PREFER** (guidance when multiple valid approaches exist):");
    for (const item of prefer) sections.push(`- ${item}`);
  }
  if (escalate && escalate.length > 0) {
    sections.push("\n**ESCALATE** (stop and ask the user before proceeding):");
    for (const item of escalate) sections.push(`- ${item}`);
  }

  return sections.join("\n");
}

// ── Skill rubric parsing ──────────────────────────────────────────────────────

/**
 * Parse optional Rubric: section from skill content.
 * Each child line is one checkable quality criterion.
 * Returns string[] (empty if no Rubric: field).
 */
export function parseSkillRubric(skillContent) {
  const lines = String(skillContent || "").split("\n");

  let inRubric = false;
  let rubricIndent = -1;
  const criteria = [];

  for (const line of lines) {
    if (!inRubric) {
      if (/^\s*-?\s*Rubric\s*(?:—|:)/i.test(line)) {
        inRubric = true;
        rubricIndent = (line.match(/^(\s*)/)?.[1] || "").length;
        // Check for inline content
        const inlineMatch = line.match(/Rubric\s*(?:—|:)\s*(.+)/i);
        if (inlineMatch && inlineMatch[1].trim()) {
          criteria.push(inlineMatch[1].trim());
        }
      }
      continue;
    }
    const indent = (line.match(/^(\s*)/)?.[1] || "").length;
    if (indent > rubricIndent && line.trim()) {
      criteria.push(line.trim().replace(/^-\s*/, ""));
    } else if (line.trim()) {
      break;
    }
  }

  return criteria;
}

// ── Skill model preference parsing ────────────────────────────────────────────

/**
 * Parse optional Models: field from skill content.
 * Supports include (+Provider) and exclude (-Provider) syntax.
 * Returns { exclude: string[], prefer: string[] } with lowercase provider names.
 */
export function parseSkillModels(skillContent) {
  const lines = String(skillContent || "").split("\n");
  const exclude = [];
  const prefer = [];

  for (const line of lines) {
    const match = line.match(/^\s*-?\s*Models\s*(?:—|:)\s*(.+)/i);
    if (!match) continue;
    const tokens = match[1].split(",").map(t => t.trim()).filter(Boolean);
    for (const token of tokens) {
      if (token.startsWith("-")) {
        exclude.push(token.slice(1).trim().toLowerCase());
      } else if (token.startsWith("+")) {
        prefer.push(token.slice(1).trim().toLowerCase());
      } else {
        prefer.push(token.trim().toLowerCase());
      }
    }
    break;
  }

  return { exclude, prefer };
}

// ── Skill acceptance criteria & staleness ─────────────────────────────────────

/**
 * Parse optional Acceptance: section from skill content.
 * Returns string[] (empty if no Acceptance: field).
 * Criteria are injected into the system prompt as binding pre-flight requirements
 * AND passed to eval-judge post-run as binary pass/fail checks.
 */
export function parseSkillAcceptance(skillContent) {
  const lines = String(skillContent || "").split("\n");
  // Accept "Acceptance —", "Acceptance:", "Acceptance Criteria —", "Acceptance Tests:", "Acceptance Checks —"
  const headerRe = /^\s*-?\s*Acceptance(?:\s+(?:criteria|tests?|checks?))?\s*(?:—|:)/i;
  const inlineRe = /Acceptance(?:\s+(?:criteria|tests?|checks?))?\s*(?:—|:)\s*(.+)/i;
  let inAcceptance = false;
  let acceptanceIndent = -1;
  const items = [];
  for (const line of lines) {
    if (!inAcceptance) {
      if (headerRe.test(line)) {
        inAcceptance = true;
        acceptanceIndent = (line.match(/^(\s*)/)?.[1] || "").length;
        const inlineMatch = line.match(inlineRe);
        if (inlineMatch && inlineMatch[1].trim()) {
          items.push(inlineMatch[1].trim().replace(/^[-*•]\s*/, ""));
        }
      }
      continue;
    }
    const indent = (line.match(/^(\s*)/)?.[1] || "").length;
    if (indent > acceptanceIndent && line.trim()) {
      items.push(line.trim().replace(/^[-*•]\s*/, ""));
    } else if (line.trim()) {
      break;
    }
  }
  return items;
}

/**
 * Parse optional Last reviewed:: [[date]] attribute from skill content.
 * Returns a Date or null.
 */
export function parseSkillLastReviewed(skillContent) {
  const text = String(skillContent || "");
  const match = text.match(/Last\s+reviewed\s*::\s*\[\[([^\]]+)\]\]/i);
  if (!match) return null;
  // "April 9th, 2026" → "April 9, 2026"
  const cleaned = match[1].replace(/(\d+)(?:st|nd|rd|th)/, "$1");
  const d = new Date(cleaned);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Resolve parsed tool names against the live tool registry and determine
 * which meta-tools (ROUTE/EXECUTE) need to be included for routed tools.
 * Returns { whitelist: Set<string>, warnings: string[] }.
 */
function resolveToolWhitelist(parsedToolNames, allToolSchemas, localMcpTools, remoteMcpTools) {
  const whitelist = new Set();
  const warnings = [];

  // Build lookup maps
  const schemaByName = new Map();
  for (const t of allToolSchemas) schemaByName.set(t.name, t);

  const localByName = new Map();
  for (const t of localMcpTools) localByName.set(t.name, t);

  const remoteByName = new Map();
  for (const t of remoteMcpTools) remoteByName.set(t.name, t);

  // Composio slug lookup
  const composioRegistry = getToolkitSchemaRegistry();
  const composioSlugs = new Set();
  for (const tk of Object.values(composioRegistry.toolkits || {})) {
    for (const slug of Object.keys(tk.tools || {})) composioSlugs.add(slug);
  }

  for (const name of parsedToolNames) {
    const schema = schemaByName.get(name);

    if (schema) {
      whitelist.add(name);
      // Check if this is a routed (non-direct) tool and include its meta-tools
      if (schema._isRemote && !schema._isDirect) {
        whitelist.add("REMOTE_MCP_ROUTE");
        whitelist.add("REMOTE_MCP_EXECUTE");
      } else if (schema._serverName && !schema._isDirect && !schema._isRemote) {
        // Local MCP routed tool
        whitelist.add("LOCAL_MCP_ROUTE");
        whitelist.add("LOCAL_MCP_EXECUTE");
      } else if (schema._extensionName && !schema._isDirect) {
        whitelist.add("EXT_ROUTE");
        whitelist.add("EXT_EXECUTE");
      }
      continue;
    }

    // Check local MCP tools (may not be in allToolSchemas if routed)
    const localTool = localByName.get(name);
    if (localTool) {
      whitelist.add(name);
      if (!localTool._isDirect) {
        whitelist.add("LOCAL_MCP_ROUTE");
        whitelist.add("LOCAL_MCP_EXECUTE");
      }
      continue;
    }

    // Check remote MCP tools
    const remoteTool = remoteByName.get(name);
    if (remoteTool) {
      whitelist.add(name);
      if (!remoteTool._isDirect) {
        whitelist.add("REMOTE_MCP_ROUTE");
        whitelist.add("REMOTE_MCP_EXECUTE");
      }
      continue;
    }

    // Check Composio slugs
    if (composioSlugs.has(name)) {
      whitelist.add(name);
      whitelist.add("COMPOSIO_MULTI_EXECUTE_TOOL");
      continue;
    }

    // Routed Roam tools (roam_batch_write, roam_find_todos, etc.) aren't in allToolSchemas
    // directly — they're accessed via ROAM_ROUTE → ROAM_EXECUTE. Include the meta-tools.
    if (name.startsWith("roam_")) {
      whitelist.add(name);
      whitelist.add("ROAM_ROUTE");
      whitelist.add("ROAM_EXECUTE");
      continue;
    }

    // Cross-source deduped names (e.g. sentry__search_issues, github_mcp_server__search_issues).
    // These are created at schema assembly time. Resolve the original tool name from the
    // server prefix and look up in MCP caches to determine the right meta-tools.
    const dedupIdx = name.indexOf("__");
    if (dedupIdx > 0) {
      const origName = name.slice(dedupIdx + 2);
      const serverPrefix = name.slice(0, dedupIdx);
      // Check remote MCP first
      const rTool = remoteMcpTools.find(t =>
        (t.name === origName || t._originalName === origName) &&
        (t._serverName || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") === serverPrefix
      );
      if (rTool) {
        whitelist.add(name);
        // Also add the original name — the schema may use it when no cross-source
        // collision occurred (e.g. Sentry direct tool stays as "search_issues")
        whitelist.add(rTool.name);
        if (!rTool._isDirect) { whitelist.add("REMOTE_MCP_ROUTE"); whitelist.add("REMOTE_MCP_EXECUTE"); }
        continue;
      }
      // Check local MCP
      const lTool = localMcpTools.find(t =>
        (t.name === origName || t._originalName === origName) &&
        (t._serverName || "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") === serverPrefix
      );
      if (lTool) {
        whitelist.add(name);
        whitelist.add(lTool.name);
        if (!lTool._isDirect) { whitelist.add("LOCAL_MCP_ROUTE"); whitelist.add("LOCAL_MCP_EXECUTE"); }
        continue;
      }
    }

    // Not found anywhere — graceful degradation
    warnings.push(`tool "${name}" not currently available (MCP server down or tool not installed)`);
  }

  return { whitelist, warnings };
}

async function runDeterministicSkillInvocation(intent, options = {}) {
  const { suppressToasts = false, onToolCall = null, onTextChunk = null } = options;
  const skillName = String(intent?.skillName || "").trim();
  if (!skillName) {
    return "Please provide a skill name, for example: use skill Weekly Planning on my next two weeks.";
  }
  const skill = await deps.findSkillEntryByName(skillName, { force: true });
  if (!skill) {
    const available = (await deps.getSkillEntries({ force: true }))
      .map((entry) => entry.title)
      .slice(0, 12);
    const suffix = available.length ? ` Available skills: ${available.join(", ")}` : " No skills are currently loaded.";
    return `I couldn't find a skill named "${skillName}".${suffix}`;
  }

  const skillPrompt = String(intent?.targetText || "").trim() || `Apply the "${skill.title}" skill to this request: ${intent?.originalPrompt || ""}`;
  showInfoToastIfAllowed("Skill", `Applying: ${skill.title}`, suppressToasts);

  // Detect daily-page-write skills by name or content
  const skillNameLower = String(skill.title || "").toLowerCase();
  const skillContentLower = String(skill.content || "").toLowerCase();
  const isDailyPageWriteSkill =
    /daily.briefing/.test(skillNameLower) ||
    /daily.page|daily.briefing/.test(skillContentLower);

  let systemPromptSuffix = `\n\nYou must prioritize this skill for this turn.`;
  if (isDailyPageWriteSkill) {
    systemPromptSuffix += `\n\nIMPORTANT: Do NOT call roam_create_blocks, roam_batch_write, or roam_get_daily_page. The system will write your output to the daily page automatically. Just produce the briefing content as structured markdown with headings (#### for sections) and FLAT bulleted lists (no indentation — every list item must start at column 0 with "- "). Indentation in your output maps directly to Roam block nesting, so indented items become children rather than siblings. Do NOT include any preamble, confirmation, or conversational text — output ONLY the structured briefing content.`;
  }

  // Parse expected sources for gathering completeness guard.
  // Include ALL MCP tools (not just direct/registered ones) so namespaced
  // tools like "sentry_mcp__search_issues" from routed servers are recognised.
  const toolSchemas = await deps.getAvailableToolSchemas();
  const knownToolNames = new Set(toolSchemas.map(t => t.name));
  // getAvailableToolSchemas only returns direct roam tools — add ALL roam native
  // tools (including routed ones like roam_get_backlinks) so gathering guard recognises them
  for (const t of (deps.getRoamNativeTools() || [])) knownToolNames.add(t.name);
  for (const t of getLocalMcpTools()) knownToolNames.add(t.name);
  for (const t of getRemoteMcpTools()) knownToolNames.add(t.name);
  // Include Composio installed tool slugs so gathering guard recognises them
  // (e.g. GMAIL_FETCH_EMAILS, WEATHERMAP_WEATHER) — these are callable via
  // COMPOSIO_MULTI_EXECUTE_TOOL or the slug interceptor.
  const composioRegistry = getToolkitSchemaRegistry();
  for (const tk of Object.values(composioRegistry.toolkits || {})) {
    for (const slug of Object.keys(tk.tools || {})) knownToolNames.add(slug);
  }
  const expectedSources = parseSkillSources(skill.content, knownToolNames);

  // Parse optional tool whitelist
  const parsedToolNames = parseSkillTools(skill.content, knownToolNames);

  // Validate: if both Sources and Tools specified, ensure all source tools are in the whitelist
  if (parsedToolNames.length > 0 && expectedSources.length > 0) {
    const toolSet = new Set(parsedToolNames);
    for (const src of expectedSources) {
      if (!toolSet.has(src.tool)) {
        console.warn(`[Chief flow] Skill "${skill.title}": source tool "${src.tool}" not in Tools whitelist — auto-adding.`);
        parsedToolNames.push(src.tool);
      }
    }
  }

  // Resolve whitelist against live tool registry
  let toolWhitelist = null;
  if (parsedToolNames.length > 0) {
    const { whitelist, warnings } = resolveToolWhitelist(
      parsedToolNames, toolSchemas, getLocalMcpTools(), getRemoteMcpTools()
    );
    for (const w of warnings) {
      console.warn(`[Chief flow] Skill "${skill.title}" tool whitelist: ${w}`);
    }
    toolWhitelist = whitelist;
    deps.debugLog(`[Chief flow] Tool whitelist for "${skill.title}": [${[...toolWhitelist].join(", ")}] (${warnings.length} warnings)`);
  }

  // Pre-resolve MCP tool schemas: if a skill source references a namespaced MCP
  // tool (e.g. "sentry_mcp__search_issues"), inject its schema into the system
  // prompt so the LLM can call LOCAL_MCP_EXECUTE directly — skipping LOCAL_MCP_ROUTE.
  let mcpToolHintsSection = "";
  if (expectedSources.length > 0) {
    const mcpToolHints = [];
    const allLocalTools = getLocalMcpTools();
    const allRemoteTools = getRemoteMcpTools();
    for (const src of expectedSources) {
      const localMatch = allLocalTools.find(t => t.name === src.tool && !t._isDirect);
      const remoteMatch = !localMatch ? allRemoteTools.find(t => t.name === src.tool && !t._isDirect) : null;
      const match = localMatch || remoteMatch;
      if (match) {
        const schemaStr = match.input_schema && Object.keys(match.input_schema.properties || {}).length > 0
          ? JSON.stringify(match.input_schema) : "(no parameters)";
        const metaTool = localMatch ? "LOCAL_MCP_EXECUTE" : "REMOTE_MCP_EXECUTE";
        mcpToolHints.push(`- **${match.name}** (${match._serverName}): ${match.description || ""}\n  Schema: ${schemaStr}\n  → Call via ${metaTool}({ "tool_name": "${match.name}", "arguments": {...} }) — do NOT call ${localMatch ? "LOCAL" : "REMOTE"}_MCP_ROUTE first.`);
      }
    }
    // Also pre-resolve Composio tool slugs: if a skill source references a Composio
    // slug (e.g. GMAIL_FETCH_EMAILS, WEATHERMAP_WEATHER), inject its schema so the
    // LLM calls COMPOSIO_MULTI_EXECUTE_TOOL directly — no brave_web_search needed.
    const composioHints = [];
    for (const src of expectedSources) {
      // Skip sources already matched as MCP tools
      if (mcpToolHints.some(h => h.includes(`**${src.tool}**`))) continue;
      const composioSchema = getToolSchema(src.tool);
      if (composioSchema) {
        const params = composioSchema.input_schema?.properties || {};
        const paramList = Object.entries(params).slice(0, 8).map(([name, v]) => {
          const type = v.type || "any";
          const req = (composioSchema.input_schema?.required || []).includes(name) ? " (required)" : "";
          return `    ${name}: ${type}${req}`;
        }).join("\n");
        composioHints.push(`- **${src.tool}**: ${(composioSchema.description || "").split(/[.\n]/)[0].slice(0, 80)}\n  Parameters:\n${paramList}\n  → Call via COMPOSIO_MULTI_EXECUTE_TOOL({ "tools": [{ "tool_slug": "${src.tool}", "arguments": {...} }] }) or call \`${src.tool}\` directly.`);
      }
    }

    if (mcpToolHints.length > 0 || composioHints.length > 0) {
      const sections = [];
      if (mcpToolHints.length > 0) {
        sections.push(`### MCP Tools\nCall directly via LOCAL_MCP_EXECUTE or REMOTE_MCP_EXECUTE without routing.\n\n${mcpToolHints.join("\n\n")}`);
      }
      if (composioHints.length > 0) {
        sections.push(`### Composio Tools\nCall directly via COMPOSIO_MULTI_EXECUTE_TOOL (batch multiple in one call) or call the slug directly. Do NOT web-search for these tools.\n\n${composioHints.join("\n\n")}`);
      }
      mcpToolHintsSection = `\n\n## Pre-Resolved Tool Schemas\nThese tools are required by this skill. Their schemas are pre-loaded — call them directly.\n\n${sections.join("\n\n")}`;
      deps.debugLog(`[Chief flow] Pre-resolved ${mcpToolHints.length} MCP + ${composioHints.length} Composio tool schema(s) for skill "${skill.title}"`);
    }
  }

  // Append tool scope notice so the LLM knows its constraints
  if (toolWhitelist) {
    const scopedNames = [...toolWhitelist].filter(n => !n.startsWith("cos_") && !/^(ROAM_|LOCAL_MCP_|REMOTE_MCP_|EXT_)(ROUTE|EXECUTE)$/.test(n));
    systemPromptSuffix += `\n\nTOOL SCOPE: This skill has a restricted tool set. In addition to core Roam and COS tools, you have access to: ${scopedNames.join(", ")}. Do not attempt to call other tools — they are not available for this skill run. IMPORTANT: ROAM_EXECUTE is ONLY for Roam extended tools (discovered via ROAM_ROUTE). Do NOT pass LOCAL_MCP_EXECUTE, search_issues, or other non-Roam tool names to ROAM_EXECUTE — they will fail.`;
  }

  // Parse and inject skill constraints (Must Do / Must Not Do / Prefer / Escalate)
  const constraints = parseSkillConstraints(skill.content);
  const constraintsSection = formatConstraintsPromptSection(constraints);
  if (constraintsSection) {
    systemPromptSuffix += constraintsSection;
    deps.debugLog(`[Chief flow] Skill "${skill.title}" constraints:`, constraints);
  }

  // Parse and inject pre-flight acceptance criteria (#113)
  const acceptance = parseSkillAcceptance(skill.content);
  if (acceptance.length > 0) {
    systemPromptSuffix += `\n\n## Pre-flight Acceptance Criteria (Required)\nYour output MUST satisfy ALL of the following before responding:\n${acceptance.map(a => `- ${a}`).join("\n")}`;
    deps.debugLog(`[Chief flow] Skill "${skill.title}" acceptance criteria: ${acceptance.length} items`);
  }

  const systemPrompt = `${await buildDefaultSystemPrompt(skillPrompt)}

## Active Skill (Explicitly Requested)
${wrapUntrustedWithInjectionScan("skill_content", skill.content)}
${systemPromptSuffix}${mcpToolHintsSection}`;

  const gatheringGuard = expectedSources.length > 0 ? { expectedSources, source: "pre-loop" } : null;
  if (gatheringGuard) {
    deps.debugLog(`[Chief flow] Gathering guard active: ${expectedSources.length} expected sources for "${skill.title}"`);
  }

  // Parse optional per-skill budget constraints (Budget:, Tier:, Iterations:)
  const parsedBudget = parseSkillBudget(skill.content);
  const skillTier = parsedBudget.tier || "power";
  const skillPowerMode = skillTier !== "mini";

  // Iteration cap: explicit Iterations: field > source-based calculation > default
  const sourceBasedIterations = gatheringGuard
    ? Math.min(expectedSources.length + 4, deps.MAX_AGENT_ITERATIONS_SKILL)
    : undefined;
  const skillMaxIterations = parsedBudget.maxIterations || sourceBasedIterations;

  if (parsedBudget.budgetUsd || parsedBudget.tier || parsedBudget.maxIterations) {
    deps.debugLog(`[Chief flow] Skill "${skill.title}" budget: tier=${skillTier}, budget=${parsedBudget.budgetUsd ? "$" + parsedBudget.budgetUsd : "none"}, iterations=${skillMaxIterations || "default"}`);
  }

  // Parse optional per-skill model preferences (Models: +Mistral, -Gemini)
  const skillModels = parseSkillModels(skill.content);
  if (skillModels.exclude.length > 0 || skillModels.prefer.length > 0) {
    deps.debugLog(`[Chief flow] Skill "${skill.title}" models: exclude=[${skillModels.exclude}], prefer=[${skillModels.prefer}]`);
  }

  const result = await deps.runAgentLoopWithFailover(skillPrompt, {
    systemPrompt,
    powerMode: skillPowerMode,
    tier: skillTier,
    gatheringGuard,
    toolWhitelist: toolWhitelist || undefined,
    ...(skillMaxIterations ? { maxIterations: skillMaxIterations } : {}),
    ...(parsedBudget.budgetUsd ? { skillBudgetUsd: parsedBudget.budgetUsd } : {}),
    ...(skillModels.exclude.length > 0 ? { excludeProviders: new Set(skillModels.exclude) } : {}),
    ...(skillModels.prefer.length > 0 ? { preferProvider: skillModels.prefer[0] } : {}),
    onToolCall: (name, args) => {
      showInfoToastIfAllowed("Using tool", name, suppressToasts);
      if (onToolCall) onToolCall(name, args);
    },
    onTextChunk
  });
  let responseText = String(result?.text || "").trim().replace(/\[Key reference:[^\]]*\]\s*/g, "").trim() || "No response generated.";

  // Audit: declared vs actually-called tools + budget usage
  if (typeof deps.getLastAgentRunTrace === "function") {
    const trace = deps.getLastAgentRunTrace();
    if (toolWhitelist) {
      const calledNames = new Set((trace?.toolCalls || []).map(tc => tc.name).filter(Boolean));
      const declaredNonCore = [...toolWhitelist].filter(n => !n.startsWith("cos_") && !/^(ROAM_|LOCAL_MCP_|REMOTE_MCP_|EXT_)(ROUTE|EXECUTE)$/.test(n));
      const unusedDeclared = declaredNonCore.filter(n => !calledNames.has(n));
      deps.debugLog(`[Chief flow] Skill "${skill.title}" tool audit: declared=${declaredNonCore.length}, called=${calledNames.size}, unused=[${unusedDeclared.join(", ")}]`);
    }
    if (parsedBudget.budgetUsd || parsedBudget.tier || parsedBudget.maxIterations) {
      deps.debugLog(`[Chief flow] Skill "${skill.title}" budget audit: tier=${skillTier}, ` +
        `cost=$${(trace?.cost || 0).toFixed(3)}${parsedBudget.budgetUsd ? "/$" + parsedBudget.budgetUsd.toFixed(3) : ""}, ` +
        `iterations=${trace?.iterations || 0}${parsedBudget.maxIterations ? "/" + parsedBudget.maxIterations : ""}`);
    }
  }

  // Preserve the actual briefing content for eval before it gets overwritten
  let evalResponseText = responseText;

  // If it's a daily-page-write skill, write the output to the DNP from code.
  if (isDailyPageWriteSkill) {
    // Strip LLM preamble/postamble — keep only lines starting with #, -, *, or digit
    const contentLines = responseText.split("\n");
    const firstStructuredLine = contentLines.findIndex(l => /^#{1,6}\s|^[-*]\s|^\d+[.)]\s/.test(l.trim()));
    const lastStructuredLine = (() => {
      for (let j = contentLines.length - 1; j >= 0; j--) {
        if (/^#{1,6}\s|^[-*]\s|^\d+[.)]\s|^\s+[-*]\s/.test(contentLines[j].trim())) return j;
      }
      return -1;
    })();
    let cleanedText = firstStructuredLine >= 0 && lastStructuredLine >= firstStructuredLine
      ? contentLines.slice(firstStructuredLine, lastStructuredLine + 1).join("\n").trim()
      : responseText;

    // Flatten accidental LLM indentation on list items so they become siblings
    // under their heading rather than progressively nested children.
    // Headings and non-list lines are preserved as-is.
    cleanedText = cleanedText.split("\n").map(line => {
      // If the line is an indented list item, strip leading whitespace
      if (/^\s+([-*]|\d+[.)]) /.test(line)) return line.trimStart();
      return line;
    }).join("\n");
    if (cleanedText.length > 40) {
      try {
        const heading = `[[Chief of Staff Daily Briefing]]`;
        const writeResult = await deps.writeStructuredResponseToTodayDailyPage(heading, cleanedText);
        showInfoToastIfAllowed("Saved to Roam", `Added under ${writeResult.pageTitle}.`, suppressToasts);
        responseText = `Briefing written to today's daily page under ${heading}.`;
      } catch (error) {
        deps.debugLog("[Chief flow] Skill auto-write to DNP failed:", error?.message || error);
      }
    } else {
      deps.debugLog("[Chief flow] Skill response doesn't look like briefing content, skipping DNP write:", responseText.slice(0, 200));
    }
  }

  // Persist audit log entry for skill runs (non-blocking, non-fatal)
  // Skill runs go through runAgentLoopWithFailover so a trace exists.
  if (typeof deps.getLastAgentRunTrace === "function") {
    const auditTrace = deps.getLastAgentRunTrace();
    if (auditTrace) {
      persistAuditLogEntry(auditTrace, skillPrompt, { skillName: skill.title });
      recordUsageStat("agentRuns");
    }
  }

  // Non-blocking skill eval (opt-in, non-fatal)
  // Use evalResponseText (actual briefing content) rather than the confirmation message
  const textForEval = evalResponseText || responseText;
  if (typeof deps.evaluateAgentRun === "function") {
    try {
      const evalTrace = typeof deps.getLastAgentRunTrace === "function" ? deps.getLastAgentRunTrace() : null;
      const rubric = parseSkillRubric(skill.content);
      // Merge acceptance criteria (pre-flight) with rubric for post-run eval
      const allChecks = [...acceptance, ...rubric];
      deps.debugLog("[Chief flow] Triggering skill eval:", skill.title, "acceptance:", acceptance.length, "rubric:", rubric.length, "trace:", !!evalTrace);
      deps.evaluateAgentRun(evalTrace, skillPrompt, textForEval, {
        skillName: skill.title,
        rubricChecks: allChecks.length > 0 ? allChecks : null
      }).catch(err => {
        deps.debugLog("[Chief flow] Skill eval error (non-fatal):", err?.message || err);
      });
    } catch (evalErr) {
      deps.debugLog("[Chief flow] Skill eval setup error (non-fatal):", evalErr?.message || evalErr);
    }
  } else {
    deps.debugLog("[Chief flow] evaluateAgentRun not available in deps");
  }

  return responseText;
}

// ── Connection summary ─────────────────────────────────────────────────────────

async function getDeterministicConnectionSummary(extensionAPI) {
  const client = await connectComposio(extensionAPI, { suppressConnectedToast: true });
  if (client?.callTool) {
    await reconcileInstalledToolsWithComposio(extensionAPI);
  }

  const state = getToolsConfigState(extensionAPI);
  const installed = state.installedTools.filter((tool) => tool.installState === "installed");
  const pending = state.installedTools.filter((tool) => tool.installState === "pending_auth");
  const failed = state.installedTools.filter((tool) => tool.installState === "failed");

  if (!installed.length && !pending.length && !failed.length) {
    return "No Composio tools are currently tracked as connected. Install a tool from the command palette to get started.";
  }

  const formatToolList = (tools) =>
    tools.map((tool) => String(tool.label || tool.slug || "").trim()).filter(Boolean).join(", ");

  const lines = [];
  if (installed.length) lines.push(`Connected: ${formatToolList(installed)}`);
  if (pending.length) lines.push(`Pending auth: ${formatToolList(pending)}`);
  if (failed.length) lines.push(`Failed: ${formatToolList(failed)}`);
  return lines.join("\n");
}

// ── Help summary ───────────────────────────────────────────────────────────────

/**
 * Build a context-aware capability summary for /help.
 * Gathers live state from every integration surface and returns markdown.
 */
export async function buildHelpSummary() {
  const lines = [];
  const extensionAPIRef = deps.getExtensionAPIRef();
  const provider = extensionAPIRef ? deps.getLlmProvider(extensionAPIRef) : "unknown";
  const providerLabel = { anthropic: "Anthropic", openai: "OpenAI", gemini: "Google Gemini", mistral: "Mistral", groq: "Groq" }[provider] || provider;
  const assistantName = deps.getAssistantDisplayName();

  lines.push(`## ${assistantName}`);
  lines.push("");
  lines.push(`I'm your AI assistant inside Roam Research. Here's what I can do right now:\n`);

  // ── AI provider ──
  lines.push(`**AI provider:** ${providerLabel}`);
  lines.push(`- Default model tier: mini · Type \`/power\` before a message for a stronger model, or \`/ludicrous\` for the strongest`);

  // Provider key count + fallback nudge
  if (extensionAPIRef) {
    const providerKeyMap = {
      anthropic: { key: deps.SETTINGS_KEYS.anthropicApiKey, label: "Anthropic" },
      openai: { key: deps.SETTINGS_KEYS.openaiApiKey, label: "OpenAI" },
      gemini: { key: deps.SETTINGS_KEYS.geminiApiKey, label: "Gemini" },
      mistral: { key: deps.SETTINGS_KEYS.mistralApiKey, label: "Mistral" },
      groq: { key: deps.SETTINGS_KEYS.groqApiKey, label: "Groq" }
    };
    const configured = [];
    for (const [prov, { key, label }] of Object.entries(providerKeyMap)) {
      if (deps.getSettingString(extensionAPIRef, key, "")) configured.push(label);
    }
    if (configured.length >= 2) {
      lines.push(`- API keys configured: ${configured.join(", ")} · Automatic failover is active for rate limits and outages`);
    } else if (configured.length === 1) {
      lines.push(`- API key configured: ${configured[0]} only · Add keys for other providers in Settings to enable automatic failover on rate limits`);
    }
  }
  lines.push("");

  // ── Roam tools ──
  const roamTools = deps.getRoamNativeTools() || [];
  lines.push(`**Roam tools** (${roamTools.length}): Search, create, update, move, and delete blocks and pages; query your graph; build outlines`);
  lines.push("");

  // ── Extension tools ──
  try {
    const registry = deps.getExtensionToolsRegistry();
    const extToolsConfig = deps.getExtToolsConfig();
    const extNames = [];
    for (const [extKey, ext] of Object.entries(registry)) {
      if (!extToolsConfig[extKey]?.enabled) continue;
      if (!ext || !Array.isArray(ext.tools) || !ext.tools.length) continue;
      const label = String(ext.name || extKey).trim();
      const count = ext.tools.filter(t => t?.name && typeof t.execute === "function").length;
      if (count) extNames.push(`${label} (${count})`);
    }
    if (extNames.length) {
      lines.push(`**Extension tools:** ${extNames.join(", ")}`);
      lines.push("");
    }
  } catch { /* ignore */ }

  // ── Local MCP ──
  const localMcpTools = getLocalMcpTools() || [];
  if (localMcpTools.length > 0) {
    const byServer = new Map();
    for (const t of localMcpTools) {
      const sn = t._serverName || "Unknown";
      if (!byServer.has(sn)) byServer.set(sn, 0);
      byServer.set(sn, byServer.get(sn) + 1);
    }
    const serverSummaries = [];
    for (const [name, count] of byServer) serverSummaries.push(`${name} (${count})`);
    lines.push(`**Local MCP servers:** ${serverSummaries.join(", ")}`);
  } else {
    lines.push("**Local MCP servers:** Not connected · Configure in Settings → Local MCP Server Ports · [Setup guide](https://github.com/mlava/chief-of-staff#3-connect-local-mcp-servers-optional)");
  }
  lines.push("");

  // ── Composio ──
  try {
    const state = extensionAPIRef ? getToolsConfigState(extensionAPIRef) : { installedTools: [] };
    const connected = state.installedTools.filter(t => t.installState === "installed");
    if (connected.length > 0) {
      lines.push(`**External services** (Composio): ${connected.map(t => t.label || t.slug).join(", ")}`);
    } else {
      lines.push("**External services:** None connected · Use the command palette to connect Gmail, Calendar, Todoist, etc. · [Setup guide](https://github.com/mlava/chief-of-staff#2-connect-composio-optional)");
    }
  } catch { /* ignore */ }
  lines.push("");

  // ── Memory ──
  const memoryPromptCache = deps.getMemoryPromptCache();
  const hasMemory = memoryPromptCache.content && memoryPromptCache.content.length > 20;
  if (hasMemory) {
    lines.push("**Memory:** Active · I remember your preferences, projects, and decisions across sessions · See `[[Chief of Staff/Memory]]`");
  } else {
    // Check if the memory page exists even though cache is empty
    const memPageUid = window.roamAlphaAPI?.pull?.("[:block/uid]", [":node/title", "Chief of Staff/Memory"]);
    if (memPageUid) {
      lines.push("**Memory:** Page exists but is light on content · Tell me things to remember, or run memory bootstrap from the command palette · See `[[Chief of Staff/Memory]]`");
    } else {
      lines.push("**Memory:** Not yet populated · Tell me things to remember, or run memory bootstrap from the command palette");
    }
  }
  lines.push("");

  // ── Skills ──
  // Ensure skills cache is populated (it may be empty if no agent loop has run yet)
  const skillsPromptCache = deps.getSkillsPromptCache();
  let skillEntries = skillsPromptCache.entries;
  if (!skillEntries || skillEntries.length === 0) {
    try {
      skillEntries = await deps.getSkillEntries();
    } catch { skillEntries = []; }
  }
  const hasSkills = skillEntries && skillEntries.length > 0;
  lines.push(hasSkills
    ? `**Skills:** ${skillEntries.length} skill${skillEntries.length > 1 ? "s" : ""} loaded · Custom workflows you've taught me`
    : "**Skills:** None defined yet · Create skills on the Chief of Staff/Skills page"
  );
  lines.push("");

  // ── Cron ──
  try {
    const jobs = loadCronJobs();
    const enabled = jobs.filter(j => j.enabled !== false);
    if (enabled.length > 0) {
      lines.push(`**Scheduled jobs:** ${enabled.length} active · Automated tasks running on a schedule`);
      lines.push("");
    }
  } catch { /* ignore */ }

  // ── Commands ──
  lines.push("**Chat commands:**");
  lines.push("- `/help` — This summary");
  lines.push("- `/clear` — Clear chat history");
  lines.push("- `/compact` — Compress older turns into a summary to free up context");
  lines.push("- `/doctor` — Run a health check on API keys, MCP servers, memory, skills, and more");
  lines.push("- `/lesson` — Record lessons learned from this conversation");
  lines.push("- `/power` — Use a more capable model for this message");
  lines.push("- `/ludicrous` — Use the most capable model");
  lines.push("- `/claude`, `/gemini`, `/openai`, `/mistral`, `/groq` — Force a specific provider for this message");
  lines.push("");
  lines.push("**Tips:** Ask me to search your graph, manage tasks, send emails, create pages, run your daily briefing, or anything else. I'll use the right tools automatically.");

  return lines.join("\n");
}

// ── Doctor / health check ─────────────────────────────────────────────────────

async function runDoctorChecks() {
  const checks = [];
  const extensionAPI = deps.getExtensionAPIRef();

  // ── 1. API Keys ──
  try {
    const providers = deps.VALID_LLM_PROVIDERS || [];
    const primary = extensionAPI ? deps.getLlmProvider(extensionAPI) : "anthropic";
    const perProvider = [];
    let configuredCount = 0;
    let primaryOk = false;
    const coolingDown = [];

    for (const p of providers) {
      const hasKey = Boolean(extensionAPI && deps.getApiKeyForProvider(extensionAPI, p));
      const cooling = deps.isProviderCoolingDown(p);
      if (hasKey) configuredCount++;
      if (p === primary && hasKey) primaryOk = true;
      if (cooling) coolingDown.push(p);
      perProvider.push(`${p}: ${hasKey ? "configured" : "missing"}${cooling ? " (cooling down)" : ""}${p === primary ? " [primary]" : ""}`);
    }

    const status = !primaryOk ? "fail" : coolingDown.includes(primary) ? "warn" : configuredCount < 2 ? "warn" : "pass";
    const suggestion = !primaryOk
      ? `Add an API key for ${primary} in Settings > API Keys.`
      : configuredCount < 2
        ? "Add keys for additional providers to enable automatic failover."
        : coolingDown.length
          ? `${coolingDown.join(", ")} currently cooling down after a rate limit.`
          : "";
    checks.push({ area: "API Keys", status, details: `${configuredCount}/${providers.length} configured. ${perProvider.join("; ")}.`, suggestion });
  } catch (e) {
    checks.push({ area: "API Keys", status: "fail", details: `Check failed: ${e?.message}`, suggestion: "Ensure extension settings are accessible." });
  }

  // ── 2. Local MCP ──
  try {
    const clients = getLocalMcpClients();
    if (!clients || clients.size === 0) {
      checks.push({ area: "Local MCP", status: "pass", details: "No local MCP servers configured.", suggestion: "" });
    } else {
      const servers = [];
      let failCount = 0;
      let warnCount = 0;
      for (const [port, entry] of clients) {
        const name = entry.serverName || `port ${port}`;
        const toolCount = Array.isArray(entry.tools) ? entry.tools.length : 0;
        const connected = toolCount > 0;
        const failures = entry.failureCount || 0;
        if (!connected) { failCount++; servers.push(`${name}: disconnected`); }
        else if (failures > 0) { warnCount++; servers.push(`${name}: ${toolCount} tools (${failures} recent failure${failures !== 1 ? "s" : ""})`); }
        else { servers.push(`${name}: ${toolCount} tools`); }
      }
      const status = failCount > 0 ? "fail" : warnCount > 0 ? "warn" : "pass";
      const suggestion = failCount > 0 ? "Check that local MCP servers are running and ports are correct." : "";
      checks.push({ area: "Local MCP", status, details: `${clients.size} server(s). ${servers.join("; ")}.`, suggestion });
    }
  } catch (e) {
    checks.push({ area: "Local MCP", status: "fail", details: `Check failed: ${e?.message}`, suggestion: "" });
  }

  // ── 3. Remote MCP ──
  try {
    const clients = getRemoteMcpClients();
    if (!clients || clients.size === 0) {
      checks.push({ area: "Remote MCP", status: "pass", details: "No remote MCP servers configured.", suggestion: "" });
    } else {
      const servers = [];
      let failCount = 0;
      let warnCount = 0;
      for (const [, entry] of clients) {
        const name = entry.serverName || "Unknown";
        const toolCount = Array.isArray(entry.tools) ? entry.tools.length : 0;
        const connected = toolCount > 0;
        const failures = entry.failureCount || 0;
        if (!connected) { failCount++; servers.push(`${name}: disconnected`); }
        else if (failures > 0) { warnCount++; servers.push(`${name}: ${toolCount} tools (${failures} recent failure${failures !== 1 ? "s" : ""})`); }
        else { servers.push(`${name}: ${toolCount} tools`); }
      }
      const status = failCount > 0 ? "fail" : warnCount > 0 ? "warn" : "pass";
      const suggestion = failCount > 0 ? "Check remote MCP server URLs and auth tokens in Settings." : "";
      checks.push({ area: "Remote MCP", status, details: `${clients.size} server(s). ${servers.join("; ")}.`, suggestion });
    }
  } catch (e) {
    checks.push({ area: "Remote MCP", status: "fail", details: `Check failed: ${e?.message}`, suggestion: "" });
  }

  // ── 4. Memory Pages ──
  try {
    const titles = deps.MEMORY_PAGE_TITLES_BASE || [];
    const roamApi = deps.getRoamAlphaApi();
    const missing = [];
    for (const title of titles) {
      const exists = roamApi?.data?.pull ? roamApi.data.pull("[:node/title]", [":node/title", title]) : null;
      if (!exists) missing.push(title.replace("Chief of Staff/", ""));
    }

    // Size cap check — use cache if warm, otherwise load fresh
    const memCache = deps.getMemoryPromptCache();
    let memContent = memCache?.content || "";
    if (!memContent && typeof deps.getAllMemoryContent === "function") {
      memContent = await deps.getAllMemoryContent({ force: false }) || "";
    }
    const totalChars = memContent.length;
    const totalCap = deps.MEMORY_TOTAL_MAX_CHARS || 8000;
    const nearCap = totalChars > totalCap * 0.85;

    if (missing.length === 0 && !nearCap) {
      checks.push({ area: "Memory Pages", status: "pass", details: `All ${titles.length} pages exist. Memory size: ${totalChars}/${totalCap} chars.`, suggestion: "" });
    } else if (missing.length > 0 && nearCap) {
      checks.push({ area: "Memory Pages", status: "warn", details: `${missing.length} page(s) missing: ${missing.join(", ")}. Memory at ${totalChars}/${totalCap} chars (${Math.round(totalChars / totalCap * 100)}%).`, suggestion: "Run 'Initialise memory' from the command palette. Consider pruning older memory entries to stay under the cap." });
    } else if (nearCap) {
      checks.push({ area: "Memory Pages", status: "warn", details: `All ${titles.length} pages exist. Memory at ${totalChars}/${totalCap} chars (${Math.round(totalChars / totalCap * 100)}%).`, suggestion: "Memory is near the size cap — older entries may be truncated. Consider pruning to keep the most relevant context." });
    } else {
      checks.push({ area: "Memory Pages", status: "warn", details: `${missing.length} page(s) missing: ${missing.join(", ")}. Memory size: ${totalChars}/${totalCap} chars.`, suggestion: "Run 'Initialise memory' from the command palette to create them." });
    }
  } catch (e) {
    checks.push({ area: "Memory Pages", status: "fail", details: `Check failed: ${e?.message}`, suggestion: "" });
  }

  // ── 5. Skills ──
  try {
    const roamApi = deps.getRoamAlphaApi();
    const skillsPageTitle = "Chief of Staff/Skills";
    const pageExists = roamApi?.data?.pull ? roamApi.data.pull("[:node/title]", [":node/title", skillsPageTitle]) : null;
    if (!pageExists) {
      checks.push({ area: "Skills", status: "warn", details: "Skills page does not exist.", suggestion: "Run 'Initialise skills' from the command palette." });
    } else {
      const entries = await deps.getSkillEntries({ force: true });
      if (!entries || entries.length === 0) {
        checks.push({ area: "Skills", status: "warn", details: "Skills page exists but no valid skills found.", suggestion: "Add skill definitions as child blocks under Chief of Staff/Skills." });
      } else {
        checks.push({ area: "Skills", status: "pass", details: `${entries.length} skill(s) parsed successfully.`, suggestion: "" });
      }
    }
  } catch (e) {
    checks.push({ area: "Skills", status: "fail", details: `Check failed: ${e?.message}`, suggestion: "" });
  }

  // ── 6. Cron Jobs ──
  try {
    const jobs = loadCronJobs();
    if (!jobs || jobs.length === 0) {
      checks.push({ area: "Cron Jobs", status: "pass", details: "No scheduled jobs configured.", suggestion: "" });
    } else {
      const enabled = jobs.filter(j => j.enabled);
      const withErrors = jobs.filter(j => j.lastRunError);
      const invalidCron = jobs.filter(j => j.type === "cron" && j.expression && !isValidCronExpression(j.expression));
      const status = invalidCron.length > 0 ? "fail" : withErrors.length > 0 ? "warn" : "pass";
      const parts = [`${jobs.length} job(s) (${enabled.length} enabled)`];
      if (withErrors.length > 0) parts.push(`${withErrors.length} with errors`);
      if (invalidCron.length > 0) parts.push(`${invalidCron.length} with invalid cron expression(s)`);
      const suggestion = invalidCron.length > 0
        ? `Fix invalid schedules: ${invalidCron.map(j => j.name || j.id).join(", ")}.`
        : withErrors.length > 0
          ? `Jobs with errors: ${withErrors.map(j => `${j.name || j.id} — ${j.lastRunError}`).join("; ")}.`
          : "";
      checks.push({ area: "Cron Jobs", status, details: `${parts.join(". ")}.`, suggestion });
    }
  } catch (e) {
    checks.push({ area: "Cron Jobs", status: "fail", details: `Check failed: ${e?.message}`, suggestion: "" });
  }

  // ── 7. Composio ──
  try {
    const client = deps.getMcpClient();
    const connected = client != null;
    const state = extensionAPI ? getToolsConfigState(extensionAPI) : { installedTools: [] };
    const installed = (state.installedTools || []).filter(t => t.installState === "installed");
    const pending = (state.installedTools || []).filter(t => t.installState === "pending_auth");
    const failed = (state.installedTools || []).filter(t => t.installState === "failed");
    const total = installed.length + pending.length + failed.length;

    if (total === 0 && !connected) {
      checks.push({ area: "Composio", status: "pass", details: "Not configured.", suggestion: "" });
    } else {
      const parts = [];
      if (connected) parts.push("connected");
      else parts.push("disconnected");
      parts.push(`${installed.length} installed`);
      if (pending.length > 0) parts.push(`${pending.length} pending auth`);
      if (failed.length > 0) parts.push(`${failed.length} failed`);
      const status = !connected && total > 0 ? "warn" : failed.length > 0 ? "warn" : pending.length > 0 ? "warn" : "pass";
      const suggestion = !connected && total > 0
        ? "Composio is disconnected — check your proxy URL and API key in Settings."
        : pending.length > 0
          ? `Complete authentication for: ${pending.map(t => t.slug).join(", ")}.`
          : failed.length > 0
            ? `Reinstall failed tools: ${failed.map(t => t.slug).join(", ")}.`
            : "";
      checks.push({ area: "Composio", status, details: parts.join(", ") + ".", suggestion });
    }
  } catch (e) {
    checks.push({ area: "Composio", status: "fail", details: `Check failed: ${e?.message}`, suggestion: "" });
  }

  // ── 8. Extension Tools ──
  try {
    const registry = deps.getExtensionToolsRegistry();
    const config = deps.getExtToolsConfig();
    if (!registry || Object.keys(registry).length === 0) {
      checks.push({ area: "Extension Tools", status: "pass", details: "No extension tools discovered.", suggestion: "" });
    } else {
      let totalTools = 0;
      let missingExecute = 0;
      const enabledExts = [];
      for (const [extKey, ext] of Object.entries(registry)) {
        if (!config[extKey]?.enabled) continue;
        if (!ext || !Array.isArray(ext.tools)) continue;
        enabledExts.push(ext.name || extKey);
        for (const t of ext.tools) {
          if (!t?.name) continue;
          totalTools++;
          if (typeof t.execute !== "function") missingExecute++;
        }
      }
      const status = missingExecute > 0 ? "warn" : "pass";
      const details = enabledExts.length > 0
        ? `${enabledExts.length} extension(s) enabled (${totalTools} tools): ${enabledExts.join(", ")}.`
        : "Extensions discovered but none enabled.";
      const suggestion = missingExecute > 0 ? `${missingExecute} tool(s) missing execute function — may not work correctly.` : "";
      checks.push({ area: "Extension Tools", status, details, suggestion });
    }
  } catch (e) {
    checks.push({ area: "Extension Tools", status: "fail", details: `Check failed: ${e?.message}`, suggestion: "" });
  }

  return checks;
}

export async function getDoctorReport() {
  const checks = await runDoctorChecks();
  const passed = checks.filter(c => c.status === "pass").length;
  const warned = checks.filter(c => c.status === "warn").length;
  const failed = checks.filter(c => c.status === "fail").length;
  const overallStatus = failed > 0 ? "fail" : warned > 0 ? "warn" : "pass";
  return { checks, summary: { passed, warned, failed, total: checks.length, overallStatus } };
}

export function formatDoctorReportAsMarkdown(report) {
  const statusLabel = { pass: "Pass", warn: "Warning", fail: "Fail" };
  const lines = [];
  lines.push("## Health Check Report\n");

  const { passed, warned, failed, total } = report.summary;
  const overall = failed > 0 ? "Issues found"
    : warned > 0 ? "Mostly healthy, some warnings"
    : "All systems healthy";
  lines.push(`**Overall:** ${overall} (${passed} passed, ${warned} warning${warned !== 1 ? "s" : ""}, ${failed} failed — ${total} checks)\n`);

  for (const check of report.checks) {
    const label = statusLabel[check.status] || check.status;
    lines.push(`**${check.area}** — ${label}`);
    lines.push(`  ${check.details}`);
    if (check.suggestion) lines.push(`  *${check.suggestion}*`);
    lines.push("");
  }
  return lines.join("\n");
}

// ── Main router ────────────────────────────────────────────────────────────────

export async function tryRunDeterministicAskIntent(prompt, context = {}) {
  const {
    suppressToasts = false,
    assistantName = deps.getAssistantDisplayName(),
    installedToolSlugsForIntents = [],
    offerWriteToDailyPage = false,
    onToolCall = null,
    onTextChunk = null
  } = context;
  deps.debugLog("[Chief flow] Deterministic router: evaluating.");

  // Mark trace as "local" so the chat panel shows the correct badge
  // instead of the stale model from the previous LLM turn.
  // If no deterministic route matches and the function returns null,
  // the agent loop overwrites lastAgentRunTrace with the real trace.
  deps.setLastAgentRunTrace({ model: "local", iterations: 0, toolCalls: [] });

  // /help — context-aware capability summary
  if (/^\/help\s*$/i.test(prompt) || /^\bhelp\b\s*$/i.test(prompt)) {
    deps.debugLog("[Chief flow] Deterministic route matched: help");
    const helpText = await buildHelpSummary();
    return deps.publishAskResponse(prompt, helpText, assistantName, suppressToasts);
  }

  // ── Doctor / health check ──────────────────────────────────────
  if (isDoctorIntent(prompt)) {
    deps.debugLog("[Chief flow] Deterministic route matched: doctor");
    const report = await getDoctorReport();
    const responseText = formatDoctorReportAsMarkdown(report);
    return deps.publishAskResponse(prompt, responseText, assistantName, suppressToasts);
  }

  const extensionAPIRef = deps.getExtensionAPIRef();

  if (extensionAPIRef && isConnectionStatusIntent(prompt)) {
    deps.debugLog("[Chief flow] Deterministic route matched: connection_status");
    const summaryText = await getDeterministicConnectionSummary(extensionAPIRef);
    return deps.publishAskResponse(prompt, summaryText, assistantName, suppressToasts);
  }

  // ── Undo ──────────────────────────────────────────────────────────
  // "undo", "undo that", "oops", "revert", "revert that"
  if (/^(?:undo|oops!?|whoops!?|revert)\s*(?:that|the last|my last|it)?\s*(?:change|action|edit|operation)?[.!?]?\s*$/i.test(prompt)) {
    deps.debugLog("[Chief flow] Deterministic route matched: undo");
    const roamTools = deps.getRoamNativeTools() || [];
    const undoTool = roamTools.find(t => t.name === "roam_undo");
    if (undoTool && typeof undoTool.execute === "function") {
      try {
        await undoTool.execute({});
        return deps.publishAskResponse(prompt, "Done — last action undone.", assistantName, suppressToasts);
      } catch (e) {
        return deps.publishAskResponse(prompt, `Undo failed: ${e?.message || "Unknown error"}`, assistantName, suppressToasts);
      }
    }
  }

  // ── Redo ──────────────────────────────────────────────────────────
  // "redo", "redo that", "redo the last change"
  if (/^redo\s*(?:that|the last|my last|it)?\s*(?:change|action|edit|operation)?[.!?]?\s*$/i.test(prompt)) {
    deps.debugLog("[Chief flow] Deterministic route matched: redo");
    const roamTools = deps.getRoamNativeTools() || [];
    const redoTool = roamTools.find(t => t.name === "roam_redo");
    if (redoTool && typeof redoTool.execute === "function") {
      try {
        await redoTool.execute({});
        return deps.publishAskResponse(prompt, "Done — last action redone.", assistantName, suppressToasts);
      } catch (e) {
        return deps.publishAskResponse(prompt, `Redo failed: ${e?.message || "Unknown error"}`, assistantName, suppressToasts);
      }
    }
  }

  // ── Current page query ──────────────────────────────────────────
  // "what page am I on?", "which page is this?", "where am I?"
  if (/^(?:what|which)\s+page\s+(?:am\s+i\s+on|is\s+this|are?\s+we\s+on)[?.!]?\s*$/i.test(prompt) ||
      /^where\s+am\s+i[?.!]?\s*$/i.test(prompt)) {
    deps.debugLog("[Chief flow] Deterministic route matched: current_page");
    const pageCtx = await deps.getCurrentPageContext();
    if (pageCtx) {
      const label = pageCtx.type === "page"
        ? `You're on **[[${pageCtx.title}]]** (uid: \`${pageCtx.uid}\`).`
        : `You're viewing a block (uid: \`${pageCtx.uid}\`).`;
      return deps.publishAskResponse(prompt, label, assistantName, suppressToasts);
    }
  }

  // ── Orphan pages ───────────────────────────────────────────────
  // "orphan pages", "find orphan pages", "unlinked pages", "pages with no references"
  // MUST come before the search route below — "find orphan pages" matches both
  const orphanPagesMatch = /^(?:(?:find|show|list|get|any|do\s+i\s+have)\s+)?(?:orphan(?:ed)?\s+pages?|pages?\s+with\s+(?:no|zero)\s+(?:references?|links?|backlinks?)|unlinked\s+pages?|unreferenced\s+pages?)(?:\s+in\s+(?:my\s+)?(?:graph|roam))?\s*[?.!]*$/i.test(prompt);
  if (orphanPagesMatch && typeof deps.getOrphanPagesResult === "function") {
    deps.debugLog("[Chief flow] Deterministic route matched: orphan_pages");
    const result = deps.getOrphanPagesResult();
    if (!result) {
      return deps.publishAskResponse(prompt, "The orphan page scan hasn't run yet. It runs during idle time — check back in a few minutes, or enable it in Settings > Automatic Actions.", assistantName, suppressToasts);
    }
    const total = result.orphanCount || result.pages.length;
    const lines = [`**Orphan Pages** (scanned ${new Date(result.scannedAt).toLocaleString()})\n`];
    lines.push(`Found ${total} page${total === 1 ? "" : "s"} with zero incoming references out of ${result.totalPages} total pages.\n`);
    for (const p of result.pages.slice(0, 30)) {
      lines.push(`- [[${p.title}]] (${p.blockCount} block${p.blockCount === 1 ? "" : "s"})`);
    }
    if (total > 30) lines.push(`\n…and ${total - 30} more. Use \`cos_get_orphan_pages\` for the full list.`);
    return deps.publishAskResponse(prompt, lines.join("\n"), assistantName, suppressToasts);
  }

  // ── Stale / broken links ──────────────────────────────────────
  // "stale links", "broken links", "find broken references", "dangling refs"
  // MUST come before the search route below — "find broken references" matches both
  const staleLinksMatch = /^(?:(?:find|show|list|get|any|do\s+i\s+have)\s+)?(?:stale|broken|dead|dangling)\s+(?:links?|references?|refs?)(?:\s+in\s+(?:my\s+)?(?:graph|roam))?\s*[?.!]*$/i.test(prompt);
  if (staleLinksMatch && typeof deps.getStaleLinkResult === "function") {
    deps.debugLog("[Chief flow] Deterministic route matched: stale_links");
    const result = deps.getStaleLinkResult();
    if (!result) {
      return deps.publishAskResponse(prompt, "The stale link scan hasn't run yet. It runs during idle time — check back in a few minutes, or enable it in Settings > Automatic Actions.", assistantName, suppressToasts);
    }
    const lines = [`**Stale Links** (scanned ${new Date(result.scannedAt).toLocaleString()})\n`];
    lines.push(`Found ${result.links.length} broken reference${result.links.length === 1 ? "" : "s"} across ${result.totalBlocks} blocks scanned.\n`);
    for (const link of result.links.slice(0, 30)) {
      if (link.type === "block_ref") {
        lines.push(`- \`((${link.targetUid}))\` in block ((${link.sourceUid})) — block no longer exists`);
      } else {
        lines.push(`- \`[[${link.targetTitle}]]\` in block ((${link.sourceUid})) — page no longer exists`);
      }
    }
    if (result.links.length > 30) lines.push(`\n…and ${result.links.length - 30} more. Use \`cos_get_stale_links\` for the full list.`);
    return deps.publishAskResponse(prompt, lines.join("\n"), assistantName, suppressToasts);
  }

  // ── Skill / cron staleness report ────────────────────────────────
  // Covers "skills"/"jobs"/"crons"/"scheduled jobs"/"scheduled tasks" as the noun.
  // Note: bare "tasks?" is intentionally excluded — it collides with the Better Tasks
  // todo route below ("show my old tasks", "stale tasks"). Use "scheduled tasks" instead.
  const stalenessNoun = "(?:skills?|jobs?|crons?|scheduled\\s+jobs?|scheduled\\s+tasks?)";
  const stalenessLeader = "(?:which|what|any|show|list|get|do\\s+i\\s+have|find)";
  // Form 1 (adjective): "stale skills", "show stale skills", "any overdue jobs"
  const adjPattern = new RegExp(`^(?:${stalenessLeader}\\s+)?(?:stale|overdue|unreviewed|old|outdated)\\s+${stalenessNoun}\\s*[?.!]*$`, "i");
  // Form 2 (need review): "jobs need review", "which jobs need review", "scheduled jobs needing review"
  const needReviewPattern = new RegExp(`^(?:${stalenessLeader}\\s+)?${stalenessNoun}\\s+(?:need(?:ing)?|due\\s+for|that\\s+need)\\s+(?:review|reviewing|a\\s+review)\\s*[?.!]*$`, "i");
  // Form 3 (review my): "review my skills", "review my scheduled tasks"
  const reviewMyPattern = new RegExp(`^review\\s+(?:my\\s+)?${stalenessNoun}\\s*[?.!]*$`, "i");
  // Form 4 (which X are Y): "which skills are stale", "which jobs are overdue"
  const whichArePattern = new RegExp(`^(?:which|what)\\s+${stalenessNoun}\\s+are\\s+(?:stale|old|overdue|unreviewed|outdated)\\s*[?.!]*$`, "i");
  // Form 5 (special phrases)
  const specialPattern = /^(?:staleness\s+report|review\s+report|what\s+needs\s+review)\s*[?.!]*$/i;
  const staleSkillsMatch = adjPattern.test(prompt)
    || needReviewPattern.test(prompt)
    || reviewMyPattern.test(prompt)
    || whichArePattern.test(prompt)
    || specialPattern.test(prompt);
  if (staleSkillsMatch && typeof deps.getSkillEntries === "function" && typeof deps.getStaleCronJobs === "function") {
    deps.debugLog("[Chief flow] Deterministic route matched: stale_skills");
    try {
      const entries = await deps.getSkillEntries({ force: false });
      const now = Date.now();
      const extApi = deps.getExtensionAPIRef();
      const rawDays = parseInt(deps.getSettingString(extApi, deps.SETTINGS_KEYS?.skillStalenessDays, "30"), 10);
      const stalenessDays = isNaN(rawDays) || rawDays < 1 ? 30 : rawDays;
      const stalenessMs = stalenessDays * 24 * 60 * 60 * 1000;
      // Grandfather floor: items with no review date fall back to upgrade-day timestamp
      // so existing skills/crons get a full grace window before being flagged.
      const grandfatherRaw = extApi?.settings?.get?.(deps.SETTINGS_KEYS?.stalenessGrandfatherAt);
      const grandfatherAt = Number.isFinite(grandfatherRaw) ? grandfatherRaw : parseInt(grandfatherRaw || "0", 10) || 0;
      const staleSkills = entries.filter(e => {
        const d = parseSkillLastReviewed(e.content);
        const reviewedAt = d ? d.getTime() : grandfatherAt;
        return (now - reviewedAt) > stalenessMs;
      });
      const staleCrons = deps.getStaleCronJobs(stalenessDays, { grandfatherAt });

      if (!staleSkills.length && !staleCrons.length) {
        return deps.publishAskResponse(prompt, `All skills and scheduled jobs have been reviewed within the last ${stalenessDays} days. Nothing needs attention.`, assistantName, suppressToasts);
      }
      const lines = ["**Staleness Report**\n"];
      if (staleSkills.length) {
        lines.push(`**${staleSkills.length} skill${staleSkills.length > 1 ? "s" : ""} needing review:**`);
        for (const s of staleSkills) {
          const d = parseSkillLastReviewed(s.content);
          const age = d ? `last reviewed ${Math.floor((now - d.getTime()) / 86400000)}d ago` : "never reviewed";
          lines.push(`- ${s.title} (${age})`);
        }
      }
      if (staleCrons.length) {
        lines.push(`\n**${staleCrons.length} scheduled job${staleCrons.length > 1 ? "s" : ""} needing review:**`);
        for (const j of staleCrons) {
          const age = j.lastReviewed > 0 ? `last reviewed ${Math.floor((now - j.lastReviewed) / 86400000)}d ago` : "never reviewed";
          lines.push(`- ${j.name} (${j.id}) — ${age}`);
        }
      }
      lines.push(`\nUse \`cos_review_skill\` or \`cos_review_cron\` to mark items as reviewed after checking them.`);
      return deps.publishAskResponse(prompt, lines.join("\n"), assistantName, suppressToasts);
    } catch (err) {
      deps.debugLog("[Chief flow] Staleness route error:", err?.message);
      // Fall through to agent loop on error
    }
  }

  // ── Deterministic search ─────────────────────────────────────────
  // "search for X", "find X in my graph", "search X", "look up X", "search roam for X"
  const searchMatch = prompt.match(/^(?:search\s+(?:for|roam\s+for|my\s+(?:graph|roam)\s+for)?|find|look\s*up)\s+(.+?)(?:\s+in\s+(?:my\s+)?(?:graph|roam))?\s*[?.!]*$/i);
  if (searchMatch) {
    const query = searchMatch[1].replace(/^["']|["']$/g, "").trim();
    if (query && query.length >= 2) {
      deps.debugLog("[Chief flow] Deterministic route matched: search", query);
      const roamTools = deps.getRoamNativeTools() || [];
      const tool = roamTools.find(t => t.name === "roam_search");
      if (tool && typeof tool.execute === "function") {
        try {
          const results = await tool.execute({ query, max_results: 20 });
          if (!Array.isArray(results) || results.length === 0) {
            return deps.publishAskResponse(prompt, `No results found for "${query}".`, assistantName, suppressToasts);
          }
          const lines = [`**Search results for "${query}"** (${results.length} match${results.length === 1 ? "" : "es"}):\n`];
          for (const r of results) {
            const pageRef = r.page ? `[[${r.page}]]` : "";
            const text = String(r.text || "").slice(0, 200);
            lines.push(`- ${pageRef}: ${text}`);
          }
          return deps.publishAskResponse(prompt, lines.join("\n"), assistantName, suppressToasts);
        } catch (e) {
          return deps.publishAskResponse(prompt, `Search failed: ${e?.message || "Unknown error"}`, assistantName, suppressToasts);
        }
      }
    }
  }

  // ── Get page by [[title]] ──────────────────────────────────────
  // "what's on [[Page]]", "show me [[Page]]", "get [[Page]]", "read [[Page]]", "contents of [[Page]]"
  const getPageMatch = prompt.match(/^(?:what(?:'s| is)\s+on|show\s+me\s+(?:the\s+(?:contents?\s+of|page)\s+)?|get|read|display|contents?\s+of)\s+\[\[([^\]]+)\]\]\s*[?.!]*$/i);
  if (getPageMatch) {
    const pageTitle = getPageMatch[1].trim();
    deps.debugLog("[Chief flow] Deterministic route matched: get_page", pageTitle);
    const roamTools = deps.getRoamNativeTools() || [];
    const tool = roamTools.find(t => t.name === "roam_get_page");
    if (tool && typeof tool.execute === "function") {
      try {
        const tree = await tool.execute({ title: pageTitle });
        if (!tree || (Array.isArray(tree) && tree.length === 0) || tree?.notFound) {
          return deps.publishAskResponse(prompt, `Page **[[${pageTitle}]]** not found or is empty.`, assistantName, suppressToasts);
        }
        const formatted = deps.formatBlockTreeForDisplay(tree, pageTitle);
        return deps.publishAskResponse(prompt, formatted, assistantName, suppressToasts);
      } catch (e) {
        return deps.publishAskResponse(prompt, `Could not get page: ${e?.message || "Unknown error"}`, assistantName, suppressToasts);
      }
    }
  }

  // ── TODOs ──────────────────────────────────────────────────────
  // "show my todos", "what are my open tasks", "list todos", "pending tasks", "my todos"
  const todoMatch = prompt.match(/^(?:show\s+(?:me\s+)?(?:my\s+)?|list\s+(?:my\s+)?|what\s+are\s+(?:my\s+)?|get\s+(?:my\s+)?|find\s+(?:my\s+)?)?(?:(?:open|pending|incomplete|outstanding)\s+)?(?:todos?|tasks?|to-?dos?|action\s*items?)\s*[?.!]*$/i);
  if (todoMatch) {
    deps.debugLog("[Chief flow] Deterministic route matched: todos");
    // Prefer Better Tasks search if available
    const extTools = deps.getExternalExtensionTools() || [];
    const btSearch = extTools.find(t => t.name === "bt_search");
    if (btSearch && typeof btSearch.execute === "function") {
      try {
        const results = await btSearch.execute({ status: "TODO" });
        const tasks = Array.isArray(results) ? results : results?.tasks || [];
        if (tasks.length === 0) {
          return deps.publishAskResponse(prompt, "No open tasks found.", assistantName, suppressToasts);
        }
        const lines = [`**Open tasks** (${tasks.length}):\n`];
        for (const t of tasks.slice(0, 30)) {
          const text = t.text || t.title || t.name || JSON.stringify(t);
          const page = t.page ? ` — [[${t.page}]]` : "";
          lines.push(`- ${text}${page}`);
        }
        if (tasks.length > 30) lines.push(`\n…and ${tasks.length - 30} more.`);
        return deps.publishAskResponse(prompt, lines.join("\n"), assistantName, suppressToasts);
      } catch (e) {
        deps.debugLog("[Chief flow] bt_search failed, falling back to roam_find_todos:", e?.message);
      }
    }
    // Fallback to roam_find_todos
    const roamTools = deps.getRoamNativeTools() || [];
    const todoTool = roamTools.find(t => t.name === "roam_find_todos");
    if (todoTool && typeof todoTool.execute === "function") {
      try {
        const result = await todoTool.execute({ status: "TODO", max_results: 30 });
        const todos = result?.todos || [];
        if (todos.length === 0) {
          return deps.publishAskResponse(prompt, "No open TODOs found.", assistantName, suppressToasts);
        }
        const lines = [`**Open TODOs** (${result.count}${result.total > result.count ? ` of ${result.total}` : ""}):\n`];
        for (const t of todos) {
          const page = t.page ? ` — [[${t.page}]]` : "";
          lines.push(`- ${t.text}${page}`);
        }
        return deps.publishAskResponse(prompt, lines.join("\n"), assistantName, suppressToasts);
      } catch (e) {
        return deps.publishAskResponse(prompt, `Could not fetch TODOs: ${e?.message || "Unknown error"}`, assistantName, suppressToasts);
      }
    }
  }

  // ── DONE / completed tasks ──────────────────────────────────────
  // "show done tasks", "completed tasks", "what did I finish", "show finished tasks"
  const doneMatch = prompt.match(/^(?:show\s+(?:me\s+)?(?:my\s+)?|list\s+(?:my\s+)?|what\s+(?:did\s+I\s+(?:finish|complete|do)|are\s+(?:my\s+)?)|get\s+(?:my\s+)?|find\s+(?:my\s+)?)?(?:(?:done|completed?|finished)\s+)?(?:todos?|tasks?|to-?dos?|action\s*items?|items?)(?:\s+(?:done|completed?|finished))?\s*[?.!]*$/i);
  if (doneMatch && /\b(?:done|complet|finish|did\s+I)\b/i.test(prompt)) {
    deps.debugLog("[Chief flow] Deterministic route matched: done_tasks");
    const extTools = deps.getExternalExtensionTools() || [];
    const btSearch = extTools.find(t => t.name === "bt_search");
    if (btSearch && typeof btSearch.execute === "function") {
      try {
        const results = await btSearch.execute({ status: "DONE" });
        const tasks = Array.isArray(results) ? results : results?.tasks || [];
        if (tasks.length === 0) {
          return deps.publishAskResponse(prompt, "No completed tasks found.", assistantName, suppressToasts);
        }
        const lines = [`**Completed tasks** (${tasks.length}):\n`];
        for (const t of tasks.slice(0, 30)) {
          const text = t.text || t.title || t.name || JSON.stringify(t);
          const page = t.page ? ` — [[${t.page}]]` : "";
          lines.push(`- ${text}${page}`);
        }
        if (tasks.length > 30) lines.push(`\n…and ${tasks.length - 30} more.`);
        return deps.publishAskResponse(prompt, lines.join("\n"), assistantName, suppressToasts);
      } catch (e) {
        deps.debugLog("[Chief flow] bt_search DONE failed, falling back to roam_find_todos:", e?.message);
      }
    }
    const roamTools = deps.getRoamNativeTools() || [];
    const todoTool = roamTools.find(t => t.name === "roam_find_todos");
    if (todoTool && typeof todoTool.execute === "function") {
      try {
        const result = await todoTool.execute({ status: "DONE", max_results: 30 });
        const todos = result?.todos || [];
        if (todos.length === 0) {
          return deps.publishAskResponse(prompt, "No completed TODOs found.", assistantName, suppressToasts);
        }
        const lines = [`**Completed TODOs** (${result.count}${result.total > result.count ? ` of ${result.total}` : ""}):\n`];
        for (const t of todos) {
          const page = t.page ? ` — [[${t.page}]]` : "";
          lines.push(`- ${t.text}${page}`);
        }
        return deps.publishAskResponse(prompt, lines.join("\n"), assistantName, suppressToasts);
      } catch (e) {
        return deps.publishAskResponse(prompt, `Could not fetch completed TODOs: ${e?.message || "Unknown error"}`, assistantName, suppressToasts);
      }
    }
  }

  // ── Today's page content ───────────────────────────────────────
  // "what's on today's page", "show today's page content", "today's notes", "what did I write today"
  // NOTE: "what's on today?" must NOT match — that's a calendar/schedule question.
  // We require explicit mention of "page", "note", "daily page", or "did I write" so that
  // bare "what's on today" falls through to the agent loop.
  const todayContentMatch = /^(?:what(?:'s| is)\s+on\s+(?:today(?:'s)?\s+(?:daily\s*)?(?:page|notes?)|(?:my\s+)?(?:the\s+)?daily\s*(?:page|note))|what\s+did\s+I\s+write\s+(?:on\s+)?today|show\s+(?:me\s+)?today(?:'s)?\s+(?:page\s+)?(?:content|notes?)|today(?:'s)?\s+(?:page\s+)?(?:content|notes?))\s*[?.!]*$/i.test(prompt);
  if (todayContentMatch) {
    deps.debugLog("[Chief flow] Deterministic route matched: today_content");
    const roamTools = deps.getRoamNativeTools() || [];
    const tool = roamTools.find(t => t.name === "roam_get_daily_page");
    if (tool && typeof tool.execute === "function") {
      try {
        const tree = await tool.execute({});
        const todayTitle = deps.formatRoamDate(new Date());
        if (!tree || (Array.isArray(tree) && tree.length === 0)) {
          return deps.publishAskResponse(prompt, `Today's page (**[[${todayTitle}]]**) is empty.`, assistantName, suppressToasts);
        }
        const formatted = deps.formatBlockTreeForDisplay(tree, todayTitle);
        return deps.publishAskResponse(prompt, formatted, assistantName, suppressToasts);
      } catch (e) {
        return deps.publishAskResponse(prompt, `Could not fetch today's page: ${e?.message || "Unknown error"}`, assistantName, suppressToasts);
      }
    }
  }

  // ── Add to today's page ────────────────────────────────────────
  // "add X to today's page", "add X to today", "add X to the daily page", "note X"
  // This is a WRITE operation — uses roam_create_block (isMutating: true).
  // Approval gating is enforced here to match the published security contract
  // ("every mutating operation requires explicit approval").
  const addTodayMatch = prompt.match(/^(?:add|put|write|note|log|jot(?:\s+down)?|capture)\s+(?:(?:"|')(.+?)(?:"|')|(.+?))\s+(?:to|on|in)\s+(?:my\s+)?(?:today(?:'s)?(?:\s+(?:daily\s*)?(?:page|note))?|the\s+daily\s*(?:page|note)?|DNP)\s*[.!?]*$/i)
    || prompt.match(/^(?:note|log|jot(?:\s+down)?|capture)\s+(?:(?:"|')(.+?)(?:"|')|(.+?))\s*[.!?]*$/i);
  if (addTodayMatch) {
    const blockText = (addTodayMatch[1] || addTodayMatch[2] || "").trim();
    if (blockText && blockText.length >= 2) {
      deps.debugLog("[Chief flow] Deterministic route matched: add_to_today", blockText);
      const roamTools = deps.getRoamNativeTools() || [];
      const createTool = roamTools.find(t => t.name === "roam_create_block");
      if (createTool && typeof createTool.execute === "function") {
        try {
          const todayTitle = deps.formatRoamDate(new Date());
          const pageUid = deps.getPageUidByTitle(todayTitle);
          if (!pageUid) {
            return deps.publishAskResponse(prompt, `Could not find today's page (**${todayTitle}**). Navigate to it first so Roam creates it.`, assistantName, suppressToasts);
          }
          const writeArgs = { parent_uid: pageUid, text: blockText, order: "last" };
          const approved = await promptToolExecutionApproval("roam_create_block", writeArgs);
          if (!approved) {
            return deps.publishAskResponse(prompt, "Cancelled — block was not added.", assistantName, suppressToasts);
          }
          const result = await createTool.execute(writeArgs);
          return deps.publishAskResponse(prompt, `Added to **[[${todayTitle}]]**: "${blockText}"`, assistantName, suppressToasts);
        } catch (e) {
          return deps.publishAskResponse(prompt, `Could not add to today's page: ${e?.message || "Unknown error"}`, assistantName, suppressToasts);
        }
      }
    }
  }

  // ── Recent changes ─────────────────────────────────────────────
  // "what changed today", "recent edits", "recent changes", "what's been modified"
  const recentMatch = /^(?:what(?:'s|\s+has)?\s+(?:been\s+)?(?:changed|modified|edited|updated)|recent\s+(?:changes?|edits?|modifications?)|what\s+changed\s+(?:today|recently|this\s+(?:morning|afternoon|evening)))\s*[?.!]*$/i.test(prompt);
  if (recentMatch) {
    deps.debugLog("[Chief flow] Deterministic route matched: recent_changes");
    const roamTools = deps.getRoamNativeTools() || [];
    const tool = roamTools.find(t => t.name === "roam_get_recent_changes");
    if (tool && typeof tool.execute === "function") {
      try {
        const result = await tool.execute({ hours: 24, limit: 20 });
        const pages = result?.pages || [];
        if (pages.length === 0) {
          return deps.publishAskResponse(prompt, "No pages modified in the last 24 hours.", assistantName, suppressToasts);
        }
        const lines = [`**Recently modified pages** (${result.count}${result.total > result.count ? ` of ${result.total}` : ""}, last 24h):\n`];
        for (const p of pages) {
          const time = p.edited ? new Date(p.edited).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
          lines.push(`- [[${p.title}]]${time ? ` — ${time}` : ""}`);
        }
        return deps.publishAskResponse(prompt, lines.join("\n"), assistantName, suppressToasts);
      } catch (e) {
        return deps.publishAskResponse(prompt, `Could not fetch recent changes: ${e?.message || "Unknown error"}`, assistantName, suppressToasts);
      }
    }
  }

  // ── Sidebar open/close ─────────────────────────────────────────
  // "open sidebar", "open left sidebar", "open right sidebar", "show sidebar"
  const openSidebarMatch = prompt.match(/^(?:open|show|display|toggle)\s+(?:the\s+)?(?:(left|right)\s+)?sidebar\s*[.!?]*$/i);
  if (openSidebarMatch) {
    const side = (openSidebarMatch[1] || "right").toLowerCase();
    const toolName = side === "left" ? "roam_open_left_sidebar" : "roam_open_right_sidebar";
    deps.debugLog(`[Chief flow] Deterministic route matched: open_${side}_sidebar`);
    const roamTools = deps.getRoamNativeTools() || [];
    const tool = roamTools.find(t => t.name === toolName);
    if (tool && typeof tool.execute === "function") {
      try {
        await tool.execute({});
        return deps.publishAskResponse(prompt, `${side.charAt(0).toUpperCase() + side.slice(1)} sidebar opened.`, assistantName, suppressToasts);
      } catch (e) {
        return deps.publishAskResponse(prompt, `Could not open ${side} sidebar: ${e?.message || "Unknown error"}`, assistantName, suppressToasts);
      }
    }
  }
  // "close sidebar", "close left sidebar", "hide sidebar"
  const closeSidebarMatch = prompt.match(/^(?:close|hide|dismiss)\s+(?:the\s+)?(?:(left|right)\s+)?sidebar\s*[.!?]*$/i);
  if (closeSidebarMatch) {
    const side = (closeSidebarMatch[1] || "right").toLowerCase();
    const toolName = side === "left" ? "roam_close_left_sidebar" : "roam_close_right_sidebar";
    deps.debugLog(`[Chief flow] Deterministic route matched: close_${side}_sidebar`);
    const roamTools = deps.getRoamNativeTools() || [];
    const tool = roamTools.find(t => t.name === toolName);
    if (tool && typeof tool.execute === "function") {
      try {
        await tool.execute({});
        return deps.publishAskResponse(prompt, `${side.charAt(0).toUpperCase() + side.slice(1)} sidebar closed.`, assistantName, suppressToasts);
      } catch (e) {
        return deps.publishAskResponse(prompt, `Could not close ${side} sidebar: ${e?.message || "Unknown error"}`, assistantName, suppressToasts);
      }
    }
  }

  // ── UI panel shortcuts ─────────────────────────────────────────
  // "open roam depot", "open graph overview", "open all pages", "open settings", "open help", "open graph view", "share link"
  const uiPanelRoutes = [
    { pattern: /^(?:open|show)\s+(?:the\s+)?(?:roam\s+)?depot\s*[.!?]*$/i,       tool: "roam_open_depot",          label: "Roam Depot" },
    { pattern: /^(?:open|show)\s+(?:the\s+)?graph(?:\s+overview)?\s*[.!?]*$/i,    tool: "roam_open_graph_overview", label: "Graph Overview" },
    { pattern: /^(?:open|show|list)\s+(?:the\s+)?all\s+pages?\s*[.!?]*$/i,        tool: "roam_open_all_pages",      label: "All Pages" },
    { pattern: /^(?:open|show)\s+(?:the\s+)?(?:roam\s+)?settings?\s*[.!?]*$/i,    tool: "roam_open_settings",       label: "Settings" },
    { pattern: /^(?:open|show)\s+(?:the\s+)?graph\s+view\s*[.!?]*$/i,            tool: "roam_open_graph_view",     label: "Graph View" },
    { pattern: /^(?:share|copy)\s+(?:the\s+)?(?:page\s+)?link\s*[.!?]*$/i,       tool: "roam_share_link",          label: "Share Link" },
    { pattern: /^(?:open|show)\s+(?:the\s+)?(?:roam\s+)?help(?:\s+menu)?\s*[.!?]*$/i, tool: "roam_open_help",       label: "Help" },
  ];
  for (const route of uiPanelRoutes) {
    if (route.pattern.test(prompt)) {
      deps.debugLog(`[Chief flow] Deterministic route matched: ${route.tool}`);
      const roamTools = deps.getRoamNativeTools() || [];
      const tool = roamTools.find(t => t.name === route.tool);
      if (tool && typeof tool.execute === "function") {
        try {
          const result = await tool.execute({});
          if (result?.success === false) {
            return deps.publishAskResponse(prompt, `Could not open ${route.label}: ${result.error || "Unknown error"}`, assistantName, suppressToasts);
          }
          return deps.publishAskResponse(prompt, `${route.label} opened.`, assistantName, suppressToasts);
        } catch (e) {
          return deps.publishAskResponse(prompt, `Could not open ${route.label}: ${e?.message || "Unknown error"}`, assistantName, suppressToasts);
        }
      }
    }
  }

  // ── Backlinks ──────────────────────────────────────────────────
  // "what links to [[Page]]", "backlinks for [[Page]]", "references to [[Page]]"
  const backlinksMatch = prompt.match(/^(?:what\s+(?:links?\s+to|references?)|backlinks?\s+(?:for|of|to)|references?\s+(?:for|to|of)|(?:show|get|find|list)\s+(?:me\s+)?(?:backlinks?|references?)\s+(?:for|to|of))\s+\[\[([^\]]+)\]\]\s*[?.!]*$/i);
  if (backlinksMatch) {
    const pageTitle = backlinksMatch[1].trim();
    deps.debugLog("[Chief flow] Deterministic route matched: backlinks", pageTitle);
    const roamTools = deps.getRoamNativeTools() || [];
    const tool = roamTools.find(t => t.name === "roam_get_backlinks");
    if (tool && typeof tool.execute === "function") {
      try {
        const result = await tool.execute({ title: pageTitle, max_results: 30 });
        const backlinks = result?.backlinks || [];
        if (backlinks.length === 0) {
          return deps.publishAskResponse(prompt, `No backlinks found for **[[${pageTitle}]]**.`, assistantName, suppressToasts);
        }
        const lines = [`**Backlinks for [[${pageTitle}]]** (${result.count}${result.total > result.count ? ` of ${result.total}` : ""}):\n`];
        for (const bl of backlinks) {
          const text = String(bl.text || "").slice(0, 150);
          lines.push(`- [[${bl.page}]]: ${text}`);
        }
        return deps.publishAskResponse(prompt, lines.join("\n"), assistantName, suppressToasts);
      } catch (e) {
        return deps.publishAskResponse(prompt, `Could not get backlinks: ${e?.message || "Unknown error"}`, assistantName, suppressToasts);
      }
    }
  }

  // ── Page metadata / stats ──────────────────────────────────────
  // "stats for [[Page]]", "metadata for [[Page]]", "page info for [[Page]]"
  const metadataMatch = prompt.match(/^(?:(?:stats?|statistics?|metadata|page\s*info|info)\s+(?:for|of|on|about)|(?:show|get)\s+(?:me\s+)?(?:stats?|metadata|info)\s+(?:for|of|on|about))\s+\[\[([^\]]+)\]\]\s*[?.!]*$/i);
  if (metadataMatch) {
    const pageTitle = metadataMatch[1].trim();
    deps.debugLog("[Chief flow] Deterministic route matched: page_metadata", pageTitle);
    const roamTools = deps.getRoamNativeTools() || [];
    const tool = roamTools.find(t => t.name === "roam_get_page_metadata");
    if (tool && typeof tool.execute === "function") {
      try {
        const meta = await tool.execute({ title: pageTitle });
        if (!meta || meta.found === false) {
          return deps.publishAskResponse(prompt, `Page **[[${pageTitle}]]** not found.`, assistantName, suppressToasts);
        }
        const lines = [`**[[${meta.title}]]** — page stats:\n`];
        if (meta.created) lines.push(`- Created: ${new Date(meta.created).toLocaleDateString()}`);
        if (meta.edited) lines.push(`- Last edited: ${new Date(meta.edited).toLocaleDateString()}`);
        lines.push(`- Blocks: ${meta.block_count || 0}`);
        lines.push(`- Words: ${meta.word_count || 0}`);
        lines.push(`- References: ${meta.reference_count || 0}`);
        return deps.publishAskResponse(prompt, lines.join("\n"), assistantName, suppressToasts);
      } catch (e) {
        return deps.publishAskResponse(prompt, `Could not get page metadata: ${e?.message || "Unknown error"}`, assistantName, suppressToasts);
      }
    }
  }

  // ── Graph stats / overview ──────────────────────────────────────
  // "how big is my graph", "graph stats", "graph overview", "how many pages do I have"
  const graphStatsMatch = /^(?:(?:how\s+(?:big|large)\s+is\s+(?:my\s+)?(?:graph|roam|database))|(?:graph|roam|database)\s+(?:stats?|statistics?|overview|info|summary)|(?:how\s+many\s+(?:pages?|blocks?|notes?)\s+(?:do\s+I\s+have|are\s+there|in\s+my\s+graph)))\s*[?.!]*$/i.test(prompt);
  if (graphStatsMatch) {
    deps.debugLog("[Chief flow] Deterministic route matched: graph_stats");
    try {
      const api = deps.getRoamAlphaApi();
      const queryApi = deps.requireRoamQueryApi(api);
      const pageCountResult = queryApi.q("[:find (count ?p) :where [?p :node/title]]");
      const blockCountResult = queryApi.q("[:find (count ?b) :where [?b :block/string]]");
      const pageCount = (Array.isArray(pageCountResult) && pageCountResult[0]) ? pageCountResult[0][0] : 0;
      const blockCount = (Array.isArray(blockCountResult) && blockCountResult[0]) ? blockCountResult[0][0] : 0;
      const lines = ["**Graph overview**\n"];
      lines.push(`- Pages: ${pageCount.toLocaleString()}`);
      lines.push(`- Blocks: ${blockCount.toLocaleString()}`);
      // Recent activity
      const roamTools = deps.getRoamNativeTools() || [];
      const recentTool = roamTools.find(t => t.name === "roam_get_recent_changes");
      if (recentTool && typeof recentTool.execute === "function") {
        try {
          const recent = await recentTool.execute({ hours: 24, limit: 5 });
          const recentPages = recent?.pages || [];
          if (recentPages.length > 0) {
            lines.push(`- Pages modified (last 24h): ${recent.total || recentPages.length}`);
          }
        } catch { /* ignore */ }
      }
      // Today's page word count
      try {
        const todayTitle = deps.formatRoamDate(new Date());
        const metaTool = roamTools.find(t => t.name === "roam_get_page_metadata");
        if (metaTool && typeof metaTool.execute === "function") {
          const todayMeta = await metaTool.execute({ title: todayTitle });
          if (todayMeta && todayMeta.found !== false) {
            lines.push(`- Today's page: ${todayMeta.block_count || 0} blocks, ${todayMeta.word_count || 0} words`);
          }
        }
      } catch { /* ignore */ }
      return deps.publishAskResponse(prompt, lines.join("\n"), assistantName, suppressToasts);
    } catch (e) {
      return deps.publishAskResponse(prompt, `Could not get graph stats: ${e?.message || "Unknown error"}`, assistantName, suppressToasts);
    }
  }

  // ── Open in sidebar ────────────────────────────────────────────
  // "open [[Page]] in sidebar", "add [[Page]] to sidebar", "sidebar [[Page]]"
  // Must come BEFORE the navigation route to avoid "open [[X]]" matching nav first
  const sidebarOpenMatch = prompt.match(/^(?:(?:open|add|show|pin)\s+\[\[([^\]]+)\]\]\s+(?:in|to)\s+(?:the\s+)?(?:right\s+)?sidebar|sidebar\s+\[\[([^\]]+)\]\])\s*[.!?]*$/i);
  if (sidebarOpenMatch) {
    const pageTitle = (sidebarOpenMatch[1] || sidebarOpenMatch[2]).trim();
    deps.debugLog("[Chief flow] Deterministic route matched: open_in_sidebar", pageTitle);
    const roamTools = deps.getRoamNativeTools() || [];
    const tool = roamTools.find(t => t.name === "roam_add_right_sidebar_window");
    if (tool && typeof tool.execute === "function") {
      try {
        await tool.execute({ type: "outline", block_uid: pageTitle });
        return deps.publishAskResponse(prompt, `Opened **[[${pageTitle}]]** in the sidebar.`, assistantName, suppressToasts);
      } catch (e) {
        return deps.publishAskResponse(prompt, `Could not open in sidebar: ${e?.message || "Unknown error"}`, assistantName, suppressToasts);
      }
    }
  }

  // ── Time / date queries ───────────────────────────────────────────
  // "what time is it?", "what's today's date?", "what day is it?"
  if (/^(?:what(?:'s| is)?\s+(?:the\s+)?(?:time|date|day)\s*(?:is it|today|now|right now)?|what\s+(?:day|date)\s+is\s+(?:it|today)|what time)\s*[?.!]*\s*$/i.test(prompt)) {
    deps.debugLog("[Chief flow] Deterministic route matched: time_query");
    const roamTools = deps.getRoamNativeTools() || [];
    const timeTool = roamTools.find(t => t.name === "cos_get_current_time");
    if (timeTool && typeof timeTool.execute === "function") {
      try {
        const result = await timeTool.execute({});
        const responseText = `**${result.currentTime}**\nTimezone: ${result.timezone}\nToday's daily page: [[${result.today}]]`;
        return deps.publishAskResponse(prompt, responseText, assistantName, suppressToasts);
      } catch (e) {
        return deps.publishAskResponse(prompt, `Could not get current time: ${e?.message || "Unknown error"}`, assistantName, suppressToasts);
      }
    }
  }

  // ── Relative date navigation ────────────────────────────────────
  // "go to yesterday", "open tomorrow", "show last Monday", "last Friday's page"
  const relativeDateNav = prompt.match(/^(?:open|go\s+to|show|navigate\s+to|view)\s+(?:my\s+)?(?:(yesterday|tomorrow)(?:(?:'s)?\s+(?:page|notes?))?\s*[.!?]*$|(last|next|this)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:(?:'s)?\s+(?:page|notes?))?\s*[.!?]*$)/i)
    || prompt.match(/^(yesterday|tomorrow)(?:(?:'s)?\s+(?:page|notes?))?\s*[.!?]*$/i);
  if (relativeDateNav) {
    const keyword = (relativeDateNav[1] || "").toLowerCase();
    const modifier = (relativeDateNav[2] || "").toLowerCase();
    const dayName = (relativeDateNav[3] || "").toLowerCase();
    let targetDate = new Date();

    if (keyword === "yesterday") {
      targetDate.setDate(targetDate.getDate() - 1);
    } else if (keyword === "tomorrow") {
      targetDate.setDate(targetDate.getDate() + 1);
    } else if (dayName) {
      const dayMap = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
      const targetDay = dayMap[dayName];
      const currentDay = targetDate.getDay();
      if (modifier === "last") {
        let diff = currentDay - targetDay;
        if (diff <= 0) diff += 7;
        targetDate.setDate(targetDate.getDate() - diff);
      } else if (modifier === "next") {
        let diff = targetDay - currentDay;
        if (diff <= 0) diff += 7;
        targetDate.setDate(targetDate.getDate() + diff);
      } else {
        // "this Monday" — closest upcoming or today
        let diff = targetDay - currentDay;
        if (diff < 0) diff += 7;
        targetDate.setDate(targetDate.getDate() + diff);
      }
    }

    const pageTitle = deps.formatRoamDate(targetDate);
    deps.debugLog("[Chief flow] Deterministic route matched: relative_date_nav", pageTitle);
    const roamTools = deps.getRoamNativeTools() || [];
    const openTool = roamTools.find(t => t.name === "roam_open_page");
    if (openTool && typeof openTool.execute === "function") {
      try {
        await openTool.execute({ title: pageTitle });
        const label = keyword || `${modifier} ${dayName}`;
        return deps.publishAskResponse(prompt, `Opened **[[${pageTitle}]]** (${label}).`, assistantName, suppressToasts);
      } catch (e) {
        return deps.publishAskResponse(prompt, `Could not navigate: ${e?.message || "Unknown error"}`, assistantName, suppressToasts);
      }
    }
  }

  // ── Navigation — daily page, system pages, [[page]] ───────────────
  const navDailyMatch = prompt.match(/^(?:open|go\s+to|show|navigate\s+to|view)\s+(?:my\s+)?(?:today(?:'s)?|daily\s*(?:page|note)?|DNP)\s*[.!?]*\s*$/i);
  const navSystemMatch = prompt.match(/^(?:open|go\s+to|show|navigate\s+to|view)\s+(?:my\s+)?(?:the\s+)?(inbox|decisions|memory|lessons\s*learned|skills|roadmap|improvement\s*requests)\s*(?:page)?\s*[.!?]*\s*$/i);
  const navBracketMatch = prompt.match(/^(?:open|go\s+to|show|navigate\s+to|view)\s+\[\[([^\]]+)\]\]\s*[.!?]*\s*$/i);
  if (navDailyMatch || navSystemMatch || navBracketMatch) {
    const roamTools = deps.getRoamNativeTools() || [];
    const openTool = roamTools.find(t => t.name === "roam_open_page");
    if (openTool && typeof openTool.execute === "function") {
      let pageTitle;
      let label;
      if (navDailyMatch) {
        pageTitle = deps.formatRoamDate(new Date());
        label = "today's daily page";
        deps.debugLog("[Chief flow] Deterministic route matched: navigate_daily");
      } else if (navSystemMatch) {
        const systemName = navSystemMatch[1].toLowerCase().replace(/\s+/g, " ").trim();
        const systemPages = {
          "inbox": "Chief of Staff/Inbox",
          "decisions": "Chief of Staff/Decisions",
          "memory": "Chief of Staff/Memory",
          "lessons learned": "Chief of Staff/Lessons Learned",
          "skills": "Chief of Staff/Skills",
          "roadmap": "Chief of Staff/Roadmap",
          "improvement requests": "Chief of Staff/Improvement Requests"
        };
        pageTitle = systemPages[systemName];
        label = systemName;
        deps.debugLog("[Chief flow] Deterministic route matched: navigate_system", systemName);
      } else {
        pageTitle = navBracketMatch[1].trim();
        label = pageTitle;
        deps.debugLog("[Chief flow] Deterministic route matched: navigate_page", pageTitle);
      }
      if (pageTitle) {
        try {
          await openTool.execute({ title: pageTitle });
          return deps.publishAskResponse(prompt, `Opened **${label}**.`, assistantName, suppressToasts);
        } catch (e) {
          return deps.publishAskResponse(prompt, `Could not open page: ${e?.message || "Unknown error"}`, assistantName, suppressToasts);
        }
      }
    }
  }

  // "what github tools do I have?", "list zotero tools", "show my better tasks tools"
  // Category-specific listing checked BEFORE generic listing so "what workspaces tools" doesn't
  // get caught by the broader "what ... tools ... do you have" generic pattern.
  const toolListMatch = prompt.match(/\b(?:what|which|list|show)\b.*?\b([\w][\w.\s-]*?)\s+tools\b/i)
    || prompt.match(/\btools\s+(?:for|from|on|in)\s+([\w][\w.\s-]*)\b/i);
  if (toolListMatch) {
    const queryName = toolListMatch[1].toLowerCase().trim();
    // Skip generic qualifiers — these should fall through to the generic tool list below
    const isGenericQualifier = /^(all|your|my|available|the|every)$/.test(queryName);
    if (!isGenericQualifier) {

      // 1. Check Local MCP servers by server name
      const mcpTools = getLocalMcpTools();
      if (mcpTools.length > 0) {
        const serverTools = mcpTools.filter(t => {
          const sn = (t._serverName || "").toLowerCase();
          return sn === queryName || sn.includes(queryName);
        });
        if (serverTools.length > 0) {
          deps.debugLog("[Chief flow] Deterministic route matched: local_mcp_tool_list", queryName);
          const responseText = formatToolListByServer(serverTools);
          return deps.publishAskResponse(prompt, responseText, assistantName, suppressToasts);
        }
      }

      // 2. Check extension tools by extension name/key
      try {
        const registry = deps.getExtensionToolsRegistry();
        const extToolsConfig = deps.getExtToolsConfig();
        for (const [extKey, ext] of Object.entries(registry)) {
          if (!extToolsConfig[extKey]?.enabled) continue;
          if (!ext || !Array.isArray(ext.tools) || !ext.tools.length) continue;
          const label = String(ext.name || extKey || "").toLowerCase();
          const key = String(extKey).toLowerCase();
          if (label.includes(queryName) || key.includes(queryName) || queryName.includes(label) || queryName.includes(key)) {
            const validTools = ext.tools.filter(t => t?.name && typeof t.execute === "function");
            if (validTools.length > 0) {
              deps.debugLog("[Chief flow] Deterministic route matched: extension_tool_list", queryName);
              const extLabel = ext.name || extKey;
              const responseText = `**${extLabel}** (${validTools.length} tools):\n\n` +
                validTools.map(t => `- **${t.name}**: ${t.description || "No description"}`).join("\n");
              return deps.publishAskResponse(prompt, responseText, assistantName, suppressToasts);
            }
          }
        }
      } catch (e) { /* ignore */ }

      // 3. Check Roam native tools by prefix match (e.g. "roam tools")
      if (queryName === "roam" || queryName === "native" || queryName === "roam native") {
        const roamTools = deps.getRoamNativeTools() || [];
        if (roamTools.length > 0) {
          deps.debugLog("[Chief flow] Deterministic route matched: roam_native_tool_list");
          const filtered = roamTools.filter(t => t.name.startsWith("roam_"));
          const responseText = `**Roam native tools** (${filtered.length}):\n\n` +
            filtered.map(t => `- **${t.name}**: ${t.description || "No description"}`).join("\n");
          return deps.publishAskResponse(prompt, responseText, assistantName, suppressToasts);
        }
      }

      // 4. Check COS tools (e.g. "assistant tools", "cos tools", "memory tools")
      if (queryName === "cos" || queryName === "assistant" || queryName === "memory" || queryName === "cron") {
        const cosTools = [...deps.getCosIntegrationTools(), ...deps.getCronTools()];
        // Also include cos_ prefixed tools from roam-native-tools that are really COS tools
        const roamTools = deps.getRoamNativeTools() || [];
        const cosFromRoam = roamTools.filter(t => t.name.startsWith("cos_"));
        const allCos = [...cosTools, ...cosFromRoam.filter(t => !cosTools.some(c => c.name === t.name))];
        if (allCos.length > 0) {
          deps.debugLog("[Chief flow] Deterministic route matched: cos_tool_list");
          const responseText = `**Assistant tools** (${allCos.length}):\n\n` +
            allCos.map(t => `- **${t.name}**: ${t.description || "No description"}`).join("\n");
          return deps.publishAskResponse(prompt, responseText, assistantName, suppressToasts);
        }
      }
    }
    // If queryName was generic or no category matched, fall through to generic tool list
  }

  // Generic "what tools do you have?", "list all tools", "what can you do?", "show capabilities"
  const isGenericToolListQuery = /\b(?:what|which|list|show)\b.*?\b(?:tools|capabilities)\b.*?\b(?:do you have|available|are there|you have|can you)\b/i.test(prompt)
    || /\b(?:what|which|list|show)\b.*?\b(?:all|your|my)\s+tools\b/i.test(prompt)
    || /\b(?:what can you do|what are your capabilities|your capabilities)\b/i.test(prompt)
    || /^(?:tools|list tools|show tools|my tools)\s*[?!.]?\s*$/i.test(prompt);
  if (isGenericToolListQuery) {
    deps.debugLog("[Chief flow] Deterministic route matched: generic_tool_list");
    const sections = [];

    // Roam native tools (filter to roam_ prefix only for accurate count)
    const roamTools = deps.getRoamNativeTools() || [];
    const roamOnly = roamTools.filter(t => t.name.startsWith("roam_"));
    if (roamOnly.length > 0) {
      sections.push(`**Roam tools** (${roamOnly.length}): ${roamOnly.map(t => t.name).join(", ")}`);
    }

    // Extension tools
    try {
      const registry = deps.getExtensionToolsRegistry();
      const extToolsConfig = deps.getExtToolsConfig();
      for (const [extKey, ext] of Object.entries(registry)) {
        if (!extToolsConfig[extKey]?.enabled) continue;
        if (!ext || !Array.isArray(ext.tools) || !ext.tools.length) continue;
        const label = String(ext.name || extKey).trim();
        const validTools = ext.tools.filter(t => t?.name && typeof t.execute === "function");
        if (validTools.length) {
          sections.push(`**${label}** (${validTools.length}): ${validTools.map(t => t.name).join(", ")}`);
        }
      }
    } catch (e) { /* ignore */ }

    // COS tools (merge cos_ tools from roam-native-tools + dedicated COS tools)
    const cosToolsDedicated = [...deps.getCosIntegrationTools(), ...deps.getCronTools()];
    const cosFromRoamGeneric = roamTools.filter(t => t.name.startsWith("cos_"));
    const allCosGeneric = [...cosToolsDedicated, ...cosFromRoamGeneric.filter(t => !cosToolsDedicated.some(c => c.name === t.name))];
    if (allCosGeneric.length > 0) {
      sections.push(`**Assistant tools** (${allCosGeneric.length}): ${allCosGeneric.map(t => t.name).join(", ")}`);
    }

    // Local MCP servers
    const localMcpTools = getLocalMcpTools() || [];
    if (localMcpTools.length > 0) {
      const byServer = new Map();
      for (const t of localMcpTools) {
        const sn = t._serverName || "Unknown";
        if (!byServer.has(sn)) byServer.set(sn, []);
        byServer.get(sn).push(t);
      }
      for (const [serverName, serverTools] of byServer) {
        if (serverTools[0]?._isDirect) {
          sections.push(`**${serverName}** (${serverTools.length}): ${serverTools.map(t => t.name).join(", ")}`);
        } else {
          sections.push(`**${serverName}** (${serverTools.length} tools, via LOCAL_MCP_ROUTE)`);
        }
      }
    }

    // Remote MCP servers
    const remoteMcpTools = getRemoteMcpTools() || [];
    if (remoteMcpTools.length > 0) {
      const byServer = new Map();
      for (const t of remoteMcpTools) {
        const sn = t._serverName || "Unknown";
        if (!byServer.has(sn)) byServer.set(sn, []);
        byServer.get(sn).push(t);
      }
      for (const [serverName, serverTools] of byServer) {
        if (serverTools[0]?._isDirect) {
          sections.push(`**${serverName}** (${serverTools.length}): ${serverTools.map(t => t.name).join(", ")}`);
        } else {
          sections.push(`**${serverName}** (${serverTools.length} tools, via REMOTE_MCP_ROUTE)`);
        }
      }
    }

    // Composio services
    try {
      const state = extensionAPIRef ? getToolsConfigState(extensionAPIRef) : { installedTools: [] };
      const connected = state.installedTools.filter(t => t.installState === "installed");
      if (connected.length > 0) {
        sections.push(`**Composio services** (${connected.length}): ${connected.map(t => t.label || t.slug).join(", ")}`);
      }
    } catch (e) { /* ignore */ }

    const responseText = sections.length > 0
      ? `## Available tools\n\n${sections.join("\n\n")}\n\nAsk about a specific category for more detail, e.g. *"what roam tools do you have?"*`
      : "No tools are currently registered. Check that your API keys and connections are configured.";
    return deps.publishAskResponse(prompt, responseText, assistantName, suppressToasts);
  }

  // "run zotero_list_libraries", "call bt_list_workspaces", "execute roam_search"
  const directToolMatch = prompt.match(/\b(?:run|call|execute|use)\s+([\w]+)\b/i);
  if (directToolMatch) {
    const toolName = directToolMatch[1];
    const allTools = [
      ...deps.getRoamNativeTools(),
      ...deps.getExternalExtensionTools(),
      ...deps.getCosIntegrationTools(),
      ...deps.getCronTools(),
      ...getLocalMcpTools()
    ];
    const tool = allTools.find(t => t.name === toolName || t.name.toLowerCase() === toolName.toLowerCase());
    const requiredParams = tool?.input_schema?.required;
    const hasRequiredParams = Array.isArray(requiredParams) && requiredParams.length > 0;
    if (tool && typeof tool.execute === "function" && !hasRequiredParams && tool.isMutating === false) {
      deps.debugLog("[Chief flow] Deterministic route matched: direct_tool_execute", toolName);
      try {
        const result = await tool.execute({});
        const responseText = typeof result === "object"
          ? "```json\n" + JSON.stringify(result, null, 2) + "\n```"
          : String(result);
        return deps.publishAskResponse(prompt, responseText, assistantName, suppressToasts);
      } catch (e) {
        const responseText = `Tool ${toolName} failed: ${e?.message || "Unknown error"}`;
        return deps.publishAskResponse(prompt, responseText, assistantName, suppressToasts);
      }
    }
  }

  const deregisterIntent = parseComposioDeregisterIntent(prompt, {
    installedSlugs: installedToolSlugsForIntents
  });
  if (extensionAPIRef && deregisterIntent?.toolSlug) {
    deps.debugLog("[Chief flow] Deterministic route matched: composio_deregister", {
      toolSlug: deregisterIntent.toolSlug
    });
    const targetSlug = String(deregisterIntent.toolSlug || "").trim().toUpperCase();
    await deregisterComposioTool(extensionAPIRef, targetSlug);
    const stateAfter = getToolsConfigState(extensionAPIRef);
    const stillTracked = stateAfter.installedTools.some(
      (tool) => normaliseToolSlugToken(tool?.slug) === normaliseToolSlugToken(targetSlug)
    );
    const responseText = stillTracked
      ? `I attempted to deregister ${targetSlug}, but it still appears in local tool state. Check the latest toast for details.`
      : `${targetSlug} has been deregistered (or was already removed).`;
    return deps.publishAskResponse(prompt, responseText, assistantName, suppressToasts);
  }

  const installIntent = parseComposioInstallIntent(prompt);
  if (extensionAPIRef && installIntent?.toolSlug) {
    deps.debugLog("[Chief flow] Deterministic route matched: composio_install", {
      toolSlug: installIntent.toolSlug
    });
    const targetSlug = String(installIntent.toolSlug || "").trim().toUpperCase();
    try {
      await installComposioTool(extensionAPIRef, targetSlug);
      const stateAfter = getToolsConfigState(extensionAPIRef);
      const installed = stateAfter.installedTools.find(
        (tool) => normaliseToolSlugToken(tool?.slug) === normaliseToolSlugToken(targetSlug)
      );
      const state = installed?.installState || "";
      const responseText = state === "pending_auth"
        ? `${targetSlug} requires authentication. A browser tab should have opened — complete the setup there, then try using the tool.`
        : state === "failed"
          ? `${targetSlug} installation failed. Check the toasts for details.`
          : `${targetSlug} has been installed and is now available.`;
      return deps.publishAskResponse(prompt, responseText, assistantName, suppressToasts);
    } catch (error) {
      const responseText = `Failed to install ${targetSlug}: ${error?.message || "Unknown error"}. Check the Composio connection and try again.`;
      return deps.publishAskResponse(prompt, responseText, assistantName, suppressToasts);
    }
  }

  const memorySaveIntent = parseMemorySaveIntent(prompt);
  if (memorySaveIntent) {
    deps.debugLog("[Chief flow] Deterministic route matched: memory_save");
    const responseText = await runDeterministicMemorySave(memorySaveIntent);
    return deps.publishAskResponse(prompt, responseText, assistantName, suppressToasts);
  }

  // ── Skill optimization intent (must be checked BEFORE skill invocation) ──
  if (typeof deps.parseSkillOptimizeIntent === "function") {
    const optimizeIntent = deps.parseSkillOptimizeIntent(prompt);
    if (optimizeIntent) {
      const enabled = extensionAPIRef?.settings?.get?.(deps.SETTINGS_KEYS?.skillAutoresearchEnabled);
      if (!enabled) {
        return deps.publishAskResponse(prompt,
          "Skill auto-optimisation is not enabled. Enable it in Settings \u2192 Automatic Actions.",
          assistantName, suppressToasts);
      }
      deps.debugLog("[Chief flow] Deterministic route matched: skill_optimize", optimizeIntent.skillName);
      const entry = await deps.findSkillEntryByName(optimizeIntent.skillName, { force: true });
      if (!entry) {
        const entries = await deps.getSkillEntries({ force: false });
        const available = entries.map(e => e.title).slice(0, 12).join(", ");
        return deps.publishAskResponse(prompt,
          `Skill "${optimizeIntent.skillName}" not found. Available: ${available}`,
          assistantName, suppressToasts);
      }
      if (deps.isOptimizationRunning?.()) {
        return deps.publishAskResponse(prompt,
          "An optimization is already running. Wait for it to complete.",
          assistantName, suppressToasts);
      }
      const budgetStr = deps.getSettingString(extensionAPIRef, deps.SETTINGS_KEYS?.skillAutoresearchBudget, "2.00");
      const budget = parseFloat(budgetStr) || 2.0;
      // Fire-and-forget — do NOT await
      deps.runSkillOptimization(entry.title, {
        budgetUsd: budget,
        withTools: !!optimizeIntent.withTools,
        powerMutations: !!optimizeIntent.powerMutations,
      }).catch(err => {
        deps.debugLog("[Autoresearch] Background optimization failed:", err?.message);
        appendChatPanelMessage("assistant",
          `Optimisation of "${entry.title}" failed: ${err?.message || "Unknown error"}`);
      });
      // Check both the flag and the settings toggle to determine the actual mode
      const toolCallingSetting = extensionAPIRef?.settings?.get?.(deps.SETTINGS_KEYS?.skillAutoresearchToolCalling);
      const willUseTools = optimizeIntent.withTools || toolCallingSetting;
      const powerMutationSetting = extensionAPIRef?.settings?.get?.(deps.SETTINGS_KEYS?.skillAutoresearchPowerMutations);
      const willUsePower = optimizeIntent.powerMutations || powerMutationSetting;
      const modeLabel = (willUseTools ? "tool-calling" : "LLM-only")
        + (willUsePower ? ", power mutations" : "");
      return deps.publishAskResponse(prompt,
        `Starting optimisation of "${entry.title}" (${modeLabel}, budget: $${budget.toFixed(2)}). `
        + `This runs in the background \u2014 I'll show a toast when it's done with results to accept or revert.`,
        assistantName, suppressToasts);
    }
  }

  const skillIntent = parseSkillInvocationIntent(prompt);
  // Also detect natural-language briefing requests and route to the Daily Briefing skill
  // Skip this shortcut if the prompt is clearly about scheduling/cron (let agent loop handle it)
  const isCronIntent = /\b(cron|schedule[ds]?|recurring|every\s+\d+\s+(min|hour)|set up a?\s*(job|timer|remind))\b/i.test(prompt);
  const briefingIntent = !skillIntent && !isCronIntent && /\b(daily\s*)?briefing\b/i.test(prompt)
    ? { skillName: "Daily Briefing", targetText: "", originalPrompt: prompt }
    : null;
  const workflowSuggestIntent = !skillIntent && !isCronIntent &&
    /\b(suggest\s*(?:some\s*)?workflows?|what\s+(?:automations?|workflows?)\s+(?:could|can|should)|skills?\s+(?:am\s+i|i'?m)\s+missing|recommend\s*(?:some\s*)?workflows?)\b/i.test(prompt)
    ? { skillName: "Suggest Workflows", targetText: "", originalPrompt: prompt }
    : null;
  // Detect "draft workflow #2" / "create skill for X" follow-ups after a Suggest Workflows turn.
  // Re-route through the skill so the LLM has drafting instructions in its system prompt.
  const recentWorkflowSuggestions = (!skillIntent && !isCronIntent && !workflowSuggestIntent)
    ? getLatestWorkflowSuggestionsFromConversation()
    : [];
  const hasRecentSuggestions = recentWorkflowSuggestions.length > 0;
  const workflowDraftIntent = hasRecentSuggestions &&
    promptLooksLikeWorkflowDraftFollowUp(prompt, recentWorkflowSuggestions)
    ? { skillName: "Suggest Workflows", targetText: prompt, originalPrompt: prompt }
    : null;
  const resolvedSkillIntent = skillIntent || briefingIntent || workflowSuggestIntent || workflowDraftIntent;
  if (resolvedSkillIntent) {
    deps.debugLog("[Chief flow] Deterministic route matched: skill_invoke", {
      skillName: resolvedSkillIntent?.skillName || "",
      viaBriefingShortcut: Boolean(briefingIntent)
    });
    const responseText = await runDeterministicSkillInvocation(resolvedSkillIntent, { suppressToasts, onToolCall, onTextChunk });
    // Extract compact suggestion index so it survives context truncation for follow-up drafting
    const suggestionIdx = extractWorkflowSuggestionIndex(responseText);
    const contextText = suggestionIdx ? `${suggestionIdx}\n\n${responseText}` : undefined;
    const result = deps.publishAskResponse(prompt, responseText, assistantName, suppressToasts, contextText);

    if (offerWriteToDailyPage) {
      const shouldWrite = await promptWriteToDailyPage();
      if (shouldWrite) {
        try {
          const writeResult = await deps.writeResponseToTodayDailyPage(prompt, responseText);
          deps.showInfoToast("Saved to Roam", `Added under ${writeResult.pageTitle}.`);
        } catch (error) {
          deps.showErrorToast("Write failed", error?.message || "Could not write to daily page.");
        }
      }
    }

    return result;
  }

  deps.debugLog("[Chief flow] Deterministic router: no match.");
  return null;
}
