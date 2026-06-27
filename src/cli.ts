#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clearLine, clearScreenDown, cursorTo } from "node:readline";
import { createInterface } from "node:readline/promises";
import { argv, stdin as input, stdout as output } from "node:process";
import { spawn } from "node:child_process";
import { parseCheckQuery } from "./check.js";
import { completeSlashCommand, parseAnalysisArgs, parseInput, helpText, parseRelatedArgs, parseRelatedSelectionArgs } from "./commands.js";
import { loadProviderEnv, type ProviderEnvLoadResult } from "./env.js";
import { OpenAICompatibleProvider, providerConfigFromEnv, providerStatus, ProviderConfigError } from "./provider.js";
import { NoteSession } from "./session.js";
import { defaultStoragePaths, NoteStore } from "./storage.js";
import type { ContextAnalysisResult, DecisionAnalysisResult, GapAnalysisResult, NoteResolutionCandidate, RelatedResult } from "./types.js";

const autosaveDelayMs = 2000;
const terminalLogo = [
  " _                _                 _",
  "| |    ___   __ _| |__   ___   ___ | | __",
  "| |   / _ \\ / _` | '_ \\ / _ \\ / _ \\| |/ /",
  "| |__| (_) | (_| | |_) | (_) | (_) |   <",
  "|_____\\___/ \\__, |_.__/ \\___/ \\___/|_|\\_\\",
  "            |___/"
];
const terminalSplashTagline = "Logbook note session.";
const terminalFallbackTagline = "Logbook note session. Type /help for commands.";
const terminalCommandBox = [
  "+-- Commands ---------------------+",
  "| /help              command list |",
  "| /compose           edit draft   |",
  "| /related <words>   search notes |",
  "| /save              save note    |",
  "| /quit              exit         |",
  "+---------------------------------+"
];
const ansi = {
  reset: "\u001b[0m",
  bold: "\u001b[1m",
  cyan: "\u001b[36m",
  dim: "\u001b[2m",
  coral: "\u001b[38;5;203m"
} as const;

type ComposeBuffer =
  | { kind: "multiline"; lines: string[] }
  | { kind: "amend"; lines: string[]; target: NoteResolutionCandidate };

type PendingWrite =
  | { kind: "amend"; target: NoteResolutionCandidate; text: string; now: Date }
  | { kind: "edit"; target: NoteResolutionCandidate; raw: string };

