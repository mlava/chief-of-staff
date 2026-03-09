# Chief of Staff — Codebase Overview for Reviewer

> **Purpose:** AI assistant extension for Roam Research. Multi-provider LLM agent with tool-use, memory, skills, scheduled jobs, and external integrations.
>
> **Runtime:** Browser SPA (Roam Research tab). No Node.js at runtime.
>
> **Total source:** ~23,000 lines across 22 files. Build output: single ES module (`extension.js`, ~815 KiB).

---

## 1. File Inventory

### Source (`src/`)

| File | Lines | Role |
|------|------:|------|
| `index.js` | 8,140 | Main entry point — agent loop, tool discovery, lifecycle, Composio UI glue |
| `chat-panel.js` | 2,398 | Chat panel DOM, toasts, approval dialogs, activity log |
| `roam-native-tools.js` | 2,088 | 44 Roam-native tool definitions (search, create, update, delete, move, etc.) |
| `tool-execution.js` | 1,111 | Tool dispatch, approval gating, LLM response parsing, message format conversion |
| `onboarding/onboarding-steps.js` | 963 | 12 onboarding step definitions with render functions |
| `composio-mcp.js` | 945 | Composio MCP data layer — toolkit schema registry, slug handling, auth state |
| `local-mcp.js` | 847 | Local MCP — SSE transport, connection pooling, supply-chain security |
| `cron-scheduler.js` | 757 | Cron jobs — leader election, tick loop, job persistence |
| `llm-providers.js` | 634 | LLM provider abstraction — API calls, PII scrubbing, retry logic |
| `supergateway-script.js` | 618 | Supergateway launch script builder for local MCP servers |
| `tier-routing.js` | 478 | Complexity scoring for mini/power/ludicrous tier selection |
| `inbox.js` | 465 | Inbox processing — pull watch, delta diffing, sequential queue |
| `system-prompt.js` | 463 | Dynamic system prompt assembly, conditional section detection |
| `security-core.js` | 414 | Pure security functions — injection detection, schema hashing, memory guards |
| `conversation.js` | 409 | Conversation turns, context truncation, budget enforcement |
| `usage-tracking.js` | 406 | Cost history, daily caps, audit log, session token tracking |
| `settings-config.js` | 324 | Progressive disclosure settings panel (3 tiers) |
| `onboarding/onboarding-ui.js` | 307 | Onboarding card DOM primitives, transitions, drag |
| `onboarding/onboarding.js` | 302 | Onboarding flow controller (step navigation, resume) |
| `security.js` | 195 | DI wrapper — re-exports security-core functions with runtime deps |
| `parse-utils.js` | 87 | Pure parsing — JSON extraction, MCP key reference parsing |
| `aibom-config.js` | 27 | Static constants — model IDs, API endpoints |

### Tests (`tests/`)

| File | Tests | Coverage area |
|------|------:|---------------|
| `tier-routing.test.mjs` | 40 | Complexity scoring, routing signals |
| `local-mcp.test.mjs` | 39 | State management, routing, formatting |
| `inbox.test.mjs` | 40 | Queue, scanning, tier routing, candidate filtering |
| `tool-execution.test.mjs` | 38 | Approval, parsing, message conversion |
| `usage-tracking.test.mjs` | 33 | Cost history, caps, stats |
| `security-core.test.mjs` | 29 | Injection detection, memory guards, hashing |
| `parse-utils.test.mjs` | 17 | JSON extraction, key references |
| `composio-mcp.test.mjs` | 14 | Toolkit normalisation, caching |

**Total: 250 tests.** Run with `npm test` (`node --test tests/*.test.mjs`).

### Root config

| File | Purpose |
|------|---------|
| `package.json` | Deps: `@modelcontextprotocol/sdk`, `croner`, `izitoast` |
| `webpack.config.js` | Bundles `src/index.js` → `extension.js` (ES module, polyfills Node APIs) |
| `extension.css` | Chat panel + onboarding styles (2,270 lines) |
| `CLAUDE.md` | Architecture reference for AI assistants |

---

## 2. Architecture at a Glance

