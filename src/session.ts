import { organizationPrompt, noteTakingSystemPrompt } from "./prompts.js";
import { generateSummary, generateTags, extractMetadata, fallbackMetadata, fallbackSummary, fallbackTags, refreshMetadata } from "./metadata.js";
import { cappedArray, llmEnvelope, nonEmptyBoundedString, untrustedNoteRules } from "./llmSafety.js";
import type { CheckResult, ContextAnalysisResult, ContextTheme, ContextTimelineItem, DecisionAnalysisItem, DecisionAnalysisResult, GapAnalysisItem, GapAnalysisResult, LlmProvider, NoteDraft, NoteMetadata, NoteResolutionCandidate, NoteResolutionResult, RelatedLookupResult, RelatedResult, RelatedStrength, SavedNote, SearchResult } from "./types.js";
import type { DateCheckQuery } from "./check.js";
import { ProviderConfigError } from "./provider.js";
import type { NoteStore } from "./storage.js";
import { z } from "zod";

export interface RelatedRequest {
  query?: string;
  visibility?: RelatedVisibilityMode;
}

type RelatedVisibilityMode = "balanced";

export class NoteSession {
  private lines: string[] = [];
  private metadata: NoteMetadata = fallbackMetadata("");
  private processed: string | undefined;
  private savedNote: SavedNote | undefined;
  private dirty = false;
  private metadataRevision = 0;

  constructor(
    private readonly store: NoteStore,
    private readonly provider?: LlmProvider
  ) {}

  get raw(): string {
    return this.lines.join("\n").trim();
  }

  get draft(): NoteDraft {
    return {
      raw: this.raw,
      metadata: this.metadata,
      ...(this.processed ? { processed: this.processed } : {})
    };
  }

  append(text: string): Promise<void> {
    this.lines.push(text);
    this.processed = undefined;
    this.metadata = fallbackMetadata(this.raw);
    this.dirty = true;
    this.refreshMetadataInBackground();
    return Promise.resolve();
  }

  async newNote(): Promise<void> {
    this.metadataRevision += 1;
    if (this.dirty) {
      this.save();
    }
    this.lines = [];
    this.processed = undefined;
    this.metadata = fallbackMetadata("");
    this.savedNote = undefined;
    this.dirty = false;
  }

  async process(): Promise<string> {
    this.ensureRaw();
    if (!this.provider) {
      throw new ProviderConfigError();
    }
    const response = await this.provider.complete({
      temperature: 0.25,
      messages: [
        { role: "system", content: noteTakingSystemPrompt },
        {
          role: "user",
          content: llmEnvelope({
            task: organizationPrompt,
            rules: untrustedNoteRules,
            untrustedNote: this.raw
          })
        }
      ]
    });
    this.processed = response.content.trim();
    this.dirty = true;
    return this.processed;
  }

  async regenerateTags(): Promise<string[]> {
    this.ensureRaw();
    this.metadataRevision += 1;
    let tags: string[];
    if (!this.provider) {
      tags = fallbackTags(this.raw);
    } else {
      try {
        tags = await generateTags(this.raw, this.provider);
      } catch {
        tags = fallbackTags(this.raw);
      }
    }
    this.metadata = { ...this.metadata, tags };
    this.dirty = true;
    return tags;
  }

  async refreshMetadata(): Promise<NoteMetadata> {
    this.ensureRaw();
    this.metadataRevision += 1;
    this.metadata = await refreshMetadata(this.raw, this.provider);
    this.dirty = true;
    return this.metadata;
  }

  async summarize(): Promise<string> {
    this.ensureRaw();
    this.metadataRevision += 1;
    if (!this.provider) {
      const summary = fallbackSummary(this.raw);
      this.metadata = { ...this.metadata, summary };
      this.dirty = true;
      return summary;
    }
    let summary: string;
    try {
      summary = await generateSummary(this.raw, this.provider);
    } catch {
      summary = fallbackSummary(this.raw);
    }
    this.metadata = { ...this.metadata, summary };
    this.dirty = true;
    return summary;
  }

