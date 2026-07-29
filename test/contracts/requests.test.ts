import assert from "node:assert/strict";
import test from "node:test";
import {
  RequestValidationError,
  validateCreateRequest,
  validateDeleteRequest,
  validateReadRequest,
  validateSearchRequest,
  validateUpdateRequest,
} from "../../src/index.js";

const REVISION = `sha256:${"a".repeat(64)}`;

test("path search applies projection and facet defaults", () => {
  const request = validateSearchRequest({ mode: "paths" });
  assert.equal(request.mode, "paths");
  assert.equal(request.projection, "files");
  assert.deepEqual(request.facets, []);
  assert.equal(request.effectiveLimits.maxFilesVisited, 10_000);
});

test("content summary applies syntax, matching, and facet defaults", () => {
  const request = validateSearchRequest({
    mode: "content",
    projection: "summary",
    pattern: "TODO",
  });
  assert.equal(request.mode, "content");
  assert.equal(request.projection, "summary");
  assert.equal(request.syntax, "literal");
  assert.equal(request.caseSensitive, true);
  assert.deepEqual(request.facets, ["extension", "topLevelPath"]);
});

test("path mode rejects matches projection", () => {
  assertValidationCode(
    () =>
      validateSearchRequest({
        mode: "paths",
        projection: "matches",
      }),
    "projection_not_supported",
  );
});

test("search rejects projection-inapplicable fields and limits", () => {
  assertValidationCode(
    () =>
      validateSearchRequest({
        mode: "content",
        projection: "count",
        pattern: "TODO",
        beforeContext: 1,
      }),
    "field_not_applicable",
  );
  assertValidationCode(
    () =>
      validateSearchRequest({
        mode: "paths",
        projection: "count",
        limits: { maxMatches: 10 },
      }),
    "field_not_applicable",
  );
});

test("search rejects unknown fields and unknown limits", () => {
  assertValidationCode(
    () => validateSearchRequest({ mode: "paths", projecton: "count" }),
    "unknown_field",
  );
  assertValidationCode(
    () =>
      validateSearchRequest({
        mode: "paths",
        limits: { maxFilseVisited: 10 },
      }),
    "unknown_field",
  );
});

test("read requires one explicit selector per item", () => {
  const request = validateReadRequest({
    items: [
      { path: "README.md", firstLines: 20 },
      {
        path: "legacy/data.txt",
        encoding: "windows-31j",
        range: { startLine: 5, endLine: 8 },
      },
    ],
  });
  assert.deepEqual(request.items[0]?.selector, { firstLines: 20 });
  assert.equal(request.items[1]?.encoding, "windows-31j");

  assertValidationCode(
    () =>
      validateReadRequest({
        items: [{ path: "README.md", full: true, firstLines: 10 }],
      }),
    "invalid_selector",
  );
});

test("read validates ranges and limit applicability", () => {
  assertValidationCode(
    () =>
      validateReadRequest({
        items: [
          {
            path: "README.md",
            range: { startLine: 10, endLine: 2 },
          },
        ],
      }),
    "invalid_range",
  );
  assertValidationCode(
    () =>
      validateReadRequest({
        items: [{ path: "README.md", full: true }],
        limits: { maxMatches: 2 },
      }),
    "field_not_applicable",
  );
});

test("create defaults to UTF-8 LF without BOM", () => {
  assert.deepEqual(
    validateCreateRequest({
      path: "new/file.txt",
      content: "hello\n",
    }),
    {
      path: "new/file.txt",
      content: "hello\n",
      writeAs: {
        encoding: "utf-8",
        lineEnding: "lf",
        bom: false,
      },
    },
  );
});

test("update validates its discriminated change and preserve defaults", () => {
  assert.deepEqual(
    validateUpdateRequest({
      path: "docs/specification.md",
      expectedRevision: REVISION,
      change: {
        type: "context-diff",
        diff: "@@\n-old\n+new\n",
      },
    }),
    {
      path: "docs/specification.md",
      expectedRevision: REVISION,
      change: {
        type: "context-diff",
        diff: "@@\n-old\n+new\n",
      },
      writeAs: {
        encoding: "preserve",
        lineEnding: "preserve",
        bom: "preserve",
      },
    },
  );
});

test("mutation paths protect .git and revisions are canonical", () => {
  assertValidationCode(
    () =>
      validateDeleteRequest({
        path: ".git/config",
        expectedRevision: REVISION,
      }),
    "protected_path",
  );
  assertValidationCode(
    () =>
      validateDeleteRequest({
        path: "file.txt",
        expectedRevision: "sha256:ABC",
      }),
    "invalid_revision",
  );
});

test("workspace paths reject absolute, parent, backslash, and empty segments", () => {
  for (const path of [
    "/absolute.txt",
    "../outside.txt",
    "dir/../outside.txt",
    "dir\\file.txt",
    "dir//file.txt",
    "C:/file.txt",
  ]) {
    assertValidationCode(
      () =>
        validateReadRequest({
          items: [{ path, full: true }],
        }),
      "path_escape",
    );
  }
});

function assertValidationCode(
  operation: () => unknown,
  expectedCode: string,
): void {
  assert.throws(operation, (error: unknown) => {
    assert.ok(error instanceof RequestValidationError);
    assert.equal(error.diagnostics[0]?.code, expectedCode);
    return true;
  });
}
