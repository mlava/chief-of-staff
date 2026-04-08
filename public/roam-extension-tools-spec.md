# Roam Extension Tools API — Implementation Spec

*Updated: 8 April 2026*

---

## What This Is

[Chief of Staff](https://github.com/mlava/chief-of-staff) is a Roam extension that adds an AI agent to your graph — it can read and write blocks, manage tasks, run scheduled jobs, and call external services. It automatically discovers tools from other Roam extensions at runtime via `window.RoamExtensionTools`. If your extension registers tools using this spec, any Chief of Staff user who has your extension installed gets AI-powered access to your extension's capabilities — no configuration required.

This spec is designed to be handed directly to an AI coding agent (Claude Code, Cursor, Copilot, etc.) working in your extension's codebase. Point it at this file and it should produce a correct implementation.

---

## API Contract — `window.RoamExtensionTools`

This is the **exact shape** Chief of Staff expects when discovering extension tools. Follow this contract precisely — any deviation will cause tools to be silently skipped or fail at execution time.

### Registration

Register in your extension's `onload()`, clean up in `onunload()`:

```javascript
// onload()
window.RoamExtensionTools = window.RoamExtensionTools || {};
window.RoamExtensionTools["your-extension-id"] = {
  name: "Your Extension",       // Display name — shown in system prompt, prefixed to tool descriptions
  version: "1.0",               // Informational only
  tools: [ /* see Tool Shape below */ ],
  broadcasts: [ /* optional, see Broadcasts below */ ]
};

// onunload()
delete window.RoamExtensionTools?.["your-extension-id"];
```

**Extension ID:** Use your Roam Depot extension ID (kebab-case). COS uses this as the registry key.

### Tool Shape (required)

Each tool in the `tools` array **must** have this shape:

```javascript
{
  name: "prefix_action",              // REQUIRED — unique tool name, namespaced by extension (e.g. ws_open, bh_remove, rdr_run_research)
  description: "What this tool does.", // REQUIRED — see "Writing Tool Descriptions" below
  readOnly: true,                      // Optional — if true, COS skips the approval prompt and allows use in inbox read-only mode
  parameters: {                        // REQUIRED — JSON Schema for tool arguments
    type: "object",
    properties: {
      my_param: {
        type: "string",
        description: "What this parameter does.",
        enum: ["allowed", "values"]    // Optional — constrains LLM input
      }
    },
    required: ["my_param"]             // List required params
  },
  execute: async (args) => {           // REQUIRED — async function, receives full args object
    // args.my_param === "allowed"
    // Do the work...
    return { success: true, data: "..." };
  }
}
```

### Writing Tool Descriptions

The `description` field is the single most important part of your tool definition. The LLM never sees your source code, your extension's UI, or your README. It sees a name, a description, and an input schema. That is the entire relationship.

**COS truncates descriptions to 300 characters** after prefixing with `[Extension Name]`. Budget accordingly — front-load the most important information. A 280-character description for an extension named "Workspaces" becomes `[Workspaces] ...` and fits within the limit. A 300-character description will be cut.

A good description answers three questions for a reader with zero context who cannot ask a follow-up question:

1. **What does this tool do?** (the action)
2. **When should the agent pick this tool?** (disambiguation from similar tools)
3. **What does it return?** (so the agent knows if it gets what it needs)

```javascript
// Weak — accurate but opaque
description: "Opens a workspace."

// Strong — intent survives the journey from your head to the agent
description: "Open a saved workspace by name. Restores sidebar state, main content, and layout. USE WHEN: user says 'switch to Research layout', 'open workspace X'. RETURNS: workspace name confirmed."
```

#### Description Patterns

Use these inline markers. The LLM recognises them as structured intent signals:

**USE WHEN** — Natural-language phrases that should route to this tool. This is the most effective way to disambiguate similar tools. Without it, the agent guesses.

```javascript
description: "Search tasks by status, project, or date. USE WHEN: user asks 'what's due today', 'show my TODOs', 'tasks in Project X'. RETURNS: array of matching tasks with uid, status, due date."
```

**RETURNS** — What the response contains. The agent uses this to decide if the tool gives it what it needs before calling it.

```javascript
description: "Get task details by UID. RETURNS: full task object with status, priority, project, due date, assignee, and all custom attributes."
```

**RELATED** — When your extension has similar tools that could be confused, say which is which. This prevents the connector-vs-shape problem where the agent picks the wrong tool because both descriptions plausibly match.

```javascript
description: "List all projects with their task counts. USE WHEN: user wants a project overview. RELATED: for tasks within a specific project, use bt_search_tasks with project filter instead."
```

**Parameter prerequisites** — If a parameter value must come from another tool's output, say so.

```javascript
description: "Open a saved workspace by name. USE WHEN: user says 'switch layout', 'open workspace'. Get workspace_name from ws_list if the user doesn't specify one."
```

#### Description Anti-Patterns

| Anti-pattern | Why it fails | Fix |
|-------------|-------------|-----|
| `"Manages workspaces."` | Too vague — agent can't distinguish read from write | Say exactly what the tool does: open, list, save, delete |
| `"Advanced task search with powerful filtering capabilities."` | Marketing copy — no routing signal | Replace with USE WHEN phrases and actual filter options |
| `"See documentation for details."` | Agent has no access to your docs | Put the details in the description |
| 400-character essay | Truncated at 300 chars after `[Extension Name]` prefix — the important part may be cut | Front-load action and USE WHEN, put extras in parameter descriptions |
| Only describing the happy path | Agent doesn't know what happens on empty results or errors | Mention return shape for both success and empty/error cases |

### `execute` Function Rules

| Rule | Detail |
|------|--------|
| **Property name** | Must be `execute`. Not `handler`, `run`, `call`, or anything else. |
| **Signature** | `async (args) => result` — receives a single object with all parameters as keys |
| **Return value** | Must return a plain object (e.g. `{ success: true, workspace: "Depot" }`). COS auto-wraps non-objects in `{ result: ... }` but don't rely on this. |
| **Error handling** | Return `{ error: "message" }` on failure. Do NOT throw — COS catches throws but the error message may be less informative. |
| **Side effects** | Fine to have side effects (navigate, modify DOM, write blocks). COS classifies tools as mutating/read-only for approval prompts — see `readOnly` below. |

### `readOnly` Property (optional)

Tells COS whether a tool is safe to run without user approval and in inbox read-only mode. This is the Extension Tools equivalent of MCP's `readOnlyHint` annotation.

| Value | Meaning |
|-------|---------|
| `true` | Tool only reads data — no approval prompt, allowed in inbox read-only mode |
| `false` | Tool mutates data — requires approval prompt |
| omitted | COS falls back to **name-based heuristic** (see naming conventions below) |

**When to set it:** Always set `readOnly` explicitly on your tools. It removes ambiguity and ensures correct behaviour regardless of what you name the tool. The heuristic fallback exists for backward compatibility but explicit annotation is preferred.

### Tool Naming Conventions

- **Prefix with 2-3 letter extension abbreviation:** `ws_`, `bh_`, `rdr_`, `fm_`, etc.
- **Use snake_case:** `ws_open`, `bh_random_unsplash`, `rdr_run_research`
- **Read-only tools:** Set `readOnly: true`. If omitted, COS defaults to treating the tool as **mutating** (requires approval). There is no name-based heuristic — explicit annotation is the only reliable path
- **Mutating tools:** Set `readOnly: false` or omit entirely (default behavior is mutating). Requires user approval on first call (then whitelisted for the session)

### Parameters (JSON Schema)

The `parameters` object follows [JSON Schema](https://json-schema.org/) format. This is passed directly to the LLM as the tool's `input_schema`.

```javascript
parameters: {
  type: "object",
  properties: {
    query: { type: "string", description: "Search query text" },
    limit: { type: "number", description: "Max results. Default 10." },
    format: { type: "string", enum: ["json", "markdown"], description: "Output format." },
    include_archived: { type: "boolean", description: "Include archived items. Default false." }
  },
  required: ["query"]  // Only truly required params — LLM fills in optional params when appropriate
}
```

**Tips:**
- Write parameter descriptions as if the LLM has never seen your extension — don't reference internal concepts without explaining them
- Use `enum` for constrained choices — the LLM will pick from the list (e.g. saved workspace names)
- Keep `required` minimal — the LLM handles optional params well
- Don't use `default` in the schema — handle defaults in your `execute` function instead
- If a parameter value must come from another tool's output, say so in the parameter description (e.g. `"Task UID — get from bt_search_tasks results"`)

### Broadcasts (optional)

Extensions can declare events that COS should listen for. COS auto-subscribes and routes notifications to the chat panel and/or toasts.

```javascript
broadcasts: [
  { event: "rdr:job-completed", toast: "info",  chat: true },
  { event: "rdr:job-failed",    toast: "error", chat: true }
]
```

| Field | Type | Description |
|-------|------|-------------|
| `event` | string | CustomEvent name fired on `window` |
| `toast` | `"info"` \| `"error"` \| omit | Toast type to show (omit for no toast) |
| `chat` | boolean | If `true`, injects an assistant message into the COS chat panel |

**Dispatching an event** (from your extension):

```javascript
window.dispatchEvent(new CustomEvent("rdr:job-completed", {
  detail: {
    title: "Research complete",                                    // Toast title (max 100 chars)
    message: 'Research complete: "query". Results: ((rootUid))'    // Chat panel + toast body (max 500 chars)
  }
}));
```

COS reads `detail.title` and `detail.message` — it doesn't interpret any other fields.

### What COS Does With Your Tools

1. **Discovery:** Reads `window.RoamExtensionTools` at the start of each agent loop — tools appear/disappear dynamically
2. **System prompt:** Injects a summary section: `## Roam Extension Tools` — for extensions with ≤15 total tools, each tool is listed by name with its description for direct calling. For >15 total tools, tools are listed by extension name only and the agent uses a two-stage routing flow (EXT_ROUTE → EXT_EXECUTE)
3. **Description processing:** Your `description` is prefixed with `[Your Extension]` and **truncated to 300 characters**. Front-load the important information — action, USE WHEN, and RETURNS should appear in the first 250 characters
4. **Tool schema:** Passes your `parameters` as `input_schema` to the LLM API
5. **Execution:** Calls `tool.execute(args)` directly — args come from the LLM's tool call
6. **Approval:** Tools with `readOnly: true` skip approval entirely. Other tools prompt the user once, then are whitelisted for the session. In inbox read-only mode, only `readOnly: true` tools (plus COS's internal allowlist) are available
7. **Error display:** If `execute` returns `{ error: "..." }` or throws, the error is relayed to the LLM which explains it to the user
8. **Extension allowlist:** Extensions default to disabled — users opt in via Extension Tools toggles in settings. An extension must be enabled before its tools appear in the agent loop

### Complete Example — Workspaces Extension

```javascript
// In onload():
window.RoamExtensionTools = window.RoamExtensionTools || {};
window.RoamExtensionTools["workspaces"] = {
  name: "Workspaces",
  version: "1.0",
  tools: [
    {
      name: "ws_list",
      description: "List all saved workspaces. USE WHEN: user asks 'what workspaces do I have', 'show my layouts'. RETURNS: array of workspace names.",
      readOnly: true,
      parameters: {
        type: "object",
        properties: {},
        required: []
      },
      execute: async () => {
        const workspaces = getSavedWorkspaces();
        return { success: true, workspaces: workspaces.map(w => w.name) };
      }
    },
    {
      name: "ws_open",
      description: "Open a saved workspace by name. Restores sidebar, main content, and layout. USE WHEN: user says 'switch to Research', 'open workspace X'. Get name from ws_list if not specified.",
      readOnly: false,  // Mutates UI state — requires approval
      parameters: {
        type: "object",
        properties: {
          workspace_name: {
            type: "string",
            description: "Name of the workspace to open. Get from ws_list if the user doesn't specify.",
            enum: ["Depot", "Research", "Writing"]  // Dynamically populated from saved workspaces
          }
        },
        required: ["workspace_name"]
      },
      execute: async (args) => {
        await openWorkspace(args.workspace_name);
        return { success: true, workspace: args.workspace_name };
      }
    }
  ]
};

// In onunload():
delete window.RoamExtensionTools?.["workspaces"];
```

### Common Mistakes

| Mistake | Symptom | Fix |
|---------|---------|-----|
| Using `handler` instead of `execute` | Tool is silently skipped — never appears in schema or executes | Rename the property to `execute` |
| Using `ext.execute(toolName, args)` pattern | Tool is silently skipped — COS only checks `tool.execute` | Move execute onto each tool object: `tool.execute = async (args) => ...` |
| Throwing errors instead of returning `{ error }` | Less informative error messages in chat | Return `{ error: "message" }` |
| Missing `parameters` property | LLM doesn't know what args to pass | Always include, even if empty: `{ type: "object", properties: {} }` |
| Non-namespaced tool names (`open`, `search`) | Name collisions with other extensions | Prefix with extension abbreviation: `ws_open`, `bh_search` |
| Returning raw strings or primitives | COS wraps in `{ result: ... }` but LLM may struggle to parse | Return objects: `{ success: true, data: "..." }` |
| Not cleaning up in `onunload()` | Stale tools remain after extension disabled | Always `delete window.RoamExtensionTools?.["your-id"]` |
| Vague description without USE WHEN | Agent picks wrong tool or ignores yours in favor of a native Roam tool | Add USE WHEN phrases and RETURNS to the description |
| Description over 280 characters | Truncated after `[Extension Name]` prefix — USE WHEN or RETURNS may be cut | Front-load action and routing signals; move detail to parameter descriptions |

---

## Instructions for IDE Agent

This spec is designed to be handed to an AI coding agent (e.g. Claude Code, Cursor, Copilot) working inside an extension's codebase. Before writing any code:

1. **Find the entry point.** Locate the extension's `onload()` and `onunload()` functions — these are where registration and cleanup go. In Roam extensions this is typically the default export in `src/index.js`, `src/index.ts`, or the main file referenced in `package.json`.

2. **Read the existing internals.** The `execute` functions in each tool should be thin wrappers around existing logic, not reimplementations. Before writing an `execute` body, find the module that already does what the tool describes and import/call it. For example:
   - A "search tasks" tool should wrap the existing query/filter engine, not write new Roam queries
   - A "get projects" tool should wrap the existing project store, not parse blocks manually
   - A "create task" tool should call the existing task creation function, not call `roam.createBlock` directly

3. **Understand the data model.** Read how the extension stores and retrieves its data (attributes, statuses, configurations). The tool's return format should expose this data as clean JSON — parsed key-value pairs, not raw block text or Roam query results.

4. **Match the contract exactly.** Each tool must have `name`, `description`, `parameters` (JSON Schema), and `execute` (async function). The orchestrator (Chief of Staff) discovers tools by scanning `window.RoamExtensionTools` and calls `execute(args)` directly. Return plain objects or strings, not Roam block UIDs or internal data structures.

5. **Write descriptions for the agent, not for humans.** The LLM that calls your tool has never seen your extension's UI. Include USE WHEN phrases so it knows when to select your tool over alternatives. Include RETURNS so it knows what data it gets back. Keep the total description under 280 characters (COS prefixes with `[Extension Name]` and truncates at 300).

6. **Error handling.** Each `execute` should return `{ error: "message" }` on failure rather than throwing. The orchestrator relays errors to the LLM, which presents them to the user.

7. **Keep it minimal.** The registration scaffold is ~10 lines. Each tool wrapper is typically 10–30 lines. If you're writing more than 50 lines for a single tool, you're probably reimplementing logic that already exists in the codebase.
