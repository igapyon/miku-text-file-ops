import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  SafeRegexError,
  compileSafeRegex,
  simpleCaseFold,
  type SafeRegexErrorCode,
} from "../../src/index.js";

interface MatchingFixture {
  name: string;
  pattern: string;
  caseSensitive: boolean;
  matches: string[];
  misses: string[];
}

interface InvalidFixture {
  name: string;
  pattern: string;
  code: SafeRegexErrorCode;
}

interface FixtureFile {
  matching: MatchingFixture[];
  invalid: InvalidFixture[];
}

const fixtures = JSON.parse(
  readFileSync(
    resolve("test/fixtures/regex/safe-regex-v1.json"),
    "utf8",
  ),
) as FixtureFile;

for (const fixture of fixtures.matching) {
  test(`safe-regex matching: ${fixture.name}`, () => {
    const regex = compileSafeRegex(fixture.pattern, {
      caseSensitive: fixture.caseSensitive,
    });
    for (const line of fixture.matches) {
      assert.equal(regex.matchesLine(line), true, `expected match: ${line}`);
    }
    for (const line of fixture.misses) {
      assert.equal(regex.matchesLine(line), false, `expected miss: ${line}`);
    }
  });
}

for (const fixture of fixtures.invalid) {
  test(`safe-regex rejection: ${fixture.name}`, () => {
    assert.throws(
      () => compileSafeRegex(fixture.pattern),
      (error: unknown) => {
        assert.ok(error instanceof SafeRegexError);
        assert.equal(error.code, fixture.code);
        return true;
      },
    );
  });
}

test("safe-regex rejects an empty pattern", () => {
  assert.throws(
    () => compileSafeRegex(""),
    (error: unknown) => {
      assert.ok(error instanceof SafeRegexError);
      assert.equal(error.code, "pattern_empty");
      return true;
    },
  );
});

test("safe-regex rejects a pattern above 4096 Unicode scalars", () => {
  assert.throws(
    () => compileSafeRegex("a".repeat(4_097)),
    (error: unknown) => {
      assert.ok(error instanceof SafeRegexError);
      assert.equal(error.code, "pattern_too_large");
      return true;
    },
  );
});

test("Unicode 17 simple folding is locale-independent and one-to-one", () => {
  assert.equal(simpleCaseFold("ΣςK"), "σσk");
  assert.equal(simpleCaseFold("ß"), "ß");
});
