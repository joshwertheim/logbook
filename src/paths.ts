import os from "node:os";
import path from "node:path";

export function logbookHomeDir(homeDir = os.homedir()): string {
  return path.join(homeDir, ".logbook");
}

export function defaultConfigPath(homeDir = os.homedir()): string {
  return path.join(logbookHomeDir(homeDir), "config.env");
}
