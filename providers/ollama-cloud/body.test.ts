import { describe, expect, test } from "bun:test";
import { boundedResponseBytesV1 } from "./body.ts";

describe("Ollama bounded response bytes", () => {
  test("bounds streamed bytes before callers parse them", async () => {
    await expect(
      boundedResponseBytesV1(new Response("abcdef"), 3, {
        oversizedMessage: "too large",
      }),
    ).rejects.toThrow("too large");
  });

  test("truncates diagnostic text and always swallows cancellation", async () => {
    const response = new Response("abcdef");
    await expect(
      boundedResponseBytesV1(response, 3, {
        truncate: true,
        cancelAfterRead: true,
      }),
    ).resolves.toEqual(new TextEncoder().encode("abc"));
  });

  test("does not consume a body after a declared oversized length", async () => {
    const response = new Response("abc", {
      headers: { "content-length": "99" },
    });
    await expect(
      boundedResponseBytesV1(response, 3, {
        oversizedMessage: "declared too large",
      }),
    ).rejects.toThrow("declared too large");
  });

  test("keeps provider-specific cancellation failure behavior", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode("abcdef"));
        },
        cancel() {
          return Promise.reject(new Error("cancel failed"));
        },
      }),
    );
    await expect(
      boundedResponseBytesV1(response, 3, {
        oversizedMessage: "too large",
        cancelOnLimit: "propagate",
      }),
    ).rejects.toThrow("cancel failed");

    const ignored = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode("abcdef"));
        },
        cancel() {
          return Promise.reject(new Error("cancel failed"));
        },
      }),
    );
    await expect(
      boundedResponseBytesV1(ignored, 3, {
        oversizedMessage: "too large",
        cancelOnLimit: "ignore",
      }),
    ).rejects.toThrow("too large");
  });
});
