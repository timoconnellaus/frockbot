import { describe, expect, test } from "bun:test";
import { SessionStore, type Session } from "@frockbot/kernel-contracts";
import { Context } from "cordis";
import {
  createGenerateImageTool,
  decodeGenerateImageInputV1,
  type GenerateImageResultV1,
  IMAGE_RESULT_ROOT_V1,
  type ImageRuntimeHostV1,
} from "./agent.ts";
import { DEFAULT_IMAGE_MODEL_V1 } from "./model.ts";
import { generatedImagePathV1 } from "./root.ts";
import {
  FakeImageModel,
  FakeImageWorkspace,
  fakePngBytesV1,
} from "./testing.ts";

const OWNER = { userId: "user-1", botId: "bot-1" };
const WRITER = { sessionId: "user-1:bot-1", turnId: "turn-4", runId: "run-9" };
const EFFECT_ID = "tool:4:2:0";

const CONTEXT = {
  botId: "bot-1",
  agentId: "bot-1",
  sessionId: "user-1:bot-1",
  compositionGenerationId: "2026-08-31T00:00:00.000Z:0123456789abcdef",
  turnType: "chat" as const,
  effectId: EFFECT_ID,
  signal: new AbortController().signal,
};

async function openSession(): Promise<{
  session: Session;
  sessions: { get(id: string): Session | undefined };
  dispose(): Promise<void>;
}> {
  const root = new Context();
  await root.plugin(SessionStore);
  const session = root.sessions.create("user-1:bot-1");
  session.appendBatch([
    { type: "turn/start", turn: 4 },
    { type: "step/start", turn: 4, step: 2 },
  ]);
  return {
    session,
    sessions: root.sessions,
    dispose: () => root.fiber.dispose(),
  };
}

function host(overrides: Partial<ImageRuntimeHostV1> = {}): ImageRuntimeHostV1 {
  return { owner: OWNER, writer: WRITER, ...overrides };
}

describe("generate_image input", () => {
  test("accepts a bounded prompt and defaults the size", () => {
    expect(decodeGenerateImageInputV1({ prompt: "a red barn" })).toEqual({
      prompt: "a red barn",
      width: 1024,
      height: 1024,
    });
  });

  test("refuses an empty, oversized, control-laden or unknown input", () => {
    for (const input of [
      undefined,
      "a red barn",
      { prompt: "" },
      { prompt: "   " },
      { prompt: "x".repeat(2_001) },
      { prompt: "a\u0007b" },
      { prompt: "a red barn", width: 640 },
      { prompt: "a red barn", height: 0 },
      { prompt: "a red barn", n: 2 },
      { prompt: "a red barn", seed: 1 },
    ]) {
      expect(() => decodeGenerateImageInputV1(input)).toThrow();
    }
  });

  test("accepts both declared sizes", () => {
    expect(
      decodeGenerateImageInputV1({ prompt: "a", width: 512, height: 512 }),
    ).toMatchObject({ width: 512, height: 512 });
  });
});

