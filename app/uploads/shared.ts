// What the person attaches to a message, before it is a message.
//
// An upload is content-addressed and owned by one Bot: its bytes live in
// object storage under the Bot's own prefix, a document's text beside them,
// and the Bot Durable Object keeps a small record of each one it holds. The
// record is what a turn command's ref is checked against, so a message can
// only ever carry a file this Bot was actually given.
import {
  ATTACHMENT_NAME_MAX_LENGTH_V1,
  DOCX_MEDIA_TYPE_V1,
  isAttachmentNameV1,
  isUploadIdV1,
  messageAttachmentKindV1,
  PPTX_MEDIA_TYPE_V1,
  XLSX_MEDIA_TYPE_V1,
  type MessageAttachmentKindV1,
  type MessageAttachmentV1,
} from "@frockbot/core/contracts";

/** Every upload's bytes and text live under this object-store prefix. */
export const UPLOAD_OBJECT_PREFIX_V1 = "uploads";

/** The prefix one Bot's uploads share, and nothing else's. */
export function uploadBotPrefixV1(userId: string, botId: string): string {
  return `${UPLOAD_OBJECT_PREFIX_V1}/${userId}/${botId}/`;
}

/** Where one upload's bytes are. */
export function uploadObjectKeyV1(
  userId: string,
  botId: string,
  uploadId: string,
): string {
  if (!isUploadIdV1(uploadId)) throw new Error("upload id is invalid");
  return `${uploadBotPrefixV1(userId, botId)}${uploadId}`;
}

/** Where one document's extracted text is. */
export function uploadTextKeyV1(
  userId: string,
  botId: string,
  uploadId: string,
): string {
  return `${uploadObjectKeyV1(userId, botId, uploadId)}.md`;
}

/** The Bot Durable Object key holding one upload's record. */
export const UPLOAD_RECORD_PREFIX_V1 = "upload:";

export function uploadRecordKeyV1(uploadId: string): string {
  if (!isUploadIdV1(uploadId)) throw new Error("upload id is invalid");
  return `${UPLOAD_RECORD_PREFIX_V1}${uploadId}`;
}

/** What the Bot remembers about one file it was given. */
export interface StoredUploadV1 {
  schemaVersion: 1;
  uploadId: string;
  kind: MessageAttachmentKindV1;
  name: string;
  mediaType: string;
  bytes: number;
  uploadedAt: string;
  /** A document's text length in characters. Absent for an image. */
  textChars?: number;
}

export function decodeStoredUploadV1(value: unknown): StoredUploadV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("stored upload is invalid");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set([
    "schemaVersion",
    "uploadId",
    "kind",
    "name",
    "mediaType",
    "bytes",
    "uploadedAt",
    "textChars",
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new Error("stored upload has invalid fields");
  }
  const kind =
    typeof record.mediaType === "string"
      ? messageAttachmentKindV1(record.mediaType)
      : undefined;
  if (
    record.schemaVersion !== 1 ||
    !isUploadIdV1(record.uploadId) ||
    !kind ||
    record.kind !== kind ||
    !isAttachmentNameV1(record.name) ||
    !Number.isSafeInteger(record.bytes) ||
    (record.bytes as number) < 1 ||
    typeof record.uploadedAt !== "string" ||
    !Number.isFinite(Date.parse(record.uploadedAt)) ||
    (record.textChars !== undefined &&
      (!Number.isSafeInteger(record.textChars) ||
        (record.textChars as number) < 0))
  ) {
    throw new Error("stored upload is invalid");
  }
  return {
    schemaVersion: 1,
    uploadId: record.uploadId,
    kind,
    name: record.name,
    mediaType: record.mediaType as string,
    bytes: record.bytes as number,
    uploadedAt: record.uploadedAt,
    ...(record.textChars === undefined
      ? {}
      : { textChars: record.textChars as number }),
  };
}

/** The reference a message carries for a stored upload. */
export function uploadAttachmentV1(
  upload: StoredUploadV1,
): MessageAttachmentV1 {
  return {
    kind: upload.kind,
    uploadId: upload.uploadId,
    name: upload.name,
    mediaType: upload.mediaType,
    bytes: upload.bytes,
  };
}

/** What the upload route answers, and what the composer holds until Send. */
export interface UploadReceiptV1 {
  schemaVersion: 1;
  upload: {
    uploadId: string;
    kind: MessageAttachmentKindV1;
    name: string;
    mediaType: string;
    bytes: number;
  };
}

/**
 * A file name as it will be shown and stored: the last path segment, controls
 * removed, trimmed and bounded. A name that is nothing after all that is
 * `file`, which is what a person would call it.
 */
export function normalizeUploadNameV1(raw: string | null | undefined): string {
  const last = (raw ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = last
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, "")
    .trim()
    .slice(0, ATTACHMENT_NAME_MAX_LENGTH_V1)
    .trim();
  return cleaned.length > 0 ? cleaned : "file";
}

const EXTENSION_MEDIA_TYPES_V1: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  pdf: "application/pdf",
  docx: DOCX_MEDIA_TYPE_V1,
  xlsx: XLSX_MEDIA_TYPE_V1,
  pptx: PPTX_MEDIA_TYPE_V1,
  csv: "text/csv",
  md: "text/markdown",
  markdown: "text/markdown",
  json: "application/json",
  txt: "text/plain",
};

