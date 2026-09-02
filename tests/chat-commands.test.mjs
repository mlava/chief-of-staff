import test from "node:test";
import assert from "node:assert/strict";
import {
  CHAT_COMMANDS,
  filterSlashCommands,
  filterFlagCommands,
  matchTrailingFlagToken,
  isKnownCommandToken,
  findClosestCommand,
} from "../src/chat-commands.js";

// ── Registry shape ────────────────────────────────────────────────────────────

test("every command has a slash-prefixed name, a kind, and a non-empty summary", () => {
  assert.ok(CHAT_COMMANDS.length > 0);
  for (const c of CHAT_COMMANDS) {
    assert.match(c.name, /^\/\w/, `name should start with /: ${c.name}`);
    assert.ok(["command", "flag"].includes(c.kind), `kind missing/invalid for ${c.name}`);
    assert.equal(typeof c.summary, "string");
    assert.ok(c.summary.trim().length > 0, `summary missing for ${c.name}`);
    if (c.aliases) assert.ok(Array.isArray(c.aliases));
  }
});

test("registry does not surface /allow-homoglyph", () => {
  const names = CHAT_COMMANDS.flatMap((c) => [c.name, ...(c.aliases || [])]);
  assert.ok(!names.includes("/allow-homoglyph"));
});

// ── filterSlashCommands ───────────────────────────────────────────────────────

test("empty query returns every command keyed on its canonical name", () => {
  const all = filterSlashCommands("");
  assert.equal(all.length, CHAT_COMMANDS.length);
  assert.equal(all[0].matchedName, all[0].command.name);
});

test("prefix match returns all commands starting with the query", () => {
  const p = filterSlashCommands("p").map((r) => r.matchedName);
  assert.ok(p.includes("/plan"));
  assert.ok(p.includes("/power"));
  assert.ok(!p.includes("/clear"));
});

test("prefix narrows to a single command", () => {
  const ex = filterSlashCommands("ex");
  assert.equal(ex.length, 1);
  assert.equal(ex[0].matchedName, "/export");
});

test("alias match reports the alias as matchedName, not the canonical name", () => {
  const ne = filterSlashCommands("ne");
  assert.equal(ne.length, 1);
  assert.equal(ne[0].command.name, "/clear");
  assert.equal(ne[0].matchedName, "/new");
});

test("canonical name matches by its own prefix (not just via alias)", () => {
  // "cl" matches both /clear and /claude — assert /clear is present via its name.
  const names = filterSlashCommands("cl").map((r) => r.matchedName);
  assert.ok(names.includes("/clear"));
  assert.ok(names.includes("/claude"));
});

test("match is case-insensitive", () => {
  assert.equal(filterSlashCommands("EX")[0].matchedName, "/export");
  assert.equal(filterSlashCommands("Plan")[0].matchedName, "/plan");
});

test("a leading slash in the query is tolerated", () => {
  assert.equal(filterSlashCommands("/ex")[0].matchedName, "/export");
});

test("no match returns an empty array", () => {
  assert.deepEqual(filterSlashCommands("zzz"), []);
});

test("null / undefined query behave like empty", () => {
  assert.equal(filterSlashCommands(null).length, CHAT_COMMANDS.length);
  assert.equal(filterSlashCommands(undefined).length, CHAT_COMMANDS.length);
});

// ── filterFlagCommands (#135) ─────────────────────────────────────────────────

test("filterFlagCommands returns only flag-kind commands", () => {
  const all = filterFlagCommands("");
  assert.ok(all.length > 0);
  for (const r of all) assert.equal(r.command.kind, "flag");
  const names = all.map((r) => r.matchedName);
  assert.ok(names.includes("/power"));
  assert.ok(names.includes("/plan"));
  assert.ok(!names.includes("/export"));
  assert.ok(!names.includes("/clear"));
});

test("filterFlagCommands prefix-narrows like the full filter", () => {
  const p = filterFlagCommands("po");
  assert.equal(p.length, 1);
  assert.equal(p[0].matchedName, "/power");
});

// ── matchTrailingFlagToken (#135) ─────────────────────────────────────────────

test("trailing flag token fires mid-message with content before it", () => {
  assert.deepEqual(matchTrailingFlagToken("summarise my week /pow"), { query: "pow" });
  assert.deepEqual(matchTrailingFlagToken("do the thing /"), { query: "" });
});

test("first-position input is not a trailing flag (that's the all-commands menu)", () => {
  assert.equal(matchTrailingFlagToken("/pow"), null);
  assert.equal(matchTrailingFlagToken("/"), null);
});

test("whitespace-only content before the token does not fire", () => {
  assert.equal(matchTrailingFlagToken("  /pow"), null);
});

test("URLs and paths never fire", () => {
  assert.equal(matchTrailingFlagToken("check https://example.com/foo"), null);
  assert.equal(matchTrailingFlagToken("rate this 7/10"), null);
});

test("token not at the end does not fire", () => {
  assert.equal(matchTrailingFlagToken("summarise /power my week"), null);
});

// ── isKnownCommandToken ──────────────────────────────────────────────────────

test("registry names, aliases, and hidden tokens are known", () => {
  assert.ok(isKnownCommandToken("power"));
  assert.ok(isKnownCommandToken("/verify"));
  assert.ok(isKnownCommandToken("new"));            // alias of /clear
  assert.ok(isKnownCommandToken("allow-homoglyph")); // hidden safety flag
  assert.ok(isKnownCommandToken("tag"));             // /export subcommand
  assert.ok(isKnownCommandToken("TAGS"));            // case-insensitive
});
test("grok and kimi are flag-kind provider commands", () => {
  const flags = CHAT_COMMANDS.filter((c) => c.kind === "flag").map((c) => c.name);
  assert.ok(flags.includes("/grok"));
  assert.ok(flags.includes("/kimi"));
  assert.ok(isKnownCommandToken("grok"));
  assert.ok(isKnownCommandToken("kimi"));
});

test("kimi-code, deepseek, ollama are flag-kind provider commands", () => {
  const flags = CHAT_COMMANDS.filter((c) => c.kind === "flag").map((c) => c.name);
  assert.ok(flags.includes("/kimi-code"));
  assert.ok(flags.includes("/deepseek"));
  assert.ok(flags.includes("/ollama"));
  assert.ok(isKnownCommandToken("kimi-code"));
  assert.ok(isKnownCommandToken("deepseek"));
  assert.ok(isKnownCommandToken("ollama"));
});

test("unknown and empty tokens are not known", () => {
  assert.ok(!isKnownCommandToken("veridy"));
  assert.ok(!isKnownCommandToken("frobnicate"));
  assert.ok(!isKnownCommandToken(""));
  assert.ok(!isKnownCommandToken(null));
});

// ── findClosestCommand (did-you-mean) ────────────────────────────────────────

test("typo within edit distance 2 suggests the right command", () => {
  assert.equal(findClosestCommand("veridy"), "/verify");
  assert.equal(findClosestCommand("stauts"), "/status");
  assert.equal(findClosestCommand("exprot"), "/export");
});

test("truncation suggests via prefix match", () => {
  assert.equal(findClosestCommand("veri"), "/verify");
  assert.equal(findClosestCommand("und"), "/undo");
});

test("alias typos suggest the alias", () => {
  assert.equal(findClosestCommand("nwe"), "/new");
});

test("nothing plausibly close returns null", () => {
  assert.equal(findClosestCommand("frobnicate"), null);
  assert.equal(findClosestCommand(""), null);
});
