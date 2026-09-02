// schedule-block.js — cos_schedule_block: deterministic TimeBlock slot writer.
//
// The slot grammar `HH:MM - HH:MM (**N'**) ((task-uid))` lives HERE, in code,
// not in prose. Any LLM that can call tools extracts {date, start, end, title}
// and this tool writes the line. Midnight wrap: end <= start means the slot
// crosses midnight, and the written string never contains "24:00".
//
// Pure helpers (formatting, parsing, overlap, chronological ordering) take
// plain values; graph access goes through the injected `deps` the rest of
// the COS tools already use.

const TIME_RE = /^(\d{1,2}):(\d{2})$/;
// `HH:MM - HH:MM` then optional `(**N'**)` then the rest (ref or event text).
const SLOT_LINE_RE = /^\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*(?:\(\*\*(\d+)'\*\*\)\s*)?(.*)$/;
const BLOCK_REF_RE = /\(\(([^()\s]+)\)\)/;

const NAUTILUS_MARKER = "roam-render-Nautilus-Log-cljs";
// Runtime stamp so a hosted-URL install can prove this build (grep extension.js / window).
export const COS_SCHEDULE_BLOCK_BUILD = "20260829-overlap-allow";
const COLLISION_REFUSE_SUFFIX = " Reply overlap or allow overlapping timed blocks to keep both, move 21:00-23:00 to shift the existing timed block, or pick a different time.";
const COLLISION_ASK_SUFFIX = " Ask the user: overlap or allow overlapping timed blocks to keep both, move 21:00-23:00 to shift the existing timed block, or pick a different time.";
const MOVE_CLOCKS_HINT = "Say move 21:00-23:00 to shift the existing timed block.";
const SMARTBLOCK_MARKER = "SmartBlock:Double timestamp buttons2";
const CHILD_PULL_PATTERN = "[:block/uid {:block/children [:block/uid :block/string :block/order]}]";
const ENTITY_PULL_PATTERN = "[:block/uid :node/title]";
const DEFAULT_SANDBOX_PAGE = "COS Daily Plan Sandbox";
/** True when the user message carries the [sandbox] pin (case-insensitive). */
export function isSandboxUserMessage(text) {
  return /\[sandbox\]/i.test(String(text || ""));
}

// ── User-text clocks ─────────────────────────────────────────────────────────
// The user's own words are the source of truth for start/end: models routinely
// mis-convert "9pm" or invent a 3-hour block. These parsers pull the times out
// of the raw user text so the executor can overwrite the model's args.

const FLEX_TIME_RE = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i;
// Tokeniser for times inside free text. Order matters: meridiem-bearing and
// HH:MM forms before the bare-hour fallback. A meridiem may follow a space
// ("9:00 pm"). `\b` keeps "180" or "2026" from matching as bare hours.
const TIME_TOKEN_GLOBAL_RE = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b\d{1,2}:\d{2}\b|\b\d{1,2}\b|\bmidnight\b|\bnoon\b/gi;

/**
 * Parse one time token to "HH:MM" (24-hour), or null.
 * "9pm"/"9:00 pm" → "21:00", "midnight"/"12am" → "00:00", "noon"/"12pm" → "12:00",
 * "21:00"/"6:15" → zero-padded as-is, "24:00" → "00:00", "9:5" → null.
 */
export function parseFlexibleTime(token) {
  const raw = String(token || "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "midnight") return "00:00";
  if (raw === "noon") return "12:00";
  const m = FLEX_TIME_RE.exec(raw);
  if (!m) return null;
  let hours = Number(m[1]);
  const mins = m[2] != null ? Number(m[2]) : 0;
  const meridiem = m[3] ? m[3].toLowerCase() : null;
  if (mins > 59) return null;
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    hours = meridiem === "am" ? hours % 12 : (hours % 12) + 12;
  } else {
    if (hours > 24 || (hours === 24 && mins !== 0)) return null;
    if (hours === 24) hours = 0; // end-of-day wrap, same as normalizeTime
  }
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

// Title filler stripped along with the time tokens. Anything left after that
// is the slot title. book/plan are intentionally omitted (would mangle "book club").
const TITLE_NOISE_RE = /\b(schedule[ds]?|block\s+out|carve\s+out|set\s+aside|slot\s+in|timebox|add|put|place|drop|from|to|until|at)\b/gi;

const DURATION_RE = /\b(\d+)\s*(hours?|hrs?|mins?|minutes?)\b/i;

/**
 * Pull {start, end, title} out of the raw user text. Two times in order are
 * start/end; a token without a meridiem inherits one from a sibling token
 * ("6-7am" → 06:00/07:00, "9pm to midnight" → 21:00/00:00). Missing keys are
 * omitted; title falls back to "Timed block".
 */
function isBareHourToken(raw) {
  return /^\d{1,2}$/.test(String(raw || "").trim());
}

function isDashAdjacentTime(text, index, length) {
  let i = index - 1;
  while (i >= 0 && text[i] === " ") i--;
  if (i >= 0 && text[i] === "-") return true;
  let j = index + length;
  while (j < text.length && text[j] === " ") j++;
  return j < text.length && text[j] === "-";
}

function isDurationNumber(text, index, length) {
  const after = text.slice(index + length);
  return /^\s*-?\s*(?:hours?|hrs?|mins?|minutes?)\b/i.test(after);
}

function isFromToUntilAdjacentTime(text, index, length) {
  const before = text.slice(0, index);
  if (/\b(?:from|to|until)\s*$/i.test(before)) return true;
  const after = text.slice(index + length);
  return /^\s*(?:to|until)\b/i.test(after);
}

function parseDurationMinutes(text) {
  const m = DURATION_RE.exec(String(text || ""));
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = m[2].toLowerCase();
  if (/^min/.test(unit)) return n;
  return n * 60;
}

function addMinutesToTime(time, minutes) {
  const total = toMinutes(time);
  if (total == null) return null;
  const wrapped = (total + minutes) % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function parseScheduleFieldsFromUserText(text) {
  const raw = String(text || "");
  const tokens = [];
  const re = new RegExp(TIME_TOKEN_GLOBAL_RE.source, "gi");
  let m;
  while ((m = re.exec(raw)) !== null) tokens.push({ raw: m[0], index: m.index });

  const kept = tokens.filter((t) => {
    const trimmed = t.raw.trim();
    if (!isBareHourToken(trimmed)) return true;
    if (isDurationNumber(raw, t.index, t.raw.length)) return false;
    return isDashAdjacentTime(raw, t.index, t.raw.length)
      || isFromToUntilAdjacentTime(raw, t.index, t.raw.length);
  });

  // Meridiem inheritance: "6-7am" gives the bare "6" the "am" from "7am".
  // Colon tokens (already 24-hour) and midnight/noon never inherit.
  const meridiem = kept
    .map((t) => /(am|pm)\b/i.exec(t.raw))
    .find(Boolean)?.[1]?.toLowerCase() || null;
  const parsed = [];
  for (const t of kept) {
    let token = t.raw;
    if (meridiem && !/(am|pm)\b/i.test(token) && !/:/.test(token) && !/^(midnight|noon)$/i.test(token.trim())) {
      token = `${token.trim()}${meridiem}`;
    }
    const time = parseFlexibleTime(token);
    if (time) parsed.push(time);
  }

  const out = {};
  if (parsed.length >= 1) out.start = parsed[0];
  if (parsed.length >= 2) out.end = parsed[1];
  if (parsed.length === 1 && !out.end) {
    const durMins = parseDurationMinutes(raw);
    if (durMins != null) out.end = addMinutesToTime(parsed[0], durMins);
  }

  // Title: the words left after cutting the time spans, [sandbox], and
  // skill-name prefixes such as "HQ Today:" (a graph-local skill label, not
  // a required COS skill).
  // and the scheduling verbs.
  let title = "";
  let cursor = 0;
  for (const t of kept) {
    title += raw.slice(cursor, t.index);
    cursor = t.index + t.raw.length;
  }
  title += raw.slice(cursor);
  title = title
    .replace(/\[sandbox\]/gi, " ")
    .replace(/HQ Today:/gi, " ")
    .replace(TITLE_NOISE_RE, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s-]+|[\s-]+$/g, "")
    .trim();
  out.title = title || "Timed block";
  return out;
}

/**
 * Pin the daily page from today/tonight/tomorrow in user text, or null.
 */
export function parseDatePinFromUserText(text, now = new Date()) {
  const raw = String(text || "");
  if (/\btomorrow\b/i.test(raw)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(12, 0, 0, 0);
    return d;
  }
  if (/\b(?:today|tonight)\b/i.test(raw)) {
    const d = new Date(now);
    d.setHours(12, 0, 0, 0);
    return d;
  }
  return null;
}

function fmtIsoDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * True for cron/job/recurring scheduling intent — NOT a one-window timed
 * block. "schedule a gaming session 9 pm to midnight" is false.
 */
export function isCronLikeScheduleIntent(text) {
  return /\b(crontab?|recurring|recurs|hourly|every\s+\d+\s*(?:min|mins|minute|minutes|hour|hours)|every\s+(?:hour|minute|day|week|morning|evening|night)|remind\s+me\s+in)\b/i.test(String(text || ""))
    || /\bschedule\s+a\s+(?:cron|job)\b/i.test(String(text || ""));
}

const DURING_EXCLUDE_RE = /\bduring\s+(?:the\s+)?(?:day|week|month|year|morning|afternoon|evening|night)\b/i;
const ANCHOR_TRAIL_RE = /\s+(?:today|tonight|tomorrow|please|thanks)[.!?,]*$/i;

/**
 * True when the user is asking to place a block overlapping an existing one.
 * Executor-side, like user-text clocks. Cron-like text and bare "that's ok" are false.
 */
export function isOverlapScheduleIntent(text) {
  const raw = String(text || "");
  if (!raw.trim()) return false;
  if (isCronLikeScheduleIntent(raw)) return false;
  if (/^that'?s\s+ok\.?$/i.test(raw.trim())) return false;
  if (/\b(?:same\s+time|at\s+the\s+same\s+time|both\s+at\s+(?:the\s+)?same\s+time)\b/i.test(raw)) return true;
  if (/\boverlapp?(?:ing)?(?:\s+with)?\b/i.test(raw)) return true;
  if (/\b(?:in\s+parallel|alongside|concurrent(?:ly)?)\b/i.test(raw)) return true;
  if (/\bdouble[-\s]?book\b/i.test(raw)) return true;
  if (/\bwhile\s+(?:watching|doing|listening|eating|reading|working)\b/i.test(raw)) return true;
  if (/\bduring\b/i.test(raw) && !DURING_EXCLUDE_RE.test(raw)) return true;
  return false;
}

function cleanAnchorName(name) {
  let s = String(name || "").trim();
  s = s.replace(ANCHOR_TRAIL_RE, "").replace(/[.!?,]+$/, "").trim();
  return s || null;
}

/**
 * Pull the existing slot name from overlap phrasing, or null when none found.
 */
export function parseOverlapAnchor(text) {
  const raw = String(text || "");
  if (!raw.trim()) return null;
  // Setting-name confirms are not "overlap with <slot>" anchors.
  if (isAllowOverlappingPhrase(raw)) return null;
  let m;
  m = /\bsame\s+time\s+as\s+(?:we\s+are|we're|I\s+am|I'm)\s+(?:watching|doing|seeing|playing)\s+(.+)/i.exec(raw);
  if (m) return cleanAnchorName(m[1]);
  m = /\bsame\s+time\s+as\s+(?!we\s+are|we're|I\s+am|I'm\b)(.+)/i.exec(raw);
  if (m) return cleanAnchorName(m[1]);
  m = /\bduring\s+(?:the\s+)?(.+)/i.exec(raw);
  if (m && !/^(?:day|week|month|year|morning|afternoon|evening|night)\b/i.test(m[1].trim())) {
    return cleanAnchorName(m[1]);
  }
  m = /\bwhile\s+(?:watching|doing|listening(?:\s+to)?|eating|reading|working(?:\s+on)?)\s+(.+)/i.exec(raw);
  if (m) return cleanAnchorName(m[1]);
  m = /\balongside\s+(.+)/i.exec(raw);
  if (m) return cleanAnchorName(m[1]);
  m = /\boverlapp?(?:ing)?(?:\s+with)?\s+(.+)/i.exec(raw);
  if (m) {
    const name = cleanAnchorName(m[1]);
    // "overlapping timed blocks" (from the setting name) is not a slot title.
    if (!name || OVERLAP_ANCHOR_NOISE_RE.test(name)) return null;
    return name;
  }
  return null;
}

function significantWords(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 3);
}

function extraTextForUid(extraTexts, uid) {
  if (!uid || extraTexts == null) return "";
  if (extraTexts instanceof Map) return extraTexts.get(uid) || "";
  if (Array.isArray(extraTexts)) {
    const row = extraTexts.find((r) => r && r.uid === uid);
    return row?.text || "";
  }
  if (typeof extraTexts === "object") return extraTexts[uid] || "";
  return "";
}

function slotMatchesAnchor(child, slot, anchor, extraTexts) {
  const trimmed = String(anchor || "").trim();
  if (!trimmed) return false;
  const words = significantWords(trimmed);
  const todoText = slot.refUid ? extraTextForUid(extraTexts, slot.refUid) : "";
  const haystack = `${slot.text} ${todoText}`.toLowerCase();
  if (words.length) return words.every((w) => haystack.includes(w));
  if (trimmed.length >= 2) return haystack.includes(trimmed.toLowerCase());
  return false;
}

/** All schedule slots matching the anchor. No fuzzy typo matching. */
export function findAllScheduleSlotsByTitle(children, anchor, extraTexts) {
  const matches = [];
  for (const child of Array.isArray(children) ? children : []) {
    const slot = parseSlotLine(child.string);
    if (!slot) continue;
    if (slotMatchesAnchor(child, slot, anchor, extraTexts)) matches.push({ child, slot });
  }
  return matches;
}

/**
 * Find the first schedule slot whose text (or linked TODO text) matches the
 * anchor. Place / align_with keep first-match behaviour.
 */
export function findScheduleSlotByTitle(children, anchor, extraTexts) {
  const all = findAllScheduleSlotsByTitle(children, anchor, extraTexts);
  return all.length ? all[0] : null;
}

/** Fail closed when zero or multiple slots match (move / unschedule). */
export function findUniqueScheduleSlotByTitle(children, anchor, extraTexts) {
  const all = findAllScheduleSlotsByTitle(children, anchor, extraTexts);
  return all.length === 1 ? all[0] : null;
}

// ── Last refused window (follow-up "overlap") ────────────────────────────────

const LAST_SCHEDULE_COLLISION_TTL_MS = 5 * 60 * 1000;
const OVERLAP_TITLE_NOISE_RE = /\b(?:that'?s\s+ok|ok|yes|please|thanks|allow|same\s+time|at\s+the\s+same\s+time|both\s+at\s+(?:the\s+)?same\s+time|overlapp?(?:ing)?|timed\s+blocks?|in\s+parallel|alongside|concurrent(?:ly)?|double[-\s]?book|while|during)\b/gi;
/** Setting-name / confirm phrases that are not slot anchors. */
const OVERLAP_ANCHOR_NOISE_RE = /^(?:timed\s+blocks?|blocks?|allow(?:\s+overlapp?(?:ing)?)?)$/i;
/** "allow overlapping timed blocks" (and close variants) — setting name users quote back. */
const ALLOW_OVERLAPPING_PHRASE_RE = /^\s*(?:yes[,.]?\s*)?allow\s+overlapp?(?:ing)?(?:\s+timed\s+blocks?)?\s*[.!?]?\s*$/i;

let lastScheduleCollision = null;

function isLastScheduleCollisionFresh(last = lastScheduleCollision) {
  if (!last || last.at == null) return false;
  return Date.now() - last.at <= LAST_SCHEDULE_COLLISION_TTL_MS;
}

export function isNoNewScheduleTitle(title) {
  const t = String(title || "").trim();
  if (!t || t === "Timed block" || t === "Scheduled block") return true;
  const stripped = t.replace(OVERLAP_TITLE_NOISE_RE, " ").replace(/\s+/g, " ").trim();
  return !stripped;
}

/** True for bare overlap confirms, including the Advanced setting display name. */
export function isAllowOverlappingPhrase(text) {
  return ALLOW_OVERLAPPING_PHRASE_RE.test(String(text || "").trim());
}

/** Bare "overlap" or overlap confirm with no new clocks, anchor, or title. */
export function isShortOverlapConfirmation(userMessage, args = {}, fromUser = null) {
  const msg = String(userMessage || "").trim();
  if (/^overlap\b/i.test(msg)) return true;
  if (isAllowOverlappingPhrase(msg)) return true;
  if (!isOverlapScheduleIntent(msg)) return false;
  const fields = fromUser || parseScheduleFieldsFromUserText(msg);
  if (fields.start && fields.end) return false;
  if (parseOverlapAnchor(msg)) return false;
  if (String(args.title || "").trim()) return false;
  if (!isNoNewScheduleTitle(fields.title)) return false;
  return true;
}

export function getLastScheduleCollision() {
  return lastScheduleCollision;
}

export function clearLastScheduleCollision() {
  lastScheduleCollision = null;
}

async function fetchOpenTodoTexts(deps) {
  const map = new Map();
  try {
    const rows = await deps.queryRoamDatalog(`[:find ?uid ?str
      :where
      [?b :block/string ?str]
      [?b :block/uid ?uid]
      [(clojure.string/includes? ?str "{{[[TODO]]}}")]]`);
    for (const [uid, str] of Array.isArray(rows) ? rows : []) {
      map.set(uid, String(str || ""));
    }
  } catch (err) {
    deps.debugLog?.("[cos_schedule_block] open-TODO scan failed:", err?.message);
  }
  return map;
}

function resolveCollidePolicy(deps, args, userMessage) {
  if (isOverlapScheduleIntent(userMessage)) return "allow";
  const explicit = String(args.collide || "").trim();
  if (explicit === "refuse" || explicit === "ask" || explicit === "allow") return explicit;
  if (deps.getSettingBool?.("schedule-allow-overlap", false)) return "allow";
  return "refuse";
}

/**
 * True when the user is asking for ONE timed window on the daily plan:
 * two parseable times (or start + duration) + a place-block verb, not cron-like, not a gcal request.
 */
/** True for move / shift / reschedule intent, excluding cron and GCal. */
export function isMoveIntent(text) {
  const raw = String(text || "");
  if (!raw.trim()) return false;
  if (isCronLikeScheduleIntent(raw)) return false;
  if (/\b(gcal|google\s+calendar)\b/i.test(raw)) return false;
  return /\b(?:move|shift|reschedule)\b/i.test(raw);
}

/** True for unschedule-by-title intent; false for Better Tasks todo deletes. */
export function isUnscheduleIntent(text) {
  const raw = String(text || "");
  if (!raw.trim()) return false;
  if (/\b(?:delete\s+this\s+todo|\btodo\b|\{\{\[\[TODO\]\]\}\})/i.test(raw)) return false;
  if (/\bunschedule\b/i.test(raw)) return true;
  if (/\btake\b[^.]{0,120}?\boff\s+the\s+plan\b/i.test(raw)) return true;
  if (/\b(?:remove|delete|drop|take)\b[^.]{0,60}?\b(?:block|slot|window)\b/i.test(raw)) return true;
  return false;
}

/** Title between move/shift/reschedule and to|from; null when absent. */
export function parseMoveTitle(text) {
  const raw = String(text || "");
  const m = /\b(?:move|shift|reschedule)\s+(.+?)\s+(?:to|from)\b/i.exec(raw);
  if (m) {
    const title = m[1].trim();
    return title || null;
  }
  return null;
}

const UNSCHEDULE_TITLE_NOISE_RE = /\b(?:the|block|slot|window|timed)\b/gi;

function stripUnscheduleTitleNoise(title) {
  return String(title || "")
    .replace(UNSCHEDULE_TITLE_NOISE_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Title after unschedule/remove/delete/drop, with slot noise stripped. */
export function parseUnscheduleTitle(text) {
  const raw = String(text || "");
  let m = /\bunschedule\s+(.+)/i.exec(raw);
  if (m) return stripUnscheduleTitleNoise(m[1]) || null;
  m = /\btake\s+(.+?)\s+off\s+the\s+plan\b/i.exec(raw);
  if (m) return stripUnscheduleTitleNoise(m[1]) || null;
  m = /\b(?:remove|delete|drop)\s+(?:the\s+)?(.+)/i.exec(raw);
  if (m) return stripUnscheduleTitleNoise(m[1]) || null;
  return null;
}

/** Infer place | move | unschedule from user text; model args.action only when text is silent. */
export function resolveScheduleAction(userMessage, args = {}) {
  const msg = String(userMessage || "");
  if (isUnscheduleIntent(msg)) return "unschedule";
  if (isMoveIntent(msg)) return "move";
  const explicit = String(args.action || "").trim();
  if (explicit === "move" || explicit === "unschedule" || explicit === "place") return explicit;
  return "place";
}

/** Split on " and " / ";" — up to four {start,end,title} windows. */
export function parseMultipleScheduleWindows(text) {
  const raw = String(text || "");
  const segments = raw.split(/\s+\band\b\s+|;/i).map((s) => s.trim()).filter(Boolean);
  const windows = [];
  for (const seg of segments) {
    const fields = parseScheduleFieldsFromUserText(seg);
    if (fields.start && fields.end) {
      windows.push({
        start: fields.start,
        end: fields.end,
        title: fields.title || "Timed block",
      });
    }
    if (windows.length >= 4) break;
  }
  return windows.slice(0, 4);
}

export function isScheduleSlotIntent(text) {
  const raw = String(text || "");
  if (!raw.trim()) return false;
  if (/\b(gcal|google\s+calendar)\b/i.test(raw)) return false;
  if (isCronLikeScheduleIntent(raw)) return false;
  const hasVerb = /\b(schedule[ds]?|block\s+out|time[-\s]?block|plan|book|reserve|carve\s+out|set\s+aside|slot\s+in|timebox|add|put|place|drop)\b/i.test(raw)
    || /\bput\b[^.]{0,80}?\bfrom\b/i.test(raw);
  if (!hasVerb) return false;
  const fields = parseScheduleFieldsFromUserText(raw);
  return Boolean(fields.start && fields.end);
}

/**
 * When the model answered a one-window schedule request with NO tool call,
 * synthesise the cos_schedule_block call the user asked for. Returns null
 * unless the message is a schedule-slot intent with both times parseable.
 */
export function buildForcedScheduleToolCall(userMessage) {
  const calls = buildForcedScheduleToolCalls(userMessage);
  return calls.length ? calls[0] : null;
}

export function buildForcedScheduleToolCalls(userMessage) {
  const raw = String(userMessage || "");
  const windows = parseMultipleScheduleWindows(raw);
  if (windows.length >= 2) {
    return windows.map((w) => ({
      name: "cos_schedule_block",
      arguments: { start: w.start, end: w.end, title: w.title },
    }));
  }
  if (isMoveIntent(raw)) {
    const fields = parseScheduleFieldsFromUserText(raw);
    const hasClocks = Boolean(fields.start);
    const moveTitle = parseMoveTitle(raw);
    if (hasClocks && moveTitle) {
      const moveArgs = { action: "move", title: moveTitle, start: fields.start };
      if (fields.end) moveArgs.end = fields.end;
      return [{ name: "cos_schedule_block", arguments: moveArgs }];
    }
    if (hasClocks && isLastScheduleCollisionFresh()) {
      const moveArgs = { action: "move", start: fields.start };
      if (fields.end) moveArgs.end = fields.end;
      return [{ name: "cos_schedule_block", arguments: moveArgs }];
    }
  }
  if (isUnscheduleIntent(raw)) {
    const title = parseUnscheduleTitle(raw)
      || (() => {
        const t = parseScheduleFieldsFromUserText(raw).title;
        return t && t !== "Timed block" ? t : null;
      })();
    if (title) {
      return [{ name: "cos_schedule_block", arguments: { action: "unschedule", title } }];
    }
  }
  if (isScheduleSlotIntent(raw)) {
    const fields = parseScheduleFieldsFromUserText(raw);
    if (fields.start && fields.end) {
      return [{
        name: "cos_schedule_block",
        arguments: { start: fields.start, end: fields.end, title: fields.title || "Timed block" },
      }];
    }
  }
  if (isShortOverlapConfirmation(raw) && isLastScheduleCollisionFresh()) {
    const last = lastScheduleCollision;
    if (last?.start && last?.end) {
      return [{
        name: "cos_schedule_block",
        arguments: {
          start: last.start,
          end: last.end,
          title: last.title || "Timed block",
          collide: "allow",
        },
      }];
    }
  }
  return [];
}

// ── Pure time helpers ────────────────────────────────────────────────────────

function toMinutes(time) {
  const m = TIME_RE.exec(String(time || "").trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const mins = Number(m[2]);
  if (mins > 59) return null;
  if (hours > 24 || (hours === 24 && mins !== 0)) return null; // 24:00 ok, 24:01 not
  return hours * 60 + mins;
}

/** "9:5" → null, "9:05" → "09:05", "24:00" → "00:00". Null when unparseable. */
export function normalizeTime(time) {
  const total = toMinutes(time);
  if (total == null) return null;
  const wrapped = total % 1440;
  const h = Math.floor(wrapped / 60);
  const m = wrapped % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Minutes from start to end; end at or before start wraps past midnight. */
export function durationMinutes(start, end) {
  let s = toMinutes(start);
  let e = toMinutes(end);
  if (s == null || e == null) return null;
  s %= 1440;
  e %= 1440;
  if (e <= s) e += 1440;
  return e - s;
}

/** "21:00","24:00" → "21:00 - 00:00 (**180'**)". Never emits "24:00". */
export function formatSlotPrefix(start, end) {
  const s = normalizeTime(start);
  const e = normalizeTime(end);
  const mins = durationMinutes(start, end);
  if (s == null || e == null || mins == null) return null;
  return `${s} - ${e} (**${mins}'**)`;
}

/**
 * Parse a slot line back into {start, end, mins, refUid, isEvent, text}.
 * Returns null for anything that isn't a `HH:MM - HH:MM …` line.
 */
export function parseSlotLine(line) {
  const m = SLOT_LINE_RE.exec(String(line || ""));
  if (!m) return null;
  const start = normalizeTime(m[1]);
  const end = normalizeTime(m[2]);
  if (start == null || end == null) return null;
  const text = (m[4] || "").trim();
  const ref = BLOCK_REF_RE.exec(text);
  return {
    start,
    end,
    mins: m[3] != null ? Number(m[3]) : durationMinutes(start, end),
    refUid: ref ? ref[1] : null,
    isEvent: /#Event\b/.test(text),
    text,
  };
}

/** Overlap on a 24h circle; both ranges may wrap midnight. End-exclusive. */
export function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  let a0 = toMinutes(aStart);
  let a1 = toMinutes(aEnd);
  let b0 = toMinutes(bStart);
  let b1 = toMinutes(bEnd);
  if (a0 == null || a1 == null || b0 == null || b1 == null) return false;
  a0 %= 1440; a1 %= 1440; b0 %= 1440; b1 %= 1440;
  if (a1 <= a0) a1 += 1440;
  if (b1 <= b0) b1 += 1440;
  // A wrapped range also occupies the previous/next day's frame — check shifts.
  for (const shift of [-1440, 0, 1440]) {
    if (a0 + shift < b1 && b0 < a1 + shift) return true;
  }
  return false;
}

function isSmartBlockChild(text) {
  return String(text || "").includes(SMARTBLOCK_MARKER);
}

/**
 * Where to insert a slot starting at `start` among `children`
 * ([{uid, string, order}], sorted by order): before the first slot that
 * starts later, else before the trailing SmartBlock buttons, else "last".
 * Returns a numeric order (Roam shifts siblings) or "last".
 */
export function insertSlotChronologically(children, start) {
  const s = toMinutes(start);
  let smartBlockOrder = null;
  for (const child of Array.isArray(children) ? children : []) {
    if (isSmartBlockChild(child.string)) {
      if (smartBlockOrder == null) smartBlockOrder = child.order;
      continue;
    }
    const slot = parseSlotLine(child.string);
    if (slot && s != null && toMinutes(slot.start) > s) return child.order;
  }
  if (smartBlockOrder != null) return smartBlockOrder;
  return "last";
}

// ── Graph helpers (deps-injected) ────────────────────────────────────────────

async function getChildBlocks(deps, uid) {
  const api = deps.getRoamAlphaApi();
  let data = null;
  try {
    if (typeof api?.data?.pull === "function") data = await api.data.pull(CHILD_PULL_PATTERN, [":block/uid", uid]);
    else if (typeof api?.pull === "function") data = await api.pull(CHILD_PULL_PATTERN, [":block/uid", uid]);
  } catch (err) {
    deps.debugLog?.("[cos_schedule_block] child pull failed for", uid, err?.message);
  }
  const kids = Array.isArray(data?.[":block/children"]) ? data[":block/children"] : [];
  return kids
    .map((c) => ({
      uid: c[":block/uid"],
      string: String(c[":block/string"] || ""),
      order: Number.isFinite(c[":block/order"]) ? c[":block/order"] : 0,
    }))
    .sort((a, b) => a.order - b.order);
}
/** Pull a minimal entity shape; pages expose :node/title. Null when absent. */
async function pullEntity(deps, uid) {
  const api = deps.getRoamAlphaApi();
  try {
    if (typeof api?.data?.pull === "function") return await api.data.pull(ENTITY_PULL_PATTERN, [":block/uid", uid]);
    if (typeof api?.pull === "function") return await api.pull(ENTITY_PULL_PATTERN, [":block/uid", uid]);
  } catch (err) {
    deps.debugLog?.("[cos_schedule_block] entity pull failed for", uid, err?.message);
  }
  return null;
}

function isPageEntity(entity) {
  return Boolean(entity && entity[":node/title"] != null);
}

/**
 * Find the schedule parent among a daily page's top-level children, creating
 * a plain `heading` block when none exists. Preference order:
 *   1. A Nautilus Log render block, if the page already has one. Reused
 *      as-is, never duplicated, never rewritten.
 *   2. A `#TimeBlock` / `Time Blocks` / `heading` block (legacy or generic).
 *   3. Create `heading` ("Schedule" by default). The Nautilus render is never
 *      injected onto a graph that doesn't already have it.
 */
export async function findScheduleParent(deps, pageUid, scheduleHeading) {
  const heading = String(scheduleHeading || "").trim() || "Schedule";
  const children = await getChildBlocks(deps, pageUid);

  const nautilus = children.find((c) => c.string.includes(NAUTILUS_MARKER));
  if (nautilus) return { uid: nautilus.uid, created: false };

  const legacy = children.find((c) => {
    const s = c.string.trim();
    return s.includes("#TimeBlock") || /^Time Blocks\b/.test(s) || s.startsWith(heading);
  });
  if (legacy) return { uid: legacy.uid, created: false };

  const uid = await deps.createRoamBlock(pageUid, heading, "last");
  return { uid, created: true };
}

/**
 * Fuzzy-match an existing open TODO by title: every significant word
 * (length > 3) must appear in the block text, case-insensitively.
 * Returns {uid, text} or null.
 */
export async function findExistingOpenTodo(deps, title) {
  const words = String(title || "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 3);
  if (!words.length) return null;

  let rows;
  try {
    rows = await deps.queryRoamDatalog(`[:find ?uid ?str
      :where
      [?b :block/string ?str]
      [?b :block/uid ?uid]
      [(clojure.string/includes? ?str "{{[[TODO]]}}")]]`);
  } catch (err) {
    deps.debugLog?.("[cos_schedule_block] open-TODO scan failed:", err?.message);
    return null;
  }
  for (const [uid, str] of Array.isArray(rows) ? rows : []) {
    const lower = String(str || "").toLowerCase();
    if (words.every((w) => lower.includes(w))) return { uid, text: String(str) };
  }
  return null;
}
/**
 * Resolve a configured schedule parent (setting value or explicit uid):
 * an existing block uid is used as-is; a page uid or a page title resolves
 * through findScheduleParent so slots land under its Nautilus/Schedule
 * heading, never as raw page children. Returns null for empty input.
 */
export async function resolveConfiguredScheduleParent(deps, raw, heading) {
  const value = String(raw || "").trim();
  if (!value) return null;
  const entity = await pullEntity(deps, value);
  if (entity) {
    if (isPageEntity(entity)) return findScheduleParent(deps, value, heading);
    return { uid: value, created: false };
  }
  const pageUid = await deps.ensurePageUidByTitle(value);
  if (!pageUid) throw new Error(`Could not resolve schedule parent page "${value}".`);
  return findScheduleParent(deps, pageUid, heading);
}

// ── The tool ─────────────────────────────────────────────────────────────────

function buildEventString(start, end, title) {
  const line = `${start} - ${end}  ${title}`;
  return /#Event\b/.test(title) ? line : `${line} #Event`;
}

function rebuildSlotString(slot, startNorm, endNorm, prefix) {
  if (slot.isEvent) {
    const eventTitle = slot.text.replace(/#Event\b/g, "").trim();
    return buildEventString(startNorm, endNorm, eventTitle);
  }
  return `${prefix} ((${slot.refUid}))`;
}

function resolveMoveClocks(userMessage, args, slotForDuration) {
  const fromUser = parseScheduleFieldsFromUserText(userMessage);
  let startRaw = fromUser.start || args.start;
  let endRaw = fromUser.end || args.end;
  if (startRaw && !endRaw) {
    const durFromText = parseDurationMinutes(userMessage);
    if (durFromText != null) {
      endRaw = addMinutesToTime(startRaw, durFromText);
    } else if (slotForDuration) {
      const mins = durationMinutes(slotForDuration.start, slotForDuration.end);
      if (mins != null) endRaw = addMinutesToTime(startRaw, mins);
    }
  }
  return { startNorm: normalizeTime(startRaw), endNorm: normalizeTime(endRaw) };
}

function hasParseableMoveClocks(userMessage, args) {
  const fromUser = parseScheduleFieldsFromUserText(userMessage);
  if (fromUser.start && fromUser.end) return true;
  if (fromUser.start && parseDurationMinutes(userMessage) != null) return true;
  if (fromUser.start) return true;
  if (args.start) return true;
  return false;
}

export function buildScheduleBlockTool(deps) {
  if (typeof window !== "undefined") window.__cosScheduleBlockBuild = COS_SCHEDULE_BLOCK_BUILD;
  async function resolveDailyPage(dateArg) {
    const raw = String(dateArg || "").trim();
    if (!raw) return deps.ensureDailyPageUid(new Date());
    const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
    if (iso) {
      return deps.ensureDailyPageUid(new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
    }
    // Assume a Roam daily title like "August 26th, 2026" — resolve or create it.
    const pageUid = await deps.ensurePageUidByTitle(raw);
    if (!pageUid) throw new Error(`Could not resolve page "${raw}".`);
    return { pageUid, pageTitle: raw };
  }

  return {
    name: "cos_schedule_block",
    isMutating: true,
    description: "Place, move, or unschedule a timed block on a daily page. Writes the canonical slot grammar HH:MM - HH:MM (**N'**) ((task-uid)) under the timed block parent. Reuses open TODOs; kind=event writes #Event text. Refuses overlapping slots by default; pass collide=allow or overlap language to keep both. Move shifts an existing slot; unschedule removes the slot child only, never the TODO.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["place", "move", "unschedule"], description: "place (default): new slot. move: shift an existing slot. unschedule: delete the slot child only." },
        date: { type: "string", description: "Daily page — Roam title (\"August 26th, 2026\") or ISO YYYY-MM-DD. Default: today." },
        start: { type: "string", description: "Start time, HH:MM 24-hour." },
        end: { type: "string", description: "End time, HH:MM 24-hour. 24:00 means midnight at the end of the day; the written line shows 00:00." },
        title: { type: "string", description: "What the slot is for. Used to find or create the TODO (kind=task) or as the event text (kind=event)." },
        kind: { type: "string", enum: ["task", "event"], description: "task (default) references a TODO via ((uid)); event writes the title tagged #Event, no TODO." },
        task_uid: { type: "string", description: "Existing TODO block uid to reference. Reused as-is — never duplicated." },
        project: { type: "string", description: "Page title on which to create a NEW todo. Default: the daily page." },
        parent_uid: { type: "string", description: "Explicit schedule parent block uid (sandbox / tests). Skips parent discovery." },
        schedule_heading: { type: "string", description: "Heading used to find/create the schedule parent when there is no Nautilus Log block and no parent_uid. Default \"Schedule\"." },
        align_with: { type: "string", description: "Existing slot title to copy start/end from when the user gave no clocks (e.g. same time as movie night)." },
        collide: { type: "string", enum: ["refuse", "ask", "allow"], description: "On overlap with a different task/event: refuse (default) returns the colliding slot without writing; ask does the same but requests a user decision; allow writes a new overlapping sibling." }
      },
      required: []
    },
    execute: async (args = {}) => {
      const userMessage = deps.getAgentUserMessage?.() || "";
      const action = resolveScheduleAction(userMessage, args);
      const fromUser = parseScheduleFieldsFromUserText(userMessage);
      const collide = resolveCollidePolicy(deps, args, userMessage);
      let title = String(args.title || "").trim();
      const kind = String(args.kind || "task") === "event" ? "event" : "task";
      const api = deps.getRoamAlphaApi();
      if (!api?.updateBlock) throw new Error("Roam updateBlock API unavailable.");
      if (action === "unschedule" && !api?.deleteBlock) throw new Error("Roam deleteBlock API unavailable.");

      // 1. Resolve the schedule parent.
      let parentUid = "";
      let createdParent = false;
      let dailyPage = null;
      if (isSandboxUserMessage(userMessage)) {
        const sandboxTitle = deps.getSettingString?.("schedule-sandbox-page", DEFAULT_SANDBOX_PAGE) || DEFAULT_SANDBOX_PAGE;
        const pageUid = await deps.ensurePageUidByTitle(sandboxTitle);
        dailyPage = { pageUid, pageTitle: sandboxTitle };
        const parent = await findScheduleParent(deps, pageUid, args.schedule_heading);
        parentUid = parent.uid;
        createdParent = parent.created;
      } else if (String(args.parent_uid || "").trim()) {
        const explicit = String(args.parent_uid).trim();
        deps.requireRoamUidExists(explicit, "parent_uid");
        const parent = await resolveConfiguredScheduleParent(deps, explicit, args.schedule_heading);
        parentUid = parent.uid;
        createdParent = parent.created;
      } else {
        const configured = String(deps.getSettingString?.("schedule-parent", "") || "").trim();
        if (configured) {
          const parent = await resolveConfiguredScheduleParent(deps, configured, args.schedule_heading);
          parentUid = parent.uid;
          createdParent = parent.created;
        } else {
          let dateArg = args.date;
          const datePin = parseDatePinFromUserText(userMessage);
          if (datePin) dateArg = fmtIsoDate(datePin);
          dailyPage = await resolveDailyPage(dateArg);
          if (!dailyPage?.pageUid) throw new Error("Could not resolve the daily page.");
          const parent = await findScheduleParent(deps, dailyPage.pageUid, args.schedule_heading);
          parentUid = parent.uid;
          createdParent = parent.created;
        }
      }

      const children = await getChildBlocks(deps, parentUid);
      const extraTexts = await fetchOpenTodoTexts(deps);
      const lastFresh = isLastScheduleCollisionFresh() ? lastScheduleCollision : null;

      // ── Unschedule by title ───────────────────────────────────────────────
      if (action === "unschedule") {
        const anchor = parseUnscheduleTitle(userMessage) || title;
        if (!anchor) throw new Error("title is required to unschedule a timed block.");
        const matches = findAllScheduleSlotsByTitle(children, anchor, extraTexts);
        if (matches.length === 0) {
          throw new Error(`No timed block matching "${anchor}" was found. Nothing was removed.`);
        }
        if (matches.length > 1) {
          throw new Error(`Multiple timed blocks match "${anchor}". Refusing to unschedule.`);
        }
        const { child, slot } = matches[0];
        await deps.withRoamWriteRetry(() =>
          api.deleteBlock({ block: { uid: child.uid } })
        );
        clearLastScheduleCollision();
        return {
          success: true,
          unscheduled: true,
          slot_uid: child.uid,
          slot_string: child.string,
          task_uid: slot.refUid || null,
          parent_uid: parentUid,
        };
      }

      // ── Move ──────────────────────────────────────────────────────────────
      if (action === "move") {
        const namedMoveTitle = parseMoveTitle(userMessage);
        if (
          lastFresh
          && lastFresh.parent_uid === parentUid
          && !namedMoveTitle
          && (isMoveIntent(userMessage) || String(args.action || "").trim() === "move")
        ) {
          if (!hasParseableMoveClocks(userMessage, args)) {
            return {
              success: false,
              error: `${MOVE_CLOCKS_HINT} Existing slot: "${lastFresh.colliding_string}".`,
              colliding_uid: lastFresh.colliding_uid,
              colliding_string: lastFresh.colliding_string,
            };
          }
          const collidingChild = children.find((c) => c.uid === lastFresh.colliding_uid);
          if (!collidingChild) {
            throw new Error(`Colliding slot ${lastFresh.colliding_uid} is no longer in the graph. Nothing was written.`);
          }
          const collidingSlot = parseSlotLine(collidingChild.string);
          if (!collidingSlot) {
            throw new Error("Colliding block is not a timed slot. Nothing was written.");
          }
          const { startNorm: moveStart, endNorm: moveEnd } = resolveMoveClocks(
            userMessage, args, collidingSlot
          );
          if (!moveStart || !moveEnd) {
            return {
              success: false,
              error: `${MOVE_CLOCKS_HINT} Existing slot: "${lastFresh.colliding_string}".`,
              colliding_uid: lastFresh.colliding_uid,
              colliding_string: lastFresh.colliding_string,
            };
          }
          const movePrefix = formatSlotPrefix(moveStart, moveEnd);
          const placeStart = lastFresh.start;
          const placeEnd = lastFresh.end;
          const placeTitle = lastFresh.title;
          const placeKind = lastFresh.kind || "task";

          for (const child of children) {
            if (child.uid === lastFresh.colliding_uid) continue;
            const slot = parseSlotLine(child.string);
            if (!slot) continue;
            if (!rangesOverlap(moveStart, moveEnd, slot.start, slot.end)) continue;
            const sameAsPlace = placeKind === "task" && slot.refUid
              && (await findExistingOpenTodo(deps, placeTitle))?.uid === slot.refUid;
            if (sameAsPlace) continue;
            throw new Error(
              `Moving to ${moveStart} - ${moveEnd} would overlap "${child.string}". Nothing was written.`
            );
          }

          const movedString = rebuildSlotString(collidingSlot, moveStart, moveEnd, movePrefix);
          await deps.withRoamWriteRetry(() =>
            api.updateBlock({ block: { uid: collidingChild.uid, string: deps.truncateRoamBlockText(movedString) } })
          );

          // Place the originally refused title at the old window.
          let placeTaskUid = null;
          let placeReused = false;
          let placeCreatedTodo = false;
          if (placeKind === "task") {
            const existing = await findExistingOpenTodo(deps, placeTitle);
            if (existing) {
              placeTaskUid = existing.uid;
              placeReused = true;
            } else {
              if (!dailyPage) dailyPage = await resolveDailyPage(args.date);
              placeTaskUid = await deps.createRoamBlock(
                dailyPage.pageUid, `{{[[TODO]]}} ${placeTitle}`, "last"
              );
              placeCreatedTodo = true;
            }
          }
          const placePrefix = formatSlotPrefix(placeStart, placeEnd);
          const refreshedChildren = await getChildBlocks(deps, parentUid);
          const order = insertSlotChronologically(refreshedChildren, placeStart);
          let slotUid;
          let slotString;
          if (placeKind === "event") {
            slotString = buildEventString(placeStart, placeEnd, placeTitle);
            slotUid = await deps.createRoamBlock(parentUid, slotString, order);
          } else {
            slotString = `${placePrefix} ((${placeTaskUid}))`;
            slotUid = await deps.createRoamBlock(parentUid, "PLACEHOLDER", order);
            await deps.withRoamWriteRetry(() =>
              api.updateBlock({ block: { uid: slotUid, string: deps.truncateRoamBlockText(slotString) } })
            );
          }
          clearLastScheduleCollision();
          return {
            success: true,
            moved: true,
            moved_uid: collidingChild.uid,
            moved_string: movedString,
            slot_uid: slotUid,
            slot_string: slotString,
            task_uid: placeTaskUid,
            parent_uid: parentUid,
            created_todo: placeCreatedTodo,
            reused_todo: placeReused,
            created_parent: createdParent,
          };
        }

        const moveTitle = parseMoveTitle(userMessage) || title;
        if (moveTitle) {
          const matches = findAllScheduleSlotsByTitle(children, moveTitle, extraTexts);
          if (matches.length === 0) {
            throw new Error(`No timed block matching "${moveTitle}" was found. Nothing was moved.`);
          }
          if (matches.length > 1) {
            throw new Error(`Multiple timed blocks match "${moveTitle}". Refusing to move.`);
          }
          const { child, slot } = matches[0];
          const { startNorm, endNorm } = resolveMoveClocks(userMessage, args, slot);
          if (!startNorm || !endNorm) {
            throw new Error("start and end (or start plus duration) are required to move a timed block.");
          }
          const prefix = formatSlotPrefix(startNorm, endNorm);
          const slotString = rebuildSlotString(slot, startNorm, endNorm, prefix);
          await deps.withRoamWriteRetry(() =>
            api.updateBlock({ block: { uid: child.uid, string: deps.truncateRoamBlockText(slotString) } })
          );
          clearLastScheduleCollision();
          return {
            success: true,
            rescheduled: true,
            slot_uid: child.uid,
            slot_string: slotString,
            task_uid: slot.refUid || null,
            parent_uid: parentUid,
            created_parent: createdParent,
          };
        }

        throw new Error("Could not determine which timed block to move.");
      }

      // ── Place (default) ───────────────────────────────────────────────────
      // Bare confirm ("overlap" / "allow overlapping timed blocks") retries the
      // refused window. Prefer the stored title over a model-invented one —
      // the user did not name a new task in the confirm reply.
      if (
        lastFresh
        && lastFresh.parent_uid === parentUid
        && lastFresh.title
        && (
          (!title && isShortOverlapConfirmation(userMessage, args, fromUser))
          || isAllowOverlappingPhrase(userMessage)
          || /^overlap\b/i.test(String(userMessage || "").trim())
        )
      ) {
        title = lastFresh.title;
      }

      let startRaw;
      let endRaw;
      if (fromUser.start && fromUser.end) {
        startRaw = fromUser.start;
        endRaw = fromUser.end;
      } else {
        const anchorName = String(args.align_with || "").trim() || parseOverlapAnchor(userMessage);
        const anchorMatch = anchorName
          ? findScheduleSlotByTitle(children, anchorName, extraTexts)
          : null;
        if (anchorMatch) {
          startRaw = anchorMatch.slot.start;
          endRaw = anchorMatch.slot.end;
        } else if (
          isShortOverlapConfirmation(userMessage, args, fromUser)
          && lastFresh
          && lastFresh.parent_uid === parentUid
          && lastFresh.start
          && lastFresh.end
        ) {
          startRaw = lastFresh.start;
          endRaw = lastFresh.end;
        } else {
          startRaw = args.start;
          endRaw = args.end;
        }
      }

      const startNorm = normalizeTime(startRaw);
      const endNorm = normalizeTime(endRaw);
      if (!startNorm) throw new Error("start is required (HH:MM, 24-hour).");
      if (!endNorm) throw new Error("end is required (HH:MM, 24-hour; 24:00 allowed for midnight).");
      if (!title) throw new Error("title is required.");
      const prefix = formatSlotPrefix(startNorm, endNorm);

      let taskUid = null;
      let reusedTodo = false;
      if (kind === "task") {
        taskUid = String(args.task_uid || "").trim() || null;
        if (taskUid) {
          deps.requireRoamUidExists(taskUid, "task_uid");
          reusedTodo = true;
        } else {
          const existing = await findExistingOpenTodo(deps, title);
          if (existing) {
            taskUid = existing.uid;
            reusedTodo = true;
          }
        }
      }

      let rescheduleTarget = null;
      let firstColliding = null;
      let overlappedOther = false;
      for (const child of children) {
        const slot = parseSlotLine(child.string);
        if (!slot) continue;
        if (!rangesOverlap(startNorm, endNorm, slot.start, slot.end)) continue;
        const sameTask = kind === "task" && taskUid && slot.refUid === taskUid;
        const sameEvent = kind === "event" && slot.isEvent
          && slot.text.replace(/#Event\b/g, "").trim() === title;
        if (sameTask || sameEvent) {
          rescheduleTarget = child;
          continue;
        }
        if (collide === "allow") {
          if (!firstColliding) firstColliding = { uid: child.uid, string: child.string };
          overlappedOther = true;
          continue;
        }
        lastScheduleCollision = {
          start: startNorm,
          end: endNorm,
          title,
          kind,
          parent_uid: parentUid,
          colliding_string: child.string,
          colliding_uid: child.uid,
          at: Date.now(),
        };
        const suffix = collide === "ask" ? COLLISION_ASK_SUFFIX : COLLISION_REFUSE_SUFFIX;
        return {
          success: false,
          error: `Time collision: ${startNorm} - ${endNorm} overlaps existing slot "${child.string}". Nothing was written.${suffix}`,
          colliding_uid: child.uid,
          colliding_string: child.string,
        };
      }

      if (rescheduleTarget) {
        const slotString = kind === "event"
          ? buildEventString(startNorm, endNorm, title)
          : `${prefix} ((${taskUid}))`;
        await deps.withRoamWriteRetry(() =>
          api.updateBlock({ block: { uid: rescheduleTarget.uid, string: deps.truncateRoamBlockText(slotString) } })
        );
        clearLastScheduleCollision();
        const result = {
          success: true, slot_uid: rescheduleTarget.uid, slot_string: slotString,
          task_uid: taskUid, parent_uid: parentUid,
          created_todo: false, reused_todo: reusedTodo, rescheduled: true,
          created_parent: createdParent,
        };
        if (overlappedOther && firstColliding) {
          result.overlapped = true;
          result.colliding_uid = firstColliding.uid;
          result.colliding_string = firstColliding.string;
        }
        return result;
      }

      let createdTodo = false;
      if (kind === "task" && !taskUid) {
        let todoParentUid;
        const project = String(args.project || "").trim();
        if (project) {
          todoParentUid = await deps.ensurePageUidByTitle(project);
          if (!todoParentUid) throw new Error(`Could not resolve project page "${project}".`);
        } else {
          if (!dailyPage) dailyPage = await resolveDailyPage(args.date);
          todoParentUid = dailyPage.pageUid;
        }
        taskUid = await deps.createRoamBlock(todoParentUid, `{{[[TODO]]}} ${title}`, "last");
        createdTodo = true;
      }

      const order = insertSlotChronologically(children, startNorm);
      let slotUid;
      let slotString;
      if (kind === "event") {
        slotString = buildEventString(startNorm, endNorm, title);
        slotUid = await deps.createRoamBlock(parentUid, slotString, order);
      } else {
        slotString = `${prefix} ((${taskUid}))`;
        slotUid = await deps.createRoamBlock(parentUid, "PLACEHOLDER", order);
        await deps.withRoamWriteRetry(() =>
          api.updateBlock({ block: { uid: slotUid, string: deps.truncateRoamBlockText(slotString) } })
        );
      }

      clearLastScheduleCollision();
      const result = {
        success: true, slot_uid: slotUid, slot_string: slotString,
        task_uid: taskUid, parent_uid: parentUid,
        created_todo: createdTodo, reused_todo: reusedTodo,
        created_parent: createdParent,
      };
      if (overlappedOther && firstColliding) {
        result.overlapped = true;
        result.colliding_uid = firstColliding.uid;
        result.colliding_string = firstColliding.string;
      }
      return result;
    }
  };
}
