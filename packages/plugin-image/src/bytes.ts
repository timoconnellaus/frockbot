// What the bytes an image model returned actually are.
//
// The tool records `mimeType`, `width` and `height` in its durable
// `tool/result`, and those must describe the stored object rather than the
// request: Workers AI's `flux-1-schnell` accepts no size at all, so echoing
// the requested width back would put a number in the durable log that no file
// on disk agrees with. Reading the container header is the only honest source.
//
// Pure, total, and the Package's whole image-format surface. A byte string
// this cannot identify is not written: an unidentifiable blob under a durable
// root is data nothing can render and nothing can attribute a format to.

/** A decoded image container. */
export interface ImageDimensionsV1 {
  mimeType: string;
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) << 24) +
    ((bytes[offset + 1] ?? 0) << 16) +
    ((bytes[offset + 2] ?? 0) << 8) +
    (bytes[offset + 3] ?? 0)
  );
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) + (bytes[offset + 1] ?? 0);
}

function decodePng(bytes: Uint8Array): ImageDimensionsV1 | undefined {
  if (bytes.byteLength < 24) return undefined;
  if (PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) {
    return undefined;
  }
  // The first chunk of a PNG is always IHDR, and its payload starts at 16.
  if (
    bytes[12] !== 0x49 ||
    bytes[13] !== 0x48 ||
    bytes[14] !== 0x44 ||
    bytes[15] !== 0x52
  ) {
    return undefined;
  }
  const width = readUint32BE(bytes, 16);
  const height = readUint32BE(bytes, 20);
  if (width < 1 || height < 1) return undefined;
  return { mimeType: "image/png", width, height };
}

/** SOF markers carrying a frame header. SOF4/8/12 are not frame starts. */
function isStartOfFrame(marker: number): boolean {
  return (
    marker >= 0xc0 &&
    marker <= 0xcf &&
    marker !== 0xc4 &&
    marker !== 0xc8 &&
    marker !== 0xcc
  );
}

function decodeJpeg(bytes: Uint8Array): ImageDimensionsV1 | undefined {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return undefined;
  }
  let offset = 2;
  while (offset + 3 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] ?? 0;
    // Padding fill bytes, and the standalone markers that carry no length.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    const length = readUint16BE(bytes, offset + 2);
    if (length < 2) return undefined;
    if (isStartOfFrame(marker)) {
      if (offset + 9 >= bytes.byteLength) return undefined;
      const height = readUint16BE(bytes, offset + 5);
      const width = readUint16BE(bytes, offset + 7);
      if (width < 1 || height < 1) return undefined;
      return { mimeType: "image/jpeg", width, height };
    }
    offset += 2 + length;
  }
  return undefined;
}

/**
 * The container these bytes are, or `undefined` when they are neither a PNG
 * nor a JPEG. Those two are what every Workers AI text-to-image model returns
 * today; anything else is refused rather than guessed at.
 */
export function decodeImageDimensionsV1(
  bytes: Uint8Array,
): ImageDimensionsV1 | undefined {
  return decodePng(bytes) ?? decodeJpeg(bytes);
}

/** The sha-256 content address of some bytes, hex encoded. */
export async function sha256HexV1(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.slice().buffer as ArrayBuffer,
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** The sha-256 of a string, for the prompt hash the intent event records. */
export function sha256HexOfTextV1(text: string): Promise<string> {
  return sha256HexV1(new TextEncoder().encode(text));
}
