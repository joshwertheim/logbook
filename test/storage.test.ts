import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NoteStore } from "../src/storage.js";

test("saves notes to markdown and sqlite, then searches them", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-test-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });

  try {
    const saved = store.saveDraft({
      raw: "Discuss launch checklist for Friday.",
      metadata: {
        title: "Launch Checklist",
        tags: ["launch", "planning"],
        dates: ["Friday"],
        summary: "Launch checklist notes.",
        type: "meeting"
      }
    }, new Date("2026-06-19T12:00:00Z"));

    assert.equal(fs.existsSync(saved.markdownPath), true);
    const results = store.search("launch");
    assert.equal(results.length, 1);
    assert.equal(results[0]?.title, "Launch Checklist");
    assert.deepEqual(results[0]?.tags, ["launch", "planning"]);
  } finally {
    store.close();
  }
});
