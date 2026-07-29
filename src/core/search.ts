import { readFile } from "node:fs/promises";
import {
  type SearchFacet,
  type ValidatedContentSearchRequest,
  type ValidatedSearchRequest,
  validateSearchRequest,
} from "../contracts/requests.js";
import {
  type Diagnostic,
  type ResultEnvelope,
} from "../contracts/types.js";
import {
  type WorkspaceFile,
  Workspace,
} from "../fs/workspace.js";
import { compileSafeRegex } from "../regex/safe-regex.js";
import { simpleCaseFold } from "../regex/simple-case-folding-17.js";
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

export interface SearchSummaryRecord {
  type: "searchSummary";
  mode: "paths" | "content";
  scanComplete: boolean;
  filesVisited: number;
  filesMatched: number | null;
  filesMatchedAtLeast: number | null;
  filesReturned: number;
  matchUnit?: "logicalLine";
  filesDecoded?: number;
  filesSkipped?: number;
  matchesFound?: number | null;
  matchesFoundAtLeast?: number | null;
  matchesReturned?: number;
}

export interface SearchContextLine {
  line: number;
  text: string;
}

export interface MatchRecord {
  type: "match";
  path: string;
  line: number;
  text: string;
  beforeContext: readonly SearchContextLine[];
  afterContext: readonly SearchContextLine[];
  encoding: CanonicalEncoding;
}

export interface SearchFileRecord {
  type: "file";
  path: string;
  rawBytes: number;
  firstMatchLine?: number;
}

export interface FacetRecord {
  type: "facet";
  facet: SearchFacet;
  value: string;
  files: number;
  matches?: number;
  exact: boolean;
}

export interface FacetRemainderRecord {
  type: "facetRemainder";
  facet: SearchFacet;
  valuesOmitted: number;
  files: number;
  matches?: number;
  exact: boolean;
}

export type SearchResultRecord =
  | SearchSummaryRecord
  | MatchRecord
  | SearchFileRecord
  | FacetRecord
  | FacetRemainderRecord;

export interface SearchCoreOptions {
  legacyFallback?: "windows-31j";
  repositoryEncoding?: (
    path: string,
  ) => CanonicalEncoding | undefined;
}

interface SearchState {
  request: ValidatedSearchRequest;
  records: SearchResultRecord[];
  diagnostics: Diagnostic[];
  diagnosticsOmitted: number;
  reasons: Set<string>;
  filesVisited: number;
  bytesRead: number;
}

interface FacetCount {
  files: number;
  matches: number;
}

export async function executeSearch(
  workspace: Workspace,
  input: unknown,
  options: SearchCoreOptions = {},
): Promise<ResultEnvelope<SearchResultRecord>> {
  const request = validateSearchRequest(input);
  const scan = await workspace.scan({
    include: request.include,
    exclude: request.exclude,
  });
  const state: SearchState = {
    request,
    records: [],
    diagnostics: [],
    diagnosticsOmitted: 0,
    reasons: new Set(),
    filesVisited: 0,
    bytesRead: 0,
  };
  for (const diagnostic of scan.diagnostics) {
    addDiagnostic(state, diagnostic);
    state.reasons.add(diagnostic.code);
  }

  if (request.mode === "paths") {
    executePathSearch(state, scan.files);
  } else {
    await executeContentSearch(state, scan.files, request, options);
  }
  enforceSearchResultByteBudget(state);
  return buildSearchEnvelope(state);
}