async function main(): Promise<void> {
  const configLoad = loadProviderEnv();

  if (argv[2] === "index") {
    const store = new NoteStore(defaultStoragePaths());
    try {
      output.write(formatIndexResult(store.indexMarkdownNotes()));
    } finally {
      store.close();
    }
    return;
  }

  const config = {
    ...providerConfigFromEnv(),
    source: formatProviderEnvSource(configLoad)
  };
  const provider = new OpenAICompatibleProvider(config);
  const store = new NoteStore(defaultStoragePaths());
  const session = new NoteSession(store, provider);
  const isTerminal = input.isTTY && output.isTTY;
  const rl = createInterface({ input, output, prompt: "> ", terminal: isTerminal, completer: completeSlashCommand });
  let composeBuffer: ComposeBuffer | undefined;
  let pendingWrite: PendingWrite | undefined;
  let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
  let lastRelatedResults: RelatedResult[] = [];

  const writePrompt = (): void => {
    if (isTerminal) {
      rl.setPrompt(pendingWrite ? "Confirm write (y/N) " : composeBuffer ? "| " : "> ");
      rl.prompt();
    }
  };

  const writeNotice = (message: string): void => {
    if (!isTerminal) {
      output.write(`${message}\n`);
      return;
    }

    clearLine(output, 0);
    cursorTo(output, 0);
    output.write(`${message}\n`);
    rl.prompt(true);
  };

  const clearAutosave = (): void => {
    if (autosaveTimer) {
      clearTimeout(autosaveTimer);
      autosaveTimer = undefined;
    }
  };

  const runAutosave = (): void => {
    clearAutosave();
    try {
      session.autosave();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeNotice(`Autosave failed: ${message}`);
    }
  };

  const scheduleAutosave = (): void => {
    clearAutosave();
    autosaveTimer = setTimeout(runAutosave, autosaveDelayMs);
  };

  renderStartup(isTerminal);

  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    writePrompt();

    for await (const line of rl) {
      if (pendingWrite) {
        const confirmed = /^(?:y|yes)$/i.test(line.trim());
        if (!confirmed) {
          pendingWrite = undefined;
          output.write("No changes written.\n");
          writePrompt();
          continue;
        }

        const write = pendingWrite;
        pendingWrite = undefined;
        const saved = write.kind === "amend"
          ? await session.appendToExistingNote(write.target.id, write.text, write.now)
          : await session.replaceExistingNote(write.target.id, write.raw);
        output.write(`Updated ${saved.title}\n${saved.markdownPath}\n`);
        writePrompt();
        continue;
      }

      if (composeBuffer) {
        if (line === "/done") {
          const text = composeBuffer.lines.join("\n");
          const compose = composeBuffer;
          composeBuffer = undefined;
          if (!text.trim()) {
            output.write("No multiline content captured.\n");
          } else if (compose.kind === "multiline") {
            await session.append(text);
            output.write("captured multiline note\n");
            scheduleAutosave();
          } else {
            pendingWrite = { kind: "amend", target: compose.target, text, now: new Date() };
            output.write(formatPendingWrite(pendingWrite));
          }
          writePrompt();
          continue;
        }
        if (line === "/cancel") {
          composeBuffer = undefined;
          output.write("Canceled multiline capture.\n");
          writePrompt();
          continue;
        }

        composeBuffer.lines.push(line);
        writePrompt();
        continue;
      }

      const parsed = parseInput(line);

      if (parsed.kind === "input") {
        await session.append(parsed.text);
        output.write("captured\n");
        scheduleAutosave();
        writePrompt();
        continue;
      }

      if (parsed.kind === "unknown-command") {
        output.write(`Unknown command: ${parsed.command}. Type /help for commands.\n`);
        writePrompt();
        continue;
      }

      if (parsed.name === "quit") {
        if (autosaveTimer) {
          runAutosave();
        }
        break;
      }

      try {
        switch (parsed.name) {
          case "compose": {
            if (!isTerminal) {
              output.write("/compose requires an interactive terminal editor.\n");
              break;
            }
            output.write("Opening current draft in your editor. Save and exit to replace the draft.\n");
            rl.pause();
            let edited: string;
            try {
              edited = await editRawCapture(session.raw);
            } finally {
              rl.resume();
            }
            if (!edited.trim()) {
              output.write("Editor content was blank; current draft unchanged.\n");
              break;
            }
            await session.replaceRawCapture(edited);
            output.write("Updated current draft from editor.\n");
            scheduleAutosave();
            break;
          }
          case "multiline":
            composeBuffer = { kind: "multiline", lines: [] };
            output.write("Multiline mode. Finish with /done or discard with /cancel.\n");
            break;
          case "amend": {
            if (!parsed.args.trim()) {
              output.write("Usage: /amend <query>\n");
              break;
            }
            const resolution = await session.resolveNote(parsed.args);
            if (!resolution.selected) {
              output.write(formatAmbiguousResolution(resolution.candidates));
              if (resolution.llmSkippedReason) {
                output.write(`${resolution.llmSkippedReason}\n`);
              }
              break;
            }
            composeBuffer = { kind: "amend", lines: [], target: resolution.selected };
            output.write(formatResolvedTarget("Amending", resolution.selected));
            output.write("Amend mode. Finish with /done or discard with /cancel.\n");
            break;
          }
          case "edit": {
            if (!parsed.args.trim()) {
              output.write("Usage: /edit <query>\n");
              break;
            }
            const resolution = await session.resolveNote(parsed.args);
            if (!resolution.selected) {
              output.write(formatAmbiguousResolution(resolution.candidates));
              if (resolution.llmSkippedReason) {
                output.write(`${resolution.llmSkippedReason}\n`);
              }
              break;
            }
            const draft = session.getDraft(resolution.selected.id);
            if (!draft) {
              output.write(`Cannot load note ${resolution.selected.id}.\n`);
              break;
            }
            output.write(formatResolvedTarget("Editing", resolution.selected));
            if (!isTerminal) {
              output.write("/edit requires an interactive terminal editor.\n");
              break;
            }
            output.write("Opening current raw capture in your editor. Save and exit to preview changes.\n");
            rl.pause();
            let edited: string;
            try {
              edited = await editRawCapture(draft.raw);
            } finally {
              rl.resume();
            }
            pendingWrite = { kind: "edit", target: resolution.selected, raw: edited };
            output.write(formatPendingWrite(pendingWrite));
            break;
          }
          case "done":
            output.write("Not currently composing. Use /multiline or /amend to start multiline capture.\n");
            break;
          case "cancel":
            output.write("Not currently composing. Use /multiline or /amend to start multiline capture.\n");
            break;
          case "new":
            clearAutosave();
            await session.newNote();
            output.write("Started a new note.\n");
            break;
          case "save": {
            clearAutosave();
            const saved = session.save();
            output.write(`Saved ${saved.title}\n${saved.markdownPath}\n`);
            break;
          }
          case "process": {
            const processed = await session.process();
            output.write(`${processed}\n`);
            scheduleAutosave();
            break;
          }
          case "metadata": {
            const metadata = await session.refreshMetadata();
            output.write(`${metadata.title}\n${metadata.summary}\nTags: ${metadata.tags.join(", ")}\nTopics: ${metadata.topics.join(", ")}\nEntities: ${metadata.entities.map((entity) => `${entity.name} (${entity.type})`).join(", ")}\n`);
            scheduleAutosave();
            break;
          }
          case "tag": {
            const tags = await session.regenerateTags();
            output.write(`${tags.join(", ")}\n`);
            scheduleAutosave();
            break;
          }
          case "summary": {
            const summary = await session.summarize();
            output.write(`${summary}\n`);
            scheduleAutosave();
            break;
          }
          case "search": {
            if (!parsed.args.trim()) {
              output.write("Usage: /search <query>\n");
              break;
            }
            const results = session.search(parsed.args.trim());
            if (results.length === 0) {
              output.write("No matching notes.\n");
              break;
            }
            for (const result of results) {
              output.write(`[${result.id}] ${result.title} (${result.tags.join(", ")})\n${result.snippet}\n${result.markdownPath}\n`);
            }
            break;
          }
          case "related": {
            const relatedArgs = parseRelatedArgs(parsed.args);
            const lookup = await session.related({ query: relatedArgs.query });
            if (lookup.results.length === 0) {
              lastRelatedResults = [];
              output.write("No additional related notes found.\n");
              break;
            }
            lastRelatedResults = lookup.results;
            output.write(formatRelatedResults(lookup.results));
            if (lookup.llmSkippedReason) {
              output.write(`${lookup.llmSkippedReason}\n`);
            }
            break;
          }
          case "context": {
            const analysisArgs = parseAnalysisArgs("context", parsed.args);
            if (analysisArgs.error) {
              output.write(`${analysisArgs.error}\n`);
              break;
            }
            const analysis = await session.context(analysisArgs);
            lastRelatedResults = analysis.relatedNotes;
            output.write(formatContextAnalysis(analysis));
            break;
          }
          case "decisions": {
            const analysisArgs = parseAnalysisArgs("decisions", parsed.args);
            if (analysisArgs.error) {
              output.write(`${analysisArgs.error}\n`);
              break;
            }
            const analysis = await session.decisions(analysisArgs);
            output.write(formatDecisionAnalysis(analysis));
            break;
          }
          case "gaps": {
            const analysisArgs = parseAnalysisArgs("gaps", parsed.args);
            if (analysisArgs.error) {
              output.write(`${analysisArgs.error}\n`);
              break;
            }
            const analysis = await session.gaps(analysisArgs);
            output.write(formatGapAnalysis(analysis));
            break;
          }
          case "note": {
            const selection = parseRelatedSelectionArgs(parsed.args);
            if (!selection.index) {
              output.write("Usage: /note <number> [all|snippet|path|id|reason]\n");
              break;
            }
            const result = lastRelatedResults[selection.index - 1];
            if (!result) {
              output.write("No related result at that number. Run /related or /context first, then choose a listed number.\n");
              break;
            }
            output.write(formatRelatedSelection(result, selection.field));
            break;
          }
          case "check": {
            const query = parseCheckQuery(parsed.args);
            if (query.kind === "unsupported") {
              output.write(`${query.reason}\n`);
              break;
            }
            const results = session.checkByDate(query);
            if (results.length === 0) {
              output.write(`No saved notes matched ${query.label} (${query.targetDate}).\n`);
              break;
            }
            output.write(`Saved notes matching ${query.label} (${query.targetDate}):\n`);
            for (const result of results) {
              output.write(`[${result.id}] ${result.title} - ${result.reasons.join(", ")}\n${result.snippet}\n${result.markdownPath}\n`);
            }
            break;
          }
          case "index": {
            const result = store.indexMarkdownNotes();
            output.write(formatIndexResult(result));
            break;
          }
          case "provider":
            output.write(`${providerStatus(config)}\n`);
            break;
          case "help":
            output.write(`${helpText()}\n`);
            break;
        }
      } catch (error) {
        if (error instanceof ProviderConfigError) {
          output.write(`${error.message}\n`);
        } else if (error instanceof Error) {
          output.write(`${error.message}\n`);
        } else {
          output.write("Unknown error.\n");
        }
      }

      writePrompt();
    }
  } finally {
    clearAutosave();
    rl.close();
    store.close();
  }
}

