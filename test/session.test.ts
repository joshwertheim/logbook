import assert from "node:assert/strict";
import Database from "better-sqlite3";
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
          topics: ["Garden planning"],
          entities: [{ name: "Garden beds", type: "project" }],
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

class RecordingSessionProvider implements LlmProvider {
  requests: LlmRequest[] = [];

  async complete(request: LlmRequest): Promise<{ content: string }> {
    this.requests.push(request);
    return {
      content: JSON.stringify({
        title: "Contact Note",
        tags: ["contact"],
        topics: [],
        entities: [],
        dates: [],
        summary: "Contact details.",
        type: "scratchpad"
      })
    };
  }
}

class FailingProvider implements LlmProvider {
  async complete(): Promise<{ content: string }> {
    throw new Error("LLM request failed with 429: insufficient_quota");
  }
}

class DeferredMetadataProvider implements LlmProvider {
  called = false;
  private resolveMetadata: ((value: { content: string }) => void) | undefined;

  async complete(request: LlmRequest): Promise<{ content: string }> {
    const prompt = request.messages.at(-1)?.content ?? "";
    if (prompt.includes("Extract lightweight metadata")) {
      this.called = true;
      return new Promise((resolve) => {
        this.resolveMetadata = resolve;
      });
    }
    return { content: "ok" };
  }

  resolve(): void {
    this.resolveMetadata?.({
      content: JSON.stringify({
        title: "Async Garden Plan",
        tags: ["garden"],
        topics: ["Garden planning"],
        entities: [{ name: "Garden beds", type: "project" }],
        dates: ["tomorrow"],
        summary: "Ideas for the garden plan.",
        type: "idea"
      })
    });
  }
}

class RerankProvider implements LlmProvider {
  async complete(request: LlmRequest): Promise<{ content: string }> {
    const prompt = request.messages.at(-1)?.content ?? "";
    if (prompt.includes("Rerank related notes")) {
      const parsed = JSON.parse(prompt) as { untrustedNotes: Array<{ id: number }> };
      return {
        content: JSON.stringify({
          results: [
            {
              id: parsed.untrustedNotes[0]?.id,
              relevance: 95,
              strength: "Strong",
              explanation: "Both notes are about the launch plan."
            }
          ]
        })
      };
    }
    return { content: "{}" };
  }
}

class StrongAllRerankProvider implements LlmProvider {
  async complete(request: LlmRequest): Promise<{ content: string }> {
    const prompt = request.messages.at(-1)?.content ?? "";
    if (prompt.includes("Rerank related notes")) {
      const parsed = JSON.parse(prompt) as { untrustedNotes: Array<{ id: number }> };
      return {
        content: JSON.stringify({
          results: parsed.untrustedNotes.map((candidate) => ({
            id: candidate.id,
            relevance: 95,
            strength: "Strong",
            explanation: "The provider says this is strongly related."
          }))
        })
      };
    }
    return { content: "{}" };
  }
}

class WorkHoursRerankProvider implements LlmProvider {
  async complete(request: LlmRequest): Promise<{ content: string }> {
    const prompt = request.messages.at(-1)?.content ?? "";
    if (prompt.includes("Rerank related notes")) {
      const parsed = JSON.parse(prompt) as { untrustedNotes: Array<{ id: number; title: string }> };
      return {
        content: JSON.stringify({
          results: parsed.untrustedNotes.map((candidate) => candidate.title === "Work and Well-being"
            ? {
                id: candidate.id,
                relevance: 55,
                strength: "Moderate",
                explanation: "Directly discusses work, hours, and workload over the past and upcoming weeks."
              }
            : {
                id: candidate.id,
                relevance: 20,
                strength: "Weak",
                explanation: "Mentions need related to pet medication, not work hours or schedule."
              })
        })
      };
    }
    return { content: "{}" };
  }
}

class UnrelatedRerankProvider implements LlmProvider {
  async complete(request: LlmRequest): Promise<{ content: string }> {
    const prompt = request.messages.at(-1)?.content ?? "";
    if (prompt.includes("Rerank related notes")) {
      const parsed = JSON.parse(prompt) as { untrustedNotes: Array<{ id: number }> };
      return {
        content: JSON.stringify({
          results: parsed.untrustedNotes.map((candidate) => ({
            id: candidate.id,
            relevance: 5,
            strength: "Unrelated",
            explanation: "Not related to the source note."
          }))
        })
      };
    }
    return { content: "{}" };
  }
}

class DecisionAnalysisProvider implements LlmProvider {
  called = false;

