import assert from "node:assert/strict";
import test from "node:test";
import {
  RepositoryConfigError,
  parseRepositoryTextPolicy,
} from "../../src/index.js";

test("repository text policy resolves encoding rules and legacy fallback", () => {
  const policy = parseRepositoryTextPolicy({
    schemaVersion: 1,
    encodingRules: [
      { glob: "legacy/**/*.txt", encoding: "windows-31j" },
      { glob: "*.utf16", encoding: "utf-16le" },
    ],
    legacyFallback: "windows-31j",
    defaultCreate: {
      encoding: "utf-8",
      lineEnding: "lf",
      bom: false,
    },
  });

  assert.equal(
    policy.repositoryEncoding("legacy/nested/data.txt"),
    "windows-31j",
  );
  assert.equal(policy.repositoryEncoding("nested/data.utf16"), "utf-16le");
  assert.equal(policy.repositoryEncoding("modern.txt"), undefined);
  assert.equal(policy.legacyFallback, "windows-31j");
  assert.deepEqual(policy.defaultCreate, {
    encoding: "utf-8",
    lineEnding: "lf",
    bom: false,
  });
  assert.deepEqual(policy.defaults, policy.defaultCreate);
});

test("repository text policy accepts defaults and rejects ambiguous aliases", () => {
  const policy = parseRepositoryTextPolicy({
    schemaVersion: 1,
    defaults: {
      encoding: "windows-31j",
      lineEnding: "crlf",
      bom: false,
    },
  });

  assert.deepEqual(policy.defaults, {
    encoding: "windows-31j",
    lineEnding: "crlf",
    bom: false,
  });
  assert.deepEqual(policy.defaultCreate, policy.defaults);
  assert.throws(
    () =>
      parseRepositoryTextPolicy({
        schemaVersion: 1,
        defaults: {
          encoding: "utf-8",
          lineEnding: "lf",
          bom: false,
        },
        defaultCreate: {
          encoding: "utf-8",
          lineEnding: "lf",
          bom: false,
        },
      }),
    RepositoryConfigError,
  );
});

test("repository text policy rejects malformed configuration", () => {
  assert.throws(
    () =>
      parseRepositoryTextPolicy({
        schemaVersion: 1,
        encodingRules: [{ glob: "[", encoding: "windows-31j" }],
      }),
    RepositoryConfigError,
  );
  assert.throws(
    () =>
      parseRepositoryTextPolicy({
        schemaVersion: 2,
        encodingRules: [],
      }),
    RepositoryConfigError,
  );
});
