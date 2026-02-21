# Chief of Staff

An AI assistant embedded in Roam Research. Chief of Staff connects your Roam graph to large language models (Anthropic, OpenAI, Google Gemini, or Mistral) and to external tools via [Composio](https://composio.dev), letting you ask questions, search and manage tasks, and orchestrate actions across your connected apps — all without leaving Roam.

---

## What it does

- **Ask anything** via the command palette or a persistent floating chat panel. The assistant can read your graph, create blocks, and call external tools in a guided, approval-gated agent loop.
- **Multi-provider LLM support** — choose from Anthropic Claude, OpenAI GPT, Google Gemini, or Mistral as your primary provider. If one provider is unavailable, the assistant automatically fails over to the next available provider in the chain.
- **Better Tasks integration** — search, create, and modify Better Tasks (TODO/DONE parent blocks with `BT_attr*` attribute children) directly from natural language. Supports filtering by due date, project, status, and free text.
- **Persistent memory** — loads context from dedicated memory pages into the system prompt each run (see [Memory and learning](#memory-and-learning)).
- **Skill routing** — reads `Chief of Staff/Skills`, injects a compact skill index into the prompt, and can apply a specific skill on request. A gathering completeness guard ensures the assistant calls all required data sources before writing.
- **Inbox as input channel** — drop blocks into `Chief of Staff/Inbox` and they are automatically processed in read-only mode (the assistant can search and read but cannot mutate your graph). Responses are nested under the inbox block and moved to your daily page.
- **Composio tool connections** — connect Google Calendar, Gmail, Todoist, and hundreds of other apps via Composio MCP. The assistant discovers and executes tools on your behalf.
- **Scheduled jobs** — create recurring or one-shot scheduled tasks (cron expressions, intervals, or specific times) that the assistant runs automatically. Multi-tab safe via leader election.
- **Three model tiers** — append `/power` for a more capable model (Claude Sonnet / GPT-4.1 / Gemini Flash / Mistral Medium), or `/ludicrous` for the most capable tier (Claude Opus / GPT-5.2 / Mistral Large). The assistant auto-escalates to power tier for complex multi-source requests.
- **Dry-run mode** — simulate any mutating operation before it executes. Useful for reviewing what the agent would do before committing.
- **Guided onboarding** — first-run onboarding walks you through API key setup, memory page bootstrapping, and chat panel introduction.

---

## Requirements

| Requirement | Notes |
|---|---|
| At least one LLM API key (Anthropic, OpenAI, Gemini, or Mistral) | Direct browser fetch — incurs API costs at your provider's rates |
| Composio account + MCP URL | Only required for external tool integrations. Graph and task features work without it. |
| [Better Tasks / Recurring Tasks](https://github.com/mlava/recurring-tasks) extension | Only required for Better Tasks integration. Plain TODO search works without it. |

---

## Setup

### 1. Configure your LLM

Open **Settings > Chief of Staff** and fill in:

- **Your Name** — how Chief of Staff addresses you
- **Assistant Name** — display-only label used in chat header and toasts (default: `Chief of Staff`)
- **LLM Provider** — `anthropic` (default), `openai`, `gemini`, or `mistral`
- **API Keys** — separate fields for each provider. Only the key for your selected provider is required; configure additional keys to enable automatic failover.
  - Anthropic API Key (`sk-ant-...`)
  - OpenAI API Key (`sk-...`) — also required for voice dictation (Whisper)
  - Google Gemini API Key (`AIza...`)
  - Mistral API Key
- **LLM Model** — leave blank to use the default for your provider, or enter any model ID supported by that provider
- **Debug Logging** — enable verbose console output for troubleshooting
- **Dry Run** — one-shot toggle that simulates the next mutating tool call without writing anything (auto-disables after one use)
- **Ludicrous mode failover** — allow escalation to the most expensive models (Opus / GPT-5.2) when all power-tier providers fail

Default models by tier:

| Tier | Anthropic | OpenAI | Gemini | Mistral |
|---|---|---|---|---|
| Mini (default) | claude-haiku-4-5 | gpt-5-mini | gemini-2.5-flash-lite | mistral-small |
| Power (`/power`) | claude-sonnet-4-6 | gpt-4.1 | gemini-2.5-flash | mistral-medium |
| Ludicrous (`/ludicrous`) | claude-opus-4-6 | gpt-5.2 | — | mistral-large |

> **Security note:** API keys are stored in Roam Depot's settings store (browser IndexedDB). They are never transmitted except directly to the LLM provider's API endpoint (via Roam's built-in CORS proxy when available). Do not use shared or public Roam graphs if you store API keys here.

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
2. In **Settings > Chief of Staff**, set **Composio MCP URL** to your proxy URL with the real Composio endpoint appended as the path:
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
| **Chief of Staff: Ask** | Opens a prompt dialogue. The assistant reasons over your question using LLM + available tools. |
| **Chief of Staff: Toggle Chat Panel** | Shows or hides the floating chat panel. |
| **Chief of Staff: Run Onboarding** | Launches the guided onboarding flow (API key setup, memory bootstrapping, chat panel intro). |
| **Chief of Staff: Bootstrap Memory Pages** | Creates memory pages (if missing) with starter content. |
| **Chief of Staff: Bootstrap Skills Page** | Creates `Chief of Staff/Skills` with starter skills (if missing). |
| **Chief of Staff: Show Memory Snapshot** | Logs currently loaded memory content to the browser console. |
| **Chief of Staff: Show Skills Snapshot** | Logs loaded skills and injected skill index to the browser console. |
| **Chief of Staff: Refresh Skills Cache** | Reloads skills from the graph after page edits. |
| **Chief of Staff: Connect Composio** | Connects the MCP client to your Composio endpoint. |
| **Chief of Staff: Disconnect Composio** | Closes the active Composio connection. |
| **Chief of Staff: Reconnect Composio** | Disconnects and reconnects (useful after credential changes). |
| **Chief of Staff: Install Composio Tool** | Prompts for a tool slug and starts the installation + authentication flow. |
| **Chief of Staff: Deregister Composio Tool** | Removes a connected tool from Composio and from local state. |
| **Chief of Staff: Test Composio Tool Connection** | Checks whether a specific tool is currently reachable via Composio. |
| **Chief of Staff: Refresh Tool Auth Status** | Re-checks any tools waiting for OAuth completion. |
| **Chief of Staff: Discover Toolkit Schemas** | Discovers and caches schemas for all connected Composio toolkits. |
| **Chief of Staff: Show Schema Registry** | Logs the discovered toolkit schema registry to the browser console. |
| **Chief of Staff: Clear Conversation Context** | Resets conversation memory and chat history. |
| **Chief of Staff: Show Stored Tool Config** | Logs the current tool configuration to the browser console. |
| **Chief of Staff: Show Last Run Trace** | Logs the most recent agent run (iterations, tool calls, timing) to the browser console. |
| **Chief of Staff: Debug Runtime Stats** | Logs current runtime state (cache sizes, connection status, conversation turns) to the browser console. |
| **Chief of Staff: Reset Token Usage Stats** | Resets the session token usage counters and cost display. |
| **Chief of Staff: Show Scheduled Jobs** | Logs all scheduled cron jobs and their status to the browser console. |

---

## Chat panel

The floating chat panel (bottom-right corner by default) provides a persistent conversational interface. It is draggable, resizable, and remembers history across sessions (up to 80 messages). Use it for follow-up questions without re-opening the command palette.

- **Enter** to send, **Shift+Enter** for a new line.
- **Arrow Up / Down** to cycle through previous messages (like a terminal).
- Suffix a message with `/power` or `/ludicrous` to use a more capable model for that request.
- The **Clear** button resets conversation history.
- A **session cost indicator** in the header shows cumulative API spend for the current session.
- Each assistant response has a small pin icon at its bottom right. Click it to append the response to your daily note page.
- **[[Page references]]** and **((block references))** in responses are clickable — click to navigate, Shift-click to open in the sidebar.
- Streaming responses render incrementally as the model generates text.

The panel suppresses non-essential toasts while open, and persists conversation history and position across reloads.

---

## Task integration

Chief of Staff recognises natural language task queries and routes them to dedicated handlers — no LLM call required for common patterns:

- *"Find my better tasks due this week"*
- *"Show overdue tasks for Planning Committee"*
- *"Create a better task to review the budget due next Friday"*
- *"List my top 10 TODO tasks"*

If the Better Tasks extension is installed, all task queries use Better Tasks attributes (`BT_attrDue`, `BT_attrProject`, etc.). Otherwise, plain `{{[[TODO]]}}` / `{{[[DONE]]}}` blocks are searched.

### Better Tasks attributes recognised

`BT_attrProject` · `BT_attrDue` · `BT_attrStart` · `BT_attrDefer` · `BT_attrRepeat` · `BT_attrGTD` · `BT_attrWaitingFor` · `BT_attrContext` · `BT_attrPriority` · `BT_attrEnergy`

Custom attribute aliases configured in the Better Tasks extension are respected automatically.

---

## Memory and learning

Chief of Staff automatically loads memory content on each LLM run (no tool call required).

Pages used (when Better Tasks is installed):
- `Chief of Staff/Memory`
- `Chief of Staff/Inbox`
- `Chief of Staff/Decisions`
- `Chief of Staff/Lessons Learned`
- `Chief of Staff/Improvement Requests`

Without Better Tasks, `Chief of Staff/Projects` is also loaded (Better Tasks provides its own project data via dedicated tools).

Memory content is capped at 3,000 characters per page and 8,000 characters total. Pages are monitored via live pull watches — edits are reflected within a few seconds without needing to restart the extension.

You can save memory explicitly in chat (for example: "remember this...", "note this idea...", "save this lesson..."), or via the native `cos_update_memory` tool path.

---

## Inbox

`Chief of Staff/Inbox` doubles as an input channel. Drop a block into the inbox page and the assistant will automatically process it in **read-only mode** — it can search, read, and gather information from your graph and connected tools, but it cannot create, update, move, or delete any blocks or send emails. The response is nested under the original inbox block, which is then moved to today's daily page under a "Processed Chief of Staff items" heading.

This is useful for quick captures — jot down a question or instruction as a block under `Chief of Staff/Inbox` and let the assistant process it in the background.

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

Skills are reloaded automatically when you edit the page (via a live pull watch). The prompt receives a compact skill index (all skill names + short summaries), while full skill bodies are used on explicit invocation.

When a skill lists **Sources**, a gathering completeness guard ensures the assistant calls all required data tools before writing output — preventing incomplete or hallucinated summaries.

Skills that produce daily-page content (e.g. Daily Briefing) can be configured to write structured output directly to today's daily note page.

---

## Scheduled jobs

The assistant can create recurring or one-shot scheduled jobs that run automatically in the background. Ask naturally — for example:

- *"Run my Daily Briefing skill every morning at 8am"*
- *"Remind me to check my inbox every 30 minutes"*
- *"At 5pm today, summarise what I worked on"*

The assistant uses `cos_cron_create`, `cos_cron_list`, `cos_cron_update`, and `cos_cron_delete` tools to manage jobs. Supported types:

| Type | Schedule format | Example |
|---|---|---|
| `cron` | 5-field cron expression + timezone | `0 8 * * *` (daily at 8am) |
| `interval` | Every N minutes | `30` (every 30 minutes) |
| `once` | Specific timestamp | One-shot, auto-disables after execution |

Jobs are stored in extension settings and persist across reloads. If you have multiple Roam tabs open, only one tab executes scheduled jobs (via automatic leader election with heartbeat and cross-tab detection) to prevent duplicates.

Run **Chief of Staff: Show Scheduled Jobs** from the command palette to inspect current jobs in the browser console.

---

## Safety and data

- **Approval gating** — every mutating operation (creating, modifying, or deleting blocks; sending emails; creating calendar events) requires explicit approval via a confirmation prompt before it executes. Approvals are remembered for 15 minutes per tool to reduce prompt fatigue.
- **Dry-run mode** — enabling *Dry Run* in settings simulates the next mutating call without writing anything. The toggle disables itself after one use.
- **Read-only inbox mode** — inbox-triggered processing runs in read-only mode. The assistant's tool set is restricted to an explicit allowlist of read-only tools, enforced both at the tool-filter layer (the LLM never sees mutating tools) and at the dispatch layer (defence-in-depth guard).
- **Read-only tools are auto-approved** — searches, lookups, and list operations do not require confirmation.
- **Hallucination guard** — if the assistant claims to have performed an action but no tool call actually succeeded, the claim is intercepted and the assistant is asked to retry with a real tool call.
- **Tool-first live data guard** — for requests about recent emails, calendar, schedule, or connections, the assistant refuses to guess if no external tool call succeeded.
- **Input sanitisation** — all user-facing HTML rendering uses `escapeHtml`. Datalog queries use `escapeForDatalog`. Markdown link hrefs are sanitised to block `javascript:`, `data:`, and `vbscript:` schemes.
- **Streaming timeouts** — LLM requests have a 90-second connect timeout, 60-second per-chunk timeout, and 5-minute total stream cap to prevent runaway requests.
- **Multi-provider failover** — if your primary LLM provider returns a rate-limit or server error, the assistant automatically retries with the next provider in the failover chain, carrying accumulated context forward to avoid lost work.
- **Write safety** — block text is capped at 20,000 characters. Batch block creation is capped at 50 nodes per call. Block tree recursion is capped at 30 levels. Target UIDs are validated before writes to prevent hallucinated UIDs from placing content in the wrong location.

---

## Limitations and performance considerations

- **Graph scans** — task search queries scan all blocks in your graph that match TODO/DONE patterns. Performance scales with graph size. On very large graphs (100k+ blocks) this may take a second or two.
- **Agent iterations** — the reasoning loop is capped at 10 iterations per request to prevent runaway API usage.
- **Conversation context** — the assistant retains up to 12 recent turns (truncated to 500 characters each) for follow-up context. Older turns are dropped automatically. Within a single agent run, tool result payloads are progressively trimmed if the message budget (50,000 characters) is exceeded.
- **Composio dependency** — external tool features (Gmail, Google Calendar, Todoist, etc.) require an active Composio connection. Roam graph and task features work fully without Composio.
- **LLM API costs** — requests are sent directly from your browser to your configured provider. Costs are billed to your API account. Structured briefings, multi-tool agent runs, and scheduled jobs consume more tokens than simple queries. The chat panel shows a running session cost estimate.
- **Scheduled job execution** — scheduled jobs require at least one Roam tab to be open. If all tabs are closed, jobs will not fire until a tab is reopened. Only one tab executes jobs at a time (automatic leader election).
- **Model support** — any model ID accepted by the configured provider can be used. Non-tool-use models will not function correctly with the agent loop.
