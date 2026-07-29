#!/usr/bin/env node

import { executeCli } from "./cli.js";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) {
  chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
}

const execution = await executeCli(
  process.argv.slice(2),
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
