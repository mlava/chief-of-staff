import test from "node:test";
import assert from "node:assert/strict";
import { ROAM_CORE_TOOLS } from "../src/roam-native-tools.js";

// A skill's `Tools:` whitelist strips ROAM_ROUTE/ROAM_EXECUTE, so any tool a
// skill declares must be DIRECT (in ROAM_CORE_TOOLS) or it is unreachable at
// run time. The agent loop's `startsWith("cos_")` bypass only admits tools
// already present in the tools array — it cannot pull a routed tool into it.
//
// This silently broke the Skill Assumption Audit: it declared cos_get_skill and
// cos_count_skill_tokens, neither was direct, and the model reported them as
// "not available" rather than fabricating. A blanket cos_ branch in
// resolveToolWhitelist had suppressed the warning that said so.

const SKILL_DECLARED_TOOLS = [
  "cos_get_skill",
  "cos_count_skill_tokens",
  "cos_write_draft_skill",
  "cos_schedule_block",
  "roam_get_page",
];

test("every tool the Skill Assumption Audit declares is a direct (core) tool", () => {
  for (const name of SKILL_DECLARED_TOOLS) {
    assert.ok(
      ROAM_CORE_TOOLS.has(name),
      `"${name}" is declared in a skill's Tools: whitelist but is not in ROAM_CORE_TOOLS — ` +
      `it would be routed behind ROAM_ROUTE/ROAM_EXECUTE, which the whitelist strips, ` +
      `leaving it uncallable during that skill's run.`
    );
  }
});

test("ROAM_CORE_TOOLS still contains the baseline Roam read/write tools", () => {
  for (const name of ["roam_search", "roam_semantic_search", "roam_get_page", "roam_create_page"]) {
    assert.ok(ROAM_CORE_TOOLS.has(name), `${name} must stay direct`);
  }
});

test("ROAM_CORE_TOOLS stays small enough to keep per-call tool tokens bounded", () => {
  // Direct tools are sent on every LLM call. Guardrail against creeping bloat:
  // if this trips, the tool belongs behind ROAM_ROUTE unless a skill declares it.
  assert.ok(ROAM_CORE_TOOLS.size <= 20, `ROAM_CORE_TOOLS has ${ROAM_CORE_TOOLS.size} entries`);
});
