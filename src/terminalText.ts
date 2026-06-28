export type WrapOptions = {
  width: number;
  indent?: string;
  subsequentIndent?: string;
};

const defaultWidth = 80;

export function wrapText(text: string, options: WrapOptions): string {
  const width = Math.max(1, Math.floor(options.width || defaultWidth));
  const firstIndent = options.indent ?? "";
  const subsequentIndent = options.subsequentIndent ?? firstIndent;

  return text
    .split(/\r?\n/)
    .flatMap((line) => wrapLine(line, width, firstIndent, subsequentIndent))
    .join("\n");
}

export function wrapTerminalOutput(text: string, width = defaultWidth): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const indent = line.match(/^\s*/)?.[0] ?? "";
      return wrapText(line.trimStart(), { width, indent, subsequentIndent: indent });
    })
    .join("\n");
}

function wrapLine(line: string, width: number, firstIndent: string, subsequentIndent: string): string[] {
  if (line.length === 0) {
    return [firstIndent.trimEnd()];
  }

  const words = line.trim().split(/\s+/);
  const lines: string[] = [];
  let current = firstIndent;

  for (const word of words) {
    const separator = current.trim().length === 0 ? "" : " ";
    if (`${current}${separator}${word}`.length <= width) {
      current += `${separator}${word}`;
      continue;
    }

    if (current.trim().length > 0) {
      lines.push(current);
      current = subsequentIndent;
    }

    const currentWidth = widthForIndent(current, width);
    if (word.length > currentWidth) {
      const chunks = chunkLongWord(word, currentWidth);
      lines.push(...chunks.slice(0, -1).map((chunk) => `${current}${chunk}`));
      current = `${subsequentIndent}${chunks.at(-1) ?? ""}`;
      continue;
    }

    current = `${subsequentIndent}${word}`;
  }

  lines.push(current);
  return lines;
}

function widthForIndent(indent: string, width: number): number {
  return Math.max(1, width - indent.length);
}

function chunkLongWord(word: string, width: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < word.length; index += width) {
    chunks.push(word.slice(index, index + width));
  }
  return chunks;
}
