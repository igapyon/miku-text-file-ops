import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  type LineEndingChoice,
  type UpdateLineEndingChoice,
  type ValidatedUpdateRequest,
  validateCreateRequest,
  validateDeleteRequest,
  validateUpdateRequest,
} from "../contracts/requests.js";
import { Workspace } from "../fs/workspace.js";
import {
  type AppliedContextDiffWithSources,
  applyContextDiffWithSources,
} from "../patch/context-diff.js";
import {
  type CanonicalEncoding,
  encodeStrict,
} from "../text/encoding.js";
import {
  type LogicalText,
  type NewlineSequence,
  parseLogicalText,
} from "../text/logical-lines.js";
import {
  decodeTextFile,
  rawByteRevision,
} from "../text/text-file.js";

export type MutationErrorCode =
  | "stale_revision"
  | "encode_error"
  | "target_exists"
  | "target_missing"
  | "unsupported_change";

export class MutationError extends Error {
  readonly code: MutationErrorCode;

  constructor(code: MutationErrorCode, message: string) {
    super(message);
    this.name = "MutationError";
    this.code = code;
  }
}

export interface CreateResult {
  path: string;
  revision: string;
  encoding: CanonicalEncoding;
  lineEnding: LineEndingChoice;
  bom: boolean;
  writtenBytes: number;
}

export interface UpdateResult {
  path: string;
  oldRevision: string;
  newRevision: string;
  encoding: CanonicalEncoding;
  lineEnding: string;
  bom: boolean;
  appliedHunks: number;
  addedLines: number;
  removedLines: number;
  writtenBytes: number;
}

export interface DeleteResult {
  path: string;
  oldRevision: string;
}

export interface MutationCoreOptions {
  legacyFallback?: "windows-31j";
  repositoryEncoding?: (
    path: string,
  ) => CanonicalEncoding | undefined;
}

export async function executeCreate(
  workspace: Workspace,
  input: unknown,
): Promise<CreateResult> {
  const request = validateCreateRequest(input);
  const target = await workspace.resolveCreateTarget(request.path);
  const formatted = normalizeLineEndings(
    request.content,
    request.writeAs.lineEnding,
  );
  const bytes = encodeWithBom(
    formatted,
    request.writeAs.encoding,
    request.writeAs.bom,
  );

  let handle;
  try {
    handle = await open(target, "wx");
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    if (isNodeCode(error, "EEXIST")) {
      throw new MutationError("target_exists", "Create target already exists");
    }
    throw error;
  } finally {
    await handle?.close();
  }

  return {
    path: request.path,
    revision: rawByteRevision(bytes),
    encoding: request.writeAs.encoding,
    lineEnding: request.writeAs.lineEnding,
    bom: request.writeAs.bom,
    writtenBytes: bytes.byteLength,
  };
}

export async function executeUpdate(
  workspace: Workspace,
  input: unknown,
  options: MutationCoreOptions = {},
): Promise<UpdateResult> {
  const request = validateUpdateRequest(input);
  const target = await workspace.resolveExistingFile(request.path);
  const originalBytes = await readFile(target);
  const oldRevision = rawByteRevision(originalBytes);
  assertRevision(request.expectedRevision, oldRevision);
  const repositoryEncoding = options.repositoryEncoding?.(request.path);
  const decoded = decodeTextFile(originalBytes, {
    ...(repositoryEncoding === undefined ? {} : { repositoryEncoding }),
    ...(options.legacyFallback === undefined
      ? {}
      : { legacyFallback: options.legacyFallback }),
  });

  let resultText = decoded.text;
  let appliedHunks = 0;
  let addedLines = 0;
  let removedLines = 0;
  let appliedContextDiff: AppliedContextDiffWithSources | undefined;
  if (request.change.type === "context-diff") {
    const applied = applyContextDiffWithSources(
      decoded.text,
      request.change.diff,
      request.writeAs.lineEnding,
    );
    appliedContextDiff = applied;
    resultText = applied.text;
    appliedHunks = applied.hunksApplied;
    addedLines = applied.linesAdded;
    removedLines = applied.linesRemoved;
  } else if (request.change.type === "replace") {
    const originalLogical = parseLogicalText(decoded.text);
    const replacementLogical = parseLogicalText(request.change.content);
    resultText = formatReplacement(
      originalLogical,
      replacementLogical,
      request.writeAs.lineEnding,
    );
    addedLines = replacementLogical.lines.length;
    removedLines = originalLogical.lines.length;
  } else if (request.writeAs.lineEnding !== "preserve") {
    resultText = normalizeLineEndings(
      decoded.text,
      request.writeAs.lineEnding,
    );
  }

  const encoding =
    request.writeAs.encoding === "preserve"
      ? decoded.encoding
      : request.writeAs.encoding;
  const bom =
    request.writeAs.bom === "preserve"
      ? decoded.bom
      : request.writeAs.bom;
  const newBytes =
    appliedContextDiff !== undefined &&
    request.writeAs.encoding === "preserve" &&
    request.writeAs.lineEnding === "preserve"
      ? encodeContextDiffPreservingSourceBytes(
          originalBytes,
          decoded,
          appliedContextDiff,
          bom,
        )
      : encodeWithBom(resultText, encoding, bom);
  const status = await lstat(target);
  await atomicRevisionGuardedReplace(
    target,
    request.expectedRevision,
    newBytes,
    status.mode,
  );

  return {
    path: request.path,
    oldRevision,
    newRevision: rawByteRevision(newBytes),
    encoding,
    lineEnding:
      request.writeAs.lineEnding === "preserve"
        ? parseLogicalText(resultText).lineEnding
        : request.writeAs.lineEnding,
    bom,
    appliedHunks,
    addedLines,
    removedLines,
    writtenBytes: newBytes.byteLength,
  };
}