  save(): SavedNote {
    this.ensureRaw();
    if (this.savedNote && !this.dirty) {
      return this.savedNote;
    }
    this.savedNote = this.savedNote
      ? this.store.updateDraft(this.savedNote.id, this.draft)
      : this.store.saveDraft(this.draft);
    this.dirty = false;
    return this.savedNote;
  }

  autosave(): SavedNote | undefined {
    this.ensureRaw();
    if (!this.dirty) {
      return undefined;
    }
    return this.save();
  }

  search(query: string): SearchResult[] {
    return this.store.search(query);
  }

  checkByDate(query: DateCheckQuery): CheckResult[] {
    return this.store.checkByDate(query);
  }

  getDraft(noteId: number): NoteDraft | undefined {
    return this.store.getDraft(noteId);
  }

  async resolveNote(query: string): Promise<NoteResolutionResult> {
    const trimmed = query.trim();
    if (!trimmed) {
      throw new Error("A note query is required.");
    }

    const candidates = this.store.resolveNoteCandidates(trimmed);
    if (candidates.length === 0) {
      return { query: trimmed, candidates: [] };
    }

    if (candidates[0]?.exact) {
      return candidates.length === 1
        ? { query: trimmed, selected: candidates[0], candidates }
        : { query: trimmed, candidates };
    }

    const dominant = dominantCandidate(candidates);
    if (dominant) {
      return { query: trimmed, selected: dominant, candidates };
    }

    if (!this.provider) {
      return {
        query: trimmed,
        candidates,
        llmSkippedReason: "LLM reranking skipped: LLM provider is not configured."
      };
    }

    try {
      const reranked = await rerankResolutionCandidates(candidates, trimmed, this.provider);
      const only = reranked[0];
      if (reranked.length === 1 && only) {
        return { query: trimmed, selected: only, candidates: reranked };
      }
      const rerankedDominant = dominantCandidate(reranked);
      return rerankedDominant
        ? { query: trimmed, selected: rerankedDominant, candidates: reranked }
        : { query: trimmed, candidates: reranked };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        query: trimmed,
        candidates,
        llmSkippedReason: `LLM reranking skipped: ${message}`
      };
    }
  }

  async appendToExistingNote(noteId: number, text: string, now = new Date()): Promise<SavedNote> {
    const existing = this.store.getDraft(noteId);
    if (!existing) {
      throw new Error(`Cannot update missing note ${noteId}.`);
    }

    const update = [
      existing.raw.trimEnd(),
      "",
      `## Update ${localDate(now)}`,
      "",
      text.trim()
    ].join("\n");

    return this.replaceExistingNote(noteId, update);
  }

  async replaceExistingNote(noteId: number, raw: string): Promise<SavedNote> {
    const existing = this.store.getDraft(noteId);
    if (!existing) {
      throw new Error(`Cannot update missing note ${noteId}.`);
    }

    const metadata = await refreshMetadata(raw, this.provider);
    const title = existing.metadata.title.trim();
    return this.store.updateDraft(noteId, {
      raw,
      metadata: {
        ...metadata,
        title: title || metadata.title
      }
    });
  }

  async related(request: RelatedRequest = {}): Promise<RelatedLookupResult> {
    const query = request.query?.trim() ?? "";
    const candidates = query
      ? this.store.relatedToQuery(query)
      : this.relatedToCurrentDraft();

    if (candidates.length === 0) {
      return { results: [] };
    }

    const visibleCandidates = filterVisibleRelatedResults(candidates, request.visibility);

    if (!this.provider) {
      return {
        results: visibleCandidates.slice(0, 10),
        llmSkippedReason: "LLM reranking skipped: LLM provider is not configured."
      };
    }

    try {
      const reranked = await rerankRelatedResults(candidates, query || this.raw, this.provider);
      return { results: filterVisibleRelatedResults(reranked, request.visibility).slice(0, 10) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        results: visibleCandidates.slice(0, 10),
        llmSkippedReason: `LLM reranking skipped: ${message}`
      };
    }
  }

  async decisions(query: string): Promise<DecisionAnalysisResult> {
    const trimmed = query.trim();
    if (!trimmed) {
      throw new Error("Usage: /decisions <query>");
    }

    const candidates = this.store.relatedToQuery(trimmed).slice(0, 12);
    if (candidates.length === 0) {
      return { query: trimmed, decisions: [], relatedNotes: [] };
    }

    if (!this.provider) {
      throw new ProviderConfigError();
    }

    return {
      query: trimmed,
      decisions: await analyzeDecisions(trimmed, candidates, this.provider),
      relatedNotes: candidates
    };
  }

  async gaps(query: string): Promise<GapAnalysisResult> {
    const trimmed = query.trim();
    if (!trimmed) {
      throw new Error("Usage: /gaps <query>");
    }

    const candidates = this.store.relatedToQuery(trimmed).slice(0, 12);
    if (candidates.length === 0) {
      return { query: trimmed, gaps: [], relatedNotes: [] };
    }

    if (!this.provider) {
      throw new ProviderConfigError();
    }

    return {
      query: trimmed,
      gaps: await analyzeGaps(trimmed, candidates, this.provider),
      relatedNotes: candidates
    };
  }

  async context(query: string): Promise<ContextAnalysisResult> {
    const trimmed = query.trim();
    if (!trimmed) {
      throw new Error("Usage: /context <query>");
    }

    const candidates = this.store.relatedToQuery(trimmed).slice(0, 12);
    const relatedNotes = filterVisibleRelatedResults(candidates, "balanced").slice(0, 10);
    if (relatedNotes.length === 0) {
      return {
        query: trimmed,
        snapshot: [],
        themes: [],
        timeline: [],
        gaps: [],
        relatedNotes: []
      };
    }

    if (!this.provider) {
      return {
        ...localContextAnalysis(trimmed, relatedNotes),
        llmSkippedReason: "LLM context synthesis skipped: LLM provider is not configured."
      };
    }

    try {
      return {
        query: trimmed,
        ...(await analyzeContext(trimmed, relatedNotes, this.provider)),
        relatedNotes
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ...localContextAnalysis(trimmed, relatedNotes),
        llmSkippedReason: `LLM context synthesis skipped: ${message}`
      };
    }
  }

  private ensureRaw(): void {
    if (!this.raw) {
      throw new Error("There is no note content yet.");
    }
  }

  private relatedToCurrentDraft(): RelatedResult[] {
    this.ensureRaw();
    return this.savedNote
      ? this.store.relatedToDraft(this.draft, { excludeNoteId: this.savedNote.id })
      : this.store.relatedToDraft(this.draft);
  }

  private refreshMetadataInBackground(): void {
    if (!this.provider) {
      this.metadataRevision += 1;
      return;
    }

    const revision = this.metadataRevision + 1;
    this.metadataRevision = revision;
    const raw = this.raw;

    void extractMetadata(raw, this.provider).then((metadata) => {
      if (revision !== this.metadataRevision || raw !== this.raw) {
        return;
      }

      const metadataChanged = JSON.stringify(metadata) !== JSON.stringify(this.metadata);
      this.metadata = metadata;
      if (!metadataChanged) {
        return;
      }

      this.dirty = true;

      if (this.savedNote) {
        try {
          this.savedNote = this.store.updateDraft(this.savedNote.id, this.draft);
          this.dirty = false;
        } catch {
          // Background metadata refresh should never interrupt capture.
        }
      }
    });
  }
}

