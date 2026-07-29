import iconv from "iconv-lite";

export type CanonicalEncoding =
  | "utf-8"
  | "utf-16le"
  | "utf-16be"
  | "windows-31j";

export class TextDecodingError extends Error {
  readonly encoding: CanonicalEncoding;

  constructor(encoding: CanonicalEncoding, message: string) {
    super(message);
    this.name = "TextDecodingError";
    this.encoding = encoding;
  }
}

export class TextEncodingError extends Error {
  readonly encoding: CanonicalEncoding;

  constructor(encoding: CanonicalEncoding, message: string) {
    super(message);
    this.name = "TextEncodingError";
    this.encoding = encoding;
  }
}

export function decodeStrict(
  bytes: Uint8Array,
  encoding: CanonicalEncoding,
): string {
  switch (encoding) {
    case "utf-8":
      return decodeWithTextDecoder(bytes, "utf-8", encoding);
    case "utf-16le":
      requireEvenByteLength(bytes, encoding);
      return decodeWithTextDecoder(bytes, "utf-16le", encoding);
    case "utf-16be":
      requireEvenByteLength(bytes, encoding);
      return decodeUtf16Be(bytes);
    case "windows-31j":
      return decodeWindows31j(bytes);
  }
}

export function encodeStrict(
  text: string,
  encoding: CanonicalEncoding,
): Uint8Array {
  switch (encoding) {
    case "utf-8":
      return Buffer.from(text, "utf8");
    case "utf-16le":
      return Buffer.from(text, "utf16le");
    case "utf-16be":
      return swapUtf16ByteOrder(Buffer.from(text, "utf16le"));
    case "windows-31j":
      return encodeWindows31j(text);
  }
}

function decodeWithTextDecoder(
  bytes: Uint8Array,
  decoderEncoding: string,
  canonicalEncoding: CanonicalEncoding,
): string {
  try {
    return new TextDecoder(decoderEncoding, {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes);
  } catch (cause) {
    throw new TextDecodingError(
      canonicalEncoding,
      `Input is not valid ${canonicalEncoding}: ${errorMessage(cause)}`,
    );
  }
}

function decodeUtf16Be(bytes: Uint8Array): string {
  const swapped = swapUtf16ByteOrder(bytes);
  return decodeWithTextDecoder(swapped, "utf-16le", "utf-16be");
}

function decodeWindows31j(bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes);
  const decoded = iconv.decode(buffer, "windows-31j");

  if (decoded.includes("\uFFFD")) {
    throw new TextDecodingError(
      "windows-31j",
      "Input contains a malformed windows-31j byte sequence",
    );
  }

  return decoded;
}

function encodeWindows31j(text: string): Uint8Array {
  const encoded = iconv.encode(text, "windows-31j");
  const decoded = iconv.decode(encoded, "windows-31j");
  if (decoded !== text) {
    throw new TextEncodingError(
      "windows-31j",
      "Text contains characters that are not representable in windows-31j",
    );
  }
  return encoded;
}

function requireEvenByteLength(
  bytes: Uint8Array,
  encoding: "utf-16le" | "utf-16be",
): void {
  if (bytes.byteLength % 2 !== 0) {
    throw new TextDecodingError(
      encoding,
      `Input byte length must be even for ${encoding}`,
    );
  }
}

function swapUtf16ByteOrder(bytes: Uint8Array): Uint8Array {
  const swapped = new Uint8Array(bytes.byteLength);
  for (let index = 0; index < bytes.byteLength; index += 2) {
    swapped[index] = bytes[index + 1] ?? 0;
    swapped[index + 1] = bytes[index] ?? 0;
  }
  return swapped;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