describe("generate_image", () => {
  test("records intent before the model runs, and the generation after", async () => {
    const { session, sessions, dispose } = await openSession();
    const model = new FakeImageModel(fakePngBytesV1(1024, 1024));
    const files = new FakeImageWorkspace();
    // The order is what is asserted, so the model records where in the log it
    // was called: an intent appended after the call would prove nothing.
    const ordered: string[] = [];
    const observed = {
      run: (
        id: string,
        input: { prompt: string; width: number; height: number },
      ) => {
        ordered.push(
          `run:${session.events.filter((event) => event.type === "image/generate-intent").length}`,
        );
        return model.run(id, input);
      },
    };
    const tool = createGenerateImageTool(
      host({ model: observed, files }),
      sessions,
    );

    const result = await tool.execute({ prompt: "a red barn" }, CONTEXT);
    expect(result.isError).toBe(false);

    // The model ran with exactly one intent already in the log.
    expect(ordered).toEqual(["run:1"]);
    const types = session.events.map((event) => event.type);
    expect(types.indexOf("image/generate-intent")).toBeLessThan(
      types.indexOf("image/generated"),
    );

    const intent = session.events.find(
      (event) => event.type === "image/generate-intent",
    );
    expect(intent).toMatchObject({
      turn: 4,
      step: 2,
      effectId: EFFECT_ID,
      model: DEFAULT_IMAGE_MODEL_V1,
      width: 1024,
      height: 1024,
    });
    // The prompt reaches the log through `tool/call`; the intent carries only
    // its hash, so the fence never becomes a second copy of the input.
    expect(JSON.stringify(intent)).not.toContain("a red barn");

    const parsed = JSON.parse(result.content) as GenerateImageResultV1;
    expect(parsed).toMatchObject({
      root: IMAGE_RESULT_ROOT_V1,
      mimeType: "image/png",
      width: 1024,
      height: 1024,
    });
    expect(parsed.path).toBe(
      generatedImagePathV1(OWNER, EFFECT_ID, "png").path,
    );
    expect(parsed.generationId).toBe("gen-0001");
    // Never the bytes: a base64 image would be replayed into every later
    // model request of the Turn.
    expect(result.content).not.toContain("iVBOR");
    expect(result.content.length).toBeLessThan(400);

    expect(
      session.events.find((event) => event.type === "image/generated"),
    ).toMatchObject({
      effectId: EFFECT_ID,
      path: parsed.path,
      generationId: parsed.generationId,
      contentHash: parsed.contentHash,
    });
    await dispose();
  });

  test("records the dimensions of the bytes it stored, not the ones it asked for", async () => {
    const { sessions, dispose } = await openSession();
    // `flux-1-schnell` accepts no size at all, so a model that ignores the
    // request is the ordinary case, not the exception.
    const model = new FakeImageModel(fakePngBytesV1(1024, 1024));
    const tool = createGenerateImageTool(
      host({ model, files: new FakeImageWorkspace() }),
      sessions,
    );

    const result = await tool.execute(
      { prompt: "a red barn", width: 512, height: 512 },
      CONTEXT,
    );

    expect(model.calls[0]?.input).toEqual({
      prompt: "a red barn",
      width: 512,
      height: 512,
    });
    expect(JSON.parse(result.content)).toMatchObject({
      width: 1024,
      height: 1024,
    });
    await dispose();
  });

  test("attributes the write to the Bot, its Session and its Turn", async () => {
    const { sessions, dispose } = await openSession();
    const files = new FakeImageWorkspace();
    const tool = createGenerateImageTool(
      host({ model: new FakeImageModel(), files }),
      sessions,
    );

    await tool.execute({ prompt: "a red barn" }, CONTEXT);

    const stored = await files.read(
      generatedImagePathV1(OWNER, EFFECT_ID, "png"),
    );
    expect(stored.status).toBe("ok");
    expect(
      stored.status === "ok" ? stored.file.generation.writer : undefined,
    ).toEqual({
      kind: "bot",
      botId: "bot-1",
      sessionId: "user-1:bot-1",
      turnId: "turn-4",
      runId: "run-9",
    });
    await dispose();
  });

  test("refuses visibly when the host has no image model binding", async () => {
    const { session, sessions, dispose } = await openSession();
    const tool = createGenerateImageTool(
      host({ files: new FakeImageWorkspace() }),
      sessions,
    );

    const result = await tool.execute({ prompt: "a red barn" }, CONTEXT);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("no image model binding");
    // Nothing was promised: an intent for an effect that can never run would
    // leave a fence around nothing.
    expect(
      session.events.some((event) => event.type === "image/generate-intent"),
    ).toBe(false);
    await dispose();
  });

  test("refuses visibly when the Workspace is unavailable", async () => {
    const { sessions, dispose } = await openSession();
    const model = new FakeImageModel();
    const tool = createGenerateImageTool(host({ model }), sessions);

    const result = await tool.execute({ prompt: "a red barn" }, CONTEXT);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Workspace file surface is unavailable");
    expect(model.calls).toHaveLength(0);
    await dispose();
  });

  test("refuses bytes that are not an image it can identify", async () => {
    const { sessions, dispose } = await openSession();
    const files = new FakeImageWorkspace();
    const model = new FakeImageModel(new TextEncoder().encode("not an image"));
    const tool = createGenerateImageTool(host({ model, files }), sessions);

    const result = await tool.execute({ prompt: "a red barn" }, CONTEXT);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("neither a PNG nor a JPEG");
    // Unidentifiable bytes never reach a durable root.
    expect(files.calls.some((call) => call.startsWith("write:"))).toBe(false);
    await dispose();
  });

  test("refuses an image larger than a Workspace file may be", async () => {
    const { sessions, dispose } = await openSession();
    const oversized = new Uint8Array(1_048_577);
    oversized.set(fakePngBytesV1(1024, 1024), 0);
    const tool = createGenerateImageTool(
      host({
        model: new FakeImageModel(oversized),
        files: new FakeImageWorkspace(),
      }),
      sessions,
    );

    const result = await tool.execute({ prompt: "a red barn" }, CONTEXT);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("may not exceed");
    await dispose();
  });

  test("carries a model failure into durable state instead of throwing", async () => {
    const { session, sessions, dispose } = await openSession();
    const model = new FakeImageModel();
    model.failure = "NSFW filter tripped";
    const tool = createGenerateImageTool(
      host({ model, files: new FakeImageWorkspace() }),
      sessions,
    );

    const result = await tool.execute({ prompt: "a red barn" }, CONTEXT);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("NSFW filter tripped");
    // The intent stands: the effect was attempted, and reconciliation can now
    // prove it produced nothing.
    expect(
      session.events.some((event) => event.type === "image/generate-intent"),
    ).toBe(true);
    expect(
      session.events.some((event) => event.type === "image/generated"),
    ).toBe(false);
    await dispose();
  });

  test("refuses a model the Package does not offer", async () => {
    const { sessions, dispose } = await openSession();
    const model = new FakeImageModel();
    const tool = createGenerateImageTool(
      host({ model, files: new FakeImageWorkspace(), modelId: "@cf/llama" }),
      sessions,
    );

    const result = await tool.execute({ prompt: "a red barn" }, CONTEXT);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not one this Package offers");
    expect(model.calls).toHaveLength(0);
    await dispose();
  });
});

