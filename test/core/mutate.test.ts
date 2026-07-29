import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  MutationError,
  Workspace,
  decodeStrict,
  encodeStrict,
  executeCreate,
  executeDelete,
  executeUpdate,
  rawByteRevision,
} from "../../src/index.js";

test("CREATE uses exclusive UTF-8 LF creation by default", async (context) => {
  const { root, workspace } = await createWorkspace(context);
  const result = await executeCreate(workspace, {
    path: "created.txt",
    content: "one\r\ntwo\r",
  });
  const bytes = await readFile(join(root, "created.txt"));
  assert.equal(bytes.toString("utf8"), "one\ntwo\n");
  assert.equal(result.revision, rawByteRevision(bytes));
  assert.equal(result.encoding, "utf-8");
  assert.equal(result.bom, false);

  await assert.rejects(
    executeCreate(workspace, {
      path: "created.txt",
      content: "overwrite",
    }),
    (error: unknown) => {
      assert.equal(
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : "",
        "target_exists",
      );
      return true;
    },
  );
});

test("CREATE writes an explicit UTF-16BE BOM", async (context) => {
  const { root, workspace } = await createWorkspace(context);
  await executeCreate(workspace, {
    path: "utf16.txt",
    content: "A\n",
    writeAs: {
      encoding: "utf-16be",
      lineEnding: "crlf",
      bom: true,
    },
  });
  const bytes = await readFile(join(root, "utf16.txt"));
  assert.deepEqual([...bytes.subarray(0, 2)], [0xfe, 0xff]);
  assert.equal(decodeStrict(bytes, "utf-16be"), "A\r\n");
});

test("UPDATE applies contextual diff and preserves permissions", async (
  context,
) => {
  const { root, workspace } = await createWorkspace(context);
  const path = join(root, "update.txt");
  const original = Buffer.from("one\r\ntwo\r\n");
  await writeFile(path, original);
  await chmod(path, 0o640);

  const result = await executeUpdate(workspace, {
    path: "update.txt",
    expectedRevision: rawByteRevision(original),
    change: {
      type: "context-diff",
      diff: "@@\n-two\n+TWO\n",
    },
  });
  const updated = await readFile(path);
  assert.equal(updated.toString("utf8"), "one\r\nTWO\r\n");
  assert.equal(result.appliedHunks, 1);
  assert.equal(result.addedLines, 1);
  assert.equal(result.removedLines, 1);
  assert.equal((await stat(path)).mode & 0o777, 0o640);
});

test("UPDATE transcodes Windows-31J to UTF-8 without changing text", async (
  context,
) => {
  const { root, workspace } = await createWorkspace(context);
  const path = join(root, "legacy.txt");
  const original = encodeStrict("髙﨑\r\n", "windows-31j");
  await writeFile(path, original);

  const result = await executeUpdate(
    workspace,
    {
      path: "legacy.txt",
      expectedRevision: rawByteRevision(original),
      change: { type: "transcode" },
      writeAs: {
        encoding: "utf-8",
        lineEnding: "lf",
        bom: false,
      },
    },
    { repositoryEncoding: () => "windows-31j" },
  );
  const updated = await readFile(path);
  assert.equal(updated.toString("utf8"), "髙﨑\n");
  assert.equal(result.encoding, "utf-8");
});

test("UPDATE fails closed on a stale revision", async (context) => {
  const { root, workspace } = await createWorkspace(context);
  await writeFile(join(root, "update.txt"), "current");

  await assert.rejects(
    executeUpdate(workspace, {
      path: "update.txt",
      expectedRevision: `sha256:${"0".repeat(64)}`,
      change: { type: "transcode" },
    }),
    (error: unknown) => {
      assert.ok(error instanceof MutationError);
      assert.equal(error.code, "stale_revision");
      return true;
    },
  );
});

