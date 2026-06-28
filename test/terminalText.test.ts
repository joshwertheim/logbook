import assert from "node:assert/strict";
import test from "node:test";
import { wrapTerminalOutput, wrapText } from "../src/terminalText.js";

test("wraps long text at word boundaries", () => {
  assert.equal(
    wrapText("A title with several words that should stay whole", { width: 24 }),
    [
      "A title with several",
      "words that should stay",
      "whole"
    ].join("\n")
  );
});

test("uses subsequent indentation for wrapped continuation lines", () => {
  assert.equal(
    wrapText("1. A long search result title with tags", { width: 20, subsequentIndent: "   " }),
    [
      "1. A long search",
      "   result title with",
      "   tags"
    ].join("\n")
  );
});

test("splits only words that are wider than the available line width", () => {
  assert.equal(
    wrapText("prefix abcdefghijk", { width: 8 }),
    [
      "prefix",
      "abcdefgh",
      "ijk"
    ].join("\n")
  );
});

test("wraps each output line independently", () => {
  assert.equal(
    wrapTerminalOutput("Short\nA second line that wraps cleanly", 18),
    [
      "Short",
      "A second line that",
      "wraps cleanly"
    ].join("\n")
  );
});

test("preserves existing indentation when wrapping output", () => {
  assert.equal(
    wrapTerminalOutput("   Rationale: a phrase that wraps", 22),
    [
      "   Rationale: a phrase",
      "   that wraps"
    ].join("\n")
  );
});
