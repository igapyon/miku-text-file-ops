import { readFile } from "node:fs/promises";
import {
  type ReadSelector,
  type ValidatedReadItem,
  type ValidatedReadRequest,
  validateReadRequest,
} from "../contracts/requests.js";
import {
  type Diagnostic,
  type ResultEnvelope,
} from "../contracts/types.js";
import { Workspace } from "../fs/workspace.js";
import {
  createEnvelope,
  serializeCanonicalEnvelope,
} from "../results/envelope.js";
import {
  type CanonicalEncoding,
} from "../text/encoding.js";
import {
  type LogicalLine,
} from "../text/logical-lines.js";
import {
  TextFileError,
  decodeTextFile,
} from "../text/text-file.js";

export interface LineRange {
  startLine: number;
  endLine: number;
}

export interface ReadResultRecord {
  type: "read";
  itemIndex: number;
  path: string;
  requestedSelection: ReadSelector;
  text: string;
  returnedRange?: LineRange;
  remainingRanges: readonly LineRange[];
  revision: string;
  encoding: CanonicalEncoding;
  encodingSource: string;
  bom: boolean;
  lineEnding: string;
  finalNewline: boolean;
  rawBytes: number;
  logicalLines: number;
  completeness: {
    complete: boolean;
    reasons: readonly string[];
  };
}

export interface ReadCoreOptions {
  legacyFallback?: "windows-31j";
  repositoryEncoding?: (
    path: string,
  ) => CanonicalEncoding | undefined;
}

interface ReadWork {
  record: ReadResultRecord;
  lines: readonly LogicalLine[];
  domain: LineRange | undefined;
  direction: "prefix" | "suffix";
  returned: LineRange | undefined;
}

interface ReadState {
  request: ValidatedReadRequest;
  works: ReadWork[];
  diagnostics: Diagnostic[];
  diagnosticsOmitted: number;
  reasons: Set<string>;
  itemsProcessed: number;
  itemsSkipped: number;
  nextItemIndex: number | undefined;
}

export async function executeRead(
  workspace: Workspace,
  input: unknown,
  options: ReadCoreOptions = {},
): Promise<ResultEnvelope<ReadResultRecord>> {
  const request = validateReadRequest(input);
  const state: ReadState = {
    request,
    works: [],
    diagnostics: [],
    diagnosticsOmitted: 0,
    reasons: new Set(),
    itemsProcessed: 0,
    itemsSkipped: 0,
    nextItemIndex: undefined,
  };
  const maximumItems = request.effectiveLimits.maxItems;
  const processCount = Math.min(request.items.length, maximumItems);
  if (request.items.length > processCount) {
    state.reasons.add("item_limit");
    state.itemsSkipped += request.items.length - processCount;
    state.nextItemIndex = processCount;
  }

  let textCharsRemaining = request.effectiveLimits.maxTextCharsReturned;
  for (let itemIndex = 0; itemIndex < processCount; itemIndex += 1) {
    if (textCharsRemaining === 0) {
      state.reasons.add("text_char_limit");
      state.itemsSkipped += processCount - itemIndex;
      state.nextItemIndex ??= itemIndex;
      break;
    }

    const item = request.items[itemIndex] as ValidatedReadItem;
    try {
      const absolutePath = await workspace.resolveExistingFile(item.path);
      const bytes = await readFile(absolutePath);
      const repositoryEncoding = options.repositoryEncoding?.(item.path);
      const decoded = decodeTextFile(bytes, {
        ...(item.encoding === undefined
          ? {}
          : { explicitEncoding: item.encoding }),
        ...(repositoryEncoding === undefined
          ? {}
          : { repositoryEncoding }),
        ...(options.legacyFallback === undefined
          ? {}
          : { legacyFallback: options.legacyFallback }),
      });
      const work = buildReadWork(
        item,
        itemIndex,
        decoded,
        request.effectiveLimits.maxLinesPerItem,
        textCharsRemaining,
        state,
      );
      state.works.push(work);
      state.itemsProcessed += 1;
      textCharsRemaining -= Array.from(work.record.text).length;
    } catch (error) {
      const diagnostic = readDiagnostic(item.path, error);
      addDiagnostic(state, diagnostic);
      state.reasons.add(diagnostic.code);
      state.itemsSkipped += 1;
    }
  }

  enforceResultByteBudget(state);
  return buildEnvelope(state);
}

