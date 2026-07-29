import assert from "node:assert/strict";
import test from "node:test";
import {
  TextDecodingError,
  TextEncodingError,
  decodeStrict,
  encodeStrict,
} from "../../src/index.js";

test("UTF-8 round-trips supplementary Unicode scalars", () => {
  const text = "初音ミク🎵";
  assert.equal(decodeStrict(encodeStrict(text, "utf-8"), "utf-8"), text);
});

test("invalid UTF-8 is rejected without replacement", () => {
  assert.throws(
    () => decodeStrict(Uint8Array.from([0xe3, 0x81]), "utf-8"),
    TextDecodingError,
  );
});

test("a matching UTF BOM is not exposed as source text", () => {
  assert.equal(
    decodeStrict(Uint8Array.from([0xef, 0xbb, 0xbf, 0x41]), "utf-8"),
    "A",
  );
  assert.equal(
    decodeStrict(Uint8Array.from([0xfe, 0xff, 0x00, 0x41]), "utf-16be"),
    "A",
  );
});

test("UTF-16LE and UTF-16BE round-trip independently", () => {
  const text = "Aみ𠮷";
  for (const encoding of ["utf-16le", "utf-16be"] as const) {
    assert.equal(decodeStrict(encodeStrict(text, encoding), encoding), text);
  }
});

test("odd-length UTF-16 input is rejected", () => {
  assert.throws(
    () => decodeStrict(Uint8Array.from([0x41]), "utf-16le"),
    TextDecodingError,
  );
});

test("windows-31j round-trips Japanese extension characters", () => {
  const text = "髙﨑①";
  assert.equal(
    decodeStrict(encodeStrict(text, "windows-31j"), "windows-31j"),
    text,
  );
});

test("unencodable windows-31j output is rejected", () => {
  assert.throws(
    () => encodeStrict("emoji: 🎵", "windows-31j"),
    TextEncodingError,
  );
});

test("malformed windows-31j input is rejected", () => {
  assert.throws(
    () => decodeStrict(Uint8Array.from([0x82]), "windows-31j"),
    TextDecodingError,
  );
});