  async complete(request: LlmRequest): Promise<{ content: string }> {
    const prompt = request.messages.at(-1)?.content ?? "";
    if (prompt.includes("Find explicit or strongly implied decisions")) {
      this.called = true;
      const parsed = JSON.parse(prompt) as { contextMode: string; untrustedNotes: Array<{ id: number; content?: string; contentExcerpt?: string; snippet: string }> };
      assert.equal(parsed.contextMode, "metadata+snippets");
      assert.equal(parsed.untrustedNotes[0]?.content, undefined);
      assert.equal(parsed.untrustedNotes[0]?.contentExcerpt, undefined);
      assert.match(parsed.untrustedNotes[0]?.snippet ?? "", /Use PKCE/);
      return {
        content: JSON.stringify({
          decisions: [
            {
              decision: "Use PKCE for the OAuth flow.",
              rationale: "The note says PKCE avoids shipping a client secret.",
              status: "Chosen",
              confidence: "High",
              relatedNoteIds: [parsed.untrustedNotes[0]?.id]
            }
          ]
        })
      };
    }
    return { content: "{}" };
  }
}

class GapAnalysisProvider implements LlmProvider {
  called = false;

  async complete(request: LlmRequest): Promise<{ content: string }> {
    const prompt = request.messages.at(-1)?.content ?? "";
    if (prompt.includes("Find important terms, entities, acronyms")) {
      this.called = true;
      const parsed = JSON.parse(prompt) as { contextMode: string; untrustedNotes: Array<{ id: number; content?: string; contentExcerpt?: string; snippet: string }> };
      assert.equal(parsed.contextMode, "metadata+snippets");
      assert.equal(parsed.untrustedNotes[0]?.content, undefined);
      assert.equal(parsed.untrustedNotes[0]?.contentExcerpt, undefined);
      assert.match(parsed.untrustedNotes[0]?.snippet ?? "", /PKCE/);
      return {
        content: JSON.stringify({
          gaps: [
            {
              term: "PKCE",
              whyItMatters: "It affects how the OAuth client proves possession during auth.",
              evidence: "PKCE is named as required but not defined.",
              suggestedQuestion: "What is PKCE and why does this OAuth flow need it?",
              relatedNoteIds: [parsed.untrustedNotes[0]?.id]
            }
          ]
        })
      };
    }
    return { content: "{}" };
  }
}

class ContextAnalysisProvider implements LlmProvider {
  called = false;

  async complete(request: LlmRequest): Promise<{ content: string }> {
    const prompt = request.messages.at(-1)?.content ?? "";
    if (prompt.includes("Create a concise knowledge snapshot")) {
      this.called = true;
      const parsed = JSON.parse(prompt) as { contextMode: string; untrustedNotes: Array<{ id: number; content?: string; contentExcerpt?: string; snippet: string }> };
      assert.equal(parsed.contextMode, "metadata+snippets");
      assert.equal(parsed.untrustedNotes[0]?.content, undefined);
      assert.equal(parsed.untrustedNotes[0]?.contentExcerpt, undefined);
      assert.match(parsed.untrustedNotes[0]?.snippet ?? "", /PKCE/);
      return {
        content: JSON.stringify({
          snapshot: ["PKCE is the chosen direction for the OAuth public client."],
          themes: [
            {
              title: "OAuth security",
              details: "The notes center on using PKCE because a public client cannot safely hold a secret.",
              relatedNoteIds: [parsed.untrustedNotes[0]?.id, 99999]
            }
          ],
          timeline: [
            {
              date: "2026-06-20",
              event: "PKCE decision recorded.",
              relatedNoteIds: [parsed.untrustedNotes[0]?.id]
            },
            {
              date: "2026-06-21",
              event: "Invalid note reference should be dropped.",
              relatedNoteIds: [99999]
            }
          ],
          gaps: [
            {
              question: "Who owns OAuth rollout?",
              reason: "The matching notes do not name an owner.",
              relatedNoteIds: [parsed.untrustedNotes[0]?.id]
            }
          ]
        })
      };
    }
    return { content: "{}" };
  }
}

class MalformedAnalysisProvider implements LlmProvider {
  async complete(): Promise<{ content: string }> {
    return { content: JSON.stringify({ results: [] }) };
  }
}

class RecordingContextProvider implements LlmProvider {
  requests: LlmRequest[] = [];

  async complete(request: LlmRequest): Promise<{ content: string }> {
    this.requests.push(request);
    const prompt = request.messages.at(-1)?.content ?? "";
    if (prompt.includes("Create a concise knowledge snapshot")) {
      return {
        content: JSON.stringify({
          snapshot: ["Recorded context."],
          themes: [],
          timeline: [],
          gaps: []
        })
      };
    }
    return { content: "{}" };
  }
}

class RecordingProcessProvider implements LlmProvider {
  requests: LlmRequest[] = [];

