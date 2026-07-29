import {
  type LogicalLine,
  type NewlineSequence,
  parseLogicalText,
} from "../text/logical-lines.js";

export type ContextDiffErrorCode =
  | "patch_syntax_error"
  | "patch_context_mismatch"
  | "patch_ambiguous"
  | "patch_hunks_out_of_order"
  | "patch_hunks_overlap"
  | "patch_requires_replace";

export type PatchLineKind = "context" | "remove" | "add";
export type PatchLineEnding = "preserve" | "lf" | "crlf" | "cr";

export interface PatchLine {
  kind: PatchLineKind;
  text: string;
}

export interface ContextDiffHunk {
  lines: readonly PatchLine[];
  sourceLines: readonly string[];
  replacementLines: readonly string[];
}

export interface ParsedContextDiff {
  hunks: readonly ContextDiffHunk[];
}

export interface AppliedContextDiff {
  text: string;
  hunksApplied: number;
  linesAdded: number;
  linesRemoved: number;
}

export interface AppliedContextDiffWithSources extends AppliedContextDiff {
  lineSources: readonly (number | null)[];
}

interface LocatedHunk {
  hunk: ContextDiffHunk;
  hunkIndex: number;
  start: number;
  end: number;
  preferredNewline: NewlineSequence;
}

interface OutputLine {
  text: string;
  newline: NewlineSequence | null;
  hunkIndex?: number;
  sourceLineIndex?: number;
}

export class ContextDiffError extends Error {
  readonly code: ContextDiffErrorCode;
  readonly hunkIndex: number | undefined;

  constructor(
    code: ContextDiffErrorCode,
    message: string,
    hunkIndex?: number,
  ) {
    super(message);
    this.name = "ContextDiffError";
    this.code = code;
    this.hunkIndex = hunkIndex;
  }
}

export function parseContextDiff(diff: string): ParsedContextDiff {
  if (diff.length === 0) {
    throw syntaxError("A contextual diff must contain at least one hunk");
  }
  if (diff.includes("\r")) {
    throw syntaxError("A contextual diff must not contain CR");
  }
  if (!diff.endsWith("\n")) {
    throw syntaxError("A contextual diff must end with LF");
  }

  const physicalLines = diff.slice(0, -1).split("\n");
  const hunks: ContextDiffHunk[] = [];
  let currentLines: PatchLine[] | undefined;

  for (const physicalLine of physicalLines) {
    if (physicalLine === "@@") {
      if (currentLines !== undefined) {
        hunks.push(buildHunk(currentLines, hunks.length));
      }
      currentLines = [];
      continue;
    }

    if (physicalLine.startsWith("@@")) {
      throw syntaxError("A hunk header must be exactly @@");
    }
    if (currentLines === undefined) {
      throw syntaxError("Patch content must begin with a @@ hunk header");
    }

    const indicator = physicalLine[0];
    const text = physicalLine.slice(1);
    switch (indicator) {
      case " ":
        currentLines.push({ kind: "context", text });
        break;
      case "-":
        currentLines.push({ kind: "remove", text });
        break;
      case "+":
        currentLines.push({ kind: "add", text });
        break;
      default:
        throw syntaxError(
          "Every hunk body line must begin with space, -, or +",
        );
    }
  }

  if (currentLines === undefined) {
    throw syntaxError("A contextual diff must contain a @@ hunk header");
  }
  hunks.push(buildHunk(currentLines, hunks.length));

  return { hunks };
}

export function applyContextDiff(
  sourceText: string,
  diff: string | ParsedContextDiff,
  lineEnding: PatchLineEnding = "preserve",
): AppliedContextDiff {
  const { lineSources: _lineSources, ...result } =
    applyContextDiffWithSources(sourceText, diff, lineEnding);
  return result;
}

