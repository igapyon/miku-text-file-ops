import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  Workspace,
  WorkspaceBoundaryError,
} from "../../src/index.js";

test("workspace scan is deterministic and honors gitignore", async (context) => {
  const root = await createWorkspace(context);
  await mkdir(join(root, ".git"));
  await mkdir(join(root, "build"));
  await mkdir(join(root, "docs", "api"), { recursive: true });
  await mkdir(join(root, "nested"));

  await Promise.all([
    writeFile(
      join(root, ".gitignore"),
      "*.log\n!important.log\nbuild/\n",
    ),
    writeFile(join(root, ".git", "config"), "secret"),
    writeFile(join(root, "visible.md"), "visible"),
    writeFile(join(root, "notes.log"), "ignored"),
    writeFile(join(root, "important.log"), "included"),
    writeFile(join(root, "build", "output.txt"), "ignored"),
    writeFile(join(root, "docs", "guide.md"), "guide"),
    writeFile(join(root, "docs", "api", "spec.md"), "spec"),
    writeFile(join(root, "nested", ".gitignore"), "*.tmp\n!keep.tmp\n"),
    writeFile(join(root, "nested", "cache.tmp"), "ignored"),
    writeFile(join(root, "nested", "keep.tmp"), "included"),
  ]);

  const workspace = await Workspace.open(root);
  const result = await workspace.scan();
  assert.deepEqual(
    result.files.map((file) => file.path),
    [
      ".gitignore",
      "docs/api/spec.md",
      "docs/guide.md",
      "important.log",
      "nested/.gitignore",
      "nested/keep.tmp",
      "visible.md",
    ],
  );
  assert.deepEqual(result.diagnostics, []);
});

test("workspace scan applies include and exclude without reinclusion", async (
  context,
) => {
  const root = await createWorkspace(context);
  await mkdir(join(root, "docs", "api"), { recursive: true });
  await Promise.all([
    writeFile(join(root, ".gitignore"), "ignored.md\n"),
    writeFile(join(root, "ignored.md"), "ignored"),
    writeFile(join(root, "root.md"), "root"),
    writeFile(join(root, "docs", "guide.md"), "guide"),
    writeFile(join(root, "docs", "api", "spec.md"), "spec"),
  ]);

  const workspace = await Workspace.open(root);
  const result = await workspace.scan({
    include: ["**/*.md"],
    exclude: ["docs/api/**"],
  });
  assert.deepEqual(
    result.files.map((file) => file.path),
    ["docs/guide.md", "root.md"],
  );
});

test("workspace rejects symlinks in explicit file paths", async (context) => {
  const root = await createWorkspace(context);
  await writeFile(join(root, "target.txt"), "target");
  await symlink(join(root, "target.txt"), join(root, "link.txt"));
  const workspace = await Workspace.open(root);

  await assert.rejects(
    workspace.resolveExistingFile("link.txt"),
    (error: unknown) => {
      assert.ok(error instanceof WorkspaceBoundaryError);
      assert.equal(error.code, "symlink_rejected");
      return true;
    },
  );
});

test("workspace create resolution requires parents and an absent target", async (
  context,
) => {
  const root = await createWorkspace(context);
  await mkdir(join(root, "existing"));
  await writeFile(join(root, "existing", "file.txt"), "content");
  const workspace = await Workspace.open(root);

  assert.equal(
    await workspace.resolveCreateTarget("existing/new.txt"),
    join(workspace.root, "existing", "new.txt"),
  );
  await assertBoundaryCode(
    workspace.resolveCreateTarget("missing/new.txt"),
    "parent_missing",
  );
  await assertBoundaryCode(
    workspace.resolveCreateTarget("existing/file.txt"),
    "target_exists",
  );
});

async function createWorkspace(context: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "miku-text-file-ops-"));
  context.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function assertBoundaryCode(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof WorkspaceBoundaryError);
    assert.equal(error.code, code);
    return true;
  });
}
