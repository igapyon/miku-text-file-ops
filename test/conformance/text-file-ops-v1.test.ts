import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  type CanonicalEncoding,
  MutationError,
  TextDecodingError,
  Workspace,
  decodeStrict,
  decodeTextFile,
  executeCreate,
  executeRead,
  executeSearch,
  executeUpdate,
  serializeCanonicalEnvelope,
} from "../../src/index.js";

interface Corpus {
  formatVersion: number;
  byteEncoding: string;
  decoding: DecodingCase[];
  logicalText: LogicalTextCase[];
  mutations: MutationCase[];
  budgets: BudgetCase[];
  canonicalResponses: CanonicalCase[];
}

interface DecodingCase {
  name: string;
  encoding: CanonicalEncoding;
  inputHex: string;
  expectedText?: string;
  expectedError?: { code: string; byteOffset: number };
}

interface LogicalTextCase {
  name: string;
  encoding: CanonicalEncoding;
  inputHex: string;
  expected: {
    lineEnding: string;
    finalNewline: boolean;
    logicalLines: number;
    revision: string;
  };
}

interface MutationCase {
  name: string;
  initialHex?: string;
  repositoryEncoding?: CanonicalEncoding;
  request: Record<string, unknown>;
  expectedOutputHex?: string;
  expectedError?: { code: string };
}

interface FixtureFile {
  path: string;
  hex: string;
}

interface BudgetCase {
  name: string;
  operation: "read" | "search";
  files: FixtureFile[];
  request: unknown;
  expected: Record<string, unknown>;
}

interface CanonicalCase {
  name: string;
  operation: "search";
  files: FixtureFile[];
  request: unknown;
  expectedUtf8: string;
}

const corpus = JSON.parse(
  readFileSync(
    resolve("test/fixtures/conformance/text-file-ops-v1.json"),
    "utf8",
  ),
) as Corpus;

test("conformance corpus format is explicit and runtime-independent", () => {
  assert.equal(corpus.formatVersion, 1);
  assert.equal(corpus.byteEncoding, "lowercase-hex");
});

for (const fixture of corpus.decoding) {
  test(`conformance decode: ${fixture.name}`, () => {
    const bytes = bytesFromHex(fixture.inputHex);
    if (fixture.expectedError !== undefined) {
      assert.throws(
        () => decodeStrict(bytes, fixture.encoding),
        (error: unknown) => {
          assert.ok(error instanceof TextDecodingError);
          assert.equal("decode_error", fixture.expectedError?.code);
          assert.equal(error.byteOffset, fixture.expectedError?.byteOffset);
          return true;
        },
      );
    } else {
      assert.equal(decodeStrict(bytes, fixture.encoding), fixture.expectedText);
    }
  });
}

for (const fixture of corpus.logicalText) {
  test(`conformance logical text: ${fixture.name}`, () => {
    const decoded = decodeTextFile(bytesFromHex(fixture.inputHex), {
      explicitEncoding: fixture.encoding,
    });
    assert.equal(decoded.lineEnding, fixture.expected.lineEnding);
    assert.equal(decoded.finalNewline, fixture.expected.finalNewline);
    assert.equal(decoded.logicalLines, fixture.expected.logicalLines);
    assert.equal(decoded.revision, fixture.expected.revision);
  });
}

for (const fixture of corpus.mutations) {
  test(`conformance mutation: ${fixture.name}`, async (context) => {
    const { root, workspace } = await fixtureWorkspace(context, []);
    const path = String(fixture.request["path"]);
    if (fixture.initialHex !== undefined) {
      await writeFile(join(root, path), bytesFromHex(fixture.initialHex));
    }

    if (fixture.expectedError !== undefined) {
      await assert.rejects(
        executeUpdate(workspace, fixture.request),
        (error: unknown) => {
          assert.ok(error instanceof MutationError);
          assert.equal(error.code, fixture.expectedError?.code);
          return true;
        },
      );
      return;
    }

    if (fixture.initialHex === undefined) {
      await executeCreate(workspace, fixture.request);
    } else {
      await executeUpdate(workspace, fixture.request, {
        repositoryEncoding: () => fixture.repositoryEncoding,
      });
    }
    assert.equal(
      (await readFile(join(root, path))).toString("hex"),
      fixture.expectedOutputHex,
    );
  });
}

for (const fixture of corpus.budgets) {
  test(`conformance budget: ${fixture.name}`, async (context) => {
    const { workspace } = await fixtureWorkspace(context, fixture.files);
    const envelope =
      fixture.operation === "read"
        ? await executeRead(workspace, fixture.request)
        : await executeSearch(workspace, fixture.request);
    assert.equal(envelope.status, fixture.expected["status"]);
    if (fixture.operation === "read") {
      assert.equal(
        envelope.usage.recordsReturned,
        fixture.expected["recordsReturned"],
      );
      assert.equal(
        envelope.usage.itemsProcessed,
        fixture.expected["itemsProcessed"],
      );
    } else {
      assert.equal(
        envelope.diagnosticSummary.returned,
        fixture.expected["diagnosticsReturned"],
      );
      assert.equal(
        envelope.diagnosticSummary.omitted,
        fixture.expected["diagnosticsOmitted"],
      );
      assert.deepEqual(envelope.diagnosticSummary.byCode, [
        {
          code: fixture.expected["diagnosticCode"],
          count: fixture.expected["diagnosticCount"],
        },
      ]);
    }
  });
}

for (const fixture of corpus.canonicalResponses) {
  test(`conformance canonical response: ${fixture.name}`, async (context) => {
    const { workspace } = await fixtureWorkspace(context, fixture.files);
    const envelope = await executeSearch(workspace, fixture.request);
    assert.equal(
      Buffer.from(serializeCanonicalEnvelope(envelope)).toString("utf8"),
      fixture.expectedUtf8,
    );
  });
}

function bytesFromHex(hex: string): Uint8Array {
  assert.match(hex, /^(?:[0-9a-f]{2})*$/u);
  return Buffer.from(hex, "hex");
}

async function fixtureWorkspace(
  context: test.TestContext,
  files: readonly FixtureFile[],
): Promise<{ root: string; workspace: Workspace }> {
  const root = await mkdtemp(join(tmpdir(), "miku-text-file-ops-corpus-"));
  context.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  for (const file of files) {
    await writeFile(join(root, file.path), bytesFromHex(file.hex));
  }
  return { root, workspace: await Workspace.open(root) };
}
