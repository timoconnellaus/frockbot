import { describe, expect, test } from "bun:test";
import type { StoredUploadV1 } from "@frockbot/app/uploads/shared";
import {
  deleteBotUploadsV1,
  releaseBotUploadQuotaRpcV1,
  uploadRoutes,
  type UploadObjectStoreV1,
  type UploadRouteDependenciesV1,
} from "./uploads.js";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

interface Harness {
  dependencies: UploadRouteDependenciesV1;
  objects: Map<
    string,
    { value: Uint8Array | string; contentType?: string; metadata?: unknown }
  >;
  records: StoredUploadV1[];
  reserved: unknown[];
}

function harness(overrides: Partial<UploadRouteDependenciesV1> = {}): Harness {
  const objects: Harness["objects"] = new Map();
  const records: StoredUploadV1[] = [];
  const reserved: unknown[] = [];
  const bucket: UploadObjectStoreV1 = {
    put: async (key, value, options) => {
      objects.set(key, {
        value,
        ...(options?.httpMetadata?.contentType
          ? { contentType: options.httpMetadata.contentType }
          : {}),
        ...(options?.customMetadata
          ? { metadata: options.customMetadata }
          : {}),
      });
    },
    get: async (key) => {
      const object = objects.get(key);
      if (!object) return null;
      const bytes =
        typeof object.value === "string"
          ? new TextEncoder().encode(object.value)
          : object.value;
      return {
        body: new Blob([bytes as BlobPart]).stream(),
        size: bytes.byteLength,
        httpMetadata: { contentType: object.contentType },
      };
    },
  };
  return {
    objects,
    records,
    reserved,
    dependencies: {
      bucket,
      botRegistered: async (_userId, botId) => botId === "bot-1",
      reserveQuota: async (input) => {
        reserved.push(input);
        return { status: "reserved", usedBytes: input.bytes };
      },
      recordUpload: async ({ upload }) => {
        records.push(upload);
        return upload;
      },
      now: () => new Date("2026-09-24T00:00:00.000Z"),
      ...overrides,
    },
  };
}

function post(
  body: BodyInit,
  name: string,
  contentType = "application/octet-stream",
  botId = "bot-1",
): [Request, URL] {
  const url = new URL(
    `https://bot.frockbot.test/api/bots/${botId}/uploads?name=${encodeURIComponent(name)}`,
  );
  return [
    new Request(url, {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    }),
    url,
  ];
}

const context = {
  userId: "user-1",
  client: "browser" as const,
  isAdmin: false,
};

