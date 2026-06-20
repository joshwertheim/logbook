import { metadataExtractionPrompt, noteTakingSystemPrompt, summaryPrompt, tagsPrompt } from "./prompts.js";
import type { LlmProvider, NoteMetadata, NoteType } from "./types.js";

const noteTypes = new Set<NoteType>(["idea", "journal", "task list", "meeting", "research", "scratchpad"]);

export function fallbackMetadata(raw: string): NoteMetadata {
  const firstMeaningfulLine = raw.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? "Untitled note";
  const title = titleCase(firstMeaningfulLine.replace(/^[-*#\s]+/, "").slice(0, 80)) || "Untitled note";
  const dates = Array.from(raw.matchAll(/\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{1,2}:\d{2}\s?(?:am|pm)?|today|tomorrow|yesterday)\b/gi)).map((match) => match[0]);
  return {
    title,
    tags: [],
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
      temperature: 0.1,
      messages: [
        { role: "system", content: noteTakingSystemPrompt },
        { role: "user", content: `${metadataExtractionPrompt}\n\nNote:\n${raw}` }
      ]
    });
    return normalizeMetadata(JSON.parse(response.content), raw);
  } catch {
    return fallbackMetadata(raw);
  }
}

export async function generateSummary(raw: string, provider: LlmProvider): Promise<string> {
  const response = await provider.complete({
    temperature: 0.2,
    messages: [
      { role: "system", content: noteTakingSystemPrompt },
      { role: "user", content: `${summaryPrompt}\n\nNote:\n${raw}` }
    ]
  });
  return response.content.trim();
}

export function fallbackSummary(raw: string): string {
  return fallbackMetadata(raw).summary;
}

export async function generateTags(raw: string, provider: LlmProvider): Promise<string[]> {
  const response = await provider.complete({
    responseFormat: "json",
    temperature: 0.1,
    messages: [
      { role: "system", content: noteTakingSystemPrompt },
      { role: "user", content: `${tagsPrompt}\n\nNote:\n${raw}` }
    ]
  });
  const parsed = JSON.parse(response.content) as { tags?: unknown };
  return normalizeTags(parsed.tags);
}

function normalizeMetadata(value: unknown, raw: string): NoteMetadata {
  const fallback = fallbackMetadata(raw);
  const record = isRecord(value) ? value : {};
  const type = typeof record.type === "string" && noteTypes.has(record.type as NoteType)
    ? record.type as NoteType
    : fallback.type;

  return {
    title: typeof record.title === "string" && record.title.trim() ? record.title.trim() : fallback.title,
    tags: normalizeTags(record.tags),
    dates: normalizeStringArray(record.dates),
    summary: typeof record.summary === "string" && record.summary.trim() ? record.summary.trim() : fallback.summary,
    type
  };
}

function normalizeTags(value: unknown): string[] {
  return normalizeStringArray(value)
    .map((tag) => tag.replace(/^#/, "").trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 8);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
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
