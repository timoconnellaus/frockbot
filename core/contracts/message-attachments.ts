// A file the person attached to a message.
//
// An attachment crosses the client's turn command, the Bot Durable Object's
// run RPC, the durable run record, the Agent loop's queued input, the session
// log and the model request, so its shape lives in the kernel. Across every
// one of those seams it is a reference: the upload's content hash, its name,
// its media type and its size. The bytes live in object storage beside the
// Bot that owns them, and a document's text beside its bytes.
//
// Only one step ever holds more than the reference: the model call itself. A
// request is journaled before it is dispatched, and the host fills in the
// image bytes and the document text for that one dispatch afterwards, so
// neither is ever written to the log. `dataBase64` and `text` are that
// resolution, and a durable decode refuses both.
import { exactKeysV1, recordV1 } from "./records.js";

/** Most files one message may carry. */
export const MESSAGE_ATTACHMENT_LIMIT_V1 = 5;

/** The largest file one upload may be, in bytes. */
export const UPLOAD_MAX_BYTES_V1 = 20 * 1024 * 1024;

/** What one account may hold in uploads, across all of its Bots. */
export const UPLOAD_ACCOUNT_QUOTA_BYTES_V1 = 5 * 1024 * 1024 * 1024;

/** The longest file name an attachment keeps. */
export const ATTACHMENT_NAME_MAX_LENGTH_V1 = 255;

/** How much of one document's text a model request carries. */
export const DOCUMENT_EXCERPT_CHARS_V1 = 30_000;

/**
 * How much document text one model request carries in all.
 *
 * The history budget measures a message by its durable shape, and a durable
 * attachment is a reference a few hundred characters long. The text a request
 * resolves on top of that is bounded here instead, newest message first.
 */
export const DOCUMENT_REQUEST_BUDGET_CHARS_V1 = 90_000;

/** How many images one model request shows, newest first. */
export const IMAGE_REQUEST_LIMIT_V1 = 8;

/**
 * How many of the newest messages carrying attachments a request resolves.
 *
 * The same horizon as a tool result's verbatim window: a Turn three messages
 * back is still the conversation, and one further back is history the Bot
 * remembers rather than rereads. Older attachments are named, not shown.
 */
export const ATTACHMENT_HISTORY_MESSAGES_V1 = 3;

export type MessageAttachmentKindV1 = "image" | "document";

/** Images go to the model as images. HEIC is converted on the device. */
export const MESSAGE_IMAGE_MEDIA_TYPES_V1 = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export const DOCX_MEDIA_TYPE_V1 =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export const XLSX_MEDIA_TYPE_V1 =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
export const PPTX_MEDIA_TYPE_V1 =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation";

/**
 * Documents go to the model as text. Source code arrives as `text/plain`:
 * what matters about it is that it is text, not which language it is.
 */
export const MESSAGE_DOCUMENT_MEDIA_TYPES_V1 = [
  "application/pdf",
  DOCX_MEDIA_TYPE_V1,
  XLSX_MEDIA_TYPE_V1,
  PPTX_MEDIA_TYPE_V1,
  "text/csv",
  "text/plain",
  "text/markdown",
  "application/json",
] as const;

export type MessageImageMediaTypeV1 =
  (typeof MESSAGE_IMAGE_MEDIA_TYPES_V1)[number];
export type MessageDocumentMediaTypeV1 =
  (typeof MESSAGE_DOCUMENT_MEDIA_TYPES_V1)[number];

/** Which kind a media type is, or nothing for a type no message may carry. */
export function messageAttachmentKindV1(
  mediaType: string,
): MessageAttachmentKindV1 | undefined {
  if ((MESSAGE_IMAGE_MEDIA_TYPES_V1 as readonly string[]).includes(mediaType))
    return "image";
  if (
    (MESSAGE_DOCUMENT_MEDIA_TYPES_V1 as readonly string[]).includes(mediaType)
  )
    return "document";
  return undefined;
}

/**
 * One attached file.
 *
 * `uploadId` is the SHA-256 of the bytes, lowercase hex: the upload is
 * content-addressed, so the id says exactly which bytes were sent.
 */
export interface MessageAttachmentV1 {
  kind: MessageAttachmentKindV1;
  uploadId: string;
  name: string;
  mediaType: string;
  bytes: number;
  /** An image's bytes, resolved for one model request. Never durable. */
  dataBase64?: string;
  /** A document's text excerpt, resolved for one model request. Never durable. */
  text?: string;
}

/** What a turn command names: an upload the Bot already holds. */
export interface UploadRefV1 {
  uploadId: string;
}

const UPLOAD_ID_PATTERN = /^[0-9a-f]{64}$/;
/** C0 controls, DEL and the line and paragraph separators. */
const NAME_FORBIDDEN = /[\u0000-\u001f\u007f\u2028\u2029]/;

export function isUploadIdV1(value: unknown): value is string {
  return typeof value === "string" && UPLOAD_ID_PATTERN.test(value);
}

/** True for a file name an attachment may carry. Total; never throws. */
export function isAttachmentNameV1(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= ATTACHMENT_NAME_MAX_LENGTH_V1 &&
    !NAME_FORBIDDEN.test(value) &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

/** The refs a turn command carries. Bounded, unique, in the order sent. */
export function decodeUploadRefsV1(
  value: unknown,
  label = "attachments",
): UploadRefV1[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length === 0) throw new Error(`${label} must not be empty`);
  if (value.length > MESSAGE_ATTACHMENT_LIMIT_V1) {
    throw new Error(
      `${label} may name at most ${MESSAGE_ATTACHMENT_LIMIT_V1} files`,
    );
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const item = `${label}[${index}]`;
    const ref = recordV1(entry, item);
    exactKeysV1(ref, ["uploadId"], [], item);
    if (!isUploadIdV1(ref.uploadId)) {
      throw new Error(`${item}.uploadId is invalid`);
    }
    if (seen.has(ref.uploadId)) {
      throw new Error(`${label} names "${ref.uploadId}" more than once`);
    }
    seen.add(ref.uploadId);
    return { uploadId: ref.uploadId };
  });
}

