import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NoteSession } from "../src/session.js";
import { NoteStore } from "../src/storage.js";
import type { LlmProvider, LlmRequest } from "../src/types.js";

class MockProvider implements LlmProvider {
  async complete(request: LlmRequest): Promise<{ content: string }> {
    const prompt = request.messages.at(-1)?.content ?? "";
    if (prompt.includes("Extract lightweight metadata")) {
      return {
        content: JSON.stringify({
          title: "Garden Plan",
          tags: ["garden", "ideas"],
          dates: ["tomorrow"],
          summary: "Ideas for the garden plan.",
          type: "idea"
        })
      };
    }
    if (prompt.includes("Lightly organize")) {
      return { content: "## Garden Plan\n\n- Buy soil\n- Sketch beds" };
    }
    return { content: "ok" };
  }
}

class FailingProvider implements LlmProvider {
  async complete(): Promise<{ content: string }> {
    throw new Error("LLM request failed with 429: insufficient_quota");
  }
}

test("captures, extracts metadata, processes, saves, and searches", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });
  const session = new NoteSession(store, new MockProvider());

  try {
    await session.append("Garden plan tomorrow: buy soil and sketch beds.");
    const processed = await session.process();
    const saved = session.save();
    const results = session.search("soil");

    assert.match(processed, /Garden Plan/);
    assert.equal(saved.title, "Garden Plan");
    assert.equal(fs.existsSync(saved.markdownPath), true);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.title, "Garden Plan");
  } finally {
    store.close();
  }
});

test("capture falls back to local metadata when automatic provider metadata fails", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-fallback-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });
  const session = new NoteSession(store, new FailingProvider());

  try {
    await session.append("Quota-safe capture today.");
    const saved = session.save();

    assert.equal(saved.title, "Quota-safe Capture Today.");
    assert.equal(fs.existsSync(saved.markdownPath), true);
  } finally {
    store.close();
  }
});

test("summary falls back locally when provider request fails", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-summary-fallback-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });
  const session = new NoteSession(store, new FailingProvider());

  try {
    await session.append("Quota-safe summary today.");
    const summary = await session.summarize();

    assert.equal(summary, "Quota-safe summary today.");
  } finally {
    store.close();
  }
});

test("tag regeneration falls back locally when provider request fails", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-tag-fallback-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });
  const session = new NoteSession(store, new FailingProvider());

  try {
    await session.append("Research notes about sqlite indexing and query planning.");
    const tags = await session.regenerateTags();

    assert.deepEqual(tags, ["research", "notes", "sqlite", "indexing", "query", "planning"]);
  } finally {
    store.close();
  }
});

test("preserves multiline raw content in a single append", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-multiline-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });
  const session = new NoteSession(store);

  try {
    await session.append("Line one\n\nLine three");

    assert.equal(session.raw, "Line one\n\nLine three");
  } finally {
    store.close();
  }
});

test("saving the same session updates the current note instead of duplicating it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-update-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });
  const session = new NoteSession(store);

  try {
    await session.append("Roadmap idea");
    const first = session.save();
    await session.append("Add budget details");
    const second = session.save();

    assert.equal(second.id, first.id);
    assert.equal(second.markdownPath, first.markdownPath);
    assert.equal(fs.readdirSync(path.join(dir, "notes")).length, 1);
    assert.match(fs.readFileSync(first.markdownPath, "utf8"), /Add budget details/);
    assert.equal(session.search("budget").length, 1);
  } finally {
    store.close();
  }
});

test("new note resets save tracking so the next save creates a separate file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-new-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });
  const session = new NoteSession(store);

  try {
    await session.append("First note");
    const first = session.save();
    await session.newNote();
    await session.append("Second note");
    const second = session.save();

    assert.notEqual(second.id, first.id);
    assert.notEqual(second.markdownPath, first.markdownPath);
    assert.equal(fs.readdirSync(path.join(dir, "notes")).length, 2);
  } finally {
    store.close();
  }
});

test("autosave skips unchanged drafts", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-autosave-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });
  const session = new NoteSession(store);

  try {
    await session.append("Autosave note");
    const saved = session.autosave();
    const clean = session.autosave();

    assert.equal(saved?.title, "Autosave Note");
    assert.equal(clean, undefined);
    assert.equal(fs.readdirSync(path.join(dir, "notes")).length, 1);
  } finally {
    store.close();
  }
});
