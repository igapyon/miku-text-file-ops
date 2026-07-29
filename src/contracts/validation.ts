import {
  AGENT_V1_LIMITS,
  type Diagnostic,
  type EffectiveLimits,
  type LimitName,
  type Limits,
  effectiveAgentV1Limits,
} from "./types.js";

const LIMIT_NAMES = new Set<string>(Object.keys(AGENT_V1_LIMITS));
const MIN_RESULT_BYTES = 4_096;

export class RequestValidationError extends Error {
  readonly diagnostics: readonly Diagnostic[];

  constructor(diagnostics: readonly Diagnostic[]) {
    super(diagnostics.map((diagnostic) => diagnostic.message).join("; "));
    this.name = "RequestValidationError";
    this.diagnostics = diagnostics;
  }
}

export function requireObject(
  value: unknown,
  fieldName = "request",
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RequestValidationError([
      validationDiagnostic(
        "invalid_type",
        `${fieldName} must be an object`,
        { field: fieldName, expected: "object" },
      ),
    ]);
  }
  return value as Record<string, unknown>;
}

export function rejectUnknownFields(
  object: Readonly<Record<string, unknown>>,
  allowedFields: ReadonlySet<string>,
  fieldName = "request",
): void {
  const unknownFields = Object.keys(object)
    .filter((key) => !allowedFields.has(key))
    .sort(compareUnicodeScalars);

  if (unknownFields.length > 0) {
    throw new RequestValidationError(
      unknownFields.map((field) =>
        validationDiagnostic(
          "unknown_field",
          `Unknown field: ${fieldName}.${field}`,
          { field: `${fieldName}.${field}` },
        ),
      ),
    );
  }
}

export function validateLimits(value: unknown): EffectiveLimits {
  if (value === undefined) {
    return effectiveAgentV1Limits();
  }

  const object = requireObject(value, "limits");
  const diagnostics: Diagnostic[] = [];
  const overrides: Limits = {};

  for (const [name, rawValue] of Object.entries(object)) {
    if (!LIMIT_NAMES.has(name)) {
      diagnostics.push(
        validationDiagnostic(
          "unknown_field",
          `Unknown field: limits.${name}`,
          { field: `limits.${name}` },
        ),
      );
      continue;
    }

    if (!Number.isSafeInteger(rawValue) || (rawValue as number) <= 0) {
      diagnostics.push(
        validationDiagnostic(
          "invalid_limit",
          `limits.${name} must be a positive safe integer`,
          { field: `limits.${name}`, value: rawValue },
        ),
      );
      continue;
    }

    if (name === "maxResultBytes" && (rawValue as number) < MIN_RESULT_BYTES) {
      diagnostics.push(
        validationDiagnostic(
          "result_budget_too_small",
          `limits.maxResultBytes must be at least ${MIN_RESULT_BYTES}`,
          { field: "limits.maxResultBytes", minimum: MIN_RESULT_BYTES },
        ),
      );
      continue;
    }

    overrides[name as LimitName] = rawValue as number;
  }

  if (diagnostics.length > 0) {
    throw new RequestValidationError(diagnostics);
  }

  return effectiveAgentV1Limits(overrides);
}

function validationDiagnostic(
  code: string,
  message: string,
  details: Readonly<Record<string, unknown>>,
): Diagnostic {
  return {
    severity: "error",
    code,
    message,
    details,
  };
}

function compareUnicodeScalars(left: string, right: string): number {
  const leftScalars = Array.from(left);
  const rightScalars = Array.from(right);
  const length = Math.min(leftScalars.length, rightScalars.length);

  for (let index = 0; index < length; index += 1) {
    const leftCodePoint = leftScalars[index]?.codePointAt(0) ?? 0;
    const rightCodePoint = rightScalars[index]?.codePointAt(0) ?? 0;
    if (leftCodePoint !== rightCodePoint) {
      return leftCodePoint - rightCodePoint;
    }
  }

  return leftScalars.length - rightScalars.length;
}
