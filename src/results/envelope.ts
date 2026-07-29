import {
  LIMIT_PROFILE,
  SCHEMA_VERSION,
  type Diagnostic,
  type DiagnosticCount,
  type EffectiveLimits,
  type Operation,
  type ResultEnvelope,
  type ResultStatus,
  type Usage,
} from "../contracts/types.js";

export interface EnvelopeInput<TResult extends object> {
  operation: Operation;
  status: ResultStatus;
  completenessReasons?: readonly string[];
  results?: readonly TResult[];
  diagnostics?: readonly Diagnostic[];
  diagnosticsOmitted?: number;
  diagnosticsOmittedByCode?: Readonly<Record<string, number>>;
  effectiveLimits: Readonly<EffectiveLimits>;
  usage?: Readonly<
    Partial<
      Omit<
        Usage,
        | "limitProfile"
        | "textCharsReturned"
        | "resultBytes"
        | "recordsReturned"
        | "diagnosticsReturned"
        | "diagnosticsOmitted"
        | "effectiveLimits"
      >
    >
  >;
}

export function createEnvelope<
  TResult extends object,
>(input: EnvelopeInput<TResult>): ResultEnvelope<TResult> {
  const results = input.results ?? [];
  const diagnostics = input.diagnostics ?? [];
  const diagnosticsOmitted = input.diagnosticsOmitted ?? 0;
  const omittedByCode = input.diagnosticsOmittedByCode ?? {};
  const completenessReasons = [...(input.completenessReasons ?? [])].sort();

  const envelope: ResultEnvelope<TResult> = {
    schemaVersion: SCHEMA_VERSION,
    operation: input.operation,
    status: input.status,
    completeness: {
      complete: input.status === "success" && completenessReasons.length === 0,
      reasons: completenessReasons,
    },
    results,
    diagnostics,
    diagnosticSummary: {
      returned: diagnostics.length,
      omitted: diagnosticsOmitted,
      byCode: summarizeDiagnostics(diagnostics, omittedByCode),
    },
    usage: {
      limitProfile: LIMIT_PROFILE,
      textCharsReturned: countReturnedTextScalars(results),
      resultBytes: 0,
      recordsReturned: results.length,
      diagnosticsReturned: diagnostics.length,
      diagnosticsOmitted,
      effectiveLimits: input.effectiveLimits,
      ...input.usage,
    },
  };

  settleResultBytes(envelope);
  return envelope;
}

export function serializeCanonicalEnvelope(
  envelope: ResultEnvelope<unknown>,
): Uint8Array {
  settleResultBytes(envelope);
  return Buffer.from(`${canonicalStringify(envelope)}\n`, "utf8");
}

function settleResultBytes(envelope: ResultEnvelope<unknown>): void {
  let previous = -1;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const bytes = Buffer.byteLength(`${canonicalStringify(envelope)}\n`, "utf8");
    envelope.usage.resultBytes = bytes;
    if (bytes === previous) {
      return;
    }
    previous = bytes;
  }
  throw new Error("usage.resultBytes did not converge");
}

function summarizeDiagnostics(
  diagnostics: readonly Diagnostic[],
  omittedByCode: Readonly<Record<string, number>>,
): readonly DiagnosticCount[] {
  const counts = new Map<string, number>();
  for (const diagnostic of diagnostics) {
    counts.set(diagnostic.code, (counts.get(diagnostic.code) ?? 0) + 1);
  }
  for (const [code, count] of Object.entries(omittedByCode)) {
    counts.set(code, (counts.get(code) ?? 0) + count);
  }
  return [...counts]
    .sort(([left], [right]) => compareUnicodeScalars(left, right))
    .map(([code, count]) => ({ code, count }));
}

function countReturnedTextScalars(value: unknown): number {
  let total = 0;
  visit(value, (key, child) => {
    if (
      typeof child === "string" &&
      (key === "text" || key === "beforeContext" || key === "afterContext")
    ) {
      total += Array.from(child).length;
    }
  });
  return total;
}

function visit(
  value: unknown,
  visitor: (key: string, value: unknown) => void,
): void {
  if (Array.isArray(value)) {
    for (const child of value) {
      visit(child, visitor);
    }
    return;
  }
  if (typeof value !== "object" || value === null) {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    visitor(key, child);
    visit(child, visitor);
  }
}

function canonicalStringify(value: unknown): string {
  return JSON.stringify(sortObjectKeys(value));
}

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortObjectKeys);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareUnicodeScalars(left, right))
      .map(([key, child]) => [key, sortObjectKeys(child)]),
  );
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