export async function executeDelete(
  workspace: Workspace,
  input: unknown,
): Promise<DeleteResult> {
  const request = validateDeleteRequest(input);
  const target = await workspace.resolveExistingFile(request.path);
  const observed = await readFile(target);
  const oldRevision = rawByteRevision(observed);
  assertRevision(request.expectedRevision, oldRevision);

  const rechecked = await readFile(target);
  assertRevision(request.expectedRevision, rawByteRevision(rechecked));
  await unlink(target);
  return { path: request.path, oldRevision };
}

export function normalizeLineEndings(
  text: string,
  lineEnding: LineEndingChoice,
): string {
  const newline = newlineSequence(lineEnding);
  return parseLogicalText(text).lines
    .map((line) => `${line.text}${line.newline === null ? "" : newline}`)
    .join("");
}

export function formatReplacement(
  original: LogicalText,
  replacement: LogicalText,
  lineEnding: UpdateLineEndingChoice,
): string {
  if (lineEnding !== "preserve") {
    const newline = newlineSequence(lineEnding);
    return joinLogicalLines(replacement, () => newline);
  }

  const originalNewlines = original.lines.flatMap((line) =>
    line.newline === null ? [] : [line.newline],
  );
  const fallback = dominantNewline(originalNewlines);

  if (original.lineEnding !== "mixed") {
    return joinLogicalLines(replacement, () => fallback);
  }

  return joinLogicalLines(
    replacement,
    (index) => original.lines[index]?.newline ?? fallback,
  );
}

export function encodeWithBom(
  text: string,
  encoding: CanonicalEncoding,
  bom: boolean,
): Uint8Array {
  if (bom && encoding === "windows-31j") {
    throw new MutationError(
      "encode_error",
      "windows-31j does not support a BOM",
    );
  }
  const encoded = encodeStrict(text, encoding);
  if (!bom) {
    return encoded;
  }
  const prefix =
    encoding === "utf-8"
      ? [0xef, 0xbb, 0xbf]
      : encoding === "utf-16le"
        ? [0xff, 0xfe]
        : [0xfe, 0xff];
  return Uint8Array.from([...prefix, ...encoded]);
}

