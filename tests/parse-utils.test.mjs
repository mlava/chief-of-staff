import test from "node:test";
import assert from "node:assert/strict";
import {
  extractBalancedJsonObjects,
  extractMcpKeyReference,
} from "../src/parse-utils.js";

// ═════════════════════════════════════════════════════════════════════════════
// extractBalancedJsonObjects
// ═════════════════════════════════════════════════════════════════════════════

test("extractBalancedJsonObjects extracts a single JSON object", () => {
  const result = extractBalancedJsonObjects('{"query":"test"}');
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].parsed, { query: "test" });
  assert.equal(result[0].start, 0);
  assert.equal(result[0].end, 16);
});

test("extractBalancedJsonObjects extracts multiple concatenated objects", () => {
  const input = '{"a":1}{"b":2}{"c":3}';
  const result = extractBalancedJsonObjects(input);
  assert.equal(result.length, 3);
  assert.deepEqual(result[0].parsed, { a: 1 });
  assert.deepEqual(result[1].parsed, { b: 2 });
  assert.deepEqual(result[2].parsed, { c: 3 });
});

test("extractBalancedJsonObjects handles trailing non-JSON text (Gemini bug)", () => {
  const input = '{"query":"test"} I will now search for that.';
  const result = extractBalancedJsonObjects(input);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].parsed, { query: "test" });
});

test("extractBalancedJsonObjects handles leading non-JSON text", () => {
  const input = 'Here is the data: {"key":"value"}';
  const result = extractBalancedJsonObjects(input);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].parsed, { key: "value" });
});

test("extractBalancedJsonObjects handles nested objects", () => {
  const input = '{"outer":{"inner":"value"}}';
  const result = extractBalancedJsonObjects(input);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].parsed, { outer: { inner: "value" } });
});

test("extractBalancedJsonObjects handles escaped quotes in strings", () => {
  const input = '{"text":"He said \\"hello\\""}';
  const result = extractBalancedJsonObjects(input);
  assert.equal(result.length, 1);
  assert.equal(result[0].parsed.text, 'He said "hello"');
});

test("extractBalancedJsonObjects handles braces inside strings", () => {
  const input = '{"text":"{ not a real object }"}';
  const result = extractBalancedJsonObjects(input);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].parsed, { text: "{ not a real object }" });
});

test("extractBalancedJsonObjects returns empty for invalid input", () => {
  assert.deepEqual(extractBalancedJsonObjects(""), []);
  assert.deepEqual(extractBalancedJsonObjects(null), []);
  assert.deepEqual(extractBalancedJsonObjects("no json here"), []);
  assert.deepEqual(extractBalancedJsonObjects("{incomplete"), []);
});

test("extractBalancedJsonObjects skips malformed JSON with balanced braces", () => {
  // Balanced braces but invalid JSON
  const input = '{not: valid json}{"valid":"json"}';
  const result = extractBalancedJsonObjects(input);
  // First object is malformed, should be skipped; second should parse
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].parsed, { valid: "json" });
});

// ═════════════════════════════════════════════════════════════════════════════
// extractMcpKeyReference
// ═════════════════════════════════════════════════════════════════════════════

test("extractMcpKeyReference extracts Name (Key: XYZ) patterns", () => {
  const texts = ["**My Library** (Key: ABC123)"];
  const result = extractMcpKeyReference(texts);
  assert.ok(result.includes("My Library → ABC123"));
  assert.ok(result.startsWith("[Key reference:"));
});

test("extractMcpKeyReference extracts multiple keys from one text block", () => {
  const texts = [
    "**Library A** (Key: AAA)\n**Library B** (Key: BBB)\n**Library C** (Key: CCC)"
  ];
  const result = extractMcpKeyReference(texts);
  assert.ok(result.includes("Library A → AAA"));
  assert.ok(result.includes("Library B → BBB"));
  assert.ok(result.includes("Library C → CCC"));
});

test("extractMcpKeyReference extracts Title/Key patterns", () => {
  const texts = [
    "**Title:** Research Paper on AI\n**Item Key:** `XYZABC`"
  ];
  const result = extractMcpKeyReference(texts);
  assert.ok(result.includes("Research Paper on AI → XYZABC"));
});

test("extractMcpKeyReference deduplicates entries", () => {
  const texts = [
    "**My Lib** (Key: AAA)",
    "**My Lib** (Key: AAA)", // duplicate
  ];
  const result = extractMcpKeyReference(texts);
  // Should only appear once
  const count = (result.match(/My Lib → AAA/g) || []).length;
  assert.equal(count, 1);
});

test("extractMcpKeyReference returns empty string when no matches", () => {
  assert.equal(extractMcpKeyReference(["no keys here"]), "");
  assert.equal(extractMcpKeyReference([]), "");
  assert.equal(extractMcpKeyReference(null), "");
});

test("extractMcpKeyReference caps at 50 entries", () => {
  const texts = [];
  for (let i = 0; i < 60; i++) {
    texts.push(`**Item${i}** (Key: KEY${i})`);
  }
  const result = extractMcpKeyReference(texts);
  // Count entries by semicolons + 1
  const entries = result.replace("[Key reference: ", "").replace("]", "").split("; ");
  assert.equal(entries.length, 50);
});

test("extractMcpKeyReference combines results from multiple text blocks", () => {
  const texts = [
    "**Lib A** (Key: AAA)",
    "**Lib B** (Key: BBB)",
  ];
  const result = extractMcpKeyReference(texts);
  assert.ok(result.includes("Lib A → AAA"));
  assert.ok(result.includes("Lib B → BBB"));
});

test("extractMcpKeyReference skips null entries in the array", () => {
  const texts = [null, "**Valid** (Key: VLD)", undefined, ""];
  const result = extractMcpKeyReference(texts);
  assert.ok(result.includes("Valid → VLD"));
});