function executePathSearch(
  state: SearchState,
  candidates: readonly WorkspaceFile[],
): void {
  const request = state.request;
  if (request.mode !== "paths") {
    throw new Error("Path request expected");
  }
  const visited = candidates.slice(
    0,
    request.effectiveLimits.maxFilesVisited,
  );
  state.filesVisited = visited.length;
  let scanComplete = visited.length === candidates.length;
  if (!scanComplete) {
    state.reasons.add("file_visit_limit");
  }

  let projectionRecords: SearchResultRecord[] = [];
  if (request.projection === "files") {
    const returned = visited.slice(
      0,
      request.effectiveLimits.maxFilesReturned,
    );
    projectionRecords = returned.map((file) => ({
      type: "file",
      path: file.path,
      rawBytes: file.rawBytes,
    }));
    if (returned.length < visited.length) {
      scanComplete = false;
      state.reasons.add("file_result_limit");
    }
  } else if (request.projection === "summary") {
    projectionRecords = buildFacetRecords(
      request.facets,
      visited.map((file) => ({ file, matches: 0 })),
      request.effectiveLimits.maxFacetValues,
      scanComplete && state.diagnostics.length === 0,
      false,
    );
  }

  const exact = scanComplete && state.diagnostics.length === 0;
  const filesReturned = projectionRecords.filter(
    (record) => record.type === "file",
  ).length;
  state.records = [
    {
      type: "searchSummary",
      mode: "paths",
      scanComplete,
      filesVisited: state.filesVisited,
      filesMatched: exact ? visited.length : null,
      filesMatchedAtLeast: exact ? null : visited.length,
      filesReturned,
    },
    ...projectionRecords,
  ];
}

async function executeContentSearch(
  state: SearchState,
  candidates: readonly WorkspaceFile[],
  request: ValidatedContentSearchRequest,
  options: SearchCoreOptions,
): Promise<void> {
  const matchesLine = buildLineMatcher(request);
  const projectionRecords: SearchResultRecord[] = [];
  const matchedForFacets: Array<{ file: WorkspaceFile; matches: number }> = [];
  let scanComplete = true;
  let filesDecoded = 0;
  let filesSkipped = 0;
  let filesMatchedObserved = 0;
  let matchesObserved = 0;
  let matchesExact = true;
  let stopTraversal = false;
  let textCharsReturned = 0;

  for (const file of candidates) {
    if (state.filesVisited >= request.effectiveLimits.maxFilesVisited) {
      scanComplete = false;
      state.reasons.add("file_visit_limit");
      break;
    }
    if (
      state.bytesRead + file.rawBytes >
      request.effectiveLimits.maxSourceBytes
    ) {
      scanComplete = false;
      state.reasons.add("source_byte_limit");
      break;
    }
    state.filesVisited += 1;
    state.bytesRead += file.rawBytes;

    let decoded;
    try {
      const bytes = await readFile(file.absolutePath);
      const repositoryEncoding = options.repositoryEncoding?.(file.path);
      decoded = decodeTextFile(bytes, {
        ...(repositoryEncoding === undefined
          ? {}
          : { repositoryEncoding }),
        ...(options.legacyFallback === undefined
          ? {}
          : { legacyFallback: options.legacyFallback }),
      });
      filesDecoded += 1;
    } catch (error) {
      filesSkipped += 1;
      const diagnostic = searchDiagnostic(file.path, error);
      addDiagnostic(state, diagnostic);
      state.reasons.add(diagnostic.code);
      continue;
    }

    let fileMatches = 0;
    let firstMatchLine: number | undefined;
    for (const line of decoded.logicalText.lines) {
      if (!matchesLine(line.text)) {
        continue;
      }
      fileMatches += 1;
      matchesObserved += 1;
      firstMatchLine ??= line.number;

      if (request.projection === "files") {
        matchesExact = false;
        break;
      }
      if (request.projection !== "matches") {
        continue;
      }
      if (
        fileMatches >
        request.effectiveLimits.maxMatchesPerFile
      ) {
        matchesExact = false;
        state.reasons.add("match_limit");
        break;
      }
      if (
        projectionRecords.filter((record) => record.type === "match").length >=
        request.effectiveLimits.maxMatches
      ) {
        scanComplete = false;
        matchesExact = false;
        state.reasons.add("match_limit");
        stopTraversal = true;
        break;
      }

      const record = buildMatchRecord(
        file.path,
        line,
        decoded.logicalText.lines,
        decoded.encoding,
        request.beforeContext,
        request.afterContext,
      );
      trimMatchToTextBudget(
        record,
        request.effectiveLimits.maxTextCharsReturned - textCharsReturned,
      );
      const recordChars = matchRecordTextChars(record);
      if (recordChars > request.effectiveLimits.maxTextCharsReturned - textCharsReturned) {
        state.reasons.add("text_char_limit");
        scanComplete = false;
        matchesExact = false;
        stopTraversal = true;
        break;
      }
      textCharsReturned += recordChars;
      projectionRecords.push(record);
    }

    if (fileMatches > 0) {
      filesMatchedObserved += 1;
      matchedForFacets.push({ file, matches: fileMatches });
      if (request.projection === "files") {
        if (
          projectionRecords.filter((record) => record.type === "file").length >=
          request.effectiveLimits.maxFilesReturned
        ) {
          state.reasons.add("file_result_limit");
          scanComplete = false;
          stopTraversal = true;
        } else {
          projectionRecords.push({
            type: "file",
            path: file.path,
            rawBytes: file.rawBytes,
            firstMatchLine: firstMatchLine as number,
          });
        }
      }
    }
    if (stopTraversal) {
      break;
    }
  }

  if (request.projection === "summary") {
    projectionRecords.push(
      ...buildFacetRecords(
        request.facets,
        matchedForFacets,
        request.effectiveLimits.maxFacetValues,
        scanComplete && filesSkipped === 0,
        true,
      ),
    );
  }

  const fileTotalsExact = scanComplete && filesSkipped === 0;
  const matchTotalsExact =
    fileTotalsExact &&
    matchesExact &&
    request.projection !== "files";
  const filesReturned = projectionRecords.filter(
    (record) => record.type === "file",
  ).length;
  const matchesReturned = projectionRecords.filter(
    (record) => record.type === "match",
  ).length;
  state.records = [
    {
      type: "searchSummary",
      mode: "content",
      scanComplete,
      matchUnit: "logicalLine",
      filesVisited: state.filesVisited,
      filesDecoded,
      filesSkipped,
      filesMatched: fileTotalsExact ? filesMatchedObserved : null,
      filesMatchedAtLeast: fileTotalsExact ? null : filesMatchedObserved,
      matchesFound: matchTotalsExact ? matchesObserved : null,
      matchesFoundAtLeast: matchTotalsExact ? null : matchesObserved,
      filesReturned,
      matchesReturned,
    },
    ...projectionRecords,
  ];
}

