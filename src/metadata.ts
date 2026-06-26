import { metadataExtractionPrompt, noteTakingSystemPrompt, summaryPrompt, tagsPrompt } from "./prompts.js";
import { boundedString, cappedArray, clampCurrentNoteForLlm, clampText, llmEnvelope, untrustedNoteRules } from "./llmSafety.js";
import type { EntityType, LlmProvider, NoteEntity, NoteMetadata, NoteType } from "./types.js";
import { z } from "zod";

const noteTypes = new Set<NoteType>(["idea", "journal", "task list", "meeting", "research", "scratchpad"]);
const entityTypes = new Set<EntityType>(["organization", "person", "place", "security", "account", "project", "goal", "event", "product", "other"]);

export function fallbackMetadata(raw: string): NoteMetadata {
  const firstMeaningfulLine = raw.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "Untitled note";
  const title = titleCase(firstMeaningfulLine.replace(/^[-*#\s]+/, "").slice(0, 80)) || "Untitled note";
  const dates = Array.from(raw.matchAll(/\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{1,2}:\d{2}\s?(?:am|pm)?|today|tomorrow|yesterday)\b/gi)).map((match) => match[0]);
  return {
    title,
    tags: [],
    topics: [],
    entities: [],
    dates,
    summary: firstMeaningfulLine.length > 180 ? `${firstMeaningfulLine.slice(0, 177)}...` : firstMeaningfulLine,
    type: inferType(raw)
  };
}

export async function extractMetadata(raw: string, provider?: LlmProvider): Promise<NoteMetadata> {
  if (!provider) {
    return fallbackMetadata(raw);
  }

  try {
    const response = await provider.complete({
      responseFormat: "json",
      maxTokens: 500,
      temperature: 0.1,
      messages: [
        { role: "system", content: noteTakingSystemPrompt },
        {
          role: "user",
          content: llmEnvelope({
            task: metadataExtractionPrompt,
            rules: untrustedNoteRules,
            untrustedNote: clampCurrentNoteForLlm(raw)
          })
        }
      ]
    });
    return normalizeMetadata(metadataResponseSchema.parse(JSON.parse(response.content)), raw);
  } catch {
    return fallbackMetadata(raw);
  }
}

export async function generateSummary(raw: string, provider: LlmProvider): Promise<string> {
  const response = await provider.complete({
    maxTokens: 250,
    temperature: 0.2,
    messages: [
      { role: "system", content: noteTakingSystemPrompt },
      {
        role: "user",
        content: llmEnvelope({
          task: summaryPrompt,
          rules: untrustedNoteRules,
          untrustedNote: clampCurrentNoteForLlm(raw)
        })
      }
    ]
  });
  return clampText(response.content, 360);
}

export function fallbackSummary(raw: string): string {
  return fallbackMetadata(raw).summary;
}

export function fallbackTags(raw: string): string[] {
  const type = fallbackMetadata(raw).type;
  const tags = new Set<string>();

  if (type !== "scratchpad") {
    tags.add(type.replace(/\s+/g, "-"));
  }

  for (const match of raw.toLowerCase().matchAll(/\b[a-z][a-z0-9-]{3,}\b/g)) {
    const word = match[0];
    if (!commonWords.has(word)) {
      tags.add(word);
    }
    if (tags.size >= 8) {
      break;
    }
  }

  return Array.from(tags);
}

export async function generateTags(raw: string, provider: LlmProvider): Promise<string[]> {
  const response = await provider.complete({
    responseFormat: "json",
    maxTokens: 300,
    temperature: 0.1,
    messages: [
      { role: "system", content: noteTakingSystemPrompt },
      {
        role: "user",
        content: llmEnvelope({
          task: tagsPrompt,
          rules: untrustedNoteRules,
          untrustedNote: clampCurrentNoteForLlm(raw)
        })
      }
    ]
  });
  const parsed = tagsResponseSchema.parse(JSON.parse(response.content));
  return normalizeTags(parsed.tags);
}

export async function refreshMetadata(raw: string, provider?: LlmProvider): Promise<NoteMetadata> {
  return extractMetadata(raw, provider);
}

export function normalizeMetadata(value: unknown, raw = ""): NoteMetadata {
  const fallback = fallbackMetadata(raw);
  const record = isRecord(value) ? value : {};
  const type = typeof record.type === "string" && noteTypes.has(record.type as NoteType)
    ? record.type as NoteType
    : fallback.type;

  return {
    title: typeof record.title === "string" && record.title.trim() ? record.title.trim() : fallback.title,
    tags: normalizeTags(record.tags),
    topics: normalizeTopics(record.topics),
    entities: normalizeEntities(record.entities),
    dates: normalizeStringArray(record.dates),
    summary: typeof record.summary === "string" && record.summary.trim() ? record.summary.trim() : fallback.summary,
    type
  };
}

const metadataResponseSchema = z.object({
  title: boundedString(120).optional(),
  tags: cappedArray(boundedString(40), 12).optional(),
  topics: cappedArray(boundedString(80), 10).optional(),
  entities: cappedArray(z.object({
    name: boundedString(120),
    type: z.enum(["organization", "person", "place", "security", "account", "project", "goal", "event", "product", "other"]).catch("other")
  }).strict(), 16).optional(),
  dates: cappedArray(boundedString(40), 16).optional(),
  summary: boundedString(360).optional(),
  type: z.enum(["idea", "journal", "task list", "meeting", "research", "scratchpad"]).optional()
}).strict();

const tagsResponseSchema = z.object({
  tags: cappedArray(boundedString(40), 12)
}).strict();

export function normalizeTags(value: unknown): string[] {
  return normalizeStringArray(value)
    .map((tag) => tag.replace(/^#/, "").trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 8);
}

function normalizeTopics(value: unknown): string[] {
  return uniqueStrings(normalizeStringArray(value)).slice(0, 6);
}

function normalizeEntities(value: unknown): NoteEntity[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const entities: NoteEntity[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || typeof item.name !== "string") {
      continue;
    }

    const name = item.name.trim();
    if (!name) {
      continue;
    }

    const type = typeof item.type === "string" && entityTypes.has(item.type as EntityType)
      ? item.type as EntityType
      : "other";
    const key = `${name.toLowerCase()}:${type}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    entities.push({ name, type });
    if (entities.length >= 12) {
      break;
    }
  }
  return entities;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(value);
  }
  return unique;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function inferType(raw: string): NoteType {
  const lower = raw.toLowerCase();
  if (/^(\s*[-*]\s|\s*\d+\.\s|\s*\[[ x]\]\s)/m.test(raw)) {
    return "task list";
  }
  if (lower.includes("meeting") || lower.includes("agenda") || lower.includes("attendees")) {
    return "meeting";
  }
  if (lower.includes("research") || lower.includes("source") || lower.includes("citation")) {
    return "research";
  }
  if (lower.includes("i feel") || lower.includes("today") || lower.includes("journal")) {
    return "journal";
  }
  if (lower.includes("idea") || lower.includes("what if")) {
    return "idea";
  }
  return "scratchpad";
}

function titleCase(value: string): string {
  return value.replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1));
}

const commonWords = new Set([
  "about",
  "after",
  "also",
  "and",
  "because",
  "before",
  "from",
  "have",
  "into",
  "need",
  "note",
  "that",
  "the",
  "this",
  "today",
  "tomorrow",
  "with"
]);
