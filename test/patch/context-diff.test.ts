import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  ContextDiffError,
  applyContextDiff,
  type ContextDiffErrorCode,
  type PatchLineEnding,
} from "../../src/index.js";

interface SuccessFixture {
  name: string;
  source: string;
  diff: string;
  lineEnding: PatchLineEnding;
  expected: string;
  hunksApplied: number;
  linesAdded: number;
  linesRemoved: number;
}

interface FailureFixture {
  name: string;
  source: string;
  diff: string;
  code: ContextDiffErrorCode;
}

interface FixtureFile {
  success: SuccessFixture[];
  failure: FailureFixture[];
}

const fixtures = JSON.parse(
  readFileSync(
    resolve("test/fixtures/patch/context-diff-v1.json"),
    "utf8",
  ),
) as FixtureFile;

for (const fixture of fixtures.success) {
  test(`context-diff success: ${fixture.name}`, () => {
    assert.deepEqual(
      applyContextDiff(fixture.source, fixture.diff, fixture.lineEnding),
      {
        text: fixture.expected,
        hunksApplied: fixture.hunksApplied,
        linesAdded: fixture.linesAdded,
        linesRemoved: fixture.linesRemoved,
      },
    );
  });
}

for (const fixture of fixtures.failure) {
  test(`context-diff failure: ${fixture.name}`, () => {
    assert.throws(
      () => applyContextDiff(fixture.source, fixture.diff),
      (error: unknown) => {
        assert.ok(error instanceof ContextDiffError);
        assert.equal(error.code, fixture.code);
        return true;
      },
    );
  });
}
