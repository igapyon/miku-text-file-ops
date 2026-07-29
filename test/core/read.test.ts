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
  Workspace,
  encodeStrict,
  executeRead,
  serializeCanonicalEnvelope,
} from "../../src/index.js";

test("READ returns a bounded LF view with complete file metadata", async (
  context,
) => {
  const { root, workspace } = await createWorkspace(context);
  await writeFile(join(root, "sample.txt"), "one\r\ntwo\r\nthree");

  const envelope = await executeRead(workspace, {
    items: [
      {
        path: "sample.txt",
        range: { startLine: 2, endLine: 3 },
      },
    ],
  });

  assert.equal(envelope.status, "success");
  assert.equal(envelope.results[0]?.text, "two\nthree");
  assert.deepEqual(envelope.results[0]?.returnedRange, {
    startLine: 2,
    endLine: 3,
  });
  assert.equal(envelope.results[0]?.lineEnding, "crlf");
  assert.equal(envelope.results[0]?.finalNewline, false);
  assert.equal(envelope.results[0]?.logicalLines, 3);
  assert.match(
    envelope.results[0]?.revision ?? "",
    /^sha256:[0-9a-f]{64}$/u,
  );
});

test("READ lastLines keeps the largest suffix under line limit", async (
  context,
) => {
  const { root, workspace } = await createWorkspace(context);
  await writeFile(join(root, "sample.txt"), "one\ntwo\nthree\nfour\n");

  const envelope = await executeRead(workspace, {
    items: [{ path: "sample.txt", lastLines: 4 }],
    limits: { maxLinesPerItem: 2 },
  });

  assert.equal(envelope.status, "partial");
  assert.equal(envelope.results[0]?.text, "three\nfour\n");
  assert.deepEqual(envelope.results[0]?.remainingRanges, [
    { startLine: 1, endLine: 2 },
  ]);
  assert.deepEqual(envelope.completeness.reasons, ["line_limit"]);
});

test("READ stops at a whole-line text-character boundary", async (context) => {
  const { root, workspace } = await createWorkspace(context);
  await writeFile(join(root, "sample.txt"), "abc\ndef\nghi\n");

  const envelope = await executeRead(workspace, {
    items: [{ path: "sample.txt", full: true }],
    limits: { maxTextCharsReturned: 8 },
  });

  assert.equal(envelope.results[0]?.text, "abc\ndef\n");
  assert.deepEqual(envelope.results[0]?.remainingRanges, [
    { startLine: 3, endLine: 3 },
  ]);
  assert.ok(envelope.completeness.reasons.includes("text_char_limit"));
});

test("READ reports a logical line that cannot fit by itself", async (
  context,
) => {
  const { root, workspace } = await createWorkspace(context);
  await writeFile(join(root, "large.txt"), `${"x".repeat(20)}\n`);

  const envelope = await executeRead(workspace, {
    items: [{ path: "large.txt", full: true }],
    limits: { maxTextCharsReturned: 10 },
  });

  assert.equal(envelope.results[0]?.text, "");
  assert.equal(envelope.diagnostics[0]?.code, "line_too_large");
  assert.ok(envelope.completeness.reasons.includes("line_too_large"));
});

test("READ exposes nextItemIndex when maxItems stops processing", async (
  context,
) => {
  const { root, workspace } = await createWorkspace(context);
  await Promise.all([
    writeFile(join(root, "a.txt"), "a"),
    writeFile(join(root, "b.txt"), "b"),
  ]);

  const envelope = await executeRead(workspace, {
    items: [
      { path: "a.txt", full: true },
      { path: "b.txt", full: true },
    ],
    limits: { maxItems: 1 },
  });

  assert.equal(envelope.results.length, 1);
  assert.equal(envelope.usage.itemsRequested, 2);
  assert.equal(envelope.usage.itemsProcessed, 1);
  assert.equal(envelope.usage.itemsSkipped, 1);
  assert.equal(envelope.usage.nextItemIndex, 1);
});

