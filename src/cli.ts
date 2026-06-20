#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { parseInput, helpText } from "./commands.js";
import { loadDotEnv } from "./env.js";
import { OpenAICompatibleProvider, providerConfigFromEnv, providerStatus, ProviderConfigError } from "./provider.js";
import { NoteSession } from "./session.js";
import { defaultStoragePaths, NoteStore } from "./storage.js";

async function main(): Promise<void> {
  loadDotEnv();
  const config = providerConfigFromEnv();
  const provider = new OpenAICompatibleProvider(config);
  const store = new NoteStore(defaultStoragePaths());
  const session = new NoteSession(store, provider);
  const rl = createInterface({ input, output, terminal: input.isTTY && output.isTTY });

  output.write("Logbook note session. Type /help for commands.\n");

  try {
    if (input.isTTY) {
      output.write("> ");
    }

    for await (const line of rl) {
      const parsed = parseInput(line);

      if (parsed.kind === "input") {
        await session.append(parsed.text);
        output.write("captured\n");
        if (input.isTTY) {
          output.write("> ");
        }
        continue;
      }

      if (parsed.name === "quit") {
        break;
      }

      try {
        switch (parsed.name) {
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

      if (input.isTTY) {
        output.write("> ");
      }
    }
  } finally {
    rl.close();
    store.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