```
┌──────────────────────────────────────────────────────────┐
│                     index.js (8,140 lines)               │
│                                                          │
│  onload() ──► DI init all 13 modules                    │
│           ──► register commands, hotkeys, pull watches   │
│           ──► start cron scheduler, inbox, onboarding    │
│                                                          │
│  askChiefOfStaff()                                       │
│    ├── tryRunDeterministicAskIntent()  [fast path]       │
│    └── runAgentLoopWithFailover()      [LLM path]        │
│          └── runAgentLoop()                              │
│                ├── buildSystemPrompt()                   │
│                ├── callLlm()                             │
│                ├── parseToolCalls()                      │
│                ├── executeToolCall()                     │
│                └── [iterate up to 20 times]              │
│                                                          │
│  onunload() ──► teardown all resources                   │
└──────────┬───────────────────────────────────────────────┘
           │ DI init + imports
    ┌──────┴──────────────────────────────────┐
    │         13 Extracted Modules             │
    │                                         │
    │  chat-panel.js        conversation.js   │
    │  roam-native-tools.js system-prompt.js  │
    │  tool-execution.js    llm-providers.js  │
    │  composio-mcp.js      security.js       │
    │  local-mcp.js         usage-tracking.js │
    │  cron-scheduler.js    settings-config.js│
    │  inbox.js                               │
    └─────────────────────────────────────────┘

    ┌─────────────────────────────────────────┐
    │         Pure Modules (no DI)            │
    │  parse-utils.js    security-core.js     │
    │  tier-routing.js   aibom-config.js      │
    └─────────────────────────────────────────┘
```

### Dependency Injection pattern

Every extracted module follows the same pattern:

```javascript
let deps = {};
export function initModuleName(injected) { deps = injected; }
// All external access via deps.* — no circular imports
```

`index.js` calls each `init*()` during `onload()`, injecting the functions and state each module needs.

**Pure modules** (`parse-utils.js`, `security-core.js`, `tier-routing.js`, `aibom-config.js`) have zero runtime dependencies — they export pure functions and static constants.

---

## 3. index.js Section Map

| Lines | Section | What to look for |
|------:|---------|------------------|
| 1–190 | **Imports & Constants** | All 18 module imports; settings keys; model configs; cost tables; failover chains |
| 191–369 | **Constants & Init** | Default URLs, memory page titles, skill/cron constants |
| 370–600 | **Extension Tools API** | Auto-discovery on `window.RoamExtensionTools`; Better Tasks bridge; broadcast event listeners |
| 601–700 | **Markdown & Escaping** | `escapeHtml()`, `renderInlineMarkdown()`, `renderMarkdownToSafeHtml()` |
| 700–1,100 | **Settings & Debug** | `getSettingString/Number/Bool/Object/Array()`; `debugLog()` with `[Chief flow]` prefix |
| 1,100–1,300 | **Roam Query Helpers** | `queryRoamDatalog()`, `escapeForDatalog()`, block string/UID/children getters |
| 1,300–1,600 | **Block Tree Builders** | `flattenBlockTree()`, `formatBlockTreeForDisplay()`, page UID/tree lookups |
| 1,600–1,900 | **Memory System** | `getMemoryPageContent()`, `getAllMemoryContent()` — 5 pages, 3K char cap each |
| 1,900–2,100 | **Skills System** | `getSkillEntries()`, `parseSkillSources()` — Chief of Staff/Skills page |
| 2,100–2,400 | **Better Tasks Integration** | `hasBetterTasksAPI()`, `getBetterTasksTools()` — Extension Tools API bridge |
| 2,400–2,750 | **Composio UI Helpers** | Toolkit discovery, AIBOM rendering, install/uninstall flows |
| 2,750–3,100 | **COS Tools** | `cos_update_memory`, `cos_cron_create`, `cos_write_draft_skill`, etc. |
| 3,100–3,500 | **Deterministic Intent Router** | Fast-path parsing for memory, skills, tasks, email, calendar intents |
| 3,500–4,300 | **Agent Loop** | `runAgentLoop()` — core reasoning: token tracking, guards, tool dispatch (800 lines) |
| 4,300–4,700 | **Failover Handler** | `runAgentLoopWithFailover()` — provider chains, context carryover, tier escalation |
| 4,700–5,400 | **Composio Connect & Auth** | `connectComposio()`, OAuth polling, auth reconciliation |
| 5,400–5,800 | **Composio Install & Routing** | `upsertInstalledTool()`, complexity-based tier escalation |
| 5,800–6,700 | **Deterministic Ask Router** | `tryRunDeterministicAskIntent()` — 900 lines of fast-path matching |
| 6,700–6,900 | **Main Entry** | `askChiefOfStaff()` — auto-escalation, conversation enrichment |
| 6,900–7,600 | **onload()** | DI init, command palette, hotkeys, pull watches, cron, onboarding, inbox |
| 7,600–8,140 | **onunload()** | Teardown: abort requests, flush state, disconnect MCP, stop cron |

