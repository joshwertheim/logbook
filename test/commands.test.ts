import assert from "node:assert/strict";
import test from "node:test";
import { completeSlashCommand, helpText, parseAnalysisArgs, parseInput, parseRelatedArgs, parseRelatedSelectionArgs, slashCommands } from "../src/commands.js";

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
  assert.deepEqual(parseInput("/amend quarterly plan"), {
    kind: "command",
    name: "amend",
    args: "quarterly plan"
  });
  assert.deepEqual(parseInput("/edit quarterly plan"), {
    kind: "command",
    name: "edit",
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

test("parses analysis commands with queries", () => {
  assert.deepEqual(parseInput("/context oauth"), {
    kind: "command",
    name: "context",
    args: "oauth"
  });
  assert.deepEqual(parseInput("/decisions oauth"), {
    kind: "command",
    name: "decisions",
    args: "oauth"
  });
  assert.deepEqual(parseInput("/gaps mcp"), {
    kind: "command",
    name: "gaps",
    args: "mcp"
  });
});

test("parses analysis args with metadata default and content opt-in", () => {
  assert.deepEqual(parseAnalysisArgs("context", "oauth"), {
    query: "oauth",
    includeContent: false
  });
  assert.deepEqual(parseAnalysisArgs("context", "--with-content oauth"), {
    query: "oauth",
    includeContent: true
  });
});

test("rejects unknown analysis flags", () => {
  assert.deepEqual(parseAnalysisArgs("context", "--full oauth"), {
    query: "",
    includeContent: false,
    error: "Usage: /context [--with-content] <query>"
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
  assert.match(helpText(), /\/amend <query>/);
  assert.match(helpText(), /\/edit <query>/);
  assert.match(helpText(), /\/related \[query\]/);
  assert.match(helpText(), /\/context \[--with-content\] <query>/);
  assert.match(helpText(), /\/decisions \[--with-content\] <query>/);
  assert.match(helpText(), /\/gaps \[--with-content\] <query>/);
  assert.match(helpText(), /\/note <number>/);
});

test("parses compose and multiline mode commands", () => {
  assert.deepEqual(parseInput("/compose"), {
    kind: "command",
    name: "compose",
    args: ""
  });
  assert.deepEqual(parseInput("/multiline"), {
    kind: "command",
    name: "multiline",
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

test("treats unknown slash commands as command errors", () => {
  assert.deepEqual(parseInput("/unknown value"), {
    kind: "unknown-command",
    command: "/unknown"
  });
  assert.deepEqual(parseInput("/relate something"), {
    kind: "unknown-command",
    command: "/relate"
  });
});

test("completes slash command prefixes", () => {
  assert.deepEqual(completeSlashCommand("/rel"), [["/related"], "/rel"]);
  assert.deepEqual(completeSlashCommand("/ame"), [["/amend"], "/ame"]);
  assert.deepEqual(completeSlashCommand("/edi"), [["/edit"], "/edi"]);
  assert.deepEqual(completeSlashCommand("/mul"), [["/multiline"], "/mul"]);
  assert.deepEqual(completeSlashCommand("/con"), [["/context"], "/con"]);
  assert.deepEqual(completeSlashCommand("/dec"), [["/decisions"], "/dec"]);
  assert.deepEqual(completeSlashCommand("/gap"), [["/gaps"], "/gap"]);
});

test("help text documents compose and multiline commands", () => {
  assert.match(helpText(), /\/compose - open the current draft in your editor/);
  assert.match(helpText(), /\/multiline - start multiline note capture/);
  assert.match(helpText(), /\/done/);
  assert.match(helpText(), /\/cancel/);
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