/**
 * Extensions read as plain text. Source code is the bulk of it: what a model
 * needs to know about a `.py` file is that it is text, and its name says the
 * rest.
 */
const PLAIN_TEXT_EXTENSIONS_V1 = new Set([
  "text",
  "log",
  "rst",
  "tex",
  "tsv",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "env",
  "xml",
  "html",
  "htm",
  "css",
  "scss",
  "less",
  "sql",
  "graphql",
  "proto",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "kts",
  "swift",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "php",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "dart",
  "lua",
  "r",
  "pl",
  "scala",
  "ex",
  "exs",
  "erl",
  "hs",
  "clj",
  "ml",
  "fs",
  "m",
  "mm",
  "gradle",
  "tf",
  "vue",
  "svelte",
  "ipynb",
]);

/** File names that are text though they carry no extension. */
const PLAIN_TEXT_NAMES_V1 = new Set([
  "dockerfile",
  "makefile",
  "license",
  "readme",
  "gemfile",
  "procfile",
]);

function extensionOf(name: string): string | undefined {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return undefined;
  return name.slice(dot + 1).toLowerCase();
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return (
    bytes.length >= prefix.length &&
    prefix.every((byte, index) => bytes[index] === byte)
  );
}

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

/** What the first bytes say a file is, where they say anything. */
export function sniffUploadMediaTypeV1(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a")
    return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP")
    return "image/webp";
  if (ascii(bytes, 0, 5) === "%PDF-") return "application/pdf";
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return "application/zip";
  if (ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4);
    if (/^(heic|heix|hevc|heim|heis|mif1|msf1|avif)$/.test(brand))
      return "image/heic";
  }
  return undefined;
}

/** Valid UTF-8 with no NUL byte: what "this is text" means here. */
export function decodeUploadTextV1(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.startsWith("﻿") ? text.slice(1) : text;
  } catch {
    return undefined;
  }
}

export type UploadClassificationV1 =
  | { status: "ok"; kind: MessageAttachmentKindV1; mediaType: string }
  | { status: "refused"; reason: string };

/**
 * What an upload is, from its bytes first and its name second.
 *
 * The bytes decide anything they can name: a photo called `.png` that is a
 * JPEG is a JPEG, and a file that is neither an image nor a document is
 * refused whatever it is called. A ZIP is only ever an Office document, and
 * its extension says which. Text is text when it decodes as UTF-8 and its
 * name or declared type says it is meant to be read.
 */
export function classifyUploadV1(input: {
  name: string;
  declaredType?: string | null;
  bytes: Uint8Array;
}): UploadClassificationV1 {
  const extension = extensionOf(input.name);
  const declared = (input.declaredType ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  const sniffed = sniffUploadMediaTypeV1(input.bytes);
  if (sniffed === "image/heic") {
    return {
      status: "refused",
      reason:
        "HEIC photos can't be sent as they are. Update the app, or send the photo as a JPEG.",
    };
  }
  if (sniffed && sniffed !== "application/zip") {
    const kind = messageAttachmentKindV1(sniffed);
    return kind
      ? { status: "ok", kind, mediaType: sniffed }
      : { status: "refused", reason: "That kind of file can't be sent." };
  }
  if (sniffed === "application/zip") {
    const byName = extension ? EXTENSION_MEDIA_TYPES_V1[extension] : undefined;
    const office = [DOCX_MEDIA_TYPE_V1, XLSX_MEDIA_TYPE_V1, PPTX_MEDIA_TYPE_V1];
    const mediaType = office.includes(byName ?? "")
      ? byName!
      : office.includes(declared)
        ? declared
        : undefined;
    return mediaType
      ? { status: "ok", kind: "document", mediaType }
      : {
          status: "refused",
          reason:
            "ZIP files can't be sent. Send the documents inside it instead.",
        };
  }
  // Only a file meant to be read is sent as text; a binary that happens to
  // decode is not a document.
  const textual =
    (extension !== undefined &&
      (PLAIN_TEXT_EXTENSIONS_V1.has(extension) ||
        ["csv", "md", "markdown", "json", "txt"].includes(extension))) ||
    PLAIN_TEXT_NAMES_V1.has(input.name.toLowerCase()) ||
    declared.startsWith("text/") ||
    declared === "application/json";
  if (!textual) {
    return {
      status: "refused",
      reason:
        "That kind of file can't be sent. Images, PDFs, Office documents and text files can.",
    };
  }
  if (decodeUploadTextV1(input.bytes) === undefined) {
    return {
      status: "refused",
      reason: "That file isn't readable text.",
    };
  }
  const byName = extension ? EXTENSION_MEDIA_TYPES_V1[extension] : undefined;
  const mediaType =
    byName && messageAttachmentKindV1(byName) === "document"
      ? byName
      : declared === "text/csv" ||
          declared === "text/markdown" ||
          declared === "application/json"
        ? declared
        : "text/plain";
  return { status: "ok", kind: "document", mediaType };
}
