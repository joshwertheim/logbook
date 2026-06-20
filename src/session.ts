import { organizationPrompt, noteTakingSystemPrompt } from "./prompts.js";
import { generateSummary, generateTags, extractMetadata, fallbackMetadata, fallbackSummary } from "./metadata.js";
import type { CheckResult, LlmProvider, NoteDraft, NoteMetadata, SavedNote, SearchResult } from "./types.js";
import type { DateCheckQuery } from "./check.js";
import { ProviderConfigError } from "./provider.js";
import { NoteStore } from "./storage.js";

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
    if (!this.provider) {
      throw new ProviderConfigError();
    }
    const tags = await generateTags(this.raw, this.provider);
    this.metadata = { ...this.metadata, tags };
    this.dirty = true;
    return tags;
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

  private ensureRaw(): void {
    if (!this.raw) {
      throw new Error("There is no note content yet.");
    }
  }
}
