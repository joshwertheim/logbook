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
        topics: ["Launch planning"],
        entities: [{ name: "Friday launch", type: "event" }],
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
    assert.deepEqual(results[0]?.topics, ["Launch planning"]);
    assert.deepEqual(results[0]?.entities, [{ name: "Friday launch", type: "event" }]);

    const db = new DatabaseSync(path.join(dir, ".logbook", "logbook.sqlite"));
    try {
      const row = db.prepare("SELECT metadata_json FROM notes WHERE id = ?").get(saved.id) as { metadata_json: string };
      const metadata = JSON.parse(row.metadata_json) as { topics?: unknown; entities?: unknown };
      assert.deepEqual(metadata.topics, ["Launch planning"]);
      assert.deepEqual(metadata.entities, [{ name: "Friday launch", type: "event" }]);
    } finally {
      db.close();
    }
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
        topics: [],
        entities: [],
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
        topics: ["Budgeting"],
        entities: [{ name: "Roadmap", type: "project" }],
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
    assert.deepEqual(newResults[0]?.topics, ["Budgeting"]);

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

test("resolves exact note candidates by id, title, path, and basename", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-resolve-exact-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });

  try {
    const saved = store.saveDraft({
      raw: "Exact resolution note.",
      metadata: {
        title: "Resolution Target",
        tags: [],
        topics: [],
        entities: [],
        dates: [],
        summary: "Resolution note.",
        type: "scratchpad"
      }
    }, new Date("2026-06-19T12:00:00Z"));

    assert.equal(store.resolveNoteCandidates(String(saved.id))[0]?.id, saved.id);
    assert.equal(store.resolveNoteCandidates("resolution target")[0]?.id, saved.id);
    assert.equal(store.resolveNoteCandidates(saved.markdownPath)[0]?.id, saved.id);
    assert.equal(store.resolveNoteCandidates(path.basename(saved.markdownPath))[0]?.id, saved.id);
    assert.equal(store.resolveNoteCandidates(path.basename(saved.markdownPath, ".md"))[0]?.id, saved.id);

    const draft = store.getDraft(saved.id);
    assert.equal(draft?.raw, "Exact resolution note.");
    assert.equal(draft?.metadata.title, "Resolution Target");
  } finally {
    store.close();
  }
});

test("indexes markdown edits into sqlite", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-index-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });

  try {
    const saved = store.saveDraft({
      raw: "Initial launch checklist.",
      metadata: {
        title: "Launch Checklist",
        tags: ["launch"],
        topics: ["Launch planning"],
        entities: [],
        dates: [],
        summary: "Initial launch notes.",
        type: "meeting"
      }
    }, new Date("2026-06-19T12:00:00Z"));

    fs.writeFileSync(saved.markdownPath, [
      "---",
      'title: "Launch Checklist"',
      'type: "research"',
      'summary: "Updated budget note."',
      'tags: ["budget"]',
      'topics: ["Planning"]',
      'entities: [{"name":"Roadmap","type":"project"}]',
      'dates: ["2026-06-20"]',
      "---",
      "# Budget Review",
      "",
      "## Raw Capture",
      "",
      "Updated budget review with Roadmap details.",
      "",
      "## Organized Version",
      "",
      "Budget review organized notes."
    ].join("\n"), "utf8");

    const result = store.indexMarkdownNotes();

    assert.equal(result.indexed, 1);
    assert.equal(result.updated, 1);
    assert.equal(store.search("launch").length, 0);

    const results = store.search("budget");
    assert.equal(results.length, 1);
    assert.equal(results[0]?.id, saved.id);
    assert.equal(results[0]?.title, "Budget Review");
    assert.deepEqual(results[0]?.tags, ["budget"]);
    assert.deepEqual(results[0]?.topics, ["Planning"]);
    assert.deepEqual(results[0]?.entities, [{ name: "Roadmap", type: "project" }]);
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
        topics: [],
        entities: [],
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
        topics: [],
        entities: [],
        dates: [],
        summary: "Older note.",
        type: "research"
      }
    }, new Date("2026-06-19T12:00:00Z"));

    const results = store.checkByDate({
      kind: "date",
      label: "today",
      targetDate: "2026-06-20",
      relativeWord: "today",
      subjectTerms: []
    });

    assert.equal(results.length, 1);
    assert.equal(results[0]?.title, "Launch Prep");
    assert.deepEqual(results[0]?.reasons, ["saved on 2026-06-20", "mentions today"]);
  } finally {
    store.close();
  }
});

