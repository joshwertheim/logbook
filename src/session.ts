import { organizationPrompt, noteTakingSystemPrompt } from "./prompts.js";
import { generateSummary, generateTags, extractMetadata, fallbackMetadata, fallbackSummary, fallbackTags, refreshMetadata } from "./metadata.js";
import type { CheckResult, LlmProvider, NoteDraft, NoteMetadata, RelatedLookupResult, RelatedResult, RelatedStrength, SavedNote, SearchResult } from "./types.js";
import type { DateCheckQuery } from "./check.js";
import { ProviderConfigError } from "./provider.js";
import { NoteStore } from "./storage.js";

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
          task: "Rerank related notes for the source text. Omit unrelated candidates entirely. Return {\"results\":[{\"id\":number,\"relevance\":number,\"strength\":\"Strong|Moderate|Weak\",\"explanation\":\"short reason\"}]}",
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
    if (isUnrelatedRerankItem(item)) {
      return [];
    }

    const strength = normalizeStrength(item.strength, relevance);
    const explanation = typeof item.explanation === "string" && item.explanation.trim()
      ? item.explanation.trim()
      : "Related by deterministic signals.";
    return [{ id: item.id, relevance, strength, explanation }];
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

function isUnrelatedRerankItem(item: Record<string, unknown>): boolean {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