async function analyzeDecisions(query: string, candidates: RelatedResult[], provider: LlmProvider): Promise<DecisionAnalysisItem[]> {
  const response = await provider.complete({
    responseFormat: "json",
    temperature: 0.1,
    messages: [
      {
        role: "system",
        content: "You analyze personal notes. Return strict JSON only. Use only the provided notes as evidence."
      },
      {
        role: "user",
        content: llmEnvelope({
          task: "Find explicit or strongly implied decisions related to the query. Group the same decision across notes. Include rationale only when supported by the notes. Return {\"decisions\":[{\"decision\":\"short decision\",\"rationale\":\"why this decision appears to have been made\",\"status\":\"optional current state\",\"confidence\":\"High|Medium|Low\",\"relatedNoteIds\":[number]}]}. If no decisions are supported, return {\"decisions\":[]}.",
          rules: untrustedNoteRules,
          query,
          untrustedNotes: candidates.map(candidateForAnalysis)
        })
      }
    ]
  });

  return parseDecisionAnalysisResponse(response.content, candidates);
}

async function analyzeGaps(query: string, candidates: RelatedResult[], provider: LlmProvider): Promise<GapAnalysisItem[]> {
  const response = await provider.complete({
    responseFormat: "json",
    temperature: 0.1,
    messages: [
      {
        role: "system",
        content: "You analyze personal notes. Return strict JSON only. Use only the provided notes as evidence."
      },
      {
        role: "user",
        content: llmEnvelope({
          task: "Find important terms, entities, acronyms, or project names related to the query that are mentioned but not explained or defined in the provided notes. Do not include common words or concepts explained in the notes. Return {\"gaps\":[{\"term\":\"term\",\"whyItMatters\":\"why it matters for understanding these notes\",\"evidence\":\"brief note-based evidence that it is mentioned but not explained\",\"suggestedQuestion\":\"question to answer later\",\"relatedNoteIds\":[number]}]}. If no gaps are supported, return {\"gaps\":[]}.",
          rules: untrustedNoteRules,
          query,
          untrustedNotes: candidates.map(candidateForAnalysis)
        })
      }
    ]
  });

  return parseGapAnalysisResponse(response.content, candidates);
}

