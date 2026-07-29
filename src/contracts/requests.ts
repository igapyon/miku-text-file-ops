import {
  type CanonicalEncoding,
  firstUnpairedSurrogate,
} from "../text/encoding.js";
import { compileRequestGlob } from "../fs/glob.js";
import {
  type Diagnostic,
  type EffectiveLimits,
  type LimitName,
  type Limits,
} from "./types.js";
import {
  RequestValidationError,
  rejectUnknownFields,
  requireObject,
  validateLimits,
} from "./validation.js";

export type SearchMode = "paths" | "content";
export type PathSearchProjection = "files" | "summary" | "count";
export type ContentSearchProjection =
  | "matches"
  | "files"
  | "summary"
  | "count";
export type SearchProjection =
  | PathSearchProjection
  | ContentSearchProjection;
export type SearchSyntax = "literal" | "regex";
export type SearchFacet = "extension" | "topLevelPath";

export interface PathSearchRequest {
  mode: "paths";
  projection?: PathSearchProjection;
  include?: readonly string[];
  exclude?: readonly string[];
  facets?: readonly SearchFacet[];
  limits?: Limits;
}

export interface ContentSearchRequest {
  mode: "content";
  projection?: ContentSearchProjection;
  pattern: string;
  syntax?: SearchSyntax;
  caseSensitive?: boolean;
  beforeContext?: number;
  afterContext?: number;
  include?: readonly string[];
  exclude?: readonly string[];
  facets?: readonly SearchFacet[];
  limits?: Limits;
}

export type SearchRequest = PathSearchRequest | ContentSearchRequest;

export interface ValidatedPathSearchRequest {
  mode: "paths";
  projection: PathSearchProjection;
  include: readonly string[];
  exclude: readonly string[];
  facets: readonly SearchFacet[];
  effectiveLimits: Readonly<EffectiveLimits>;
}

export interface ValidatedContentSearchRequest {
  mode: "content";
  projection: ContentSearchProjection;
  pattern: string;
  syntax: SearchSyntax;
  caseSensitive: boolean;
  beforeContext: number;
  afterContext: number;
  include: readonly string[];
  exclude: readonly string[];
  facets: readonly SearchFacet[];
  effectiveLimits: Readonly<EffectiveLimits>;
}

export type ValidatedSearchRequest =
  | ValidatedPathSearchRequest
  | ValidatedContentSearchRequest;

export interface ReadRange {
  startLine: number;
  endLine: number;
}

export type ReadSelector =
  | { full: true }
  | { range: ReadRange }
  | { firstLines: number }
  | { lastLines: number };

export type ReadItem = {
  path: string;
  encoding?: CanonicalEncoding;
} & ReadSelector;

export interface ReadRequest {
  items: readonly ReadItem[];
  limits?: Limits;
}

export interface ValidatedReadItem {
  path: string;
  encoding: CanonicalEncoding | undefined;
  selector: ReadSelector;
}

export interface ValidatedReadRequest {
  items: readonly ValidatedReadItem[];
  effectiveLimits: Readonly<EffectiveLimits>;
}

export type LineEndingChoice = "lf" | "crlf" | "cr";
export type UpdateLineEndingChoice = LineEndingChoice | "preserve";
export type UpdateEncodingChoice = CanonicalEncoding | "preserve";
export type UpdateBomChoice = boolean | "preserve";

export interface CreateWriteAs {
  encoding?: CanonicalEncoding;
  lineEnding?: LineEndingChoice;
  bom?: boolean;
}

export interface CreateRequest {
  path: string;
  content: string;
  writeAs?: CreateWriteAs;
}

export interface ValidatedCreateRequest {
  path: string;
  content: string;
  writeAs: {
    encoding: CanonicalEncoding;
    lineEnding: LineEndingChoice;
    bom: boolean;
  };
}

export type UpdateChange =
  | { type: "context-diff"; diff: string }
  | { type: "replace"; content: string }
  | { type: "transcode" };

export interface UpdateWriteAs {
  encoding?: UpdateEncodingChoice;
  lineEnding?: UpdateLineEndingChoice;
  bom?: UpdateBomChoice;
}

export interface UpdateRequest {
  path: string;
  expectedRevision: string;
  change: UpdateChange;
  writeAs?: UpdateWriteAs;
}

