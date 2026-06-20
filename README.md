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

Local OpenAI-compatible servers can also work if they expose `/chat/completions`.

## Commands

- `/new` starts a new note session.
- `/save` writes the current note to Markdown and SQLite.
- `/process` lightly organizes the note while preserving the raw capture.
- `/tag` regenerates tags and topics.
- `/summary` creates a short summary.
- `/search <query>` searches stored notes.
- `/provider` shows active provider configuration.
- `/help` lists commands.
- `/quit` exits cleanly.

Markdown notes are written to `notes/YYYY-MM-DD-slug.md`. SQLite data is stored in `.logbook/logbook.sqlite`.
