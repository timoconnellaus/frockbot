// What a model request's attachments name, filled in for one dispatch.
//
// The loop journals a request with references in it, then hands it to the
// model registry, which asks this resolver for the bytes and text before a
// provider sees it. Nothing resolved here is ever written down, and a request
// re-dispatched after an eviction resolves the same content-addressed bytes
// again, so an attached image survives an eviction instead of turning into a
// placeholder.
//
// How much is resolved is bounded here, newest first, because the history
// budget measures a message by its durable shape — a reference a few hundred
// characters long. Attachments on the newest few messages are shown; older
// ones are named and not shown, which every provider adapter says in words
// (`userMessagePartsV1`), so the Bot always knows a file was there.
import {
  ATTACHMENT_HISTORY_MESSAGES_V1,
  DOCUMENT_EXCERPT_CHARS_V1,
  DOCUMENT_REQUEST_BUDGET_CHARS_V1,
  IMAGE_REQUEST_LIMIT_V1,
  type LlmMessage,
  type MessageAttachmentV1,
  type ModelAttachmentResolverV1,
  type NormalizedModelRequest,
  type ToolAttachmentV1,
  type WorkspaceFilesV1,
} from "@frockbot/core/contracts";

/**
 * The largest image a request carries. The device scales a photo to 2,048
 * pixels before it is sent; an image past this is a file the model would be
 * refused anyway, so it is named rather than shown.
 */
export const MODEL_IMAGE_MAX_BYTES_V1 = 8 * 1024 * 1024;

/** A document excerpt shorter than this is not worth the space. */
const DOCUMENT_EXCERPT_MIN_CHARS_V1 = 1_000;

/** The Bot's own uploads, read by id. */
export interface UploadReaderV1 {
  /** An image's bytes, or nothing when this Bot holds no such upload. */
  bytes(uploadId: string): Promise<Uint8Array | undefined>;
  /** The first `maxChars` of a document's text, and how long it is in all. */
  excerpt(
    uploadId: string,
    maxChars: number,
  ): Promise<{ text: string; chars: number } | undefined>;
}

/** Base64 without a Node Buffer: this runs in workerd. */
export function base64OfBytesV1(bytes: Uint8Array): string {
  let binary = "";
  const step = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
  }
  return btoa(binary);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** The words a request carries for a document, with how much it left out. */
export function documentExcerptTextV1(excerpt: {
  text: string;
  chars: number;
}): string {
  return excerpt.chars > excerpt.text.length
    ? `${excerpt.text}\n\n[This is the first ${excerpt.text.length.toLocaleString("en-US")} of ${excerpt.chars.toLocaleString("en-US")} characters.]`
    : excerpt.text;
}

/**
 * One resolver per mounted Turn. It remembers what it read, so the steps of a
 * Turn read each file once; the memory goes with the Turn.
 */
export function createModelAttachmentResolverV1(options: {
  uploads?: UploadReaderV1;
  /** Where a tool result's image lives, for one the Session no longer holds. */
  workspace?: Pick<WorkspaceFilesV1, "read">;
}): ModelAttachmentResolverV1 {
  const images = new Map<string, string | null>();
  const excerpts = new Map<string, { text: string; chars: number } | null>();
  const workspaceImages = new Map<string, string | null>();

  async function uploadImage(uploadId: string): Promise<string | undefined> {
    if (!images.has(uploadId)) {
      const bytes = await options.uploads?.bytes(uploadId);
      images.set(
        uploadId,
        bytes &&
          bytes.byteLength <= MODEL_IMAGE_MAX_BYTES_V1 &&
          (await sha256Hex(bytes)) === uploadId
          ? base64OfBytesV1(bytes)
          : null,
      );
    }
    return images.get(uploadId) ?? undefined;
  }

  async function uploadExcerpt(
    uploadId: string,
    maxChars: number,
  ): Promise<{ text: string; chars: number } | undefined> {
    const key = `${uploadId}:${maxChars}`;
    if (!excerpts.has(key)) {
      excerpts.set(
        key,
        (await options.uploads?.excerpt(uploadId, maxChars)) ?? null,
      );
    }
    return excerpts.get(key) ?? undefined;
  }

  async function toolImage(
    attachment: ToolAttachmentV1,
  ): Promise<string | undefined> {
    const workspace = options.workspace;
    if (!workspace) return undefined;
    if (!workspaceImages.has(attachment.contentHash)) {
      const outcome = await workspace.read(attachment.workspacePath);
      workspaceImages.set(
        attachment.contentHash,
        outcome.status === "ok" &&
          outcome.file.generation.contentHash === attachment.contentHash &&
          outcome.file.bytes.byteLength <= MODEL_IMAGE_MAX_BYTES_V1
          ? base64OfBytesV1(outcome.file.bytes)
          : null,
      );
    }
    return workspaceImages.get(attachment.contentHash) ?? undefined;
  }

  return {
    async resolve(request: NormalizedModelRequest, signal: AbortSignal) {
      const messages = [...request.messages];
      let imagesLeft = IMAGE_REQUEST_LIMIT_V1;
      let textLeft = DOCUMENT_REQUEST_BUDGET_CHARS_V1;
      let attachedMessages = 0;
      // Newest first: what the person just sent is what the request is for.
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        signal.throwIfAborted();
        const message = messages[index]!;
        if (message.role === "user" && message.attachments?.length) {
          attachedMessages += 1;
          if (attachedMessages > ATTACHMENT_HISTORY_MESSAGES_V1) continue;
          const resolved: MessageAttachmentV1[] = [];
          for (const attachment of message.attachments) {
            if (attachment.kind === "image") {
              const data =
                attachment.dataBase64 ??
                (imagesLeft > 0
                  ? await uploadImage(attachment.uploadId)
                  : undefined);
              if (data !== undefined) imagesLeft -= 1;
              resolved.push(
                data === undefined
                  ? attachment
                  : { ...attachment, dataBase64: data },
              );
              continue;
            }
            const allowance = Math.min(DOCUMENT_EXCERPT_CHARS_V1, textLeft);
            const excerpt =
              attachment.text === undefined &&
              allowance >= DOCUMENT_EXCERPT_MIN_CHARS_V1
                ? await uploadExcerpt(attachment.uploadId, allowance)
                : undefined;
            if (excerpt) textLeft -= excerpt.text.length;
            resolved.push(
              excerpt
                ? { ...attachment, text: documentExcerptTextV1(excerpt) }
                : attachment,
            );
          }
          messages[index] = { ...message, attachments: resolved };
          continue;
        }
        if (message.role === "tool" && message.attachments?.length) {
          const resolved: ToolAttachmentV1[] = [];
          for (const attachment of message.attachments) {
            const data =
              attachment.dataBase64 ??
              (imagesLeft > 0 ? await toolImage(attachment) : undefined);
            if (data !== undefined) imagesLeft -= 1;
            resolved.push(
              data === undefined
                ? attachment
                : { ...attachment, dataBase64: data },
            );
          }
          messages[index] = {
            ...message,
            attachments: resolved,
          } satisfies LlmMessage;
        }
      }
      return { ...request, messages };
    },
  };
}