export interface ValidatedUpdateRequest {
  path: string;
  expectedRevision: string;
  change: UpdateChange;
  writeAs: {
    encoding: UpdateEncodingChoice;
    lineEnding: UpdateLineEndingChoice;
    bom: UpdateBomChoice;
  };
}

export interface DeleteRequest {
  path: string;
  expectedRevision: string;
}

export interface ValidatedDeleteRequest {
  path: string;
  expectedRevision: string;
}

const SEARCH_COMMON_FIELDS = new Set([
  "mode",
  "projection",
  "include",
  "exclude",
  "facets",
  "limits",
]);
const CONTENT_SEARCH_FIELDS = new Set([
  ...SEARCH_COMMON_FIELDS,
  "pattern",
  "syntax",
  "caseSensitive",
  "beforeContext",
  "afterContext",
]);
const PATH_PROJECTIONS = new Set<PathSearchProjection>([
  "files",
  "summary",
  "count",
]);
const CONTENT_PROJECTIONS = new Set<ContentSearchProjection>([
  "matches",
  "files",
  "summary",
  "count",
]);
const FACETS = new Set<SearchFacet>(["extension", "topLevelPath"]);
const ENCODINGS = new Set<CanonicalEncoding>([
  "utf-8",
  "utf-16le",
  "utf-16be",
  "windows-31j",
]);

const SEARCH_LIMITS_EVERYWHERE = new Set<LimitName>([
  "maxResultBytes",
  "maxDiagnostics",
  "maxFilesVisited",
]);
const READ_LIMITS = new Set<LimitName>([
  "maxResultBytes",
  "maxTextCharsReturned",
  "maxDiagnostics",
  "maxItems",
  "maxLinesPerItem",
]);

export function validateSearchRequest(
  value: unknown,
): ValidatedSearchRequest {
  const object = requireObject(value);
  const mode = requiredEnum(
    object["mode"],
    "mode",
    new Set<SearchMode>(["paths", "content"]),
  );
  rejectUnknownFields(
    object,
    mode === "content" ? CONTENT_SEARCH_FIELDS : SEARCH_COMMON_FIELDS,
  );

  const include = optionalStringArray(object["include"], "include");
  const exclude = optionalStringArray(object["exclude"], "exclude");
  const suppliedLimits = optionalLimitsObject(object["limits"]);
  const effectiveLimits = validateLimits(object["limits"]);

  if (mode === "paths") {
    const projection = optionalEnum(
      object["projection"],
      "projection",
      PATH_PROJECTIONS,
      "files",
      "projection_not_supported",
    );
    const facets = validateFacets(object["facets"], projection);
    validateApplicableLimits(
      suppliedLimits,
      applicableSearchLimits("paths", projection),
    );
    return {
      mode,
      projection,
      include,
      exclude,
      facets,
      effectiveLimits,
    };
  }

  const projection = optionalEnum(
    object["projection"],
    "projection",
    CONTENT_PROJECTIONS,
    "matches",
    "projection_not_supported",
  );
  const pattern = requiredString(object["pattern"], "pattern");
  validateContentPattern(pattern);
  const syntax = optionalEnum(
    object["syntax"],
    "syntax",
    new Set<SearchSyntax>(["literal", "regex"]),
    "literal",
  );
  const beforeContext = optionalNonNegativeInteger(
    object["beforeContext"],
    "beforeContext",
    0,
  );
  const afterContext = optionalNonNegativeInteger(
    object["afterContext"],
    "afterContext",
    0,
  );
  if (
    projection !== "matches" &&
    (object["beforeContext"] !== undefined ||
      object["afterContext"] !== undefined)
  ) {
    throw validationError(
      "field_not_applicable",
      "beforeContext and afterContext apply only to matches projection",
      { projection },
    );
  }
  const facets = validateFacets(object["facets"], projection);
  validateApplicableLimits(
    suppliedLimits,
    applicableSearchLimits("content", projection),
  );

  return {
    mode,
    projection,
    pattern,
    syntax,
    caseSensitive: optionalBoolean(
      object["caseSensitive"],
      "caseSensitive",
      true,
    ),
    beforeContext,
    afterContext,
    include,
    exclude,
    facets,
    effectiveLimits,
  };
}