async function analyzeContext(query: string, candidates: RelatedResult[], provider: LlmProvider): Promise<Omit<ContextAnalysisResult, "query" | "relatedNotes" | "llmSkippedReason">> {
  const response = await provider.complete({
    responseFormat: "json",
    temperature: 0.1,
    messages: [
      {
        role: "system",
        content: "You analyze personal notes as a small knowledgebase. Return strict JSON only. Use only the provided notes as evidence."
      },
      {
        role: "user",
        content: llmEnvelope({
          task: "Create a concise knowledge snapshot for the query. Return {\"snapshot\":[\"brief bullet\"],\"themes\":[{\"title\":\"theme\",\"details\":\"note-supported details\",\"relatedNoteIds\":[number]}],\"timeline\":[{\"date\":\"date or date phrase\",\"event\":\"brief event\",\"relatedNoteIds\":[number]}],\"gaps\":[{\"question\":\"question to answer later\",\"reason\":\"why the notes do not fully answer it\",\"relatedNoteIds\":[number]}]}. Keep it brief, only cite provided note IDs, and return empty arrays when unsupported.",
          rules: untrustedNoteRules,
          query,
          untrustedNotes: candidates.map(candidateForAnalysis)
        })
      }
    ]
  });

  return parseContextAnalysisResponse(response.content, candidates);
}

function candidateForAnalysis(candidate: RelatedResult): Record<string, unknown> {
  return {
    id: candidate.id,
    title: candidate.title,
    summary: candidate.summary,
    tags: candidate.tags,
    topics: candidate.topics,
    entities: candidate.entities,
    dates: candidate.dates,
    noteType: candidate.noteType,
    deterministicScore: candidate.score,
    deterministicReasons: candidate.reasons,
    content: candidate.content
  };
}

const relevanceSchema = z.number().finite().transform((value) => Math.max(0, Math.min(100, value)));

const resolutionRerankResponseSchema = z.object({
  results: cappedArray(z.object({
    id: z.number().int(),
    relevance: relevanceSchema,
    explanation: nonEmptyBoundedString(240)
  }).strict(), 20)
}).strict();

const relatedRerankResponseSchema = z.object({
  results: cappedArray(z.object({
    id: z.number().int(),
    relevance: relevanceSchema,
    strength: z.enum(["Strong", "Moderate", "Weak", "Unrelated"]),
    explanation: nonEmptyBoundedString(240)
  }).strict(), 20)
}).strict();

