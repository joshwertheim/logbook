import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { matchDateCheck, type DateCheckQuery } from "./check.js";
import { datedMarkdownFilename, renderMarkdown, slugify } from "./markdown.js";
import { fallbackMetadata, fallbackTags, normalizeMetadata } from "./metadata.js";
import { configuredNotesDir, logbookHomeDir } from "./paths.js";
import type { CheckResult, NoteDraft, NoteEntity, NoteMetadata, NoteResolutionCandidate, RelatedResult, RelatedStrength, SavedNote, SearchResult } from "./types.js";

export interface StoragePaths {
  notesDir: string;
  dbPath: string;
}

export interface DefaultStoragePathOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
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

interface RelatedSource {
  raw: string;
  metadata: NoteMetadata;
  literalTerms?: Set<string>;
  includeMetadataType?: boolean;
}

interface RelatedProfile {
  text: string;
  terms: Set<string>;
  tags: Set<string>;
  topics: Set<string>;
  entities: Map<string, NoteEntity>;
  dates: Set<string>;
  noteType: string;
  literalTerms: Set<string>;
}

interface ColumnInfo {
  name: string;
}

export interface IndexResult {
  indexed: number;
  inserted: number;
  updated: number;
  unchanged: number;
  skipped: Array<{ markdownPath: string; reason: string }>;
}

export class NoteStore {
  private readonly db: Database.Database;

