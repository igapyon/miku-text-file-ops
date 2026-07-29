import iconv from "iconv-lite";

export type CanonicalEncoding =
  | "utf-8"
  | "utf-16le"
  | "utf-16be"
  | "windows-31j";

export class TextDecodingError extends Error {
  readonly encoding: CanonicalEncoding;
  readonly byteOffset: number | undefined;

  constructor(
    encoding: CanonicalEncoding,
    message: string,
    byteOffset?: number,
  ) {
    super(message);
    this.name = "TextDecodingError";
    this.encoding = encoding;
    this.byteOffset = byteOffset;
  }
}

export class TextEncodingError extends Error {
  readonly encoding: CanonicalEncoding;
  readonly characterOffset: number | undefined;

  constructor(
    encoding: CanonicalEncoding,
    message: string,
    characterOffset?: number,
  ) {
    super(message);
    this.name = "TextEncodingError";
    this.encoding = encoding;
    this.characterOffset = characterOffset;
  }
}

export function decodeStrict(
  bytes: Uint8Array,
  encoding: CanonicalEncoding,
): string {
  const invalidOffset = firstInvalidByteOffset(bytes, encoding);
  if (invalidOffset !== undefined) {
    throw new TextDecodingError(
      encoding,
      `Input is not valid ${encoding} at byte offset ${invalidOffset}`,
      invalidOffset,
    );
  }

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
  const invalidScalar = firstUnpairedSurrogate(text);
  if (invalidScalar !== undefined) {
    throw new TextEncodingError(
      encoding,
      `Text contains an unpaired surrogate at character offset ${invalidScalar.characterOffset}`,
      invalidScalar.characterOffset,
    );
  }

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
      firstInvalidWindows31jOffset(bytes),
    );
  }

  return decoded;
}

function encodeWindows31j(text: string): Uint8Array {
  const encoded = iconv.encode(text, "windows-31j");
  const decoded = iconv.decode(encoded, "windows-31j");
  if (decoded !== text) {
    const characterOffset = firstWindows31jEncodingFailure(text);
    throw new TextEncodingError(
      "windows-31j",
      `Text contains a character that is not representable in windows-31j at character offset ${characterOffset}`,
      characterOffset,
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
      Math.max(0, bytes.byteLength - 1),
    );
  }
}

export interface InvalidUnicodeScalar {
  codeUnitOffset: number;
  characterOffset: number;
}

export function firstUnpairedSurrogate(
  text: string,
): InvalidUnicodeScalar | undefined {
  let characterOffset = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return { codeUnitOffset: index, characterOffset };
      }
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return { codeUnitOffset: index, characterOffset };
    }
    characterOffset += 1;
  }
  return undefined;
}

function firstInvalidByteOffset(
  bytes: Uint8Array,
  encoding: CanonicalEncoding,
): number | undefined {
  switch (encoding) {
    case "utf-8":
      return firstInvalidUtf8Offset(bytes);
    case "utf-16le":
      return firstInvalidUtf16Offset(bytes, false);
    case "utf-16be":
      return firstInvalidUtf16Offset(bytes, true);
    case "windows-31j":
      return firstInvalidWindows31jOffset(bytes);
  }
}

function firstInvalidUtf8Offset(bytes: Uint8Array): number | undefined {
  for (let index = 0; index < bytes.length; ) {
    const first = bytes[index] as number;
    if (first <= 0x7f) {
      index += 1;
      continue;
    }

    let length: number;
    let secondMinimum = 0x80;
    let secondMaximum = 0xbf;
    if (first >= 0xc2 && first <= 0xdf) {
      length = 2;
    } else if (first >= 0xe0 && first <= 0xef) {
      length = 3;
      if (first === 0xe0) secondMinimum = 0xa0;
      if (first === 0xed) secondMaximum = 0x9f;
    } else if (first >= 0xf0 && first <= 0xf4) {
      length = 4;
      if (first === 0xf0) secondMinimum = 0x90;
      if (first === 0xf4) secondMaximum = 0x8f;
    } else {
      return index;
    }

    if (index + length > bytes.length) {
      return index;
    }
    const second = bytes[index + 1] as number;
    if (second < secondMinimum || second > secondMaximum) {
      return index + 1;
    }
    for (let offset = 2; offset < length; offset += 1) {
      const continuation = bytes[index + offset] as number;
      if (continuation < 0x80 || continuation > 0xbf) {
        return index + offset;
      }
    }
    index += length;
  }
  return undefined;
}

function firstInvalidUtf16Offset(
  bytes: Uint8Array,
  bigEndian: boolean,
): number | undefined {
  if (bytes.length % 2 !== 0) {
    return bytes.length - 1;
  }
  const unitAt = (offset: number): number =>
    bigEndian
      ? ((bytes[offset] as number) << 8) | (bytes[offset + 1] as number)
      : (bytes[offset] as number) | ((bytes[offset + 1] as number) << 8);

  for (let offset = 0; offset < bytes.length; offset += 2) {
    const unit = unitAt(offset);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      if (offset + 3 >= bytes.length) {
        return offset;
      }
      const next = unitAt(offset + 2);
      if (next < 0xdc00 || next > 0xdfff) {
        return offset;
      }
      offset += 2;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return offset;
    }
  }
  return undefined;
}

function firstInvalidWindows31jOffset(
  bytes: Uint8Array,
): number | undefined {
  for (let index = 0; index < bytes.length; ) {
    const first = bytes[index] as number;
    const lead =
      (first >= 0x81 && first <= 0x9f) ||
      (first >= 0xe0 && first <= 0xfc);
    const length = lead ? 2 : 1;
    if (index + length > bytes.length) {
      return index;
    }
    const decoded = iconv.decode(
      Buffer.from(bytes.subarray(index, index + length)),
      "windows-31j",
    );
    if (decoded.includes("\uFFFD")) {
      return index;
    }
    index += length;
  }
  return undefined;
}

function firstWindows31jEncodingFailure(text: string): number {
  for (const [index, scalar] of Array.from(text).entries()) {
    const encoded = iconv.encode(scalar, "windows-31j");
    if (iconv.decode(encoded, "windows-31j") !== scalar) {
      return index;
    }
  }
  return 0;
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
