#!/usr/bin/env node

import { executeCli } from "./cli.js";

const args = process.argv.slice(2);
const chunks: Buffer[] = [];
const metadataOnly =
  args.length === 1 &&
  (args[0] === "--help" || args[0] === "-h" || args[0] === "--version");
if (!metadataOnly) {
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
}

const execution = await executeCli(
  args,
  Buffer.concat(chunks),
  process.cwd(),
);
if (execution.stdout.byteLength > 0) {
  process.stdout.write(execution.stdout);
}
if (execution.stderr.byteLength > 0) {
  process.stderr.write(execution.stderr);
}
process.exitCode = execution.exitCode;
