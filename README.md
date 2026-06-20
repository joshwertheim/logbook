# Logbook

A CLI-first note-taking LLM harness. It captures raw notes, enriches them with lightweight metadata, stores readable Markdown files, and records searchable note data in SQLite.

## Requirements

- Node.js 24+
- pnpm

## Setup

```sh
pnpm install
pnpm build
pnpm start
```

## Provider Configuration

The first provider is OpenAI-compatible and uses `fetch`.

```sh
export LLM_BASE_URL="https://api.openai.com/v1"
export LLM_API_KEY="..."
export LLM_MODEL="gpt-4.1-mini"
```

You can also put those values in a root-level `.env` file:

```sh
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=...
LLM_MODEL=gpt-4.1-mini
```

Environment variables already set in your shell take precedence over `.env` values.

Local OpenAI-compatible servers can also work if they expose `/chat/completions`.

### OpenRouter and cheap models

OpenRouter can be used through the same OpenAI-compatible provider settings:

```sh
LLM_BASE_URL=https://openrouter.ai/api/v1
LLM_API_KEY=...
LLM_MODEL=openai/gpt-4.1-nano
```

For this app, prefer a cheap, reliable small model over the absolute cheapest
available model. Logbook uses the model for note metadata, tags, summaries, and
cleanup, so consistent structured output matters more than minimizing every
fraction of a cent.

You can try cheaper or free OpenRouter models by changing `LLM_MODEL`, but
validate them against real note flows before relying on them:

```sh
/metadata
/summary
/process
```

## Commands

- `/new` starts a new note session.
- `/save` writes or updates the current note to Markdown and SQLite.
- `/process` lightly organizes the note while preserving the raw capture.
- `/metadata` refreshes title, summary, tags, topics, entities, dates, and type.
- `/tag` regenerates tags only; `/metadata` is preferred for the full metadata contract.
- `/summary` creates a short summary.
- `/search <query>` searches stored notes.
- `/check <question>` checks saved notes by natural date phrases, such as `/check what happened today`.
- `/provider` shows active provider configuration.
- `/compose` starts multiline capture mode. Press Return for new lines, then enter `/done` to capture the block or `/cancel` to discard it.
- `/help` lists commands.
- `/quit` exits cleanly.

Markdown notes are written to `notes/YYYY-MM-DD-slug.md`. SQLite data is stored in `.logbook/logbook.sqlite`.
Captured notes autosave after 2 seconds of input inactivity. Autosave creates the note on first save, then updates the same Markdown file and SQLite note while you keep working.