test("checks notes by date and subject terms", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-check-subject-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });

  try {
    store.saveDraft({
      raw: "Today I gave Haru his first dose of anti-seizure medicine.",
      metadata: {
        title: "Haru Medication",
        tags: ["haru"],
        topics: ["medicine"],
        entities: [{ name: "Haru", type: "other" }],
        dates: ["today"],
        summary: "Haru got his medicine.",
        type: "journal"
      }
    }, new Date("2026-06-20T12:00:00Z"));

    store.saveDraft({
      raw: "Today I watched PAR vs TUR World Cup.",
      metadata: {
        title: "World Cup",
        tags: ["world-cup"],
        topics: [],
        entities: [],
        dates: ["today"],
        summary: "Watched a World Cup match.",
        type: "journal"
      }
    }, new Date("2026-06-20T13:00:00Z"));

    const results = store.checkByDate({
      kind: "date",
      label: "today",
      targetDate: "2026-06-20",
      relativeWord: "today",
      subjectTerms: ["haru", "medicine"]
    });

    assert.equal(results.length, 1);
    assert.equal(results[0]?.title, "Haru Medication");
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
        topics: [],
        entities: [],
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
          topics: [],
          entities: [],
          dates: [],
          summary: "Recent unrelated note.",
          type: "scratchpad"
        }
      }, new Date(`2026-02-${String((index % 28) + 1).padStart(2, "0")}T12:00:00Z`));
    }

    const results = store.checkByDate({
      kind: "date",
      label: "2026-06-20",
      targetDate: "2026-06-20",
      subjectTerms: []
    });

    assert.equal(results.length, 1);
    assert.equal(results[0]?.title, "Old Launch Date");
  } finally {
    store.close();
  }
});

test("backfills canonical metadata for existing database rows", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-backfill-"));
  const notesDir = path.join(dir, "notes");
  const dbPath = path.join(dir, ".logbook", "logbook.sqlite");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.mkdirSync(notesDir, { recursive: true });

  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        slug TEXT NOT NULL,
        markdown_path TEXT NOT NULL,
        raw_content TEXT NOT NULL,
        processed_content TEXT,
        summary TEXT NOT NULL,
        note_type TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE note_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        raw_content TEXT NOT NULL,
        processed_content TEXT,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE
      );

      CREATE TABLE note_tags (
        note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY (note_id, tag_id)
      );
    `);
    db.prepare(`
      INSERT INTO notes (title, slug, markdown_path, raw_content, processed_content, summary, note_type, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run("Brokerage Note", "brokerage-note", path.join(notesDir, "brokerage-note.md"), "Move VTI at Fidelity.", null, "Brokerage summary.", "research", "2026-06-20T12:00:00.000Z", "2026-06-20T12:00:00.000Z");
    db.prepare("INSERT INTO tags (name) VALUES (?)").run("finance");
    db.prepare("INSERT INTO note_tags (note_id, tag_id) VALUES (?, ?)").run(1, 1);
  } finally {
    db.close();
  }

  const store = new NoteStore({ notesDir, dbPath });
  try {
    const row = new DatabaseSync(dbPath);
    try {
      const result = row.prepare("SELECT metadata_json FROM notes WHERE id = 1").get() as { metadata_json: string };
      const metadata = JSON.parse(result.metadata_json) as { tags: string[]; topics: unknown[]; entities: unknown[] };
      assert.deepEqual(metadata.tags, ["finance"]);
      assert.deepEqual(metadata.topics, []);
      assert.deepEqual(metadata.entities, []);
    } finally {
      row.close();
    }
  } finally {
    store.close();
  }
});

test("search finds notes by topic and entity name", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-search-metadata-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });

  try {
    store.saveDraft({
      raw: "Review VTI position at Fidelity.",
      metadata: {
        title: "Brokerage Review",
        tags: ["finance"],
        topics: ["Investing"],
        entities: [
          { name: "Fidelity", type: "organization" },
          { name: "VTI", type: "security" }
        ],
        dates: [],
        summary: "Review brokerage positions.",
        type: "research"
      }
    }, new Date("2026-06-20T12:00:00Z"));

    assert.equal(store.search("Investing").length, 1);
    assert.equal(store.search("Fidelity").length, 1);
    assert.equal(store.search("entities").length, 0);
    assert.equal(store.search("dates").length, 0);
    assert.equal(store.search("type").length, 0);
  } finally {
    store.close();
  }
});

