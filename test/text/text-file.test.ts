import assert from "node:assert/strict";
import test from "node:test";
import {
  TextFileError,
  decodeTextFile,
  encodeStrict,
  rawByteRevision,
} from "../../src/index.js";

test("text file resolves BOM before strict UTF-8", () => {
  const bytes = Uint8Array.from([0xff, 0xfe, 0x41, 0x00]);
  const file = decodeTextFile(bytes);
  assert.equal(file.text, "A");
  assert.equal(file.encoding, "utf-16le");
  assert.equal(file.encodingSource, "bom");
  assert.equal(file.bom, true);
});

test("text file detects strict UTF-8 without a BOM", () => {
  const bytes = encodeStrict("one\r\ntwo", "utf-8");
  const file = decodeTextFile(bytes);
  assert.equal(file.encoding, "utf-8");
  assert.equal(file.encodingSource, "strictUtf8");
  assert.equal(file.lineEnding, "crlf");
  assert.equal(file.finalNewline, false);
  assert.equal(file.logicalLines, 2);
});

test("text file uses an explicitly enabled legacy fallback", () => {
  const bytes = encodeStrict("髙﨑", "windows-31j");
  const file = decodeTextFile(bytes, { legacyFallback: "windows-31j" });
  assert.equal(file.text, "髙﨑");
  assert.equal(file.encoding, "windows-31j");
  assert.equal(file.encodingSource, "legacyFallback");
});

test("text file rejects undetermined encoding without fallback", () => {
  const bytes = encodeStrict("髙﨑", "windows-31j");
  assert.throws(
    () => decodeTextFile(bytes),
    (error: unknown) => {
      assert.ok(error instanceof TextFileError);
      assert.equal(error.code, "encoding_undetermined");
      return true;
    },
  );
});

test("text file preserves the invalid UTF-8 byte offset", () => {
  assert.throws(
    () => decodeTextFile(Uint8Array.from([0x61, 0xe3, 0x81])),
    (error: unknown) => {
      assert.ok(error instanceof TextFileError);
      assert.equal(error.code, "encoding_undetermined");
      assert.equal(error.byteOffset, 1);
      return true;
    },
  );
});

test("text file rejects an explicit encoding that conflicts with BOM", () => {
  const bytes = Uint8Array.from([0xff, 0xfe, 0x41, 0x00]);
  assert.throws(
    () => decodeTextFile(bytes, { explicitEncoding: "utf-8" }),
    (error: unknown) => {
      assert.ok(error instanceof TextFileError);
      assert.equal(error.code, "encoding_conflict");
      return true;
    },
  );
});

test("raw-byte revision changes with BOM and newline bytes", () => {
  const plain = encodeStrict("a\n", "utf-8");
  const crlf = encodeStrict("a\r\n", "utf-8");
  const bom = Uint8Array.from([0xef, 0xbb, 0xbf, ...plain]);
  assert.notEqual(rawByteRevision(plain), rawByteRevision(crlf));
  assert.notEqual(rawByteRevision(plain), rawByteRevision(bom));
  assert.match(rawByteRevision(plain), /^sha256:[0-9a-f]{64}$/u);
});