function formatProviderEnvSource(result: ProviderEnvLoadResult): string {
  switch (result.source) {
    case "explicit-config":
      return `LOGBOOK_CONFIG (${result.path})`;
    case "user-config":
      return `user config (${result.path})`;
    case "shell":
      return "shell";
    case "unset":
      return "unset";
  }
}

function formatIndexResult(result: ReturnType<NoteStore["indexMarkdownNotes"]>): string {
  const lines = [
    `Indexed ${result.indexed} Markdown note${result.indexed === 1 ? "" : "s"} into SQLite.`,
    `Inserted: ${result.inserted}; updated: ${result.updated}; unchanged: ${result.unchanged}; skipped: ${result.skipped.length}.`
  ];

  for (const skipped of result.skipped.slice(0, 5)) {
    lines.push(`Skipped ${skipped.markdownPath}: ${skipped.reason}`);
  }

  if (result.skipped.length > 5) {
    lines.push(`Skipped ${result.skipped.length - 5} more file${result.skipped.length - 5 === 1 ? "" : "s"}.`);
  }

  return `${lines.join("\n")}\n`;
}

function formatRelatedResults(results: RelatedResult[]): string {
  return `${results.map((result, index) => {
    return `${index + 1}. ${result.title}\n   ${result.reasons.join("; ")}`;
  }).join("\n")}\n`;
}

