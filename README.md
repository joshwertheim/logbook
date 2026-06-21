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

## How LLMs Are Used

Logbook uses one OpenAI-compatible chat-completions provider. Every LLM request is a `POST` to:

```text
${LLM_BASE_URL}/chat/completions
```

The request includes the configured `LLM_MODEL`, a `messages` array, a temperature, and, for JSON tasks, `response_format: { "type": "json_object" }`. Requests are authenticated with `Authorization: Bearer ${LLM_API_KEY}`.

LLM calls happen in these cases:

- Capturing note text starts a background metadata extraction call when a provider is configured. The raw note is sent with a metadata prompt, and the model returns JSON for title, tags, topics, entities, dates, summary, and type. If this fails, Logbook keeps a local fallback title, summary, dates, and inferred type.
- `/metadata` runs the same metadata extraction call immediately and updates the current draft.
- `/summary` sends the raw note with a summary prompt and stores the returned summary. If the call fails, Logbook falls back to a local first-line summary.
- `/tag` sends the raw note with a tag-generation prompt and expects JSON shaped like `{ "tags": [...] }`. If the call fails, Logbook falls back to local keyword tags.
- `/process` sends the raw note with an organization prompt and stores the returned organized version. This command requires a configured provider.
- `/related [query]` first finds deterministic candidates locally, then asks the model to rerank those candidates as JSON. If no provider is configured or reranking fails, Logbook returns the deterministic ranking and prints why LLM reranking was skipped.
- `/decisions <query>` first finds deterministic candidates locally, then asks the model to synthesize supported decisions, rationale, and related note references as JSON. This command requires a configured provider when matching notes exist.
- `/gaps <query>` first finds deterministic candidates locally, then asks the model to identify important unexplained terms, entities, acronyms, or project names as JSON. This command requires a configured provider when matching notes exist.

These commands do not call the LLM provider: `/save`, autosave, `/new`, `/search`, `/check`, `/index`, `/provider`, `/compose`, `/help`, and `/quit`.

## Commands

Press Tab while typing a slash command to autocomplete matching commands, such as `/rel` to `/related`.

- `/new` starts a new note session.
- `/save` writes or updates the current note to Markdown and SQLite.
- `/process` lightly organizes the note while preserving the raw capture.
- `/metadata` refreshes title, summary, tags, topics, entities, dates, and type.
- `/tag` regenerates tags only; `/metadata` is preferred for the full metadata contract.
- `/summary` creates a short summary.
- `/search <query>` searches stored notes.
- `/related [query]` finds saved notes related to the current note or supplied query.
- `/decisions <query>` synthesizes decisions and rationale from related notes.
- `/gaps <query>` finds unexplained terms and entities in related notes.
- `/check <question>` checks saved notes by natural date phrases, such as `/check what happened today`.
- `/index` indexes Markdown notes into SQLite.
- `/provider` shows active provider configuration.
- `/compose` starts multiline capture mode. Press Return for new lines, then enter `/done` to capture the block or `/cancel` to discard it.
- `/help` lists commands.
- `/quit` exits cleanly.

## Storage and Indexing

Markdown notes are written to `notes/YYYY-MM-DD-slug.md`. SQLite data is stored in `.logbook/logbook.sqlite`.

SQLite is the CLI's operational source of truth. Markdown files are readable mirrors written on save; manual Markdown edits are not reflected in CLI search, check, or related-note results until you run `/index` or `logbook index`.

Use `/index` inside the interactive CLI, or run this outside the CLI:

```sh
logbook index
```

Captured notes autosave after 2 seconds of input inactivity. Autosave creates the note on first save, then updates the same Markdown file and SQLite note while you keep working.

---

Heads up: large parts of this codebase (and this README) are AI slop — generated with Codex. Read before you trust.
