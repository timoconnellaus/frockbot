import { describe, expect, test } from "bun:test";
import {
  FakeImageWorkspace,
  fakePngBytesV1,
} from "@frockbot/plugin-image/testing";
import {
  createBotImageHost,
  createWorkersAiImageModelV1,
  decodeWorkersAiImageV1,
} from "./backend-image.ts";

const IDENTITY = { userId: "user-1", botId: "bot-1" };
const TURN = { runId: "run-9", turnId: "turn-4", sessionId: "user-1:bot-1" };

function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

describe("the Bot image seam", () => {
  test("mounts nothing when the Workspace file surface is unbound", () => {
    expect(createBotImageHost(IDENTITY, TURN, { AI: { run: () => {} } })).toBe(
      undefined,
    );
  });

  test("mounts with no model when Workers AI is unbound, so the refusal is visible", () => {
    const workspace = new FakeImageWorkspace();
    const host = createBotImageHost(IDENTITY, TURN, {
      WORKSPACE_FILES: workspace,
    });
    expect(host).toBeDefined();
    expect(host?.model).toBeUndefined();
    expect(host?.files).toBe(workspace);
    // The seam reaches the Workspace and nothing else: no Computer is opened
    // to build it, so a hibernated Computer changes none of this.
    expect(workspace.calls).toEqual([]);
  });

  test("binds the Bot's provenance and the adapted model when both are present", () => {
    const workspace = new FakeImageWorkspace();
    const host = createBotImageHost(IDENTITY, TURN, {
      WORKSPACE_FILES: workspace,
      AI: { run: () => Promise.resolve({ image: "" }) },
    });
    expect(host?.owner).toEqual(IDENTITY);
    expect(host?.writer).toEqual({
      sessionId: "user-1:bot-1",
      turnId: "turn-4",
      runId: "run-9",
    });
    expect(host?.model).toBeDefined();
  });
});

describe("normalizing what Workers AI answered", () => {
  const png = fakePngBytesV1(64, 32);

  test("accepts the base64 envelope the FLUX models answer", async () => {
    const buffer = await decodeWorkersAiImageV1({ image: base64(png) });
    expect([...new Uint8Array(buffer)]).toEqual([...png]);
  });

  test("accepts the binary stream the Stable Diffusion models answer", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(png.slice(0, 8));
        controller.enqueue(png.slice(8));
        controller.close();
      },
    });
    expect([...new Uint8Array(await decodeWorkersAiImageV1(stream))]).toEqual([
      ...png,
    ]);
  });

  test("accepts a raw buffer or view", async () => {
    expect([
      ...new Uint8Array(await decodeWorkersAiImageV1(png.slice().buffer)),
    ]).toEqual([...png]);
    expect([...new Uint8Array(await decodeWorkersAiImageV1(png))]).toEqual([
      ...png,
    ]);
  });

  test("refuses anything else rather than storing it", async () => {
    for (const answer of [undefined, null, 7, "hello", { image: 3 }, {}]) {
      await expect(decodeWorkersAiImageV1(answer)).rejects.toThrow(
        "not an image",
      );
    }
  });

  test("passes the requested size through to the binding", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const model = createWorkersAiImageModelV1({
      run: (name, input) => {
        calls.push([name, input]);
        return Promise.resolve({ image: base64(png) });
      },
    });

    await model.run("@cf/black-forest-labs/flux-1-schnell", {
      prompt: "a red barn",
      width: 512,
      height: 512,
    });

    expect(calls).toEqual([
      [
        "@cf/black-forest-labs/flux-1-schnell",
        { prompt: "a red barn", width: 512, height: 512 },
      ],
    ]);
  });
});
