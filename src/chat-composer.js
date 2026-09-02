// Composer helpers extracted so tests do not have to load izitoast / the DOM.

export const CHAT_INPUT_MAX_HEIGHT_PX = 160;

/**
 * True when a pointer/keyboard event landed on the composer field, a button,
 * or a link inside the panel. Resize grips and panel-level cursor styling
 * must not run on these — they steal the textarea caret and show a resize
 * cursor over the input while you type.
 */
export function isChatComposerField(el) {
  if (!el || typeof el.closest !== "function") return false;
  return Boolean(
    el.closest("[data-chief-chat-input]")
    || el.closest("[data-chief-chat-send]")
    || el.closest("textarea")
    || el.closest("button")
    || el.closest("a")
    || el.closest("input")
  );
}

/** Grow the composer textarea with the text; keep the caret where it was. */
export function autosizeChatInput(el, maxHeightPx = CHAT_INPUT_MAX_HEIGHT_PX) {
  if (!el || el.nodeName !== "TEXTAREA") return;
  const start = el.selectionStart;
  const end = el.selectionEnd;
  el.style.height = "auto";
  const next = Math.min(Math.max(el.scrollHeight, 0), maxHeightPx);
  el.style.height = next + "px";
  el.style.overflowY = el.scrollHeight > maxHeightPx ? "auto" : "hidden";
  if (typeof start === "number" && typeof end === "number" && typeof el.setSelectionRange === "function") {
    try { el.setSelectionRange(start, end); } catch { /* some browsers throw if not focused */ }
  }
}
