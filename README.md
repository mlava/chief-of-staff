# Chief of Staff

An AI assistant embedded in Roam Research. Chief of Staff connects your Roam graph to large language models — Anthropic, OpenAI, Google Gemini, Mistral, Groq, Grok, Kimi (Moonshot), Kimi Code, DeepSeek, Ollama (Cloud or local), or any OpenAI-compatible endpoint (LM Studio, OpenRouter, vLLM, …) — and to external tools via [Composio](https://composio.dev), letting you ask questions, search and manage tasks, and orchestrate actions across your connected apps — all without leaving Roam.

https://www.loom.com/share/9aa3c07de0f147af971d2fc54fe65e4a

---

## What it does

- **Ask anything** via the command palette or a persistent floating chat panel. The assistant can read your graph, create blocks, and call external tools — with your approval before any write operation. Common queries (task searches, memory saves, tool lists) are handled instantly without an LLM call.
- **Graph search — exact and semantic** — search uses Roam's native ranked engine: page-title matches rank above block matches, and results include page context. If your graph has **semantic search** enabled (requires embeddings enabled in Roam's settings and a signed-in user), the assistant can also search by *meaning* — "what have I written that relates to burnout?" surfaces compassion-fatigue and change-fatigue notes even when the word "burnout" never appears. Conceptual phrasing like `find my notes about racquet sports` routes to semantic search automatically; when semantic search isn't available it falls back to exact-text search and tells you so.
- **Multi-provider LLM support** — choose from Anthropic Claude, OpenAI GPT, Google Gemini, Mistral, Groq, Grok (xAI), Kimi (Moonshot), Kimi Code, DeepSeek, Ollama (Cloud or a local server), or up to three **custom OpenAI-compatible endpoints** (LM Studio, OpenRouter, vLLM, self-hosted, etc.) as your primary provider. If one provider is unavailable, the assistant automatically fails over to the next available provider in the chain. Custom local slots support a privacy mode that disables fallback to cloud providers — failed requests surface as errors instead of silently routing to a remote API.
- **Better Tasks integration** — search, create, and modify Better Tasks (TODO/DONE parent blocks with `BT_attr*` attribute children) directly from natural language. Supports filtering by due date, project, status, and free text.
- **Timed blocks** — one window on a daily page, written as `HH:MM - HH:MM (**N'**) ((uid))`. This is not a cron job; those stay under [Scheduled jobs](#scheduled-jobs). A JS executor owns clocks (`from 9 to 10pm`, `2 hours from 9pm`), today/tomorrow, overlap-on-request, move-by-title, unschedule-by-title (slot only, not the TODO), multi-window "and", and the `((uid))` placeholder, so Kimi, DeepSeek, Ollama, Grok, and the rest write the same line. One new window is `cos_schedule_block`; slot lines through roam_create_block are refused. Overlaps are refused unless you say "same time", "overlap", or "during lunch", or you turn on **Allow overlapping timed blocks**. Add / book / timebox work as well as "schedule". A full-day rewrite still runs as a skill, if the graph has one.
- **Persistent memory** — loads context from dedicated memory pages into the system prompt each run (see [Memory and learning](#memory-and-learning)).
- **Skill routing** — reads `Chief of Staff/Skills`, injects a compact skill index into the prompt, and can apply a specific skill on request. A gathering completeness guard ensures the assistant calls all required data sources before writing. Skills can declare **pre-flight acceptance criteria** (an `Acceptance:` field) — binding pass/fail conditions injected into the system prompt before the skill runs, so the model knows exactly what its output must satisfy. Same criteria are also passed to the post-run eval-judge.
- **Skill & cron staleness detection** — track when each skill and scheduled job was last reviewed via a `Last reviewed::` attribute. A configurable threshold (default 30 days) triggers a once-per-day startup warning toast when items drift past it, and `cos_review_skill` / `cos_review_cron` tools mark items as current. Ask "stale skills" or "staleness report" any time. Prevents the silent process calcification problem where automations keep running long after the underlying workflow has changed.
- **Inbox as input channel** — drop blocks into `Chief of Staff/Inbox` and they are automatically processed in read-only mode (the assistant can search and read but cannot mutate your graph). Responses are nested under the inbox block and moved to your daily page. Works as a natural integration point for external automation — Make, Zapier, n8n, local agents, or any MCP-capable tool can write a pointer block to the inbox and COS will pick it up, read the linked output, and file a synthesis to your daily page.
- **Composio tool connections** — connect Google Calendar, Gmail, Todoist, and hundreds of other apps via Composio MCP. The assistant discovers and executes tools on your behalf.
- **Local MCP server integration** — connect to MCP servers running on your machine (e.g. Zotero, GitHub, custom tools). Servers with many tools use a two-stage routing system to keep token costs low. Connections retry automatically on failure.
- **Remote MCP server integration** — connect to any remote MCP server on the internet via StreamableHTTP or SSE transport. Configure up to 10 remote servers with token-based auth or automatic OAuth sign-in. Servers that implement the MCP OAuth 2.1 spec (GitHub, Notion, Linear, Sentry, Stripe, and 30+ others) can be connected with a single click — no manual token management needed. SSE connections that fail automatically fall back to StreamableHTTP. Tools are discovered at connection time and made available to the agent alongside local and Composio tools.
- **Web page fetching** — fetch any public web page and return its content as Markdown using Cloudflare's Browser Rendering API. Useful for importing articles, documentation, or reference material into your graph. Requires a Cloudflare API token (free tier available).
- **Scheduled jobs** — create recurring or one-shot scheduled tasks (cron expressions, intervals, or specific times) that the assistant runs automatically. Multi-tab safe via leader election.
- **Self-healing tool calls** — if the LLM claims to have done something without actually doing it, the extension detects the hallucination, retries with the correct tool, and auto-escalates to a smarter model if needed. No user intervention required.
- **Three model tiers with automatic routing** — most requests use a fast, cheap model. Append `/power` or `/ludicrous` to your message to force a more capable tier, or let the extension auto-escalate based on request complexity. You can also force a specific provider with `/claude`, `/gemini`, `/openai`, `/mistral`, `/groq`, `/grok`, `/kimi`, `/kimi-code`, `/deepseek`, or `/ollama`. See [How tiers work](#how-tiers-work) for details.
- **Anthropic advisor tool (beta, opt-in)** — when running on Anthropic, the cheap executor (Haiku/Sonnet) can consult Opus on hard judgment calls within a single API call without giving up control of the agent loop. The advisor returns guidance only; it never executes tools. Off by default; enable in Advanced settings. See [Anthropic advisor tool](#anthropic-advisor-tool) for details.
- **Plan-first execution** — prefix any request with `/plan` to get a preview instead of an action. The assistant explores your graph read-only and lays out the exact steps, tools, and writes it intends, then waits for your one-click approval (Run plan / Discard) before making any changes. See [Chat panel](#chat-panel).
- **Undo the assistant's last changes** — `/undo` (or just saying "undo" / "oops") reverses everything the assistant wrote in its last run: created blocks are deleted, edited blocks restored to their previous content. It shows you exactly what will be reversed before doing anything, skips blocks you've edited since, and never touches your own edits — Roam's native Ctrl/Cmd+Z covers those. See [Chat panel](#chat-panel).
- **Transparency commands** — `/why` explains how the last response was produced (model, tier, tools, guards, token cost), `/status` shows everything running autonomously (scheduled jobs, background tasks, connections, pending approvals), and `/verify` scores the last response with an independent judge model on demand. See [Chat panel](#chat-panel).
- **Dry-run mode** — simulate any mutating operation before it executes. Useful for reviewing what the agent would do before committing.
- **Linked refs filtering** — automatically removes Chief of Staff namespace pages from the linked references section of every non-COS page you visit, keeping your graph tidy. Filters are merged with your existing manual filters (never overwritten) and applied once per page per session, so manual changes are respected. Enabled by default; toggle off in Advanced settings if needed.
- **Correction capture** — opt-in background feature that detects when you edit COS outputs (briefings, pinned responses) and records the differences on `[[Chief of Staff/Corrections]]`. Corrections are cross-referenced with the Review Queue for feedback loop closure. Runs during idle time only — enable in Settings → Show Automatic Actions.
- **Correction synthesis** — opt-in weekly pass that turns repeated corrections into proposed memories. Deterministic (no LLM cost): corrections from the last 30 days are clustered, and any pattern repeated 3+ times becomes a drafted memory proposal on `[[Chief of Staff/Synthesis]]`, with block-ref evidence you can inspect. Memory entries untouched for 180+ days are also flagged for review (tag an entry `#pinned` to exempt it). Strictly propose-only — nothing is ever written to memory pages without you doing it; unchanged proposals are never re-nagged. First run is deferred one full week after enabling so you can see what it *would* do before it does anything. Needs Correction Capture for data. Enable in Settings → Show Automatic Actions.
- **Graph hygiene scans** — opt-in background scans that detect orphan pages (pages with zero incoming references) and stale links (block/page references pointing to deleted content). Results are cached in memory and logged to `[[Chief of Staff/Graph Hygiene]]`. Ask `orphan pages` or `broken links` for instant results, or use the `cos_get_orphan_pages` / `cos_get_stale_links` tools. Runs during idle time only — enable in Settings → Show Automatic Actions.
- **Post-run evaluation** — opt-in LLM-as-judge that scores each agent interaction on task completion, factual grounding, and safety (1–5 rubric) plus five deterministic binary pass/fail checks (e.g. "were all claims tool-backed?", "did the response answer the question?"). Skills can define custom `Rubric:` criteria that are evaluated alongside the standard checks. Low scores, failed checks, or failed rubric items route to `[[Chief of Staff/Review Queue]]` with exactly what failed. Enable in Settings → Show Automatic Actions.
- **Skill constraints** — skills can define structured behavioural boundaries via a `Constraints:` field with four quadrants: Must Do (non-negotiable requirements), Must Not Do (hard prohibitions), Prefer (soft guidance), and Escalate (stop and ask the user). Injected as binding system instructions for each skill run.
- **LLM Council** — multi-model review panel that stress-tests a question through independent analysis, anonymous peer critique with robustness scores, and a chair's decisive synthesis. Results written to `[[LLM Council]]` page with cost breakdown. Ask "council: should I use X or Y?" or use the `cos_llm_council` tool.
- **Health check / doctor** — self-diagnostic that validates API keys, MCP server connections, memory page integrity, skill definitions, cron job health, Composio auth, and Extension Tools discovery. Returns a structured pass/warn/fail report with fix suggestions. Type `/doctor` in the chat panel, say "health check", or use `cos_doctor`.
- **Budget warning toasts** — automatic notifications when daily API spend reaches 50%, 80%, and 100% of your configured cap. Fires once per threshold per day.
- **Guided onboarding** — first-run onboarding walks you through API key setup, memory page bootstrapping, and chat panel introduction.

---

## How your data is handled

Chief of Staff runs entirely inside your Roam browser tab — there's no server, no external API endpoint, and nothing outside your browser can reach your graph through it.

**Nothing happens unless you trigger it.** Every LLM call, every tool invocation, every piece of data that leaves your browser starts because you typed a message, ran a command, or invoked a skill. The only exception is if you explicitly set up one of three optional automation features (cron jobs, inbox processing, or idle tasks) — and even those only do what you've configured them to do.

Here's what crosses the network when something does run:

**LLM calls** — Your prompt and supporting context are sent to whichever LLM provider you've configured (Anthropic, OpenAI, Google, Mistral, Groq, Grok, Kimi (Moonshot), Kimi Code, DeepSeek, Ollama, or a custom OpenAI-compatible endpoint of your choice). The context sent alongside your message includes conversation history (up to 12 prior turns), your COS memory pages, active project list, any active skill instructions, and tool results gathered during the current run (e.g. Roam search results, calendar events). Anthropic calls go direct from your browser; other built-in providers route through Roam's built-in CORS proxy. Custom slots pointing at `localhost` go direct (browser secure-context exception); custom slots pointing at remote URLs go direct by default and can opt into the proxy. An optional PII scrubbing setting can strip emails, phone numbers, and other sensitive patterns before anything is sent.

**Composio integrations** — If you optionally connect external services (Gmail, Calendar, GitHub, etc.) through Composio, those tool calls go through Composio's API via a CORS proxy. Entirely opt-in — nothing connects unless you explicitly set it up and authenticate.

**Local MCP servers** — If you connect local MCP servers (e.g. Zotero, a GitHub server), tool calls go to `localhost` — data stays on your machine and never hits the network.

**Remote MCP servers** — If you connect remote MCP servers (e.g. Notion, Sentry), tool calls go to those external endpoints via the CORS proxy. Like Composio, fully opt-in and only what you configure.

**Asking for help** — A dedicated remote MCP server contains semantically chunked documentation from the COS readme, other extension READMEs, and Roam help articles. When you ask "how do I connect to remote MCP servers?" this is where the query goes. It's hosted on a Supabase database controlled by the extension author.

**What it can do inside your graph** — When you ask Chief of Staff to do something, it has access to Roam tools that can search blocks, read pages, create/edit/delete blocks, create pages, manage TODOs, and navigate your graph. If Better Tasks is installed, it can also search, create, and modify tasks with full attribute support. If Roam Grid is installed, its `rg_*` tools show up through the same Extension Tools path as other extensions once you enable the **Roam Grid** toggle (off by default). These tools only run during an active request — they don't scan or index your graph in the background by default.

**Safety defaults** — Any action that modifies your graph (creating, editing, or deleting blocks) requires your explicit approval via a confirmation prompt. Read-only operations (searching, fetching) proceed automatically.

**Automatic Actions** — Optional background features, each gated behind its own settings toggle (all off by default) under Settings → Show Automatic Actions. Current features: **Correction Capture** tracks blocks COS writes and detects your edits (local diff, no LLM); **Correction Synthesis** clusters repeated corrections weekly into proposed memories on `[[Chief of Staff/Synthesis]]` and flags stale memory entries (deterministic, no LLM, propose-only); **Post-Run Evaluation** scores each interaction via an LLM judge with rubric scores + binary pass/fail checks (one cheap mini-tier call per evaluated run, ~$0.001-0.003). Future automatic actions (e.g. graph statistics, stale task detection) will follow the same pattern.

For full technical details on security measures, injection defences, and credential handling, see [Security](#security).

---

## Requirements

| Requirement | Notes |
|---|---|
| At least one LLM API key (Anthropic, OpenAI, Gemini, Mistral, Groq, Grok, Kimi Moonshot, Kimi Code, DeepSeek, Ollama Cloud), **or** a ChatGPT Plus/Pro subscription (see [ChatGPT subscription auth](#chatgpt-subscription-auth-experimental)), **or** a local Ollama server, **or** a custom OpenAI-compatible endpoint (LM Studio, OpenRouter, vLLM, …) | API keys use direct browser fetch — incurs API costs at your provider's rates. Groq requires a paid plan (Dev tier or above) — the free tier's token-per-minute limit is too low. ChatGPT subscription auth draws on the plan's weekly quota instead of API billing (experimental). Kimi Code, Ollama Cloud, and ChatGPT subscription calls are metered as zero-cost in Chief of Staff (billing lives on the subscription side). Local servers (LM Studio, Ollama on localhost) cost nothing and run offline. |
| Composio account + API key | Only required for external tool integrations. Graph and task features work without it. |
| [Better Tasks](https://github.com/mlava/recurring-tasks) extension | Only required for Better Tasks integration. Plain TODO search works without it. |
| Roam Grid extension | Only required for grid tools (`rg_*`). Chief of Staff works without it. |

---

## Setup

### 1. Configure your LLM

Open **Settings > Chief of Staff** and fill in:

- **Your Name** — how Chief of Staff addresses you
- **Assistant Name** — display-only label used in chat header and toasts (default: `Chief of Staff`)
- **LLM Provider** — `anthropic` (default), `openai`, `gemini`, `mistral`, `groq`, `grok`, `kimi` (Moonshot), `kimi-coding` (kimi.com/code), `deepseek`, `ollama` (Ollama Cloud or a local server), `openai-codex` (appears once you connect a ChatGPT subscription — see [ChatGPT subscription auth](#chatgpt-subscription-auth-experimental) below), or one of your configured custom slots (see [Custom OpenAI-compatible providers](#custom-openai-compatible-providers-lm-studio-ollama-openrouter-vllm-) below).
- **API Keys** — separate fields for each provider. Only the key for your selected provider is required; configure additional keys to enable automatic failover.
  - Anthropic API Key (`sk-ant-...`)
  - OpenAI API Key (`sk-...`)
  - Google Gemini API Key (`AIza...`)
  - Mistral API Key
  - Groq API Key (`gsk_...`) — requires a paid plan (Dev tier or above)
  - Grok API Key (xAI) (`xai-...`)
  - Kimi API Key (Moonshot) (`sk-...`)
  - Kimi Code API Key — get yours at kimi.com/code. A `sk-kimi…` key pasted into the Moonshot field above is reused here automatically.
  - DeepSeek API Key (`sk-...`) — get yours at platform.deepseek.com
  - Ollama API Key — Ollama Cloud key. Leave blank for a local Ollama server.
  - Ollama Base URL — default `https://ollama.com/v1`. Set to `http://127.0.0.1:11434/v1` for a local server. Optional per-tier model overrides (mini/power/ludicrous) sit below it.
- **LLM Model** — leave blank to use the default for your provider, or enter any model ID supported by that provider
- **Response Verbosity** — controls how verbose assistant responses are and how many output tokens are allowed per call. `concise` (1,200 tokens, brief bullet-point style), `standard` (2,500 tokens, default), or `detailed` (4,096 tokens, thorough explanations). Only affects the mini tier — power and ludicrous tiers have their own token budgets. With prompt caching reducing input costs, output tokens become the dominant expense, so this setting gives you direct control over the main remaining cost lever.
- **Debug Logging** — enable verbose console output for troubleshooting
- **Dry Run** — one-shot toggle that simulates the next mutating tool call without writing anything (auto-disables after one use)
- **Ludicrous mode failover** — allow escalation to the most expensive models (Opus 5 / GPT-5.6 Sol) when all power-tier providers fail
- **End run after a single successful write** (Advanced, default on) — a lone successful write ends the run with a confirmation. Turn it off if a skill needs several writes in one go (for example a create-then-update workflow, a batch edit, or a follow-up TODO plus slot). `/plan` then go still runs the full plan either way.
- **Continue after a write during a skill run** (Advanced, default on) — when a skill is active, the run may take another turn after one write even if the switch above is on. Casual chat is unchanged.
- **Escalate on claimed action with no tool call (all providers)** (Advanced, default on) — any mini-tier provider that repeatedly claims it did something without a successful tool call is bumped to power. Off keeps the old Gemini-only trigger.
- **Agent max iterations** (Advanced, default 20) — cap on agent-loop iterations for normal chat. Raise for weaker models that spend one iteration per tool, or for long multi-write rearranges. Multi-write intents (rearrange a list / insert many items into an existing order) auto-boost to at least 32. Allowed range 10–40.
- **Skill max iterations** (Advanced, default 16) — cap on agent-loop iterations when a skill or gathering guard is active. Raise it for weaker models that spend one iteration per tool. Allowed range 8–40.
- **Timed block parent** (Advanced, empty by default): page title or block uid that owns new timed blocks. Empty uses today's daily page (an existing Nautilus Log child if present, otherwise a Schedule heading). Does not inject Nautilus onto a graph that never had it.
- **Timed block sandbox page** (Advanced, default `COS Daily Plan Sandbox`): when the user message contains `[sandbox]`, timed blocks go under that page instead of today.
- **Allow overlapping timed blocks** (Advanced, default off): Off (the default) refuses a new timed block that overlaps a different one unless you ask to overlap (same time, during, in parallel). On allows overlapping writes even without that language. The same task still reschedules in place. Saying "same time", "overlap", or "during lunch" writes both without flipping this setting.
- **Auto mode** (Advanced, default `off`) — `off` still asks before every mutating tool. `graph` auto-approves reversible graph writes (create/update/todo/batch) after a toast; deletes, email, and money still ask. `full` also auto-approves a single `roam_delete_block`; bulk deletes, page deletes, email, and money still ask. Chat and prompt injection cannot change this.
- **Hide COS Pages from Linked References** — automatically filters Chief of Staff namespace pages out of linked references on all non-COS pages. Enabled by default.
- **Use Linked Dates in CoS Logs** — when enabled, internal CoS log entries (audit log, usage stats, eval scores, corrections, graph hygiene, skill-optimize) prefix each line with a `[[Linked Date]]`. Disable to write plain dates instead — keeps Daily Notes pages from accumulating linked references on mobile. Enabled by default.
- **Staleness Warning Threshold (days)** — how long a skill or scheduled job can go without being reviewed before it's flagged. A startup toast (debounced to once per 24 hours) lists stale items, and `staleness report` returns the same list on demand. Default `30`. Set to `0` to disable the warnings entirely (the report still works).

Default models by tier:

| Tier | Anthropic | OpenAI | Gemini | Mistral | Groq | Grok | Kimi | OpenAI-Codex (subscription) |
|---|---|---|---|---|---|---|---|---|
| Mini (default) | claude-haiku-4-5 | gpt-5.6-luna | gemini-3.1-flash-lite | mistral-small-latest | llama-3.3-70b-versatile | grok-4.3 | kimi-k2.5 | gpt-5.6-luna |
| Power (`/power`) | claude-sonnet-5 | gpt-5.6-terra | gemini-3.6-flash | mistral-medium-latest | llama-3.3-70b-versatile | grok-4.6 | kimi-k2.7-code | gpt-5.6-terra |
| Ludicrous (`/ludicrous`) | claude-opus-5 | gpt-5.6-sol | gemini-3.1-pro-preview-customtools | mistral-medium-latest | llama-3.3-70b-versatile | grok-4.6 | kimi-k3 | gpt-5.6-sol |

| Tier | Kimi Code (`/kimi-code`) | DeepSeek | Ollama (Cloud default; overridable) |
|---|---|---|---|
| Mini | kimi-for-coding | deepseek-chat | deepseek-v4-flash |
| Power | kimi-for-coding | deepseek-reasoner | deepseek-v4-pro |
| Ludicrous | kimi-for-coding-highspeed | deepseek-reasoner | glm-5.2 |

`/kimi` is Moonshot (`api.moonshot.ai`). `/kimi-code` is Kimi Code (`api.kimi.com/coding/v1`). A `sk-kimi…` key pasted into the Moonshot field is reused for Kimi Code and ignored for Moonshot. Ollama Cloud uses `https://ollama.com/v1`; a local server uses `http://127.0.0.1:11434/v1` and needs no key.

#### Custom OpenAI-compatible providers (LM Studio, Ollama, OpenRouter, vLLM, …)

In addition to the built-in providers above, you can configure up to three custom slots pointing at any OpenAI-compatible `/v1/chat/completions` endpoint — local servers like LM Studio or a second Ollama, or remote services like OpenRouter, Together AI, or self-hosted vLLM. Settings live under **Show Integration Settings → Custom LLM Providers**. First-class Ollama (Cloud or local) is a built-in; custom slots are for extra endpoints.

**Per-slot fields:**

- **Display name** (optional) — friendly label that appears in the LLM Provider dropdown above (e.g. `custom-1 — LM Studio`).
- **Base URL** — endpoint base ending at `/v1`. The `/chat/completions` path is appended automatically.
- **API key** (optional) — Bearer token. Leave blank for local servers that ignore auth (LM Studio, Ollama).
- **Model IDs** — separate fields for mini, power, and ludicrous tiers. Mini is required; power falls back to mini if blank, ludicrous falls back to power.
- **Include in failover** — append this slot to the end of every failover chain (default off; only used when explicitly selected as primary).
- **Privacy mode (no failover)** — when this slot is the primary provider and a request fails, surface the error instead of falling over to another provider. Use this to keep all traffic local with no cloud spillover.
- **Disable tool calling** — required for some free OpenRouter models and small local models that 404 on tool-bearing requests. Agent runs in chat-only mode (no Roam reads/writes, no MCP) when on.
- **Route through Roam CORS proxy** — escape hatch for remote endpoints with restrictive CORS. Does NOT work for localhost — local servers must enable CORS themselves.

**Quick start — LM Studio:** open the **Developer** tab, toggle **Enable CORS** ON, then start the server with a model loaded. Set base URL to `http://localhost:1234/v1` and copy the model ID from `http://localhost:1234/v1/models`. Without the CORS toggle, the browser blocks the request at preflight with `No 'Access-Control-Allow-Origin' header is present`.

**Quick start — Ollama:** Ollama enforces CORS via the `OLLAMA_ORIGINS` env var. Run `OLLAMA_ORIGINS=https://roamresearch.com ollama serve`, then `ollama pull llama3.2`. Set base URL to `http://localhost:11434/v1` and model `llama3.2`.

**Quick start — OpenRouter:** sign up at [openrouter.ai](https://openrouter.ai), copy your API key, set base URL to `https://openrouter.ai/api/v1`. Pick any model from the [tools-capable models filter](https://openrouter.ai/models?supported_parameters=tools). Free models have aggressive per-account rate limits (~50/day default, lifted to 1000/day after $10 credit purchase) and several have no tool-capable provider — if a model 404s with *"No endpoints found that support tool use"*, either pick a different model or toggle "Disable tool calling" on the slot.

**Cost tracking note.** Custom-provider models accrue zero cost in Chief of Staff's session/daily totals — the extension can't reliably price arbitrary endpoints. For paid services like OpenRouter, check spend on the provider's own dashboard.

**CORS rules summary.** Local URLs (`http://localhost`, `127.0.0.1`, `[::1]`) always bypass the Roam CORS proxy and go direct (browser secure-context exception for loopback). Remote URLs go direct by default; if the remote service has restrictive CORS, enable "Route through proxy" on that slot. The proxy escape hatch does not work for localhost — the proxy is a Cloudflare Worker on the edge and cannot reach your machine.

**Renaming caveat.** When you rename a slot's display name, Roam's settings select widget caches its displayed selection across rebuilds — close and re-open the settings panel to see the new label in the LLM Provider dropdown. The change takes effect immediately for routing; only the display lags.

#### ChatGPT subscription auth (EXPERIMENTAL)

Instead of an OpenAI API key, you can authenticate with your **ChatGPT Plus or Pro subscription** — GPT calls then draw on the subscription's included weekly quota rather than per-token API billing. For heavy `/ludicrous` use this can turn hundreds of dollars of monthly API spend into the flat $20/month you may already pay.

**How it works.** Chief of Staff uses OpenAI's Codex device sign-in (the same flow as `codex login --device-auth` and Hermes Agent): run **command palette → Chief of Staff: Connect ChatGPT Subscription (Codex)**, a dialog shows a one-time code, open the sign-in page ([auth.openai.com/codex/device](https://auth.openai.com/codex/device)) from any device, enter the code, and approve. On success, `openai-codex` becomes your primary LLM provider automatically (change it back anytime in settings — it also stays available in the dropdown). Disconnecting restores a working provider (your first configured API key, or a custom slot). Tiers: mini → **gpt-5.6-luna**, power → **gpt-5.6-terra**, ludicrous → **gpt-5.6-sol** — everyday queries preserve your weekly quota and only escalated requests draw on the top model. Requests stream to OpenAI's Codex backend through Roam's shared CORS proxy; tokens are stored in Roam Depot settings and refreshed automatically. Note the ~60s ceiling that proxy imposes — see the last bullet below.

**Read this before enabling:**

- **Grey-area, best-effort.** This path uses OpenAI's own Codex sign-in but is not a documented third-party API. OpenAI could restrict or break it at any time without notice (Anthropic blocked the equivalent path for Claude subscriptions in early 2026). Treat it as a cost optimisation, not infrastructure.
- **Weekly quota limits.** ChatGPT Plus has a weekly usage cap for Codex access; agent loops with many tool calls burn it faster than chat. When you hit the cap you'll see a clear error — wait for the weekly reset, upgrade to Pro, or switch back to an API-key provider.
- **Keep an API key configured.** `openai-codex` is never a failover *target* — but when it fails (quota, expired auth), Chief of Staff automatically falls over TO your API-key providers, so responses keep flowing.
- **One graph session at a time.** Refresh tokens rotate on every renewal; two Roam sessions refreshing the same credential can invalidate each other. If auth dies, run **Reconnect ChatGPT Subscription** from the command palette.
- **Zero-cost in usage tracking.** Like custom providers, subscription calls don't count against the daily spending cap (there's no per-token price to meter).
- **Long runs are capped at ~60s — this is a hard limit, not a setting.** Subscription requests must route through Roam's shared CORS proxy (`chatgpt.com` blocks cross-origin browser calls), and that proxy is a cloud function which times out at ~60s. Generations longer than that die with a gateway error at around 63 seconds; heavy skill runs hit this reliably, everyday queries do not. **You cannot fix this with your own Cloudflare Worker** — it was tried: Cloudflare's runtime stamps a `Cf-Worker` header on every Worker subrequest (it is added after user code, so it cannot be stripped) and OpenAI's WAF rejects any request carrying it with a 403. Escaping the ceiling would need a proxy on a non-Cloudflare platform. For now, **use an API-key provider (e.g. Anthropic) for long runs** — those are called directly from the browser with no proxy and no time limit.

Command palette entries: **Connect ChatGPT Subscription (Codex)**, **Disconnect ChatGPT Subscription**, **Reconnect ChatGPT Subscription**. Connection status shows in settings under **ChatGPT Subscription (EXPERIMENTAL)**.

#### How tiers work

By default, requests go to the **mini** tier — fast and cheap. You can force a higher tier by appending `/power` or `/ludicrous` to your message in the chat panel (e.g. "summarise my week /power"). You can also force a specific provider by appending `/claude`, `/gemini`, `/openai`, `/mistral`, `/groq`, `/grok`, `/kimi`, `/kimi-code`, `/deepseek`, or `/ollama` (e.g. "summarise my week /claude /power"). `/kimi-code` must be typed in full — the `/kimi` flag selects the Moonshot host. Provider and tier commands are orthogonal and can be combined freely. All command suffixes are stripped before the message reaches the LLM. When a provider is forced, automatic failover is disabled — if that provider fails, you see the error rather than a silent switch to another provider.

Most of the time, you don't need to think about tiers. A composite scoring system evaluates each request across three dimensions — tool count requirements (40% weight), prompt complexity (35%), and conversation trajectory (25%) — and automatically escalates to the power tier when the score exceeds 0.45. Requests involving routed MCP servers (those with more than 15 tools) are always escalated to power regardless of score. Trivial follow-ups ("thanks", "ok") stay on mini even after complex sessions.

#### Automatic failover

If your primary provider is unavailable or returns an error, the assistant automatically tries the next available provider in the chain. Each failed provider enters a 60-second cooldown before being retried. If all power-tier providers fail and you have **Ludicrous mode failover** enabled in settings, the assistant escalates to the most capable (and most expensive) models as a last resort. This means configuring API keys for multiple providers gives you resilience — the assistant keeps working even if one provider has an outage.

Custom OpenAI-compatible slots are NOT in any failover chain by default — they only run when explicitly selected as the primary provider. Toggle **Include in failover** per slot to opt in (the slot is appended to the end of every tier's chain so built-ins are tried first). For local-only / privacy use, toggle **Privacy mode (no failover)** on the slot — when that slot is the primary provider, a failed call surfaces the error instead of falling over to a cloud provider.

#### Anthropic advisor tool

When running on Anthropic, Chief of Staff supports the [advisor tool](https://www.claude.com/blog/the-advisor-strategy) — an Anthropic beta server tool (`advisor_20260301`) that lets a cheap executor model consult a more capable advisor model on hard judgment calls within a single API call. The executor stays in control of the agent loop and never gives it up; the advisor returns strategic guidance only and cannot execute tools.

**Why it matters.** A typical Chief of Staff agent run handles many simple iterations — searching, fetching, formatting, listing — at very low cost on Haiku. Most of those iterations don't need high-end reasoning. A few moments do: strategic decisions, ambiguous tool results, judgment calls about what to do next. The advisor pattern lets the executor pause those specific moments to consult Opus, then resume. You get most of the cheap-iteration savings while preserving quality on the hard parts. Anthropic's published benchmarks show meaningful quality improvements at lower overall cost than a single-tier Sonnet baseline.

**How to enable it.** In **Settings → Show Advanced Settings**:

- **Anthropic Advisor Tool (Beta)** — master toggle. Off by default.
- **Advisor Max Uses Per Run** — caps how many times the executor can consult the advisor per agent run. Default `2`. Each consultation calls Opus and is billed at Opus rates.
- **Restrict Advisor to Mini Tier** — when on (the default), the advisor is only injected on mini-tier runs, where the cost-quality delta is largest. Toggle off if you also want it available on power tier.

**Provider scope.** Anthropic only. Gemini, OpenAI, Mistral, and Groq are unaffected — they continue to use the existing tier and failover strategy. Eval-judge, intent classifier, and other zero-tool deterministic Anthropic calls are also exempt — the advisor only fires when there are real tools in the request.

**When the model decides to consult.** The system prompt instructs the model to consult the advisor sparingly — for genuinely uncertain strategic decisions, ambiguous tool results, forecasts, and judgment calls — and *not* for routine information lookups, simple tool calls, or tasks within its normal capability. In practice, the executor self-selects appropriately: it consults on architectural questions but not on derivative follow-ups or pure tool orchestration like daily briefings.

**Cost attribution.** When the advisor is consulted, its tokens are tracked separately at Opus rates. The Activity tab and persistent audit log show the model label as `claude-haiku-4-5-20251001 + claude-opus-5 advisor ×N` for runs that used the advisor, with the token total combining executor and advisor tokens. Cost is the sum of both. The session cost indicator in the chat panel header includes advisor cost in the same line.

> **Security note:** API keys are stored in Roam Depot's settings store (browser IndexedDB). They are never transmitted except directly to the LLM provider's API endpoint (via Roam's built-in CORS proxy when available). Do not use shared or public Roam graphs if you store API keys here.

### 2. Connect Composio (optional)

Composio lets the assistant call external APIs (Gmail, Google Calendar, Todoist, etc.) via MCP. **Skip this section entirely if you only need graph and task features** — everything in the sections above works without Composio.

If you do want external tool integrations, here is the dependency chain:

> **You want external tools** (Gmail, Calendar, Todoist, …)
> → you need a **Composio account** (free tier available at [composio.dev](https://composio.dev))
> → Composio's MCP endpoint requires a **CORS proxy** (because Roam runs in the browser)
> → the proxy runs on **Cloudflare Workers** (free tier, one-click deploy below)

In short: Cloudflare account → deploy proxy → Composio account → configure extension → connect tools. Each step is covered below.

This helpful video overview was created by Maya at Roam Research for publication in *Commentarii Roamani* and shows the process in detail:

[![Composio MCP Setup Video](https://img.youtube.com/vi/HD8-LOoJC84/maxresdefault.jpg)](https://www.youtube.com/watch?v=HD8-LOoJC84)

#### 2a. Deploy a CORS proxy

Roam runs in the browser, so cross-origin requests to Composio's MCP endpoint are blocked by default. You need a small Cloudflare Worker that adds CORS headers. A ready-to-deploy worker lives in a separate repo: [`roam-mcp-proxy`](https://github.com/mlava/roam-mcp-proxy). It only accepts requests originating from `roamresearch.com` by default.

**Deploy it once and it covers both Composio and [web page fetching](#5-web-page-fetching-optional)** — there is no second proxy to install. If you deployed this worker before **v2**, redeploy to pick up web fetching; your worker URL doesn't change and no settings need updating.

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

1. Create a [Composio](https://composio.dev) account and copy your **API key** from the Composio dashboard (Settings → API Keys — starts with `ak_`).
2. In **Settings > Chief of Staff**, set **CORS Proxy URL** to just your proxy worker's base URL — no path required:
   ```
   https://roam-mcp-proxy.<you>.workers.dev
   ```
   The extension automatically creates a Composio tool-router session at connect time and constructs the correct endpoint URL from the session response.
3. Enter your **Composio API Key** in the same settings panel.
4. Run **Chief of Staff: Connect Composio** from the command palette.
5. Run **Chief of Staff: Install Composio Tool** and enter a tool slug (e.g. `GOOGLECALENDAR`, `GMAIL`, `TODOIST`). You will be redirected to complete OAuth authentication in a new tab.

### 3. Connect local MCP servers (optional)

Local MCP servers let the assistant interact with tools running on your machine — for example, a Zotero research library, a local GitHub MCP server, or custom tools. Most MCP servers communicate via stdio, but browser extensions can only use HTTP. Chief of Staff bridges this gap automatically using [supergateway](https://github.com/supercorp-ai/supergateway), which wraps any stdio MCP server as an SSE endpoint.

#### One-command setup

1. Open the command palette and run **Chief of Staff: Generate Supergateway Script**.
2. Paste your `mcpServers` JSON configuration — the same format used by Claude Desktop, Cursor, Cline, or any MCP client. You only need the inner server entries (not any wrapper keys). If you're not sure where your existing config lives, check these common locations:

   | Client | Config file |
   |--------|-------------|
   | **Claude Desktop** | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) · `%APPDATA%\Claude\claude_desktop_config.json` (Windows) |
   | **Claude Code** | `.claude/settings.json` or `.mcp.json` in your project root |
   | **Cursor** | `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global) |
   | **VS Code (Copilot)** | `.vscode/mcp.json` in the project root |
   | **Cline** | `~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json` (macOS) |
   | **Windsurf** | `~/.codeium/windsurf/mcp_config.json` |

   Open the relevant file and copy the server entries from the `"mcpServers"` object. For example:
   ```json
   {
     "zotero": {
       "command": "npx",
       "args": ["-y", "zotero-mcp"]
     },
     "github": {
       "command": "npx",
       "args": ["-y", "@modelcontextprotocol/server-github"],
       "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "ghp_..." }
     }
   }
   ```
3. The extension parses your config, auto-assigns ports (starting from 8100), and generates a platform-specific install script:
   - **macOS** — creates `launchd` plists in `~/Library/LaunchAgents/` that auto-start on boot and restart on failure
   - **Linux** — creates `systemd` user services that persist across reboots via `loginctl enable-linger`
   - **Windows** — creates Scheduled Tasks in a `\COS\` folder that run at login with auto-restart on failure
4. Click **Download Script** — this also saves the port assignments into your extension settings automatically, so there is nothing to configure manually.
5. Run the downloaded script in your terminal (macOS/Linux: `chmod +x` then execute; Windows: right-click the `.ps1` and "Run with PowerShell").
6. Back in Roam, click the **Connect** button in the setup modal, or run **Chief of Staff: Refresh Local MCP Servers** from the command palette.

That's it. On every subsequent Roam load, the extension auto-connects to your configured ports with exponential-backoff retry (up to 5 attempts per port). Your MCP servers are now available as tools in every agent run.

#### How it works under the hood

- The extension connects to each `localhost:{port}/sse` endpoint using native browser `EventSource` (not the MCP SDK's transport, which fails with local SSE).
- Tools are discovered once at connection time via `listTools()` and cached for the session.
- Servers with **15 or fewer tools** are registered directly — the LLM calls them by name in a single step.
- Servers with **more than 15 tools** use two-stage routing: `LOCAL_MCP_ROUTE` discovers available tools, then `LOCAL_MCP_EXECUTE` calls the chosen tool. This keeps the system prompt compact and per-request token costs low.
- When your prompt mentions a connected server by name (e.g. "search Zotero for..." or "GitHub issues on..."), the request is automatically escalated to the power tier for better tool-use reasoning.
- On first connection, the tool schema is pinned (SHA-256 hash). On subsequent connections, any schema drift (added, removed, or modified tools) is flagged. Tool descriptions are scanned for injection patterns before tools are made available. Connection details are logged to `[[Chief of Staff/MCP Servers]]` in your graph — see [MCP supply chain security](#mcp-supply-chain-security) for details.

A detailed operational guide for manual supergateway setup, LaunchAgent configuration, and troubleshooting is available in [`public/mcp-supergateway-playbook.md`](public/mcp-supergateway-playbook.md).

### 4. Connect remote MCP servers (optional)

Remote MCP servers let the assistant use tools hosted anywhere on the internet — for example, personal knowledge tools, productivity APIs, or custom cloud services that expose a StreamableHTTP or SSE MCP endpoint. No proxy setup or local processes are required.

#### Setup

1. In **Settings > Chief of Staff**, enable **Show Integration Settings**.
2. Set **Remote MCP Servers** to the number of servers you want to connect (1–10).
3. For each server, fill in the fields that appear:

   | Field | Required | Example |
   |---|---|---|
   | **URL** | Yes | `https://mcp.sentry.dev/sse` or `https://my-server.example.com/mcp` |
   | **Display name** | No | `Sentry` (falls back to the server's own name) |
   | **Auth method** | Yes | `token` or `oauth` |

4. **For token auth:** fill in the header name (e.g. `x-api-key`, `Authorization`) and token value.
5. **For OAuth auth:** run **Chief of Staff: Connect Remote OAuth Server** from the command palette. A browser tab opens to the service's sign-in page. Once you authorise, the extension picks up the token automatically. Subsequent reloads reconnect using stored tokens — no re-authentication needed.

#### Auth methods

| Method | When to use | How it works |
|---|---|---|
| **Token** | Servers that accept API keys or static bearer tokens (e.g. `x-api-key: sk-...`). | You paste the header name and token value in settings. |
| **OAuth** | Servers that implement MCP OAuth 2.1 (GitHub, Notion, Linear, Sentry, Stripe, Supabase, Cloudflare, and [30+ others](docs/remote-mcp-servers-research.md)). | Chief of Staff handles the full OAuth flow automatically: server discovery, dynamic client registration, PKCE, and token refresh. Just enter the URL, set auth to "oauth", and connect. |

> **Pre-registered servers:** Some providers (e.g. GitHub, Atlassian) block automatic client registration. For these, register an OAuth app in the provider's developer console, set the redirect URI to `https://roam-oauth-middleware.roam-extensions.workers.dev/mcp-oauth/callback`, then enter the Client ID in the settings fields that appear.

#### How it works

- **Two transports supported:** StreamableHTTP (stateless POST to `/mcp`) is preferred. SSE (browser-native `EventSource` GET to `/sse`) is also supported for legacy servers. OAuth servers using SSE URLs are automatically rewritten to StreamableHTTP.
- **Automatic fallback:** If an SSE connection fails (CORS, 4xx, network error), the extension automatically retries with StreamableHTTP on the same host (`/sse` → `/mcp`). No manual reconfiguration needed.
- Tool calls use raw JSON-RPC POST requests directly — this ensures compatibility with stateless servers that close the SSE stream after each response.
- Servers with **15 or fewer tools** are registered directly — the LLM calls them by name in a single step.
- Servers with **more than 15 tools** use two-stage routing: `REMOTE_MCP_ROUTE` discovers available tools, then `REMOTE_MCP_EXECUTE` calls the chosen tool.
- Auth tokens are stored in Roam Depot (browser IndexedDB) and redacted from all debug logs. OAuth tokens are refreshed automatically when they expire.
- The same supply-chain security pipeline as local MCP applies: tool descriptions are scanned for injection patterns, schemas are pinned on first connection and compared on reconnection, and connection details are logged to `[[Chief of Staff/MCP Servers]]`.
- Connections retry automatically with exponential backoff (up to 4 retries). Use **Chief of Staff: Refresh Remote MCP Servers** to force an immediate reconnect.

> **CORS note:** Roam routes remote MCP requests through its built-in CORS proxy (`corsAnywhereProxyUrl`). If the proxy is unavailable, the extension falls back to a direct request. Some servers may require the proxy to be active for cross-origin access to work correctly.

### 5. Web page fetching (optional)

The `roam_web_fetch` tool lets the assistant fetch any public web page and return its content as Markdown. This is useful for importing articles, reading documentation, or pulling reference material into your graph. It uses Cloudflare's [Browser Rendering `/markdown` endpoint](https://developers.cloudflare.com/browser-rendering/rest-api/), which returns clean Markdown synchronously.

**Requirements:**

- A Cloudflare account (free tier includes Browser Rendering)
- A Cloudflare API token with **Browser Rendering Edit** permission
- Your CORS proxy ([roam-mcp-proxy](https://github.com/mlava/roam-mcp-proxy)) must allow `api.cloudflare.com`. **v2 and later allow it out of the box** — if you deployed the worker earlier, redeploy it (`git pull && npx wrangler deploy`); your proxy URL doesn't change and no settings need updating. (If you previously hand-added `api.cloudflare.com` to an older worker's allowlist, that still works — but redeploying replaces the manual edit and gets you the path-locking, which restricts the proxy to Cloudflare's Browser Rendering API rather than your whole Cloudflare account.)

**Setup:**

1. Go to [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens) → **Create Token** → **Create Custom Token**. Under Permissions choose **Account** · **Browser Rendering** · **Edit**, scope it to your account, then Continue and Create. Copy the token immediately — Cloudflare displays it once.
2. Copy your **Account ID** from the right-hand sidebar of your Cloudflare dashboard overview page (it's also the hex string in the dashboard URL: `dash.cloudflare.com/<account-id>/…`).
3. In **Settings > Chief of Staff**, enable **Show Integration Settings** and fill in:
   - **Cloudflare API Token** — the token you just created
   - **Cloudflare Account ID** — your account ID
   - **CORS Proxy URL** — your roam-mcp-proxy worker URL, if not already set
4. Nothing to do on the worker: **v2 allows `api.cloudflare.com` out of the box** (path-locked to Browser Rendering, so the token can't be aimed at the rest of your Cloudflare account). If you're on a pre-v2 worker, redeploy — see Requirements above.

The tool is now available to the assistant. Ask it to "fetch https://example.com as markdown" or "summarise this article: https://...".

> **Note:** Cloudflare's free tier has daily usage limits for Browser Rendering. If you hit a rate limit (HTTP 429), wait for the daily reset.

### 6. Roam Grid (optional)

Install **Roam Grid** from Roam Depot if you want grid tools. Chief of Staff works without it.

Roam Grid registers tools on `window.RoamExtensionTools["roam-grid"]` with display name **Roam Grid**. Chief of Staff discovers them through the existing Extension Tools path (`getExternalExtensionTools`). There is no roam-grid-specific wiring.

Chief of Staff must not flatten tables: it never writes a grid as sibling bullets under `{{table}}` via `roam_create_block`, `roam_create_blocks`, or `roam_batch_write`. Those render as a single column in Roam Grid. It uses `rg_create_table` instead.

All extensions default to disabled. Opt in the same way as any other extension:

1. In **Settings > Chief of Staff**, enable **Show Extension Tools**.
2. Turn on the **Roam Grid** toggle (off by default).
3. Run **Chief of Staff: Refresh Extension Tools** from the command palette, or `/doctor`, so discovery is current.

Tool names: `rg_list_grids`, `rg_get_grid`, `rg_get_cell`, `rg_enhance_table`, `rg_restore_native`, `rg_create_table`, `rg_resize_table`, `rg_insert_rows`, `rg_insert_cols`, `rg_delete_rows`, `rg_delete_cols`, `rg_set_cell`, `rg_fill`, `rg_add_formula`, `rg_merge`, `rg_unmerge`, `rg_sort`, `rg_insert_chart`, `rg_export_grid`, `rg_apply_patch`, `rg_list_templates`, `rg_create_from_template`.

### Recovery — starting over

Roam Depot stores extension settings in your browser's IndexedDB, which means they **survive uninstall and reinstall**. If you end up with a poisoned configuration — a malformed custom LLM endpoint, a stuck OAuth token, an MCP server that crashes the agent loop — uninstalling the extension does not give you a clean slate.

For that case, run **Chief of Staff: Reset All Settings (Recovery)** from the command palette. It opens a confirmation dialog, then clears every persisted key: API keys for every provider, custom LLM endpoints, all configured local and remote MCP servers, onboarding state, scheduled jobs, usage and cost history, tool installations, and every other setting the extension has saved. Anything you've put on memory pages, in `Chief of Staff/Skills`, or elsewhere in your graph is untouched — only `extensionAPI.settings` is cleared.

After confirming, **reload Roam** (or disable + re-enable the extension) so in-memory state clears too. On next load, onboarding restarts from scratch.

Use this only as a recovery hatch — there's no undo, and you will need to re-enter API keys and reconnect MCP servers. If you only need to clear one specific thing (e.g. a single OAuth token, a single MCP server's stored credentials), prefer the targeted command for that subsystem (`Disconnect Remote OAuth Server`, etc.) instead.

---

## Command palette

| Command | What it does |
|---|---|
| **Chief of Staff: Ask** | Opens a prompt dialogue. The assistant reasons over your question using LLM + available tools. |
| **Chief of Staff: Toggle Chat Panel** | Shows or hides the floating chat panel. |
| **Chief of Staff: Doctor (Health Check)** | Runs a self-diagnostic across API keys, MCP connections, memory, skills, cron jobs, Composio, and Extension Tools. Summary toast + full report in console. |
| **Chief of Staff: Check LLM Model Availability** | Sends a tiny prompt to each configured provider/tier model ID and reports which are reachable. Results summarised in a toast and on the **LLM Model Availability** settings row (also runnable from its **Run check** button). |
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
| **Chief of Staff: Validate Composio Proxy** | Checks that your configured CORS proxy URL is reachable and responding correctly. |
| **Chief of Staff: Refresh Tool Auth Status** | Re-checks any tools waiting for OAuth completion. |
| **Chief of Staff: Discover Toolkit Schemas** | Discovers and caches schemas for all connected Composio toolkits. |
| **Chief of Staff: Show Schema Registry** | Logs the discovered toolkit schema registry to the browser console. |
| **Chief of Staff: Clear Conversation Context** | Resets conversation memory and chat history. |
| **Chief of Staff: Generate Supergateway Script** | Paste your `mcpServers` JSON and get a platform-specific install script (macOS launchd / Linux systemd / Windows Task Scheduler) with auto-assigned ports. |
| **Chief of Staff: Refresh Local MCP Servers** | Disconnects and reconnects all configured local MCP servers. |
| **Chief of Staff: Refresh Remote MCP Servers** | Disconnects and reconnects all configured remote MCP servers. |
| **Chief of Staff: Connect ChatGPT Subscription (Codex)** | Starts the device sign-in flow to authenticate with your ChatGPT Plus/Pro subscription instead of an OpenAI API key (see [ChatGPT subscription auth](#chatgpt-subscription-auth-experimental)). |
| **Chief of Staff: Disconnect ChatGPT Subscription** | Clears stored subscription tokens and, if openai-codex was your primary provider, restores a working one (first configured API key or custom slot). |
| **Chief of Staff: Reconnect ChatGPT Subscription** | Clears tokens and starts a fresh device sign-in (use after auth expiry). |
| **Chief of Staff: Connect Remote OAuth Server** | Starts the OAuth sign-in flow for a remote MCP server configured with auth type "oauth". |
| **Chief of Staff: Disconnect Remote OAuth Server** | Clears stored OAuth credentials and disconnects a remote server. |
| **Chief of Staff: Review MCP Schema Changes** | Shows the schema diff for any MCP server suspended after an unexpected tool schema change, and lets you accept or keep it blocked. |
| **Chief of Staff: Refresh Extension Tools** | Re-discovers tools registered by other extensions on `window.RoamExtensionTools`. After you enable an extension's toggle (for example **Roam Grid**), run this or `/doctor` so those tools are callable. |
| **Chief of Staff: Show Stored Tool Config** | Logs the current tool configuration to the browser console. |
| **Chief of Staff: Show Last Run Trace** | Logs the most recent agent run (iterations, tool calls, timing) to the browser console. |
| **Chief of Staff: Debug Runtime Stats** | Logs current runtime state (cache sizes, connection status, conversation turns) to the browser console. |
| **Chief of Staff: Reset Token Usage Stats** | Resets the session token usage counters and cost display. |
| **Chief of Staff: Show Cost History** | Toast summary of API spend: today, last 7 days, and last 30 days, with request and token counts. |
| **Chief of Staff: Open Review Queue** | Opens `Chief of Staff/Review Queue` — where low-scoring agent runs are filed by the post-run evaluation feature. |
| **Chief of Staff: Refresh AIBOM Snapshot** | Regenerates the runtime AI Bill of Materials snapshot (see [AIBOM](#ai-bill-of-materials-aibom)). |
| **Chief of Staff: Reset All Settings (Recovery)** | Recovery hatch: clears every persisted setting (API keys, custom LLM endpoints, MCP servers, onboarding state, cron jobs, usage history) after a confirmation dialog. Use when a bad config is blocking the UI and uninstall/reinstall doesn't help. Requires a Roam reload to fully take effect. See [Recovery — starting over](#recovery--starting-over). |
| **Chief of Staff: Show Scheduled Jobs** | Logs all scheduled cron jobs and their status to the browser console. |

---

## Chat panel

The floating chat panel (bottom-right corner by default) provides a persistent conversational interface. It is draggable, resizable, and remembers history across sessions (up to 80 messages). Use it for follow-up questions without re-opening the command palette.

- **Enter** to send, **Shift+Enter** for a new line. Composer keys stay in the panel so Roam does not steal them. The resize grip skips the textarea and Send button, so the caret does not jump while you type. The input grows with the text.
- **Arrow Up / Down** to cycle through previous messages (like a terminal).
- **Type `/` at the start of the input** to open an autocomplete menu of the available commands (below), each with a short description. It filters as you type (`/ex` → `/export`); use **Arrow Up / Down** to navigate, **Tab / Enter / click** to complete, and **Esc** to dismiss. The menu also fires **mid-message** when you type a trailing `/` after a space ("summarise my week `/pow`…"), offering just the inline flags (`/power`, `/plan`, provider overrides) and completing in place without disturbing your message.
- **Mistyped a command?** A lone `/veridy` gets an instant "did you mean `/verify`?" instead of being sent to the model.
- `/clear` (or `/new`) resets conversation history and context and starts a new chat (same as the Clear button).
- `/plan <task>` drafts a plan before acting. The assistant explores your graph **read-only**, then lays out the numbered steps, the tools it will call, and the pages/blocks it will write — and waits. Approve with the **Run plan** button (or type `go`), edit by sending a revised request, or **Discard**. Nothing is written until you approve. Ideal for multi-step or consequential operations.
- `/export` copies the current chat transcript into your graph — onto today's daily page under a `[[Chief of Staff/Transcripts]]` header block, so every export collects in that page's linked references. Add `/tag Name` (or `/tags`) to tag the export header, e.g. `/export /tag Inbox` tags it `#Inbox`; comma-separate for several (`/export /tag Inbox, Weekly Review`).
- `/undo` reverses the changes **the assistant** made in its last run — blocks it created are deleted, blocks it edited are restored to their previous content — after showing you exactly what will be reversed (**Undo changes** / **Cancel**). Blocks you've edited since are detected and left alone, and anything it can't safely reverse (deletes, moves, emails sent via external services) is named rather than silently skipped. Your own edits are never touched — Roam's native undo (Ctrl/Cmd+Z) covers those. Saying "undo", "oops", or "revert that" in chat does the same thing. *(This replaces the previous behaviour, where "undo" fired Roam's global undo and could revert your own latest edit instead of the assistant's.)*
- `/why` explains how the last response was produced: which model and tier handled it and why (your flag, an auto-escalation, or the default), which tools ran and how long they took, any self-correction guards that fired, and roughly how many tokens went in. If the answer came from an instant pattern match, `/why` says exactly that — no model call, no tokens.
- `/status` shows what the assistant is doing autonomously right now: connected integrations (Composio, local and remote MCP servers), active scheduled jobs with last-run results, background idle tasks, any plan awaiting approval, whether the last run can be `/undo`ne, and session cost.
- `/verify` scores the last response with an independent judge model — task completion, factual grounding, and safety (1–5), plus binary checks like "were all claims tool-backed?". Works even when the background Post-Run Evaluation feature is off (one cheap mini-tier call); flagged runs are filed to `[[Chief of Staff/Review Queue]]`.
- `/compact` summarises older conversation turns into a compact summary, freeing context space while keeping recent turns intact. Useful in long-running chats when responses start losing earlier context.
- `/help` shows a context-aware capability summary, including the full command list.
- `/doctor` runs a health check across API keys, MCP servers, memory, skills, cron jobs, Composio, and Extension Tools — results displayed inline.
- `/lesson` reviews the conversation and records lessons learned to `[[Chief of Staff/Lessons Learned]]`. Add a topic to focus the reflection (e.g. `/lesson error handling`).
- Suffix a message with `/power` or `/ludicrous` to use a more capable model for that request. Use `/claude`, `/gemini`, `/openai`, `/mistral`, `/groq`, `/grok`, `/kimi`, `/kimi-code`, `/deepseek`, or `/ollama` to force a specific provider.
- A **cost indicator** in the header shows cumulative API spend. Hover for a detailed breakdown: session cost with input/output token counts, today's cost with per-model splits (e.g. `3-flash $2.06`), and rolling 7-day and 30-day totals. Cost history is persisted across sessions. Use **Chief of Staff: Reset Token Usage Stats** to zero the session counters.
- Each assistant response has a small pin icon at its bottom right. Click it to append the response to your daily note page.
- **[[Page references]]** and **((block references))** in responses are clickable — click to navigate, Shift-click to open in the sidebar.
- Streaming responses render incrementally as the model generates text.

The panel suppresses non-essential toasts while open, and persists conversation history and position across reloads.

### Theme responsiveness

The chat panel automatically detects and adapts to your Roam theme — including Roam Studio custom themes and Blueprint dark mode. Three detection strategies work in concert: CSS class markers (`.bp3-dark`), the `prefers-color-scheme` system preference, and real-time luminance sampling of rendered background colours. This means custom Roam Studio themes that don't set standard dark-mode markers are still detected correctly.

Theme transitions are handled gracefully: a hold-last-state guard prevents flicker during animated CSS transitions (common with Roam Studio themes), and a triple-pass verification re-sample ensures the panel settles on the correct theme even for slow multi-second transitions. All UI elements — buttons, inputs, borders, code blocks, and tool previews — use CSS custom properties that update in real time when the theme changes.

---

## Instant commands (no LLM required)

Many common tasks are handled by a **deterministic router** that matches your input against known patterns and calls Roam APIs directly — no LLM round-trip, no API cost, near-instant response. These work even without an LLM API key configured.

### Quick capture

| You type | What happens |
|---|---|
| `add "buy milk" to today` | Creates a block on today's daily page |
| `note meeting at 3pm with Sarah` | Same — `note`, `log`, `jot down`, `capture` all work |
| `add check quarterly numbers to today's page` | Quotes are optional |

### Search & read

| You type | What happens |
|---|---|
| `search project planning` | Exact-text search across page titles and blocks, ranked by relevance |
| `find meeting notes` | Same — `find`, `look up`, `search for` all work |
| `find my notes about racquet sports` | Semantic (meaning-based) search — finds conceptually related notes even when the exact words don't appear. Requires semantic search enabled on your graph; falls back to exact-text search otherwise |
| `show me [[Project Plan]]` | Returns the page contents (top 4 levels, 3K chars) |
| `what's on [[Weekly Review]]` | Same — `read`, `get`, `contents of` |
| `what's on today's page` | Shows today's daily page content |
| `today's notes` | Same |

### Tasks

| You type | What happens |
|---|---|
| `show my todos` | Lists open TODO items (uses Better Tasks if available) |
| `pending tasks` | Same — `list todos`, `open tasks`, `action items` |
| `show done tasks` | Lists completed DONE items |
| `completed tasks` | Same — `finished tasks`, `what did I finish` |

### Navigation

| You type | What happens |
|---|---|
| `open [[Project Plan]]` | Navigates to the page |
| `go to today` | Opens today's daily page |
| `go to yesterday` | Opens yesterday's daily page |
| `open tomorrow` | Opens tomorrow's daily page |
| `go to last Monday` | Opens last Monday's daily page |
| `open next Friday` | Opens next Friday's daily page |
| `open inbox` | Opens `Chief of Staff/Inbox` |
| `open skills` | Opens `Chief of Staff/Skills` |

### Graph information

| You type | What happens |
|---|---|
| `graph stats` | Page count, block count, today's activity |
| `how big is my graph` | Same |
| `what changed today` | Pages modified in the last 24 hours |
| `recent edits` | Same |
| `backlinks for [[Page]]` | What links to a page |
| `stats for [[Page]]` | Created/edited dates, block/word/reference counts |
| `orphan pages` | Pages with zero incoming references (requires Orphan Page Detection enabled) |
| `broken links` | Block/page refs pointing to deleted content (requires Stale Link Detection enabled) |

### Sidebar & UI

| You type | What happens |
|---|---|
| `open sidebar` | Opens the right sidebar |
| `open left sidebar` | Opens the left sidebar |
| `close sidebar` | Closes the right sidebar |
| `open [[Page]] in sidebar` | Opens a page in the right sidebar |

### Utilities

| You type | What happens |
|---|---|
| `undo` / `oops` / `revert that` | Reverses the assistant's last changes (same as `/undo` — shows a summary and asks for confirmation; never touches your own edits) |
| `what time is it` | Current time and today's daily page title |
| `health check` or `doctor` | Self-diagnostic report (API keys, MCP, memory, skills, cron, Composio, Extension Tools) |
| `help` | Context-aware capability summary |
| `tools` | Lists all available tools by category |
| `what roam tools do you have` | Lists tools for a specific category |
| `remember that X` | Saves to memory (no LLM needed) |
| `run daily briefing` | Triggers a skill directly by name |
| `import a document` | Opens a file picker and imports a document (docx, odt, rtf, epub, html, md) as a new Roam page — requires the Export Document extension, which handles pandoc conversion and consent |
| `staleness report` | Lists skills and scheduled jobs that haven't been reviewed within the configured threshold |
| `stale skills` | Same — also matches `which jobs need review`, `review my scheduled tasks`, `unreviewed crons`, `outdated skills`, `staleness report` |

All of the above work in both the chat panel and the command palette prompt. They respond in under 100ms since there's no network call to an LLM provider.

---

## Ask about Roam, extensions, or Chief of Staff itself

Chief of Staff connects to a remote MCP server that serves documentation — such as extension READMEs, Roam help articles, or setup guides — and can answer questions about Roam Research and many of your installed extensions directly in the chat panel. No browsing, no searching through docs. Just ask.

**Examples:**

- *"How do I create a Kanban board in Roam?"* — explains the `{{[[kanban]]}}` syntax, column/card hierarchy, and drag-and-drop behaviour.
- *"How do I set up remote MCP servers?"* — walks you through settings, transport types, auth configuration, and troubleshooting.
- *"How do I set up Better Tasks?"* — covers installation, dashboard access, task creation (including via natural language through COS), recurring tasks, and attributes.
- *"What keyboard shortcuts does Roam have?"* — pulls from Roam's help documentation.
- *"How does the inbox work in Chief of Staff?"* — explains the read-only processing model, auto-move to daily page, and how to use it.

This works because COS treats the documentation server like any other remote MCP tool — it routes the question to the server, retrieves the relevant content, and synthesises a response grounded in the actual docs rather than the LLM's training data. Responses include Roam-specific syntax examples and configuration steps that are accurate to the current version.

**Setup:** None needed. As long as you have an API key set in settings for one of the LLM providers, this feature is available.

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

If the [Better Tasks](https://github.com/mlava/recurring-tasks) extension is installed, task queries use Better Tasks attributes (`BT_attrDue`, `BT_attrProject`, etc.) and support filtering by due date, project, status, priority, energy, GTD context, and free text. You can create new Better Tasks from natural language ("create a better task to review the budget due next Friday for the Planning Committee project"), and the assistant will set the appropriate attributes.

**Attributes recognised:** `BT_attrProject` · `BT_attrDue` · `BT_attrStart` · `BT_attrDefer` · `BT_attrRepeat` · `BT_attrGTD` · `BT_attrWaitingFor` · `BT_attrContext` · `BT_attrPriority` · `BT_attrEnergy` · `BT_attrDepends` · `BT_attrParent`

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

`Chief of Staff/Inbox` acts as a semi-automated input channel. Drop a block into the inbox page and the assistant will automatically process it in **read-only mode** — it can search, read, and gather information from your graph and connected tools, but it cannot create, update, move, or delete any blocks or send emails. The response is nested under the original inbox block as a structured hierarchy of Roam blocks, which is then moved to today's daily page under a "Processed Chief of Staff items" heading.

### How it works

- COS watches `Chief of Staff/Inbox` with a live pull watch. New top-level blocks are detected within a few seconds of being written (5-second debounce to let batch writes settle).
- Items are processed one at a time in a sequential queue (max 40 pending).
- The block text becomes the prompt. The model tier is chosen automatically: **mini** for short, simple items; **power** for items longer than 700 characters, more than 10 lines, or containing keywords like `triage`, `weekly review`, `daily briefing`, `deep research`, `catch me up`, `retrospective`, or `end-of-day`.
- The response is parsed from markdown into a proper Roam block hierarchy — headings, bullets, and nested lists all land as real nested blocks, not flat text.
- After processing, the original inbox block (and its children) is moved to today's daily notes page under a `### Processed Chief of Staff items` heading, with the COS response appended as child blocks beneath it.

### Read-only tool allowlist

Inbox processing uses a strict allowlist — any tool not on this list is blocked, regardless of what the model requests:

| Category | Tools available |
|---|---|
| Roam read | `roam_search`, `roam_semantic_search`, `roam_get_page`, `roam_get_daily_page`, `roam_get_block_children`, `roam_get_block_context`, `roam_get_page_metadata`, `roam_get_recent_changes`, `roam_link_suggestions` |
| Better Tasks read | `roam_bt_search_tasks`, `roam_bt_get_projects`, `roam_bt_get_waiting_for`, `roam_bt_get_context`, `roam_bt_get_analytics`, `roam_bt_get_task_by_uid`, `roam_bt_get_attributes` |
| Web | `roam_web_fetch` |
| COS | `cos_get_skill`, `cos_get_tool_ecosystem`, `cos_cron_list` |
| MCP routing | `LOCAL_MCP_ROUTE` (explicit); remote MCP tools flagged as `isMutating: false` by their server also pass through automatically, so read-only remote tools (e.g. Open Brain's `search_thoughts`) are available |

`roam_open_page` is intentionally excluded — it would navigate your main window mid-background-run.

### Simple captures

For quick questions or instructions, just write a block directly to the inbox page:

```
What tasks are overdue in Better Tasks?
```

```
Fetch https://example.com/article and summarise the key points.
```

### Using the inbox with external automation

The inbox is a natural integration point for Make, Zapier, n8n, local agents (like a home-server agent), or any tool that can write to your Roam graph via MCP. The recommended pattern is a clean separation of concerns:

**Step 1 — The external tool writes its output to a dedicated page**, not directly to the inbox. Use a consistent naming convention, e.g.:

```
[[Hermes/2026-04-09]]          ← overnight agent run
[[Gmail Digest/2026-04-09]]    ← daily email summary from Make
[[Zapier/Meeting Notes/2026-04-09]]
```

Structure the page with clear sections — Summary, Findings, Action items — so COS can navigate it efficiently with `roam_get_page`.

**Step 2 — The external tool writes a short pointer block to `Chief of Staff/Inbox`**:

```
I've written overnight research to [[Hermes/2026-04-09]]. Triage the findings and identify action items.
```

```
Gmail digest for today is at [[Gmail Digest/2026-04-09]]. Summarise anything requiring a response.
```

```
New meeting notes at [[Zapier/Meeting Notes/2026-04-09]]. Extract action items and decisions.
```

COS picks up the inbox block, reads the linked page with `roam_get_page`, synthesises the content, and moves everything to your daily page with a structured response beneath it. You wake up (or check in later) to a clean daily note with the work already triaged.

**Tip — use trigger words intentionally.** The inbox pointer wording determines which model tier processes the request. Including `triage`, `daily briefing`, `weekly review`, or `deep research` upgrades from mini to power. For simple filing tasks ("save this to my daily page") you don't need those keywords and will get a faster, cheaper mini-tier run.

**What the external tool needs.** Any tool that can write blocks to a Roam graph via the Roam MCP server can use this pattern. The Roam MCP server exposes tools like `roam_create_page` and `roam_import_markdown` that make it straightforward to write structured output pages and inbox pointer blocks from external agents, Make scenarios, or n8n workflows.

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
  - Sources: get_calendar_events, bt_search, search_email
  - Tools: get_calendar_events, list_calendars, bt_search, bt_get_projects, search_email, WEATHERMAP_WEATHER, roam_batch_write
  - Tier: mini
  - Budget: $0.03
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

There are six skills installed during onboarding, however a series of other skills are available at [`public/other_skills.md`](public/other_skills.md).

### How skills work

Skills are reloaded automatically when you edit the page (via a live pull watch). The prompt receives a compact skill index (all skill names + first-line summaries), while the full skill body is loaded only when you invoke a specific skill. You can invoke a skill by name: "run my Weekly Review" or "do a Daily Briefing".

When a skill lists **Sources**, a gathering completeness guard ensures the assistant calls all required data tools before writing output. For example, if your Weekly Review lists "Better Tasks" as a source, the assistant must query Better Tasks before generating the review — it cannot skip the query and hallucinate task data.

### Optional skill fields

Skills support several optional fields that control tool access and cost. All are optional — if absent, current defaults apply.

| Field | Format | Default | What it does |
|-------|--------|---------|--------------|
| **Sources:** | Comma-separated tool names or `[[Page]]` refs | None | Gathering completeness guard — forces the assistant to call these tools before writing output |
| **Tools:** | Comma-separated tool names | Full tool set (~80-110 tools) | Restricts which tools are available for this skill run. Reduces token cost and tightens security. Core Roam and COS tools are always available regardless. |
| **Tier:** | `mini`, `power`, or `ludicrous` | `power` | Which model tier the skill runs at. Mini is ~60-80% cheaper; ludicrous uses the most capable (and most expensive) models. |
| **Budget:** | Dollar amount, e.g. `$0.05` | No cap | Hard cost cap per skill run. The agent loop halts when the accumulated cost exceeds this amount. |
| **Iterations:** | Integer, e.g. `4` | Source-based calculation or 20 | Maximum number of LLM calls per skill run. Minimum 2 (one for tool calls, one for synthesis). |
| **Constraints:** | Four quadrants: Must Do, Must Not Do, Prefer, Escalate | None | Structured behavioural boundaries injected as binding system instructions. |
| **Acceptance:** | Binary pass/fail criteria, one per line | None | **Pre-flight** quality criteria injected into the system prompt *before* the skill runs, so the model knows what its output must satisfy. Header variants accepted: `Acceptance —`, `Acceptance Criteria —`, `Acceptance Tests:`, `Acceptance Checks —`. Also passed to the eval-judge post-run alongside any `Rubric:` items. |
| **Rubric:** | Checkable quality criteria, one per line | Standard eval only | **Post-run** skill-specific pass/fail checks scored by the eval-judge after each run. Results appear in the Review Queue. Use `Acceptance:` if you want the model to know the criteria *during* the run; use `Rubric:` for criteria the judge evaluates from the output alone. |
| **Last reviewed::** | `[[date page ref]]` | None | Optional staleness marker. Updated automatically by `cos_review_skill`. Skills without this attribute are subject to the staleness warning threshold. |
| **Models:** | `+Mistral`, `-Gemini`, or comma-separated | All providers | Per-skill provider preference. `+Provider` prefers it; `-Provider` excludes it. Useful when a provider struggles with a specific skill's tool patterns. |

**Tools vs Sources:** `Sources:` defines what the assistant *must* call (enforced by the gathering guard). `Tools:` defines what tools are *available* at all (enforced by filtering the tool set before the LLM sees it). Tools should be a superset of Sources — if a source tool is missing from the Tools list, it is auto-added with a warning.

**Tool names:** Use the same shorthand names in both fields — `bt_search`, `list-events`, `roam_get_page`, `WEATHERMAP_WEATHER`, etc. Names are resolved against the live tool registry. If a tool is behind a router (e.g. a local MCP tool), the routing meta-tools are included automatically.

### Tips

- Keep individual skill instructions under about 2,000 characters. The assistant has limited context space, and overly long skills crowd out other context.
- Use **cross-references** to other Chief of Staff pages (e.g. "Sources: Chief of Staff/Decisions") to ground the assistant in your real data.
- Skills that say "Write output to today's daily page" will produce structured output on your daily note page — useful for briefings and reviews you want to see in your daily workflow.
- You can reference Composio tools by name in sources (e.g. "Google Calendar", "Gmail") and the assistant will call them during skill execution.

For a comprehensive guide to writing reliable, cost-efficient skills — including patterns, anti-patterns, the constraint architecture, per-skill eval rubrics, and a tuning workflow — see [`public/skills-best-practices.md`](public/skills-best-practices.md).

### Skill optimisation

Say `optimise [skill name]` (or `optimize`) to run the automatic optimisation loop on any skill. The assistant generates synthetic test cases from the skill definition, scores the current skill against evaluation criteria to establish a baseline, then iteratively mutates individual sections — accepting only changes that improve the score — and presents you with the result before writing anything to Roam.

**Accept / revert.** When the loop finds an improvement, a toast shows the before/after pass rate. If the chat panel is open, the full per-criterion breakdown and optimised skill content appear there too. You must explicitly accept — the skill is never modified until you do. Hitting revert leaves the original untouched.

**Budget.** Each run has a configurable cost cap (set in extension settings under *Skill optimisation budget*, default $2.00). Most runs cost $0.10–$0.40. The run stops cleanly when the budget is reached and presents whatever improvement was found.

**What gets optimised.** The loop targets structural sections: it may add a Rubric (binary quality criteria), add or tighten Constraints (Must Do / Must Not Do / Prefer / Escalate), improve Approach step specificity, clarify Output format, or clean up the Sources list. The Trigger, Tools, Models, Tier, and Budget fields are never modified.

**Stuck criteria.** If an evaluation criterion fails consistently regardless of mutations — typically because it tests runtime behaviour that text-only simulation cannot reproduce — it is automatically excluded from scoring and the loop continues optimising the remaining criteria. These are reported as *wall criteria* in the debrief.

**Power mutations.** Add `--power` to use the power-tier model for mutations rather than mini: `optimise Daily Briefing --power`. Slower and more expensive, but produces better results for complex skills with dense instructions.

---

## Scheduled jobs

The assistant can create recurring or one-shot scheduled jobs that run automatically in the background. Ask naturally — for example:

- *"Run my Daily Briefing skill every morning at 8am"*
- *"Remind me to check my inbox every 30 minutes"*
- *"At 5pm today, summarise what I worked on"*
- *"Check my Open Brain stats every 2 hours between 8am and 6pm"*

Supported schedule types:

| Type | Schedule format | Example |
|---|---|---|
| `cron` | 5-field cron expression + timezone | `0 8 * * *` (daily at 8am) |
| `interval` | Every N minutes, runs 24/7 (minimum 5) | `30` (every 30 minutes) |
| `once` | Specific timestamp | One-shot, auto-disables after execution |
| `reminder` | Specific timestamp, sticky toast only | No agent loop — just a persistent notification |

**Time-windowed recurring jobs.** To run something repeatedly but only during certain hours — e.g. *"every 2 hours between 8am and 6pm"* — use `cron` type with a range expression. The assistant translates natural language automatically:

| Natural language | Cron expression |
|---|---|
| Every 2 hours from 8am to 6pm | `0 8-18/2 * * *` |
| Every 30 minutes during business hours | `*/30 9-17 * * *` |
| 9am and 5pm on weekdays | `0 9,17 * * 1-5` |
| Weekdays at 8am | `0 8 * * 1-5` |

Jobs are stored in extension settings and persist across reloads. If you have multiple Roam tabs open, only one tab executes scheduled jobs (via automatic leader election with heartbeat and cross-tab detection) to prevent duplicates.

Run **Chief of Staff: Show Scheduled Jobs** from the command palette to inspect current jobs in the browser console.

### Keeping jobs current

Recurring jobs and skills can drift out of sync with how you actually work. Chief of Staff tracks a `lastReviewed` timestamp on each enabled `cron`/`interval` job (one-shot `once`/`reminder` jobs are excluded — they don't meaningfully drift) and a `Last reviewed::` attribute on each skill block. When items pass the configurable **Staleness Warning Threshold** (default 30 days, set in Settings), a once-per-day startup toast lists what needs attention. To mark something as current after reviewing it:

- Skills: `cos_review_skill skill_name "Weekly Review"` — writes/updates a `Last reviewed:: [[today]]` block on the skill, walking the entire subtree to update an existing marker rather than creating a duplicate.
- Cron jobs: `cos_review_cron with job_id <id>` — stamps the job's `lastReviewed` timestamp (find the ID via `cos_cron_list`).

On first install after upgrading, existing skills and jobs are grandfathered for one full staleness window so you don't get a wall of warnings on day one.

---

## Security

Chief of Staff is an AI agent with broad access to your Roam graph and, optionally, to external services like Gmail and Google Calendar. That access demands careful safety engineering. The extension has been through a structured security audit against seven industry frameworks — the OWASP Top 10 for Agentic Applications, OWASP Agentic AI Threats & Mitigations, the Google Secure AI Agents Whitepaper, NIST AI Agent Standards Initiative, and MITRE ATLAS — calibrated for its actual threat model: a single-user browser extension with no server-side state, no multi-tenancy, and no filesystem access.

A collated security reference framework (synthesising OWASP Top 10 for LLM Applications, Google Secure AI Framework, NIST AI RMF, and MITRE ATLAS) is in [`security/ai-agent-security-reference.md`](security/ai-agent-security-reference.md), with the corresponding compliance assessment in [`security/ai-agent-security-reference-compliance.md`](security/ai-agent-security-reference-compliance.md).

### What the extension does to protect your data

**Human-in-the-loop by default.** Every mutating operation — creating, modifying, or deleting blocks; sending emails; creating calendar events — requires explicit approval via a confirmation toast before it executes. Approvals are scoped per request: each new prompt starts with a clean slate, so approvals granted during one request never carry over to the next. Within a single agent run, the first write to a given page requires confirmation and subsequent writes to the same page are auto-approved to reduce prompt fatigue. A separate approval is required for each new page. Rate limits cap tool calls at 4 per LLM response and 5 per tool per agent run, preventing runaway loops.

**Read-only inbox processing.** Blocks dropped into `Chief of Staff/Inbox` are processed with a restricted tool allowlist. The assistant can search, read, and gather information, but cannot create, update, move, or delete anything. This is enforced at both the tool-filter layer (the LLM never sees mutating tools) and the dispatch layer (defence-in-depth guard).

**Prompt injection defence.** Content from external sources (emails, calendar events, MCP tool results, memory pages, Composio responses) is wrapped in `<untrusted>` boundary tags with explicit instructions to the LLM to treat it as data, not instructions. A semantic injection scanner checks all untrusted content against 15 pattern categories (instruction overrides, role assumption, authority claims, output manipulation, tool coercion) and annotates flagged content with an in-context warning. A separate Unicode layer detects homoglyph attacks — mixed-script tokens where Cyrillic or Greek letters are substituted for Latin lookalikes (e.g. `gіthub.com` with Cyrillic U+0456), along with invisible zero-width and bidi-override characters — and flags them in the same warning banner, catching typosquatting payloads that would bypass semantic pattern matching. On user chat messages, the homoglyph layer instead hard-stops the request before any LLM call and asks the user to verify the exact string, because downstream LLM reasoning has been observed to silently normalise or even hallucinate new homoglyphs in outbound tool arguments. Provider-specific boundary tags are neutralised before content enters the prompt, preventing delimiter breakout attacks.

**Memory poisoning defence.** Because memory content is loaded into every system prompt, it is a high-value target for persistent injection. All memory writes are scanned against 28 pattern categories (15 general injection + 13 memory-specific, covering directive language, approval bypass, hidden instruction embedding, data exfiltration, and tool manipulation). Flagged content is blocked before the write occurs, and the LLM receives an error with guidance to reformulate. This works in concert with the approval gate — even if the patterns were evaded, the user still confirms every memory write.

**System prompt confidentiality.** The system prompt contains detailed architectural information. A confidentiality directive instructs the LLM to decline extraction attempts regardless of framing. An output-side guard scans every response against 38 distinctive fingerprint phrases; if three or more match, the response is replaced with a safe refusal.

**PII scrubbing.** An opt-in layer (enabled by default) intercepts all outbound LLM API calls and redacts email addresses, phone numbers, SSNs, credit card numbers (Luhn-validated), IBANs, Medicare numbers, TFNs, and public IP addresses before content leaves the browser. This can be toggled off in settings if your workflow requires full fidelity.

**Three-layer claimed-action mitigation.** Some models (especially smaller/faster tiers) occasionally generate text claiming an action was performed without actually issuing a tool call. Chief of Staff detects and recovers from this automatically via three layers working in concert. *Layer 1 — Detection + retry nudge:* a pattern-matching guard (`detectClaimedActionWithoutToolCall`) checks every assistant response against static action-claim patterns, tool-specific claim patterns (e.g. Focus Mode state, OCR results, definitions), and dynamic patterns built from the names of all currently registered tools. On detection, the assistant is given a targeted retry message naming the specific tool it should call, and recovers on the next attempt. *Layer 2 — Context hygiene:* if the model hallucinated in a prior turn, those poisoned conversation entries are sanitised before the next LLM call, breaking the feedback loop that would otherwise teach the model to repeat text-only responses. *Layer 3 — Tier escalation:* if the same session sees repeated hallucinations on the mini tier, the extension automatically escalates to the power tier (e.g. gemini-3.1-flash-lite-preview → gemini-3-flash-preview), which succeeds immediately. A separate fabrication guard detects long responses about external data produced without any tool call, forcing a retry with real results. A key validation guard rejects display names and path-style values in parameters that expect identifiers, catching a common LLM mistake before it wastes an API round-trip.

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

**Remote MCP servers.** Tool call payloads are sent directly to the remote server's URL (via Roam's built-in CORS proxy when available). Auth tokens are included in request headers and are stored locally in Roam Depot — they are never sent to any other service.

**What is never sent.** Your full graph is never transmitted. The assistant reads specific blocks via Roam's local API and includes only the relevant results in the LLM context. Your API keys are sent only to their respective provider endpoints (built-in providers, custom OpenAI-compatible endpoints you've configured, MCP servers, Composio), never to any other party. Custom-endpoint base URLs are user-controlled — if you set a custom slot's base URL to your own server, only your server receives those requests.

### What the extension does not protect against

**User-approved destructive actions.** The biggest realistic risk is approving something you shouldn't. The extension shows you what it intends to do before it does it, but if you confirm a deletion or an email send, it will execute. Review approval toasts carefully, especially for unfamiliar operations. `/undo` reverses the assistant's last batch of block creations and edits; Roam's built-in undo and daily backups cover the rest.

**Determined adversarial content.** Pattern-based injection detection cannot catch every possible encoding of a malicious instruction. A sufficiently creative attacker who can get content into your graph (via a shared page, an imported file, or an email body) could theoretically craft a payload that evades all 28 injection patterns (15 general + 13 memory-specific) and the Unicode homoglyph layer while still influencing the LLM's behaviour. The boundary wrapping and approval gating provide additional layers, but no detection system is perfect.

**API key security at rest.** Keys are stored in browser IndexedDB in plaintext. Any browser extension with storage access, or anyone with physical access to your machine, could read them. Do not use Chief of Staff on shared or public computers, and do not install untrusted browser extensions alongside it.

### Dry-run mode

If you want to see what the assistant would do before it does anything, enable **Dry Run** in settings. The next mutating operation will be simulated without executing. The toggle disables itself after one use.

### MCP supply chain security

When you connect a Local MCP server, Chief of Staff automatically logs the connection to `[[Chief of Staff/MCP Servers]]` in your Roam graph. Each entry records the server name, tool count, trust status, schema hash, and last connection date. On first connection the tool schema is pinned (SHA-256 hash); on subsequent connections the schema is compared against the pin and any drift (added, removed, or modified tools) is flagged. Tool descriptions are scanned against 14 injection pattern categories before the tools are made available to the agent. Review your `[[Chief of Staff/MCP Servers]]` page periodically to verify that connected servers and their tool inventories match your expectations.

### AI Bill of Materials (AIBOM)

Chief of Staff generates an AI Bill of Materials in CycloneDX 1.6 format. A static build-time artifact (`artifacts/aibom-static.cdx.json`) is produced by the CI pipeline and catalogues all npm dependencies plus declared AI model components. At runtime, a live snapshot is written to `[[Chief of Staff/AIBOM]]` in your Roam graph, capturing your specific configuration: which LLM providers and models are active, which MCP servers are connected, which Composio tools are installed, and which extension tool registrations are present. This page updates automatically as your configuration changes. Review it to understand exactly what components your instance of Chief of Staff is using.

### Reporting security issues

If you discover a security issue, please report it directly rather than filing a public issue (so you don't expose secure information). Send a direct message to me on the [Roam Research Slack channel](https://app.slack.com/client/TNEAEL9QW/dms).

---

## Limitations and performance considerations

- **Graph scans** — task search queries scan all blocks in your graph that match TODO/DONE patterns. Performance scales with graph size. On very large graphs (100k+ blocks) this may take a second or two.
- **Agent iterations** — the reasoning loop is capped by **Agent max iterations** (default 20; range 10–40). Skills use **Skill max iterations** (default 16). Multi-write graph-edit intents auto-boost the chat cap to at least 32.
- **Conversation context** — the assistant retains up to 12 recent turns (truncated to 500 user / 2,000 assistant characters each) for follow-up context. Older turns are dropped automatically. Within a single agent run, tool result payloads are progressively trimmed if the message budget (70,000 characters) is exceeded. Key references (identifiers from MCP tool results) are extracted and stored at the front of assistant turns to survive truncation.
- **Composio dependency** — external tool features (Gmail, Google Calendar, Todoist, etc.) require an active Composio connection. Roam graph and task features work fully without Composio.
- **LLM API costs** — requests are sent directly from your browser to your configured provider. Costs are billed to your API account. Structured briefings, multi-tool agent runs, and scheduled jobs consume more tokens than simple queries. The chat panel shows a running cost estimate with per-model breakdowns — for Anthropic, this includes a cache breakdown showing how many input tokens were served from cache. **Note:** displayed costs are estimates based on hardcoded per-model rates and may not reflect current provider pricing. Always check your provider's billing dashboard for authoritative usage and charges.
- **Prompt caching** — the extension is structured to maximise cache hits across all providers. The system prompt and tool definitions (the largest, most stable token blocks) are placed at the start of every request, and variable content (conversation history, user message) comes last. For **Anthropic**, explicit `cache_control` breakpoints mark the system prompt and tool definitions as cacheable — after the first call in a session, subsequent calls serve these tokens from cache at 90% off the normal input price. For **OpenAI**, automatic prefix caching applies without opt-in as long as the prompt prefix is stable across calls, which this layout ensures. For **Gemini** and **Mistral**, the stable-prefix ordering provides the best conditions for any future caching support. With caching reducing input costs by up to 90%, output tokens become the dominant expense — use the **Response Verbosity** setting to control this directly.
- **Scheduled job execution** — scheduled jobs require at least one Roam tab to be open. If all tabs are closed, jobs will not fire until a tab is reopened. Only one tab executes jobs at a time (automatic leader election).
