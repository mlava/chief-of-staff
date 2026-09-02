/**
 * Detect multi-step graph-edit intents (rearrange a list, fill an outline,
 * migrate many children, etc.). Used to suppress the one-write short-circuit
 * and to raise the chat iteration cap. Pure helpers — no deps.
 */

const MW_WRITE_VERB =
  /\b(?:add|append|create|insert|write|move|shift|copy|migrate|nest|indent|rearrange|re-?arrange|reorder|re-?order|sort|reorganis\w*|reorganiz\w*|restructur\w*|fill|flesh\s+out|expand|split|merge|consolidat\w*|turn|convert|clean\s+up|tidy)\b/i;

const MW_MULTI_TARGET =
  /\b(?:all\s+of\s+(?:these|them|the)|multiple|several|many|remaining|the\s+rest\s+of|each|every)\b[\s\S]{0,60}?\b(?:blocks?|todos?|tasks?|items?|entries|lines|sections?|bullets?|children|steps?|notes?|pages?)\b/i;

const MW_REORDER_TARGET =
  /\b(?:rearrange|re-?arrange|reorder|re-?order|reorganis\w*|reorganiz\w*|restructur\w*|sort)\b[\s\S]{0,40}?\b(?:list|items?|todos?|tasks?|entries|order|sequence|page|outline)\b/i;

const MW_MID_INSERT =
  /\binsert\b[\s\S]{0,120}?\b(?:into|in|after|before|between)\b[\s\S]{0,80}?\b(?:list|order|sequence|outline|page|section|existing)\b/i;

const MW_OUTLINE_FILL =
  /\b(?:fill|flesh\s+out|expand|complete|finish)\b[\s\S]{0,40}?\boutline\b/i;

const MW_CHILDREN_MOVE =
  /\b(?:migrate|move|copy|consolidat\w*)\b[\s\S]{0,60}?\bchildren\b/i;

// "move existing TODOs / items / blocks" — common rearrange phrasing without
// an explicit "many/all/each" quantifier.
const MW_EXISTING_MOVE =
  /\b(?:move|shift)\b[\s\S]{0,80}?\b(?:existing\s+)?(?:todos?|tasks?|items?|blocks?)\b/i;

/**
 * True when the user asked for a multi-step graph edit.
 * Verb × plural-target (or a dedicated reorder/insert/outline/children pattern)
 * so read-only questions like "how many todos" stay false.
 */
export function isMultiWriteGraphIntent(text) {
  const raw = String(text || "");
  if (!raw.trim()) return false;
  if (MW_REORDER_TARGET.test(raw)) return true;
  if (MW_MID_INSERT.test(raw)) return true;
  if (MW_OUTLINE_FILL.test(raw)) return true;
  if (MW_CHILDREN_MOVE.test(raw)) return true;
  if (MW_EXISTING_MOVE.test(raw)) return true;
  if (MW_WRITE_VERB.test(raw) && MW_MULTI_TARGET.test(raw)) return true;
  if (/\brearrange\s*\/\s*move\b/i.test(raw)) return true;
  return false;
}

/**
 * Raise the iteration cap for multi-write rearrange runs.
 * Weaker models often spend one iteration per tool call.
 *   - base below minBoost → minBoost
 *   - base already higher → keep base
 *   - never above hardCap (default 40)
 */
export function resolveMultiWriteMaxIterations(baseMax, { minBoost = 32, hardCap = 40 } = {}) {
  const base = Number.isFinite(Number(baseMax)) ? Math.floor(Number(baseMax)) : 20;
  const floor = Number.isFinite(Number(minBoost)) ? Math.floor(Number(minBoost)) : 32;
  const cap = Number.isFinite(Number(hardCap)) ? Math.floor(Number(hardCap)) : 40;
  return Math.min(cap, Math.max(base, floor));
}
