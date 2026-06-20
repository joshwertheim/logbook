import assert from "node:assert/strict";
import test from "node:test";
import { helpText, parseInput, parseRelatedArgs } from "../src/commands.js";

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

test("parses related command with optional query", () => {
  assert.deepEqual(parseInput("/related"), {
    kind: "command",
    name: "related",
    args: ""
  });
  assert.deepEqual(parseInput("/related launch plan"), {
    kind: "command",
    name: "related",
    args: "launch plan"
  });
});

test("parses related args with room for future flags", () => {
  assert.deepEqual(parseRelatedArgs("--strict launch plan"), {
    mode: "balanced",
    query: "launch plan",
    flags: ["--strict"]
  });
});

test("help text documents related command", () => {
  assert.match(helpText(), /\/related \[query\]/);
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

test("parses metadata command", () => {
  assert.deepEqual(parseInput("/metadata"), {
    kind: "command",
    name: "metadata",
    args: ""
  });
});

test("treats unknown slash commands as note input", () => {
  assert.deepEqual(parseInput("/unknown value"), {
    kind: "input",
    text: "/unknown value"
  });
});