test("DELETE requires and returns the observed raw-byte revision", async (
  context,
) => {
  const { root, workspace } = await createWorkspace(context);
  const bytes = Buffer.from("delete me");
  await writeFile(join(root, "delete.txt"), bytes);
  const revision = rawByteRevision(bytes);

  assert.deepEqual(
    await executeDelete(workspace, {
      path: "delete.txt",
      expectedRevision: revision,
    }),
    {
      path: "delete.txt",
      oldRevision: revision,
    },
  );
  await assert.rejects(readFile(join(root, "delete.txt")), {
    code: "ENOENT",
  });
});

test("UPDATE replace preserves a uniform source newline and content shape", async (
  context,
) => {
  const { root, workspace } = await createWorkspace(context);
  const bytes = Buffer.from("one\r\ntwo\r\n");
  await writeFile(join(root, "replace.txt"), bytes);
  const result = await executeUpdate(workspace, {
    path: "replace.txt",
    expectedRevision: rawByteRevision(bytes),
    change: { type: "replace", content: "first\nsecond\rthird" },
  });

  assert.equal(
    (await readFile(join(root, "replace.txt"))).toString("utf8"),
    "first\r\nsecond\r\nthird",
  );
  assert.equal(result.lineEnding, "crlf");
  assert.equal(result.appliedHunks, 0);
  assert.equal(result.addedLines, 3);
  assert.equal(result.removedLines, 2);
});

test("UPDATE replace preserves mixed newlines by ordinal position", async (
  context,
) => {
  const { root, workspace } = await createWorkspace(context);
  const bytes = Buffer.from("one\r\ntwo\nthree\rfour\r\n");
  await writeFile(join(root, "replace.txt"), bytes);
  await executeUpdate(workspace, {
    path: "replace.txt",
    expectedRevision: rawByteRevision(bytes),
    change: { type: "replace", content: "a\nb\nc\nd\ne\n" },
  });

  assert.equal(
    (await readFile(join(root, "replace.txt"))).toString("utf8"),
    "a\r\nb\nc\rd\r\ne\r\n",
  );
});

test("UPDATE replace uses first-seen newline to break a dominant tie", async (
  context,
) => {
  const { root, workspace } = await createWorkspace(context);
  const bytes = Buffer.from("one\rtwo\nthree\nfour\r");
  await writeFile(join(root, "replace.txt"), bytes);
  await executeUpdate(workspace, {
    path: "replace.txt",
    expectedRevision: rawByteRevision(bytes),
    change: { type: "replace", content: "a\nb\nc\nd\ne\n" },
  });

  assert.equal(
    (await readFile(join(root, "replace.txt"))).toString("utf8"),
    "a\rb\nc\nd\re\r",
  );
});

test("UPDATE replace falls back to LF when the source has no newline", async (
  context,
) => {
  const { root, workspace } = await createWorkspace(context);
  const bytes = Buffer.from("original");
  await writeFile(join(root, "replace.txt"), bytes);
  await executeUpdate(workspace, {
    path: "replace.txt",
    expectedRevision: rawByteRevision(bytes),
    change: { type: "replace", content: "a\r\nb" },
  });

  assert.equal(
    (await readFile(join(root, "replace.txt"))).toString("utf8"),
    "a\nb",
  );
});

test("UPDATE replace honors an explicit newline and may produce empty content", async (
  context,
) => {
  const { root, workspace } = await createWorkspace(context);
  const path = join(root, "replace.txt");
  const bytes = Buffer.from("one\r\ntwo\n");
  await writeFile(path, bytes);
  const replaced = await executeUpdate(workspace, {
    path: "replace.txt",
    expectedRevision: rawByteRevision(bytes),
    change: { type: "replace", content: "a\nb\n" },
    writeAs: { lineEnding: "cr" },
  });
  assert.equal((await readFile(path)).toString("utf8"), "a\rb\r");

  await executeUpdate(workspace, {
    path: "replace.txt",
    expectedRevision: replaced.newRevision,
    change: { type: "replace", content: "" },
  });
  assert.equal((await readFile(path)).byteLength, 0);
});

async function createWorkspace(
  context: test.TestContext,
): Promise<{ root: string; workspace: Workspace }> {
  const root = await mkdtemp(join(tmpdir(), "miku-text-file-ops-mutate-"));
  context.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return { root, workspace: await Workspace.open(root) };
}
