import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  CLI_EXIT,
  PRODUCT_VERSION,
  executeCli,
  validateCreateRequest,
  validateDeleteRequest,
  validateReadRequest,
  validateSearchRequest,
  validateUpdateRequest,
} from "../../src/index.js";

test("CLI metadata options do not require stdin", async () => {
  const version = await executeCli(
    ["--version"],
    new Uint8Array(),
    process.cwd(),
  );
  const help = await executeCli(
    ["--help"],
    new Uint8Array(),
    process.cwd(),
  );

  assert.equal(version.exitCode, CLI_EXIT.success);
  assert.equal(
    Buffer.from(version.stdout).toString("utf8"),
    `${PRODUCT_VERSION}\n`,
  );
  const helpText = Buffer.from(help.stdout).toString("utf8");
  assert.equal(help.exitCode, CLI_EXIT.success);
  assert.equal(help.stderr.byteLength, 0);
  assert.equal(helpText.endsWith("\n"), true);
  for (const section of [
    "USAGE",
    "TRANSPORT AND PATH RULES",
    "SEARCH REQUEST",
    "READ REQUEST",
    "CREATE REQUEST",
    "UPDATE REQUEST",
    "DELETE REQUEST",
    "OPTIONAL LIMITS",
    "JSON RESPONSE",
    "EXIT CODES",
    "MINIMAL AGENT WORKFLOW",
  ]) {
    assert.match(helpText, new RegExp(section, "u"));
  }
  assert.match(helpText, /expectedRevision/u);
  assert.match(helpText, /remainingRanges/u);
  assert.match(helpText, /stale_revision/u);
  assert.match(helpText, /Recommended for agents/u);
  assert.match(helpText, /\.gitignore/u);
  assert.match(helpText, /stable machine contract/u);
  assert.match(helpText, /maxResultBytes:32768/u);
  assert.match(helpText, /mixed.*logical-line position/su);
  validateRenderedHelpExamples(helpText);
});

test("--json emits exactly the canonical measured response", async (context) => {
  const root = await createRoot(context);
  await writeFile(join(root, "hello.txt"), "hello\n");

  const execution = await executeCli(
    ["search", "--json", "--root", root],
    jsonBytes({ mode: "paths", projection: "files" }),
    root,
  );
  const response = JSON.parse(Buffer.from(execution.stdout).toString("utf8"));

  assert.equal(execution.exitCode, CLI_EXIT.success);
  assert.equal(execution.stderr.byteLength, 0);
  assert.equal(execution.stdout.at(-1), 0x0a);
  assert.equal(
    response.usage.resultBytes,
    execution.stdout.byteLength,
  );
  assert.equal(response.operation, "search");
  assert.equal(response.status, "success");
  assert.equal(response.results[1].path, "hello.txt");
});

test("request validation failures use exit 2 and a failed JSON envelope", async (
  context,
) => {
  const root = await createRoot(context);
  const execution = await executeCli(
    ["search", "--root", root, "--json"],
    jsonBytes({ mode: "paths", misspelled: true }),
    root,
  );
  const response = JSON.parse(Buffer.from(execution.stdout).toString("utf8"));

  assert.equal(execution.exitCode, CLI_EXIT.requestError);
  assert.equal(execution.stderr.byteLength, 0);
  assert.equal(response.status, "failed");
  assert.equal(response.diagnostics[0].code, "unknown_field");
});

test("safe-regex syntax failures are request errors", async (context) => {
  const root = await createRoot(context);
  const execution = await executeCli(
    ["search", "--root", root, "--json"],
    jsonBytes({
      mode: "content",
      pattern: "(?=unsupported)",
      syntax: "regex",
    }),
    root,
  );
  const response = JSON.parse(Buffer.from(execution.stdout).toString("utf8"));

  assert.equal(execution.exitCode, CLI_EXIT.requestError);
  assert.equal(response.status, "failed");
  assert.equal(
    response.diagnostics[0].code,
    "regex_feature_not_supported",
  );
});