function formatRelatedSelection(result: RelatedResult, field: "all" | "snippet" | "path" | "id" | "reason"): string {
  switch (field) {
    case "snippet":
      return `${result.snippet}\n`;
    case "path":
      return `${result.markdownPath}\n`;
    case "id":
      return `${result.id}\n`;
    case "reason":
      return `${result.reasons.join("; ")}\n`;
    case "all":
      return [
        result.title,
        result.reasons.join("; "),
        result.snippet,
        result.markdownPath,
        `ID: ${result.id}`
      ].join("\n") + "\n";
  }
}

function formatResolvedTarget(action: string, target: NoteResolutionCandidate): string {
  return [
    `${action} [${target.id}] ${target.title}`,
    target.markdownPath
  ].join("\n") + "\n";
}

function formatPendingWrite(write: PendingWrite): string {
  if (write.kind === "amend") {
    return [
      `Preview append to [${write.target.id}] ${write.target.title}`,
      write.target.markdownPath,
      "",
      `## Update ${formatLocalDate(write.now)}`,
      "",
      write.text.trim(),
      "",
      "Write this update? y/N"
    ].join("\n") + "\n";
  }

  const summary = write.raw.trim().split(/\r?\n/).find(Boolean) ?? "(empty)";
  return [
    `Preview replacement for [${write.target.id}] ${write.target.title}`,
    write.target.markdownPath,
    `Replacement raw capture: ${write.raw.trim().length} characters`,
    `First line: ${summary}`,
    "",
    "Write this replacement? y/N"
  ].join("\n") + "\n";
}

function formatAmbiguousResolution(candidates: NoteResolutionCandidate[]): string {
  if (candidates.length === 0) {
    return "No matching saved note. Rerun with an exact note ID, title, or Markdown path.\n";
  }

  const lines = [
    "Ambiguous note query. Rerun with an exact note ID, title, or Markdown path.",
    ...candidates.map((candidate, index) => {
      return `${index + 1}. [${candidate.id}] ${candidate.title}\n   ${candidate.markdownPath}\n   score ${candidate.score}: ${candidate.reasons.join("; ")}`;
    })
  ];
  return `${lines.join("\n")}\n`;
}