function buildLineMatcher(
  request: ValidatedContentSearchRequest,
): (line: string) => boolean {
  if (request.syntax === "regex") {
    const regex = compileSafeRegex(request.pattern, {
      caseSensitive: request.caseSensitive,
    });
    return (line) => regex.matchesLine(line);
  }
  if (request.caseSensitive) {
    return (line) => line.includes(request.pattern);
  }
  const foldedPattern = simpleCaseFold(request.pattern);
  return (line) => simpleCaseFold(line).includes(foldedPattern);
}

function buildMatchRecord(
  path: string,
  line: LogicalLine,
  lines: readonly LogicalLine[],
  encoding: CanonicalEncoding,
  before: number,
  after: number,
): MatchRecord {
  return {
    type: "match",
    path,
    line: line.number,
    text: line.text,
    beforeContext: lines
      .slice(Math.max(0, line.number - 1 - before), line.number - 1)
      .map((context) => ({ line: context.number, text: context.text })),
    afterContext: lines
      .slice(line.number, line.number + after)
      .map((context) => ({ line: context.number, text: context.text })),
    encoding,
  };
}

function trimMatchToTextBudget(
  record: MatchRecord,
  remaining: number,
): void {
  while (
    matchRecordTextChars(record) > remaining &&
    record.afterContext.length > 0
  ) {
    record.afterContext = record.afterContext.slice(0, -1);
  }
  while (
    matchRecordTextChars(record) > remaining &&
    record.beforeContext.length > 0
  ) {
    record.beforeContext = record.beforeContext.slice(1);
  }
}

function matchRecordTextChars(record: MatchRecord): number {
  return Array.from(record.text).length +
    record.beforeContext.reduce(
      (total, context) => total + Array.from(context.text).length,
      0,
    ) +
    record.afterContext.reduce(
      (total, context) => total + Array.from(context.text).length,
      0,
    );
}

