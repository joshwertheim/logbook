import { organizationPrompt, noteTakingSystemPrompt } from "./prompts.js";
import { generateSummary, generateTags, extractMetadata, fallbackMetadata, fallbackSummary, fallbackTags, refreshMetadata } from "./metadata.js";
import type { CheckResult, LlmProvider, NoteDraft, NoteMetadata, RelatedLookupResult, RelatedResult, RelatedStrength, SavedNote, SearchResult } from "./types.js";
import type { DateCheckQuery } from "./check.js";
import { ProviderConfigError } from "./provider.js";
import { NoteStore } from "./storage.js";

export interface RelatedRequest {
  query?: string;
}

export class NoteSession {
  private lines: string[] = [];
  private metadata: NoteMetadata = fallbackMetadata("");
  private processed: string | undefined;
  private savedNote: SavedNote | undefined;
  private dirty = false;

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

  async append(text: string): Promise<void> {
    this.lines.push(text);
    this.processed = undefined;
    this.metadata = await extractMetadata(this.raw, this.provider);
    this.dirty = true;
  }

  async newNote(): Promise<void> {
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
        { role: "user", content: `${organizationPrompt}\n\nNote:\n${this.raw}` }
      ]
    });
    this.processed = response.content.trim();
    this.dirty = true;
    return this.processed;
  }

  async regenerateTags(): Promise<string[]> {
    this.ensureRaw();
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
    this.metadata = await refreshMetadata(this.raw, this.provider);
    this.dirty = true;
    return this.metadata;
  }

  async summarize(): Promise<string> {
    this.ensureRaw();
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

  async related(request: RelatedRequest = {}): Promise<RelatedLookupResult> {
    const query = request.query?.trim() ?? "";
    const candidates = query
      ? this.store.relatedToQuery(query)
      : this.relatedToCurrentDraft();

    if (candidates.length === 0) {
      return { results: [] };
    }

    if (!this.provider) {
      return {
        results: candidates.slice(0, 10),
        llmSkippedReason: "LLM reranking skipped: LLM provider is not configured."
      };
    }

    try {
      const reranked = await rerankRelatedResults(candidates, query || this.raw, this.provider);
      return { results: reranked.slice(0, 10) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        results: candidates.slice(0, 10),
        llmSkippedReason: `LLM reranking skipped: ${message}`
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
        content: JSON.stringify({
          task: "Rerank related notes for the source text. Return {\"results\":[{\"id\":number,\"relevance\":number,\"strength\":\"Strong|Moderate|Weak\",\"explanation\":\"short reason\"}]}",
          source,
          candidates: candidates.map((candidate) => ({
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
    reranked.push({
      ...candidate,
      score: item.relevance,
      strength: item.strength,
      reasons: [item.explanation]
    });
  }

  for (const candidate of candidates) {
    if (!seen.has(candidate.id)) {
      reranked.push(candidate);
    }
  }

  return reranked.sort((left, right) => right.score - left.score || right.updatedAt.localeCompare(left.updatedAt));
}

function parseRerankResponse(content: string): Array<{ id: number; relevance: number; strength: RelatedStrength; explanation: string }> {
  const parsed = JSON.parse(content) as unknown;
  if (!isRecord(parsed) || !Array.isArray(parsed.results)) {
    throw new Error("LLM rerank response did not include results.");
  }

  return parsed.results.flatMap((item) => {
    if (!isRecord(item) || typeof item.id !== "number") {
      return [];
    }

    const relevance = typeof item.relevance === "number" && Number.isFinite(item.relevance)
      ? item.relevance
      : 0;
    const strength = normalizeStrength(item.strength, relevance);
    const explanation = typeof item.explanation === "string" && item.explanation.trim()
      ? item.explanation.trim()
      : "Related by deterministic signals.";
    return [{ id: item.id, relevance, strength, explanation }];
  });
}

function normalizeStrength(value: unknown, relevance: number): RelatedStrength {
  if (value === "Strong" || value === "Moderate" || value === "Weak") {
    return value;
  }
  if (relevance >= 70) {
    return "Strong";
  }
  if (relevance >= 40) {
    return "Moderate";
  }
  return "Weak";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
