export type NoteType = "idea" | "journal" | "task list" | "meeting" | "research" | "scratchpad";
export type EntityType = "organization" | "person" | "place" | "security" | "account" | "project" | "goal" | "event" | "product" | "other";

export interface NoteEntity {
  name: string;
  type: EntityType;
}

export interface NoteMetadata {
  title: string;
  tags: string[];
  topics: string[];
  entities: NoteEntity[];
  dates: string[];
  summary: string;
  type: NoteType;
}

export interface NoteDraft {
  raw: string;
  metadata: NoteMetadata;
  processed?: string;
}

export interface SavedNote {
  id: number;
  content: string;
  title: string;
  slug: string;
  markdownPath: string;
  tags: string[];
  topics: string[];
  entities: NoteEntity[];
  summary: string;
  noteType: string;
  createdAt: string;
  updatedAt: string;
}

export interface SearchResult extends SavedNote {
  snippet: string;
}

export interface CheckResult extends SearchResult {
  reasons: string[];
}

export type RelatedStrength = "Strong" | "Moderate" | "Weak";

export interface RelatedResult extends SearchResult {
  score: number;
  strength: RelatedStrength;
  reasons: string[];
  deterministicReasons?: string[];
}

export interface RelatedLookupResult {
  results: RelatedResult[];
  llmSkippedReason?: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmRequest {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: "json";
}

export interface LlmResponse {
  content: string;
  raw?: unknown;
}

export interface LlmProvider {
  complete(request: LlmRequest): Promise<LlmResponse>;
  stream?(request: LlmRequest): AsyncIterable<string>;
}
