export interface DateCheckQuery {
  kind: "date";
  label: string;
  targetDate: string;
  relativeWord?: "today" | "yesterday" | "tomorrow";
  subjectTerms: string[];
}

export interface UnsupportedCheckQuery {
  kind: "unsupported";
  reason: string;
}

export type CheckQuery = DateCheckQuery | UnsupportedCheckQuery;

export interface CheckMatchInput {
  createdAt: string;
  updatedAt: string;
  dates: string[];
}

export interface CheckMatch {
  matched: boolean;
  reasons: string[];
}

export function parseCheckQuery(input: string, now = new Date()): CheckQuery {
  const normalized = input.trim().toLowerCase();
  if (!normalized) {
    return { kind: "unsupported", reason: "Usage: /check <question>, for example /check what happened today" };
  }

  if (/\btoday\b/.test(normalized)) {
    return {
      kind: "date",
      label: "today",
      targetDate: formatLocalDate(now),
      relativeWord: "today",
      subjectTerms: extractSubjectTerms(normalized)
    };
  }

  if (/\byesterday\b/.test(normalized)) {
    return {
      kind: "date",
      label: "yesterday",
      targetDate: formatLocalDate(addDays(now, -1)),
      relativeWord: "yesterday",
      subjectTerms: extractSubjectTerms(normalized)
    };
  }

  if (/\btomorrow\b/.test(normalized)) {
    return {
      kind: "date",
      label: "tomorrow",
      targetDate: formatLocalDate(addDays(now, 1)),
      relativeWord: "tomorrow",
      subjectTerms: extractSubjectTerms(normalized)
    };
  }

  const isoDate = /\b(\d{4}-\d{2}-\d{2})\b/.exec(normalized);
  if (isoDate?.[1]) {
    return {
      kind: "date",
      label: isoDate[1],
      targetDate: isoDate[1],
      subjectTerms: extractSubjectTerms(normalized)
    };
  }

  const slashDate = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/.exec(normalized);
  if (slashDate?.[1] && slashDate[2] && slashDate[3]) {
    const year = slashDate[3].length === 2 ? `20${slashDate[3]}` : slashDate[3];
    const month = slashDate[1].padStart(2, "0");
    const day = slashDate[2].padStart(2, "0");
    return {
      kind: "date",
      label: `${slashDate[1]}/${slashDate[2]}/${slashDate[3]}`,
      targetDate: `${year}-${month}-${day}`,
      subjectTerms: extractSubjectTerms(normalized)
    };
  }

  return {
    kind: "unsupported",
    reason: "I can only check date-oriented questions right now, such as /check what happened today or /check 2026-06-20."
  };
}

export function extractSubjectTerms(input: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();

  for (const match of input.toLowerCase().matchAll(/\b[a-z][a-z0-9']{2,}\b/g)) {
    const term = normalizeSubjectTerm(match[0]);
    if (!term || checkStopWords.has(term) || seen.has(term)) {
      continue;
    }

    seen.add(term);
    terms.push(term);
  }

  return terms;
}

export function matchDateCheck(input: CheckMatchInput, query: DateCheckQuery): CheckMatch {
  const reasons: string[] = [];

  if (localDateFromTimestamp(input.createdAt) === query.targetDate) {
    reasons.push(`saved on ${query.targetDate}`);
  }

  const createdDate = localDateFromTimestamp(input.createdAt);
  const updatedDate = localDateFromTimestamp(input.updatedAt);
  if (updatedDate === query.targetDate && updatedDate !== createdDate) {
    reasons.push(`updated on ${query.targetDate}`);
  }

  for (const date of input.dates) {
    const normalized = date.trim().toLowerCase();
    if (
      normalized === query.targetDate
      || normalizeDateToken(normalized) === query.targetDate
      || (query.relativeWord !== undefined && normalized === query.relativeWord)
    ) {
      reasons.push(`mentions ${date}`);
    }
  }

  return {
    matched: reasons.length > 0,
    reasons
  };
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

export function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function normalizeDateToken(value: string): string | undefined {
  const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (isoDate?.[1] && isoDate[2] && isoDate[3]) {
    return `${isoDate[1]}-${isoDate[2]}-${isoDate[3]}`;
  }

  const slashDate = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(value);
  if (slashDate?.[1] && slashDate[2] && slashDate[3]) {
    const year = slashDate[3].length === 2 ? `20${slashDate[3]}` : slashDate[3];
    const month = slashDate[1].padStart(2, "0");
    const day = slashDate[2].padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  return undefined;
}

function localDateFromTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value.slice(0, 10);
  }
  return formatLocalDate(date);
}

function normalizeSubjectTerm(value: string): string {
  return value.replace(/'s$/, "").replace(/^'+|'+$/g, "");
}

const checkStopWords = new Set([
  "about",
  "after",
  "again",
  "all",
  "any",
  "are",
  "can",
  "check",
  "did",
  "does",
  "done",
  "for",
  "gave",
  "give",
  "given",
  "had",
  "has",
  "have",
  "happen",
  "happened",
  "her",
  "him",
  "his",
  "how",
  "into",
  "mention",
  "mentioned",
  "note",
  "notes",
  "our",
  "out",
  "she",
  "show",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "today",
  "tomorrow",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "with",
  "yesterday",
  "you",
  "your"
]);
