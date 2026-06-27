import os from "node:os";
import path from "node:path";

export function logbookHomeDir(homeDir = os.homedir()): string {
  return path.join(homeDir, ".logbook");
}

export function defaultConfigPath(homeDir = os.homedir()): string {
  return path.join(logbookHomeDir(homeDir), "config.env");
}

export function defaultNotesDir(homeDir = os.homedir()): string {
  return path.join(logbookHomeDir(homeDir), "notes");
}

export function configuredNotesDir(env: NodeJS.ProcessEnv = process.env, homeDir = os.homedir()): string {
  const configured = env.LOGBOOK_NOTES_DIR?.trim();
  if (!configured) {
    return defaultNotesDir(homeDir);
  }

  const expanded = configured === "~" ? homeDir : configured.startsWith("~/") ? path.join(homeDir, configured.slice(2)) : configured;
  if (!path.isAbsolute(expanded)) {
    throw new Error("LOGBOOK_NOTES_DIR must be an absolute path or start with ~/.");
  }

  return path.normalize(expanded);
}