function buildFacetRecords(
  facets: readonly SearchFacet[],
  matched: readonly { file: WorkspaceFile; matches: number }[],
  maximumValues: number,
  exact: boolean,
  content: boolean,
): SearchResultRecord[] {
  const records: SearchResultRecord[] = [];
  for (const facet of facets) {
    const counts = new Map<string, FacetCount>();
    for (const entry of matched) {
      const value = facetValue(facet, entry.file.path);
      const current = counts.get(value) ?? { files: 0, matches: 0 };
      current.files += 1;
      current.matches += entry.matches;
      counts.set(value, current);
    }
    const ordered = [...counts.entries()].sort((left, right) => {
      const countDifference = content
        ? right[1].matches - left[1].matches
        : right[1].files - left[1].files;
      return countDifference !== 0
        ? countDifference
        : compareUnicodeScalars(left[0], right[0]);
    });
    const returned = ordered.slice(0, maximumValues);
    for (const [value, count] of returned) {
      records.push({
        type: "facet",
        facet,
        value,
        files: count.files,
        ...(content ? { matches: count.matches } : {}),
        exact,
      });
    }
    const omitted = ordered.slice(maximumValues);
    if (omitted.length > 0) {
      records.push({
        type: "facetRemainder",
        facet,
        valuesOmitted: omitted.length,
        files: omitted.reduce((sum, entry) => sum + entry[1].files, 0),
        ...(content
          ? {
              matches: omitted.reduce(
                (sum, entry) => sum + entry[1].matches,
                0,
              ),
            }
          : {}),
        exact,
      });
    }
  }
  return records;
}

function facetValue(facet: SearchFacet, path: string): string {
  if (facet === "topLevelPath") {
    const slash = path.indexOf("/");
    return slash === -1 ? "" : path.slice(0, slash);
  }
  const slash = path.lastIndexOf("/");
  const basename = slash === -1 ? path : path.slice(slash + 1);
  const dot = basename.lastIndexOf(".");
  return dot <= 0 ? "" : basename.slice(dot);
}

function enforceSearchResultByteBudget(state: SearchState): void {
  const limit = state.request.effectiveLimits.maxResultBytes;
  while (serializeCanonicalEnvelope(buildSearchEnvelope(state)).byteLength > limit) {
    state.reasons.add("result_byte_limit");
    if (state.records.length > 1) {
      state.records.pop();
      refreshReturnedCounts(state.records[0] as SearchSummaryRecord, state.records);
      continue;
    }
    if (state.diagnostics.length > 0) {
      state.diagnostics.pop();
      state.diagnosticsOmitted += 1;
      continue;
    }
    throw new Error("Minimal SEARCH envelope exceeds maxResultBytes");
  }
}

function refreshReturnedCounts(
  summary: SearchSummaryRecord,
  records: readonly SearchResultRecord[],
): void {
  summary.filesReturned = records.filter(
    (record) => record.type === "file",
  ).length;
  if (summary.mode === "content") {
    summary.matchesReturned = records.filter(
      (record) => record.type === "match",
    ).length;
  }
}

function buildSearchEnvelope(
  state: SearchState,
): ResultEnvelope<SearchResultRecord> {
  const status =
    state.reasons.size === 0
      ? "success"
      : state.records.length > 0
        ? "partial"
        : "failed";
  return createEnvelope({
    operation: "search",
    status,
    completenessReasons: [...state.reasons],
    results: state.records,
    diagnostics: state.diagnostics,
    diagnosticsOmitted: state.diagnosticsOmitted,
    effectiveLimits: state.request.effectiveLimits,
    usage: {
      filesVisited: state.filesVisited,
      bytesRead: state.bytesRead,
    },
  });
}

function addDiagnostic(state: SearchState, diagnostic: Diagnostic): void {
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

function searchDiagnostic(path: string, error: unknown): Diagnostic {
  if (error instanceof TextFileError) {
    return {
      severity: "warning",
      code: error.code,
      message: error.message,
      path,
    };
  }
  return {
    severity: "warning",
    code: "source_error",
    message: error instanceof Error ? error.message : String(error),
    path,
  };
}

function compareUnicodeScalars(left: string, right: string): number {
  const leftScalars = Array.from(left);
  const rightScalars = Array.from(right);
  const length = Math.min(leftScalars.length, rightScalars.length);
  for (let index = 0; index < length; index += 1) {
    const difference =
      (leftScalars[index]?.codePointAt(0) ?? 0) -
      (rightScalars[index]?.codePointAt(0) ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return leftScalars.length - rightScalars.length;
}
