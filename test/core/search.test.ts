import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  type SearchSummaryRecord,
  Workspace,
  encodeStrict,
  executeSearch,
  serializeCanonicalEnvelope,
} from "../../src/index.js";

test("SEARCH paths count returns only an exact summary", async (context) => {
  const { root, workspace } = await createWorkspace(context);
  await Promise.all([
    writeFile(join(root, "a.md"), "a"),
    writeFile(join(root, "b.txt"), "b"),
  ]);

  const envelope = await executeSearch(workspace, {
    mode: "paths",
    projection: "count",
  });
  const summary = envelope.results[0] as SearchSummaryRecord;
  assert.equal(envelope.status, "success");
  assert.equal(envelope.results.length, 1);
  assert.equal(summary.filesMatched, 2);
  assert.equal(summary.filesMatchedAtLeast, null);
});

test("SEARCH paths files honors include, exclude, and ordering", async (
  context,
) => {
  const { root, workspace } = await createWorkspace(context);
  await mkdir(join(root, "docs"));
  await Promise.all([
    writeFile(join(root, "root.md"), "root"),
    writeFile(join(root, "docs", "a.md"), "a"),
    writeFile(join(root, "docs", "b.txt"), "b"),
  ]);

  const envelope = await executeSearch(workspace, {
    mode: "paths",
    projection: "files",
    include: ["**/*.md"],
    exclude: ["root.md"],
  });
  assert.deepEqual(
    envelope.results.slice(1).map((record) => record.type === "file" && record.path),
    ["docs/a.md"],
  );
});

test("SEARCH paths summary returns deterministic facets", async (context) => {
  const { root, workspace } = await createWorkspace(context);
  await mkdir(join(root, "docs"));
  await Promise.all([
    writeFile(join(root, "README.md"), "root"),
    writeFile(join(root, "docs", "a.md"), "a"),
    writeFile(join(root, "docs", "b.txt"), "b"),
  ]);

  const envelope = await executeSearch(workspace, {
    mode: "paths",
    projection: "summary",
  });
  const facets = envelope.results.filter((record) => record.type === "facet");
  assert.ok(
    facets.some(
      (record) =>
        record.type === "facet" &&
        record.facet === "extension" &&
        record.value === ".md" &&
        record.files === 2,
    ),
  );
});

test("SEARCH content returns one match per matching logical line", async (
  context,
) => {
  const { root, workspace } = await createWorkspace(context);
  await writeFile(
    join(root, "sample.txt"),
    "TODO and TODO\nnothing\nTODO last\n",
  );

  const envelope = await executeSearch(workspace, {
    mode: "content",
    projection: "matches",
    syntax: "literal",
    pattern: "TODO",
    beforeContext: 1,
    afterContext: 1,
  });
  const matches = envelope.results.filter((record) => record.type === "match");
  assert.equal(matches.length, 2);
  assert.equal(matches[0]?.line, 1);
  assert.equal(matches[0]?.text, "TODO and TODO");
  assert.deepEqual(matches[0]?.afterContext, [
    { line: 2, text: "nothing" },
  ]);
  const summary = envelope.results[0] as SearchSummaryRecord;
  assert.equal(summary.matchesFound, 2);
  assert.equal(summary.filesMatched, 1);
});

test("SEARCH content regex uses Unicode simple case folding", async (
  context,
) => {
  const { root, workspace } = await createWorkspace(context);
  await writeFile(join(root, "sample.txt"), "Σ\nς\nS\n");

  const envelope = await executeSearch(workspace, {
    mode: "content",
    projection: "count",
    syntax: "regex",
    pattern: "^σ$",
    caseSensitive: false,
  });
  const summary = envelope.results[0] as SearchSummaryRecord;
  assert.equal(summary.matchesFound, 2);
});

test("SEARCH content files returns firstMatchLine without source text", async (
  context,
) => {
  const { root, workspace } = await createWorkspace(context);
  await writeFile(join(root, "sample.txt"), "none\nhit\nhit\n");

  const envelope = await executeSearch(workspace, {
    mode: "content",
    projection: "files",
    pattern: "hit",
  });
  const file = envelope.results.find((record) => record.type === "file");
  assert.equal(file?.type, "file");
  assert.equal(file?.firstMatchLine, 2);
  const summary = envelope.results[0] as SearchSummaryRecord;
  assert.equal(summary.matchesFound, null);
  assert.equal(summary.matchesFoundAtLeast, 1);
});

test("SEARCH maxMatches returns explicit lower-bound partial results", async (
  context,
) => {
  const { root, workspace } = await createWorkspace(context);
  await writeFile(join(root, "sample.txt"), "hit\nhit\nhit\n");

  const envelope = await executeSearch(workspace, {
    mode: "content",
    projection: "matches",
    pattern: "hit",
    limits: {
      maxMatches: 1,
      maxMatchesPerFile: 10,
    },
  });
  const summary = envelope.results[0] as SearchSummaryRecord;
  assert.equal(envelope.status, "partial");
  assert.equal(summary.matchesReturned, 1);
  assert.equal(summary.matchesFound, null);
  assert.ok((summary.matchesFoundAtLeast ?? 0) >= 2);
  assert.ok(envelope.completeness.reasons.includes("match_limit"));
});

