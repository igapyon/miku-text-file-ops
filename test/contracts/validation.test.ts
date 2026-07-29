import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_V1_LIMITS,
  RequestValidationError,
  rejectUnknownFields,
  validateLimits,
} from "../../src/index.js";

test("validateLimits returns the complete agent-v1 profile", () => {
  assert.deepEqual(validateLimits(undefined), AGENT_V1_LIMITS);
});

test("validateLimits accepts positive integer overrides", () => {
  const limits = validateLimits({
    maxResultBytes: 8_192,
    maxMatches: 12,
  });
  assert.equal(limits.maxResultBytes, 8_192);
  assert.equal(limits.maxMatches, 12);
  assert.equal(limits.maxFilesVisited, AGENT_V1_LIMITS.maxFilesVisited);
});

test("validateLimits rejects unknown and invalid fields together", () => {
  assert.throws(
    () => validateLimits({ maxMatches: 0, maxMaches: 10 }),
    (error: unknown) => {
      assert.ok(error instanceof RequestValidationError);
      assert.deepEqual(
        error.diagnostics.map((diagnostic) => diagnostic.code),
        ["invalid_limit", "unknown_field"],
      );
      return true;
    },
  );
});
test("validateLimits rejects a result budget below the normative floor", () => {
  assert.throws(
    () => validateLimits({ maxResultBytes: 4_095 }),
    (error: unknown) => {
      assert.ok(error instanceof RequestValidationError);
      assert.equal(error.diagnostics[0]?.code, "result_budget_too_small");
      return true;
    },
  );
});

test("rejectUnknownFields reports fields deterministically", () => {
  assert.throws(
    () =>
      rejectUnknownFields(
        { mode: "paths", z: true, a: true },
        new Set(["mode"]),
      ),
    (error: unknown) => {
      assert.ok(error instanceof RequestValidationError);
      assert.deepEqual(
        error.diagnostics.map((diagnostic) => diagnostic.details?.["field"]),
        ["request.a", "request.z"],
      );
      return true;
    },
  );
});
