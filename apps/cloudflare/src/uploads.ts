// The upload route: where a file's bytes go before the message that carries
// it is sent.
//
//   POST /api/bots/:botId/uploads?name=<file name>   body: the file's bytes
//   GET  /api/bots/:botId/uploads/:uploadId          the bytes again
//
// An upload is admitted durably before it is acknowledged. The route reads
// the bytes, decides what they are, extracts a document's text, counts them
// against the account's upload space, writes them to object storage under the
// Bot's own prefix, and has the Bot Durable Object record that it holds them
// — and only then answers with the upload's id, which is the SHA-256 of the
// bytes. A turn command names that id, and the Bot refuses any id it did not
// record, so a message can only carry a file its Bot was given.
//
// Nothing here spends money or reaches a third party except the document
// converter, and that runs with image description off, so it costs nothing.
// The steps are idempotent by content hash instead of recorded as intent: a
// retried upload of the same file counts once, writes the same bytes to the
// same key and records the same record. A write that fails after the space
// was counted leaves that one file counted until the Bot is deleted, which is
// the whole of what a crash can cost.
import {
  UPLOAD_ACCOUNT_QUOTA_BYTES_V1,
  UPLOAD_MAX_BYTES_V1,
} from "@frockbot/core/contracts";
import { decodeBotIdV1 } from "@frockbot/core/configuration";
import {
  extractDocumentTextV1,
  type DocumentConverterV1,
} from "@frockbot/app/uploads/extract";
import type { UploadQuotaAnswerV1 } from "@frockbot/app/uploads/quota";
import {
  classifyUploadV1,
  normalizeUploadNameV1,
  uploadBotPrefixV1,
  uploadObjectKeyV1,
  uploadTextKeyV1,
  type StoredUploadV1,
  type UploadReceiptV1,
} from "@frockbot/app/uploads/shared";
import type { BackendRouteContribution } from "./contracts.js";

const UPLOAD_PATH_V1 = /^\/api\/bots\/([^/]+)\/uploads$/;
const UPLOAD_READ_PATH_V1 = /^\/api\/bots\/([^/]+)\/uploads\/([0-9a-f]{64})$/;

