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

test("checks notes by date", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-check-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });

  try {
    store.saveDraft({
      raw: "Today we reviewed launch prep.",
      metadata: {
        title: "Launch Prep",
        tags: ["launch"],
        dates: ["today"],
        summary: "Launch prep notes.",
        type: "meeting"
      }
    }, new Date("2026-06-20T12:00:00Z"));

    store.saveDraft({
      raw: "Older research note.",
      metadata: {
        title: "Older Research",
        tags: ["research"],
        dates: [],
        summary: "Older note.",
        type: "research"
      }
    }, new Date("2026-06-19T12:00:00Z"));

    const results = store.checkByDate({
      kind: "date",
      label: "today",
      targetDate: "2026-06-20",
      relativeWord: "today"
    });

    assert.equal(results.length, 1);
    assert.equal(results[0]?.title, "Launch Prep");
    assert.deepEqual(results[0]?.reasons, ["saved on 2026-06-20", "mentions today"]);
  } finally {
    store.close();
  }
});
