#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { parseCheckQuery } from "./check.js";
import { parseInput, helpText } from "./commands.js";
import { loadDotEnv } from "./env.js";
import { OpenAICompatibleProvider, providerConfigFromEnv, providerStatus, ProviderConfigError } from "./provider.js";
import { NoteSession } from "./session.js";
import { defaultStoragePaths, NoteStore } from "./storage.js";

const autosaveDelayMs = 2000;

async function main(): Promise<void> {
  loadDotEnv();
  const config = providerConfigFromEnv();
  const provider = new OpenAICompatibleProvider(config);
  const store = new NoteStore(defaultStoragePaths());
  const session = new NoteSession(store, provider);
  const rl = createInterface({ input, output, terminal: input.isTTY && output.isTTY });
  let composeBuffer: string[] | undefined;
  let autosaveTimer: ReturnType<typeof setTimeout> | undefined;

  const writePrompt = (): void => {
    if (input.isTTY) {
      output.write("> ");
    }
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
      const saved = session.autosave();
      if (saved) {
        output.write(`Autosaved ${saved.title}\n${saved.markdownPath}\n`);
        writePrompt();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.write(`Autosave failed: ${message}\n`);
      writePrompt();
    }
  };

  const scheduleAutosave = (): void => {
    clearAutosave();
    autosaveTimer = setTimeout(runAutosave, autosaveDelayMs);
  };

  output.write("Logbook note session. Type /help for commands.\n");

  try {
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
        if (input.isTTY) {
          output.write("| ");
        }
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

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