/**
 * The exact v1 decoder for the attachments one message carries.
 *
 * `durable` refuses the two resolved fields: bytes and text belong to one
 * model request and never to the log, so a record carrying them is refused at
 * the seam rather than trimmed.
 */
export function decodeMessageAttachmentsV1(
  value: unknown,
  label: string,
  durable: boolean,
): MessageAttachmentV1[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length === 0 || value.length > MESSAGE_ATTACHMENT_LIMIT_V1) {
    throw new Error(
      `${label} must hold 1 to ${MESSAGE_ATTACHMENT_LIMIT_V1} attachments`,
    );
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const item = `${label}[${index}]`;
    const attachment = recordV1(entry, item);
    exactKeysV1(
      attachment,
      ["kind", "uploadId", "name", "mediaType", "bytes"],
      durable ? [] : ["dataBase64", "text"],
      item,
    );
    if (!isUploadIdV1(attachment.uploadId)) {
      throw new Error(`${item}.uploadId is invalid`);
    }
    if (seen.has(attachment.uploadId)) {
      throw new Error(`${label} names one upload more than once`);
    }
    seen.add(attachment.uploadId);
    if (typeof attachment.mediaType !== "string") {
      throw new Error(`${item}.mediaType is invalid`);
    }
    const kind = messageAttachmentKindV1(attachment.mediaType);
    if (!kind || attachment.kind !== kind) {
      throw new Error(`${item}.kind does not match its media type`);
    }
    if (!isAttachmentNameV1(attachment.name)) {
      throw new Error(`${item}.name is invalid`);
    }
    if (
      !Number.isSafeInteger(attachment.bytes) ||
      (attachment.bytes as number) < 1 ||
      (attachment.bytes as number) > UPLOAD_MAX_BYTES_V1
    ) {
      throw new Error(`${item}.bytes is invalid`);
    }
    if (
      attachment.dataBase64 !== undefined &&
      (kind !== "image" || typeof attachment.dataBase64 !== "string")
    ) {
      throw new Error(`${item}.dataBase64 is invalid`);
    }
    if (
      attachment.text !== undefined &&
      (kind !== "document" || typeof attachment.text !== "string")
    ) {
      throw new Error(`${item}.text is invalid`);
    }
    return {
      kind,
      uploadId: attachment.uploadId,
      name: attachment.name,
      mediaType: attachment.mediaType,
      bytes: attachment.bytes as number,
      ...(attachment.dataBase64 === undefined
        ? {}
        : { dataBase64: attachment.dataBase64 as string }),
      ...(attachment.text === undefined
        ? {}
        : { text: attachment.text as string }),
    };
  });
}

/** The reference alone, whatever was resolved onto it. */
export function durableMessageAttachmentV1(
  attachment: MessageAttachmentV1,
): MessageAttachmentV1 {
  return {
    kind: attachment.kind,
    uploadId: attachment.uploadId,
    name: attachment.name,
    mediaType: attachment.mediaType,
    bytes: attachment.bytes,
  };
}

/** `1.2 MB`, `340 KB`: how big a file is, in words a model reads easily. */
export function attachmentSizeLabelV1(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function quotedName(name: string): string {
  return JSON.stringify(name);
}

/** One part of a user message, as every provider adapter draws it. */
export type UserMessagePartV1 =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: string; dataBase64: string; name: string };

/**
 * A user message as the parts a provider sends: the person's words, each
 * document's text, and each image — or, for anything this request does not
 * carry, one line saying so.
 *
 * Shared so every adapter says the same thing about an attachment it cannot
 * show. A Bot has to be able to tell "I saw the picture" from "I was told a
 * picture exists", and a silent drop leaves it guessing.
 */
export function userMessagePartsV1(
  message: { content: string; attachments?: readonly MessageAttachmentV1[] },
  options: { images: boolean },
): UserMessagePartV1[] {
  const parts: UserMessagePartV1[] = [];
  if (message.content) parts.push({ type: "text", text: message.content });
  for (const attachment of message.attachments ?? []) {
    const label = `${quotedName(attachment.name)} (${attachment.mediaType}, ${attachmentSizeLabelV1(attachment.bytes)})`;
    if (attachment.kind === "document") {
      parts.push({
        type: "text",
        text:
          attachment.text === undefined
            ? `[Document ${label} is attached to this message. Its text is not included in this request.]`
            : `<attachment name=${quotedName(attachment.name)} type="${attachment.mediaType}">\n${attachment.text}\n</attachment>`,
      });
      continue;
    }
    if (attachment.dataBase64 === undefined) {
      parts.push({
        type: "text",
        text: `[Image ${label} is attached to this message. It is not shown in this request.]`,
      });
    } else if (!options.images) {
      parts.push({
        type: "text",
        text: `[Image ${label} is attached to this message. This model cannot see images.]`,
      });
    } else {
      parts.push({
        type: "image",
        mediaType: attachment.mediaType,
        dataBase64: attachment.dataBase64,
        name: attachment.name,
      });
    }
  }
  return parts;
}
