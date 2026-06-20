import assert from "node:assert/strict";
import test from "node:test";
import { datedMarkdownFilename, renderMarkdown, slugify } from "../src/markdown.js";

test("slugifies note titles", () => {
  assert.equal(slugify("Project Ideas: June 2026!"), "project-ideas-june-2026");
});

test("generates dated markdown filename", () => {
  assert.equal(datedMarkdownFilename("My Note", new Date("2026-06-19T12:00:00Z")), "2026-06-19-my-note.md");
});

test("renders frontmatter and raw capture", () => {
  const markdown = renderMarkdown({
    raw: "raw thoughts",
    metadata: {
      title: "Raw Thoughts",
      tags: ["ideas"],
      topics: ["Planning"],
      entities: [{ name: "Fidelity", type: "organization" }],
      dates: ["2026-06-19"],
      summary: "A short thought.",
      type: "idea"
    }
  });

  assert.match(markdown, /title: "Raw Thoughts"/);
  assert.match(markdown, /tags: \["ideas"\]/);
  assert.match(markdown, /topics: \["Planning"\]/);
  assert.match(markdown, /entities: \[\{"name":"Fidelity","type":"organization"\}\]/);
  assert.match(markdown, /## Raw Capture\n\nraw thoughts/);
});
