import { describe, expect, test } from "bun:test";
import type {
  LlmMessage,
  MessageAttachmentV1,
  NormalizedModelRequest,
  WorkspaceFilesV1,
} from "@frockbot/core/contracts";
import {
  base64OfBytesV1,
  createModelAttachmentResolverV1,
  type UploadReaderV1,
} from "./resolver.js";

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

const signal = new AbortController().signal;

function request(messages: LlmMessage[]): NormalizedModelRequest {
  return {
    requestId: "request-1",
    provider: "fake",
    model: "fake",
    system: "",
    messages,
    tools: [],
  };
}

async function image(label: string): Promise<{
  bytes: Uint8Array;
  attachment: MessageAttachmentV1;
}> {
  const bytes = new TextEncoder().encode(`image:${label}`);
  return {
    bytes,
    attachment: {
      kind: "image",
      uploadId: await sha256Hex(bytes),
      name: `${label}.png`,
      mediaType: "image/png",
      bytes: bytes.byteLength,
    },
  };
}

function document(label: string): MessageAttachmentV1 {
  return {
    kind: "document",
    uploadId: label.padEnd(64, "0").slice(0, 64),
    name: `${label}.pdf`,
    mediaType: "application/pdf",
    bytes: 10,
  };
}

function reader(
  images: Map<string, Uint8Array>,
  texts: Map<string, string>,
  reads: string[] = [],
): UploadReaderV1 {
  return {
    bytes: async (uploadId) => {
      reads.push(`bytes:${uploadId}`);
      return images.get(uploadId);
    },
    excerpt: async (uploadId, maxChars) => {
      reads.push(`text:${uploadId}`);
      const text = texts.get(uploadId);
      return text === undefined
        ? undefined
        : { text: text.slice(0, maxChars), chars: text.length };
    },
  };
}

describe("resolving a request's attachments", () => {
  test("fills in bytes and text, and names how much of a document it left out", async () => {
    const photo = await image("beach");
    const report = document("aa");
    const resolver = createModelAttachmentResolverV1({
      uploads: reader(
        new Map([[photo.attachment.uploadId, photo.bytes]]),
        new Map([[report.uploadId, "x".repeat(40_000)]]),
      ),
    });
    const resolved = await resolver.resolve(
      request([
        {
          role: "user",
          content: "Look",
          attachments: [photo.attachment, report],
        },
      ]),
      signal,
    );
    const user = resolved.messages[0]!;
    if (user.role !== "user") throw new Error("expected the user message");
    expect(user.attachments![0]!.dataBase64).toBe(base64OfBytesV1(photo.bytes));
    expect(user.attachments![1]!.text).toEndWith(
      "[This is the first 30,000 of 40,000 characters.]",
    );
  });

  test("only the newest three messages with files are resolved", async () => {
    const photos = await Promise.all(
      ["one", "two", "three", "four"].map(image),
    );
    const reads: string[] = [];
    const resolver = createModelAttachmentResolverV1({
      uploads: reader(
        new Map(
          photos.map((photo) => [photo.attachment.uploadId, photo.bytes]),
        ),
        new Map(),
        reads,
      ),
    });
    const resolved = await resolver.resolve(
      request(
        photos.map((photo) => ({
          role: "user" as const,
          content: "",
          attachments: [photo.attachment],
        })),
      ),
      signal,
    );
    const shown = resolved.messages.map(
      (message) =>
        message.role === "user" &&
        message.attachments?.[0]?.dataBase64 !== undefined,
    );
    expect(shown).toEqual([false, true, true, true]);
    expect(reads).not.toContain(`bytes:${photos[0]!.attachment.uploadId}`);
  });

  test("bytes that are not the upload's hash are not shown", async () => {
    const photo = await image("beach");
    const resolver = createModelAttachmentResolverV1({
      uploads: reader(
        new Map([
          [photo.attachment.uploadId, new TextEncoder().encode("other")],
        ]),
        new Map(),
      ),
    });
    const resolved = await resolver.resolve(
      request([{ role: "user", content: "", attachments: [photo.attachment] }]),
      signal,
    );
    const user = resolved.messages[0]!;
    expect(
      user.role === "user" && user.attachments?.[0]?.dataBase64,
    ).toBeUndefined();
  });

  test("a Turn reads each file once however many steps it takes", async () => {
    const photo = await image("beach");
    const reads: string[] = [];
    const resolver = createModelAttachmentResolverV1({
      uploads: reader(
        new Map([[photo.attachment.uploadId, photo.bytes]]),
        new Map(),
        reads,
      ),
    });
    const asked = request([
      { role: "user", content: "", attachments: [photo.attachment] },
    ]);
    await resolver.resolve(asked, signal);
    await resolver.resolve(asked, signal);
    expect(reads).toHaveLength(1);
  });

  test("the document budget is spent newest first", async () => {
    const older = document("bb");
    const newer = document("cc");
    const resolver = createModelAttachmentResolverV1({
      uploads: reader(
        new Map(),
        new Map([
          [older.uploadId, "o".repeat(90_000)],
          [newer.uploadId, "n".repeat(90_000)],
        ]),
      ),
    });
    const resolved = await resolver.resolve(
      request([
        { role: "user", content: "", attachments: [older] },
        { role: "user", content: "", attachments: [newer, document("dd")] },
        { role: "user", content: "", attachments: [document("ee")] },
      ]),
      signal,
    );
    const texts = resolved.messages.flatMap((message) =>
      message.role === "user"
        ? (message.attachments ?? []).map((item) => item.text?.length ?? 0)
        : [],
    );
    // In message order: the two documents with no text spend nothing, and
    // each of the others takes a full excerpt out of the 90,000.
    expect(texts[0]!).toBeGreaterThan(30_000);
    expect(texts[0]!).toBeLessThan(60_100);
    expect(texts[1]!).toBeGreaterThan(30_000);
    expect(texts.slice(2)).toEqual([0, 0]);
  });

  test("a tool's image the Session no longer holds is read from the Workspace", async () => {
    const bytes = new TextEncoder().encode("generated");
    const contentHash = await sha256Hex(bytes);
    const workspacePath = {
      root: {
        kind: "package-declared" as const,
        userId: "user-1",
        packageId: "image",
        rootId: "generated",
      },
      path: "run-1/effect.png",
    };
    const workspace: Pick<WorkspaceFilesV1, "read"> = {
      read: async () =>
        ({
          status: "ok",
          file: { bytes, generation: { contentHash } },
        }) as never,
    };
    const resolver = createModelAttachmentResolverV1({ workspace });
    const resolved = await resolver.resolve(
      request([
        {
          role: "tool",
          callId: "call-1",
          name: "generate_image",
          content: "{}",
          isError: false,
          attachments: [
            {
              kind: "image",
              mediaType: "image/png",
              workspacePath,
              contentHash,
              bytes: bytes.byteLength,
            },
          ],
        },
      ]),
      signal,
    );
    const tool = resolved.messages[0]!;
    expect(tool.role === "tool" && tool.attachments?.[0]?.dataBase64).toBe(
      base64OfBytesV1(bytes),
    );
  });
});
