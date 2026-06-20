#!/usr/bin/env node
import { emitKeypressEvents } from "node:readline";
import type { Key } from "node:readline";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { parseCheckQuery } from "./check.js";
import { parseInput, helpText, type SlashCommand } from "./commands.js";
import { loadDotEnv } from "./env.js";
import { OpenAICompatibleProvider, providerConfigFromEnv, providerStatus, ProviderConfigError } from "./provider.js";
import { NoteSession } from "./session.js";
import { defaultStoragePaths, NoteStore } from "./storage.js";
import { terminalActionForKey } from "./terminalInput.js";

async function main(): Promise<void> {
  loadDotEnv();
  const config = providerConfigFromEnv();
  const provider = new OpenAICompatibleProvider(config);
  const store = new NoteStore(defaultStoragePaths());
  const session = new NoteSession(store, provider);

  try {
    if (input.isTTY && output.isTTY) {
      await runInteractiveMode(session, config);
    } else {
      await runLineMode(session, config);
    }
  } finally {
    store.close();
  }
}

async function runLineMode(session: NoteSession, config: ReturnType<typeof providerConfigFromEnv>): Promise<void> {
  const rl = createInterface({ input, output, terminal: false });

  output.write("Logbook note session. Type /help for commands.\n");

  try {
    for await (const line of rl) {
      const parsed = parseInput(line);

      if (parsed.kind === "input") {
        await session.append(parsed.text);
        output.write("captured\n");
        continue;
      }

      if (parsed.name === "quit") {
        break;
      }

      await executeCommand(parsed, session, config);
    }
  } finally {
    rl.close();
  }
}

async function runInteractiveMode(session: NoteSession, config: ReturnType<typeof providerConfigFromEnv>): Promise<void> {
  output.write("Logbook note session. Type /help for commands.\n");
  output.write("Enter saves the current note. Shift+Enter/Ctrl+Enter inserts a newline when your terminal supports it. Ctrl+J also inserts a newline.\n");
  output.write("> ");

  emitKeypressEvents(input);
  input.setRawMode(true);
  input.resume();

  let buffer = "";
  let pending = Promise.resolve();
  let ignoreSubmitUntil = 0;

  await new Promise<void>((resolve) => {
    const onKeypress = (sequence: string, key: Key): void => {
      pending = pending.then(async () => {
        const action = terminalActionForKey(sequence, key);

        switch (action.kind) {
          case "quit":
            output.write("\n");
            cleanup();
            resolve();
            break;
          case "clear":
            buffer = "";
            output.write("\n> ");
            break;
          case "backspace":
            if (buffer.length > 0) {
              buffer = buffer.slice(0, -1);
              output.write("\b \b");
            }
            break;
          case "newline":
            buffer += "\n";
            ignoreSubmitUntil = Date.now() + 100;
            output.write("\n  ");
            break;
          case "text":
            buffer += action.value;
            output.write(action.value);
            break;
          case "submit":
            if (Date.now() < ignoreSubmitUntil) {
              break;
            }
            output.write("\n");
            if (await submitInteractiveBuffer(buffer, session, config) === "quit") {
              cleanup();
              resolve();
              break;
            }
            buffer = "";
            output.write("> ");
            break;
          case "ignore":
            break;
        }
      }).catch((error: unknown) => {
        output.write(`${formatError(error)}\n> `);
      });
    };

    const cleanup = (): void => {
      input.off("keypress", onKeypress);
      input.setRawMode(false);
      input.pause();
    };

    input.on("keypress", onKeypress);
  });

  await pending;
}

async function submitInteractiveBuffer(buffer: string, session: NoteSession, config: ReturnType<typeof providerConfigFromEnv>): Promise<"continue" | "quit"> {
  const value = buffer.trim();
  if (!value) {
    output.write("No note content to save.\n");
    return "continue";
  }

  const parsed = parseInput(value);
  if (parsed.kind === "command") {
    if (parsed.name === "quit") {
      return "quit";
    }
    await executeCommand(parsed, session, config);
    return "continue";
  }

  await session.append(buffer);
  const saved = session.save();
  output.write(`Saved ${saved.title}\n${saved.markdownPath}\n`);
  await session.newNote();
  return "continue";
}

async function executeCommand(command: SlashCommand, session: NoteSession, config: ReturnType<typeof providerConfigFromEnv>): Promise<void> {
  try {
    switch (command.name) {
      case "new":
        await session.newNote();
        output.write("Started a new note.\n");
        break;
      case "save": {
        const saved = session.save();
        output.write(`Saved ${saved.title}\n${saved.markdownPath}\n`);
        break;
      }
      case "process": {
        const processed = await session.process();
        output.write(`${processed}\n`);
        break;
      }
      case "tag": {
        const tags = await session.regenerateTags();
        output.write(`${tags.join(", ")}\n`);
        break;
      }
      case "summary": {
        const summary = await session.summarize();
        output.write(`${summary}\n`);
        break;
      }
      case "search": {
        if (!command.args.trim()) {
          output.write("Usage: /search <query>\n");
          break;
        }
        const results = session.search(command.args.trim());
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
        const query = parseCheckQuery(command.args);
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
      case "quit":
        break;
    }
  } catch (error) {
    output.write(`${formatError(error)}\n`);
  }
}

function formatError(error: unknown): string {
  if (error instanceof ProviderConfigError) {
    return error.message;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown error.";
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
