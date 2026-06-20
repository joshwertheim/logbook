import assert from "node:assert/strict";
import test from "node:test";
import { completeSlashCommand, helpText, parseInput, parseRelatedArgs, parseRelatedSelectionArgs, slashCommands } from "../src/commands.js";

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

test("parses related result selection command", () => {
  assert.deepEqual(parseInput("/note 2 snippet"), {
    kind: "command",
    name: "note",
    args: "2 snippet"
  });
});

test("parses related args with room for future flags", () => {
  assert.deepEqual(parseRelatedArgs("--strict launch plan"), {
    mode: "balanced",
    query: "launch plan",
    flags: ["--strict"]
  });
});

test("parses related selection args", () => {
  assert.deepEqual(parseRelatedSelectionArgs("2 snippet"), {
    index: 2,
    field: "snippet"
  });
  assert.deepEqual(parseRelatedSelectionArgs("3"), {
    index: 3,
    field: "all"
  });
  assert.deepEqual(parseRelatedSelectionArgs("wat path"), {
    index: undefined,
    field: "path"
  });
});

test("help text documents related command", () => {
  assert.match(helpText(), /\/related \[query\]/);
  assert.match(helpText(), /\/note <number>/);
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

test("parses index command", () => {
  assert.deepEqual(parseInput("/index"), {
    kind: "command",
    name: "index",
    args: ""
  });
  assert.match(helpText(), /\/index/);
});

test("treats unknown slash commands as note input", () => {
  assert.deepEqual(parseInput("/unknown value"), {
    kind: "input",
    text: "/unknown value"
  });
});

test("completes slash command prefixes", () => {
  assert.deepEqual(completeSlashCommand("/rel"), [["/related"], "/rel"]);
});

test("lists all slash commands for bare slash", () => {
  assert.deepEqual(
    completeSlashCommand("/"),
    [slashCommands.map((command) => `/${command}`), "/"]
  );
});

test("does not complete note text or command arguments", () => {
  assert.deepEqual(completeSlashCommand("remember"), [[], "remember"]);
  assert.deepEqual(completeSlashCommand("/related har"), [[], "/related har"]);
});

test("returns no matches for unknown slash prefix", () => {
  assert.deepEqual(completeSlashCommand("/wat"), [[], "/wat"]);
});
