// The Bot's side of uploads: the records it keeps, the refs a message is
// checked against, and the reader a Turn resolves attachments through.
import {
  decodeUploadRefsV1,
  isUploadIdV1,
  messageAttachmentKindV1,
  type MessageAttachmentV1,
  type UploadRefV1,
} from "@frockbot/core/contracts";
import {
  decodeStoredUploadV1,
  normalizeUploadNameV1,
  uploadAttachmentV1,
  uploadObjectKeyV1,
  uploadRecordKeyV1,
  uploadTextKeyV1,
  UPLOAD_QUOTA_FULL_MESSAGE_V1,
  UPLOAD_RECORD_PREFIX_V1,
  type StoredUploadV1,
} from "./shared.js";
import type { UploadQuotaAnswerV1 } from "./quota.js";
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

/**
 * The uploads a list names, in its order: each entry is an upload's id, or
 * the name a file was attached under, which means the newest file of that
 * name. Answers the first entry that names nothing this Bot holds instead.
 */
export async function findBotUploadsV1(
  storage: Pick<UploadRecordStorageV1, "get"> & {
    list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  },
  entries: readonly string[],
): Promise<
  | { status: "ok"; attachments: MessageAttachmentV1[] }
  | { status: "missing"; entry: string }
> {
  let byName: Map<string, StoredUploadV1> | undefined;
  const attachments: MessageAttachmentV1[] = [];
  for (const entry of entries) {
    let found: StoredUploadV1 | undefined;
    if (isUploadIdV1(entry)) {
      const stored = await storage.get<unknown>(uploadRecordKeyV1(entry));
      found = stored === undefined ? undefined : decodeStoredUploadV1(stored);
    } else {
      if (!byName) {
        byName = new Map();
        const all = await storage.list<unknown>({
          prefix: UPLOAD_RECORD_PREFIX_V1,
        });
        for (const value of all.values()) {
          let upload: StoredUploadV1;
          try {
            upload = decodeStoredUploadV1(value);
          } catch {
            continue;
          }
          const held = byName.get(upload.name);
          if (!held || held.uploadedAt < upload.uploadedAt) {
            byName.set(upload.name, upload);
          }
        }
      }
      found = byName.get(entry);
    }
    if (!found) return { status: "missing", entry };
    if (!attachments.some((held) => held.uploadId === found.uploadId)) {
      attachments.push(uploadAttachmentV1(found));
    }
  }
  return { status: "ok", attachments };
}

/** One file the Bot keeps as an upload of its own, not one a person attached. */
export interface BotFileV1 {
  name: string;
  mediaType: string;
  bytes: Uint8Array;
  /** A document's text, as a model request reads it. */
  text?: string;
}

/** Where a Bot's own files go: the upload route's store and ledger. */
export interface BotFileStoreV1 {
  bucket: {
    put(
      key: string,
      value: Uint8Array | string,
      options?: {
        httpMetadata?: { contentType?: string };
        customMetadata?: Record<string, string>;
      },
    ): Promise<unknown>;
    delete(keys: string[]): Promise<unknown>;
  };
  storage: UploadRecordStorageV1 & { delete(key: string): Promise<boolean> };
  /** Counts one file against the account's upload space, once. */
  reserveQuota(input: {
    uploadId: string;
    bytes: number;
  }): Promise<UploadQuotaAnswerV1>;
  /** Gives back the space of files this Bot deleted. */
  releaseQuota(uploadIds: string[]): Promise<void>;
  now(): Date;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Keeps files the Bot was handed by the product — a recording the person
 * made on the Computer — exactly as the upload route keeps a file they
 * attach: counted against the account first, the bytes and a document's text
 * under the Bot's own prefix, then the record a message is checked against.
 * Content-addressed, so keeping the same files again counts and writes
 * nothing new. Answers the attachments a message names them by.
 */
export async function keepBotFilesV1(
  store: BotFileStoreV1,
  owner: { userId: string; botId: string },
  files: readonly BotFileV1[],
): Promise<MessageAttachmentV1[]> {
  const attachments: MessageAttachmentV1[] = [];
  for (const file of files) {
    const kind = messageAttachmentKindV1(file.mediaType);
    if (!kind) throw new Error(`a ${file.mediaType} file can't be kept`);
    const uploadId = await sha256Hex(file.bytes);
    const quota = await store.reserveQuota({
      uploadId,
      bytes: file.bytes.byteLength,
    });
    if (quota.status === "full") throw new Error(UPLOAD_QUOTA_FULL_MESSAGE_V1);
    await store.bucket.put(
      uploadObjectKeyV1(owner.userId, owner.botId, uploadId),
      file.bytes,
      { httpMetadata: { contentType: file.mediaType } },
    );
    if (kind === "document" && file.text !== undefined) {
      await store.bucket.put(
        uploadTextKeyV1(owner.userId, owner.botId, uploadId),
        file.text,
        {
          httpMetadata: { contentType: "text/markdown; charset=utf-8" },
          customMetadata: { chars: String(file.text.length) },
        },
      );
    }
    const recorded = await recordUploadV1(store.storage, {
      schemaVersion: 1,
      uploadId,
      kind,
      name: normalizeUploadNameV1(file.name),
      mediaType: file.mediaType,
      bytes: file.bytes.byteLength,
      uploadedAt: store.now().toISOString(),
      ...(kind === "document" && file.text !== undefined
        ? { textChars: file.text.length }
        : {}),
    });
    attachments.push(uploadAttachmentV1(recorded));
  }
  return attachments;
}

/**
 * Deletes some of the Bot's uploads: their bytes and text, the records a
 * message is checked against, and their count against the account. A
 * message that carried one keeps saying it did, and its file reads as no
 * longer available. Idempotent.
 */
export async function removeBotFilesV1(
  store: BotFileStoreV1,
  owner: { userId: string; botId: string },
  uploadIds: readonly string[],
): Promise<void> {
  const unique = [...new Set(uploadIds)];
  if (unique.length === 0) return;
  await store.bucket.delete(
    unique.flatMap((uploadId) => [
      uploadObjectKeyV1(owner.userId, owner.botId, uploadId),
      uploadTextKeyV1(owner.userId, owner.botId, uploadId),
    ]),
  );
  for (const uploadId of unique) {
    await store.storage.delete(uploadRecordKeyV1(uploadId));
  }
  await store.releaseQuota(unique);
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
        .replace(/\uFFFD$/, "")
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
