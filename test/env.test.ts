import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadProviderEnv, parseDotEnv } from "../src/env.js";

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

test("loads provider values from user config without overriding shell values", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-env-"));
  const configDir = path.join(homeDir, ".logbook");
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, "config.env");
  fs.writeFileSync(configPath, [
    "LLM_BASE_URL=http://localhost:11434/v1",
    "LLM_API_KEY=file-key",
    "LLM_MODEL=file-model"
  ].join("\n"));

  const env: NodeJS.ProcessEnv = {
    LLM_API_KEY: "shell-key"
  };

  const result = loadProviderEnv({ env, homeDir });

  assert.equal(result.source, "user-config");
  assert.equal(result.path, configPath);
  assert.equal(env.LLM_BASE_URL, "http://localhost:11434/v1");
  assert.equal(env.LLM_API_KEY, "shell-key");
  assert.equal(env.LLM_MODEL, "file-model");
});

test("loads notes directory from user config without overriding shell values", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-env-notes-"));
  const configDir = path.join(homeDir, ".logbook");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "config.env"), [
    "LOGBOOK_NOTES_DIR=/tmp/logbook-notes-from-file"
  ].join("\n"));

  const env: NodeJS.ProcessEnv = {
    LOGBOOK_NOTES_DIR: "/tmp/logbook-notes-from-shell"
  };

  const result = loadProviderEnv({ env, homeDir });

  assert.equal(result.source, "user-config");
  assert.equal(env.LOGBOOK_NOTES_DIR, "/tmp/logbook-notes-from-shell");
});

test("loads notes directory from user config", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-env-notes-"));
  const configDir = path.join(homeDir, ".logbook");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "config.env"), [
    "LOGBOOK_NOTES_DIR=/tmp/logbook-notes-from-file"
  ].join("\n"));

  const env: NodeJS.ProcessEnv = {};

  const result = loadProviderEnv({ env, homeDir });

  assert.equal(result.source, "user-config");
  assert.equal(env.LOGBOOK_NOTES_DIR, "/tmp/logbook-notes-from-file");
});

test("does not load cwd .env by default", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-env-cwd-"));
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-env-empty-"));
  fs.writeFileSync(path.join(dir, ".env"), [
    "LLM_BASE_URL=http://localhost:11434/v1",
    "LLM_API_KEY=file-key",
    "LLM_MODEL=file-model"
  ].join("\n"));

  const env: NodeJS.ProcessEnv = {};

  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    const result = loadProviderEnv({ env, homeDir });
    assert.equal(result.source, "unset");
    assert.equal(env.LLM_BASE_URL, undefined);
    assert.equal(env.LLM_API_KEY, undefined);
    assert.equal(env.LLM_MODEL, undefined);
  } finally {
    process.chdir(previousCwd);
  }
});

test("supports explicit LOGBOOK_CONFIG", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-env-explicit-"));
  const configPath = path.join(dir, "provider.env");
  fs.writeFileSync(configPath, [
    "LLM_BASE_URL=https://api.openai.com/v1",
    "LLM_API_KEY=file-key",
    "LLM_MODEL=file-model"
  ].join("\n"));

  const env: NodeJS.ProcessEnv = {
    LOGBOOK_CONFIG: configPath
  };

  const result = loadProviderEnv({ env });

  assert.equal(result.source, "explicit-config");
  assert.equal(result.path, configPath);
  assert.equal(env.LLM_BASE_URL, "https://api.openai.com/v1");
  assert.equal(env.LLM_API_KEY, "file-key");
  assert.equal(env.LLM_MODEL, "file-model");
});

test("creates default logbook home for user config", () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "logbook-env-home-"));
  const env: NodeJS.ProcessEnv = {};

  const result = loadProviderEnv({ env, homeDir });

  assert.equal(result.source, "unset");
  assert.equal(fs.existsSync(path.join(homeDir, ".logbook")), true);
});