function buildReadWork(
  item: ValidatedReadItem,
  itemIndex: number,
  decoded: ReturnType<typeof decodeTextFile>,
  maxLines: number,
  textCharsRemaining: number,
  state: ReadState,
): ReadWork {
  const domain = selectedDomain(item.selector, decoded.logicalLines);
  const direction = "lastLines" in item.selector ? "suffix" : "prefix";
  const itemReasons = new Set<string>();
  let returned = domain === undefined ? undefined : { ...domain };

  if (
    returned !== undefined &&
    rangeLength(returned) > maxLines
  ) {
    itemReasons.add("line_limit");
    state.reasons.add("line_limit");
    returned =
      direction === "prefix"
        ? {
            startLine: returned.startLine,
            endLine: returned.startLine + maxLines - 1,
          }
        : {
            startLine: returned.endLine - maxLines + 1,
            endLine: returned.endLine,
          };
  }

  if (returned !== undefined) {
    returned = fitTextCharacterBudget(
      decoded.logicalText.lines,
      returned,
      direction,
      textCharsRemaining,
      decoded,
      item,
      itemReasons,
      state,
    );
  }

  const record: ReadResultRecord = {
    type: "read",
    itemIndex,
    path: item.path,
    requestedSelection: item.selector,
    text: renderLines(decoded.logicalText.lines, returned),
    ...(returned === undefined ? {} : { returnedRange: returned }),
    remainingRanges: remainingRanges(domain, returned),
    revision: decoded.revision,
    encoding: decoded.encoding,
    encodingSource: decoded.encodingSource,
    bom: decoded.bom,
    lineEnding: decoded.lineEnding,
    finalNewline: decoded.finalNewline,
    rawBytes: decoded.rawBytes,
    logicalLines: decoded.logicalLines,
    completeness: {
      complete: itemReasons.size === 0,
      reasons: [...itemReasons].sort(),
    },
  };
  return {
    record,
    lines: decoded.logicalText.lines,
    domain,
    direction,
    returned,
  };
}

function fitTextCharacterBudget(
  lines: readonly LogicalLine[],
  requested: LineRange,
  direction: "prefix" | "suffix",
  remaining: number,
  decoded: ReturnType<typeof decodeTextFile>,
  item: ValidatedReadItem,
  itemReasons: Set<string>,
  state: ReadState,
): LineRange | undefined {
  let used = 0;
  let accepted = 0;
  const indexes =
    direction === "prefix"
      ? sequence(requested.startLine, requested.endLine, 1)
      : sequence(requested.endLine, requested.startLine, -1);

  for (const lineNumber of indexes) {
    const line = lines[lineNumber - 1] as LogicalLine;
    const chars = Array.from(
      `${line.text}${line.newline === null ? "" : "\n"}`,
    ).length;
    if (used + chars > remaining) {
      if (
        accepted === 0 &&
        chars > state.request.effectiveLimits.maxTextCharsReturned
      ) {
        itemReasons.add("line_too_large");
        state.reasons.add("line_too_large");
        addDiagnostic(state, {
          severity: "warning",
          code: "line_too_large",
          message: `Logical line ${lineNumber} cannot fit the text budget`,
          path: item.path,
          line: lineNumber,
          details: {
            textChars: chars,
            encoding: decoded.encoding,
          },
        });
      } else {
        itemReasons.add("text_char_limit");
        state.reasons.add("text_char_limit");
      }
      break;
    }
    used += chars;
    accepted += 1;
  }

  if (accepted === 0) {
    return undefined;
  }
  return direction === "prefix"
    ? {
        startLine: requested.startLine,
        endLine: requested.startLine + accepted - 1,
      }
    : {
        startLine: requested.endLine - accepted + 1,
        endLine: requested.endLine,
      };
}

function enforceResultByteBudget(state: ReadState): void {
  const limit = state.request.effectiveLimits.maxResultBytes;
  while (serializeCanonicalEnvelope(buildEnvelope(state)).byteLength > limit) {
    state.reasons.add("result_byte_limit");
    const work = [...state.works]
      .reverse()
      .find((candidate) => candidate.returned !== undefined);
    if (work !== undefined) {
      trimReturnedRange(work);
      continue;
    }
    if (state.works.length > 0) {
      const removed = state.works.pop() as ReadWork;
      state.itemsProcessed -= 1;
      state.itemsSkipped += 1;
      state.nextItemIndex =
        state.nextItemIndex === undefined
          ? removed.record.itemIndex
          : Math.min(state.nextItemIndex, removed.record.itemIndex);
      continue;
    }
    if (state.diagnostics.length > 0) {
      state.diagnostics.pop();
      state.diagnosticsOmitted += 1;
      continue;
    }
    throw new Error("Minimal READ envelope exceeds maxResultBytes");
  }
}