export function applyContextDiffWithSources(
  sourceText: string,
  diff: string | ParsedContextDiff,
  lineEnding: PatchLineEnding = "preserve",
): AppliedContextDiffWithSources {
  const patch = typeof diff === "string" ? parseContextDiff(diff) : diff;
  const source = parseLogicalText(sourceText);
  const preferredFileNewline = dominantNewline(source.lines);
  const located = patch.hunks.map((hunk, hunkIndex) =>
    locateHunk(
      source.lines,
      hunk,
      hunkIndex,
      preferredFileNewline,
    ),
  );

  validateHunkInteraction(located);

  const output: OutputLine[] = [];
  let sourceIndex = 0;
  let linesAdded = 0;
  let linesRemoved = 0;

  for (const locatedHunk of located) {
    appendOriginalRange(output, source.lines, sourceIndex, locatedHunk.start);

    let hunkSourceIndex = locatedHunk.start;
    for (const patchLine of locatedHunk.hunk.lines) {
      switch (patchLine.kind) {
        case "context": {
          const original = source.lines[hunkSourceIndex];
          if (original === undefined) {
            throw new Error("Located hunk exceeded its source range");
          }
          output.push({
            text: original.text,
            newline: original.newline,
            hunkIndex: locatedHunk.hunkIndex,
            sourceLineIndex: hunkSourceIndex,
          });
          hunkSourceIndex += 1;
          break;
        }
        case "remove":
          hunkSourceIndex += 1;
          linesRemoved += 1;
          break;
        case "add":
          output.push({
            text: patchLine.text,
            newline: null,
            hunkIndex: locatedHunk.hunkIndex,
          });
          linesAdded += 1;
          break;
      }
    }

    sourceIndex = locatedHunk.end;
  }

  appendOriginalRange(output, source.lines, sourceIndex, source.lines.length);

  if (output.length === 0) {
    throw new ContextDiffError(
      "patch_requires_replace",
      "A contextual diff cannot produce an empty file; use replace",
    );
  }

  assignOutputNewlines(
    output,
    located,
    lineEnding,
    source.finalNewline,
    preferredFileNewline,
  );

  return {
    text: serializeOutputLines(output),
    hunksApplied: located.length,
    linesAdded,
    linesRemoved,
    lineSources: output.map((line) => line.sourceLineIndex ?? null),
  };
}

function buildHunk(
  lines: readonly PatchLine[],
  hunkIndex: number,
): ContextDiffHunk {
  if (lines.length === 0) {
    throw syntaxError("A hunk must contain at least one body line", hunkIndex);
  }
  if (!lines.some((line) => line.kind === "add" || line.kind === "remove")) {
    throw syntaxError(
      "A hunk must contain at least one changed line",
      hunkIndex,
    );
  }

  const sourceLines = lines
    .filter((line) => line.kind !== "add")
    .map((line) => line.text);
  if (sourceLines.length === 0) {
    throw new ContextDiffError(
      "patch_requires_replace",
      "An addition-only hunk requires a context anchor; use replace",
      hunkIndex,
    );
  }

  return {
    lines: [...lines],
    sourceLines,
    replacementLines: lines
      .filter((line) => line.kind !== "remove")
      .map((line) => line.text),
  };
}

function locateHunk(
  sourceLines: readonly LogicalLine[],
  hunk: ContextDiffHunk,
  hunkIndex: number,
  preferredFileNewline: NewlineSequence,
): LocatedHunk {
  const starts: number[] = [];
  const finalStart = sourceLines.length - hunk.sourceLines.length;

  for (let start = 0; start <= finalStart; start += 1) {
    if (
      hunk.sourceLines.every(
        (text, offset) => sourceLines[start + offset]?.text === text,
      )
    ) {
      starts.push(start);
    }
  }

  if (starts.length === 0) {
    throw new ContextDiffError(
      "patch_context_mismatch",
      `Hunk ${hunkIndex} did not match the original file`,
      hunkIndex,
    );
  }
  if (starts.length > 1) {
    throw new ContextDiffError(
      "patch_ambiguous",
      `Hunk ${hunkIndex} matched more than one location`,
      hunkIndex,
    );
  }

  const start = starts[0] as number;
  const end = start + hunk.sourceLines.length;
  return {
    hunk,
    hunkIndex,
    start,
    end,
    preferredNewline: selectHunkNewline(
      sourceLines,
      hunk,
      start,
      end,
      preferredFileNewline,
    ),
  };
}

function validateHunkInteraction(located: readonly LocatedHunk[]): void {
  for (let index = 1; index < located.length; index += 1) {
    const previous = located[index - 1] as LocatedHunk;
    const current = located[index] as LocatedHunk;

    if (rangesOverlap(previous.start, previous.end, current.start, current.end)) {
      throw new ContextDiffError(
        "patch_hunks_overlap",
        `Hunks ${previous.hunkIndex} and ${current.hunkIndex} overlap`,
        current.hunkIndex,
      );
    }
    if (current.start < previous.start) {
      throw new ContextDiffError(
        "patch_hunks_out_of_order",
        `Hunk ${current.hunkIndex} occurs before the previous hunk`,
        current.hunkIndex,
      );
    }
  }
}