---

## 4. Tool System

Tools come from five sources, all aggregated in `getAvailableToolSchemas()`:

| Source | Count | Location | Notes |
|--------|------:|----------|-------|
| **Roam native** | 44 | `roam-native-tools.js` | `roam_search`, `roam_create_block`, `roam_delete_block`, etc. |
| **Extension Tools API** | Variable | `window.RoamExtensionTools` | Auto-discovered from other Roam extensions (Better Tasks, workspaces, focus mode, etc.) |
| **Composio MCP** | Variable | `composio-mcp.js` | External services (Gmail, Calendar, GitHub, Slack) via StreamableHTTP |
| **Local MCP** | Variable | `local-mcp.js` | Local MCP servers (Zotero, GitHub, custom) via SSE |
| **COS internal** | ~8 | index.js §COS Tools | `cos_update_memory`, `cos_cron_create`, `cos_write_draft_skill`, etc. |

### Tool object shape

```javascript
{
  name: "roam_search",           // snake_case, prefixed
  description: "Search blocks…",
  input_schema: { type: "object", properties: {…}, required: […] },
  execute: async (args) => "result string",
  isMutating: true               // optional — triggers approval gating
}
```

### Safety: approval gating

Mutating tools (`isMutating: true`) require user confirmation via toast dialog. Approvals are cached per-tool for 15 minutes per session. Page-scoped write approvals are tracked separately.

### Local MCP: two-stage routing

Servers with ≤15 tools register tools directly. Servers with >15 tools use:
1. `LOCAL_MCP_ROUTE` — discovery (list available tools)
2. `LOCAL_MCP_EXECUTE` — execute specific tool by name

---

## 5. Agent Loop Flow

```
askChiefOfStaff(userMessage)
  │
  ├─► tryRunDeterministicAskIntent()     # Fast path (no LLM call)
  │     Memory saves, skill invocations, task queries,
  │     email/calendar, tool list queries, zero-arg tool execution
  │
  └─► runAgentLoopWithFailover()          # LLM path
        │
        ├─► Select provider chain based on tier (mini/power/ludicrous)
        │     Chain order: anthropic → gemini → mistral → openai
        │
        └─► runAgentLoop()                # Core loop (up to 20 iterations)
              │
              ├── buildSystemPrompt()     # Dynamic, with conditional sections
              ├── callLlm()              # Provider-specific API call
              ├── parseToolCalls()       # Extract tool calls from response
              ├── executeToolCall()      # Dispatch + approval gating
              ├── [safety guards]        # Claimed-action, fabrication, live-data
              └── [iterate or return]
```

### Tier escalation

| Trigger | From | To |
|---------|------|----|
| POWER_ESCALATION_PATTERNS match | mini | power |
| Local MCP server name in prompt | mini | power |
| `sessionUsedLocalMcp` flag set | mini | power |
| Claimed-action count ≥ 2 | mini | power |
| User prefix `/power` | any | power |
| User prefix `/ludicrous` | any | ludicrous |

### Safety guards in the agent loop

1. **Claimed-action detection** — Catches models that claim to have performed actions without issuing tool calls. Three layers: detection + retry nudge → context hygiene (sanitise poisoned turns) → tier escalation.
2. **MCP fabrication guard** — Blocks long responses without tool calls in MCP sessions.
3. **Live data guard** — Requires at least one successful external data tool result before allowing the model to present "live" data.
4. **MCP key validation** — Rejects path-style and display-name values in key/ID parameters.
5. **Source completeness guard** — Ensures required tools from skill definitions are actually called.
6. **Empty response guard** — Auto-retries when model returns 0 output tokens after successful tool calls.

---

## 6. Security Model