function trimReturnedRange(work: ReadWork): void {
  const returned = work.returned as LineRange;
  if (returned.startLine === returned.endLine) {
    work.returned = undefined;
    delete work.record.returnedRange;
  } else if (work.direction === "prefix") {
    work.returned = {
      startLine: returned.startLine,
      endLine: returned.endLine - 1,
    };
    work.record.returnedRange = work.returned;
  } else {
    work.returned = {
      startLine: returned.startLine + 1,
      endLine: returned.endLine,
    };
    work.record.returnedRange = work.returned;
  }
  work.record.text = renderLines(work.lines, work.returned);
  work.record.remainingRanges = remainingRanges(work.domain, work.returned);
  work.record.completeness = {
    complete: false,
    reasons: [...new Set([
      ...work.record.completeness.reasons,
      "result_byte_limit",
    ])].sort(),
  };
}

function buildEnvelope(
  state: ReadState,
): ResultEnvelope<ReadResultRecord> {
  const records = state.works.map((work) => work.record);
  const status =
    state.reasons.size === 0
      ? "success"
      : records.length > 0
        ? "partial"
        : "failed";
  return createEnvelope({
    operation: "read",
    status,
    completenessReasons: [...state.reasons],
    results: records,
    diagnostics: state.diagnostics,
    diagnosticsOmitted: state.diagnosticsOmitted,
    effectiveLimits: state.request.effectiveLimits,
    usage: {
      itemsRequested: state.request.items.length,
      itemsProcessed: state.itemsProcessed,
      itemsSkipped: state.itemsSkipped,
      ...(state.nextItemIndex === undefined
        ? {}
        : { nextItemIndex: state.nextItemIndex }),
    },
  });
}

function selectedDomain(
  selector: ReadSelector,
  logicalLines: number,
): LineRange | undefined {
  if (logicalLines === 0) {
    return undefined;
  }
  if ("full" in selector) {
    return { startLine: 1, endLine: logicalLines };
  }
  if ("range" in selector) {
    if (selector.range.startLine > logicalLines) {
      return undefined;
    }
    return {
      startLine: selector.range.startLine,
      endLine: Math.min(selector.range.endLine, logicalLines),
    };
  }
  if ("firstLines" in selector) {
    return {
      startLine: 1,
      endLine: Math.min(selector.firstLines, logicalLines),
    };
  }
  return {
    startLine: Math.max(1, logicalLines - selector.lastLines + 1),
    endLine: logicalLines,
  };
}

function remainingRanges(
  domain: LineRange | undefined,
  returned: LineRange | undefined,
): readonly LineRange[] {
  if (domain === undefined) {
    return [];
  }
  if (returned === undefined) {
    return [domain];
  }
  const ranges: LineRange[] = [];
  if (domain.startLine < returned.startLine) {
    ranges.push({
      startLine: domain.startLine,
      endLine: returned.startLine - 1,
    });
  }
  if (returned.endLine < domain.endLine) {
    ranges.push({
      startLine: returned.endLine + 1,
      endLine: domain.endLine,
    });
  }
  return ranges;
}

function renderLines(
  lines: readonly LogicalLine[],
  range: LineRange | undefined,
): string {
  if (range === undefined) {
    return "";
  }
  return lines
    .slice(range.startLine - 1, range.endLine)
    .map((line) => `${line.text}${line.newline === null ? "" : "\n"}`)
    .join("");
}

function sequence(start: number, end: number, step: 1 | -1): number[] {
  const values: number[] = [];
  for (
    let value = start;
    step === 1 ? value <= end : value >= end;
    value += step
  ) {
    values.push(value);
  }
  return values;
}

function rangeLength(range: LineRange): number {
  return range.endLine - range.startLine + 1;
}

function addDiagnostic(state: ReadState, diagnostic: Diagnostic): void {
  if (
    state.diagnostics.length <
    state.request.effectiveLimits.maxDiagnostics
  ) {
    state.diagnostics.push(diagnostic);
  } else {
    state.diagnosticsOmitted += 1;
    state.reasons.add("diagnostic_limit");
  }
}

function readDiagnostic(path: string, error: unknown): Diagnostic {
  if (error instanceof TextFileError) {
    return {
      severity: "error",
      code: error.code,
      message: error.message,
      path,
      ...(error.encoding === undefined
        ? {}
        : { details: { encoding: error.encoding } }),
    };
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return {
      severity: "error",
      code: error.code,
      message: error instanceof Error ? error.message : String(error),
      path,
    };
  }
  return {
    severity: "error",
    code: "source_error",
    message: error instanceof Error ? error.message : String(error),
    path,
  };
}
