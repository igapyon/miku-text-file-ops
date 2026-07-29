export const SCHEMA_VERSION = "miku-text-file-ops/v1" as const;
export const LIMIT_PROFILE = "agent-v1" as const;

export type Operation = "search" | "read" | "create" | "update" | "delete";
export type ResultStatus = "success" | "partial" | "failed";
export type DiagnosticSeverity = "info" | "warning" | "error";

export interface Diagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  path?: string;
  line?: number;
  byteOffset?: number;
  details?: Readonly<Record<string, unknown>>;
}

export interface Completeness {
  complete: boolean;
  reasons: readonly string[];
}

export interface DiagnosticCount {
  code: string;
  count: number;
}

export interface DiagnosticSummary {
  returned: number;
  omitted: number;
  byCode: readonly DiagnosticCount[];
}

export const AGENT_V1_LIMITS = {
  maxResultBytes: 32_768,
  maxTextCharsReturned: 16_384,
  maxDiagnostics: 50,
  maxFilesVisited: 10_000,
  maxSourceBytes: 268_435_456,
  maxMatches: 100,
  maxMatchesPerFile: 10,
  maxFilesReturned: 100,
  maxFacetValues: 10,
  maxItems: 8,
  maxLinesPerItem: 400,
} as const;

export type LimitName = keyof typeof AGENT_V1_LIMITS;
export type Limits = Partial<Record<LimitName, number>>;
export type EffectiveLimits = Record<LimitName, number>;

export interface Usage {
  limitProfile: typeof LIMIT_PROFILE;
  textCharsReturned: number;
  resultBytes: number;
  recordsReturned: number;
  diagnosticsReturned: number;
  diagnosticsOmitted: number;
  effectiveLimits: Readonly<EffectiveLimits>;
  filesVisited?: number;
  bytesRead?: number;
  itemsRequested?: number;
  itemsProcessed?: number;
  itemsSkipped?: number;
  nextItemIndex?: number;
}

export interface ResultEnvelope<TResult = Readonly<Record<string, unknown>>> {
  schemaVersion: typeof SCHEMA_VERSION;
  operation: Operation;
  status: ResultStatus;
  completeness: Completeness;
  results: readonly TResult[];
  diagnostics: readonly Diagnostic[];
  diagnosticSummary: DiagnosticSummary;
  usage: Usage;
}

export function effectiveAgentV1Limits(overrides: Limits = {}): EffectiveLimits {
  return {
    ...AGENT_V1_LIMITS,
    ...overrides,
  };
}