const decisionAnalysisResponseSchema = z.object({
  decisions: cappedArray(z.object({
    decision: nonEmptyBoundedString(240),
    rationale: nonEmptyBoundedString(500),
    status: nonEmptyBoundedString(240).optional(),
    confidence: z.enum(["High", "Medium", "Low"]),
    relatedNoteIds: cappedArray(z.number().int(), 12)
  }).strict(), 12)
}).strict();

const gapAnalysisResponseSchema = z.object({
  gaps: cappedArray(z.object({
    term: nonEmptyBoundedString(120),
    whyItMatters: nonEmptyBoundedString(500),
    evidence: nonEmptyBoundedString(500),
    suggestedQuestion: nonEmptyBoundedString(240),
    relatedNoteIds: cappedArray(z.number().int(), 12)
  }).strict(), 12)
}).strict();

const contextAnalysisResponseSchema = z.object({
  snapshot: cappedArray(nonEmptyBoundedString(220), 5),
  themes: cappedArray(z.object({
    title: nonEmptyBoundedString(120),
    details: nonEmptyBoundedString(500),
    relatedNoteIds: cappedArray(z.number().int(), 12)
  }).strict(), 6),
  timeline: cappedArray(z.object({
    date: nonEmptyBoundedString(80),
    event: nonEmptyBoundedString(300),
    relatedNoteIds: cappedArray(z.number().int(), 12)
  }).strict(), 8),
  gaps: cappedArray(z.object({
    question: nonEmptyBoundedString(220),
    reason: nonEmptyBoundedString(400),
    relatedNoteIds: cappedArray(z.number().int(), 12)
  }).strict(), 6)
}).strict();

function parseDecisionAnalysisResponse(content: string, candidates: RelatedResult[]): DecisionAnalysisItem[] {
  const parsed = decisionAnalysisResponseSchema.parse(JSON.parse(content));

  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  return parsed.decisions.flatMap((item) => {
    const relatedNoteIds = normalizeRelatedNoteIds(item.relatedNoteIds, candidateIds);
    if (relatedNoteIds.length === 0) {
      return [];
    }

    return [{
      decision: item.decision,
      rationale: item.rationale,
      ...(item.status ? { status: item.status } : {}),
      confidence: item.confidence,
      relatedNoteIds
    }];
  });
}

function parseGapAnalysisResponse(content: string, candidates: RelatedResult[]): GapAnalysisItem[] {
  const parsed = gapAnalysisResponseSchema.parse(JSON.parse(content));

  const candidateIds = new Set(candidates.map((candidate) => candidate.id));
  return parsed.gaps.flatMap((item) => {
    const relatedNoteIds = normalizeRelatedNoteIds(item.relatedNoteIds, candidateIds);
    if (relatedNoteIds.length === 0) {
      return [];
    }

    return [{ ...item, relatedNoteIds }];
  });
}

function parseContextAnalysisResponse(content: string, candidates: RelatedResult[]): Omit<ContextAnalysisResult, "query" | "relatedNotes" | "llmSkippedReason"> {
  const parsed = contextAnalysisResponseSchema.parse(JSON.parse(content));
  const candidateIds = new Set(candidates.map((candidate) => candidate.id));

  return {
    snapshot: parsed.snapshot,
    themes: parsed.themes.flatMap((item) => {
      const relatedNoteIds = normalizeRelatedNoteIds(item.relatedNoteIds, candidateIds);
      return relatedNoteIds.length > 0 ? [{ ...item, relatedNoteIds }] : [];
    }),
    timeline: parsed.timeline.flatMap((item) => {
      const relatedNoteIds = normalizeRelatedNoteIds(item.relatedNoteIds, candidateIds);
      return relatedNoteIds.length > 0 ? [{ ...item, relatedNoteIds }] : [];
    }),
    gaps: parsed.gaps.flatMap((item) => {
      const relatedNoteIds = normalizeRelatedNoteIds(item.relatedNoteIds, candidateIds);
      return relatedNoteIds.length > 0 ? [{ ...item, relatedNoteIds }] : [];
    })
  };
}

