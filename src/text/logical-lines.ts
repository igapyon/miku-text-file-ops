export type NewlineSequence = "\n" | "\r\n" | "\r";
export type LineEndingShape = "none" | "lf" | "crlf" | "cr" | "mixed";

export interface LogicalLine {
  number: number;
  text: string;
  newline: NewlineSequence | null;
}

export interface LogicalText {
  lines: readonly LogicalLine[];
  lineEnding: LineEndingShape;
  finalNewline: boolean;
}

export function parseLogicalText(text: string): LogicalText {
  const lines: LogicalLine[] = [];
  const newlineKinds = new Set<NewlineSequence>();
  let lineStart = 0;
  let lineNumber = 1;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (character !== "\r" && character !== "\n") {
      continue;
    }

    let newline: NewlineSequence;
    if (character === "\r" && text[index + 1] === "\n") {
      newline = "\r\n";
      index += 1;
    } else {
      newline = character;
    }

    const newlineStart = newline === "\r\n" ? index - 1 : index;
    lines.push({
      number: lineNumber,
      text: text.slice(lineStart, newlineStart),
      newline,
    });
    newlineKinds.add(newline);
    lineNumber += 1;
    lineStart = index + 1;
  }

  if (lineStart < text.length) {
    lines.push({
      number: lineNumber,
      text: text.slice(lineStart),
      newline: null,
    });
  }

  return {
    lines,
    lineEnding: classifyLineEnding(newlineKinds),
    finalNewline: text.length > 0 && lineStart === text.length,
  };
}

export function agentFacingText(logicalText: LogicalText): string {
  return logicalText.lines
    .map((line) => `${line.text}${line.newline === null ? "" : "\n"}`)
    .join("");
}

function classifyLineEnding(
  newlineKinds: ReadonlySet<NewlineSequence>,
): LineEndingShape {
  if (newlineKinds.size === 0) {
    return "none";
  }
  if (newlineKinds.size > 1) {
    return "mixed";
  }

  const only = newlineKinds.values().next().value;
  switch (only) {
    case "\n":
      return "lf";
    case "\r\n":
      return "crlf";
    case "\r":
      return "cr";
    default:
      throw new Error("Unreachable newline classification");
  }
}
