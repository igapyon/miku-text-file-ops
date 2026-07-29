import assert from "node:assert/strict";
import test from "node:test";
import {
  createEnvelope,
  effectiveAgentV1Limits,
  serializeCanonicalEnvelope,
} from "../../src/index.js";

test("envelope derives summaries, scalar counts, and exact serialized bytes", () => {
  const envelope = createEnvelope({
    operation: "read",
    status: "partial",
    completenessReasons: ["line_limit"],
    effectiveLimits: effectiveAgentV1Limits(),
    results: [
      {
        type: "read",
        text: "A🎵",
      },
    ],
    diagnostics: [
      {
        severity: "warning",
        code: "line_limit",
        message: "The line limit was reached",
      },
      {
        severity: "warning",
        code: "line_limit",
        message: "A second item also reached the line limit",
      },
    ],
  });

  const bytes = serializeCanonicalEnvelope(envelope);
  assert.equal(envelope.usage.textCharsReturned, 2);
  assert.equal(envelope.usage.resultBytes, bytes.byteLength);
  assert.equal(bytes.at(-1), 0x0a);
  assert.deepEqual(envelope.diagnosticSummary.byCode, [
    { code: "line_limit", count: 2 },
  ]);
});

test("canonical serialization is stable across object insertion order", () => {
  const common = {
    operation: "search" as const,
    status: "success" as const,
    effectiveLimits: effectiveAgentV1Limits(),
  };
  const left = createEnvelope({
    ...common,
    results: [{ type: "example", alpha: 1, beta: 2 }],
  });
  const right = createEnvelope({
    ...common,
    results: [{ beta: 2, alpha: 1, type: "example" }],
  });

  assert.deepEqual(
    serializeCanonicalEnvelope(left),
    serializeCanonicalEnvelope(right),
  );
});