function localContextAnalysis(query: string, relatedNotes: RelatedResult[]): ContextAnalysisResult {
  return {
    query,
    snapshot: localSnapshot(relatedNotes),
    themes: localThemes(relatedNotes),
    timeline: localTimeline(relatedNotes),
    gaps: [],
    relatedNotes
  };
}

function localSnapshot(relatedNotes: RelatedResult[]): string[] {
  return relatedNotes.slice(0, 4).map((note) => {
    const detail = note.summary.trim() || note.snippet.trim() || note.title;
    return `${note.title}: ${clampSentence(detail, 180)}`;
  });
}

function localThemes(relatedNotes: RelatedResult[]): ContextTheme[] {
  const buckets = new Map<string, { title: string; details: Set<string>; ids: Set<number>; score: number }>();
  const add = (key: string, title: string, note: RelatedResult, detail: string, score: number): void => {
    const normalizedKey = key.toLowerCase();
    const existing = buckets.get(normalizedKey) ?? { title, details: new Set<string>(), ids: new Set<number>(), score: 0 };
    existing.details.add(detail);
    existing.ids.add(note.id);
    existing.score += score;
    buckets.set(normalizedKey, existing);
  };

  for (const note of relatedNotes) {
    for (const tag of note.tags) {
      add(`tag:${tag}`, tag, note, note.title, 4);
    }
    for (const topic of note.topics) {
      add(`topic:${topic}`, topic, note, note.title, 5);
    }
    for (const entity of note.entities) {
      add(`entity:${entity.name}`, entity.name, note, note.title, 6);
    }
    for (const reason of note.reasons) {
      const theme = themeFromReason(reason);
      if (theme) {
        add(`reason:${theme}`, theme, note, note.title, 3);
      }
    }
  }

  return Array.from(buckets.values())
    .filter((bucket) => bucket.ids.size > 0)
    .sort((left, right) => right.ids.size - left.ids.size || right.score - left.score || left.title.localeCompare(right.title))
    .slice(0, 5)
    .map((bucket) => ({
      title: titleCase(bucket.title),
      details: `Related notes: ${Array.from(bucket.details).slice(0, 4).join(", ")}.`,
      relatedNoteIds: Array.from(bucket.ids)
    }));
}