export function validateReadRequest(value: unknown): ValidatedReadRequest {
  const object = requireObject(value);
  rejectUnknownFields(object, new Set(["items", "limits"]));
  if (!Array.isArray(object["items"]) || object["items"].length === 0) {
    throw validationError(
      "invalid_items",
      "items must be a non-empty array",
      { field: "items" },
    );
  }

  const suppliedLimits = optionalLimitsObject(object["limits"]);
  const effectiveLimits = validateLimits(object["limits"]);
  validateApplicableLimits(suppliedLimits, READ_LIMITS);
  return {
    items: object["items"].map((item, index) => validateReadItem(item, index)),
    effectiveLimits,
  };
}

export function validateCreateRequest(
  value: unknown,
): ValidatedCreateRequest {
  const object = requireObject(value);
  rejectUnknownFields(object, new Set(["path", "content", "writeAs"]));
  const writeAs = validateCreateWriteAs(object["writeAs"]);
  return {
    path: validateWorkspacePath(object["path"], "path", true),
    content: requiredString(object["content"], "content"),
    writeAs,
  };
}

export function validateUpdateRequest(
  value: unknown,
): ValidatedUpdateRequest {
  const object = requireObject(value);
  rejectUnknownFields(
    object,
    new Set(["path", "expectedRevision", "change", "writeAs"]),
  );
  return {
    path: validateWorkspacePath(object["path"], "path", true),
    expectedRevision: validateRevision(object["expectedRevision"]),
    change: validateUpdateChange(object["change"]),
    writeAs: validateUpdateWriteAs(object["writeAs"]),
  };
}

export function validateDeleteRequest(
  value: unknown,
): ValidatedDeleteRequest {
  const object = requireObject(value);
  rejectUnknownFields(object, new Set(["path", "expectedRevision"]));
  return {
    path: validateWorkspacePath(object["path"], "path", true),
    expectedRevision: validateRevision(object["expectedRevision"]),
  };
}

export function validateWorkspacePath(
  value: unknown,
  field: string,
  mutation: boolean,
): string {
  const path = requiredString(value, field);
  if (
    path.includes("\0") ||
    path.includes("\\") ||
    path.startsWith("/") ||
    path.startsWith("//") ||
    /^[A-Za-z]:/u.test(path)
  ) {
    throw validationError(
      "path_escape",
      `${field} must be a root-relative JSON path using /`,
      { field, path },
    );
  }

  const segments = path.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw validationError(
      "path_escape",
      `${field} contains an invalid path segment`,
      { field, path },
    );
  }
  if (mutation && segments[0] === ".git") {
    throw validationError(
      "protected_path",
      "Mutation under .git is prohibited",
      { field, path },
    );
  }
  return path;
}

function validateReadItem(
  value: unknown,
  index: number,
): ValidatedReadItem {
  const field = `items[${index}]`;
  const object = requireObject(value, field);
  rejectUnknownFields(
    object,
    new Set([
      "path",
      "encoding",
      "full",
      "range",
      "firstLines",
      "lastLines",
    ]),
    field,
  );

  const selectors = ["full", "range", "firstLines", "lastLines"].filter(
    (selector) => object[selector] !== undefined,
  );
  if (selectors.length !== 1) {
    throw validationError(
      "invalid_selector",
      `${field} must contain exactly one read selector`,
      { field, selectors },
    );
  }

  let selector: ReadSelector;
  if (object["full"] !== undefined) {
    if (object["full"] !== true) {
      throw validationError(
        "invalid_selector",
        `${field}.full must be true`,
        { field: `${field}.full` },
      );
    }
    selector = { full: true };
  } else if (object["range"] !== undefined) {
    const range = requireObject(object["range"], `${field}.range`);
    rejectUnknownFields(
      range,
      new Set(["startLine", "endLine"]),
      `${field}.range`,
    );
    const startLine = positiveInteger(
      range["startLine"],
      `${field}.range.startLine`,
    );
    const endLine = positiveInteger(
      range["endLine"],
      `${field}.range.endLine`,
    );
    if (startLine > endLine) {
      throw validationError(
        "invalid_range",
        `${field}.range.startLine must not exceed endLine`,
        { field: `${field}.range`, startLine, endLine },
      );
    }
    selector = { range: { startLine, endLine } };
  } else if (object["firstLines"] !== undefined) {
    selector = {
      firstLines: positiveInteger(
        object["firstLines"],
        `${field}.firstLines`,
      ),
    };
  } else {
    selector = {
      lastLines: positiveInteger(object["lastLines"], `${field}.lastLines`),
    };
  }

  return {
    path: validateWorkspacePath(object["path"], `${field}.path`, false),
    encoding:
      object["encoding"] === undefined
        ? undefined
        : requiredEnum(
            object["encoding"],
            `${field}.encoding`,
            ENCODINGS,
          ),
    selector,
  };
}

