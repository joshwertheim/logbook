import fs from "node:fs";
import path from "node:path";
import { defaultConfigPath, logbookHomeDir } from "./paths.js";

const providerKeys = ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"] as const;

export type ProviderEnvSource = "shell" | "explicit-config" | "user-config" | "unset";

export interface ProviderEnvLoadOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export interface ProviderEnvLoadResult {
  source: ProviderEnvSource;
  path?: string;
}

export function loadProviderEnv(options: ProviderEnvLoadOptions = {}): ProviderEnvLoadResult {
  const env = options.env ?? process.env;
  const explicitConfig = env.LOGBOOK_CONFIG;
  const userConfigPath = defaultConfigPath(options.homeDir);
  const configPath = explicitConfig && path.isAbsolute(explicitConfig) ? explicitConfig : userConfigPath;
  const configSource: ProviderEnvSource = explicitConfig && path.isAbsolute(explicitConfig) ? "explicit-config" : "user-config";

  if (configPath === userConfigPath) {
    fs.mkdirSync(logbookHomeDir(options.homeDir), { recursive: true });
  }

  if (fs.existsSync(configPath)) {
    loadEnvFile(configPath, env);
    return { source: configSource, path: configPath };
  }

  return providerKeys.some((key) => env[key] !== undefined) ? { source: "shell" } : { source: "unset" };
}

function loadEnvFile(envPath: string, env: NodeJS.ProcessEnv): void {
  const values = parseDotEnv(fs.readFileSync(envPath, "utf8"));
  for (const [key, value] of Object.entries(values)) {
    if (env[key] === undefined) {
      env[key] = value;
    }
  }
}

export function parseDotEnv(content: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const equalsIndex = normalized.indexOf("=");
    if (equalsIndex <= 0) {
      continue;
    }

    const key = normalized.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    values[key] = parseValue(normalized.slice(equalsIndex + 1).trim());
  }

  return values;
}

function parseValue(value: string): string {
  if (value.startsWith("\"") && value.endsWith("\"")) {
    return value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, "\"");
  }

  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }

  const commentIndex = value.indexOf(" #");
  return (commentIndex === -1 ? value : value.slice(0, commentIndex)).trim();
}