async function editRawCapture(raw: string): Promise<string> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-edit-"));
  const tempPath = path.join(tempDir, "raw-capture.md");
  fs.writeFileSync(tempPath, raw.endsWith("\n") ? raw : `${raw}\n`, "utf8");

  try {
    const [command, ...args] = editorCommand();
    await runEditor(command, [...args, tempPath]);
    return fs.readFileSync(tempPath, "utf8").trimEnd();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function editorCommand(): string[] {
  const configured = process.env.VISUAL || process.env.EDITOR || "vi";
  return configured.match(/"[^"]+"|'[^']+'|\S+/g)?.map((token) => token.replace(/^(['"])(.*)\1$/, "$2")) ?? ["vi"];
}

function startupMessage(isTerminal: boolean): string {
  return isTerminal
    ? `${formatTerminalSplash(output.columns, shouldColorStartup())}\n`
    : `${terminalFallbackTagline}\n`;
}

function renderStartup(isTerminal: boolean): void {
  if (isTerminal) {
    cursorTo(output, 0, 0);
    clearScreenDown(output);
  }

  output.write(startupMessage(isTerminal));
}

function formatTerminalSplash(columns = 80, color = false): string {
  const logoWidth = Math.max(...terminalLogo.map((line) => line.length));
  const boxWidth = Math.max(...terminalCommandBox.map((line) => line.length));
  const gap = "  ";
  const canRenderBox = columns >= logoWidth + gap.length + boxWidth;

  if (!canRenderBox) {
    return [
      ...terminalLogo.map((line) => colorize(line, ansi.cyan, color)),
      "",
      colorize(terminalFallbackTagline, ansi.bold, color)
    ].join("\n");
  }

  const lineCount = Math.max(terminalLogo.length, terminalCommandBox.length);
  const lines = Array.from({ length: lineCount }, (_, index) => {
    const logoLine = terminalLogo[index] ?? "";
    const boxLine = terminalCommandBox[index] ?? "";
    return `${colorize(logoLine.padEnd(logoWidth), ansi.cyan, color)}${gap}${formatCommandBoxLine(boxLine, color)}`;
  });

  return [...lines, "", colorize(terminalSplashTagline, ansi.bold, color)].join("\n");
}

function shouldColorStartup(): boolean {
  return !process.env.NO_COLOR && process.env.TERM !== "dumb";
}

function colorize(text: string, colorCode: string, enabled: boolean): string {
  return enabled ? `${colorCode}${text}${ansi.reset}` : text;
}

function formatCommandBoxLine(line: string, color: boolean): string {
  const commandMatch = line.match(/(\/(?:help|compose|related|save|quit)(?: <words>)?)/);
  const baseLine = colorize(line, ansi.dim, color);

  if (!commandMatch?.[1]) {
    return baseLine;
  }

  const command = commandMatch[1];
  return baseLine.replace(command, colorize(command, `${ansi.bold}${ansi.coral}`, color));
}

async function runEditor(command: string | undefined, args: string[]): Promise<void> {
  if (!command) {
    throw new Error("No editor command configured.");
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(signal ? `Editor exited with signal ${signal}.` : `Editor exited with code ${code}.`));
    });
  });
}