/** The object store surface the route writes and reads. */
export interface UploadObjectStoreV1 {
  put(
    key: string,
    value: Uint8Array | string,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
  get(key: string): Promise<{
    body: ReadableStream<Uint8Array>;
    size: number;
    httpMetadata?: { contentType?: string };
  } | null>;
}

export interface UploadRouteDependenciesV1 {
  /** Absent in a deployment with no object store: uploads answer 503. */
  bucket?: UploadObjectStoreV1;
  /** Absent: only plain-text documents can be read. */
  converter?: DocumentConverterV1;
  botRegistered(userId: string, botId: string): Promise<boolean>;
  reserveQuota(input: {
    userId: string;
    botId: string;
    uploadId: string;
    bytes: number;
  }): Promise<UploadQuotaAnswerV1>;
  recordUpload(input: {
    userId: string;
    botId: string;
    upload: StoredUploadV1;
  }): Promise<StoredUploadV1>;
  now?(): Date;
}

function refusal(status: number, message: string): Response {
  return Response.json(
    { error: message },
    { status, headers: { "cache-control": "no-store" } },
  );
}

const TOO_LARGE_MESSAGE_V1 = `That file is larger than ${UPLOAD_MAX_BYTES_V1 / 1024 ** 2} MB.`;

/** The request body, refused once it passes the upload bound. */
async function readBoundedBodyV1(
  request: Request,
): Promise<Uint8Array | "too-large"> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > UPLOAD_MAX_BYTES_V1) {
    return "too-large";
  }
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > UPLOAD_MAX_BYTES_V1) {
      await reader.cancel();
      return "too-large";
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function sha256HexV1(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function botIdOf(segment: string): string | undefined {
  try {
    return decodeBotIdV1(decodeURIComponent(segment));
  } catch {
    return undefined;
  }
}

export function uploadRoutes(
  dependencies: UploadRouteDependenciesV1,
): BackendRouteContribution {
  const now = dependencies.now ?? (() => new Date());

  async function upload(
    request: Request,
    url: URL,
    userId: string,
    botId: string,
  ): Promise<Response> {
    const bucket = dependencies.bucket;
    if (!bucket) {
      return refusal(503, "Files can't be sent on this deployment.");
    }
    if (!(await dependencies.botRegistered(userId, botId))) {
      return refusal(404, "Bot not found");
    }
    const body = await readBoundedBodyV1(request);
    if (body === "too-large") return refusal(413, TOO_LARGE_MESSAGE_V1);
    if (body.byteLength === 0) return refusal(400, "That file is empty.");
    const name = normalizeUploadNameV1(url.searchParams.get("name"));
    const classified = classifyUploadV1({
      name,
      declaredType: request.headers.get("content-type"),
      bytes: body,
    });
    if (classified.status === "refused") {
      return refusal(415, classified.reason);
    }
    // Read before anything is stored or counted: a document with no text is
    // refused on the composer, not accepted and then shown to the Bot as
    // nothing.
    const text =
      classified.kind === "document"
        ? await extractDocumentTextV1({
            name,
            mediaType: classified.mediaType,
            bytes: body,
            ...(dependencies.converter
              ? { converter: dependencies.converter }
              : {}),
          })
        : undefined;
    if (text?.status === "refused") return refusal(422, text.reason);
    const uploadId = await sha256HexV1(body);
    const quota = await dependencies.reserveQuota({
      userId,
      botId,
      uploadId,
      bytes: body.byteLength,
    });
    if (quota.status === "full") {
      return refusal(
        413,
        `Your files use all ${UPLOAD_ACCOUNT_QUOTA_BYTES_V1 / 1024 ** 3} GB of upload space. Delete a Bot you no longer need to make room.`,
      );
    }
    await bucket.put(uploadObjectKeyV1(userId, botId, uploadId), body, {
      httpMetadata: { contentType: classified.mediaType },
    });
    if (text?.status === "ok") {
      await bucket.put(uploadTextKeyV1(userId, botId, uploadId), text.text, {
        httpMetadata: { contentType: "text/markdown; charset=utf-8" },
        customMetadata: { chars: String(text.chars) },
      });
    }
    const recorded = await dependencies.recordUpload({
      userId,
      botId,
      upload: {
        schemaVersion: 1,
        uploadId,
        kind: classified.kind,
        name,
        mediaType: classified.mediaType,
        bytes: body.byteLength,
        uploadedAt: now().toISOString(),
        ...(text?.status === "ok" ? { textChars: text.chars } : {}),
      },
    });
    return Response.json(
      {
        schemaVersion: 1,
        upload: {
          uploadId: recorded.uploadId,
          kind: recorded.kind,
          name: recorded.name,
          mediaType: recorded.mediaType,
          bytes: recorded.bytes,
        },
      } satisfies UploadReceiptV1,
      { status: 201, headers: { "cache-control": "no-store" } },
    );
  }

  async function read(
    userId: string,
    botId: string,
    uploadId: string,
  ): Promise<Response> {
    const object = await dependencies.bucket?.get(
      uploadObjectKeyV1(userId, botId, uploadId),
    );
    if (!object) return refusal(404, "That file is no longer available.");
    const contentType =
      object.httpMetadata?.contentType ?? "application/octet-stream";
    const image = contentType.startsWith("image/");
    return new Response(object.body, {
      headers: {
        "content-type": image ? contentType : "application/octet-stream",
        "content-length": String(object.size),
        // The URL names the bytes' hash, so they never change under it.
        "cache-control": "private, max-age=31536000, immutable",
        etag: `"${uploadId}"`,
        "x-content-type-options": "nosniff",
        // The person's own file, served from the app's origin: never a page.
        "content-security-policy": "default-src 'none'; sandbox",
        ...(image ? {} : { "content-disposition": "attachment" }),
      },
    });
  }

  return {
    packageId: "uploads",
    async route(request, url, context) {
      const uploadMatch = url.pathname.match(UPLOAD_PATH_V1);
      const readMatch = uploadMatch
        ? null
        : url.pathname.match(UPLOAD_READ_PATH_V1);
      if (!uploadMatch && !readMatch) return undefined;
      const userId = context.userId;
      if (!userId) return refusal(401, "authentication required");
      const botId = botIdOf((uploadMatch ?? readMatch)![1]!);
      if (!botId) return refusal(400, "invalid bot id");
      try {
        if (uploadMatch) {
          if (request.method !== "POST") {
            return refusal(405, "method not allowed");
          }
          return await upload(request, url, userId, botId);
        }
        if (request.method !== "GET") return refusal(405, "method not allowed");
        return await read(userId, botId, readMatch![2]!);
      } catch (error) {
        const name =
          typeof error === "object" && error !== null && "name" in error
            ? String(error.name)
            : "";
        if (name === "BotNotFoundError") return refusal(404, "Bot not found");
        if (name === "BotDeletedError") return refusal(410, "Bot is deleted");
        return refusal(
          503,
          "That file couldn't be saved. Try attaching it again.",
        );
      }
    },
  };
}

/** The bindings teardown needs to take a Bot's uploads with it. */
export interface UploadTeardownEnvV1 {
  MEMORY_FILES?: {
    list(options: {
      prefix: string;
      cursor?: string;
      limit?: number;
    }): Promise<{
      objects: { key: string }[];
      truncated: boolean;
      cursor?: string;
    }>;
    delete(keys: string | string[]): Promise<void>;
  };
  USER_CONFIGURATIONS: {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): unknown;
  };
}

/** Every object under one Bot's upload prefix, removed. Idempotent. */
export async function deleteBotUploadsV1(
  env: UploadTeardownEnvV1,
  identity: { userId: string; botId: string },
): Promise<number> {
  const bucket = env.MEMORY_FILES;
  if (!bucket) return 0;
  const prefix = uploadBotPrefixV1(identity.userId, identity.botId);
  let removed = 0;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({
      prefix,
      limit: 1_000,
      ...(cursor === undefined ? {} : { cursor }),
    });
    if (page.objects.length > 0) {
      await bucket.delete(page.objects.map((object) => object.key));
      removed += page.objects.length;
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  return removed;
}

/** Asks the User object to give back a deleted Bot's upload space. */
export async function releaseBotUploadQuotaRpcV1(
  env: UploadTeardownEnvV1,
  identity: { userId: string; botId: string },
): Promise<void> {
  // SAFETY: this binding names UserConfiguration; this is its reviewed RPC.
  const user = env.USER_CONFIGURATIONS.get(
    env.USER_CONFIGURATIONS.idFromName(identity.userId),
  ) as {
    releaseBotUploadQuota(input: {
      schemaVersion: 1;
      userId: string;
      botId: string;
    }): Promise<{ released: number }>;
  };
  await user.releaseBotUploadQuota({ schemaVersion: 1, ...identity });
}
