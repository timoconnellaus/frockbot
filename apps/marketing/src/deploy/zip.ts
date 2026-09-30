/**
 * The files in a zip archive: the release's web client, served by the install
 * as static assets.
 *
 * Reads the central directory, and handles the two methods a release zip uses,
 * stored and deflated. Enough for an archive we publish ourselves; not a
 * general-purpose reader.
 */

export interface ZipEntryV1 {
  readonly path: string;
  readonly bytes: Uint8Array<ArrayBuffer>;
}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;

async function inflateRaw(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes])
    .stream()
    .pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readZipV1(
  archive: Uint8Array<ArrayBuffer>,
): Promise<ZipEntryV1[]> {
  const view = new DataView(
    archive.buffer,
    archive.byteOffset,
    archive.byteLength,
  );
  let end = -1;
  for (
    let i = archive.length - 22;
    i >= Math.max(0, archive.length - 65_557);
    i -= 1
  ) {
    if (view.getUint32(i, true) === END_OF_CENTRAL_DIRECTORY) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("The web client archive is not a zip file");
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const entries: ZipEntryV1[] = [];
  for (let n = 0; n < count; n += 1) {
    if (view.getUint32(offset, true) !== CENTRAL_FILE_HEADER) {
      throw new Error("The web client archive's directory is damaged");
    }
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const path = decoder.decode(
      archive.subarray(offset + 46, offset + 46 + nameLength),
    );
    offset += 46 + nameLength + extraLength + commentLength;
    if (path.endsWith("/")) continue;
    if (path.split("/").some((part) => part === ".." || part === "")) {
      throw new Error(`The web client archive names an unsafe path: ${path}`);
    }
    if (view.getUint32(localOffset, true) !== LOCAL_FILE_HEADER) {
      throw new Error(`The web client archive's entry ${path} is damaged`);
    }
    const dataStart =
      localOffset +
      30 +
      view.getUint16(localOffset + 26, true) +
      view.getUint16(localOffset + 28, true);
    const data = archive.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) entries.push({ path, bytes: data.slice() });
    else if (method === 8)
      entries.push({ path, bytes: await inflateRaw(data) });
    else
      throw new Error(
        `The web client archive uses compression method ${method}`,
      );
  }
  return entries;
}
