import test from "node:test";
import assert from "node:assert/strict";
import { ONBOARDING_STEPS, detectProvider } from "../src/onboarding/onboarding-steps.jsx";

// NOTE: render() functions need a DOM and cannot run under node — these tests
// cover the pure parts: provider detection, step ordering, and skip logic.

// ── detectProvider ───────────────────────────────────────────────────────────

test("detectProvider identifies keys by prefix", () => {
  assert.equal(detectProvider("sk-ant-api03-xyz"), "anthropic");
  assert.equal(detectProvider("sk-proj-xyz"), "openai");
  assert.equal(detectProvider("AIzaSyExample"), "gemini");
  assert.equal(detectProvider("gsk_example"), "groq");
});

test("detectProvider prefers the more specific sk-ant- prefix over sk-", () => {
  assert.equal(detectProvider("sk-ant-anything"), "anthropic");
});

test("detectProvider returns null for unrecognised or empty input", () => {
  assert.equal(detectProvider("random-key"), null); // e.g. Mistral — no distinctive prefix
  assert.equal(detectProvider(""), null);
  assert.equal(detectProvider(null), null);
  assert.equal(detectProvider(undefined), null);
});

// ── ONBOARDING_STEPS contract ────────────────────────────────────────────────

// loadOnboardingState in onboarding.js resumes by hardcoded index — these
// invariants are what it relies on.
test("ONBOARDING_STEPS keeps the resume-logic contract", () => {
  assert.equal(ONBOARDING_STEPS.length, 12);
  assert.equal(ONBOARDING_STEPS[0].id, "welcome");
  assert.equal(ONBOARDING_STEPS[2].id, "api-key");
  assert.equal(ONBOARDING_STEPS[11].id, "finish");
});

// ── api-key step skip logic ──────────────────────────────────────────────────

test("api-key step skips iff any LLM path is configured", () => {
  const step = ONBOARDING_STEPS.find((s) => s.id === "api-key");
  const ctx = (configured) => ({
    extensionAPI: {},
    deps: { hasAnyLlmConfigured: () => configured },
  });
  assert.equal(!!step.skipIf(ctx(true)), true);
  assert.equal(!!step.skipIf(ctx(false)), false);
});

test("api-key step does not skip when the helper is missing from deps", () => {
  const step = ONBOARDING_STEPS.find((s) => s.id === "api-key");
  assert.equal(!!step.skipIf({ extensionAPI: {}, deps: {} }), false);
});
