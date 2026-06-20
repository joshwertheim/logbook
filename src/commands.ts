export type SlashCommandName =
  | "new"
  | "save"
  | "process"
  | "tag"
  | "summary"
  | "search"
  | "check"
  | "provider"
  | "compose"
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

export type ParsedInput = SlashCommand | NoteInput;

const commands = new Set<SlashCommandName>([
  "new",
  "save",
  "process",
  "tag",
  "summary",
  "search",
  "check",
  "provider",
  "compose",
  "done",
  "cancel",
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
    "/save - save or update current note to Markdown and SQLite",
    "/process - lightly organize the current note",
    "/tag - regenerate tags/topics",
    "/summary - create a short summary",
    "/search <query> - search stored notes",
    "/check <question> - check saved notes by natural date phrases, such as what happened today",
    "/provider - show active model/provider config",
    "/compose - start multiline note capture; finish with /done or discard with /cancel",
    "/help - list commands",
    "/quit - exit"
  ].join("\n");
}
