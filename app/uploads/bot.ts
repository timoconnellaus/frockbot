// The Bot's side of uploads: the records it keeps, the refs a message is
// checked against, and the reader a Turn resolves attachments through.
import {
  decodeUploadRefsV1,
  type MessageAttachmentV1,
  type UploadRefV1,
} from "@frockbot/core/contracts";
import {
  decodeStoredUploadV1,
  uploadAttachmentV1,
  uploadObjectKeyV1,
  uploadRecordKeyV1,
  uploadTextKeyV1,
  type StoredUploadV1,
} from "./shared.js";
import type { UploadReaderV1 } from "./resolver.js";

/**
 * A message named a file this Bot does not hold: never uploaded to it, or
 * uploaded to another Bot. Named, because only the name survives the RPC.
 */
export class UploadNotFoundError extends Error {
  override readonly name = "UploadNotFoundError";
  constructor() {
    super(
      "One of the attached files is no longer available. Attach it again and send.",
    );
  }
}

interface UploadRecordStorageV1 {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

/** Records one upload this Bot now holds. The latest name wins. */
export async function recordUploadV1(
  storage: UploadRecordStorageV1,
  upload: StoredUploadV1,
): Promise<StoredUploadV1> {
  const decoded = decodeStoredUploadV1(upload);
  await storage.put(uploadRecordKeyV1(decoded.uploadId), decoded);
  return decoded;
}

/**
 * The attachments a turn command's refs name, in the order sent, or
 * `UploadNotFoundError` when any one of them is not this Bot's.
 */
export async function resolveUploadRefsV1(
  storage: Pick<UploadRecordStorageV1, "get">,
  refs: readonly UploadRefV1[] | undefined,
): Promise<MessageAttachmentV1[] | undefined> {
  if (!refs || refs.length === 0) return undefined;
  const decoded = decodeUploadRefsV1([...refs]);
  const attachments: MessageAttachmentV1[] = [];
  for (const ref of decoded) {
    const stored = await storage.get<unknown>(uploadRecordKeyV1(ref.uploadId));
    if (stored === undefined) throw new UploadNotFoundError();
    attachments.push(uploadAttachmentV1(decodeStoredUploadV1(stored)));
  }
  return attachments;
}

/** The R2 surface an upload reader needs. */
export interface UploadBucketV1 {
  get(
    key: string,
    options?: { range?: { offset: number; length: number } },
  ): Promise<{
    arrayBuffer(): Promise<ArrayBuffer>;
    customMetadata?: Record<string, string>;
  } | null>;
}

/**
 * Reads one Bot's uploads out of object storage. A document's excerpt reads
 * only the front of its text: four bytes a character is the most UTF-8 can
 * spend, so that many bytes always hold the characters asked for.
 */
export function createUploadReaderV1(
  bucket: UploadBucketV1,
  owner: { userId: string; botId: string },
): UploadReaderV1 {
  return {
    async bytes(uploadId) {
      const object = await bucket.get(
        uploadObjectKeyV1(owner.userId, owner.botId, uploadId),
      );
      return object ? new Uint8Array(await object.arrayBuffer()) : undefined;
    },
    async excerpt(uploadId, maxChars) {
      const object = await bucket.get(
        uploadTextKeyV1(owner.userId, owner.botId, uploadId),
        { range: { offset: 0, length: maxChars * 4 } },
      );
      if (!object) return undefined;
      // A range can end inside a character; the decoder drops that tail.
      const text = new TextDecoder()
        .decode(await object.arrayBuffer())
        .replace(/�$/, "")
        .slice(0, maxChars);
      const chars = Number(object.customMetadata?.chars);
      return {
        text,
        chars:
          Number.isSafeInteger(chars) && chars >= text.length
            ? chars
            : text.length,
      };
    },
  };
}