  async complete(request: LlmRequest): Promise<{ content: string }> {
    this.requests.push(request);
    const prompt = request.messages.at(-1)?.content ?? "";
    if (prompt.includes("Extract lightweight metadata")) {
      return {
        content: JSON.stringify({
          title: "Oversized Note",
          tags: [],
          topics: [],
          entities: [],
          dates: [],
          summary: "Oversized note.",
          type: "scratchpad"
        })
      };
    }
    return { content: "## Organized\n\nClean note." };
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
    assert.deepEqual(results[0]?.topics, ["Garden planning"]);
    assert.deepEqual(results[0]?.entities, [{ name: "Garden beds", type: "project" }]);
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

test("append does not wait for automatic provider metadata", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-async-metadata-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });
  const provider = new DeferredMetadataProvider();
  const session = new NoteSession(store, provider);

  try {
    await session.append("Garden plan tomorrow: buy soil and sketch beds.");
    assert.equal(provider.called, true);

    const saved = session.save();
    assert.equal(saved.title, "Garden Plan Tomorrow: Buy Soil And Sketch Beds.");

    provider.resolve();
    await new Promise((resolve) => setImmediate(resolve));

    const results = session.search("Garden planning");
    assert.equal(results.length, 1);
    assert.equal(results[0]?.title, "Async Garden Plan");
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

test("metadata refresh updates the current draft and saved search shape", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-metadata-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });
  const session = new NoteSession(store, new MockProvider());

  try {
    await session.append("Garden plan tomorrow: buy soil and sketch beds.");
    const metadata = await session.refreshMetadata();
    const saved = session.save();
    const results = session.search("Garden planning");

    assert.deepEqual(metadata.topics, ["Garden planning"]);
    assert.equal(saved.content, "Garden plan tomorrow: buy soil and sketch beds.");
    assert.equal(results.length, 1);
    assert.deepEqual(results[0]?.entities, [{ name: "Garden beds", type: "project" }]);
  } finally {
    store.close();
  }
});

test("PII redaction does not mutate saved raw note content", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-pii-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });
  const provider = new RecordingSessionProvider();
  const session = new NoteSession(store, provider);
  const raw = "Contact Jane at jane@example.com or 415-555-1212.";

  try {
    await session.append(raw);
    await session.refreshMetadata();
    const saved = session.save();
    const prompt = provider.requests.at(-1)?.messages.at(-1)?.content ?? "";

    assert.match(prompt, /\[REDACTED_EMAIL_1\]/);
    assert.match(prompt, /\[REDACTED_PHONE_1\]/);
    assert.equal(saved.content, raw);
    assert.match(fs.readFileSync(saved.markdownPath, "utf8"), /jane@example\.com/);
  } finally {
    store.close();
  }
});

test("current note provider prompts clamp oversized raw content without mutating saved content", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-current-note-clamp-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });
  const provider = new RecordingProcessProvider();
  const session = new NoteSession(store, provider);
  const raw = `Oversized note\n${"alpha ".repeat(3000)}`;

  try {
    await session.append(raw);
    await session.process();
    const saved = session.save();

    const processPrompt = provider.requests.find((request) => (request.messages.at(-1)?.content ?? "").includes("Lightly organize"))?.messages.at(-1)?.content ?? "";
    const parsed = JSON.parse(processPrompt) as { untrustedNote: string };
    assert.equal(parsed.untrustedNote.length, 12000);
    assert.equal(saved.content, session.raw);
    assert.ok(saved.content.length > parsed.untrustedNote.length);
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

test("replaceRawCapture replaces current draft, clears processed content, and preserves saved identity", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-compose-replace-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });
  const session = new NoteSession(store, new MockProvider());

  try {
    await session.append("Initial roadmap note.");
    const first = session.save();
    await session.process();

    await session.replaceRawCapture("Line one\n\nLine three");

    assert.equal(session.raw, "Line one\n\nLine three");
    assert.equal(session.draft.processed, undefined);

    const second = session.save();
    assert.equal(second.id, first.id);
    assert.equal(second.markdownPath, first.markdownPath);
    assert.equal(fs.readdirSync(path.join(dir, "notes")).length, 1);

    const draft = store.getDraft(first.id);
    assert.equal(draft?.raw, "Line one\n\nLine three");
    assert.equal(draft?.processed, undefined);
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

test("resolves notes by exact id and dominant deterministic candidate", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-resolve-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });
  const session = new NoteSession(store);

  try {
    const haru = store.saveDraft({
      raw: "Haru medicine schedule and refill notes.",
      metadata: {
        title: "Haru Medicine",
        tags: ["pet-care"],
        topics: [],
        entities: [{ name: "Haru", type: "other" }],
        dates: [],
        summary: "Medicine schedule.",
        type: "scratchpad"
      }
    });
    store.saveDraft({
      raw: "Generic medicine cabinet inventory.",
      metadata: {
        title: "Medicine Cabinet",
        tags: [],
        topics: [],
        entities: [],
        dates: [],
        summary: "Cabinet inventory.",
        type: "scratchpad"
      }
    });

    const byId = await session.resolveNote(String(haru.id));
    assert.equal(byId.selected?.id, haru.id);

    const dominant = await session.resolveNote("haru");
    assert.equal(dominant.selected?.id, haru.id);
  } finally {
    store.close();
  }
});