function validateCreateWriteAs(
  value: unknown,
): ValidatedCreateRequest["writeAs"] {
  if (value === undefined) {
    return { encoding: "utf-8", lineEnding: "lf", bom: false };
  }
  const object = requireObject(value, "writeAs");
  rejectUnknownFields(
    object,
    new Set(["encoding", "lineEnding", "bom"]),
    "writeAs",
  );
  return {
    encoding: optionalEnum(
      object["encoding"],
      "writeAs.encoding",
      ENCODINGS,
      "utf-8",
    ),
    lineEnding: optionalEnum(
      object["lineEnding"],
      "writeAs.lineEnding",
      new Set<LineEndingChoice>(["lf", "crlf", "cr"]),
      "lf",
    ),
    bom: optionalBoolean(object["bom"], "writeAs.bom", false),
  };
}

function validateUpdateWriteAs(
  value: unknown,
): ValidatedUpdateRequest["writeAs"] {
  if (value === undefined) {
    return {
      encoding: "preserve",
      lineEnding: "preserve",
      bom: "preserve",
    };
  }
  const object = requireObject(value, "writeAs");
  rejectUnknownFields(
    object,
    new Set(["encoding", "lineEnding", "bom"]),
    "writeAs",
  );
  return {
    encoding: optionalEnum(
      object["encoding"],
      "writeAs.encoding",
      new Set<UpdateEncodingChoice>(["preserve", ...ENCODINGS]),
      "preserve",
    ),
    lineEnding: optionalEnum(
      object["lineEnding"],
      "writeAs.lineEnding",
      new Set<UpdateLineEndingChoice>(["preserve", "lf", "crlf", "cr"]),
      "preserve",
    ),
    bom:
      object["bom"] === undefined
        ? "preserve"
        : object["bom"] === "preserve" || typeof object["bom"] === "boolean"
          ? object["bom"]
          : invalidField(
              "writeAs.bom",
              'must be boolean or "preserve"',
              object["bom"],
            ),
  };
}

function validateUpdateChange(value: unknown): UpdateChange {
  const object = requireObject(value, "change");
  const type = requiredEnum(
    object["type"],
    "change.type",
    new Set<UpdateChange["type"]>(["context-diff", "replace", "transcode"]),
  );
  if (type === "context-diff") {
    rejectUnknownFields(object, new Set(["type", "diff"]), "change");
    return {
      type,
      diff: requiredString(object["diff"], "change.diff"),
    };
  }
  if (type === "replace") {
    rejectUnknownFields(object, new Set(["type", "content"]), "change");
    return {
      type,
      content: requiredString(object["content"], "change.content"),
    };
  }
  rejectUnknownFields(object, new Set(["type"]), "change");
  return { type };
}

function validateFacets(
  value: unknown,
  projection: SearchProjection,
): readonly SearchFacet[] {
  if (value === undefined) {
    return projection === "summary" ? ["extension", "topLevelPath"] : [];
  }
  if (projection !== "summary") {
    throw validationError(
      "field_not_applicable",
      "facets apply only to summary projection",
      { projection },
    );
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw validationError(
      "invalid_facets",
      "facets must be a non-empty array",
      { field: "facets" },
    );
  }
  const facets = value.map((facet, index) =>
    requiredEnum(facet, `facets[${index}]`, FACETS),
  );
  if (new Set(facets).size !== facets.length) {
    throw validationError(
      "invalid_facets",
      "facets must not contain duplicates",
      { field: "facets" },
    );
  }
  return facets;
}

function applicableSearchLimits(
  mode: SearchMode,
  projection: SearchProjection,
): ReadonlySet<LimitName> {
  const names = new Set(SEARCH_LIMITS_EVERYWHERE);
  if (mode === "content") {
    names.add("maxSourceBytes");
  }
  if (projection === "matches") {
    names.add("maxTextCharsReturned");
    names.add("maxMatches");
    names.add("maxMatchesPerFile");
  } else if (projection === "files") {
    names.add("maxFilesReturned");
  } else if (projection === "summary") {
    names.add("maxFacetValues");
  }
  return names;
}