describe("the upload route", () => {
  test("admits an image durably, then answers with its hash", async () => {
    const h = harness();
    const [request, url] = post(JPEG, "photos/beach.png", "image/png");
    const response = await uploadRoutes(h.dependencies).route(
      request,
      url,
      context,
    );
    expect(response?.status).toBe(201);
    const uploadId = await sha256Hex(JPEG);
    expect(await response!.json<unknown>()).toEqual({
      schemaVersion: 1,
      upload: {
        uploadId,
        kind: "image",
        name: "beach.png",
        mediaType: "image/jpeg",
        bytes: JPEG.byteLength,
      },
    });
    expect(h.objects.get(`uploads/user-1/bot-1/${uploadId}`)?.contentType).toBe(
      "image/jpeg",
    );
    expect(h.records).toEqual([
      {
        schemaVersion: 1,
        uploadId,
        kind: "image",
        name: "beach.png",
        mediaType: "image/jpeg",
        bytes: JPEG.byteLength,
        uploadedAt: "2026-09-24T00:00:00.000Z",
      },
    ]);
    expect(h.reserved).toEqual([
      { userId: "user-1", botId: "bot-1", uploadId, bytes: JPEG.byteLength },
    ]);
  });

  test("keeps a document's text beside its bytes", async () => {
    const h = harness();
    const bytes = new TextEncoder().encode("a,b\n1,2\n");
    const [request, url] = post(bytes, "data.csv", "text/csv");
    const response = await uploadRoutes(h.dependencies).route(
      request,
      url,
      context,
    );
    expect(response?.status).toBe(201);
    const uploadId = await sha256Hex(bytes);
    expect(h.objects.get(`uploads/user-1/bot-1/${uploadId}.md`)).toMatchObject({
      value: "a,b\n1,2",
      metadata: { chars: "7" },
    });
    expect(h.records[0]).toMatchObject({ kind: "document", textChars: 7 });
  });

  test("refuses what it cannot send, before storing or counting anything", async () => {
    for (const [body, name, status] of [
      [new Uint8Array([0x4d, 0x5a, 0x90, 0x00]), "setup.exe", 415],
      [new Uint8Array(), "empty.txt", 400],
      [new TextEncoder().encode("   "), "blank.txt", 422],
    ] as const) {
      const h = harness();
      const [request, url] = post(body, name);
      const response = await uploadRoutes(h.dependencies).route(
        request,
        url,
        context,
      );
      expect(response?.status).toBe(status);
      expect(h.objects.size).toBe(0);
      expect(h.reserved).toEqual([]);
    }
  });

  test("refuses a file past the size bound", async () => {
    const h = harness();
    const [request, url] = post(
      new Uint8Array(20 * 1024 * 1024 + 1),
      "big.png",
    );
    const response = await uploadRoutes(h.dependencies).route(
      request,
      url,
      context,
    );
    expect(response?.status).toBe(413);
    expect(await response!.json<unknown>()).toEqual({
      error: "That file is larger than 20 MB.",
    });
  });

  test("an account out of space is told so, and nothing is written", async () => {
    const h = harness({
      reserveQuota: async () => ({
        status: "full",
        usedBytes: 5 * 1024 ** 3,
        quotaBytes: 5 * 1024 ** 3,
      }),
    });
    const [request, url] = post(JPEG, "beach.jpg");
    const response = await uploadRoutes(h.dependencies).route(
      request,
      url,
      context,
    );
    expect(response?.status).toBe(413);
    expect(((await response!.json()) as { error: string }).error).toContain(
      "5 GB",
    );
    expect(h.objects.size).toBe(0);
  });

  test("a Bot the account does not have is not found", async () => {
    const h = harness();
    const [request, url] = post(JPEG, "beach.jpg", "image/jpeg", "bot-2");
    const response = await uploadRoutes(h.dependencies).route(
      request,
      url,
      context,
    );
    expect(response?.status).toBe(404);
  });

  test("serves the bytes back as a picture, and a document only as a download", async () => {
    const h = harness();
    const routes = uploadRoutes(h.dependencies);
    await routes.route(...post(JPEG, "beach.jpg"), context);
    const uploadId = await sha256Hex(JPEG);
    const url = new URL(
      `https://bot.frockbot.test/api/bots/bot-1/uploads/${uploadId}`,
    );
    const response = await routes.route(new Request(url), url, context);
    expect(response?.status).toBe(200);
    expect(response!.headers.get("content-type")).toBe("image/jpeg");
    expect(response!.headers.get("content-disposition")).toBeNull();
    expect(new Uint8Array(await response!.arrayBuffer())).toEqual(JPEG);

    const text = new TextEncoder().encode("<script>alert(1)</script>");
    await routes.route(...post(text, "page.html", "text/html"), context);
    const textId = await sha256Hex(text);
    const textUrl = new URL(
      `https://bot.frockbot.test/api/bots/bot-1/uploads/${textId}`,
    );
    const download = await routes.route(new Request(textUrl), textUrl, context);
    expect(download!.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(download!.headers.get("content-disposition")).toBe("attachment");

    // Another account's user id names another prefix, and nothing is there.
    const other = await routes.route(new Request(url), url, {
      ...context,
      userId: "user-2",
    });
    expect(other?.status).toBe(404);
  });

  test("leaves every other path to the rest of the gateway", async () => {
    const h = harness();
    const url = new URL("https://bot.frockbot.test/api/bots/bot-1/turns");
    expect(
      await uploadRoutes(h.dependencies).route(new Request(url), url, context),
    ).toBeUndefined();
  });
});

describe("a deleted Bot's uploads", () => {
  test("every object under its prefix goes, a page at a time", async () => {
    const keys = new Set([
      "uploads/user-1/bot-1/a",
      "uploads/user-1/bot-1/a.md",
      "uploads/user-1/bot-1/b",
      "uploads/user-1/bot-10/c",
    ]);
    const removed = await deleteBotUploadsV1(
      {
        MEMORY_FILES: {
          list: async ({ prefix, cursor }) => {
            // A cursor names where the last page ended, as R2's does, so
            // deleting what was listed does not shift what comes next.
            const matching = [...keys]
              .filter((key) => key.startsWith(prefix) && key > (cursor ?? ""))
              .sort();
            const page = matching.slice(0, 2);
            return {
              objects: page.map((key) => ({ key })),
              truncated: matching.length > 2,
              ...(matching.length > 2 ? { cursor: page.at(-1)! } : {}),
            };
          },
          delete: async (deleted) => {
            for (const key of [deleted].flat()) keys.delete(key);
          },
        },
        USER_CONFIGURATIONS: {
          idFromName: () => ({}) as DurableObjectId,
          get: () => ({}),
        },
      },
      { userId: "user-1", botId: "bot-1" },
    );
    expect(removed).toBe(3);
    expect([...keys]).toEqual(["uploads/user-1/bot-10/c"]);
  });

  const releasing = (answer: () => Promise<unknown>) => ({
    USER_CONFIGURATIONS: {
      idFromName: () => ({}) as DurableObjectId,
      get: () => ({ releaseBotUploadQuota: answer }),
    },
  });

  test("an erased account has no space to give back, and the teardown still ends", async () => {
    const erased = Object.assign(new Error("This account has been deleted."), {
      name: "AccountDeletedError",
    });
    await releaseBotUploadQuotaRpcV1(
      releasing(() => Promise.reject(erased)),
      { userId: "user-1", botId: "bot-1" },
    );
  });

  test("any other failure is the teardown's to retry", async () => {
    await expect(
      releaseBotUploadQuotaRpcV1(
        releasing(() => Promise.reject(new Error("storage unavailable"))),
        { userId: "user-1", botId: "bot-1" },
      ),
    ).rejects.toThrow("storage unavailable");
  });
});