test("finds related notes by shared entities, tags, topics, dates, and keywords", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-related-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });

  try {
    store.saveDraft({
      raw: "Launch plan with Acme on 2026-07-01 covers beta onboarding.",
      metadata: {
        title: "Acme Launch Plan",
        tags: ["launch", "beta"],
        topics: ["Product launch"],
        entities: [{ name: "Acme", type: "organization" }],
        dates: ["2026-07-01"],
        summary: "Acme launch planning.",
        type: "meeting"
      }
    }, new Date("2026-06-20T12:00:00Z"));

    store.saveDraft({
      raw: "A launch checklist for customer onboarding and release notes.",
      metadata: {
        title: "Launch Checklist",
        tags: ["launch"],
        topics: ["Release planning"],
        entities: [],
        dates: [],
        summary: "Checklist for launch.",
        type: "task list"
      }
    }, new Date("2026-06-20T13:00:00Z"));

    store.saveDraft({
      raw: "Unrelated grocery list.",
      metadata: {
        title: "Groceries",
        tags: ["errands"],
        topics: [],
        entities: [],
        dates: [],
        summary: "Buy vegetables.",
        type: "scratchpad"
      }
    }, new Date("2026-06-20T14:00:00Z"));

    const results = store.relatedToDraft({
      raw: "Acme beta launch meeting on 2026-07-01.",
      metadata: {
        title: "Acme Beta Launch",
        tags: ["launch"],
        topics: ["Product launch"],
        entities: [{ name: "Acme", type: "organization" }],
        dates: ["2026-07-01"],
        summary: "Follow up on Acme beta launch.",
        type: "meeting"
      }
    });

    assert.equal(results.length, 2);
    assert.equal(results[0]?.title, "Acme Launch Plan");
    assert.equal(results[0]?.strength, "Strong");
    assert.match(results[0]?.reasons.join(" "), /shared entities: acme/);
    assert.match(results[0]?.reasons.join(" "), /shared tags: launch/);
    assert.match(results[0]?.reasons.join(" "), /shared topics: product launch/);
    assert.match(results[0]?.reasons.join(" "), /shared dates: 2026-07-01/);
    assert.equal(results[1]?.title, "Launch Checklist");
  } finally {
    store.close();
  }
});

test("finds related notes for free query keyword lookup", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-related-query-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });

  try {
    store.saveDraft({
      raw: "Roadmap launch plan for mobile beta.",
      metadata: {
        title: "Mobile Launch",
        tags: ["roadmap"],
        topics: ["Mobile beta"],
        entities: [],
        dates: [],
        summary: "Plan mobile beta launch.",
        type: "idea"
      }
    }, new Date("2026-06-20T12:00:00Z"));

    const results = store.relatedToQuery("mobile beta launch plan");

    assert.equal(results.length, 1);
    assert.equal(results[0]?.title, "Mobile Launch");
    assert.match(results[0]?.reasons.join(" "), /keyword overlap/);
  } finally {
    store.close();
  }
});

test("single-token related query prioritizes literal subject evidence over generated tags", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-related-literal-query-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });

  try {
    store.saveDraft({
      raw: "today I gave haru his first dose of anti-seizure medicine.",
      metadata: {
        title: "Haru Medication",
        tags: ["pet", "medication"],
        topics: ["Pet Care"],
        entities: [{ name: "Haru", type: "other" }],
        dates: [],
        summary: "Haru got his medicine.",
        type: "journal"
      }
    }, new Date("2026-06-20T12:00:00Z"));
    store.saveDraft({
      raw: "yesterday was distressing. haru sure is a lot of work!",
      metadata: {
        title: "Work and Well-being",
        tags: ["work", "stress", "haru"],
        topics: ["Work Life"],
        entities: [],
        dates: [],
        summary: "A distressing work day that mentions Haru.",
        type: "journal"
      }
    }, new Date("2026-06-20T12:01:00Z"));
    store.saveDraft({
      raw: "testing another note",
      metadata: {
        title: "Testing Another Note",
        tags: [],
        topics: [],
        entities: [],
        dates: [],
        summary: "testing another note",
        type: "scratchpad"
      }
    }, new Date("2026-06-20T12:02:00Z"));

    const results = store.relatedToQuery("haru");

    assert.deepEqual(results.map((result) => result.title), [
      "Haru Medication",
      "Work and Well-being"
    ]);
    assert.match(results[0]?.reasons.join(" ") ?? "", /literal entity match/);
    assert.doesNotMatch(results.map((result) => result.reasons.join(" ")).join(" "), /scratchpad/);
  } finally {
    store.close();
  }
});
