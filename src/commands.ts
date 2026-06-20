export type SlashCommandName =
  | "new"
  | "save"
  | "process"
  | "tag"
  | "summary"
  | "search"
  | "provider"
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

export type ParsedInput = SlashCommand | NoteInput;

const commands = new Set<SlashCommandName>([
  "new",
  "save",
  "process",
  "tag",
  "summary",
  "search",
  "provider",
  "help",
  "quit"
]);

export function parseInput(input: string): ParsedInput {
  if (!input.startsWith("/")) {
    return { kind: "input", text: input };
  }

  const trimmed = input.trim();
  const match = /^\/([a-z]+)(?:\s+(.*))?$/.exec(trimmed);
  if (!match) {
    return { kind: "input", text: input };
  }

  const name = match[1] as SlashCommandName;
  if (!commands.has(name)) {
    return { kind: "input", text: input };
  }

  return {
    kind: "command",
    name,
    args: match[2] ?? ""
  };
}

export function helpText(): string {
  return [
    "Commands:",
    "/new - start a new note session",
    "/save - save current note to Markdown and SQLite",
    "/process - lightly organize the current note",
    "/tag - regenerate tags/topics",
    "/summary - create a short summary",
    "/search <query> - search stored notes",
    "/provider - show active model/provider config",
    "/help - list commands",
    "/quit - exit"
  ].join("\n");
}
