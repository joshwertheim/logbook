import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { matchDateCheck, type DateCheckQuery } from "./check.js";
import { datedMarkdownFilename, renderMarkdown, slugify } from "./markdown.js";
import { normalizeMetadata } from "./metadata.js";
import type { CheckResult, NoteDraft, NoteMetadata, SavedNote, SearchResult } from "./types.js";

export interface StoragePaths {
  notesDir: string;
  dbPath: string;
}

interface NoteRow {
  id: number;
  title: string;
  slug: string;
  markdown_path: string;
  raw_content: string;
  processed_content: string | null;
  summary: string;
  note_type: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

interface CheckRow extends NoteRow {
  metadata_json: string;
}

interface ColumnInfo {
  name: string;
}

export class NoteStore {
  private readonly db: DatabaseSync;

  constructor(private readonly paths: StoragePaths) {
    fs.mkdirSync(paths.notesDir, { recursive: true });
    fs.mkdirSync(path.dirname(paths.dbPath), { recursive: true });
    this.db = new DatabaseSync(paths.dbPath);
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  saveDraft(draft: NoteDraft, now = new Date()): SavedNote {
    const timestamp = now.toISOString();
    const slug = slugify(draft.metadata.title);
    const markdownFile = this.uniqueMarkdownPath(draft.metadata.title, now);
    fs.writeFileSync(markdownFile, renderMarkdown(draft), "utf8");

    const insert = this.db.prepare(`
      INSERT INTO notes (title, slug, markdown_path, raw_content, processed_content, summary, note_type, metadata_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = insert.run(
      draft.metadata.title,
      slug,
      markdownFile,
      draft.raw,
      draft.processed ?? null,
      draft.metadata.summary,
      draft.metadata.type,
      JSON.stringify(draft.metadata),
      timestamp,
      timestamp
    );
    const noteId = Number(result.lastInsertRowid);

    this.insertVersion(noteId, draft, timestamp);
    this.replaceTags(noteId, draft.metadata.tags);

    return rowToSavedNote({
      id: noteId,
      title: draft.metadata.title,
      slug,
      markdown_path: markdownFile,
      raw_content: draft.raw,
      processed_content: draft.processed ?? null,
      summary: draft.metadata.summary,
      note_type: draft.metadata.type,
      metadata_json: JSON.stringify(draft.metadata),
      created_at: timestamp,
      updated_at: timestamp
    });
  }

  updateDraft(noteId: number, draft: NoteDraft, now = new Date()): SavedNote {
    const existing = this.db.prepare("SELECT * FROM notes WHERE id = ?").get(noteId) as NoteRow | undefined;
    if (!existing) {
      throw new Error(`Cannot update missing note ${noteId}.`);
    }

    const timestamp = now.toISOString();
    const slug = slugify(draft.metadata.title);
    fs.writeFileSync(existing.markdown_path, renderMarkdown(draft), "utf8");

    this.db.prepare(`
      UPDATE notes
      SET title = ?,
          slug = ?,
          raw_content = ?,
          processed_content = ?,
          summary = ?,
          note_type = ?,
          metadata_json = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      draft.metadata.title,
      slug,
      draft.raw,
      draft.processed ?? null,
      draft.metadata.summary,
      draft.metadata.type,
      JSON.stringify(draft.metadata),
      timestamp,
      noteId
    );

    this.insertVersion(noteId, draft, timestamp);
    this.replaceTags(noteId, draft.metadata.tags);

    return rowToSavedNote({
      ...existing,
      title: draft.metadata.title,
      slug,
      raw_content: draft.raw,
      processed_content: draft.processed ?? null,
      summary: draft.metadata.summary,
      note_type: draft.metadata.type,
      metadata_json: JSON.stringify(draft.metadata),
      updated_at: timestamp
    });
  }

  recordProviderRun(input: {
    noteId?: number;
    provider: string;
    model: string;
    prompt: string;
    response: string;
    status: "ok" | "error";
    error?: string;
  }, now = new Date()): void {
    this.db.prepare(`
      INSERT INTO provider_runs (note_id, provider, model, prompt, response, status, error, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(input.noteId ?? null, input.provider, input.model, input.prompt, input.response, input.status, input.error ?? null, now.toISOString());
  }

  search(query: string): SearchResult[] {
    const pattern = `%${query}%`;
    const rows = this.db.prepare(`
      SELECT * FROM notes
      WHERE title LIKE ?
         OR raw_content LIKE ?
         OR processed_content LIKE ?
         OR summary LIKE ?
         OR metadata_json LIKE ?
         OR id IN (
           SELECT note_tags.note_id FROM note_tags
           JOIN tags ON tags.id = note_tags.tag_id
           WHERE tags.name LIKE ?
         )
      ORDER BY updated_at DESC
      LIMIT 25
    `).all(pattern, pattern, pattern, pattern, pattern, pattern) as NoteRow[];

    return rows.map((row) => ({
      ...rowToSavedNote(row),
      tags: this.tagsForNote(row.id),
      snippet: makeSnippet(row.raw_content, query)
    }));
  }

  checkByDate(query: DateCheckQuery): CheckResult[] {
    const rows = this.db.prepare(`
      SELECT notes.*
      FROM notes
      ORDER BY notes.updated_at DESC
    `).all() as CheckRow[];

    return rows.flatMap((row) => {
      const dates = metadataDates(row.metadata_json);
      const match = matchDateCheck({
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        dates
      }, query);

      if (!match.matched) {
        return [];
      }

      return [{
        ...rowToSavedNote(row),
        tags: this.tagsForNote(row.id),
        snippet: makeSnippet(row.raw_content, query.relativeWord ?? query.targetDate),
        reasons: match.reasons
      }];
    });
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        slug TEXT NOT NULL,
        markdown_path TEXT NOT NULL,
        raw_content TEXT NOT NULL,
        processed_content TEXT,
        summary TEXT NOT NULL,
        note_type TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS note_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        raw_content TEXT NOT NULL,
        processed_content TEXT,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE
      );

      CREATE TABLE IF NOT EXISTS note_tags (
        note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY (note_id, tag_id)
      );

      CREATE TABLE IF NOT EXISTS provider_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        note_id INTEGER REFERENCES notes(id) ON DELETE SET NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt TEXT NOT NULL,
        response TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        created_at TEXT NOT NULL
      );
    `);

    this.ensureNotesMetadataColumn();
    this.backfillNoteMetadata();
  }

  private ensureNotesMetadataColumn(): void {
    const columns = this.db.prepare("PRAGMA table_info(notes)").all() as ColumnInfo[];
    if (!columns.some((column) => column.name === "metadata_json")) {
      this.db.exec("ALTER TABLE notes ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'");
    }
  }

  private backfillNoteMetadata(): void {
    const rows = this.db.prepare(`
      SELECT notes.*, (
        SELECT note_versions.metadata_json
        FROM note_versions
        WHERE note_versions.note_id = notes.id
        ORDER BY note_versions.created_at DESC, note_versions.id DESC
        LIMIT 1
      ) AS version_metadata_json
      FROM notes
      WHERE notes.metadata_json IS NULL OR notes.metadata_json = '{}'
    `).all() as Array<NoteRow & { version_metadata_json: string | null }>;

    for (const row of rows) {
      const versionMetadata = parseMetadataJson(row.version_metadata_json, row.raw_content);
      const metadata = normalizeMetadata({
        ...(versionMetadata ?? {}),
        title: versionMetadata?.title ?? row.title,
        summary: versionMetadata?.summary ?? row.summary,
        type: versionMetadata?.type ?? row.note_type,
        tags: versionMetadata?.tags ?? this.tagsForNote(row.id),
        dates: versionMetadata?.dates ?? [],
        topics: versionMetadata?.topics ?? [],
        entities: versionMetadata?.entities ?? []
      }, row.raw_content);
      this.db.prepare("UPDATE notes SET metadata_json = ? WHERE id = ?").run(JSON.stringify(metadata), row.id);
    }
  }

  private uniqueMarkdownPath(title: string, now: Date): string {
    const filename = datedMarkdownFilename(title, now);
    const parsed = path.parse(filename);
    let candidate = path.join(this.paths.notesDir, filename);
    let suffix = 2;
    while (fs.existsSync(candidate)) {
      candidate = path.join(this.paths.notesDir, `${parsed.name}-${suffix}${parsed.ext}`);
      suffix += 1;
    }
    return candidate;
  }

  private tagsForNote(noteId: number): string[] {
    const rows = this.db.prepare(`
      SELECT tags.name FROM tags
      JOIN note_tags ON note_tags.tag_id = tags.id
      WHERE note_tags.note_id = ?
      ORDER BY tags.name
    `).all(noteId) as Array<{ name: string }>;
    return rows.map((row) => row.name);
  }

  private insertVersion(noteId: number, draft: NoteDraft, timestamp: string): void {
    this.db.prepare(`
      INSERT INTO note_versions (note_id, raw_content, processed_content, metadata_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(noteId, draft.raw, draft.processed ?? null, JSON.stringify(draft.metadata), timestamp);
  }

  private replaceTags(noteId: number, tags: string[]): void {
    this.db.prepare("DELETE FROM note_tags WHERE note_id = ?").run(noteId);
    for (const tag of tags) {
      this.db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)").run(tag);
      const tagRow = this.db.prepare("SELECT id FROM tags WHERE name = ?").get(tag) as { id: number };
      this.db.prepare("INSERT OR IGNORE INTO note_tags (note_id, tag_id) VALUES (?, ?)").run(noteId, tagRow.id);
    }
  }
}

export function defaultStoragePaths(cwd = process.cwd()): StoragePaths {
  return {
    notesDir: path.join(cwd, "notes"),
    dbPath: path.join(cwd, ".logbook", "logbook.sqlite")
  };
}

function rowToSavedNote(row: NoteRow): SavedNote {
  const metadata = parseMetadataJson(row.metadata_json, row.raw_content) ?? normalizeMetadata({
    title: row.title,
    summary: row.summary,
    type: row.note_type,
    tags: [],
    topics: [],
    entities: [],
    dates: []
  }, row.raw_content);

  return {
    id: row.id,
    content: row.raw_content,
    title: row.title,
    slug: row.slug,
    markdownPath: row.markdown_path,
    tags: metadata.tags,
    topics: metadata.topics,
    entities: metadata.entities,
    summary: row.summary,
    noteType: row.note_type,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function makeSnippet(content: string, query: string): string {
  const index = content.toLowerCase().indexOf(query.toLowerCase());
  if (index === -1) {
    return content.slice(0, 160);
  }
  const start = Math.max(0, index - 60);
  const end = Math.min(content.length, index + query.length + 100);
  return content.slice(start, end).trim();
}

function metadataDates(metadataJson: string | null): string[] {
  if (!metadataJson) {
    return [];
  }

  return parseMetadataJson(metadataJson)?.dates ?? [];
}

function parseMetadataJson(metadataJson: string | null, raw = ""): NoteMetadata | undefined {
  if (!metadataJson) {
    return undefined;
  }

  try {
    return normalizeMetadata(JSON.parse(metadataJson), raw);
  } catch {
    return undefined;
  }
}