  constructor(private readonly paths: StoragePaths) {
    fs.mkdirSync(paths.notesDir, { recursive: true });
    fs.mkdirSync(path.dirname(paths.dbPath), { recursive: true });
    this.db = new Database(paths.dbPath);
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

  getDraft(noteId: number): NoteDraft | undefined {
    const row = this.db.prepare("SELECT * FROM notes WHERE id = ?").get(noteId) as NoteRow | undefined;
    if (!row) {
      return undefined;
    }

    const metadata = parseMetadataJson(row.metadata_json, row.raw_content) ?? normalizeMetadata({
      title: row.title,
      summary: row.summary,
      type: row.note_type,
      tags: this.tagsForNote(row.id),
      topics: [],
      entities: [],
      dates: []
    }, row.raw_content);

    return {
      raw: row.raw_content,
      metadata: {
        ...metadata,
        title: row.title,
        summary: row.summary,
        type: row.note_type as NoteMetadata["type"]
      },
      ...(row.processed_content ? { processed: row.processed_content } : {})
    };
  }

  getNote(noteId: number): SavedNote | undefined {
    const row = this.db.prepare("SELECT * FROM notes WHERE id = ?").get(noteId) as NoteRow | undefined;
    return row ? rowToSavedNote(row) : undefined;
  }

  resolveNoteCandidates(query: string): NoteResolutionCandidate[] {
    const trimmed = query.trim();
    if (!trimmed) {
      return [];
    }

    const exact = this.exactNoteCandidates(trimmed);
    if (exact.length > 0) {
      return exact;
    }

    return this.relatedToQuery(trimmed).slice(0, 6).map((result) => ({
      ...result,
      exact: false
    }));
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

  indexMarkdownNotes(): IndexResult {
    const result: IndexResult = {
      indexed: 0,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      skipped: []
    };
    const markdownFiles = fs.readdirSync(this.paths.notesDir)
      .filter((filename) => filename.endsWith(".md"))
      .sort();

    for (const filename of markdownFiles) {
      const markdownPath = path.join(this.paths.notesDir, filename);
      try {
        const content = fs.readFileSync(markdownPath, "utf8");
        const parsed = parseMarkdownNote(content);
        if (!parsed) {
          result.skipped.push({ markdownPath, reason: "missing Logbook frontmatter or Raw Capture section" });
          continue;
        }

        const stat = fs.statSync(markdownPath);
        const status = this.upsertIndexedMarkdown(markdownPath, parsed, stat.mtime);
        result.indexed += 1;
        result[status] += 1;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        result.skipped.push({ markdownPath, reason });
      }
    }

    return result;
  }

  search(query: string): SearchResult[] {
    const pattern = `%${escapeLikePattern(query)}%`;
    const rows = this.db.prepare(`
      SELECT * FROM notes
      WHERE title LIKE ? ESCAPE '\\'
         OR raw_content LIKE ? ESCAPE '\\'
         OR processed_content LIKE ? ESCAPE '\\'
         OR summary LIKE ? ESCAPE '\\'
         OR EXISTS (
           SELECT 1 FROM json_tree(notes.metadata_json)
           WHERE json_tree.type IN ('text', 'integer', 'real', 'true', 'false')
             AND CAST(json_tree.atom AS TEXT) LIKE ? ESCAPE '\\'
         )
         OR id IN (
           SELECT note_tags.note_id FROM note_tags
           JOIN tags ON tags.id = note_tags.tag_id
           WHERE tags.name LIKE ? ESCAPE '\\'
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

      if (!matchesSubjectTerms(row, query.subjectTerms)) {
        return [];
      }

      return [{
        ...rowToSavedNote(row),
        tags: this.tagsForNote(row.id),
        snippet: makeSnippet(row.raw_content, query.subjectTerms[0] ?? query.relativeWord ?? query.targetDate),
        reasons: match.reasons
      }];
    });
  }

  relatedToDraft(draft: NoteDraft, options: { excludeNoteId?: number } = {}): RelatedResult[] {
    return this.relatedToSource({
      raw: draft.raw,
      metadata: draft.metadata
    }, options);
  }

  relatedToQuery(query: string): RelatedResult[] {
    const literalTerms = literalTermsForQuery(query);
    const metadata = normalizeMetadata({
      ...fallbackMetadata(query),
      tags: literalTerms.size > 0 ? [] : fallbackTags(query)
    }, query);
    return this.relatedToSource({
      raw: query,
      metadata,
      literalTerms,
      includeMetadataType: false
    });
  }

  private relatedToSource(source: RelatedSource, options: { excludeNoteId?: number } = {}): RelatedResult[] {
    const rows = this.db.prepare("SELECT * FROM notes ORDER BY updated_at DESC").all() as NoteRow[];
    const profile = profileForSource(source);

    return rows
      .filter((row) => row.id !== options.excludeNoteId)
      .map((row) => scoreRelatedRow(row, profile, this.tagsForNote(row.id)))
      .filter((result): result is RelatedResult => result !== undefined)
      .sort((left, right) => right.score - left.score || right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, 12);
  }

  private exactNoteCandidates(query: string): NoteResolutionCandidate[] {
    const rows = this.db.prepare("SELECT * FROM notes ORDER BY updated_at DESC").all() as NoteRow[];
    const normalizedQuery = query.toLowerCase();
    const numericId = /^\d+$/.test(query) ? Number.parseInt(query, 10) : undefined;
    const queryPath = path.resolve(query);
    const queryBasename = path.basename(query).toLowerCase();
    const queryBasenameWithoutExt = path.basename(query, path.extname(query)).toLowerCase();

    const candidates = new Map<number, NoteResolutionCandidate>();
    const add = (row: NoteRow, reason: string): void => {
      const existing = candidates.get(row.id);
      if (existing) {
        existing.reasons.push(reason);
        return;
      }
      candidates.set(row.id, {
        ...rowToSavedNote(row),
        tags: this.tagsForNote(row.id),
        snippet: makeSnippet(row.raw_content, query),
        score: 100,
        reasons: [reason],
        exact: true
      });
    };

    for (const row of rows) {
      if (numericId !== undefined && row.id === numericId) {
        add(row, "exact id match");
      }

      const markdownPath = path.resolve(row.markdown_path);
      const basename = path.basename(row.markdown_path).toLowerCase();
      const basenameWithoutExt = path.basename(row.markdown_path, path.extname(row.markdown_path)).toLowerCase();
      if (markdownPath === queryPath || row.markdown_path === query) {
        add(row, "exact path match");
      } else if (basename === queryBasename || basenameWithoutExt === queryBasenameWithoutExt) {
        add(row, "exact filename match");
      }

      if (row.title.toLowerCase() === normalizedQuery) {
        add(row, "exact title match");
      }
    }

    return Array.from(candidates.values());
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

  private upsertIndexedMarkdown(markdownPath: string, draft: NoteDraft, fileTime: Date): "inserted" | "updated" | "unchanged" {
    const existing = this.db.prepare("SELECT * FROM notes WHERE markdown_path = ?").get(markdownPath) as NoteRow | undefined;
    const slug = slugify(draft.metadata.title);
    const metadataJson = JSON.stringify(draft.metadata);
    const timestamp = fileTime.toISOString();

    if (!existing) {
      const insert = this.db.prepare(`
        INSERT INTO notes (title, slug, markdown_path, raw_content, processed_content, summary, note_type, metadata_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertResult = insert.run(
        draft.metadata.title,
        slug,
        markdownPath,
        draft.raw,
        draft.processed ?? null,
        draft.metadata.summary,
        draft.metadata.type,
        metadataJson,
        timestamp,
        timestamp
      );
      const noteId = Number(insertResult.lastInsertRowid);
      this.insertVersion(noteId, draft, timestamp);
      this.replaceTags(noteId, draft.metadata.tags);
      return "inserted";
    }

    if (
      existing.title === draft.metadata.title
      && existing.slug === slug
      && existing.raw_content === draft.raw
      && existing.processed_content === (draft.processed ?? null)
      && existing.summary === draft.metadata.summary
      && existing.note_type === draft.metadata.type
      && existing.metadata_json === metadataJson
    ) {
      return "unchanged";
    }

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
      metadataJson,
      timestamp,
      existing.id
    );
    this.insertVersion(existing.id, draft, timestamp);
    this.replaceTags(existing.id, draft.metadata.tags);
    return "updated";
  }
}

export function defaultStoragePaths(options: DefaultStoragePathOptions = {}): StoragePaths {
  const baseDir = logbookHomeDir(options.homeDir);
  return {
    notesDir: configuredNotesDir(options.env, options.homeDir),
    dbPath: path.join(baseDir, "logbook.sqlite")
  };
}

function scoreRelatedRow(row: NoteRow, source: RelatedProfile, storedTags: string[]): RelatedResult | undefined {
  const metadata = parseMetadataJson(row.metadata_json, row.raw_content) ?? normalizeMetadata({
    title: row.title,
    summary: row.summary,
    type: row.note_type,
    tags: storedTags,
    topics: [],
    entities: [],
    dates: []
  }, row.raw_content);
  const candidate = profileForSource({
    raw: [
      row.title,
      row.summary,
      row.raw_content,
      row.processed_content ?? ""
    ].join("\n"),
    metadata: {
      ...metadata,
      tags: metadata.tags.length > 0 ? metadata.tags : storedTags
    }
  });
  const reasons: string[] = [];
  let score = 0;
  let snippetTerm = firstTerm(source.terms) ?? "";

  if (source.literalTerms.size > 0) {
    const literalMatch = scoreLiteralMatches(row, metadata, source.literalTerms);
    score += literalMatch.score;
    if (literalMatch.snippetTerm) {
      snippetTerm = literalMatch.snippetTerm;
    }
    reasons.push(...literalMatch.reasons);
  }

  const sharedEntities = intersectMapKeys(source.entities, candidate.entities);
  if (sharedEntities.length > 0) {
    score += sharedEntities.length * 30;
    snippetTerm = sharedEntities[0] ?? snippetTerm;
    reasons.push(`shared entities: ${sharedEntities.join(", ")}`);
  } else {
    const referencedEntities = Array.from(source.entities.keys()).filter((entity) => candidate.text.includes(entity));
    if (referencedEntities.length > 0) {
      score += referencedEntities.length * 12;
      snippetTerm = referencedEntities[0] ?? snippetTerm;
      reasons.push(`mentions entities: ${referencedEntities.slice(0, 3).join(", ")}`);
    }
  }

  const sharedTags = intersectSets(source.tags, candidate.tags);
  if (sharedTags.length > 0) {
    score += sharedTags.length * 18;
    snippetTerm = sharedTags[0] ?? snippetTerm;
    reasons.push(`shared tags: ${sharedTags.join(", ")}`);
  }

  const sharedTopics = intersectSets(source.topics, candidate.topics);
  if (sharedTopics.length > 0) {
    score += sharedTopics.length * 16;
    snippetTerm = sharedTopics[0] ?? snippetTerm;
    reasons.push(`shared topics: ${sharedTopics.join(", ")}`);
  }

  const sharedDates = intersectSets(source.dates, candidate.dates);
  if (sharedDates.length > 0) {
    score += sharedDates.length * 8;
    snippetTerm = sharedDates[0] ?? snippetTerm;
    reasons.push(`shared dates: ${sharedDates.join(", ")}`);
  }

  if (source.noteType !== "scratchpad" && source.noteType === candidate.noteType) {
    score += 4;
    reasons.push(`same note type: ${source.noteType}`);
  }

  const sharedKeywords = intersectSets(source.terms, candidate.terms).slice(0, 8);
  if (sharedKeywords.length > 0) {
    const titleMatches = sharedKeywords.filter((term) => normalizeText(row.title).includes(term)).length;
    const summaryMatches = sharedKeywords.filter((term) => normalizeText(row.summary).includes(term)).length;
    const contentMatches = sharedKeywords.length;
    score += Math.min(24, titleMatches * 3 + summaryMatches * 2 + contentMatches);
    snippetTerm = sharedKeywords[0] ?? snippetTerm;
    reasons.push(`keyword overlap: ${sharedKeywords.slice(0, 5).join(", ")}`);
  }

  if (score <= 0) {
    return undefined;
  }

  return {
    ...rowToSavedNote(row),
    tags: metadata.tags.length > 0 ? metadata.tags : storedTags,
    snippet: makeSnippet(row.raw_content, snippetTerm),
    score,
    strength: strengthForScore(score),
    reasons
  };
}

function profileForSource(source: RelatedSource): RelatedProfile {
  const metadata = source.metadata;
  const text = normalizeText([
    source.raw,
    metadata.title,
    metadata.summary,
    metadata.tags.join(" "),
    metadata.topics.join(" "),
    metadata.entities.map((entity) => entity.name).join(" "),
    metadata.dates.join(" "),
    source.includeMetadataType === false ? "" : metadata.type
  ].join(" "));

  return {
    text,
    terms: termsForText(text),
    tags: normalizedSet(metadata.tags),
    topics: normalizedSet(metadata.topics),
    entities: new Map(metadata.entities.map((entity) => [normalizeText(entity.name), entity])),
    dates: normalizedSet(metadata.dates),
    noteType: metadata.type,
    literalTerms: source.literalTerms ?? new Set()
  };
}

function scoreLiteralMatches(row: NoteRow, metadata: NoteMetadata, terms: Set<string>): { score: number; reasons: string[]; snippetTerm?: string } {
  const reasons: string[] = [];
  let score = 0;
  let snippetTerm: string | undefined;
  const title = normalizeText(row.title);
  const filename = normalizeText(path.basename(row.markdown_path, path.extname(row.markdown_path)));
  const slug = normalizeText(row.slug);
  const summary = normalizeText(row.summary);
  const raw = normalizeText(row.raw_content);
  const firstLines = normalizeText(row.raw_content.split(/\r?\n/).slice(0, 6).join("\n"));
  const tags = normalizedSet(metadata.tags);
  const entityNames = new Set(metadata.entities.map((entity) => normalizeText(entity.name)));

  const matchedEntities = intersectSets(terms, entityNames);
  if (matchedEntities.length > 0) {
    score += matchedEntities.length * 40;
    snippetTerm = matchedEntities[0] ?? snippetTerm;
    reasons.push(`literal entity match: ${matchedEntities.join(", ")}`);
  }

  const matchedTitle = termsInText(terms, title);
  if (matchedTitle.length > 0) {
    score += matchedTitle.length * 28;
    snippetTerm = matchedTitle[0] ?? snippetTerm;
    reasons.push(`literal title match: ${matchedTitle.join(", ")}`);
  }

  const matchedFilename = Array.from(terms).filter((term) => slug.includes(term) || filename.includes(term));
  if (matchedFilename.length > 0) {
    score += matchedFilename.length * 24;
    snippetTerm = matchedFilename[0] ?? snippetTerm;
    reasons.push(`literal filename match: ${matchedFilename.join(", ")}`);
  }

  const matchedFirstLines = termsInText(terms, firstLines);
  if (matchedFirstLines.length > 0) {
    score += matchedFirstLines.length * 16;
    snippetTerm = matchedFirstLines[0] ?? snippetTerm;
    reasons.push(`literal early content match: ${matchedFirstLines.join(", ")}`);
  }

  const matchedSummary = termsInText(terms, summary);
  if (matchedSummary.length > 0) {
    score += matchedSummary.length * 8;
    snippetTerm = matchedSummary[0] ?? snippetTerm;
    reasons.push(`literal summary match: ${matchedSummary.join(", ")}`);
  }

  const matchedTags = intersectSets(terms, tags).filter((term) => raw.includes(term) || summary.includes(term) || title.includes(term));
  if (matchedTags.length > 0) {
    score += matchedTags.length * 4;
    snippetTerm = matchedTags[0] ?? snippetTerm;
    reasons.push(`confirmed tag match: ${matchedTags.join(", ")}`);
  }

  return snippetTerm ? { score, reasons, snippetTerm } : { score, reasons };
}

function literalTermsForQuery(query: string): Set<string> {
  const terms = termsForText(normalizeText(query));
  return terms.size === 1 ? terms : new Set();
}

function termsInText(terms: Set<string>, text: string): string[] {
  return Array.from(terms).filter((term) => text.includes(term));
}

function strengthForScore(score: number): RelatedStrength {
  if (score >= 35) {
    return "Strong";
  }
  if (score >= 18) {
    return "Moderate";
  }
  return "Weak";
}

function normalizedSet(values: string[]): Set<string> {
  return new Set(values.map((value) => normalizeText(value)).filter(Boolean));
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}-]+/gu, " ").trim();
}