test("READ enforces canonical result bytes before returning", async (
  context,
) => {
  const { root, workspace } = await createWorkspace(context);
  const content = Array.from(
    { length: 200 },
    (_, index) => `${index.toString().padStart(3, "0")}-${"x".repeat(30)}\n`,
  ).join("");
  await writeFile(join(root, "many.txt"), content);

  const envelope = await executeRead(workspace, {
    items: [{ path: "many.txt", full: true }],
    limits: {
      maxResultBytes: 4_096,
      maxTextCharsReturned: 10_000,
      maxLinesPerItem: 400,
    },
  });

  const bytes = serializeCanonicalEnvelope(envelope);
  assert.ok(bytes.byteLength <= 4_096);
  assert.equal(envelope.usage.resultBytes, bytes.byteLength);
  assert.ok(envelope.completeness.reasons.includes("result_byte_limit"));
  assert.ok((envelope.results[0]?.remainingRanges.length ?? 0) > 0);
});

test("READ can decode an explicitly selected Windows-31J item", async (
  context,
) => {
  const { root, workspace } = await createWorkspace(context);
  await writeFile(
    join(root, "legacy.txt"),
    encodeStrict("髙﨑\r\n", "windows-31j"),
  );

  const envelope = await executeRead(workspace, {
    items: [
      {
        path: "legacy.txt",
        encoding: "windows-31j",
        full: true,
      },
    ],
  });
  assert.equal(envelope.results[0]?.text, "髙﨑\n");
  assert.equal(envelope.results[0]?.encoding, "windows-31j");
  assert.equal(envelope.results[0]?.encodingSource, "explicit");
});

test("READ host ceilings clamp requested limits with a diagnostic", async (
  context,
) => {
  const { workspace } = await createWorkspace(context, {
    "one.txt": "one\n",
    "two.txt": "two\n",
  });
  const envelope = await executeRead(
    workspace,
    {
      items: [
        { path: "one.txt", full: true },
        { path: "two.txt", full: true },
      ],
      limits: { maxItems: 10 },
    },
    { limitCeilings: { maxItems: 1 } },
  );

  assert.equal(envelope.status, "partial");
  assert.equal(envelope.usage.effectiveLimits.maxItems, 1);
  assert.equal(envelope.diagnostics[0]?.code, "limit_clamped");
  assert.equal(envelope.usage.itemsProcessed, 1);
});

test("READ processes a zero-character item after exhausting text budget", async (
  context,
) => {
  const { workspace } = await createWorkspace(context, {
    "one.txt": "x",
    "zero.txt": "",
  });
  const envelope = await executeRead(workspace, {
    items: [
      { path: "one.txt", full: true },
      { path: "zero.txt", full: true },
    ],
    limits: { maxTextCharsReturned: 1 },
  });

  assert.equal(envelope.results.length, 2);
  assert.equal(envelope.results[1]?.path, "zero.txt");
  assert.equal(envelope.results[1]?.text, "");
  assert.equal(envelope.usage.itemsProcessed, 2);
});

test("READ reports a line that cannot fit the result byte budget", async (
  context,
) => {
  const { workspace } = await createWorkspace(context, {
    "large.txt": "x".repeat(5_000),
  });
  const envelope = await executeRead(workspace, {
    items: [{ path: "large.txt", full: true }],
    limits: {
      maxResultBytes: 4_096,
      maxTextCharsReturned: 6_000,
    },
  });

  assert.ok(envelope.usage.resultBytes <= 4_096);
  assert.ok(
    envelope.diagnostics.some(
      (diagnostic) => diagnostic.code === "line_too_large",
    ),
  );
});

async function createWorkspace(
  context: test.TestContext,
  files: Readonly<Record<string, string | Uint8Array>> = {},
): Promise<{ root: string; workspace: Workspace }> {
  const root = await mkdtemp(join(tmpdir(), "miku-text-file-ops-read-"));
  context.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(root, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    await writeFile(join(root, path), content);
  }
  return { root, workspace: await Workspace.open(root) };
}
