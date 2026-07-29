import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const bundle = resolve("bundle/miku-text-file-ops.mjs");

const version = await execute(process.execPath, [bundle, "--version"]);
assert.equal(version.stderr, "");
assert.equal(version.stdout, `${packageJson.version}\n`);

const help = await execute(process.execPath, [bundle, "--help"]);
assert.equal(help.stderr, "");
assert.match(help.stdout, /USAGE/u);
assert.match(help.stdout, /SEARCH REQUEST/u);
assert.match(help.stdout, /expectedRevision/u);
assert.match(help.stdout, /EXIT CODES/u);
assert.match(help.stdout, /--version/u);
assert.match(help.stdout, /maxResultBytes:32768/u);
assert.match(help.stdout, /lineEnding:preserve/u);

const root = await mkdtemp(join(tmpdir(), "miku-text-file-ops-bundle-"));
try {
  await mkdir(join(root, ".mikusoft"));
  await writeFile(
    join(root, ".mikusoft", "miku-text-file-ops.json"),
    JSON.stringify({
      schemaVersion: 1,
      encodingRules: [
        { glob: "legacy.txt", encoding: "windows-31j" },
      ],
    }),
  );
  const original = Buffer.from("87900d0a610d0a", "hex");
  await writeFile(join(root, "legacy.txt"), original);

  const read = await executeJson("read", root, {
    items: [{ path: "legacy.txt", full: true }],
  });
  assert.equal(read.status, "success");
  assert.equal(read.results[0].encodingSource, "repositoryRule");

  const search = await executeJson("search", root, {
    mode: "content",
    pattern: "a",
    include: ["legacy.txt"],
  });
  assert.equal(search.status, "success");
  assert.equal(search.results[1].text, "a");

  const update = await executeJson("update", root, {
    path: "legacy.txt",
    expectedRevision: read.results[0].revision,
    change: {
      type: "context-diff",
      diff: "@@\n-a\n+A\n",
    },
  });
  assert.equal(update.status, "success");
  assert.equal(
    (await readFile(join(root, "legacy.txt"))).toString("hex"),
    "87900d0a410d0a",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

process.stdout.write(`CLI bundle smoke passed: ${packageJson.version}\n`);

async function executeJson(operation, root, request) {
  const execution = await new Promise((resolveExecution, rejectExecution) => {
    const child = execFile(
      process.execPath,
      [bundle, operation, "--root", root, "--json"],
      (error, stdout, stderr) => {
        if (error !== null) {
          rejectExecution(error);
          return;
        }
        resolveExecution({ stdout, stderr });
      },
    );
    child.stdin.end(JSON.stringify(request));
  });
  assert.equal(execution.stderr, "");
  return JSON.parse(execution.stdout);
}
