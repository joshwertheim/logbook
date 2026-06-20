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

test("parses check command with natural language args", () => {
  assert.deepEqual(parseInput("/check what happened today"), {
    kind: "command",
    name: "check",
    args: "what happened today"
  });
});

test("parses compose mode commands", () => {
  assert.deepEqual(parseInput("/compose"), {
    kind: "command",
    name: "compose",
    args: ""
  });
  assert.deepEqual(parseInput("/done"), {
    kind: "command",
    name: "done",
    args: ""
  });
  assert.deepEqual(parseInput("/cancel"), {
    kind: "command",
    name: "cancel",
    args: ""
  });
});

test("treats unknown slash commands as note input", () => {
  assert.deepEqual(parseInput("/unknown value"), {
    kind: "input",
    text: "/unknown value"
  });
});