test("useful incomplete results use the distinct partial exit", async (
  context,
) => {
  const root = await createRoot(context);
  await writeFile(join(root, "bad.bin"), Uint8Array.from([0xff]));
  const execution = await executeCli(
    ["--json", "search", "--root", root],
    jsonBytes({
      mode: "content",
      projection: "count",
      pattern: "anything",
    }),
    root,
  );
  const response = JSON.parse(Buffer.from(execution.stdout).toString("utf8"));

  assert.equal(execution.exitCode, CLI_EXIT.partial);
  assert.equal(response.status, "partial");
  assert.equal(response.diagnostics[0].code, "encoding_undetermined");
});

test("CLI create, replace, and delete share the mutation core", async (
  context,
) => {
  const root = await createRoot(context);
  const createExecution = await executeCli(
    ["create", "--root", root, "--json"],
    jsonBytes({ path: "cli.txt", content: "one\r\ntwo\r\n" }),
    root,
  );
  const created = JSON.parse(
    Buffer.from(createExecution.stdout).toString("utf8"),
  ).results[0];
  assert.equal(createExecution.exitCode, CLI_EXIT.success);

  const updateExecution = await executeCli(
    ["update", "--root", root, "--json"],
    jsonBytes({
      path: "cli.txt",
      expectedRevision: created.revision,
      change: { type: "replace", content: "updated\n" },
    }),
    root,
  );
  const updated = JSON.parse(
    Buffer.from(updateExecution.stdout).toString("utf8"),
  ).results[0];
  assert.equal(updateExecution.exitCode, CLI_EXIT.success);
  assert.equal(
    (await readFile(join(root, "cli.txt"))).toString("utf8"),
    "updated\n",
  );

  const deleteExecution = await executeCli(
    ["delete", "--root", root, "--json"],
    jsonBytes({
      path: "cli.txt",
      expectedRevision: updated.newRevision,
    }),
    root,
  );
  assert.equal(deleteExecution.exitCode, CLI_EXIT.success);
  await assert.rejects(readFile(join(root, "cli.txt")), { code: "ENOENT" });
});

test("the executable keeps machine-mode stdout protocol-pure", async (
  context,
) => {
  const root = await createRoot(context);
  await writeFile(join(root, "one.txt"), "one\n");
  const bin = new URL("../../src/bin.js", import.meta.url);
  const execution = await spawnCli(
    bin,
    ["search", "--root", root, "--json"],
    JSON.stringify({ mode: "paths", projection: "count" }),
  );

  assert.equal(execution.code, CLI_EXIT.success);
  assert.equal(execution.stderr, "");
  assert.equal(execution.stdout.endsWith("\n"), true);
  assert.equal(JSON.parse(execution.stdout).operation, "search");
});

function jsonBytes(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function validateRenderedHelpExamples(helpText: string): void {
  const pattern =
    /^miku-text-file-ops --root \. --json (search|read|create|update|delete) <<'JSON'\n([\s\S]*?)\nJSON$/gmu;
  const examples = [...helpText.matchAll(pattern)];
  assert.equal(examples.length, 6);
  const seen = new Set<string>();

  for (const match of examples) {
    const operation = match[1] as
      | "search"
      | "read"
      | "create"
      | "update"
      | "delete";
    const request = JSON.parse(match[2] as string);
    seen.add(operation);
    switch (operation) {
      case "search":
        validateSearchRequest(request);
        break;
      case "read":
        validateReadRequest(request);
        break;
      case "create":
        validateCreateRequest(request);
        break;
      case "update":
        validateUpdateRequest(request);
        break;
      case "delete":
        validateDeleteRequest(request);
        break;
    }
  }

  assert.deepEqual(
    [...seen].sort(),
    ["create", "delete", "read", "search", "update"],
  );
}

async function createRoot(context: test.TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "miku-text-file-ops-cli-"));
  context.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function spawnCli(
  bin: URL,
  args: readonly string[],
  stdin: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(bin), ...args]);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.stdin.end(stdin);
  });
}
