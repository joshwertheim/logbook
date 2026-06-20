#!/usr/bin/env node
import { clearLine, cursorTo } from "node:readline";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { parseCheckQuery } from "./check.js";
import { parseInput, helpText, parseRelatedArgs, parseRelatedSelectionArgs } from "./commands.js";
import { loadDotEnv } from "./env.js";
import { OpenAICompatibleProvider, providerConfigFromEnv, providerStatus, ProviderConfigError } from "./provider.js";
import { NoteSession } from "./session.js";
import { defaultStoragePaths, NoteStore } from "./storage.js";
import type { RelatedResult } from "./types.js";

const autosaveDelayMs = 2000;

async function main(): Promise<void> {
  loadDotEnv();
  const config = providerConfigFromEnv();
  const provider = new OpenAICompatibleProvider(config);
  const store = new NoteStore(defaultStoragePaths());
  const session = new NoteSession(store, provider);
  const isTerminal = input.isTTY && output.isTTY;
  const rl = createInterface({ input, output, prompt: "> ", terminal: isTerminal });
  let composeBuffer: string[] | undefined;
  let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
  let lastRelatedResults: RelatedResult[] = [];

  const writePrompt = (): void => {
    if (isTerminal) {
      rl.setPrompt(composeBuffer ? "| " : "> ");
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

  output.write("Logbook note session. Type /help for commands.\n");

  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    writePrompt();

    for await (const line of rl) {
      if (composeBuffer) {
        if (line === "/done") {
          const text = composeBuffer.join("\n");
          composeBuffer = undefined;
          if (text.trim()) {
            await session.append(text);
            output.write("captured multiline note\n");
            scheduleAutosave();
          } else {
            output.write("No multiline content captured.\n");
          }
          writePrompt();
          continue;
        }
        if (line === "/cancel") {
          composeBuffer = undefined;
          output.write("Canceled multiline note.\n");
          writePrompt();
          continue;
        }

        composeBuffer.push(line);
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

      if (parsed.name === "quit") {
        if (autosaveTimer) {
          runAutosave();
        }
        break;
      }

      try {
        switch (parsed.name) {
          case "compose":
            composeBuffer = [];
            output.write("Compose mode. Finish with /done or discard with /cancel.\n");
            break;
          case "done":
            output.write("Not currently composing. Use /compose to start a multiline note.\n");
            break;
          case "cancel":
            output.write("Not currently composing. Use /compose to start a multiline note.\n");
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
          case "note": {
            const selection = parseRelatedSelectionArgs(parsed.args);
            if (!selection.index) {
              output.write("Usage: /note <number> [all|snippet|path|id|reason]\n");
              break;
            }
            const result = lastRelatedResults[selection.index - 1];
            if (!result) {
              output.write("No related result at that number. Run /related first, then choose a listed number.\n");
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

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
