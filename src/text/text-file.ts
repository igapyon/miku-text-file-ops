import { createHash } from "node:crypto";
import {
  type CanonicalEncoding,
  TextDecodingError,
  decodeStrict,
} from "./encoding.js";
import {
  type LineEndingShape,
  type LogicalText,
  parseLogicalText,
} from "./logical-lines.js";

export type EncodingSource =
  | "explicit"
  | "repositoryRule"
  | "bom"
  | "strictUtf8"
  | "legacyFallback";

export interface DecodeTextFileOptions {
  explicitEncoding?: CanonicalEncoding;
  repositoryEncoding?: CanonicalEncoding;
  legacyFallback?: "windows-31j";
}

export interface DecodedTextFile {
  text: string;
  logicalText: LogicalText;
  revision: string;
  encoding: CanonicalEncoding;
  encodingSource: EncodingSource;
  bom: boolean;
  rawBytes: number;
  lineEnding: LineEndingShape;
  finalNewline: boolean;
  logicalLines: number;
}

export type TextFileErrorCode =
  | "decode_error"
  | "encoding_undetermined"
  | "encoding_conflict";

export class TextFileError extends Error {
  readonly code: TextFileErrorCode;
  readonly encoding: CanonicalEncoding | undefined;
  readonly byteOffset: number | undefined;

  constructor(
    code: TextFileErrorCode,
    message: string,
    encoding?: CanonicalEncoding,
    byteOffset?: number,
  ) {
    super(message);
    this.name = "TextFileError";
    this.code = code;
    this.encoding = encoding;
    this.byteOffset = byteOffset;
  }
}

export function decodeTextFile(
  bytes: Uint8Array,
  options: DecodeTextFileOptions = {},
): DecodedTextFile {
  const bomEncoding = detectBom(bytes);
  const requestedEncoding =
    options.explicitEncoding ?? options.repositoryEncoding;
  if (
    requestedEncoding !== undefined &&
    bomEncoding !== undefined &&
    requestedEncoding !== bomEncoding
  ) {
    throw new TextFileError(
      "encoding_conflict",
      `Requested ${requestedEncoding} conflicts with ${bomEncoding} BOM`,
      requestedEncoding,
    );
  }

  let encoding: CanonicalEncoding;
  let encodingSource: EncodingSource;
  if (options.explicitEncoding !== undefined) {
    encoding = options.explicitEncoding;
    encodingSource = "explicit";
  } else if (options.repositoryEncoding !== undefined) {
    encoding = options.repositoryEncoding;
    encodingSource = "repositoryRule";
  } else if (bomEncoding !== undefined) {
    encoding = bomEncoding;
    encodingSource = "bom";
  } else {
    try {
      const text = decodeStrict(bytes, "utf-8");
      return buildDecodedFile(
        bytes,
        text,
        "utf-8",
        "strictUtf8",
        false,
      );
    } catch (error) {
      if (
        !(error instanceof TextDecodingError) ||
        options.legacyFallback === undefined
      ) {
        throw new TextFileError(
          "encoding_undetermined",
          "Input has no recognized BOM and is not valid UTF-8",
          "utf-8",
          error instanceof TextDecodingError
            ? error.byteOffset
            : undefined,
        );
      }
      encoding = options.legacyFallback;
      encodingSource = "legacyFallback";
    }
  }

  try {
    return buildDecodedFile(
      bytes,
      decodeStrict(bytes, encoding),
      encoding,
      encodingSource,
      bomEncoding !== undefined,
    );
  } catch (error) {
    if (error instanceof TextDecodingError) {
      throw new TextFileError(
        "decode_error",
        error.message,
        encoding,
        error.byteOffset,
      );
    }
    throw error;
  }
}

export function rawByteRevision(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function detectBom(
  bytes: Uint8Array,
): CanonicalEncoding | undefined {
  if (
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
  ) {
    return "utf-8";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return "utf-16le";
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return "utf-16be";
  }
  return undefined;
}

function buildDecodedFile(
  bytes: Uint8Array,
  text: string,
  encoding: CanonicalEncoding,
  encodingSource: EncodingSource,
  bom: boolean,
): DecodedTextFile {
  const logicalText = parseLogicalText(text);
  return {
    text,
    logicalText,
    revision: rawByteRevision(bytes),
    encoding,
    encodingSource,
    bom,
    rawBytes: bytes.byteLength,
    lineEnding: logicalText.lineEnding,
    finalNewline: logicalText.finalNewline,
    logicalLines: logicalText.lines.length,
  };
}