function encodeContextDiffPreservingSourceBytes(
  originalBytes: Uint8Array,
  decoded: ReturnType<typeof decodeTextFile>,
  applied: AppliedContextDiffWithSources,
  bom: boolean,
): Uint8Array {
  const bodyOffset = decoded.bom
    ? decoded.encoding === "utf-8"
      ? 3
      : 2
    : 0;
  const sourceLines = splitEncodedLogicalLines(
    originalBytes.subarray(bodyOffset),
    decoded.encoding,
  );
  const outputLines = parseLogicalText(applied.text).lines;
  if (
    sourceLines.length !== decoded.logicalText.lines.length ||
    outputLines.length !== applied.lineSources.length
  ) {
    return encodeWithBom(applied.text, decoded.encoding, bom);
  }

  const chunks = outputLines.map((line, index) => {
    const sourceIndex = applied.lineSources[index];
    if (sourceIndex !== null && sourceIndex !== undefined) {
      const sourceLine = decoded.logicalText.lines[sourceIndex];
      if (
        sourceLine?.text === line.text &&
        sourceLine.newline === line.newline
      ) {
        return sourceLines[sourceIndex] as Uint8Array;
      }
    }
    return encodeStrict(
      `${line.text}${line.newline ?? ""}`,
      decoded.encoding,
    );
  });
  const prefix = bom
    ? decoded.encoding === "utf-8"
      ? Uint8Array.from([0xef, 0xbb, 0xbf])
      : decoded.encoding === "utf-16le"
        ? Uint8Array.from([0xff, 0xfe])
        : decoded.encoding === "utf-16be"
          ? Uint8Array.from([0xfe, 0xff])
          : (() => {
              throw new MutationError(
                "encode_error",
                "windows-31j does not support a BOM",
              );
            })()
    : new Uint8Array();
  return concatenateBytes([prefix, ...chunks]);
}

function splitEncodedLogicalLines(
  bytes: Uint8Array,
  encoding: CanonicalEncoding,
): readonly Uint8Array[] {
  const width =
    encoding === "utf-16le" || encoding === "utf-16be" ? 2 : 1;
  const codeUnitAt = (offset: number): number => {
    if (width === 1) return bytes[offset] as number;
    return encoding === "utf-16be"
      ? ((bytes[offset] as number) << 8) | (bytes[offset + 1] as number)
      : (bytes[offset] as number) | ((bytes[offset + 1] as number) << 8);
  };

  const lines: Uint8Array[] = [];
  let start = 0;
  for (let offset = 0; offset < bytes.length; offset += width) {
    const unit = codeUnitAt(offset);
    if (unit !== 0x0a && unit !== 0x0d) continue;
    let end = offset + width;
    if (
      unit === 0x0d &&
      end < bytes.length &&
      codeUnitAt(end) === 0x0a
    ) {
      end += width;
      offset += width;
    }
    lines.push(bytes.subarray(start, end));
    start = end;
  }
  if (start < bytes.length) {
    lines.push(bytes.subarray(start));
  }
  return lines;
}

function concatenateBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    chunks.reduce((total, chunk) => total + chunk.byteLength, 0),
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function joinLogicalLines(
  logicalText: LogicalText,
  selectNewline: (index: number) => NewlineSequence,
): string {
  return logicalText.lines
    .map((line, index) =>
      `${line.text}${line.newline === null ? "" : selectNewline(index)}`,
    )
    .join("");
}

function dominantNewline(
  newlines: readonly NewlineSequence[],
): NewlineSequence {
  if (newlines.length === 0) {
    return "\n";
  }

  const counts = new Map<NewlineSequence, number>();
  for (const newline of newlines) {
    counts.set(newline, (counts.get(newline) ?? 0) + 1);
  }
  const maximum = Math.max(...counts.values());
  return newlines.find((newline) => counts.get(newline) === maximum) ?? "\n";
}

async function atomicRevisionGuardedReplace(
  target: string,
  expectedRevision: string,
  bytes: Uint8Array,
  mode: number,
): Promise<void> {
  const temporary = join(
    dirname(target),
    `.${basename(target)}.miku-text-file-ops-${process.pid}-${randomUUID()}.tmp`,
  );
  let handle;
  let renamed = false;
  try {
    handle = await open(temporary, "wx", mode & 0o7777);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, mode & 0o7777);

    const rechecked = await readFile(target);
    assertRevision(expectedRevision, rawByteRevision(rechecked));
    await rename(temporary, target);
    renamed = true;
  } finally {
    await handle?.close();
    if (!renamed) {
      try {
        await unlink(temporary);
      } catch (error) {
        if (!isNodeCode(error, "ENOENT")) {
          throw error;
        }
      }
    }
  }
}

function assertRevision(expected: string, actual: string): void {
  if (expected !== actual) {
    throw new MutationError(
      "stale_revision",
      `Expected revision ${expected}, observed ${actual}`,
    );
  }
}

function newlineSequence(
  lineEnding: Exclude<UpdateLineEndingChoice, "preserve">,
): "\n" | "\r\n" | "\r" {
  switch (lineEnding) {
    case "lf":
      return "\n";
    case "crlf":
      return "\r\n";
    case "cr":
      return "\r";
  }
}

function isNodeCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