describe("reconciling a generated image", () => {
  test("is never retried by the registry: the effect is not idempotent", async () => {
    const { sessions, dispose } = await openSession();
    const tool = createGenerateImageTool(
      host({ model: new FakeImageModel(), files: new FakeImageWorkspace() }),
      sessions,
    );
    expect(tool.idempotent).toBe(false);
    expect(tool.reconcile).toBeDefined();
    await dispose();
  });

  test("returns the stored image after eviction without a second run()", async () => {
    const files = new FakeImageWorkspace();
    const model = new FakeImageModel();

    // The Turn that generated the image.
    const first = await openSession();
    const before = createGenerateImageTool(
      host({ model, files }),
      first.sessions,
    );
    const original = await before.execute({ prompt: "a red barn" }, CONTEXT);
    expect(original.isError).toBe(false);
    await first.dispose();

    // Eviction: a fresh Package instance over the same durable Workspace, and
    // a session that replays only the intent — the outcome was never recorded.
    const second = await openSession();
    second.session.append({
      type: "image/generate-intent",
      turn: 4,
      step: 2,
      effectId: EFFECT_ID,
      model: DEFAULT_IMAGE_MODEL_V1,
      promptHash: "0".repeat(64),
      width: 1024,
      height: 1024,
    });
    const after = createGenerateImageTool(
      host({ model, files }),
      second.sessions,
    );

    const reconciliation = await after.reconcile!(
      { prompt: "a red barn" },
      CONTEXT,
    );

    expect(reconciliation.status).toBe("recovered");
    expect(
      reconciliation.status === "recovered"
        ? JSON.parse(reconciliation.result.content)
        : undefined,
    ).toEqual(JSON.parse(original.content));
    // The whole point: recovery read the Workspace and never billed again.
    expect(model.calls).toHaveLength(1);
    // And the outcome the interrupted attempt never recorded is recorded now.
    expect(
      second.session.events.find((event) => event.type === "image/generated"),
    ).toMatchObject({ effectId: EFFECT_ID, turn: 4, step: 2 });
    await second.dispose();
  });

  test("is unavailable, not a silent retry, when nothing was stored", async () => {
    const { sessions, dispose } = await openSession();
    const model = new FakeImageModel();
    const tool = createGenerateImageTool(
      host({ model, files: new FakeImageWorkspace() }),
      sessions,
    );

    const reconciliation = await tool.reconcile!(
      { prompt: "a red barn" },
      CONTEXT,
    );

    expect(reconciliation).toMatchObject({ status: "unavailable" });
    expect(model.calls).toHaveLength(0);
    await dispose();
  });

  test("records the outcome only once across a reconciled replay", async () => {
    const files = new FakeImageWorkspace();
    const model = new FakeImageModel();
    const { session, sessions, dispose } = await openSession();
    const tool = createGenerateImageTool(host({ model, files }), sessions);

    await tool.execute({ prompt: "a red barn" }, CONTEXT);
    await tool.reconcile!({ prompt: "a red barn" }, CONTEXT);

    expect(
      session.events.filter((event) => event.type === "image/generated"),
    ).toHaveLength(1);
    expect(model.calls).toHaveLength(1);
    await dispose();
  });
});
