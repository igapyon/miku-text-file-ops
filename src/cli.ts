import { resolve } from "node:path";
import {
  applyLimitCeilings,
  RequestValidationError,
  validateLimits,
} from "./contracts/validation.js";
import {
  loadRepositoryTextPolicy,
} from "./config/repository-policy.js";
import {
  validateCreateRequest,
  validateDeleteRequest,
  validateReadRequest,
  validateSearchRequest,
  validateUpdateRequest,
} from "./contracts/requests.js";
import {
  AGENT_V1_LIMITS,
  type Diagnostic,
  type Operation,
  type ResultEnvelope,
  effectiveAgentV1Limits,
} from "./contracts/types.js";
import {
  executeCreate,
  executeDelete,
  executeUpdate,
} from "./core/mutate.js";
import { executeRead } from "./core/read.js";
import { executeSearch } from "./core/search.js";
import { Workspace } from "./fs/workspace.js";
import { renderHelp } from "./help.js";
import { PRODUCT_VERSION } from "./metadata.js";
import { ContextDiffError } from "./patch/context-diff.js";
import { SafeRegexError } from "./regex/safe-regex.js";
import {
  createEnvelope,
  serializeCanonicalEnvelope,
} from "./results/envelope.js";
import {
  TextDecodingError,
  TextEncodingError,
  decodeStrict,
} from "./text/encoding.js";
import { parseLogicalText } from "./text/logical-lines.js";

export const CLI_EXIT = {
  success: 0,
  partial: 1,
  requestError: 2,
  runtimeError: 3,
} as const;

export interface CliExecution {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

interface ParsedArguments {
  operation: Operation;
  root: string;
  json: boolean;
}

class CliRequestError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CliRequestError";
    this.code = code;
  }
}

export async function executeCli(
  args: readonly string[],
  stdin: Uint8Array,
  cwd: string,
): Promise<CliExecution> {
  const metadata = metadataExecution(args);
  if (metadata !== undefined) {
    return metadata;
  }

  let parsed: ParsedArguments;
  try {
    parsed = parseArguments(args, cwd);
  } catch (error) {
    return unstructuredCliFailure(error);
  }

  let request: unknown;
  try {
    request = parseRequest(stdin);
  } catch (error) {
    return renderFailure(parsed, error, true);
  }

  try {
    validateOperationRequest(parsed.operation, request);
  } catch (error) {
    return renderFailure(parsed, error, isRequestFailure(error), request);
  }

  try {
    const workspace = await Workspace.open(parsed.root);
    const policy = await loadRepositoryTextPolicy(workspace);
    const envelope = await dispatch(
      parsed.operation,
      workspace,
      request,
      policy,
    );
    return renderExecution(parsed, envelope, exitForEnvelope(envelope));
  } catch (error) {
    return renderFailure(
      parsed,
      error,
      isRequestFailure(error),
      request,
    );
  }
}

function validateOperationRequest(
  operation: Operation,
  request: unknown,
): void {
  switch (operation) {
    case "search":
      validateSearchRequest(request);
      return;
    case "read":
      validateReadRequest(request);
      return;
    case "create":
      validateCreateRequest(request);
      return;
    case "update":
      validateUpdateRequest(request);
      return;
    case "delete":
      validateDeleteRequest(request);
      return;
  }
}

function metadataExecution(
  args: readonly string[],
): CliExecution | undefined {
  if (args.length !== 1) {
    return undefined;
  }
  if (args[0] === "--version") {
    return successfulText(`${PRODUCT_VERSION}\n`);
  }
  if (args[0] === "--help" || args[0] === "-h") {
    return successfulText(renderHelp());
  }
  return undefined;
}

function successfulText(text: string): CliExecution {
  return {
    exitCode: CLI_EXIT.success,
    stdout: Buffer.from(text, "utf8"),
    stderr: new Uint8Array(),
  };
}

