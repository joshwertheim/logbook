import assert from "node:assert/strict";
import test from "node:test";
import { terminalActionForKey } from "../src/terminalInput.js";

test("plain return submits the current note", () => {
  assert.deepEqual(terminalActionForKey("\r", { name: "return" }), {
    kind: "submit"
  });
});

test("modified enter sequences insert a newline", () => {
  assert.deepEqual(terminalActionForKey("\u001b[13;2u", { name: "return", shift: true }), {
    kind: "newline"
  });
});

test("ctrl+j inserts a newline fallback", () => {
  assert.deepEqual(terminalActionForKey("\n", { name: "j", ctrl: true }), {
    kind: "newline"
  });
});

test("printable characters append text", () => {
  assert.deepEqual(terminalActionForKey("a", { name: "a" }), {
    kind: "text",
    value: "a"
  });
});
