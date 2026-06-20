import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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

test("updates saved notes in place and records a new version", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-update-"));
  const dbPath = path.join(dir, ".logbook", "logbook.sqlite");
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath
  });

  try {
    const saved = store.saveDraft({
      raw: "Initial launch checklist.",
      metadata: {
        title: "Launch Checklist",
        tags: ["launch", "planning"],
        dates: [],
        summary: "Initial launch notes.",
        type: "meeting"
      }
    }, new Date("2026-06-19T12:00:00Z"));

    const updated = store.updateDraft(saved.id, {
      raw: "Updated roadmap note with budget details.",
      metadata: {
        title: "Roadmap Budget",
        tags: ["budget"],
        dates: ["tomorrow"],
        summary: "Updated budget notes.",
        type: "research"
      }
    }, new Date("2026-06-19T12:05:00Z"));

    assert.equal(updated.id, saved.id);
    assert.equal(updated.markdownPath, saved.markdownPath);
    assert.equal(fs.readdirSync(path.join(dir, "notes")).length, 1);
    assert.match(fs.readFileSync(saved.markdownPath, "utf8"), /Updated roadmap note/);

    const oldResults = store.search("launch");
    const newResults = store.search("budget");
    assert.equal(oldResults.length, 0);
    assert.equal(newResults.length, 1);
    assert.equal(newResults[0]?.title, "Roadmap Budget");
    assert.deepEqual(newResults[0]?.tags, ["budget"]);

    const db = new DatabaseSync(dbPath);
    try {
      const row = db.prepare("SELECT COUNT(*) AS count FROM note_versions WHERE note_id = ?").get(saved.id) as { count: number };
      assert.equal(row.count, 2);
    } finally {
      db.close();
    }
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

test("checks notes by date beyond the 100 most recently updated notes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-check-limit-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });

  try {
    store.saveDraft({
      raw: "Old note mentions the launch date.",
      metadata: {
        title: "Old Launch Date",
        tags: ["launch"],
        dates: ["2026-06-20"],
        summary: "Old launch date note.",
        type: "meeting"
      }
    }, new Date("2026-01-01T12:00:00Z"));

    for (let index = 0; index < 100; index += 1) {
      store.saveDraft({
        raw: `Recent unrelated note ${index}.`,
        metadata: {
          title: `Recent ${index}`,
          tags: [],
          dates: [],
          summary: "Recent unrelated note.",
          type: "scratchpad"
        }
      }, new Date(`2026-02-${String((index % 28) + 1).padStart(2, "0")}T12:00:00Z`));
    }

    const results = store.checkByDate({
      kind: "date",
      label: "2026-06-20",
      targetDate: "2026-06-20"
    });

    assert.equal(results.length, 1);
    assert.equal(results[0]?.title, "Old Launch Date");
  } finally {
    store.close();
  }
});
