import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const runtime = await import(
  `${pathToFileURL("bundle/miku-text-file-ops-runtime.mjs").href}?smoke=${Date.now()}`
);

assert.equal(runtime.PRODUCT_NAME, packageJson.name);
assert.equal(runtime.PRODUCT_VERSION, packageJson.version);
assert.equal(typeof runtime.executeSearch, "function");
assert.equal(typeof runtime.executeRead, "function");
assert.equal(typeof runtime.executeUpdate, "function");

process.stdout.write(`Runtime bundle smoke passed: ${packageJson.version}\n`);
