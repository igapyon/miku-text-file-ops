import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);
const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const bundle = "bundle/miku-text-file-ops.mjs";

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

process.stdout.write(`CLI bundle smoke passed: ${packageJson.version}\n`);