function rangesOverlap(
  leftStart: number,
  leftEnd: number,
  rightStart: number,
  rightEnd: number,
): boolean {
  return leftStart < rightEnd && rightStart < leftEnd;
}

function selectHunkNewline(
  sourceLines: readonly LogicalLine[],
  hunk: ContextDiffHunk,
  start: number,
  end: number,
  preferredFileNewline: NewlineSequence,
): NewlineSequence {
  let sourceOffset = 0;
  for (const line of hunk.lines) {
    if (line.kind === "add") {
      continue;
    }
    const original = sourceLines[start + sourceOffset];
    if (
      line.kind === "remove" &&
      original !== undefined &&
      original.newline !== null
    ) {
      return original.newline;
    }
    sourceOffset += 1;
  }

  const preceding = nearestPrecedingNewline(sourceLines, start);
  if (preceding !== undefined) {
    return preceding;
  }
  const following = nearestFollowingNewline(sourceLines, end);
  return following ?? preferredFileNewline;
}

function nearestPrecedingNewline(
  lines: readonly LogicalLine[],
  start: number,
): NewlineSequence | undefined {
  for (let index = start - 1; index >= 0; index -= 1) {
    const newline = lines[index]?.newline;
    if (newline !== null && newline !== undefined) {
      return newline;
    }
  }
  return undefined;
}

function nearestFollowingNewline(
  lines: readonly LogicalLine[],
  end: number,
): NewlineSequence | undefined {
  for (let index = end; index < lines.length; index += 1) {
    const newline = lines[index]?.newline;
    if (newline !== null && newline !== undefined) {
      return newline;
    }
  }
  return undefined;
}

function dominantNewline(lines: readonly LogicalLine[]): NewlineSequence {
  const counts = new Map<NewlineSequence, { count: number; first: number }>();
  for (const [index, line] of lines.entries()) {
    if (line.newline === null) {
      continue;
    }
    const current = counts.get(line.newline);
    counts.set(line.newline, {
      count: (current?.count ?? 0) + 1,
      first: current?.first ?? index,
    });
  }

  const selected = [...counts.entries()].sort((left, right) => {
    const countDifference = right[1].count - left[1].count;
    return countDifference !== 0
      ? countDifference
      : left[1].first - right[1].first;
  })[0];
  return selected?.[0] ?? "\n";
}

function appendOriginalRange(
  output: OutputLine[],
  source: readonly LogicalLine[],
  start: number,
  end: number,
): void {
  for (let index = start; index < end; index += 1) {
    const line = source[index];
    if (line !== undefined) {
      output.push({
        text: line.text,
        newline: line.newline,
        sourceLineIndex: index,
      });
    }
  }
}

function assignOutputNewlines(
  output: OutputLine[],
  located: readonly LocatedHunk[],
  lineEnding: PatchLineEnding,
  originalFinalNewline: boolean,
  preferredFileNewline: NewlineSequence,
): void {
  const explicit = explicitNewline(lineEnding);
  const lastIndex = output.length - 1;

  for (const [index, line] of output.entries()) {
    const isLast = index === lastIndex;
    if (explicit !== undefined) {
      line.newline = isLast && !originalFinalNewline ? null : explicit;
      continue;
    }

    if (isLast && !originalFinalNewline) {
      line.newline = null;
      continue;
    }
    if (line.newline === null) {
      line.newline =
        line.hunkIndex === undefined
          ? preferredFileNewline
          : (located[line.hunkIndex]?.preferredNewline ?? preferredFileNewline);
    }
  }
}

function explicitNewline(
  lineEnding: PatchLineEnding,
): NewlineSequence | undefined {
  switch (lineEnding) {
    case "preserve":
      return undefined;
    case "lf":
      return "\n";
    case "crlf":
      return "\r\n";
    case "cr":
      return "\r";
  }
}

function serializeOutputLines(lines: readonly OutputLine[]): string {
  return lines.map((line) => `${line.text}${line.newline ?? ""}`).join("");
}

function syntaxError(
  message: string,
  hunkIndex?: number,
): ContextDiffError {
  return new ContextDiffError("patch_syntax_error", message, hunkIndex);
}