function optionalLimitsObject(value: unknown): Record<string, unknown> {
  return value === undefined ? {} : requireObject(value, "limits");
}

function validateApplicableLimits(
  supplied: Readonly<Record<string, unknown>>,
  applicable: ReadonlySet<LimitName>,
): void {
  const invalid = Object.keys(supplied).filter(
    (name) => !applicable.has(name as LimitName),
  );
  if (invalid.length > 0) {
    throw validationError(
      "field_not_applicable",
      `Limit ${invalid[0]} does not apply to the selected operation`,
      { field: `limits.${invalid[0]}` },
    );
  }
}

function validateContentPattern(pattern: string): void {
  const length = Array.from(pattern).length;
  if (length === 0) {
    throw validationError("pattern_empty", "pattern must not be empty", {
      field: "pattern",
    });
  }
  if (length > 4_096) {
    throw validationError(
      "pattern_too_large",
      "pattern must not exceed 4096 Unicode scalars",
      { field: "pattern", length },
    );
  }
  if (pattern.includes("\r") || pattern.includes("\n")) {
    throw validationError(
      "regex_syntax_error",
      "pattern must not contain CR or LF",
      { field: "pattern" },
    );
  }
}

function validateRevision(value: unknown): string {
  const revision = requiredString(value, "expectedRevision");
  if (!/^sha256:[0-9a-f]{64}$/u.test(revision)) {
    throw validationError(
      "invalid_revision",
      "expectedRevision must be sha256 followed by 64 lowercase hex digits",
      { field: "expectedRevision" },
    );
  }
  return revision;
}

function optionalStringArray(value: unknown, field: string): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw validationError(
      "invalid_type",
      `${field} must be a non-empty string array`,
      { field },
    );
  }
  return value.map((item, index) => {
    const text = requiredString(item, `${field}[${index}]`);
    const itemField = `${field}[${index}]`;
    if (text.includes("\0") || text.includes("\\")) {
      throw validationError(
        "invalid_glob",
        `${itemField} must use / and contain no NUL`,
        { field: itemField },
      );
    }
    try {
      compileRequestGlob(text);
    } catch (error) {
      throw validationError(
        "invalid_glob",
        `${itemField} is not a valid glob`,
        {
          field: itemField,
          reason: error instanceof Error ? error.message : String(error),
        },
      );
    }
    return text;
  });
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    return invalidField(field, "must be a string", value);
  }
  const invalid = firstUnpairedSurrogate(value);
  if (invalid !== undefined) {
    throw validationError(
      "invalid_unicode_scalar",
      `${field} must contain only Unicode scalar values`,
      {
        field,
        characterOffset: invalid.characterOffset,
        codeUnitOffset: invalid.codeUnitOffset,
      },
    );
  }
  return value;
}

function optionalBoolean(
  value: unknown,
  field: string,
  fallback: boolean,
): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    return invalidField(field, "must be boolean", value);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    return invalidField(field, "must be a positive safe integer", value);
  }
  return value as number;
}

function optionalNonNegativeInteger(
  value: unknown,
  field: string,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return invalidField(field, "must be a non-negative safe integer", value);
  }
  return value as number;
}

function requiredEnum<T extends string>(
  value: unknown,
  field: string,
  values: ReadonlySet<T>,
  code = "invalid_value",
): T {
  if (typeof value !== "string" || !values.has(value as T)) {
    throw validationError(code, `${field} has an unsupported value`, {
      field,
      value,
      allowed: [...values],
    });
  }
  return value as T;
}

function optionalEnum<T extends string>(
  value: unknown,
  field: string,
  values: ReadonlySet<T>,
  fallback: T,
  code = "invalid_value",
): T {
  return value === undefined
    ? fallback
    : requiredEnum(value, field, values, code);
}

function invalidField(
  field: string,
  expectation: string,
  value: unknown,
): never {
  throw validationError("invalid_type", `${field} ${expectation}`, {
    field,
    value,
  });
}

function validationError(
  code: string,
  message: string,
  details: Readonly<Record<string, unknown>>,
): RequestValidationError {
  const diagnostic: Diagnostic = {
    severity: "error",
    code,
    message,
    details,
  };
  return new RequestValidationError([diagnostic]);
}
