# Chief of Staff

An AI assistant embedded in Roam Research. Chief of Staff connects your Roam graph to large language models (Anthropic, OpenAI, Google Gemini, or Mistral) and to external tools via [Composio](https://composio.dev), letting you ask questions, search and manage tasks, and orchestrate actions across your connected apps — all without leaving Roam.

---

## What it does

- **Ask anything** via the command palette or a persistent floating chat panel. The assistant can read your graph, create blocks, and call external tools — with your approval before any write operation. Common queries (task searches, memory saves, tool lists) are handled instantly without an LLM call.
- **Multi-provider LLM support** — choose from Anthropic Claude, OpenAI GPT, Google Gemini, or Mistral as your primary provider. If one provider is unavailable, the assistant automatically fails over to the next available provider in the chain.
- **Better Tasks integration** — search, create, and modify Better Tasks (TODO/DONE parent blocks with `BT_attr*` attribute children) directly from natural language. Supports filtering by due date, project, status, and free text.
- **Persistent memory** — loads context from dedicated memory pages into the system prompt each run (see [Memory and learning](#memory-and-learning)).
- **Skill routing** — reads `Chief of Staff/Skills`, injects a compact skill index into the prompt, and can apply a specific skill on request. A gathering completeness guard ensures the assistant calls all required data sources before writing.
- **Inbox as input channel** — drop blocks into `Chief of Staff/Inbox` and they are automatically processed in read-only mode (the assistant can search and read but cannot mutate your graph). Responses are nested under the inbox block and moved to your daily page.
- **Composio tool connections** — connect Google Calendar, Gmail, Todoist, and hundreds of other apps via Composio MCP. The assistant discovers and executes tools on your behalf.
- **Local MCP server integration** — connect to MCP servers running on your machine (e.g. Zotero, GitHub, custom tools). Servers with many tools use a two-stage routing system to keep token costs low. Connections retry automatically on failure.
- **Scheduled jobs** — create recurring or one-shot scheduled tasks (cron expressions, intervals, or specific times) that the assistant runs automatically. Multi-tab safe via leader election.
- **Self-healing tool calls** — if the LLM claims to have done something without actually doing it, the extension detects the hallucination, retries with the correct tool, and auto-escalates to a smarter model if needed. No user intervention required.
- **Three model tiers with automatic routing** — most requests use a fast, cheap model. Append `/power` or `/ludicrous` to your message to force a more capable tier, or let the extension auto-escalate based on request complexity. See [How tiers work](#how-tiers-work) for details.
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
| Mini (default) | claude-haiku-4-5 | gpt-5-mini | gemini-2.5-flash | mistral-small |
| Power (`/power`) | claude-sonnet-4-6 | gpt-4.1 | gemini-3-flash-preview | mistral-medium |
| Ludicrous (`/ludicrous`) | claude-opus-4-6 | gpt-5.2 | gemini-3.1-pro-preview-customtools | mistral-large |

#### How tiers work

By default, requests go to the **mini** tier — fast and cheap. You can force a higher tier by appending `/power` or `/ludicrous` to your message in the chat panel (e.g. "summarise my week /power"). The suffix is stripped before the message reaches the LLM.

Most of the time, you don't need to think about tiers. A composite scoring system evaluates each request across three dimensions — tool count requirements (40% weight), prompt complexity (35%), and conversation trajectory (25%) — and automatically escalates to the power tier when the score exceeds 0.45. Requests involving routed MCP servers (those with more than 15 tools) are always escalated to power regardless of score. Trivial follow-ups ("thanks", "ok") stay on mini even after complex sessions.

#### Automatic failover

If your primary provider is unavailable or returns an error, the assistant automatically tries the next available provider in the chain. Each failed provider enters a 60-second cooldown before being retried. If all power-tier providers fail and you have **Ludicrous mode failover** enabled in settings, the assistant escalates to the most capable (and most expensive) models as a last resort. This means configuring API keys for multiple providers gives you resilience — the assistant keeps working even if one provider has an outage.

> **Security note:** API keys are stored in Roam Depot's settings store (browser IndexedDB). They are never transmitted except directly to the LLM provider's API endpoint (via Roam's built-in CORS proxy when available). Do not use shared or public Roam graphs if you store API keys here.

### 2. Connect Composio (optional)

Composio lets the assistant call external APIs (Gmail, Google Calendar, Todoist, etc.) via MCP. **Skip this section entirely if you only need graph and task features** — everything in the sections above works without Composio.

If you do want external tool integrations, here is the dependency chain:

> **You want external tools** (Gmail, Calendar, Todoist, …)
> → you need a **Composio account** (free tier available at [composio.dev](https://composio.dev))
> → Composio's MCP endpoint requires a **CORS proxy** (because Roam runs in the browser)
> → the proxy runs on **Cloudflare Workers** (free tier, one-click deploy below)

In short: Cloudflare account → deploy proxy → Composio account → configure extension → connect tools. Each step is covered below.

#### 2a. Deploy a CORS proxy

Roam runs in the browser, so cross-origin requests to Composio's MCP endpoint are blocked by default. You need a small Cloudflare Worker that adds CORS headers. A ready-to-deploy worker lives in a separate repo: [`roam-mcp-proxy`](https://github.com/mlava/roam-mcp-proxy). It only accepts requests originating from `roamresearch.com` by default.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mlava/roam-mcp-proxy)

Or deploy manually:

```bash
git clone https://github.com/mlava/roam-mcp-proxy.git
cd roam-mcp-proxy
npm install
npx wrangler login   # one-time Cloudflare auth
npx wrangler deploy
```

Wrangler will print your worker URL (e.g. `https://roam-mcp-proxy.<you>.workers.dev`). See the [roam-mcp-proxy README](https://github.com/mlava/roam-mcp-proxy#readme) for full details and optional security hardening.

#### 2b. Configure the extension

1. Create a [Composio](https://composio.dev) account and copy your **MCP URL** and **API key** from the Composio dashboard.
2. In **Settings > Chief of Staff**, set **Composio MCP URL** to your proxy URL with the real Composio endpoint appended as the path:
   ```
   https://roam-mcp-proxy.<you>.workers.dev/https://mcp.composio.dev/<your-endpoint>
   ```
3. Enter your **Composio API Key** in the same settings panel.
4. Run **Chief of Staff: Connect Composio** from the command palette.
5. Run **Chief of Staff: Install Composio Tool** and enter a tool slug (e.g. `GOOGLECALENDAR`, `GMAIL`, `TODOIST`). You will be redirected to complete OAuth authentication in a new tab.

### 3. Connect local MCP servers (optional)

Local MCP servers let the assistant interact with tools running on your machine — for example, a Zotero research library, a local GitHub MCP server, or custom tools.

1. Run an MCP server locally that exposes an SSE endpoint (e.g. via [supergateway](https://github.com/nicobailey/supergateway)).
2. In **Settings > Chief of Staff**, under **Local MCP**, add the port number and optionally a display name for each server. Up to four servers can be configured.
3. The extension auto-connects on load. Servers with ≤15 tools are registered directly (one-step calls). Servers with >15 tools use two-stage routing (`LOCAL_MCP_ROUTE` to discover, `LOCAL_MCP_EXECUTE` to call) to keep per-request token costs low.
4. Connection status is logged to the browser console on startup. Failed connections retry automatically.

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
- `/clear` resets conversation history and context (same as the Clear button).
- Suffix a message with `/power` or `/ludicrous` to use a more capable model for that request.
- A **session cost indicator** in the header shows cumulative API spend for the current session.
- Each assistant response has a small pin icon at its bottom right. Click it to append the response to your daily note page.
- **[[Page references]]** and **((block references))** in responses are clickable — click to navigate, Shift-click to open in the sidebar.
- Streaming responses render incrementally as the model generates text.

The panel suppresses non-essential toasts while open, and persists conversation history and position across reloads.

### Theme responsiveness

The chat panel automatically detects and adapts to your Roam theme — including Roam Studio custom themes and Blueprint dark mode. Three detection strategies work in concert: CSS class markers (`.bp3-dark`), the `prefers-color-scheme` system preference, and real-time luminance sampling of rendered background colours. This means custom Roam Studio themes that don't set standard dark-mode markers are still detected correctly.

Theme transitions are handled gracefully: a hold-last-state guard prevents flicker during animated CSS transitions (common with Roam Studio themes), and a triple-pass verification re-sample ensures the panel settles on the correct theme even for slow multi-second transitions. All UI elements — buttons, inputs, borders, code blocks, and tool previews — use CSS custom properties that update in real time when the theme changes.

---

## Task integration

Chief of Staff recognises natural language task queries and routes them to dedicated handlers — no LLM call required for common patterns:

- *"Find my better tasks due this week"*
- *"Show overdue tasks for Planning Committee"*
- *"Create a better task to review the budget due next Friday"*
- *"List my top 10 TODO tasks"*
- *"What's overdue?"*

These queries are handled by a fast deterministic router that matches intent patterns and calls the right Roam queries directly — no LLM round-trip, so they are near-instant and cost nothing.

### With Better Tasks installed

If the [Better Tasks / Recurring Tasks](https://github.com/mlava/recurring-tasks) extension is installed, task queries use Better Tasks attributes (`BT_attrDue`, `BT_attrProject`, etc.) and support filtering by due date, project, status, priority, energy, GTD context, and free text. You can create new Better Tasks from natural language ("create a better task to review the budget due next Friday for the Planning Committee project"), and the assistant will set the appropriate attributes.

**Attributes recognised:** `BT_attrProject` · `BT_attrDue` · `BT_attrStart` · `BT_attrDefer` · `BT_attrRepeat` · `BT_attrGTD` · `BT_attrWaitingFor` · `BT_attrContext` · `BT_attrPriority` · `BT_attrEnergy`

Custom attribute aliases configured in the Better Tasks extension are respected automatically. The assistant also loads project data from Better Tasks directly, so you don't need a separate `Chief of Staff/Projects` page.

### Without Better Tasks

Plain `{{[[TODO]]}}` / `{{[[DONE]]}}` block searches still work. Task queries find TODO and DONE markers across your graph and return matching blocks. You won't have access to attribute-based filtering (due dates, projects, etc.), but basic task listing and searching is fully functional. In this mode, `Chief of Staff/Projects` is also loaded into memory to give the assistant project context.

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

### Memory protection

Because memory content is loaded into every system prompt, it is a high-value target for prompt injection — if someone could sneak a malicious instruction into your memory pages, it would influence every future assistant response. To prevent this, all memory writes are scanned against 28 pattern categories (covering directive language, approval bypass attempts, hidden instruction embedding, data exfiltration, and tool manipulation). Flagged content is blocked before the write occurs, and the assistant receives an error with guidance to reformulate. This works in concert with the approval gate — even if the scan were somehow evaded, you still confirm every memory write via a toast notification before it executes.

---

## Inbox

`Chief of Staff/Inbox` doubles as an input channel. Drop a block into the inbox page and the assistant will automatically process it in **read-only mode** — it can search, read, and gather information from your graph and connected tools, but it cannot create, update, move, or delete any blocks or send emails. The response is nested under the original inbox block, which is then moved to today's daily page under a "Processed Chief of Staff items" heading.

This is useful for quick captures — jot down a question or instruction as a block under `Chief of Staff/Inbox` and let the assistant process it in the background.

---

## Skills

Skills are custom instructions that teach the assistant how to perform specific workflows. They live on the `Chief of Staff/Skills` page in your graph and are automatically available to the assistant.

### Page structure

Each skill is a top-level block (the skill name) with child blocks (the instructions). Keep skill names short and descriptive — they appear in a compact index in every system prompt, so the assistant always knows what skills are available.

```text
- Weekly Review
  - Objective: Conduct a weekly review for the past 7 days.
  - Sources: Chief of Staff/Projects, Chief of Staff/Decisions, Better Tasks.
  - Output: Top priorities, overdue items, next-week plan.
  - Write output to today's daily page under a "Weekly Review" heading.
```

```text
- Daily Briefing
  - Objective: Summarise today's calendar, overdue tasks, and recent decisions.
  - Sources: Google Calendar (today), Better Tasks (overdue + due today), Chief of Staff/Decisions.
  - Output: A concise briefing with calendar, tasks, and decision sections.
  - Write output to today's daily page.
```

```text
- Meeting Prep
  - Objective: Prepare a briefing for an upcoming meeting.
  - Input: The user will specify which meeting.
  - Sources: Google Calendar (meeting details + attendees), Better Tasks (related project tasks).
  - Output: Agenda summary, attendee context, relevant open tasks, and suggested talking points.
```

### How skills work

Skills are reloaded automatically when you edit the page (via a live pull watch). The prompt receives a compact skill index (all skill names + first-line summaries), while the full skill body is loaded only when you invoke a specific skill. You can invoke a skill by name: "run my Weekly Review" or "do a Daily Briefing".

When a skill lists **Sources**, a gathering completeness guard ensures the assistant calls all required data tools before writing output. For example, if your Weekly Review lists "Better Tasks" as a source, the assistant must query Better Tasks before generating the review — it cannot skip the query and hallucinate task data.

### Tips

- Keep individual skill instructions under about 2,000 characters. The assistant has limited context space, and overly long skills crowd out other context.
- Use **cross-references** to other Chief of Staff pages (e.g. "Sources: Chief of Staff/Decisions") to ground the assistant in your real data.
- Skills that say "Write output to today's daily page" will produce structured output on your daily note page — useful for briefings and reviews you want to see in your daily workflow.
- You can reference Composio tools by name in sources (e.g. "Google Calendar", "Gmail") and the assistant will call them during skill execution.

---

## Scheduled jobs

The assistant can create recurring or one-shot scheduled jobs that run automatically in the background. Ask naturally — for example:

- *"Run my Daily Briefing skill every morning at 8am"*
- *"Remind me to check my inbox every 30 minutes"*
- *"At 5pm today, summarise what I worked on"*

Supported schedule types:

| Type | Schedule format | Example |
|---|---|---|
| `cron` | 5-field cron expression + timezone | `0 8 * * *` (daily at 8am) |
| `interval` | Every N minutes (minimum 5) | `30` (every 30 minutes) |
| `once` | Specific timestamp | One-shot, auto-disables after execution |

Jobs are stored in extension settings and persist across reloads. If you have multiple Roam tabs open, only one tab executes scheduled jobs (via automatic leader election with heartbeat and cross-tab detection) to prevent duplicates.

Run **Chief of Staff: Show Scheduled Jobs** from the command palette to inspect current jobs in the browser console.

---

## Security

Chief of Staff is an AI agent with broad access to your Roam graph and, optionally, to external services like Gmail and Google Calendar. That access demands careful safety engineering. The extension has been through a structured security audit against the [Doneyli 5-Phase AI Agent Security Audit Framework](https://doneyli.com), cross-referenced with the OWASP Top 10 for LLM Applications and MITRE ATLAS, and calibrated for its actual threat model: a single-user browser extension with no server-side state, no multi-tenancy, and no filesystem access.

The full audit report is available in [`SECURITY-AUDIT.md`](SECURITY-AUDIT.md).

### What the extension does to protect your data

**Human-in-the-loop by default.** Every mutating operation — creating, modifying, or deleting blocks; sending emails; creating calendar events — requires explicit approval via a confirmation toast before it executes. Approvals are scoped per request: each new prompt starts with a clean slate, so approvals granted during one request never carry over to the next. Within a single agent run, the first write to a given page requires confirmation and subsequent writes to the same page are auto-approved to reduce prompt fatigue. A separate approval is required for each new page. Rate limits cap tool calls at 4 per LLM response and 5 per tool per agent run, preventing runaway loops.

**Read-only inbox processing.** Blocks dropped into `Chief of Staff/Inbox` are processed with a restricted tool allowlist. The assistant can search, read, and gather information, but cannot create, update, move, or delete anything. This is enforced at both the tool-filter layer (the LLM never sees mutating tools) and the dispatch layer (defence-in-depth guard).

**Prompt injection defence.** Content from external sources (emails, calendar events, MCP tool results, memory pages, Composio responses) is wrapped in `<untrusted>` boundary tags with explicit instructions to the LLM to treat it as data, not instructions. A semantic injection scanner checks all untrusted content against 14 pattern categories (instruction overrides, role assumption, authority claims, output manipulation, tool coercion) and annotates flagged content with an in-context warning. Provider-specific boundary tags are neutralised before content enters the prompt, preventing delimiter breakout attacks.

**Memory poisoning defence.** Because memory content is loaded into every system prompt, it is a high-value target for persistent injection. All memory writes are scanned against 28 pattern categories (14 general injection + 14 memory-specific, covering directive language, approval bypass, hidden instruction embedding, data exfiltration, and tool manipulation). Flagged content is blocked before the write occurs, and the LLM receives an error with guidance to reformulate. This works in concert with the approval gate — even if the patterns were evaded, the user still confirms every memory write.

**System prompt confidentiality.** The system prompt contains detailed architectural information. A confidentiality directive instructs the LLM to decline extraction attempts regardless of framing. An output-side guard scans every response against 38 distinctive fingerprint phrases; if three or more match, the response is replaced with a safe refusal.

**PII scrubbing.** An opt-in layer (enabled by default) intercepts all outbound LLM API calls and redacts email addresses, phone numbers, SSNs, credit card numbers (Luhn-validated), IBANs, Medicare numbers, TFNs, and public IP addresses before content leaves the browser. This can be toggled off in settings if your workflow requires full fidelity.

**Three-layer claimed-action mitigation.** Some models (especially smaller/faster tiers) occasionally generate text claiming an action was performed without actually issuing a tool call. Chief of Staff detects and recovers from this automatically via three layers working in concert. *Layer 1 — Detection + retry nudge:* a pattern-matching guard (`detectClaimedActionWithoutToolCall`) checks every assistant response against static action-claim patterns, tool-specific claim patterns (e.g. Focus Mode state, OCR results, definitions), and dynamic patterns built from the names of all currently registered tools. On detection, the assistant is given a targeted retry message naming the specific tool it should call, and recovers on the next attempt. *Layer 2 — Context hygiene:* if the model hallucinated in a prior turn, those poisoned conversation entries are sanitised before the next LLM call, breaking the feedback loop that would otherwise teach the model to repeat text-only responses. *Layer 3 — Tier escalation:* if the same session sees repeated hallucinations on the mini tier, the extension automatically escalates to the power tier (e.g. gemini-2.5-flash-lite → gemini-2.5-flash), which succeeds immediately. A separate fabrication guard detects long responses about external data produced without any tool call, forcing a retry with real results. A key validation guard rejects display names and path-style values in parameters that expect identifiers, catching a common LLM mistake before it wastes an API round-trip.

**Credential handling.** API keys are stored in Roam Depot's settings store (browser IndexedDB) and transmitted only to their respective provider endpoints over HTTPS. All application-level console output is processed through a credential redaction layer that masks API key patterns, bearer tokens, and header values. Keys are never logged in cleartext.

**CORS proxy hardening.** The included Cloudflare Worker proxy accepts requests only from `roamresearch.com`, forwards only to an allowlisted set of upstream hosts, enforces HTTPS for remote targets, blocks upstream redirects (SSRF defence), filters request headers to an explicit allowlist, and uses validated CORS header echo rather than wildcards. 85 security tests cover the proxy's validation logic.

**XSS prevention.** All user-facing HTML rendering uses escape-then-reinsert with nonce placeholders. A post-processing DOM sanitiser strips dangerous elements and event handler attributes after every `innerHTML` assignment. Markdown link hrefs are sanitised to block `javascript:`, `data:`, and `vbscript:` schemes.

### What data leaves your browser

All LLM processing happens via direct API calls from your browser to your configured provider. There is no intermediate server, no telemetry, and no analytics. Here is what gets sent in each mode:

**Chat (command palette or hotkey).** Your message, the system prompt, up to 12 recent conversation turns (truncated), any memory pages (capped at 3,000 chars each), and the results of any tool calls the assistant makes during the run. If PII scrubbing is enabled (it is by default), personal identifiers are redacted before the request leaves the browser.

**Inbox processing.** The content of the inbox block, the system prompt, and any read-only tool results gathered during processing. The same PII scrubbing applies.

**Scheduled jobs (cron).** The job's prompt, the system prompt, and any tool results. Identical data path to chat — jobs are just chat requests triggered by a timer instead of a keystroke.

**Composio tools (Gmail, Calendar, Todoist, etc.).** When you use an external service, the assistant's tool call payload (e.g. an email search query or a calendar event body) is sent to Composio's MCP endpoint via the included CORS proxy. The proxy forwards only to allowlisted hosts and adds no tracking. Your Composio API key authenticates the request. The proxy itself stores nothing.

**Local MCP servers.** If you connect a local MCP server (e.g. Zotero, GitHub), tool call payloads are sent to `localhost` on the port you configured. Nothing leaves your machine.

**What is never sent.** Your full graph is never transmitted. The assistant reads specific blocks via Roam's local API and includes only the relevant results in the LLM context. Your API keys are sent only to their respective provider endpoints, never to Composio or the CORS proxy.

### What the extension does not protect against

**User-approved destructive actions.** The biggest realistic risk is approving something you shouldn't. The extension shows you what it intends to do before it does it, but if you confirm a deletion or an email send, it will execute. Review approval toasts carefully, especially for unfamiliar operations. Roam's built-in undo and daily backups provide a recovery path.

**Determined adversarial content.** Pattern-based injection detection cannot catch every possible encoding of a malicious instruction. A sufficiently creative attacker who can get content into your graph (via a shared page, an imported file, or an email body) could theoretically craft a payload that evades all 28 memory injection patterns and 14 general injection patterns while still influencing the LLM's behaviour. The boundary wrapping and approval gating provide additional layers, but no detection system is perfect.

**API key security at rest.** Keys are stored in browser IndexedDB in plaintext. Any browser extension with storage access, or anyone with physical access to your machine, could read them. Do not use Chief of Staff on shared or public computers, and do not install untrusted browser extensions alongside it.

### Dry-run mode

If you want to see what the assistant would do before it does anything, enable **Dry Run** in settings. The next mutating operation will be simulated without executing. The toggle disables itself after one use.

### Reporting security issues

If you discover a security issue, please report it directly rather than filing a public issue. Contact details are in the extension's Roam Depot listing.

---

## Limitations and performance considerations

- **Graph scans** — task search queries scan all blocks in your graph that match TODO/DONE patterns. Performance scales with graph size. On very large graphs (100k+ blocks) this may take a second or two.
- **Agent iterations** — the reasoning loop is capped at 10 iterations per request to prevent runaway API usage.
- **Conversation context** — the assistant retains up to 12 recent turns (truncated to 500 user / 2,000 assistant characters each) for follow-up context. Older turns are dropped automatically. Within a single agent run, tool result payloads are progressively trimmed if the message budget (50,000 characters) is exceeded. Key references (identifiers from MCP tool results) are extracted and stored at the front of assistant turns to survive truncation.
- **Composio dependency** — external tool features (Gmail, Google Calendar, Todoist, etc.) require an active Composio connection. Roam graph and task features work fully without Composio.
- **LLM API costs** — requests are sent directly from your browser to your configured provider. Costs are billed to your API account. Structured briefings, multi-tool agent runs, and scheduled jobs consume more tokens than simple queries. The chat panel shows a running session cost estimate.
- **Scheduled job execution** — scheduled jobs require at least one Roam tab to be open. If all tabs are closed, jobs will not fire until a tab is reopened. Only one tab executes jobs at a time (automatic leader election).
- **Model support** — any model ID accepted by the configured provider can be used. Non-tool-use models will not function correctly with the agent loop.
