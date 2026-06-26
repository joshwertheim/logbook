# Logbook

A CLI-first note-taking LLM harness. It captures raw notes, enriches them with lightweight metadata, stores readable Markdown files, and records searchable note data in SQLite.

## Requirements

- Node.js 24+
- pnpm

## Development Setup

```sh
pnpm install
pnpm build
pnpm start
```

## Install

To install Logbook locally with pnpm so the `logbook` command is available from
your shell:

```sh
pnpm install
pnpm build
pnpm add --global .
```

> [!TIP]
> If you have not set up `pnpm` before, then you may need to run `pnpm setup` and start a new shell

Then verify the command is available:

```sh
which logbook
logbook
```

This installs the package's `logbook` binary from `dist/src/cli.js`.

After changing TypeScript source, run `pnpm build` again so `logbook` uses the
latest compiled output.

## Provider Configuration

The first provider is OpenAI-compatible and uses `fetch`.

```sh
export LLM_BASE_URL="https://api.openai.com/v1"
export LLM_API_KEY="..."
export LLM_MODEL="gpt-4.1-mini"
```

You can also put those values in a user-level config file:

```sh
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/logbook"
$EDITOR "${XDG_CONFIG_HOME:-$HOME/.config}/logbook/config.env"
```

```env
LLM_BASE_URL=https://api.openai.com/v1
LLM_API_KEY=...
LLM_MODEL=gpt-4.1-mini
```

Environment variables already set in your shell take precedence over config file values. By default, Logbook reads `$XDG_CONFIG_HOME/logbook/config.env`, falling back to `~/.config/logbook/config.env`. To use an explicit config file, set `LOGBOOK_CONFIG` to an absolute path:

```sh
LOGBOOK_CONFIG=/absolute/path/to/config.env logbook
```

Logbook does not auto-load `./.env` from the directory where it is run. If you previously used a root-level `.env`, move those provider values to the user config file or launch Logbook with `LOGBOOK_CONFIG=/absolute/path/to/config.env`.

Provider URLs must use HTTPS unless they point to a loopback HTTP server: `http://localhost`, `http://127.0.0.1`, or `http://[::1]`. Local OpenAI-compatible servers can work if they expose `/chat/completions`.

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

User note text is sent inside JSON prompt envelopes such as `untrustedNote` or `untrustedNotes`, separate from the trusted `task` and `rules` fields. The rules tell the model to treat note text as data and ignore instructions inside notes that try to change roles, reveal prompts, alter schemas, or override the task.

Before outbound LLM calls, Logbook redacts common PII patterns in the prompt payload, including likely emails, phone numbers, SSNs, credit-card-like numbers, API-key/token-looking strings, and bearer tokens. Redaction uses stable placeholders per request, such as `[REDACTED_EMAIL_1]`. Saved Markdown and SQLite raw note content are not redacted or mutated.

JSON responses are validated with runtime schemas before normalization. String lengths and array sizes are bounded, extra fields and malformed shapes are rejected, and deterministic fallback behavior is used where available, such as metadata extraction and reranking.

LLM calls happen in these cases:

- Capturing note text starts a background metadata extraction call when a provider is configured. The raw note is sent as `untrustedNote` with a metadata task, and the model returns JSON for title, tags, topics, entities, dates, summary, and type. If this fails, Logbook keeps a local fallback title, summary, dates, and inferred type.
- `/metadata` runs the same metadata extraction call immediately and updates the current draft.
- `/summary` sends the raw note as `untrustedNote` with a summary task and stores the returned summary. If the call fails, Logbook falls back to a local first-line summary.
- `/tag` sends the raw note as `untrustedNote` with a tag-generation task and expects JSON shaped like `{ "tags": [...] }`. If the call fails, Logbook falls back to local keyword tags.
- `/process` sends the raw note as `untrustedNote` with an organization task and stores the returned organized version. This command requires a configured provider.
- `/related [query]` first finds deterministic candidates locally, then asks the model to rerank those candidates as `untrustedNotes` JSON. If no provider is configured or reranking fails, Logbook returns the deterministic ranking and prints why LLM reranking was skipped.
- `/context <query>` first finds related notes locally, then asks the model for a concise snapshot, themes, timeline, gaps, and note references from `untrustedNotes` JSON. If no provider is configured or synthesis fails, Logbook returns a deterministic local snapshot and prints why LLM synthesis was skipped.
- `/decisions <query>` first finds deterministic candidates locally, then asks the model to synthesize supported decisions, rationale, and related note references from `untrustedNotes` JSON. This command requires a configured provider when matching notes exist.
- `/gaps <query>` first finds deterministic candidates locally, then asks the model to identify important unexplained terms, entities, acronyms, or project names from `untrustedNotes` JSON. This command requires a configured provider when matching notes exist.

These commands do not call the LLM provider: `/save`, autosave, `/new`, `/search`, `/check`, `/index`, `/provider`, `/help`, and `/quit`.

## Commands

Press Tab while typing a slash command to autocomplete matching commands, such as `/rel` to `/related`.

- `/new` starts a new note session.
- `/save` writes or updates the current note to Markdown and SQLite.
- `/process` lightly organizes the note while preserving the raw capture.
- `/metadata` refreshes title, summary, tags, topics, entities, dates, and type.
- `/tag` regenerates tags only; `/metadata` is preferred for the full metadata contract.
- `/summary` creates a short summary.
- `/search <query>` searches stored notes.
- `/amend <query>` appends a dated update to an existing saved note.
- `/edit <query>` edits the raw capture of an existing saved note.
- `/related [query]` finds saved notes related to the current note or supplied query.
- `/context <query>` creates a concise knowledge snapshot from related saved notes, including a corpus summary of the notes used. Its related notes are numbered for `/note` inspection.
- `/decisions <query>` synthesizes decisions and rationale from related notes.
- `/gaps <query>` finds unexplained terms and entities in related notes.
- `/note <number> [all|snippet|path|id|reason]` shows details for a numbered `/related` or `/context` result.
- `/check <question>` checks saved notes by natural date phrases, such as `/check what happened today`.
- `/index` indexes Markdown notes into SQLite.
- `/provider` shows active provider configuration.
- `/compose` opens the current draft in `$VISUAL`, `$EDITOR`, or `vi`. Save and exit to replace the draft immediately; blank editor content leaves it unchanged.
- `/multiline` starts multiline capture mode. Press Return for new lines, then enter `/done` to capture the block or `/cancel` to discard it.
- `/done` finishes multiline or amend capture.
- `/cancel` discards multiline or amend capture.
- `/help` lists commands.
- `/quit` exits cleanly.

## Storage and Indexing

Markdown notes are written to `notes/YYYY-MM-DD-slug.md`. SQLite data is stored in `.logbook/logbook.sqlite`.

SQLite is the CLI's operational source of truth. Markdown files are readable mirrors written on save; manual Markdown edits are not reflected in CLI search, check, or related-note results until you run `/index` or `logbook index`.

Indexing expects Logbook's generated frontmatter shape: one `key: value` entry per line, with strings and arrays written as JSON-compatible inline values. General YAML features such as multi-line arrays are not parsed.

Use `/index` inside the interactive CLI, or run this outside the CLI:

```sh
logbook index
```

Captured notes autosave after 2 seconds of input inactivity. Autosave creates the note on first save, then updates the same Markdown file and SQLite note while you keep working.

---

Heads up: large parts of this codebase (and this README) are AI slop — generated with Codex. Read before you trust.
