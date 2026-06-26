# Repository Guidelines

## Project Structure & Module Organization

Logbook is a CLI-first TypeScript project. Source files live in `src/`, with `src/cli.ts` as the executable entry point and modules such as `storage.ts`, `session.ts`, `metadata.ts`, and `provider.ts` handling core behavior. Tests live in `test/` and mirror source concerns with `*.test.ts` files. JSON schema assets are in `schema/`. Runtime note data is generated outside source control in `notes/` and `.logbook/`; treat those as user data, not application code.

## Build, Test, and Development Commands

- `pnpm install` installs dependencies using the checked-in lockfile.
- `pnpm build` compiles TypeScript to `dist/`.
- `pnpm typecheck` runs strict TypeScript checks without writing output.
- `pnpm test` builds first, then runs Node's built-in test runner against `dist/test/*.test.js`.
- `pnpm start` builds and launches the CLI from `dist/src/cli.js`.

Node.js 24+ and pnpm are required. For provider-backed flows, configure `LLM_BASE_URL`, `LLM_API_KEY`, and `LLM_MODEL` in the shell or a root `.env` file.

## Coding Style & Naming Conventions

Use strict TypeScript with ES modules and explicit `.js` extensions for local imports, matching the existing NodeNext setup. Prefer small, focused modules and named exports for reusable behavior. Use two-space indentation, double quotes, semicolons, and descriptive camelCase names for functions, variables, and test helpers. Keep CLI command names slash-based and user-facing text concise.

## Testing Guidelines

Tests use `node:test` with `node:assert/strict`. Add tests under `test/` using the pattern `<module>.test.ts`, and keep fixtures local to the test unless they are reused broadly. Run `pnpm test` before submitting changes; run `pnpm typecheck` when editing types, provider contracts, or storage/session boundaries.

## Commit & Pull Request Guidelines

Recent commits use short imperative subjects, for example `Add context knowledge snapshot command` and `Fix date checks and literal search`. Follow that style: describe the behavior change, not the implementation chore. Pull requests should include a brief summary, test results, linked issues when applicable, and screenshots or terminal output for visible CLI behavior changes. Note any changes to storage format, generated note paths, or LLM request behavior.

## Security & Configuration Tips

Do not commit `.env`, `.logbook/`, generated notes, API keys, or provider transcripts. Preserve prompt-safety boundaries: raw note text should remain inside untrusted JSON fields, and outbound LLM payloads should continue using the existing redaction and schema-validation paths.
