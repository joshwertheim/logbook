export type SlashCommandName =
  | "new"
  | "save"
  | "process"
  | "metadata"
  | "tag"
  | "summary"
  | "search"
  | "amend"
  | "edit"
  | "related"
  | "context"
  | "decisions"
  | "gaps"
  | "note"
  | "check"
  | "index"
  | "provider"
  | "compose"
  | "multiline"
  | "done"
  | "cancel"
  | "help"
  | "quit";

export interface SlashCommand {
  kind: "command";
  name: SlashCommandName;
  args: string;
}

export interface NoteInput {
  kind: "input";
  text: string;
}

export interface UnknownCommandInput {
  kind: "unknown-command";
  command: string;
}

export type ParsedInput = SlashCommand | NoteInput | UnknownCommandInput;

export const slashCommands: SlashCommandName[] = [
  "new",
  "save",
  "process",
  "metadata",
  "tag",
  "summary",
  "search",
  "amend",
  "edit",
  "related",
  "context",
  "decisions",
  "gaps",
  "note",
  "check",
  "index",
  "provider",
  "compose",
  "multiline",
  "done",
  "cancel",
  "help",
  "quit"
];

const commands = new Set<SlashCommandName>(slashCommands);

export function parseInput(input: string): ParsedInput {
  if (!input.startsWith("/")) {
    return { kind: "input", text: input };
  }

  const trimmed = input.trim();
  const match = /^\/([a-z]+)(?:\s+(.*))?$/.exec(trimmed);
  if (!match) {
    return { kind: "unknown-command", command: input };
  }

  const name = match[1] as SlashCommandName;
  if (!commands.has(name)) {
    return { kind: "unknown-command", command: `/${name}` };
  }

  return {
    kind: "command",
    name,
    args: match[2] ?? ""
  };
}

export function completeSlashCommand(line: string): [string[], string] {
  if (!line.startsWith("/") || /\s/.test(line)) {
    return [[], line];
  }

  const matches = slashCommands
    .map((command) => `/${command}`)
    .filter((command) => command.startsWith(line));

  return [matches, line];
}

export function helpText(): string {
  return [
    "Commands:",
    "/new - start a new note session",
    "/save - save or update current note to Markdown and SQLite",
    "/process - lightly organize the current note",
    "/metadata - refresh title, summary, tags, topics, entities, dates, and type",
    "/tag - regenerate tags only; /metadata is preferred for full metadata",
    "/summary - create a short summary",
    "/search <query> - search stored notes",
    "/amend <query> - append a dated update to an existing saved note",
    "/edit <query> - edit the raw capture of an existing saved note",
    "/related [query] - find saved notes related to the current note or supplied query",
    "/context <query> - create a concise snapshot from related saved notes",
    "/decisions <query> - synthesize decisions and rationale from related notes",
    "/gaps <query> - find unexplained terms and entities in related notes",
    "/note <number> [all|snippet|path|id|reason] - show details for a numbered /related or /context result",
    "/check <question> - check saved notes by natural date phrases, such as what happened today",
    "/index - index Markdown notes into SQLite",
    "/provider - show active model/provider config",
    "/compose - open the current draft in your editor",
    "/multiline - start multiline note capture; finish with /done or discard with /cancel",
    "/done - finish multiline or amend capture",
    "/cancel - discard multiline or amend capture",
    "/help - list commands",
    "/quit - exit"
  ].join("\n");
}

export interface RelatedCommandArgs {
  mode: "balanced";
  query: string;
  flags: string[];
}

export type RelatedSelectionField = "all" | "snippet" | "path" | "id" | "reason";

export interface RelatedSelectionArgs {
  index: number | undefined;
  field: RelatedSelectionField;
}

export function parseRelatedArgs(args: string): RelatedCommandArgs {
  const tokens = args.match(/"[^"]+"|'[^']+'|\S+/g) ?? [];
  const flags: string[] = [];
  const queryParts: string[] = [];

  for (const token of tokens) {
    if (token.startsWith("--")) {
      flags.push(token);
      continue;
    }
    queryParts.push(token.replace(/^(['"])(.*)\1$/, "$2"));
  }

  return {
    mode: "balanced",
    query: queryParts.join(" ").trim(),
    flags
  };
}

export function parseRelatedSelectionArgs(args: string): RelatedSelectionArgs {
  const [numberToken, fieldToken] = args.trim().split(/\s+/, 2);
  const index = numberToken ? Number.parseInt(numberToken, 10) : undefined;
  const field = isRelatedSelectionField(fieldToken) ? fieldToken : "all";

  return {
    index: Number.isInteger(index) ? index : undefined,
    field
  };
}

function isRelatedSelectionField(value: string | undefined): value is RelatedSelectionField {
  return value === "all"
    || value === "snippet"
    || value === "path"
    || value === "id"
    || value === "reason";
}
