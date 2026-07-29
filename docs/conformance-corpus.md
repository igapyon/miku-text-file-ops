# Byte-level conformance corpus

The reusable corpus is
[`test/fixtures/conformance/text-file-ops-v1.json`](../test/fixtures/conformance/text-file-ops-v1.json).
`npm test` executes it against the public runtime API.

The corpus is runtime-independent JSON. Raw file content and complete mutation
output use lowercase hexadecimal bytes, so a consumer does not need Node.js
`Buffer` conventions. Each case contains an operation or primitive, its input,
and structured expected values. Offsets are zero-based. Revisions cover the
complete raw byte sequence and use lowercase SHA-256.

Conforming runtimes must:

1. decode each `inputHex` without replacement;
2. compare error codes and byte or character offsets exactly;
3. compare newline metadata and raw-byte revisions exactly;
4. execute mutation requests and compare the complete `outputHex`;
5. execute budget cases and compare status, reasons, usage, and diagnostic
   aggregation;
6. serialize canonical-response cases as UTF-8 including the final LF and
   compare every byte.

The format is versioned independently through `formatVersion`. Additive fields
may be introduced within version 1, but changing the meaning of an existing
field requires a new format version.