test("ambiguous deterministic note resolution returns candidates without selecting", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-resolve-ambiguous-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });
  const session = new NoteSession(store);

  try {
    store.saveDraft({
      raw: "Launch checklist for product beta.",
      metadata: {
        title: "Product Launch",
        tags: [],
        topics: [],
        entities: [],
        dates: [],
        summary: "Launch checklist.",
        type: "meeting"
      }
    });
    store.saveDraft({
      raw: "Launch checklist for marketing beta.",
      metadata: {
        title: "Marketing Launch",
        tags: [],
        topics: [],
        entities: [],
        dates: [],
        summary: "Launch checklist.",
        type: "meeting"
      }
    });

    const resolution = await session.resolveNote("launch");
    assert.equal(resolution.selected, undefined);
    assert.equal(resolution.candidates.length, 2);
    assert.match(resolution.llmSkippedReason ?? "", /provider is not configured/);
  } finally {
    store.close();
  }
});

test("appendToExistingNote appends a dated update to the same note and preserves title", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-amend-"));
  const dbPath = path.join(dir, ".logbook", "logbook.sqlite");
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath
  });
  const session = new NoteSession(store);

  try {
    const saved = store.saveDraft({
      raw: "Initial launch checklist.",
      metadata: {
        title: "Launch Checklist",
        tags: ["launch"],
        topics: [],
        entities: [],
        dates: [],
        summary: "Initial launch notes.",
        type: "meeting"
      },
      processed: "Organized launch checklist."
    }, new Date("2026-06-19T12:00:00Z"));

    const updated = await session.appendToExistingNote(saved.id, "Added rollout owner.", new Date("2026-06-20T12:00:00Z"));

    assert.equal(updated.id, saved.id);
    assert.equal(updated.markdownPath, saved.markdownPath);
    assert.equal(updated.title, "Launch Checklist");
    const markdown = fs.readFileSync(saved.markdownPath, "utf8");
    assert.match(markdown, /Initial launch checklist\./);
    assert.match(markdown, /## Update 2026-06-20/);
    assert.match(markdown, /Added rollout owner\./);
    assert.equal(session.search("rollout").length, 1);

    const db = new Database(dbPath);
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

test("replaceExistingNote replaces raw capture, clears processed content, and preserves title", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-edit-"));
  const dbPath = path.join(dir, ".logbook", "logbook.sqlite");
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath
  });
  const session = new NoteSession(store);

  try {
    const saved = store.saveDraft({
      raw: "Initial launch checklist.",
      metadata: {
        title: "Launch Checklist",
        tags: ["launch"],
        topics: [],
        entities: [],
        dates: [],
        summary: "Initial launch notes.",
        type: "meeting"
      },
      processed: "Organized launch checklist."
    }, new Date("2026-06-19T12:00:00Z"));

    const updated = await session.replaceExistingNote(saved.id, "Replacement budget details.");

    assert.equal(updated.id, saved.id);
    assert.equal(updated.markdownPath, saved.markdownPath);
    assert.equal(updated.title, "Launch Checklist");
    assert.equal(session.search("launch").length, 1);
    assert.equal(session.search("budget").length, 1);
    assert.match(fs.readFileSync(saved.markdownPath, "utf8"), /Replacement budget details\./);

    const draft = store.getDraft(saved.id);
    assert.equal(draft?.processed, undefined);

    const db = new Database(dbPath);
    try {
      const row = db.prepare("SELECT processed_content FROM notes WHERE id = ?").get(saved.id) as { processed_content: string | null };
      assert.equal(row.processed_content, null);
    } finally {
      db.close();
    }
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

test("new note saves dirty content before resetting", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-new-save-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });
  const session = new NoteSession(store);

  try {
    await session.append("Unsaved note before new");
    await session.newNote();
    await session.append("Next note");
    const next = session.save();

    assert.equal(next.title, "Next Note");
    assert.equal(fs.readdirSync(path.join(dir, "notes")).length, 2);
    assert.equal(session.search("Unsaved").length, 1);
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

test("related lookup for current note excludes the current saved note", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-related-current-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });
  const session = new NoteSession(store);

  try {
    await session.append("Acme launch plan.");
    const current = session.save();
    store.saveDraft({
      raw: "Follow-up Acme launch checklist.",
      metadata: {
        title: "Launch Follow-up",
        tags: ["launch"],
        topics: [],
        entities: [],
        dates: [],
        summary: "Follow-up checklist.",
        type: "task list"
      }
    }, new Date("2026-06-20T12:00:00Z"));

    const lookup = await session.related();

    assert.equal(lookup.results.length, 1);
    assert.notEqual(lookup.results[0]?.id, current.id);
    assert.equal(lookup.results[0]?.title, "Launch Follow-up");
  } finally {
    store.close();
  }
});

