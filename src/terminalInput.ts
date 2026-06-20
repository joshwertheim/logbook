import type { Key } from "node:readline";

export type TerminalAction =
  | { kind: "submit" }
  | { kind: "newline" }
  | { kind: "backspace" }
  | { kind: "clear" }
  | { kind: "quit" }
  | { kind: "text"; value: string }
  | { kind: "ignore" };

const modifiedEnterSequences = new Set([
  "\u001b[13;2u",
  "\u001b[13;5u",
  "\u001b[13;6u",
  "\u001b[27;2;13~",
  "\u001b[27;5;13~",
  "\u001b[27;6;13~"
]);

export function terminalActionForKey(sequence: string | undefined, key: Key | undefined): TerminalAction {
  if (key?.ctrl && key.name === "c") {
    return { kind: "quit" };
  }

  if (key?.ctrl && key.name === "u") {
    return { kind: "clear" };
  }

  if (key?.name === "backspace" || sequence === "\u007f") {
    return { kind: "backspace" };
  }

  if (isModifiedEnter(sequence, key)) {
    return { kind: "newline" };
  }

  if (key?.name === "return" || key?.name === "enter" || sequence === "\r") {
    return { kind: "submit" };
  }

  if (sequence === "\n" || (key?.ctrl && key.name === "j")) {
    return { kind: "newline" };
  }

  if (sequence && isPrintable(sequence, key)) {
    return { kind: "text", value: sequence };
  }

  return { kind: "ignore" };
}

function isModifiedEnter(sequence: string | undefined, key: Key | undefined): boolean {
  if (sequence && modifiedEnterSequences.has(sequence)) {
    return true;
  }

  return Boolean((key?.shift || key?.ctrl || key?.meta) && (key.name === "return" || key.name === "enter"));
}

function isPrintable(sequence: string, key: Key | undefined): boolean {
  if (key?.ctrl || key?.meta) {
    return false;
  }

  return !sequence.startsWith("\u001b") && sequence >= " " && sequence !== "\u007f";
}