function localTimeline(relatedNotes: RelatedResult[]): ContextTimelineItem[] {
  const items: ContextTimelineItem[] = [];
  for (const note of relatedNotes) {
    const createdDate = note.createdAt.slice(0, 10);
    if (createdDate) {
      items.push({
        date: createdDate,
        event: `${note.title}: ${clampSentence(note.summary || note.snippet, 180)}`,
        relatedNoteIds: [note.id]
      });
    }
    for (const date of note.dates.slice(0, 3)) {
      items.push({
        date,
        event: `${note.title}: ${clampSentence(note.summary || note.snippet, 180)}`,
        relatedNoteIds: [note.id]
      });
    }
  }

  const seen = new Set<string>();
  return items
    .filter((item) => {
      const key = `${item.date}:${item.relatedNoteIds.join(",")}:${item.event}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(0, 8);
}

function themeFromReason(reason: string): string | undefined {
  const match = /^(?:shared|mentions|literal|confirmed)\s+([^:]+):\s*(.+)$/.exec(reason);
  const value = match?.[2]?.split(",")[0]?.trim();
  return value || undefined;
}

function clampSentence(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1).trimEnd()}...` : normalized;
}

function titleCase(value: string): string {
  return value.replace(/\b[\p{L}\p{N}][\p{L}\p{N}-]*/gu, (word) => {
    return word.charAt(0).toUpperCase() + word.slice(1);
  });
}

function normalizeRelatedNoteIds(value: unknown, candidateIds: Set<number>): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<number>();
  const ids: number[] = [];
  for (const item of value) {
    if (typeof item !== "number" || !Number.isInteger(item) || !candidateIds.has(item) || seen.has(item)) {
      continue;
    }
    seen.add(item);
    ids.push(item);
  }
  return ids;
}

function dominantCandidate(candidates: NoteResolutionCandidate[]): NoteResolutionCandidate | undefined {
  const top = candidates[0];
  if (!top || top.score < 35) {
    return undefined;
  }
  const second = candidates[1];
  if (!second || top.score >= second.score * 1.75 || top.score - second.score >= 20) {
    return top;
  }
  return undefined;
}

async function rerankResolutionCandidates(candidates: NoteResolutionCandidate[], query: string, provider: LlmProvider): Promise<NoteResolutionCandidate[]> {
  const response = await provider.complete({
    responseFormat: "json",
    temperature: 0.1,
    messages: [
      {
        role: "system",
        content: "You select an existing note from provided candidates. Return strict JSON only. Do not add candidates that are not provided."
      },
      {
        role: "user",
        content: llmEnvelope({
          task: "Rerank note candidates for the query. Omit unrelated candidates. Return {\"results\":[{\"id\":number,\"relevance\":number,\"explanation\":\"short reason\"}]}",
          rules: untrustedNoteRules,
          query,
          untrustedNotes: candidates.map((candidate) => ({
            id: candidate.id,
            title: candidate.title,
            path: candidate.markdownPath,
            summary: candidate.summary,
            tags: candidate.tags,
            deterministicScore: candidate.score,
            deterministicReasons: candidate.reasons,
            snippet: candidate.snippet
          }))
        })
      }
    ]
  });

  const parsed = parseResolutionRerankResponse(response.content);
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const seen = new Set<number>();
  const reranked: NoteResolutionCandidate[] = [];
  for (const item of parsed) {
    const candidate = byId.get(item.id);
    if (!candidate || seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    reranked.push({
      ...candidate,
      score: item.relevance,
      reasons: [item.explanation],
      exact: false
    });
  }
  return reranked.sort((left, right) => right.score - left.score || right.updatedAt.localeCompare(left.updatedAt));
}

function parseResolutionRerankResponse(content: string): Array<{ id: number; relevance: number; explanation: string }> {
  const parsed = resolutionRerankResponseSchema.parse(JSON.parse(content));

  return parsed.results.flatMap((item) => {
    if (isUnrelatedRerankItem(item)) {
      return [];
    }
    return [item];
  });
}

function localDate(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function rerankRelatedResults(candidates: RelatedResult[], source: string, provider: LlmProvider): Promise<RelatedResult[]> {
  const response = await provider.complete({
    responseFormat: "json",
    temperature: 0.1,
    messages: [
      {
        role: "system",
        content: "You rerank note search candidates. Return strict JSON only. Do not add candidates that are not provided."
      },
      {
        role: "user",
        content: llmEnvelope({
          task: "Rerank related notes for the source text. Omit unrelated candidates entirely. Return {\"results\":[{\"id\":number,\"relevance\":number,\"strength\":\"Strong|Moderate|Weak\",\"explanation\":\"short reason\"}]}",
          rules: untrustedNoteRules,
          untrustedNote: source,
          untrustedNotes: candidates.map((candidate) => ({
            id: candidate.id,
            title: candidate.title,
            summary: candidate.summary,
            tags: candidate.tags,
            topics: candidate.topics,
            entities: candidate.entities,
            dates: candidate.reasons.filter((reason) => reason.startsWith("shared dates:")),
            noteType: candidate.noteType,
            deterministicScore: candidate.score,
            deterministicReasons: candidate.reasons,
            snippet: candidate.snippet
          }))
        })
      }
    ]
  });

  const parsed = parseRerankResponse(response.content);
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const seen = new Set<number>();
  const reranked: RelatedResult[] = [];

  for (const item of parsed) {
    const candidate = byId.get(item.id);
    if (!candidate || seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    const strength = capStrength(item.strength, candidate.strength);
    reranked.push({
      ...candidate,
      score: item.relevance,
      strength,
      reasons: [item.explanation],
      deterministicReasons: candidate.reasons
    });
  }

  return reranked.sort((left, right) => right.score - left.score || right.updatedAt.localeCompare(left.updatedAt));
}

function parseRerankResponse(content: string): Array<{ id: number; relevance: number; strength: RelatedStrength; explanation: string }> {
  const parsed = relatedRerankResponseSchema.parse(JSON.parse(content));

  return parsed.results.flatMap((item) => {
    if (item.strength === "Unrelated" || isUnrelatedRerankItem(item)) {
      return [];
    }

    return [{
      id: item.id,
      relevance: item.relevance,
      strength: item.strength,
      explanation: item.explanation
    }];
  });
}

function filterVisibleRelatedResults(results: RelatedResult[], mode: RelatedVisibilityMode = "balanced"): RelatedResult[] {
  switch (mode) {
    case "balanced":
      return results.filter(isVisibleByDefault);
  }
}

function isVisibleByDefault(result: RelatedResult): boolean {
  if (hasUnrelatedExplanation(result.reasons)) {
    return false;
  }
  if (result.strength === "Strong" || result.strength === "Moderate") {
    return true;
  }
  return hasClearDeterministicEvidence(result.deterministicReasons ?? result.reasons);
}

function hasClearDeterministicEvidence(reasons: string[]): boolean {
  return reasons.some((reason) => {
    const normalized = reason.toLowerCase();
    return normalized.startsWith("shared entities:")
      || normalized.startsWith("mentions entities:")
      || normalized.startsWith("shared tags:")
      || normalized.startsWith("shared topics:")
      || normalized.startsWith("literal entity match:")
      || normalized.startsWith("literal title match:")
      || normalized.startsWith("literal filename match:")
      || normalized.startsWith("literal early content match:")
      || hasSpecificKeywordOverlap(normalized);
  });
}

function hasSpecificKeywordOverlap(reason: string): boolean {
  if (!reason.startsWith("keyword overlap:")) {
    return false;
  }
  const terms = reason
    .slice("keyword overlap:".length)
    .split(",")
    .map((term) => term.trim())
    .filter(Boolean);
  return terms.some((term) => !genericRelatedKeywords.has(term));
}

function isUnrelatedRerankItem(item: { strength?: unknown; relevanceClass?: unknown; relevance_class?: unknown; explanation?: unknown }): boolean {
  return isUnrelatedValue(item.strength)
    || isUnrelatedValue(item.relevanceClass)
    || isUnrelatedValue(item.relevance_class)
    || hasUnrelatedExplanation(typeof item.explanation === "string" ? [item.explanation] : []);
}

function isUnrelatedValue(value: unknown): boolean {
  return typeof value === "string" && value.toLowerCase() === "unrelated";
}

function hasUnrelatedExplanation(reasons: string[]): boolean {
  return reasons.some((reason) => {
    const normalized = reason.toLowerCase();
    return /\bunrelated\b|\bnot related\b|\bno clear relation\b|\bno meaningful relation\b/i.test(reason)
      || /\bnot\s+(?:about|work|hours|schedule|relevant|responsive)\b/.test(normalized)
      || /\bdoes\s+not\s+(?:discuss|mention|address|answer|connect|relate)\b/.test(normalized)
      || /\bmentions?\b.+\bnot\b.+\b(?:work|hours|schedule|relevant|responsive|about)\b/.test(normalized);
  });
}

function capStrength(strength: RelatedStrength, maximum: RelatedStrength): RelatedStrength {
  return strengthRank(strength) <= strengthRank(maximum) ? strength : maximum;
}

function strengthRank(strength: RelatedStrength): number {
  switch (strength) {
    case "Strong":
      return 3;
    case "Moderate":
      return 2;
    case "Weak":
      return 1;
  }
}

const genericRelatedKeywords = new Set([
  "idea",
  "journal",
  "task",
  "list",
  "meeting",
  "research",
  "scratchpad"
]);