function termsForText(value: string): Set<string> {
  const terms = new Set<string>();
  for (const match of value.matchAll(/\b[\p{L}\p{N}][\p{L}\p{N}-]{2,}\b/gu)) {
    const term = match[0].toLowerCase();
    if (relatedStopWords.has(term)) {
      continue;
    }
    terms.add(term);
  }
  return terms;
}

function intersectSets(left: Set<string>, right: Set<string>): string[] {
  return Array.from(left).filter((value) => right.has(value));
}

function intersectMapKeys(left: Map<string, NoteEntity>, right: Map<string, NoteEntity>): string[] {
  return Array.from(left.keys()).filter((value) => right.has(value));
}

function firstTerm(terms: Set<string>): string | undefined {
  return terms.values().next().value as string | undefined;
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
    dates: metadata.dates,
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

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

function metadataDates(metadataJson: string | null): string[] {
  if (!metadataJson) {
    return [];
  }

  return parseMetadataJson(metadataJson)?.dates ?? [];
}

function matchesSubjectTerms(row: NoteRow, terms: string[]): boolean {
  if (terms.length === 0) {
    return true;
  }

  const metadata = parseMetadataJson(row.metadata_json, row.raw_content);
  const searchable = [
    row.title,
    row.raw_content,
    row.processed_content ?? "",
    row.summary,
    row.note_type,
    metadata?.tags.join(" ") ?? "",
    metadata?.topics.join(" ") ?? "",
    metadata?.entities.map((entity) => entity.name).join(" ") ?? ""
  ].join(" ").toLowerCase();

  return terms.every((term) => searchable.includes(term));
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

function parseMarkdownNote(content: string): NoteDraft | undefined {
  const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content);
  if (!frontmatterMatch) {
    return undefined;
  }

  const body = content.slice(frontmatterMatch[0].length);
  const rawHeading = /^## Raw Capture\s*$/m.exec(body);
  if (!rawHeading) {
    return undefined;
  }

  const rawStart = rawHeading.index + rawHeading[0].length;
  const organizedMatch = /^## Organized Version\s*$/m.exec(body.slice(rawStart));
  const rawEnd = organizedMatch ? rawStart + organizedMatch.index : body.length;
  const raw = body.slice(rawStart, rawEnd).trim();
  if (!raw) {
    return undefined;
  }

  const processed = organizedMatch
    ? body.slice(rawStart + organizedMatch.index + organizedMatch[0].length).trim()
    : undefined;
  const frontmatter = parseFrontmatter(frontmatterMatch[1] ?? "");
  const h1Title = parseMarkdownTitle(body);
  const metadata = normalizeMetadata({
    ...frontmatter,
    ...(h1Title ? { title: h1Title } : {})
  }, raw);

  return {
    raw,
    metadata,
    ...(processed ? { processed } : {})
  };
}

function parseFrontmatter(frontmatter: string): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const line of frontmatter.split(/\r?\n/)) {
    const match = /^([a-z_]+):\s*(.*)$/.exec(line.trim());
    if (!match) {
      continue;
    }

    const key = match[1];
    if (!key) {
      continue;
    }
    values[key] = parseFrontmatterValue(match[2] ?? "");
  }
  return values;
}

function parseMarkdownTitle(body: string): string | undefined {
  const match = /^#\s+(.+?)\s*$/m.exec(body);
  const title = match?.[1]?.trim();
  return title || undefined;
}

function parseFrontmatterValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value.trim();
  }
}

const relatedStopWords = new Set([
  "about",
  "after",
  "also",
  "and",
  "are",
  "because",
  "before",
  "for",
  "from",
  "had",
  "has",
  "have",
  "into",
  "note",
  "notes",
  "our",
  "that",
  "the",
  "this",
  "today",
  "tomorrow",
  "was",
  "were",
  "with"
]);