function formatLocalDate(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatDecisionAnalysis(analysis: DecisionAnalysisResult): string {
  if (analysis.relatedNotes.length === 0) {
    return `No saved notes matched ${analysis.query}.\n`;
  }
  if (analysis.decisions.length === 0) {
    return `No supported decisions found for ${analysis.query}.\n`;
  }

  const titlesById = new Map(analysis.relatedNotes.map((note) => [note.id, note.title]));
  const lines = [`Decisions for ${analysis.query}:`];
  analysis.decisions.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.decision}`);
    lines.push(`   Rationale: ${item.rationale}`);
    if (item.status) {
      lines.push(`   Status: ${item.status}`);
    }
    lines.push(`   Confidence: ${item.confidence}`);
    lines.push(`   Notes: ${formatReferencedNotes(item.relatedNoteIds, titlesById)}`);
  });
  return `${lines.join("\n")}\n`;
}

function formatGapAnalysis(analysis: GapAnalysisResult): string {
  if (analysis.relatedNotes.length === 0) {
    return `No saved notes matched ${analysis.query}.\n`;
  }
  if (analysis.gaps.length === 0) {
    return `No unexplained terms or entities found for ${analysis.query}.\n`;
  }

  const titlesById = new Map(analysis.relatedNotes.map((note) => [note.id, note.title]));
  const lines = [`Gaps for ${analysis.query}:`];
  analysis.gaps.forEach((item, index) => {
    lines.push(`${index + 1}. ${item.term}`);
    lines.push(`   Why it matters: ${item.whyItMatters}`);
    lines.push(`   Evidence: ${item.evidence}`);
    lines.push(`   Suggested question: ${item.suggestedQuestion}`);
    lines.push(`   Notes: ${formatReferencedNotes(item.relatedNoteIds, titlesById)}`);
  });
  return `${lines.join("\n")}\n`;
}

function formatContextAnalysis(analysis: ContextAnalysisResult): string {
  if (analysis.relatedNotes.length === 0) {
    return `No saved notes matched ${analysis.query}.\n`;
  }

  const displayIndexById = new Map(analysis.relatedNotes.map((note, index) => [note.id, index + 1]));
  const lines = [`Context for ${analysis.query}:`];

  lines.push("Corpus");
  lines.push(...formatContextCorpus(analysis.relatedNotes));

  if (analysis.snapshot.length > 0) {
    lines.push("Snapshot");
    for (const item of analysis.snapshot) {
      lines.push(`- ${item}`);
    }
  }

  if (analysis.themes.length > 0) {
    lines.push("Themes");
    analysis.themes.forEach((theme, index) => {
      lines.push(`${index + 1}. ${theme.title} ${formatDisplayNoteReferences(theme.relatedNoteIds, displayIndexById)}`);
      lines.push(`   ${theme.details}`);
    });
  }

  if (analysis.timeline.length > 0) {
    lines.push("Timeline");
    for (const item of analysis.timeline) {
      lines.push(`- ${item.date}: ${item.event} ${formatDisplayNoteReferences(item.relatedNoteIds, displayIndexById)}`);
    }
  }

  if (analysis.gaps.length > 0) {
    lines.push("Gaps / Questions");
    analysis.gaps.forEach((gap, index) => {
      lines.push(`${index + 1}. ${gap.question} ${formatDisplayNoteReferences(gap.relatedNoteIds, displayIndexById)}`);
      lines.push(`   ${gap.reason}`);
    });
  }

  lines.push("Related notes");
  lines.push(formatRelatedResults(analysis.relatedNotes).trimEnd());

  if (analysis.llmSkippedReason) {
    lines.push(analysis.llmSkippedReason);
  }

  return `${lines.join("\n")}\n`;
}

function formatContextCorpus(notes: RelatedResult[]): string[] {
  const strengths = countBy(notes.map((note) => note.strength));
  const dates = notes
    .flatMap((note) => [note.createdAt.slice(0, 10), ...note.dates])
    .filter(Boolean)
    .sort();
  const concepts = topCorpusConcepts(notes);
  const lines = [
    `- ${notes.length} related note${notes.length === 1 ? "" : "s"} used from local retrieval (${formatCounts(strengths)}).`,
    `- Strongest notes: ${notes.slice(0, 4).map((note, index) => `[${index + 1}] ${note.title}`).join("; ")}.`
  ];

  if (dates.length > 0) {
    const first = dates[0];
    const last = dates.at(-1);
    lines.push(first === last ? `- Dates represented: ${first}.` : `- Dates represented: ${first} to ${last}.`);
  }

  if (concepts.length > 0) {
    lines.push(`- Recurring metadata: ${concepts.join(", ")}.`);
  }

  return lines;
}

function topCorpusConcepts(notes: RelatedResult[]): string[] {
  const counts = new Map<string, number>();
  const add = (value: string): void => {
    const normalized = value.trim();
    if (!normalized) {
      return;
    }
    counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
  };

  for (const note of notes) {
    note.tags.forEach(add);
    note.topics.forEach(add);
    note.entities.map((entity) => entity.name).forEach(add);
  }

  return Array.from(counts.entries())
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 8)
    .map(([value]) => value);
}

function countBy(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function formatCounts(counts: Map<string, number>): string {
  return Array.from(counts.entries())
    .map(([value, count]) => `${count} ${value.toLowerCase()}`)
    .join(", ");
}

function formatDisplayNoteReferences(noteIds: number[], displayIndexById: Map<number, number>): string {
  const refs = noteIds
    .map((id) => displayIndexById.get(id))
    .filter((index): index is number => index !== undefined)
    .map((index) => `[${index}]`);
  return refs.length > 0 ? refs.join(" ") : "";
}

function formatReferencedNotes(noteIds: number[], titlesById: Map<number, string>): string {
  return noteIds
    .map((id) => {
      const title = titlesById.get(id);
      return title ? `[${id}] ${title}` : `[${id}]`;
    })
    .join(", ");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
