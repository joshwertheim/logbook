import assert from "node:assert/strict";
import test from "node:test";
import { parseInput } from "../src/commands.js";

test("parses note input", () => {
  assert.deepEqual(parseInput("remember the thing"), {
    kind: "input",
    text: "remember the thing"
  });
});

test("parses slash commands with args", () => {
  assert.deepEqual(parseInput("/search quarterly plan"), {
    kind: "command",
    name: "search",
    args: "quarterly plan"
  });
});

test("treats unknown slash commands as note input", () => {
  assert.deepEqual(parseInput("/unknown value"), {
    kind: "input",
    text: "/unknown value"
  });
});
