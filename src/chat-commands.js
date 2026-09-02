/**
 * chat-commands.js — display registry for chat-panel slash commands.
 *
 * Pure leaf module (no DOM, no deps) shared by the `/` autocomplete menu
 * (chat-panel.js) and the `/help` summary (deterministic-router.js) so the two
 * discovery surfaces can't drift. This is DISPLAY ONLY — command dispatch still
 * lives in the send handler (chat-panel.js) and askChiefOfStaff (index.js);
 * their exact-match vs inline-anywhere semantics are intentionally not unified.
 *
 * `kind` distinguishes the two dispatch styles for the autocomplete:
 *   - "command" — standalone, typed at the start of an otherwise-empty input
 *     (`/export`, `/undo`). Offered only by the first-position menu.
 *   - "flag" — inline modifier that can ride along with a message
 *     ("summarise my week /power"). Offered by both the first-position menu
 *     and the mid-message menu that fires on a trailing `/token`.
 *
 * `/allow-homoglyph` is deliberately omitted — it's a niche safety-bypass flag
 * we don't want to surface for discovery (it still works via the flag parser).
 */

// Display order = menu order, roughly most-useful first.
export const CHAT_COMMANDS = [
  { name: "/plan", kind: "flag", summary: "Draft a read-only plan, then approve before executing" },
  { name: "/export", kind: "command", summary: "Save this chat to today's page (add /tag Name to tag it)" },
  { name: "/undo", kind: "command", summary: "Reverse the changes I made in my last run" },
  { name: "/why", kind: "command", summary: "Explain how I produced my last response" },
  { name: "/status", kind: "command", summary: "Show connections, scheduled jobs, and pending state" },
  { name: "/verify", kind: "command", summary: "Score my last response with an independent judge" },
  { name: "/clear", kind: "command", aliases: ["/new"], summary: "Clear the chat and start fresh" },
  { name: "/compact", kind: "command", summary: "Summarise older turns to free up context" },
  { name: "/help", kind: "command", summary: "Show what I can do" },
  { name: "/doctor", kind: "command", summary: "Run a health check on keys, MCP, memory, skills, cron" },
  { name: "/lesson", kind: "flag", summary: "Record lessons from this chat (add a topic to focus)" },
  { name: "/power", kind: "flag", summary: "Use a more capable model for this message" },
  { name: "/ludicrous", kind: "flag", summary: "Use the most capable model for this message" },
  // Providers are peers with no usefulness ranking — alphabetical for tidiness.
  { name: "/claude", kind: "flag", summary: "Force the Anthropic provider for this message" },
  { name: "/gemini", kind: "flag", summary: "Force the Google Gemini provider for this message" },
  { name: "/grok", kind: "flag", summary: "Force the Grok (xAI) provider for this message" },
  { name: "/groq", kind: "flag", summary: "Force the Groq provider for this message" },
  { name: "/kimi", kind: "flag", summary: "Force the Kimi (Moonshot) provider for this message" },
  { name: "/kimi-code", kind: "flag", summary: "Force the Kimi Code (kimi.com/code) provider for this message" },
  { name: "/deepseek", kind: "flag", summary: "Force the DeepSeek provider for this message" },
  { name: "/ollama", kind: "flag", summary: "Force the Ollama (Cloud or local) provider for this message" },
  { name: "/mistral", kind: "flag", summary: "Force the Mistral provider for this message" },
  { name: "/openai", kind: "flag", summary: "Force the OpenAI provider for this message" },
];

// Tokens that dispatch somewhere real but are deliberately NOT in the display
// registry: the hidden safety-bypass flag and /export's tag subcommand. The
// unknown-command intercept must never block these.
const HIDDEN_COMMAND_TOKENS = new Set(["allow-homoglyph", "tag", "tags"]);

function bareForm(name) {
  return String(name || "").replace(/^\//, "").toLowerCase();
}

function filterCommands(query, predicate) {
  const q = bareForm(query);
  const results = [];
  for (const command of CHAT_COMMANDS) {
    if (predicate && !predicate(command)) continue;
    const names = [command.name, ...(command.aliases || [])];
    if (q === "") {
      results.push({ command, matchedName: command.name });
      continue;
    }
    // First name/alias whose bare form starts with the query.
    const matched = names.find((n) => bareForm(n).startsWith(q));
    if (matched) results.push({ command, matchedName: matched });
  }
  return results;
}

/**
 * Filter the command registry by a typed query (the text after the leading
 * `/`, e.g. "ex" for "/ex" — a leading "/" in the query is tolerated). Prefix-
 * matches, case-insensitively, against each command's name and aliases.
 *
 * @returns {{ command, matchedName }[]} — matchedName is the specific
 *   name/alias that matched, so completion inserts what the user was typing
 *   (e.g. "/ne" → matchedName "/new", not "/clear"). Empty query returns every
 *   command keyed on its canonical name. Order follows CHAT_COMMANDS.
 */
export function filterSlashCommands(query) {
  return filterCommands(query, null);
}

/**
 * Like filterSlashCommands, but only inline flags (kind: "flag") — the subset
 * that makes sense appended to a message. Used by the mid-message menu.
 */
export function filterFlagCommands(query) {
  return filterCommands(query, (c) => c.kind === "flag");
}

/**
 * Detect a trailing `/token` being typed mid-message ("summarise my week /pow").
 * Fires only when there is real content before the token (first-position input
 * is the all-commands menu's case, not this one) and the token is at the very
 * end of the input. The whitespace requirement keeps URLs and paths quiet:
 * "example.com/foo" and "see /tmp/file" never match ("/tmp" alone after a
 * space would, but filterFlagCommands finds nothing and the menu stays shut).
 *
 * @returns {{ query: string } | null}
 */
export function matchTrailingFlagToken(value) {
  const text = String(value || "");
  const match = /\s\/(\w*)$/.exec(text);
  if (!match) return null;
  const before = text.slice(0, match.index).trim();
  if (!before) return null;
  return { query: match[1] };
}

/**
 * True if a bare token (no leading slash) is a real command, alias, or hidden
 * token. Used by the unknown-command intercept to decide whether a lone
 * "/something" message should reach the LLM.
 */
export function isKnownCommandToken(token) {
  const t = bareForm(token);
  if (!t) return false;
  if (HIDDEN_COMMAND_TOKENS.has(t)) return true;
  return CHAT_COMMANDS.some((c) =>
    [c.name, ...(c.aliases || [])].some((n) => bareForm(n) === t)
  );
}

function editDistance(a, b) {
  // Small Levenshtein — command names are short, inputs are capped upstream.
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) {
    const curr = [i];
    for (let j = 1; j <= n; j += 1) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = curr;
  }
  return prev[n];
}

/**
 * Closest registry command for a mistyped token ("/veridy" → "/verify").
 * Prefix matches win first (cheap, catches truncations like "/veri"); then
 * edit distance ≤ 2 against every name and alias. Returns the slash-prefixed
 * matched name, or null when nothing is plausibly close (the caller shows a
 * generic "type / to see commands" instead of a bad guess).
 */
export function findClosestCommand(token) {
  const t = bareForm(token);
  if (!t) return null;
  const prefixMatch = filterSlashCommands(t)[0];
  if (prefixMatch) return prefixMatch.matchedName;
  let best = null;
  let bestDistance = 3; // only suggest within edit distance 2
  for (const command of CHAT_COMMANDS) {
    for (const name of [command.name, ...(command.aliases || [])]) {
      const distance = editDistance(t, bareForm(name));
      if (distance < bestDistance) {
        bestDistance = distance;
        best = name;
      }
    }
  }
  return best;
}