### Layers (from `security.js` / `security-core.js`)

| Layer | Function | Purpose |
|-------|----------|---------|
| Injection detection | `wrapUntrustedWithInjectionScan()` | Scans untrusted content for prompt injection patterns |
| Memory guards | `guardMemoryWrite()` | Prevents injection via memory page writes |
| System prompt leakage | `detectSystemPromptLeakage()` | Fingerprint matching against known system prompt phrases |
| LLM payload sanitisation | `sanitiseLlmPayload()` | Scrubs PII, redacts sensitive patterns before API calls |
| DOM sanitisation | `sanitiseForDom()` | Prevents XSS in rendered content |
| Log redaction | `redactForLog()` | Strips sensitive data from debug logs |
| Schema pinning | `computeSchemaHash()` | Detects MCP tool schema changes (supply-chain security) |

### Approval gating (`tool-execution.js`)

- All mutating tools require user confirmation
- 15-minute session-scoped approval cache
- Page-scoped write approvals tracked separately
- Dry-run mode available (simulates without executing)
- Inbox processing restricted to read-only tool allowlist

---

## 7. External Integrations

### Composio MCP (cloud)
- **Transport:** StreamableHTTP via `@modelcontextprotocol/sdk`
- **Proxy:** Cloudflare Worker (`roam-mcp-proxy`) for CORS
- **Services:** Gmail, Google Calendar, Todoist, GitHub, Slack, etc.
- **Auth:** OAuth polling loop (9s interval, 180s timeout)
- **Schema cache:** Toolkit registry with 7-day TTL, max 30 toolkits

