export type NoteType = "idea" | "journal" | "task list" | "meeting" | "research" | "scratchpad";

export interface NoteMetadata {
  title: string;
  tags: string[];
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
  title: string;
  slug: string;
  markdownPath: string;
  summary: string;
  noteType: string;
  createdAt: string;
  updatedAt: string;
}

export interface SearchResult extends SavedNote {
  tags: string[];
  snippet: string;
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
