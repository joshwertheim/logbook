import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadDotEnv, parseDotEnv } from "../src/env.js";

test("parses dotenv values", () => {
  assert.deepEqual(parseDotEnv(`
    # comment
    LLM_BASE_URL=https://api.openai.com/v1
    export LLM_MODEL="gpt-4.1-mini"
    LLM_API_KEY='test-key'
    IGNORED LINE
  `), {
    LLM_BASE_URL: "https://api.openai.com/v1",
    LLM_MODEL: "gpt-4.1-mini",
    LLM_API_KEY: "test-key"
  });
});

test("loads root .env without overriding existing env values", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-env-"));
  fs.writeFileSync(path.join(dir, ".env"), [
    "LLM_BASE_URL=http://localhost:11434/v1",
    "LLM_API_KEY=file-key",
    "LLM_MODEL=file-model"
  ].join("\n"));

  const env: NodeJS.ProcessEnv = {
    LLM_API_KEY: "shell-key"
  };

  loadDotEnv(dir, env);

  assert.equal(env.LLM_BASE_URL, "http://localhost:11434/v1");
  assert.equal(env.LLM_API_KEY, "shell-key");
  assert.equal(env.LLM_MODEL, "file-model");
});