test("related lookup supports free query without current note content", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-related-query-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });
  const session = new NoteSession(store);

  try {
    store.saveDraft({
      raw: "Launch roadmap for mobile beta.",
      metadata: {
        title: "Mobile Launch",
        tags: ["launch"],
        topics: ["Mobile beta"],
        entities: [],
        dates: [],
        summary: "Mobile launch roadmap.",
        type: "idea"
      }
    }, new Date("2026-06-20T12:00:00Z"));

    const lookup = await session.related({ query: "mobile beta launch" });

    assert.equal(lookup.results.length, 1);
    assert.equal(lookup.results[0]?.title, "Mobile Launch");
  } finally {
    store.close();
  }
});

test("related lookup for haru hides notes without matching evidence", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-related-haru-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });
  const session = new NoteSession(store);

  try {
    store.saveDraft({
      raw: "Haru deployment checklist.",
      metadata: {
        title: "Haru Deployment",
        tags: [],
        topics: [],
        entities: [],
        dates: [],
        summary: "Deployment checklist for Haru.",
        type: "task list"
      }
    }, new Date("2026-06-20T12:00:00Z"));
    store.saveDraft({
      raw: "Grocery list for dinner.",
      metadata: {
        title: "Groceries",
        tags: [],
        topics: [],
        entities: [],
        dates: [],
        summary: "Dinner groceries.",
        type: "task list"
      }
    }, new Date("2026-06-20T12:01:00Z"));

    const lookup = await session.related({ query: "haru" });

    assert.deepEqual(lookup.results.map((result) => result.title), ["Haru Deployment"]);
  } finally {
    store.close();
  }
});

test("related lookup caps provider strength to deterministic evidence", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-related-strength-cap-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });
  const session = new NoteSession(store, new StrongAllRerankProvider());

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

    const lookup = await session.related({ query: "haru" });
    const strengths = new Map(lookup.results.map((result) => [result.title, result.strength]));

    assert.equal(strengths.get("Haru Medication"), "Strong");
    assert.equal(strengths.get("Work and Well-being"), "Moderate");
  } finally {
    store.close();
  }
});

test("related lookup drops weak contrastive rerank explanations", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-related-contrastive-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });
  const session = new NoteSession(store, new WorkHoursRerankProvider());

  try {
    store.saveDraft({
      raw: "yesterday was very distressing. i had to take the day off work.\ni'll probably need one or two days off next week too.",
      metadata: {
        title: "Work and Well-being",
        tags: ["work", "stress", "leave"],
        topics: ["Work Life"],
        entities: [],
        dates: ["yesterday", "next week"],
        summary: "A distressing work day with possible leave next week.",
        type: "journal"
      }
    }, new Date("2026-06-20T12:00:00Z"));
    store.saveDraft({
      raw: "we have an appoint for a consult at the veterinary neurologist.\nit'll be on tuesday afternoon.",
      metadata: {
        title: "Haru's Medication and Vet Appointment",
        tags: ["pet", "medication", "veterinary"],
        topics: ["Pet Care"],
        entities: [{ name: "Haru", type: "other" }],
        dates: ["Tuesday afternoon"],
        summary: "Notes about Haru's medication and upcoming vet appointment.",
        type: "journal"
      }
    }, new Date("2026-06-20T12:01:00Z"));

    const lookup = await session.related({ query: "how has work been going the past week? do i need to worry about my hours over the next couple weeks?" });

    assert.deepEqual(lookup.results.map((result) => result.title), ["Work and Well-being"]);
  } finally {
    store.close();
  }
});

test("decisions analysis synthesizes provider results from related notes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-decisions-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });
  const provider = new DecisionAnalysisProvider();
  const session = new NoteSession(store, provider);

  try {
    const note = store.saveDraft({
      raw: "OAuth decision: Use PKCE because we cannot safely ship a client secret.",
      metadata: {
        title: "OAuth PKCE Decision",
        tags: ["oauth"],
        topics: ["OAuth"],
        entities: [{ name: "PKCE", type: "security" }],
        dates: [],
        summary: "Decision to use PKCE for OAuth.",
        type: "research"
      }
    }, new Date("2026-06-20T12:00:00Z"));

    const analysis = await session.decisions("oauth");

    assert.equal(provider.called, true);
    assert.equal(analysis.query, "oauth");
    assert.equal(analysis.relatedNotes.length, 1);
    assert.deepEqual(analysis.decisions, [{
      decision: "Use PKCE for the OAuth flow.",
      rationale: "The note says PKCE avoids shipping a client secret.",
      status: "Chosen",
      confidence: "High",
      relatedNoteIds: [note.id]
    }]);
  } finally {
    store.close();
  }
});

