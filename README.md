# Chief of Staff

An AI assistant embedded in Roam Research. Chief of Staff connects your Roam graph to large language models (Anthropic Claude or OpenAI GPT) and to external tools via [Composio](https://composio.dev), letting you ask questions, search and manage tasks, and orchestrate actions across your connected apps — all without leaving Roam.

---

## What it does

- **Ask anything** via the command palette or a persistent floating chat panel. The assistant can read your graph, create blocks, and call external tools in a guided, approval-gated agent loop.
- **Better Tasks integration** — search, create, and modify Better Tasks (TODO/DONE parent blocks with `BT_attr*` attribute children) directly from natural language. Supports filtering by due date, project, status, and free text.
- **Persistent memory** — loads context from `Chief of Staff/Memory`, `Chief of Staff/Inbox`, `Chief of Staff/Projects`, `Chief of Staff/Decisions`, and `Chief of Staff/Lessons Learned` into the system prompt each run.
- **Skill routing** — reads `Chief of Staff/Skills`, injects a compact skill index into the prompt, and can apply a specific skill on request.
- **Composio tool connections** — connect Google Calendar, Gmail, Todoist, and hundreds of other apps via Composio MCP. The assistant discovers and executes tools on your behalf.
- **Daily briefings** — generate a plain briefing (via Ask) or a structured briefing written directly into today's daily page as nested blocks.
- **Dry-run mode** — simulate any mutating operation before it executes. Useful for reviewing what the agent would do before committing.

---

## Requirements

| Requirement | Notes |
|---|---|
| Anthropic or OpenAI API key | Direct browser fetch — incurs API costs at your provider's rates |
| Composio account + MCP URL | Only required for external tool integrations. Graph and task features work without it. |
| CORS proxy (Cloudflare Worker) | Only required for Composio. See [roam-mcp-proxy](roam-mcp-proxy/) for setup. |
| [Better Tasks / Recurring Tasks](https://github.com/mlava/recurring-tasks) extension | Only required for Better Tasks integration. Plain TODO search works without it. |

---

## Setup

### 1. Configure your LLM

Open **Settings → Chief of Staff** and fill in:

- **Assistant Name** — display-only label used in chat header/toasts (default: `Chief of Staff`)
- **LLM Provider** — `anthropic` (default) or `openai`
- **LLM API Key** — your Anthropic (`sk-ant-...`) or OpenAI (`sk-...`) key
- **LLM Model** — leave blank to use the default (`claude-sonnet-4-5-20250929` / `gpt-4o`), or enter any model ID supported by your provider
- **Better Tasks scan cap** — maximum number of Better Task parent records scanned per query (50–1000). Lower is faster; higher is more complete. Tune this if you have a very large graph.
- **Debug Logging** — enable verbose console output for troubleshooting

> **Security note:** API keys are stored in Roam Depot's settings store (browser IndexedDB). They are never transmitted except directly to the LLM provider's API endpoint. Do not use shared or public Roam graphs if you store API keys here.

### 2. Connect Composio (optional)

Composio lets the assistant call external APIs (Gmail, Google Calendar, Todoist, etc.) via MCP. Skip this section if you only need graph and task features.

#### 2a. Deploy a CORS proxy

Roam runs in the browser, so cross-origin requests to Composio's MCP endpoint are blocked by default. You need a small proxy that adds CORS headers. A ready-to-deploy Cloudflare Worker is included in [`roam-mcp-proxy/`](roam-mcp-proxy/). It only accepts requests originating from `roamresearch.com` by default.

```bash
cd roam-mcp-proxy
npm install
npx wrangler login   # one-time Cloudflare auth
npx wrangler deploy
```

Wrangler will print your worker URL (e.g. `https://roam-mcp-proxy.<you>.workers.dev`). See [roam-mcp-proxy/README.md](roam-mcp-proxy/README.md) for full details and optional security hardening.

#### 2b. Configure the extension

1. Create a [Composio](https://composio.dev) account and copy your **MCP URL** and **API key** from the Composio dashboard.
2. In **Settings → Chief of Staff**, set **Composio MCP URL** to your proxy URL with the real Composio endpoint appended as the path:
   ```
   https://roam-mcp-proxy.<you>.workers.dev/https://mcp.composio.dev/<your-endpoint>
   ```
3. Enter your **Composio API Key** in the same settings panel.
4. Run **Chief of Staff: Connect Composio** from the command palette.
5. Run **Chief of Staff: Install Composio Tool** and enter a tool slug (e.g. `GOOGLECALENDAR`, `GMAIL`, `TODOIST`). You will be redirected to complete OAuth authentication in a new tab.

---

## Command palette

| Command | What it does |
|---|---|
| **Chief of Staff: Ask** | Opens a prompt dialog. The assistant reasons over your question using LLM + available tools. |
| **Chief of Staff: Toggle Chat Panel** | Shows or hides the floating chat panel. |
| **Chief of Staff: Write Structured Briefing** | Generates a structured daily briefing (Calendar, Email, Tasks, Top Priorities) and writes it to today's daily page. |
| **Chief of Staff: Bootstrap Memory Pages** | Creates memory pages (if missing) with starter content. |
| **Chief of Staff: Show Memory Snapshot** | Logs currently loaded memory content to console. |
| **Chief of Staff: Bootstrap Skills Page** | Creates `Chief of Staff/Skills` with starter skills (if missing). |
| **Chief of Staff: Show Skills Snapshot** | Logs loaded skills and injected skill index to console. |
| **Chief of Staff: Refresh Skills Cache** | Reloads skills from the graph after page edits. |
| **Chief of Staff: Connect Composio** | Connects the MCP client to your Composio endpoint. |
| **Chief of Staff: Disconnect Composio** | Closes the active Composio connection. |
| **Chief of Staff: Reconnect Composio** | Disconnects and reconnects (useful after credential changes). |
| **Chief of Staff: Install Composio Tool** | Prompts for a tool slug and starts the installation + authentication flow. |
| **Chief of Staff: Deregister Composio Tool** | Removes a connected tool from Composio and from local state. |
| **Chief of Staff: Test Composio Tool Connection** | Checks whether a specific tool is currently reachable via Composio. |
| **Chief of Staff: Refresh Tool Auth Status** | Re-checks any tools waiting for OAuth completion. |
| **Chief of Staff: Clear Conversation Context** | Resets conversation memory and chat history. |
| **Chief of Staff: Show Stored Tool Config** | Logs the current tool configuration to the browser console. |
| **Chief of Staff: Show Last Run Trace** | Logs the most recent agent run (iterations, tool calls, timing) to the browser console. |
| **Chief of Staff: Debug Runtime Stats** | Logs current runtime state (cache sizes, connection status, conversation turns) to the browser console. |

---

## Chat panel

The floating chat panel (bottom-right corner by default) provides a persistent conversational interface. It is draggable and remembers history across sessions (up to 80 messages). Use it for follow-up questions without re-opening the command palette.

Press **Enter** to send, **Shift+Enter** for a new line. Use the **Clear** button to reset history.

The panel suppresses non-essential toasts while open, and persists conversation history across reloads.

---

## Task integration

Chief of Staff recognises natural language task queries and routes them to dedicated handlers — no LLM call required for common patterns:

- *"Find my better tasks due this week"*
- *"Show overdue tasks for AMEE FD Committee"*
- *"Create a better task to review the budget due next Friday"*
- *"List my top 10 TODO tasks"*

If the Better Tasks extension is installed, all task queries use Better Tasks attributes (`BT_attrDue`, `BT_attrProject`, etc.). Otherwise, plain `{{[[TODO]]}}` / `{{[[DONE]]}}` blocks are searched.

### Better Tasks attributes recognised

`BT_attrProject` · `BT_attrDue` · `BT_attrStart` · `BT_attrDefer` · `BT_attrRepeat` · `BT_attrGTD` · `BT_attrWaitingFor` · `BT_attrContext` · `BT_attrPriority` · `BT_attrEnergy`

Custom attribute aliases configured in the Better Tasks / Recurring Tasks extension are respected automatically.

---

## Memory and learning

Chief of Staff automatically loads memory content on each LLM run (no tool call required).

Pages used:
- `Chief of Staff/Memory`
- `Chief of Staff/Inbox`
- `Chief of Staff/Projects`
- `Chief of Staff/Decisions`
- `Chief of Staff/Lessons Learned`

You can save memory explicitly in chat (for example: “remember this…”, “note this idea…”, “save this lesson…”), or via the native `cos_update_memory` tool path.

---

## Skills

Skills are sourced from `Chief of Staff/Skills`.

Expected structure:
- Parent block = **skill name**
- Child blocks = **skill instructions**

Example:

```text
- Weekly Review
  - Objective: Conduct a weekly review for the past 7 days.
  - Sources: Chief of Staff/Projects, Chief of Staff/Decisions, Better Tasks.
  - Output: Top priorities, overdue items, next-week plan.
```

After editing the page, run **Chief of Staff: Refresh Skills Cache** to reload immediately.  
The prompt receives a compact skill index (all skill names + short summaries), while full skill bodies are used on explicit invocation.

---

## Safety and data

- **Approval gating** — every mutating operation (creating, modifying, or deleting blocks; sending emails; creating calendar events) requires explicit approval via a confirmation prompt before it executes.
- **Dry-run mode** — enabling *Dry Run* in settings simulates the next mutating call without writing anything. The toggle disables itself after one use.
- **Read-only tools are auto-approved** — searches, lookups, and list operations do not require confirmation.
- **No silent mutations** — the extension will never overwrite a block containing user content. If a block is non-empty, a sibling block is created instead.
- **Tool-first live data guard** — for requests like recent emails/calendar/schedule/connections, the assistant refuses to guess if no external tool call succeeded.

---

## Limitations and performance considerations

- **Graph scans** — task search queries scan all blocks in your graph that match TODO/DONE patterns. Performance scales with graph size. On very large graphs (100k+ blocks) this may take a second or two.
- **Agent iterations** — the reasoning loop is capped at 10 iterations per request to prevent runaway API usage.
- **Conversation context** — the assistant retains up to 8 recent turns (truncated to 500 characters each) for follow-up context. Older turns are dropped automatically.
- **Composio dependency** — external tool features (Gmail, Google Calendar, Todoist, etc.) require an active Composio connection. Roam graph and task features work fully offline from Composio.
- **LLM API costs** — requests are sent directly from your browser to Anthropic or OpenAI. Costs are billed to your API account. Structured briefings and multi-tool agent runs consume more tokens than simple queries.
- **Model support** — any model ID accepted by the configured provider can be used. Non-tool-use models will not function correctly with the agent loop.

---

## Programmatic access

The extension exposes a small API on `window.chiefOfStaff` for use from Smartblocks or the browser console:

```js
window.chiefOfStaff.ask("What are my tasks due today?");
window.chiefOfStaff.briefing();
window.chiefOfStaff.toggleChat();
const memory = await window.chiefOfStaff.memory(); // force-refresh and return memory content
const skills = await window.chiefOfStaff.skills(); // force-refresh and return skills content
window.chiefOfStaff.mcpClient(); // returns the active MCP client or null
```

`memory()` and `skills()` are async — they return Promises and must be awaited (or chained with `.then()`).