### Local MCP (local servers)
- **Transport:** Native browser `EventSource` (NOT the SDK's `SSEClientTransport`)
- **Why:** SDK's `SSEClientTransport` uses `eventsource` v3 npm package (fetch-based), which fails with supergateway's local SSE endpoints
- **Connection pooling:** `localMcpClients` Map keyed by port
- **Supply-chain security:** Schema pinning, tool description scanning, BOM tracking, server suspension

### Extension Tools API
- Auto-discovers tools from any Roam extension via `window.RoamExtensionTools`
- Better Tasks is the primary consumer but the system is generic
- Discovered at the start of each agent loop

---

## 8. Persistence & State

### Roam Depot settings (IndexedDB)
27 settings keys including API keys, installed tools, conversation context, chat history, cron jobs, toolkit schemas.

### Memory system (Roam pages)
Five pages under `Chief of Staff/`:
- `Memory` — General assistant memory
- `Inbox` — Input channel for async processing
- `Decisions` — Decision log
- `Lessons Learned` — Patterns and insights
- `Improvement Requests` — User feedback

Each loaded per agent run, capped at 3,000 chars/page.

### Module-scoped state (key variables)

| Module | Key state | Lifecycle |
|--------|-----------|-----------|
| `index.js` | `extensionAPIRef`, `composioClientRef`, `activeAgentAbortController`, `btProjectsCache`, `sessionClaimedActionCount` | Extension lifetime |
| `conversation.js` | `conversationTurns[]`, `sessionUsedLocalMcp` | Session (12-turn max) |
| `local-mcp.js` | `localMcpClients` Map, `suspendedMcpServers` Map, `execPool` Map, `portQueues` Map | Extension lifetime |
| `cron-scheduler.js` | `cronLeaderTabId`, `cronRunningJobs` Set | Extension lifetime |
| `tool-execution.js` | `approvedToolsThisSession` Map (15-min TTL) | Session |
| `usage-tracking.js` | `sessionTokenUsage`, `costHistory`, `usageStats` | Session / persisted |
| `inbox.js` | `inboxProcessingQueue`, `inboxPendingQueueCount` | Extension lifetime |
| `chat-panel.js` | DOM refs, `chatPanelHistory[]`, `activeToastKeyboards` | Extension lifetime |

---

## 9. Onboarding System

12 steps, defined in `onboarding/onboarding-steps.js`:

| # | Step ID | Purpose | Conditional? |
|---|---------|---------|-------------|
| 0 | `welcome` | Logo, intro text | No |
| 1 | `introductions` | Name input → creates user page | No |
| 2 | `api-key` | Provider selector + API key input | No |
| 3 | `better-tasks` | Better Tasks API key | Skip if no BT API |
| 4 | `memory-pages` | Create memory pages | Skip if pages exist |
| 5 | `memory-questionnaire` | Preference questions | No |
| 6 | `hotkey` | Hotkey assignment | No |
| 7 | `chat-panel` | First interaction | No |
| 8 | `skills` | Skills page bootstrap | No |
| 9 | `composio` | Composio connection | Optional |
| 10 | `local-mcp` | Local MCP port setup | Optional |
| 11 | `finish` | Completion + help links | No |

Resume logic: loads state from settings, skips completed steps, walks forward to next incomplete.

---

## 10. Build & Test

```bash
npm run build       # webpack → extension.js (ES module)
npm test            # node --test tests/*.test.mjs (250 tests)
npm run test:security   # security-core tests only
npm run ci          # tests → build → AIBOM generation
```

### Webpack config
- **Entry:** `src/index.js`
- **Output:** `extension.js` (ES module, gitignored)
- **Polyfills:** stream, buffer, url, http, zlib (for MCP SDK browser compat)
- **Externals:** `roam-client` (provided by Roam at runtime)
- **Mode:** production

---

## 11. Key Constants

```
MAX_AGENT_ITERATIONS         = 20
MAX_AGENT_ITERATIONS_SKILL   = 16
MAX_TOOL_CALLS_PER_ITERATION = 4
MAX_CALLS_PER_TOOL_PER_LOOP  = 10
MAX_TOOL_RESULT_CHARS        = 12,000
MAX_CONVERSATION_TURNS       = 12
MAX_CONTEXT_USER_CHARS       = 500
MAX_CONTEXT_ASSISTANT_CHARS  = 2,000
MAX_AGENT_MESSAGES_CHAR_BUDGET = 70,000
STANDARD_MAX_OUTPUT_TOKENS   = 2,500
SKILL_MAX_OUTPUT_TOKENS      = 4,096
LUDICROUS_MAX_OUTPUT_TOKENS  = 8,192
LOCAL_MCP_DIRECT_TOOL_THRESHOLD = 15
```

### Model tiers

| Tier | Anthropic | OpenAI | Gemini | Mistral |
|------|-----------|--------|--------|---------|
| Mini | claude-haiku-4-5 | gpt-5-mini | gemini-3.1-flash-lite-preview | mistral-small |
| Power | claude-sonnet-4-6 | gpt-4.1 | gemini-3-flash-preview | mistral-medium |
| Ludicrous | claude-opus-4-6 | gpt-5.4 | gemini-3.1-pro-preview-customtools | mistral-large |

---

## 12. Review Guidance

### High-risk areas to scrutinise
1. **Agent loop** (index.js:3,500–4,300) — Core reasoning loop; iteration limits, token budgets, guard bypass paths
2. **Tool execution** (`tool-execution.js`) — Approval gating correctness, write detection, parsing edge cases
3. **Security** (`security-core.js`, `security.js`) — Injection patterns, memory guards, schema pinning
4. **Local MCP** (`local-mcp.js`) — SSE transport reliability, supply-chain security, connection pooling cleanup
5. **Composio auth** (index.js:4,700–5,400) — OAuth polling, token handling, connection state
6. **Inbox processing** (`inbox.js`) — Read-only enforcement, queue backpressure, delta diffing correctness

### Lower-risk / UI areas
- Chat panel DOM (`chat-panel.js`) — UI only, no data mutation
- Onboarding (`onboarding/`) — Setup wizard, no ongoing runtime impact
- Settings panel (`settings-config.js`) — Configuration UI
- Supergateway script (`supergateway-script.js`) — Shell script generation for local MCP

### Things to verify
- [ ] All observers disconnect on `onunload()`
- [ ] No unbounded arrays or maps (check lifecycle of `localMcpClients`, `approvedToolsThisSession`, `conversationTurns`)
- [ ] Approval gating cannot be bypassed (check `isMutating` coverage on write tools)
- [ ] Inbox read-only allowlist is comprehensive (no write tools leak through)
- [ ] Daily spending cap enforcement is correct
- [ ] Multi-tab leader election handles edge cases (tab crash, stale heartbeat)
- [ ] PII scrubbing covers all provider API call paths
- [ ] System prompt leakage detection covers all output paths