test("gaps analysis identifies unexplained terms from related notes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-gaps-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });
  const provider = new GapAnalysisProvider();
  const session = new NoteSession(store, provider);

  try {
    const note = store.saveDraft({
      raw: "OAuth implementation note: PKCE is required for the public client.",
      metadata: {
        title: "OAuth Client Notes",
        tags: ["oauth"],
        topics: ["OAuth"],
        entities: [{ name: "PKCE", type: "security" }],
        dates: [],
        summary: "OAuth note mentioning PKCE.",
        type: "research"
      }
    }, new Date("2026-06-20T12:00:00Z"));

    const analysis = await session.gaps("oauth");

    assert.equal(provider.called, true);
    assert.equal(analysis.query, "oauth");
    assert.equal(analysis.relatedNotes.length, 1);
    assert.deepEqual(analysis.gaps, [{
      term: "PKCE",
      whyItMatters: "It affects how the OAuth client proves possession during auth.",
      evidence: "PKCE is named as required but not defined.",
      suggestedQuestion: "What is PKCE and why does this OAuth flow need it?",
      relatedNoteIds: [note.id]
    }]);
  } finally {
    store.close();
  }
});

test("context analysis falls back locally without provider", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-context-local-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });
  const session = new NoteSession(store);

  try {
    const note = store.saveDraft({
      raw: "OAuth implementation note: PKCE is required for the public client.",
      metadata: {
        title: "OAuth Client Notes",
        tags: ["oauth"],
        topics: ["OAuth"],
        entities: [{ name: "PKCE", type: "security" }],
        dates: ["2026-06-21"],
        summary: "OAuth note mentioning PKCE.",
        type: "research"
      }
    }, new Date("2026-06-20T12:00:00Z"));

    const analysis = await session.context("oauth");

    assert.equal(analysis.query, "oauth");
    assert.equal(analysis.relatedNotes.length, 1);
    assert.equal(analysis.relatedNotes[0]?.id, note.id);
    assert.match(analysis.snapshot[0] ?? "", /OAuth Client Notes/);
    assert.equal(analysis.gaps.length, 0);
    assert.match(analysis.llmSkippedReason ?? "", /provider is not configured/);
    assert.ok(analysis.themes.some((theme) => theme.relatedNoteIds.includes(note.id)));
    assert.ok(analysis.timeline.some((item) => item.date === "2026-06-20"));
    assert.ok(analysis.timeline.some((item) => item.date === "2026-06-21"));
  } finally {
    store.close();
  }
});

test("context analysis parses provider results and filters invalid note ids", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-context-provider-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });
  const provider = new ContextAnalysisProvider();
  const session = new NoteSession(store, provider);

  try {
    const note = store.saveDraft({
      raw: "OAuth implementation note: PKCE is required for the public client.",
      metadata: {
        title: "OAuth Client Notes",
        tags: ["oauth"],
        topics: ["OAuth"],
        entities: [{ name: "PKCE", type: "security" }],
        dates: [],
        summary: "OAuth note mentioning PKCE.",
        type: "research"
      }
    }, new Date("2026-06-20T12:00:00Z"));

    const analysis = await session.context("oauth");

    assert.equal(provider.called, true);
    assert.deepEqual(analysis.snapshot, ["PKCE is the chosen direction for the OAuth public client."]);
    assert.deepEqual(analysis.themes, [{
      title: "OAuth security",
      details: "The notes center on using PKCE because a public client cannot safely hold a secret.",
      relatedNoteIds: [note.id]
    }]);
    assert.deepEqual(analysis.timeline, [{
      date: "2026-06-20",
      event: "PKCE decision recorded.",
      relatedNoteIds: [note.id]
    }]);
    assert.deepEqual(analysis.gaps, [{
      question: "Who owns OAuth rollout?",
      reason: "The matching notes do not name an owner.",
      relatedNoteIds: [note.id]
    }]);
    assert.equal(analysis.llmSkippedReason, undefined);
  } finally {
    store.close();
  }
});

test("context analysis defaults to metadata and snippets without full raw content", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-context-metadata-only-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });
  const provider = new RecordingContextProvider();
  const session = new NoteSession(store, provider);

  try {
    const oversized = `OAuth implementation note: PKCE is required.\n${"secret raw detail ".repeat(400)}`;
    store.saveDraft({
      raw: oversized,
      metadata: {
        title: "OAuth Client Notes",
        tags: ["oauth"],
        topics: ["OAuth"],
        entities: [{ name: "PKCE", type: "security" }],
        dates: [],
        summary: "OAuth note mentioning PKCE.",
        type: "research"
      }
    }, new Date("2026-06-20T12:00:00Z"));

    await session.context("oauth");

    const prompt = provider.requests[0]?.messages.at(-1)?.content ?? "";
    const parsed = JSON.parse(prompt) as { contextMode: string; untrustedNotes: Array<{ content?: string; contentExcerpt?: string; snippet: string }> };
    assert.equal(parsed.contextMode, "metadata+snippets");
    assert.equal(parsed.untrustedNotes[0]?.content, undefined);
    assert.equal(parsed.untrustedNotes[0]?.contentExcerpt, undefined);
    assert.match(parsed.untrustedNotes[0]?.snippet ?? "", /PKCE/);
    assert.ok((parsed.untrustedNotes[0]?.snippet ?? "").length < oversized.length);
    assert.ok(prompt.length < oversized.length);
  } finally {
    store.close();
  }
});

