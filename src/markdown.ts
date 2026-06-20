import path from "node:path";
import { formatLocalDate } from "./check.js";
import type { NoteDraft, NoteMetadata } from "./types.js";

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "untitled-note";
}

export function datedMarkdownFilename(title: string, date = new Date()): string {
  return `${formatLocalDate(date)}-${slugify(title)}.md`;
}

export function markdownPath(notesDir: string, title: string, date = new Date()): string {
  return path.join(notesDir, datedMarkdownFilename(title, date));
}

export function renderMarkdown(draft: NoteDraft): string {
  const frontmatter = renderFrontmatter(draft.metadata);
  const processed = draft.processed ? `\n## Organized Version\n\n${draft.processed.trim()}\n` : "";
  return `${frontmatter}\n# ${draft.metadata.title}\n\n## Raw Capture\n\n${draft.raw.trim()}\n${processed}`;
}

export function renderFrontmatter(metadata: NoteMetadata): string {
  return [
    "---",
    `title: ${yamlString(metadata.title)}`,
    `type: ${yamlString(metadata.type)}`,
    `summary: ${yamlString(metadata.summary)}`,
    `tags: [${metadata.tags.map(yamlString).join(", ")}]`,
    `topics: [${metadata.topics.map(yamlString).join(", ")}]`,
    `entities: [${metadata.entities.map((entity) => JSON.stringify(entity)).join(", ")}]`,
    `dates: [${metadata.dates.map(yamlString).join(", ")}]`,
    "---"
  ].join("\n");
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}
