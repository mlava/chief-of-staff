// =============================================================================
// composio-mcp.js — Composio MCP Integration Module
// =============================================================================
// Extracted from index.js following the DI pattern from roam-native-tools.js
// Handles toolkit discovery, schema caching, tool resolution, and configuration.
// =============================================================================

let deps = {};

export function initComposioMcp(injected) {
  deps = injected;
}

// ═══════════════════════════════════════════════════════════════════════
// Module-scoped constants (only used within this module)
// ═══════════════════════════════════════════════════════════════════════

const COMPOSIO_TOOLKIT_CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const COMPOSIO_TOOLKIT_CATALOG_MAX_SLUGS = 1000;
const COMPOSIO_TOOLKIT_SEARCH_BFS_MAX_NODES = 300;
const TOOLKIT_SCHEMA_REGISTRY_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const TOOLKIT_SCHEMA_MAX_TOOLKITS = 30;
const TOOLKIT_SCHEMA_MAX_PROMPT_CHARS = 8000;

// ═══════════════════════════════════════════════════════════════════════
// Pure helper functions (no deps)
// ═══════════════════════════════════════════════════════════════════════

export function normaliseToolkitSlug(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function normaliseInstalledToolRecord(input) {
  const slug = typeof input?.slug === "string" ? input.slug.trim() : "";
  if (!slug) return null;
  return {
    slug,
    label: typeof input?.label === "string" && input.label.trim() ? input.label.trim() : slug,
    enabled: input?.enabled !== false,
    installState: typeof input?.installState === "string" ? input.installState : "installed",
    lastError: typeof input?.lastError === "string" ? input.lastError : "",
    connectionId: typeof input?.connectionId === "string" ? input.connectionId : "",
    updatedAt: Number.isFinite(input?.updatedAt) ? input.updatedAt : Date.now()
  };
}

export function normaliseToolSlugToken(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

// ═══════════════════════════════════════════════════════════════════════
// Toolkit Catalog Cache
// ═══════════════════════════════════════════════════════════════════════

function normaliseComposioToolkitCatalogCache(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const fetchedAt = Number.isFinite(source?.fetchedAt) ? source.fetchedAt : 0;
  const seen = new Set();
  const slugs = Array.isArray(source?.slugs)
    ? source.slugs
      .map((value) => normaliseToolkitSlug(value))
      .filter((value) => {
        if (!value || seen.has(value)) return false;
        seen.add(value);
        return true;
      })
      .slice(0, COMPOSIO_TOOLKIT_CATALOG_MAX_SLUGS)
    : [];
  return { fetchedAt, slugs };
}

export function getComposioToolkitCatalogCache(extensionAPI = deps.getExtensionAPIRef()) {
  const raw = extensionAPI?.settings?.get?.(deps.SETTINGS_KEYS.composioToolkitCatalogCache);
  return normaliseComposioToolkitCatalogCache(raw);
}

function saveComposioToolkitCatalogCache(extensionAPI = deps.getExtensionAPIRef(), cache = {}) {
  if (!extensionAPI?.settings?.set) return;
  const normalised = normaliseComposioToolkitCatalogCache(cache);
  extensionAPI.settings.set(deps.SETTINGS_KEYS.composioToolkitCatalogCache, normalised);
}

export function mergeComposioToolkitCatalogSlugs(extensionAPI = deps.getExtensionAPIRef(), slugs = [], options = {}) {
  if (!extensionAPI?.settings?.set) return getComposioToolkitCatalogCache(extensionAPI);
  const { touchFetchedAt = false } = options;
  const current = getComposioToolkitCatalogCache(extensionAPI);
  const incoming = Array.isArray(slugs) ? slugs : [];
  const seen = new Set();
  const merged = [...incoming, ...current.slugs]
    .map((value) => normaliseToolkitSlug(value))
    .filter((value) => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    })
    .slice(0, COMPOSIO_TOOLKIT_CATALOG_MAX_SLUGS);
  const next = {
    fetchedAt: touchFetchedAt ? Date.now() : current.fetchedAt,
    slugs: merged
  };
  saveComposioToolkitCatalogCache(extensionAPI, next);
  return next;
}

// ═══════════════════════════════════════════════════════════════════════
// Toolkit Schema Registry
// ═══════════════════════════════════════════════════════════════════════

export function getToolkitSchemaRegistry(extensionAPI = deps.getExtensionAPIRef()) {
  if (deps.getToolkitSchemaRegistryCache()) return deps.getToolkitSchemaRegistryCache();
  const raw = extensionAPI?.settings?.get?.(deps.SETTINGS_KEYS.toolkitSchemaRegistry);
  const registry = raw && typeof raw === "object" && raw.toolkits ? raw : { toolkits: {} };
  deps.setToolkitSchemaRegistryCache(registry);
  return registry;
}

function saveToolkitSchemaRegistry(extensionAPI = deps.getExtensionAPIRef(), registry = null) {
  const reg = registry || deps.getToolkitSchemaRegistryCache() || { toolkits: {} };
  const entries = Object.entries(reg.toolkits || {});
  if (entries.length > TOOLKIT_SCHEMA_MAX_TOOLKITS) {
    entries.sort((a, b) => (b[1].discoveredAt || 0) - (a[1].discoveredAt || 0));
    reg.toolkits = Object.fromEntries(entries.slice(0, TOOLKIT_SCHEMA_MAX_TOOLKITS));
  }
  deps.setToolkitSchemaRegistryCache(reg);
  extensionAPI?.settings?.set?.(deps.SETTINGS_KEYS.toolkitSchemaRegistry, reg);
}

export function getToolkitEntry(toolkitName) {
  const registry = getToolkitSchemaRegistry();
  const key = String(toolkitName || "").toUpperCase();
  return registry.toolkits?.[key] || null;
}

export function getToolSchema(toolSlug) {
  const slug = String(toolSlug || "").toUpperCase();
  const registry = getToolkitSchemaRegistry();
  for (const tk of Object.values(registry.toolkits || {})) {
    if (tk.tools?.[slug]) return tk.tools[slug];
  }
  return null;
}

export function inferToolkitFromSlug(toolSlug) {
  const slug = String(toolSlug || "").toUpperCase();
  const match = slug.match(/^(GOOGLE[A-Z]*|[A-Z]+?)_/);
  return match ? match[1] : slug;
}

// ═══════════════════════════════════════════════════════════════════════
// Toolkit Discovery
// ═══════════════════════════════════════════════════════════════════════

function populateSlugAllowlist(entry) {
  if (!entry?.tools) return;
  const allowlist = deps.getComposioSafeMultiExecuteSlugAllowlist();
  const mutatingTokens = new Set(["DELETE", "REMOVE", "SEND", "CREATE", "UPDATE", "MODIFY", "WRITE", "POST", "TRASH", "MOVE", "EXECUTE"]);
  for (const slug of Object.keys(entry.tools)) {
    const upperSlug = slug.toUpperCase();
    const tokens = upperSlug.split("_");
    const hasMutating = tokens.some(t => mutatingTokens.has(t));
    const hasReadOnly = tokens.some(t =>
      ["GET", "LIST", "FETCH", "SEARCH", "FIND", "READ", "QUERY", "DETAILS", "ABOUT", "SUGGEST"].includes(t)
    );
    if (hasReadOnly && !hasMutating && allowlist.size < 200) {
      allowlist.add(upperSlug);
    }
  }
}

export async function discoverToolkitSchema(toolkitName, options = {}) {
  const { force = false } = options;
  const key = String(toolkitName || "").toUpperCase();
  if (!key) return null;

  // Check cache freshness
  if (!force) {
    const existing = getToolkitEntry(key);
    if (existing && (Date.now() - (existing.discoveredAt || 0)) < TOOLKIT_SCHEMA_REGISTRY_TTL_MS) {
      deps.debugLog("[Chief flow] Schema registry: cache hit for", key);
      populateSlugAllowlist(existing);
      return existing;
    }
  }

  if (!deps.getMcpClient()?.callTool) {
    deps.debugLog("[Chief flow] Schema registry: no MCP client, skipping discovery for", key);
    return getToolkitEntry(key); // return stale if available
  }

  deps.debugLog("[Chief flow] Schema registry: discovering", key);
  try {
    const TOOLKIT_QUERY_HINTS = {
      GMAIL: ["gmail", "gmail list read fetch send create"],
      GOOGLECALENDAR: ["google calendar list events", "google calendar create update delete events"],
      SLACK: ["slack send message", "slack list channels messages"],
      TODOIST: ["todoist tasks projects", "todoist create complete tasks"],
      GITHUB: ["github repos issues pull requests", "github create issue PR"],
      NOTION: ["notion pages databases", "notion create update pages"],
      GOOGLEDRIVE: ["google drive files folders", "google drive upload share"],
      GOOGLESHEETS: ["google sheets read write", "google sheets create update"],
      ASANA: ["asana tasks projects", "asana create update tasks"],
      TRELLO: ["trello boards cards lists", "trello create move cards"],
      LINEAR: ["linear issues projects", "linear create update issues"],
      JIRA: ["jira issues projects", "jira create update issues"],
      SEMANTICSCHOLAR: ["semantic scholar search papers authors", "semantic scholar paper details references citations"],
      OPENWEATHER: ["openweather current weather forecast", "openweather air quality UV index"]
    };

    const queries = TOOLKIT_QUERY_HINTS[key]
      || [key.toLowerCase(), `${key.toLowerCase()} list read fetch send create`];

    const tools = {};
    let bestPlan = { recommended_plan_steps: [], known_pitfalls: [], execution_guidance: "" };
    const allPrimarySlugs = new Set();
    const allRelatedSlugs = new Set();

    for (const queryText of queries) {
      try {
        const searchResult = await deps.getMcpClient().callTool({
          name: "COMPOSIO_SEARCH_TOOLS",
          arguments: { queries: [{ use_case: queryText }] }
        });
        const text = searchResult?.content?.[0]?.text;
        const qParsed = typeof text === "string" ? deps.safeJsonParse(text) : text;
        if (!qParsed?.successful) continue;

        const r = qParsed.data?.results?.[0] || {};
        const inlineSchemas = r.tool_schemas || {};
        const qPrimary = Array.isArray(r.primary_tool_slugs) ? r.primary_tool_slugs : [];
        const qRelated = Array.isArray(r.related_tool_slugs) ? r.related_tool_slugs : [];

        qPrimary.forEach(s => allPrimarySlugs.add(s));
        qRelated.forEach(s => allRelatedSlugs.add(s));

        const planSteps = Array.isArray(r.recommended_plan_steps) ? r.recommended_plan_steps : [];
        const pitfalls = Array.isArray(r.known_pitfalls) ? r.known_pitfalls : [];
        if (planSteps.length + pitfalls.length > bestPlan.recommended_plan_steps.length + bestPlan.known_pitfalls.length) {
          bestPlan = {
            recommended_plan_steps: planSteps,
            known_pitfalls: pitfalls,
            execution_guidance: r.execution_guidance || bestPlan.execution_guidance
          };
        }

        for (const [slug, schema] of Object.entries(inlineSchemas)) {
          const slugToolkit = inferToolkitFromSlug(slug);
          if (slugToolkit !== key && !qPrimary.includes(slug)) continue;
          if (tools[slug]?.input_schema && !schema?.input_schema) continue;
          if (schema?.input_schema && (schema.hasFullSchema !== false)) {
            tools[slug] = {
              slug,
              toolkit: schema.toolkit || key,
              description: schema.description || "",
              input_schema: schema.input_schema,
              fetchedAt: Date.now()
            };
          } else if (!tools[slug]) {
            tools[slug] = {
              slug,
              toolkit: schema?.toolkit || key,
              description: schema?.description || "",
              input_schema: null,
              fetchedAt: 0
            };
          }
        }

        deps.debugLog("[Chief flow] Schema registry: query", queryText, "→",
          Object.keys(inlineSchemas).length, "tools,",
          planSteps.length, "steps,",
          pitfalls.length, "pitfalls");
      } catch (e) {
        deps.debugLog("[Chief flow] Schema registry: query failed:", queryText, String(e?.message || e));
      }
    }

    for (const slug of [...allPrimarySlugs, ...allRelatedSlugs]) {
      const slugToolkit = inferToolkitFromSlug(slug);
      if (slugToolkit !== key && !allPrimarySlugs.has(slug)) continue;
      if (!tools[slug]) {
        tools[slug] = { slug, toolkit: key, description: "", input_schema: null, fetchedAt: 0 };
      }
    }

    const plan = bestPlan;
    const primarySlugs = [...allPrimarySlugs];
    const relatedSlugs = [...allRelatedSlugs];

    if (!Object.keys(tools).length) {
      deps.debugLog("[Chief flow] Schema registry: no tools found for", key);
      return getToolkitEntry(key);
    }

    const needsFetch = Object.values(tools).filter(t => !t.input_schema).map(t => t.slug);
    if (needsFetch.length > 0) {
      for (let i = 0; i < needsFetch.length && i < 20; i += 10) {
        const batch = needsFetch.slice(i, i + 10);
        try {
          const schemaResult = await deps.getMcpClient().callTool({
            name: "COMPOSIO_GET_TOOL_SCHEMAS",
            arguments: { tool_slugs: batch }
          });
          const schemaText = schemaResult?.content?.[0]?.text;
          const schemaParsed = typeof schemaText === "string" ? deps.safeJsonParse(schemaText) : schemaText;
          const fetchedSchemas = schemaParsed?.data?.tool_schemas || {};
          for (const [slug, schema] of Object.entries(fetchedSchemas)) {
            if (tools[slug] && schema?.input_schema) {
              tools[slug].input_schema = schema.input_schema;
              tools[slug].description = schema.description || tools[slug].description;
              tools[slug].fetchedAt = Date.now();
            }
          }
        } catch (e) {
          deps.debugLog("[Chief flow] Schema registry: GET_TOOL_SCHEMAS batch failed:", String(e?.message || e));
        }
      }
    }

    const entry = {
      toolkit: key,
      discoveredAt: Date.now(),
      plan,
      primarySlugs,
      relatedSlugs,
      tools
    };

    const registry = getToolkitSchemaRegistry();
    registry.toolkits[key] = entry;
    saveToolkitSchemaRegistry(deps.getExtensionAPIRef(), registry);

    deps.debugLog("[Chief flow] Schema registry: discovered", key, {
      toolCount: Object.keys(tools).length,
      withSchema: Object.values(tools).filter(t => t.input_schema).length,
      pitfalls: plan.known_pitfalls.length
    });

    populateSlugAllowlist(entry);

    return entry;
  } catch (e) {
    deps.debugLog("[Chief flow] Schema registry: discovery failed for", key, String(e?.message || e));
    return getToolkitEntry(key);
  }
}

export async function discoverAllConnectedToolkitSchemas(extensionAPI = deps.getExtensionAPIRef(), options = {}) {
  const { force = false } = options;
  if (!extensionAPI) return;
  const allowlist = deps.getComposioSafeMultiExecuteSlugAllowlist();
  allowlist.clear();
  deps.COMPOSIO_SAFE_SLUG_SEED.forEach(s => allowlist.add(s));
  const { installedTools } = getToolsConfigState(extensionAPI);
  const connected = installedTools
    .filter(t => t.enabled && t.installState === "installed")
    .map(t => inferToolkitFromSlug(t.slug));
  const unique = [...new Set(connected)];
  deps.debugLog("[Chief flow] Schema registry: discovering connected toolkits:", unique, force ? "(forced)" : "");

  const batchSize = 5;
  for (let i = 0; i < unique.length; i += batchSize) {
    const batch = unique.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map(tk => discoverToolkitSchema(tk, { force })));
    results.forEach((r, idx) => {
      if (r.status === "rejected") deps.debugLog("[Chief flow] Toolkit schema discovery failed:", batch[idx], r.reason?.message);
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════
// System Prompt Section Builder
// ═══════════════════════════════════════════════════════════════════════

export function buildToolkitSchemaPromptSection(activeSections) {
  const registry = getToolkitSchemaRegistry();
  const toolkits = Object.values(registry.toolkits || {});
  if (!toolkits.length) return "";

  const installedToolkits = new Set();
  if (deps.getExtensionAPIRef()) {
    const { installedTools } = getToolsConfigState(deps.getExtensionAPIRef());
    for (const tool of installedTools) {
      if (tool.enabled && tool.installState === "installed") {
        installedToolkits.add(inferToolkitFromSlug(tool.slug));
      }
    }
  }

  const sections = [];
  let totalChars = 0;

  for (const tk of toolkits) {
    if (totalChars >= TOOLKIT_SCHEMA_MAX_PROMPT_CHARS) break;

    if (installedToolkits.size > 0 && !installedToolkits.has(tk.toolkit)) continue;

    if (activeSections) {
      const tkKey = `toolkit_${tk.toolkit}`;
      if (!activeSections.has(tkKey)) continue;
    }

    const toolEntries = Object.values(tk.tools || {}).filter(t => t.input_schema);
    if (!toolEntries.length) continue;

    const lines = [`### ${tk.toolkit}`];

    const slugList = toolEntries.map(t => {
      const desc = (t.description || "").split(/[.\n]/)[0].slice(0, 50).trim();
      return desc ? `${t.slug} (${desc})` : t.slug;
    }).join(", ");
    lines.push(`Available: ${slugList}`);

    if (tk.plan?.known_pitfalls?.length) {
      tk.plan.known_pitfalls.slice(0, 2).forEach(p => {
        const cleaned = p.replace(/^\[[^\]]*\]\s*/, "").slice(0, 100);
        lines.push(`⚠ ${cleaned}`);
      });
    }

    const primarySlugs = new Set(Array.isArray(tk.primarySlugs) ? tk.primarySlugs : []);
    const keyTools = toolEntries.filter(t => primarySlugs.has(t.slug)).slice(0, 5);
    if (!keyTools.length) keyTools.push(...toolEntries.slice(0, 3));

    for (const tool of keyTools) {
      const params = tool.input_schema?.properties || {};
      const paramEntries = Object.entries(params)
        .filter(([_, v]) => !v.description?.includes("Deprecated"))
        .slice(0, 8);
      lines.push(`- \`${tool.slug}\``);
      for (const [name, v] of paramEntries) {
        const type = v.type || "any";
        const def = v.default !== undefined ? `, default=${JSON.stringify(v.default)}` : "";
        const desc = (v.description || "").split(/[.\n]/)[0].slice(0, 60);
        lines.push(`    ${name}: ${type}${def}${desc ? ` — ${desc}` : ""}`);
      }
    }

    const section = lines.join("\n");
    if (totalChars + section.length > TOOLKIT_SCHEMA_MAX_PROMPT_CHARS) break;
    sections.push(section);
    totalChars += section.length;
  }

  if (!sections.length) return "";

  const firstTk = toolkits.find(tk => installedToolkits.has(tk.toolkit));
  const firstTool = firstTk ? Object.values(firstTk.tools || {}).find(t => t.input_schema) : null;
  const exampleLine = firstTool
    ? `Example: call COMPOSIO_MULTI_EXECUTE_TOOL with:
  {"tools": [{"tool_slug": "${firstTool.slug}", "arguments": {}}]}`
    : `Example: {"tools": [{"tool_slug": "TOOL_SLUG", "arguments": {}}]}`;

  return `## Connected Toolkit Schemas

IMPORTANT: Call these tools directly via COMPOSIO_MULTI_EXECUTE_TOOL. Do NOT call COMPOSIO_SEARCH_TOOLS first — the schemas below are already cached and ready.

${exampleLine}

Use the EXACT tool slugs listed below. Do not shorten or modify them.

${deps.wrapUntrustedWithInjectionScan("composio_schemas", sections.join("\n\n"))}`;
}

// ═══════════════════════════════════════════════════════════════════════
// Response Shape Recording
// ═══════════════════════════════════════════════════════════════════════

export function recordToolResponseShape(toolSlug, result) {
  try {
    const slug = String(toolSlug || "").toUpperCase();
    const schema = getToolSchema(slug);
    if (!schema || schema._responseShape) return;

    const parsed = typeof result === "string" ? deps.safeJsonParse(result) : result;
    if (!parsed) return;

    const paths = [
      { path: "data.results[0].response.data", value: parsed?.data?.results?.[0]?.response?.data },
      { path: "data.results[0].response.data_preview", value: parsed?.data?.results?.[0]?.response?.data_preview },
      { path: "data.results[0].response", value: parsed?.data?.results?.[0]?.response },
      { path: "data", value: parsed?.data }
    ];

    for (const { path, value } of paths) {
      if (value && typeof value === "object" && Object.keys(value).length > 0) {
        const topKeys = Object.keys(value).slice(0, 15);
        const arrayKeys = topKeys.filter(k => Array.isArray(value[k]));
        const hasPagination = topKeys.includes("nextPageToken") || topKeys.includes("pageToken");
        schema._responseShape = {
          dataPath: path,
          topKeys,
          arrayKeys,
          hasPagination,
          recordedAt: Date.now()
        };
        deps.debugLog("[Chief flow] Schema registry: recorded response shape for", slug, schema._responseShape);
        return;
      }
    }
  } catch { /* non-critical */ }
}

// ═══════════════════════════════════════════════════════════════════════
// Slug Resolution
// ═══════════════════════════════════════════════════════════════════════

export function resolveToolkitSlugFromSuggestions(requestedSlug, suggestions = []) {
  const requested = normaliseToolkitSlug(requestedSlug);
  const list = Array.isArray(suggestions) ? suggestions.map((value) => normaliseToolkitSlug(value)).filter(Boolean) : [];
  if (!requested || !list.length) {
    return {
      requestedSlug: requested,
      resolvedSlug: requested,
      suggestions: list
    };
  }

  const requestedToken = normaliseToolSlugToken(requested);
  const exact = list.find((slug) => normaliseToolSlugToken(slug) === requestedToken);
  if (exact) {
    return {
      requestedSlug: requested,
      resolvedSlug: exact,
      suggestions: list
    };
  }

  const rootToken = normaliseToolSlugToken(requested.split("_")[0] || requested);
  const rootMatch = list.find((slug) => normaliseToolSlugToken(slug) === rootToken);
  if (rootMatch) {
    return {
      requestedSlug: requested,
      resolvedSlug: rootMatch,
      suggestions: list
    };
  }

  return {
    requestedSlug: requested,
    resolvedSlug: requested,
    suggestions: list
  };
}

export function canonicaliseComposioToolSlug(slug) {
  const raw = String(slug || "").trim().toUpperCase();
  if (!raw) return "";
  const alias = deps.getComposioMultiExecuteSlugAliasByToken()[normaliseToolSlugToken(raw)];
  if (alias) return alias;

  const registry = getToolkitSchemaRegistry();
  const allToolkits = Object.values(registry.toolkits || {});
  for (const tk of allToolkits) {
    if (tk.tools?.[raw]) return raw;
  }

  const toolkit = inferToolkitFromSlug(raw);
  const tkEntry = registry.toolkits?.[toolkit];
  if (tkEntry?.tools) {
    const candidates = Object.keys(tkEntry.tools);
    const contained = candidates.find(c => c.includes(raw) || raw.includes(c));
    if (contained) {
      deps.debugLog("[Chief flow] Slug fuzzy-corrected:", raw, "→", contained);
      return contained;
    }
    const rawSuffix = raw.replace(toolkit + "_", "");
    const rawParts = rawSuffix.split("_").filter(Boolean);
    const rawVerb = rawParts[0] || "";
    const rawWords = new Set(rawParts);
    const ACTION_VERBS = new Set(["GET", "LIST", "FETCH", "SEARCH", "CREATE", "ADD", "DELETE", "REMOVE", "TRASH", "UPDATE", "PATCH", "SEND", "MOVE", "COPY", "STAR", "UNSTAR", "MARK", "ARCHIVE"]);
    for (const candidate of candidates) {
      const candSuffix = candidate.replace(toolkit + "_", "");
      const candParts = candSuffix.split("_").filter(Boolean);
      const candVerb = candParts[0] || "";
      if (ACTION_VERBS.has(rawVerb) && ACTION_VERBS.has(candVerb) && rawVerb !== candVerb) continue;
      const candWords = new Set(candParts);
      const overlap = [...rawWords].filter(w => candWords.has(w)).length;
      if (overlap >= 2 && overlap >= rawWords.size * 0.6) {
        deps.debugLog("[Chief flow] Slug fuzzy-corrected:", raw, "→", candidate);
        return candidate;
      }
    }
  }

  return raw;
}

// ═══════════════════════════════════════════════════════════════════════
// Multi-Execute Argument Normalization
// ═══════════════════════════════════════════════════════════════════════

export function normaliseComposioMultiExecuteArgs(args) {
  const base = args && typeof args === "object" ? { ...args } : {};
  const tools = Array.isArray(base.tools) ? base.tools : [];
  if (!tools.length) return base;
  base.tools = tools.map((tool) => {
    if (!tool || typeof tool !== "object") return tool;
    const nextSlug = canonicaliseComposioToolSlug(tool.tool_slug);

    const explicitArgs = tool.arguments && typeof tool.arguments === "object" ? tool.arguments : {};
    const altArgs = tool.parameters && typeof tool.parameters === "object" ? tool.parameters
      : tool.params && typeof tool.params === "object" ? tool.params
        : {};

    const META_KEYS = new Set(["tool_slug", "arguments", "parameters", "params", "toolkit"]);
    const SCHEMA_SHAPE_KEYS = new Set(["type", "description", "examples", "items", "properties", "required", "default", "enum"]);
    const looseArgs = {};
    for (const [k, v] of Object.entries(tool)) {
      if (META_KEYS.has(k)) continue;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const vKeys = Object.keys(v);
        const isSchemaObj = vKeys.length > 0 && vKeys.every(vk => SCHEMA_SHAPE_KEYS.has(vk));
        if (isSchemaObj) continue;
      }
      looseArgs[k] = v;
    }

    const mergedArgs = { ...looseArgs, ...altArgs, ...explicitArgs };

    const RESULTS_FLOOR = 10;
    const RESULTS_FLOOR_KEYS = ["max_results", "maxResults", "limit", "page_size", "pageSize"];
    for (const key of RESULTS_FLOOR_KEYS) {
      if (key in mergedArgs) {
        const val = Number(mergedArgs[key]);
        if (Number.isFinite(val) && val < RESULTS_FLOOR) {
          deps.debugLog(`[Chief flow] MULTI_EXECUTE: raising ${key} from ${val} to ${RESULTS_FLOOR}`);
          mergedArgs[key] = RESULTS_FLOOR;
        }
        break;
      }
    }

    return {
      tool_slug: nextSlug || tool.tool_slug,
      arguments: Object.keys(mergedArgs).length ? mergedArgs : {}
    };
  });
  return base;
}

// ═══════════════════════════════════════════════════════════════════════
// Status and Auth Helpers
// ═══════════════════════════════════════════════════════════════════════

export function mapComposioStatusToInstallState(statusValue) {
  const status = String(statusValue || "").toLowerCase();
  if (!status) return "installed";
  if (["active", "connected", "completed", "complete", "success", "succeeded", "ready"].includes(status)) {
    return "installed";
  }
  if (["initiated", "pending", "pending_completion", "in_progress", "authorizing", "awaiting_auth"].includes(status)) {
    return "pending_auth";
  }
  if (["failed", "error", "cancelled", "canceled", "disconnected"].includes(status)) {
    return "failed";
  }
  return "installed";
}

export function extractAuthRedirectUrls(response) {
  const text = response?.content?.[0]?.text;
  if (typeof text !== "string") return [];

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return [];
  }

  const urls = new Set();
  const queue = [parsed];
  let visited = 0;
  while (queue.length && visited < 400) {
    visited += 1;
    const current = queue.shift();
    if (!current || typeof current !== "object") continue;

    if (typeof current.redirect_url === "string" && current.redirect_url.trim()) {
      urls.add(current.redirect_url.trim());
    }

    Object.values(current).forEach((value) => {
      if (Array.isArray(value)) value.forEach((item) => queue.push(item));
      else if (value && typeof value === "object") queue.push(value);
    });
  }

  return Array.from(urls);
}

export function clearAuthPollForSlug(toolSlug) {
  const key = String(toolSlug || "").toUpperCase();
  if (!key) return;
  const state = deps.getAuthPollStateBySlug().get(key);
  if (!state) return;
  state.stopped = true;
  if (state.timeoutId) window.clearTimeout(state.timeoutId);
  if (state.hardTimeoutId) window.clearTimeout(state.hardTimeoutId);
  deps.getAuthPollStateBySlug().delete(key);
}

export function clearAllAuthPolls() {
  for (const toolSlug of [...deps.getAuthPollStateBySlug().keys()]) {
    clearAuthPollForSlug(toolSlug);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Tools Configuration State
// ═══════════════════════════════════════════════════════════════════════

export function getToolsConfigState(extensionAPI) {
  const schemaVersion = deps.getSettingNumber(extensionAPI, deps.SETTINGS_KEYS.toolsSchemaVersion, 0);
  const installedToolsRaw = deps.getSettingArray(extensionAPI, deps.SETTINGS_KEYS.installedTools, []);
  const installedTools = installedToolsRaw
    .map(normaliseInstalledToolRecord)
    .filter(Boolean);
  const toolPreferences = deps.getSettingObject(extensionAPI, deps.SETTINGS_KEYS.toolPreferences, {});
  const toolPacksEnabled = deps.getSettingArray(extensionAPI, deps.SETTINGS_KEYS.toolPacksEnabled, [])
    .filter((item) => typeof item === "string");

  return {
    schemaVersion,
    installedTools,
    toolPreferences,
    toolPacksEnabled
  };
}

export function saveToolsConfigState(extensionAPI, nextState) {
  extensionAPI?.settings?.set?.(deps.SETTINGS_KEYS.toolsSchemaVersion, deps.TOOLS_SCHEMA_VERSION);
  extensionAPI?.settings?.set?.(deps.SETTINGS_KEYS.installedTools, nextState.installedTools || []);
  extensionAPI?.settings?.set?.(deps.SETTINGS_KEYS.toolPreferences, nextState.toolPreferences || {});
  extensionAPI?.settings?.set?.(deps.SETTINGS_KEYS.toolPacksEnabled, nextState.toolPacksEnabled || []);
}

export function ensureToolsConfigState(extensionAPI) {
  const current = getToolsConfigState(extensionAPI);
  const needsInit =
    current.schemaVersion !== deps.TOOLS_SCHEMA_VERSION ||
    !Array.isArray(current.installedTools) ||
    typeof current.toolPreferences !== "object" ||
    !Array.isArray(current.toolPacksEnabled);
  if (!needsInit) return current;
  deps.debugLog("[Chief flow] Schema version changed, clearing toolkit schema registry");
  deps.setToolkitSchemaRegistryCache(null);
  extensionAPI?.settings?.set?.(deps.SETTINGS_KEYS.toolkitSchemaRegistry, { toolkits: {} });
  const initialState = {
    schemaVersion: deps.TOOLS_SCHEMA_VERSION,
    installedTools: current.installedTools || [],
    toolPreferences: current.toolPreferences || {},
    toolPacksEnabled: current.toolPacksEnabled || []
  };
  saveToolsConfigState(extensionAPI, initialState);
  return initialState;
}

// ═══════════════════════════════════════════════════════════════════════
// Search and Resolution Helpers
// ═══════════════════════════════════════════════════════════════════════

export function extractCandidateToolkitSlugsFromComposioSearch(result) {
  const text = result?.content?.[0]?.text;
  if (typeof text !== "string") return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return [];
  }

  const keys = [
    "toolkit_slug",
    "toolkit",
    "toolkitSlug",
    "app_slug",
    "app",
    "appName",
    "app_name"
  ];
  const seen = new Set();
  const slugs = [];
  const queue = [parsed];
  let visited = 0;
  while (queue.length && visited < COMPOSIO_TOOLKIT_SEARCH_BFS_MAX_NODES) {
    visited += 1;
    const current = queue.shift();
    if (!current || typeof current !== "object") continue;
    keys.forEach((key) => {
      const value = current[key];
      if (typeof value !== "string") return;
      const slug = normaliseToolkitSlug(value);
      if (!slug || seen.has(slug)) return;
      seen.add(slug);
      slugs.push(slug);
    });
    Object.values(current).forEach((value) => {
      if (Array.isArray(value)) {
        value.forEach((item) => queue.push(item));
      } else if (value && typeof value === "object") {
        queue.push(value);
      }
    });
  }
  return slugs;
}

export async function resolveComposioToolkitSlugForInstall(client, requestedSlug, extensionAPI = deps.getExtensionAPIRef()) {
  const requested = normaliseToolkitSlug(requestedSlug);
  if (!requested || !client?.callTool) {
    return {
      requestedSlug: requested,
      resolvedSlug: requested,
      suggestions: []
    };
  }

  const cachedCatalog = getComposioToolkitCatalogCache(extensionAPI);
  const cacheAgeMs = Date.now() - (cachedCatalog.fetchedAt || 0);
  const cacheIsFresh =
    cachedCatalog.fetchedAt > 0 &&
    cacheAgeMs >= 0 &&
    cacheAgeMs <= COMPOSIO_TOOLKIT_CATALOG_CACHE_TTL_MS;
  const cachedResolution = resolveToolkitSlugFromSuggestions(requested, cachedCatalog.slugs);
  const cachedHasMatch = cachedResolution.resolvedSlug !== requested;

  if (cacheIsFresh && cachedResolution.suggestions.length > 0 && cachedHasMatch) {
    return cachedResolution;
  }

  try {
    const searchResult = await client.callTool({
      name: "COMPOSIO_SEARCH_TOOLS",
      arguments: {
        queries: [{ use_case: requested }]
      }
    });
    const discovered = extractCandidateToolkitSlugsFromComposioSearch(searchResult);
    if (discovered.length) {
      const mergedCatalog = mergeComposioToolkitCatalogSlugs(extensionAPI, discovered, { touchFetchedAt: true });
      return resolveToolkitSlugFromSuggestions(requested, mergedCatalog.slugs);
    }
    return cachedResolution;
  } catch (error) {
    return cachedResolution;
  }
}