test("context analysis with content includes bounded excerpts only", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-context-with-content-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });
  const provider = new RecordingContextProvider();
  const session = new NoteSession(store, provider);

  try {
    const oversized = `OAuth implementation note: PKCE is required.\n${"raw-detail ".repeat(2000)}`;
    store.saveDraft({
      raw: oversized,
      metadata: {
        title: "OAuth Client Notes",
        tags: ["oauth"],
        topics: ["OAuth"],
        entities: [{ name: "PKCE", type: "security" }],
        dates: [],
        summary: "OAuth note mentioning PKCE.",
        type: "research"
      }
    }, new Date("2026-06-20T12:00:00Z"));

    await session.context({ query: "oauth", includeContent: true });

    const prompt = provider.requests[0]?.messages.at(-1)?.content ?? "";
    const parsed = JSON.parse(prompt) as { contextMode: string; untrustedNotes: Array<{ content?: string; contentExcerpt?: string }> };
    assert.equal(parsed.contextMode, "metadata+bounded-content-excerpts");
    assert.equal(parsed.untrustedNotes[0]?.content, undefined);
    assert.match(parsed.untrustedNotes[0]?.contentExcerpt ?? "", /PKCE/);
    assert.ok((parsed.untrustedNotes[0]?.contentExcerpt ?? "").length <= 1200);
    assert.ok(prompt.length < oversized.length);
  } finally {
    store.close();
  }
});

test("context analysis falls back locally on malformed provider response", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-context-malformed-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });
  const session = new NoteSession(store, new MalformedAnalysisProvider());

  try {
    store.saveDraft({
      raw: "OAuth implementation note: PKCE is required.",
      metadata: {
        title: "OAuth Client Notes",
        tags: ["oauth"],
        topics: ["OAuth"],
        entities: [{ name: "PKCE", type: "security" }],
        dates: [],
        summary: "OAuth note mentioning PKCE.",
        type: "research"
      }
    }, new Date("2026-06-20T12:00:00Z"));

    const analysis = await session.context("oauth");

    assert.equal(analysis.relatedNotes.length, 1);
    assert.match(analysis.snapshot[0] ?? "", /OAuth Client Notes/);
    assert.match(analysis.llmSkippedReason ?? "", /LLM context synthesis skipped/);
  } finally {
    store.close();
  }
});

test("context analysis rejects empty query", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-context-empty-query-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });
  const session = new NoteSession(store);

  try {
    await assert.rejects(
      session.context("   "),
      /Usage: \/context \[--with-content\] <query>/
    );
  } finally {
    store.close();
  }
});

test("analysis commands return empty before calling provider when no notes match", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-analysis-empty-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });
  const provider = new DecisionAnalysisProvider();
  const session = new NoteSession(store, provider);

  try {
    const analysis = await session.decisions("oauth");

    assert.equal(provider.called, false);
    assert.deepEqual(analysis, {
      query: "oauth",
      decisions: [],
      relatedNotes: []
    });
  } finally {
    store.close();
  }
});

test("context analysis returns empty before calling provider when no notes match", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-context-empty-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });
  const provider = new ContextAnalysisProvider();
  const session = new NoteSession(store, provider);

  try {
    const analysis = await session.context("oauth");

    assert.equal(provider.called, false);
    assert.deepEqual(analysis, {
      query: "oauth",
      snapshot: [],
      themes: [],
      timeline: [],
      gaps: [],
      relatedNotes: []
    });
  } finally {
    store.close();
  }
});

test("analysis commands require a provider when related notes exist", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-analysis-provider-required-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });
  const session = new NoteSession(store);

  try {
    store.saveDraft({
      raw: "OAuth decision: Use PKCE.",
      metadata: {
        title: "OAuth PKCE Decision",
        tags: ["oauth"],
        topics: ["OAuth"],
        entities: [{ name: "PKCE", type: "security" }],
        dates: [],
        summary: "Decision to use PKCE.",
        type: "research"
      }
    }, new Date("2026-06-20T12:00:00Z"));

    await assert.rejects(
      session.decisions("oauth"),
      /LLM provider is not configured/
    );
  } finally {
    store.close();
  }
});