function parseArguments(
  args: readonly string[],
  cwd: string,
): ParsedArguments {
  let operation: Operation | undefined;
  let root = cwd;
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] as string;
    if (argument === "--json") {
      if (json) {
        throw new CliRequestError(
          "duplicate_option",
          "--json may be supplied only once",
        );
      }
      json = true;
      continue;
    }
    if (argument === "--root") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new CliRequestError(
          "missing_option_value",
          "--root requires a path",
        );
      }
      root = resolve(cwd, value);
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new CliRequestError(
        "unknown_option",
        `Unknown CLI option: ${argument}`,
      );
    }
    if (!isOperation(argument)) {
      throw new CliRequestError(
        "unknown_command",
        `Unknown CLI command: ${argument}`,
      );
    }
    if (operation !== undefined) {
      throw new CliRequestError(
        "multiple_commands",
        "Exactly one operation command is required",
      );
    }
    operation = argument;
  }

  if (operation === undefined) {
    throw new CliRequestError(
      "missing_command",
      "One operation command is required",
    );
  }
  return { operation, root, json };
}

function parseRequest(stdin: Uint8Array): unknown {
  if (stdin.byteLength === 0) {
    throw new CliRequestError(
      "empty_request",
      "Standard input must contain one JSON request object",
    );
  }
  if (
    stdin[0] === 0xef &&
    stdin[1] === 0xbb &&
    stdin[2] === 0xbf
  ) {
    throw new CliRequestError(
      "json_bom_not_allowed",
      "The JSON request must not contain a UTF-8 BOM",
    );
  }

  let text: string;
  try {
    text = decodeStrict(stdin, "utf-8");
  } catch (error) {
    throw new CliRequestError(
      "invalid_utf8",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (text.trim().length === 0) {
    throw new CliRequestError(
      "empty_request",
      "Standard input must contain one JSON request object",
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CliRequestError(
      "invalid_json",
      "Standard input must contain exactly one valid JSON document",
    );
  }
}

async function dispatch(
  operation: Operation,
  workspace: Workspace,
  request: unknown,
  policy: Awaited<ReturnType<typeof loadRepositoryTextPolicy>>,
): Promise<ResultEnvelope<object>> {
  const coreOptions = {
    repositoryEncoding: policy.repositoryEncoding,
    limitCeilings: AGENT_V1_LIMITS,
    ...(policy.legacyFallback === undefined
      ? {}
      : { legacyFallback: policy.legacyFallback }),
  };
  switch (operation) {
    case "search":
      return executeSearch(workspace, request, coreOptions);
    case "read":
      return executeRead(workspace, request, coreOptions);
    case "create": {
      const result = await executeCreate(workspace, request);
      return mutationEnvelope(operation, { type: operation, ...result });
    }
    case "update": {
      const result = await executeUpdate(workspace, request, coreOptions);
      return mutationEnvelope(operation, { type: operation, ...result });
    }
    case "delete": {
      const result = await executeDelete(workspace, request);
      return mutationEnvelope(operation, { type: operation, ...result });
    }
  }
}

function mutationEnvelope(
  operation: "create" | "update" | "delete",
  result: object,
): ResultEnvelope<object> {
  return createEnvelope({
    operation,
    status: "success",
    results: [result],
    effectiveLimits: effectiveAgentV1Limits(),
  });
}

function renderFailure(
  parsed: ParsedArguments,
  error: unknown,
  requestError: boolean,
  request?: unknown,
): CliExecution {
  const allDiagnostics =
    error instanceof RequestValidationError
      ? error.diagnostics
      : [diagnosticFromError(error)];
  const effectiveLimits = failureEffectiveLimits(parsed.operation, request);
  const diagnostics = allDiagnostics.slice(
    0,
    effectiveLimits.maxDiagnostics,
  );
  const omittedByCode: Record<string, number> = {};
  for (const diagnostic of allDiagnostics.slice(diagnostics.length)) {
    omittedByCode[diagnostic.code] =
      (omittedByCode[diagnostic.code] ?? 0) + 1;
  }
  const reasons = [...new Set(
    allDiagnostics.map((diagnostic) => diagnostic.code),
  )];
  const build = () =>
    createEnvelope({
      operation: parsed.operation,
      status: "failed",
      completenessReasons: reasons,
      diagnostics,
      diagnosticsOmitted:
        allDiagnostics.length - diagnostics.length,
      diagnosticsOmittedByCode: omittedByCode,
      effectiveLimits,
    });
  let envelope = build();
  while (
    serializeCanonicalEnvelope(envelope).byteLength >
    effectiveLimits.maxResultBytes &&
    diagnostics.length > 0
  ) {
    const omitted = diagnostics.pop() as Diagnostic;
    omittedByCode[omitted.code] =
      (omittedByCode[omitted.code] ?? 0) + 1;
    envelope = build();
  }
  if (
    serializeCanonicalEnvelope(envelope).byteLength >
    effectiveLimits.maxResultBytes
  ) {
    throw new Error("Minimal CLI failure envelope exceeds maxResultBytes");
  }
  return renderExecution(
    parsed,
    envelope,
    requestError ? CLI_EXIT.requestError : CLI_EXIT.runtimeError,
  );
}

function failureEffectiveLimits(
  operation: Operation,
  request: unknown,
): ReturnType<typeof effectiveAgentV1Limits> {
  if (
    (operation !== "read" && operation !== "search") ||
    typeof request !== "object" ||
    request === null ||
    Array.isArray(request)
  ) {
    return effectiveAgentV1Limits();
  }
  try {
    const limits = validateLimits(
      (request as Record<string, unknown>)["limits"],
    );
    return applyLimitCeilings(limits, AGENT_V1_LIMITS).effectiveLimits;
  } catch {
    return effectiveAgentV1Limits();
  }
}

function renderExecution(
  parsed: ParsedArguments,
  envelope: ResultEnvelope<object>,
  exitCode: number,
): CliExecution {
  const canonical = serializeCanonicalEnvelope(envelope);
  if (parsed.json) {
    return {
      exitCode,
      stdout: canonical,
      stderr: new Uint8Array(),
    };
  }

  const rendered = renderText(envelope);
  return {
    exitCode,
    stdout: rendered.byteLength <= canonical.byteLength ? rendered : canonical,
    stderr: new Uint8Array(),
  };
}

function renderText(envelope: ResultEnvelope<object>): Uint8Array {
  const lines: string[] = [];
  if (envelope.status !== "success") {
    lines.push(
      `# ${envelope.operation} ${envelope.status}` +
        (envelope.completeness.reasons.length === 0
          ? ""
          : ` ${envelope.completeness.reasons.join(",")}`),
    );
  }
  for (const result of envelope.results) {
    renderRecord(result, lines);
  }
  for (const diagnostic of envelope.diagnostics) {
    lines.push(
      `! ${diagnostic.code}` +
        (diagnostic.path === undefined ? "" : ` ${diagnostic.path}`) +
        `: ${diagnostic.message}`,
    );
  }
  return Buffer.from(lines.length === 0 ? "" : `${lines.join("\n")}\n`, "utf8");
}

function renderRecord(record: object, lines: string[]): void {
  const value = record as Record<string, unknown>;
  switch (value["type"]) {
    case "match":
      lines.push(`${value["path"]}:${value["line"]}:${value["text"]}`);
      return;
    case "file":
      lines.push(String(value["path"]));
      return;
    case "read":
      renderReadRecord(value, lines);
      return;
    case "create":
      lines.push(`${value["path"]}\t${value["revision"]}`);
      return;
    case "update":
      lines.push(`${value["path"]}\t${value["newRevision"]}`);
      return;
    case "delete":
      lines.push(`${value["path"]}\t${value["oldRevision"]}`);
      return;
    case "searchSummary":
      lines.push(renderSearchSummary(value));
      return;
    case "facet":
      lines.push(
        `# ${value["facet"]}=${value["value"]} files=${value["files"]}`,
      );
      return;
    case "facetRemainder":
      lines.push(
        `# ${value["facet"]} omitted=${value["valuesOmitted"]}` +
          ` files=${value["files"]}`,
      );
      return;
    default:
      lines.push(JSON.stringify(record));
  }
}

function renderReadRecord(
  record: Readonly<Record<string, unknown>>,
  lines: string[],
): void {
  const path = String(record["path"]);
  const text = String(record["text"]);
  const returnedRange = record["returnedRange"];
  if (
    typeof returnedRange !== "object" ||
    returnedRange === null ||
    !("startLine" in returnedRange)
  ) {
    lines.push(`# ${path} empty selection`);
    return;
  }
  const startLine = Number(
    (returnedRange as Record<string, unknown>)["startLine"],
  );
  for (const line of parseLogicalText(text).lines) {
    lines.push(`${path}:${startLine + line.number - 1}:${line.text}`);
  }
}

function renderSearchSummary(
  record: Readonly<Record<string, unknown>>,
): string {
  const fields = [
    "filesVisited",
    "filesMatched",
    "filesMatchedAtLeast",
    "matchesFound",
    "matchesFoundAtLeast",
    "filesReturned",
    "matchesReturned",
  ]
    .filter((field) => record[field] !== undefined && record[field] !== null)
    .map((field) => `${field}=${record[field]}`)
    .join(" ");
  return `# ${record["mode"]} ${fields}`;
}

function diagnosticFromError(error: unknown): Diagnostic {
  if (error instanceof CliRequestError) {
    return {
      severity: "error",
      code: error.code,
      message: error.message,
    };
  }
  if (error instanceof TextEncodingError) {
    return {
      severity: "error",
      code: "encode_error",
      message: error.message,
      details: {
        encoding: error.encoding,
        ...(error.characterOffset === undefined
          ? {}
          : { characterOffset: error.characterOffset }),
      },
    };
  }
  if (error instanceof TextDecodingError) {
    return {
      severity: "error",
      code: "decode_error",
      message: error.message,
      ...(error.byteOffset === undefined
        ? {}
        : { byteOffset: error.byteOffset }),
      details: { encoding: error.encoding },
    };
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    const path =
      "path" in error && typeof error.path === "string"
        ? error.path
        : undefined;
    return {
      severity: "error",
      code: stableRuntimeCode(error.code),
      message: error instanceof Error ? error.message : String(error),
      ...(path === undefined ? {} : { path }),
    };
  }
  return {
    severity: "error",
    code: "runtime_error",
    message: error instanceof Error ? error.message : String(error),
  };
}

function stableRuntimeCode(code: string): string {
  return /^[a-z][a-z0-9_]*$/u.test(code) ? code : "source_error";
}

function isRequestFailure(error: unknown): boolean {
  return (
    error instanceof RequestValidationError ||
    error instanceof SafeRegexError ||
    (error instanceof ContextDiffError &&
      error.code === "patch_syntax_error")
  );
}

function exitForEnvelope(envelope: ResultEnvelope<object>): number {
  switch (envelope.status) {
    case "success":
      return CLI_EXIT.success;
    case "partial":
      return CLI_EXIT.partial;
    case "failed":
      return CLI_EXIT.runtimeError;
  }
}

function unstructuredCliFailure(error: unknown): CliExecution {
  const diagnostic = diagnosticFromError(error);
  return {
    exitCode: CLI_EXIT.requestError,
    stdout: new Uint8Array(),
    stderr: Buffer.from(`${diagnostic.code}: ${diagnostic.message}\n`, "utf8"),
  };
}

function isOperation(value: string): value is Operation {
  return (
    value === "search" ||
    value === "read" ||
    value === "create" ||
    value === "update" ||
    value === "delete"
  );
}
