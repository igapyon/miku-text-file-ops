import assert from "node:assert/strict";
import test from "node:test";
import { agentFacingText, parseLogicalText } from "../../src/index.js";

test("empty text has zero logical lines", () => {
  assert.deepEqual(parseLogicalText(""), {
    lines: [],
    lineEnding: "none",
    finalNewline: false,
  });
});

test("a final newline does not create a phantom logical line", () => {
  const parsed = parseLogicalText("one\r\ntwo\r\n");
  assert.equal(parsed.lines.length, 2);
  assert.equal(parsed.lineEnding, "crlf");
  assert.equal(parsed.finalNewline, true);
  assert.equal(agentFacingText(parsed), "one\ntwo\n");
});

test("LF, CRLF, and CR are recognized in one mixed file", () => {
  const parsed = parseLogicalText("one\ntwo\r\nthree\rfour");
  assert.deepEqual(
    parsed.lines.map(({ number, text, newline }) => ({
      number,
      text,
      newline,
    })),
    [
      { number: 1, text: "one", newline: "\n" },
      { number: 2, text: "two", newline: "\r\n" },
      { number: 3, text: "three", newline: "\r" },
      { number: 4, text: "four", newline: null },
    ],
  );
  assert.equal(parsed.lineEnding, "mixed");
  assert.equal(parsed.finalNewline, false);
});

test("one empty line is distinct from an empty file", () => {
  const parsed = parseLogicalText("\n");
  assert.equal(parsed.lines.length, 1);
  assert.equal(parsed.lines[0]?.text, "");
  assert.equal(parsed.finalNewline, true);
});