test("analysis commands reject malformed provider responses", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-analysis-malformed-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });
  const session = new NoteSession(store, new MalformedAnalysisProvider());

  try {
    store.saveDraft({
      raw: "OAuth implementation note: PKCE is required.",
      metadata: {
        title: "OAuth Client Notes",
        tags: ["oauth"],
        topics: ["OAuth"],
        entities: [{ name: "PKCE", type: "security" }],
        dates: [],
        summary: "OAuth note mentioning PKCE.",
        type: "research"
      }
    }, new Date("2026-06-20T12:00:00Z"));

    await assert.rejects(
      session.gaps("oauth"),
      /Invalid input/
    );
  } finally {
    store.close();
  }
});

test("related lookup without query requires current note content", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-related-empty-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });
  const session = new NoteSession(store);

  try {
    await assert.rejects(
      session.related(),
      /There is no note content yet\./
    );
  } finally {
    store.close();
  }
});

test("related lookup returns empty when saved notes do not survive visibility filtering", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-related-empty-visible-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });
  const session = new NoteSession(store);

  try {
    await session.append("Idea.");
    store.saveDraft({
      raw: "Unrelated concept.",
      metadata: {
        title: "Unrelated Concept",
        tags: [],
        topics: [],
        entities: [],
        dates: [],
        summary: "Unrelated concept.",
        type: "idea"
      }
    }, new Date("2026-06-20T12:00:00Z"));

    const lookup = await session.related();

    assert.deepEqual(lookup.results, []);
    assert.equal(lookup.llmSkippedReason, "LLM reranking skipped: LLM provider is not configured.");
  } finally {
    store.close();
  }
});

test("related lookup uses provider reranking when available", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-related-rerank-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });
  const session = new NoteSession(store, new RerankProvider());

  try {
    store.saveDraft({
      raw: "Launch roadmap for mobile beta.",
      metadata: {
        title: "Mobile Launch",
        tags: ["launch"],
        topics: ["Mobile beta"],
        entities: [],
        dates: [],
        summary: "Mobile launch roadmap.",
        type: "idea"
      }
    }, new Date("2026-06-20T12:00:00Z"));
    store.saveDraft({
      raw: "Mobile beta launch retro notes.",
      metadata: {
        title: "Launch Retro",
        tags: ["launch"],
        topics: ["Mobile beta"],
        entities: [],
        dates: [],
        summary: "Retro notes for the mobile launch.",
        type: "idea"
      }
    }, new Date("2026-06-20T12:01:00Z"));

    const lookup = await session.related({ query: "mobile beta launch" });

    assert.equal(lookup.llmSkippedReason, undefined);
    assert.equal(lookup.results.length, 1);
    assert.equal(lookup.results[0]?.score, 95);
    assert.deepEqual(lookup.results[0]?.reasons, ["Both notes are about the launch plan."]);
  } finally {
    store.close();
  }
});

test("related lookup drops provider-reranked unrelated candidates", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-related-rerank-unrelated-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });
  const session = new NoteSession(store, new UnrelatedRerankProvider());

  try {
    store.saveDraft({
      raw: "Launch roadmap for mobile beta.",
      metadata: {
        title: "Mobile Launch",
        tags: ["launch"],
        topics: ["Mobile beta"],
        entities: [],
        dates: [],
        summary: "Mobile launch roadmap.",
        type: "idea"
      }
    }, new Date("2026-06-20T12:00:00Z"));

    const lookup = await session.related({ query: "mobile beta launch" });

    assert.deepEqual(lookup.results, []);
  } finally {
    store.close();
  }
});

test("related lookup falls back when provider reranking fails", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-related-fallback-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });
  const session = new NoteSession(store, new FailingProvider());

  try {
    store.saveDraft({
      raw: "Launch roadmap for mobile beta.",
      metadata: {
        title: "Mobile Launch",
        tags: ["launch"],
        topics: ["Mobile beta"],
        entities: [],
        dates: [],
        summary: "Mobile launch roadmap.",
        type: "idea"
      }
    }, new Date("2026-06-20T12:00:00Z"));

    const lookup = await session.related({ query: "mobile beta launch" });

    assert.equal(lookup.results.length, 1);
    assert.match(lookup.llmSkippedReason ?? "", /LLM reranking skipped/);
  } finally {
    store.close();
  }
});

test("related lookup filters deterministic fallback after provider failure", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-session-related-fallback-filtered-"));
  const store = new NoteStore({
    notesDir: path.join(dir, "notes"),
    dbPath: path.join(dir, ".logbook", "logbook.sqlite")
  });
  const session = new NoteSession(store, new FailingProvider());

  try {
    await session.append("Idea.");
    store.saveDraft({
      raw: "Unrelated concept.",
      metadata: {
        title: "Unrelated Concept",
        tags: [],
        topics: [],
        entities: [],
        dates: [],
        summary: "Unrelated concept.",
        type: "idea"
      }
    }, new Date("2026-06-20T12:00:00Z"));

    const lookup = await session.related();

    assert.deepEqual(lookup.results, []);
    assert.match(lookup.llmSkippedReason ?? "", /LLM reranking skipped/);
  } finally {
    store.close();
  }
});
