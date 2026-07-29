import { readFile } from "node:fs/promises";
import {
  type LineEndingChoice,
  validateCreateRequest,
} from "../contracts/requests.js";
import {
  type CompiledGlob,
  compileRequestGlob,
  requestGlobMatches,
} from "../fs/glob.js";
import {
  Workspace,
  WorkspaceBoundaryError,
} from "../fs/workspace.js";
import {
  type CanonicalEncoding,
  decodeStrict,
} from "../text/encoding.js";

export const REPOSITORY_CONFIG_PATH =
  ".mikusoft/miku-text-file-ops.json" as const;

export interface RepositoryEncodingRule {
  glob: string;
  encoding: CanonicalEncoding;
}

export interface RepositoryCreateDefaults {
  encoding: CanonicalEncoding;
  lineEnding: LineEndingChoice;
  bom: boolean;
}

export interface RepositoryTextPolicy {
  encodingRules: readonly RepositoryEncodingRule[];
  defaultCreate: RepositoryCreateDefaults | undefined;
  legacyFallback: "windows-31j" | undefined;
  repositoryEncoding(path: string): CanonicalEncoding | undefined;
}

interface CompiledEncodingRule extends RepositoryEncodingRule {
  compiled: CompiledGlob;
}

export class RepositoryConfigError extends Error {
  readonly code = "repository_config_invalid";
  readonly path = REPOSITORY_CONFIG_PATH;

  constructor(message: string) {
    super(message);
    this.name = "RepositoryConfigError";
  }
}

export async function loadRepositoryTextPolicy(
  workspace: Workspace,
): Promise<RepositoryTextPolicy> {
  let absolutePath: string;
  try {
    absolutePath = await workspace.resolveExistingFile(REPOSITORY_CONFIG_PATH);
  } catch (error) {
    if (
      error instanceof WorkspaceBoundaryError &&
      error.code === "target_missing"
    ) {
      return buildPolicy([], undefined, undefined);
    }
    throw error;
  }

  let value: unknown;
  try {
    const text = decodeStrict(await readFile(absolutePath), "utf-8");
    value = JSON.parse(text);
  } catch (error) {
    throw configError("must be strict UTF-8 containing valid JSON", error);
  }
  return parseRepositoryTextPolicy(value);
}

export function parseRepositoryTextPolicy(
  value: unknown,
): RepositoryTextPolicy {
  const object = configObject(value, "configuration");
  rejectConfigFields(
    object,
    new Set([
      "schemaVersion",
      "encodingRules",
      "defaultCreate",
      "legacyFallback",
    ]),
    "configuration",
  );
  if (object["schemaVersion"] !== 1) {
    throw configError("schemaVersion must be 1");
  }

  const rulesValue = object["encodingRules"];
  if (rulesValue !== undefined && !Array.isArray(rulesValue)) {
    throw configError("encodingRules must be an array");
  }
  const rules = (rulesValue ?? []).map((rule, index) =>
    parseEncodingRule(rule, index),
  );

  const defaultCreate =
    object["defaultCreate"] === undefined
      ? undefined
      : parseCreateDefaults(object["defaultCreate"]);
  const legacyFallback =
    object["legacyFallback"] === undefined
      ? undefined
      : object["legacyFallback"] === "windows-31j"
        ? "windows-31j"
        : (() => {
            throw configError('legacyFallback must be "windows-31j"');
          })();
  return buildPolicy(rules, defaultCreate, legacyFallback);
}

function parseEncodingRule(
  value: unknown,
  index: number,
): CompiledEncodingRule {
  const field = `encodingRules[${index}]`;
  const object = configObject(value, field);
  rejectConfigFields(object, new Set(["glob", "encoding"]), field);
  const glob = configString(object["glob"], `${field}.glob`);
  const encoding = canonicalEncoding(
    object["encoding"],
    `${field}.encoding`,
  );
  try {
    return { glob, encoding, compiled: compileRequestGlob(glob) };
  } catch (error) {
    throw configError(`${field}.glob is invalid`, error);
  }
}

function parseCreateDefaults(value: unknown): RepositoryCreateDefaults {
  const object = configObject(value, "defaultCreate");
  rejectConfigFields(
    object,
    new Set(["encoding", "lineEnding", "bom"]),
    "defaultCreate",
  );
  try {
    return validateCreateRequest({
      path: "placeholder",
      content: "",
      writeAs: object,
    }).writeAs;
  } catch (error) {
    throw configError("defaultCreate is invalid", error);
  }
}

function buildPolicy(
  rules: readonly CompiledEncodingRule[],
  defaultCreate: RepositoryCreateDefaults | undefined,
  legacyFallback: "windows-31j" | undefined,
): RepositoryTextPolicy {
  return {
    encodingRules: rules.map(({ glob, encoding }) => ({ glob, encoding })),
    defaultCreate,
    legacyFallback,
    repositoryEncoding: (path) =>
      rules.find((rule) => requestGlobMatches(rule.compiled, path))?.encoding,
  };
}

function configObject(
  value: unknown,
  field: string,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value)
  ) {
    throw configError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function configString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw configError(`${field} must be a string`);
  }
  return value;
}

function canonicalEncoding(
  value: unknown,
  field: string,
): CanonicalEncoding {
  if (
    value !== "utf-8" &&
    value !== "utf-16le" &&
    value !== "utf-16be" &&
    value !== "windows-31j"
  ) {
    throw configError(`${field} has an unsupported value`);
  }
  return value;
}

function rejectConfigFields(
  object: Readonly<Record<string, unknown>>,
  allowed: ReadonlySet<string>,
  field: string,
): void {
  const unknown = Object.keys(object).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw configError(`${field} contains unknown field ${unknown[0]}`);
  }
}

function configError(
  message: string,
  cause?: unknown,
): RepositoryConfigError {
  const suffix =
    cause instanceof Error && cause.message.length > 0
      ? `: ${cause.message}`
      : "";
  return new RepositoryConfigError(`${message}${suffix}`);
}
