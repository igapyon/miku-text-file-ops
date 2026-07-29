import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const packageLock = JSON.parse(await readFile("package-lock.json", "utf8"));
const metadata = await readFile("src/metadata.ts", "utf8");
const metadataMatch = metadata.match(
  /PRODUCT_VERSION = "([^"]+)" as const;/u,
);

assert.equal(
  packageLock.version,
  packageJson.version,
  "package-lock.json top-level version must match package.json",
);
assert.equal(
  packageLock.packages?.[""]?.version,
  packageJson.version,
  "package-lock.json root package version must match package.json",
);
assert.equal(
  metadataMatch?.[1],
  packageJson.version,
  "src/metadata.ts PRODUCT_VERSION must match package.json",
);

process.stdout.write(`Version sources agree: ${packageJson.version}\n`);
