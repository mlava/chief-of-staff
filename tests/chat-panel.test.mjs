import test from "node:test";
import assert from "node:assert/strict";
import { isChatComposerField, autosizeChatInput } from "../src/chat-composer.js";

test("isChatComposerField is false for empty targets", () => {
  assert.equal(isChatComposerField(null), false);
  assert.equal(isChatComposerField(undefined), false);
  assert.equal(isChatComposerField({}), false);
});

test("isChatComposerField is true for the chat textarea and send button", () => {
  const input = { closest: (sel) => (sel === "[data-chief-chat-input]" ? input : null) };
  const send = { closest: (sel) => (sel === "[data-chief-chat-send]" ? send : null) };
  const area = { closest: (sel) => (sel === "textarea" ? area : null) };
  assert.equal(isChatComposerField(input), true);
  assert.equal(isChatComposerField(send), true);
  assert.equal(isChatComposerField(area), true);
});

test("isChatComposerField is false for the panel chrome", () => {
  const header = { closest: () => null };
  assert.equal(isChatComposerField(header), false);
});

test("autosizeChatInput keeps the caret and caps height", () => {
  const calls = [];
  const el = {
    nodeName: "TEXTAREA",
    selectionStart: 4,
    selectionEnd: 4,
    scrollHeight: 240,
    style: {},
    setSelectionRange(a, b) { calls.push([a, b]); this.selectionStart = a; this.selectionEnd = b; }
  };
  autosizeChatInput(el, 160);
  assert.equal(el.style.height, "160px");
  assert.equal(el.style.overflowY, "auto");
  assert.deepEqual(calls, [[4, 4]]);
});

test("autosizeChatInput is a no-op on non-textareas", () => {
  assert.equal(autosizeChatInput(null), undefined);
  assert.equal(autosizeChatInput({ nodeName: "DIV" }), undefined);
});