test("SEARCH reports an undecodable candidate without hiding partial status", async (
  context,
) => {
  const { root, workspace } = await createWorkspace(context);
  await writeFile(join(root, "valid.txt"), "hit\n");
  await writeFile(
    join(root, "legacy.txt"),
    encodeStrict("髙﨑", "windows-31j"),
  );

  const envelope = await executeSearch(workspace, {
    mode: "content",
    projection: "count",
    pattern: "hit",
  });
  const summary = envelope.results[0] as SearchSummaryRecord;
  assert.equal(envelope.status, "partial");
  assert.equal(summary.filesSkipped, 1);
  assert.equal(summary.filesMatched, null);
  assert.equal(envelope.diagnostics[0]?.code, "encoding_undetermined");
});

test("SEARCH enforces canonical result byte budget", async (context) => {
  const { root, workspace } = await createWorkspace(context);
  const content = Array.from(
    { length: 100 },
    (_, index) => `hit-${index}-${"x".repeat(30)}\n`,
  ).join("");
  await writeFile(join(root, "many.txt"), content);

  const envelope = await executeSearch(workspace, {
    mode: "content",
    projection: "matches",
    pattern: "hit",
    limits: {
      maxResultBytes: 4_096,
      maxMatches: 100,
      maxMatchesPerFile: 100,
      maxTextCharsReturned: 10_000,
    },
  });
  const bytes = serializeCanonicalEnvelope(envelope);
  assert.ok(bytes.byteLength <= 4_096);
  assert.equal(envelope.usage.resultBytes, bytes.byteLength);
  assert.ok(envelope.completeness.reasons.includes("result_byte_limit"));
});

test("SEARCH reports context trimming as partial", async (context) => {
  const { workspace } = await createWorkspace(context, {
    "context.txt": "before\nHIT\nafter\n",
  });
  const envelope = await executeSearch(workspace, {
    mode: "content",
    pattern: "HIT",
    beforeContext: 1,
    afterContext: 1,
    limits: { maxTextCharsReturned: 3 },
  });

  assert.equal(envelope.status, "partial");
  assert.ok(envelope.completeness.reasons.includes("text_char_limit"));
  const match = envelope.results.find((record) => record.type === "match");
  assert.deepEqual(match?.beforeContext, []);
  assert.deepEqual(match?.afterContext, []);
});

test("SEARCH diagnostic summary includes omitted diagnostics by code", async (
  context,
) => {
  const { workspace } = await createWorkspace(context, {
    "bad-a.bin": Uint8Array.from([0xff]),
    "bad-b.bin": Uint8Array.from([0xff]),
    "bad-c.bin": Uint8Array.from([0xff]),
  });
  const envelope = await executeSearch(workspace, {
    mode: "content",
    projection: "count",
    pattern: "x",
    limits: { maxDiagnostics: 1 },
  });

  assert.equal(envelope.diagnosticSummary.returned, 1);
  assert.equal(envelope.diagnosticSummary.omitted, 2);
  assert.deepEqual(envelope.diagnosticSummary.byCode, [
    { code: "encoding_undetermined", count: 3 },
  ]);
});

test("SEARCH maxFilesVisited stops before later directory diagnostics", async (
  context,
) => {
  const { root, workspace } = await createWorkspace(context, {
    "a.txt": "a\n",
  });
  await mkdir(join(root, "z-later"));
  await writeFile(
    join(root, "z-later", ".gitignore"),
    Uint8Array.from([0xff]),
  );
  const envelope = await executeSearch(workspace, {
    mode: "paths",
    projection: "count",
    limits: { maxFilesVisited: 1 },
  });

  assert.equal(envelope.usage.filesVisited, 1);
  assert.ok(envelope.completeness.reasons.includes("file_visit_limit"));
  assert.equal(
    envelope.diagnostics.some(
      (diagnostic) => diagnostic.code === "source_error",
    ),
    false,
  );
});

test("SEARCH matches stops reading after result record admission fails", async (
  context,
) => {
  const first = `${"x".repeat(5_000)}\n`;
  const { workspace } = await createWorkspace(context, {
    "a.txt": first,
    "z-bad.bin": Uint8Array.from([0xff]),
  });
  const envelope = await executeSearch(workspace, {
    mode: "content",
    pattern: "x",
    limits: {
      maxResultBytes: 4_096,
      maxTextCharsReturned: 6_000,
    },
  });

  assert.equal(envelope.usage.filesVisited, 1);
  assert.equal(envelope.usage.bytesRead, Buffer.byteLength(first));
  assert.ok(envelope.completeness.reasons.includes("result_byte_limit"));
  assert.equal(envelope.diagnostics.length, 0);
});

test("SEARCH files stops reading after result record admission fails", async (
  context,
) => {
  const { root, workspace } = await createWorkspace(context);
  for (let index = 0; index < 40; index += 1) {
    const name =
      `a-${index.toString().padStart(2, "0")}-` +
      `${"p".repeat(180)}.txt`;
    await writeFile(join(root, name), "match\n");
  }
  await writeFile(join(root, "z-bad.bin"), Uint8Array.from([0xff]));

  const envelope = await executeSearch(workspace, {
    mode: "content",
    projection: "files",
    pattern: "match",
    limits: { maxResultBytes: 4_096 },
  });

  assert.ok((envelope.usage.filesVisited ?? 0) < 41);
  assert.ok(envelope.completeness.reasons.includes("result_byte_limit"));
  assert.equal(envelope.diagnostics.length, 0);
});

async function createWorkspace(
  context: test.TestContext,
  files: Readonly<Record<string, string | Uint8Array>> = {},
): Promise<{ root: string; workspace: Workspace }> {
  const root = await mkdtemp(join(tmpdir(), "miku-text-file-ops-search-"));
  context.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(root, path), content);
  }
  return { root, workspace: await Workspace.open(root) };
}
