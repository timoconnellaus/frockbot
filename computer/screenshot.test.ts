import { frockbotToolCall, discoverFrockbotTools } from "@frockbot/app/testkit";
// `computer_screenshot`: parity row 25.
//
// The subject is what the tool *files*, not what `scrot` produced. Three rules
// are asserted here because they are the ones a future change could quietly
// break: the bytes go through `ComputerWorkspace.write` so the Bot is recorded
// as their writer, the root is bounded, and the model gets a reference it can
// resolve rather than a picture of a path.
import { describe, expect, test } from "bun:test";
import { ComputerError, computerBotPathKeyV1 } from "@frockbot/computer/core";
import {
  type ComputerHostCapabilitiesV1,
  type ComputerHostSessionV1,
  type ComputerHostV1,
} from "@frockbot/computer/core/host";
import {
  type AgentRuntimeHarness,
  createAgentRuntimeHarness,
} from "@frockbot/app/testkit";
import { createComputerAgentFeature, pngDimensionsV1 } from "./agent.js";
import { FakeWorkspace } from "@frockbot/computer/fake";
import {
  COMPUTER_FRAME_RECORD_KEY,
  computerFrameSinkV1,
  decodeStoredComputerFrameV1,
} from "./frame.js";

/** The Bot Durable Object storage the card's frame is kept in. */
class FrameStorage {
  readonly values = new Map<string, unknown>();
  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.values.get(key) as T | undefined);
  }
  put(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
  frame() {
    const value = this.values.get(COMPUTER_FRAME_RECORD_KEY);
    return value === undefined ? undefined : decodeStoredComputerFrameV1(value);
  }
}

/** A host that offers nothing beyond the operations under test. */
const TEST_HOST_CAPABILITIES: ComputerHostCapabilitiesV1 = {
  viewerFrameOrigins: [],
};

/** A 4x3 PNG: a real signature and a real IHDR, and nothing after it. */
function png(width = 4, height = 3): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function providerWith(
  workspace: FakeWorkspace,
  capture: () => Promise<{
    bytes: Uint8Array;
    mediaType: "image/png";
    display: string;
    capturedAt: string;
  }>,
): ComputerHostV1 {
  return {
    id: "fixture",
    capabilities: TEST_HOST_CAPABILITIES,
    open: (identity, tenant, assignment): Promise<ComputerHostSessionV1> =>
      Promise.resolve({
        assignment,
        identity,
        tenant,
        capabilities: TEST_HOST_CAPABILITIES,
        workspace,
        screenshot: { capture: () => capture() },
        exec: {
          execute: () =>
            Promise.resolve({
              exitCode: 0,
              stdout: new TextEncoder().encode("done"),
              stderr: new Uint8Array(),
              outputTruncated: false,
            }),
        },
        close: () => Promise.resolve(),
      }),
  };
}

async function mount(
  provider: ComputerHostV1,
  writer = true,
  projectionFiles?: {
    invalidate(botId: string, kind: "frame" | "doctor"): void;
  },
  frames?: FrameStorage,
) {
  const harness = createAgentRuntimeHarness();
  harness.computers.register(provider);
  await harness.mount(
    createComputerAgentFeature({
      userId: "user-1",
      defaultProviderId: "fixture",
      ...(writer
        ? {
            writer: {
              sessionId: "session-1",
              turnId: "run-9",
              runId: "run-9",
            },
          }
        : {}),
      ...(projectionFiles ? { projectionFiles } : {}),
      ...(frames ? { frames: computerFrameSinkV1(frames) } : {}),
    }),
  );
  return harness;
}

async function beginTurn(harness: AgentRuntimeHarness) {
  const session = harness.sessions.create("session-1");
  const agent = { botId: "bot-1", session };
  await harness.hooks.preStep(agent as never, [], 1, 1, () =>
    Promise.resolve({ kind: "enter" as const, inputs: [] }),
  );
  return agent;
}

async function executeTool(
  harness: AgentRuntimeHarness,
  name: string,
  input: unknown,
) {
  const context = {
    botId: "bot-1",
    agentId: "run-9",
    compositionGenerationId: "bootstrap",
    turnType: "chat" as const,
    sessionId: "session-1",
    effectId: "tool:1:1:0",
    signal: new AbortController().signal,
  };
  const prepared = await harness.tools.prepare(
    frockbotToolCall(name, input, crypto.randomUUID()),
    context,
  );
  if (prepared.kind !== "ready") throw new Error(prepared.result.content);
  return harness.tools.executePrepared(prepared, context);
}

function capture(harness: AgentRuntimeHarness) {
  return executeTool(harness, "computer_screenshot", {});
}

describe("computer_screenshot", () => {
  test("files the capture through the Workspace with the Bot as its writer", async () => {
    const workspace = new FakeWorkspace();
    const harness = await mount(
      providerWith(workspace, () =>
        Promise.resolve({
          bytes: png(1280, 720),
          mediaType: "image/png" as const,
          display: ":100",
          capturedAt: "2026-08-31T00:00:00.000Z",
        }),
      ),
    );

    const result = await capture(harness);

    expect(result.isError).toBe(false);
    const answer = JSON.parse(result.content) as Record<string, unknown>;
    const botKey = computerBotPathKeyV1("bot-1");
    expect(answer).toMatchObject({
      path: `${botKey}/run-9-1.png`,
      rootId: "screenshots",
      width: 1280,
      height: 720,
      display: ":100",
      capturedAt: "2026-08-31T00:00:00.000Z",
    });
    // The writer is the point: a file a shell left on the Computer would sync
    // back `unattributed`, so the tool reads the bytes and writes them here.
    const written = workspace.files.get(`${botKey}/run-9-1.png`);
    expect(written?.generation.writer).toEqual({
      kind: "bot",
      botId: "bot-1",
      sessionId: "session-1",
      turnId: "run-9",
      runId: "run-9",
    });
    expect(result.attachments).toEqual([
      {
        kind: "image",
        mediaType: "image/png",
        workspacePath: {
          root: {
            kind: "package-declared",
            userId: "user-1",
            packageId: "computer",
            rootId: "screenshots",
          },
          path: `${botKey}/run-9-1.png`,
        },
        contentHash: written!.generation.contentHash,
        bytes: written!.generation.size,
      },
    ]);
    await harness.dispose();
  });

  test("keeps the newest twenty captures, pruned at the Turn end and never during a call", async () => {
    const workspace = new FakeWorkspace();
    const harness = await mount(
      providerWith(workspace, () =>
        Promise.resolve({
          bytes: png(),
          mediaType: "image/png" as const,
          display: ":100",
          capturedAt: "2026-08-31T00:00:00.000Z",
        }),
      ),
    );
    const agent = await beginTurn(harness);

    for (let index = 0; index < 23; index += 1) await capture(harness);
    // A capture is the Bot's; retention is not its call's cost.
    expect(workspace.files.size).toBe(23);
    expect(workspace.deleted).toEqual([]);

    await harness.hooks.turnStopping(agent as never, 1);

    expect(workspace.files.size).toBe(20);
    expect(workspace.deleted).toEqual([
      `${computerBotPathKeyV1("bot-1")}/run-9-1.png`,
      `${computerBotPathKeyV1("bot-1")}/run-9-2.png`,
      `${computerBotPathKeyV1("bot-1")}/run-9-3.png`,
    ]);
    await harness.dispose();
  });

  test("a capture is also the card's frame", async () => {
    const workspace = new FakeWorkspace();
    const frames = new FrameStorage();
    const invalidations: string[] = [];
    const harness = await mount(
      providerWith(workspace, () =>
        Promise.resolve({
          bytes: png(1280, 720),
          mediaType: "image/png" as const,
          display: ":100",
          capturedAt: "2026-09-03T00:00:10.000Z",
        }),
      ),
      true,
      {
        invalidate: (botId, kind) => invalidations.push(`${botId}:${kind}`),
      },
      frames,
    );

    const result = await capture(harness);

    expect(result).toMatchObject({ isError: false });
    expect(workspace.writes).toHaveLength(1);
    expect(frames.frame()).toMatchObject({
      bytes: png(1280, 720),
      capturedAt: "2026-09-03T00:00:10.000Z",
    });
    // Announced as soon as it is kept, so an open card reads it now.
    expect(invalidations).toEqual(["bot-1:frame"]);
    await harness.dispose();
  });

  test("reports a Computer with no screenshot capability as a failure", async () => {
    const workspace = new FakeWorkspace();
    const harness = await mount({
      id: "fixture",
      capabilities: TEST_HOST_CAPABILITIES,
      open: (identity, tenant, assignment) =>
        Promise.resolve({
          assignment,
          identity,
          tenant,
          capabilities: TEST_HOST_CAPABILITIES,
          workspace,
          close: () => Promise.resolve(),
        }),
    });

    const result = await capture(harness);

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("does not support screenshots");
    await harness.dispose();
  });

  test("carries a refused capture back as the tool's failure", async () => {
    const workspace = new FakeWorkspace();
    const harness = await mount(
      providerWith(workspace, () =>
        Promise.reject(
          new Error("The user is controlling this agent's computer"),
        ),
      ),
    );

    const result = await capture(harness);

    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("controlling this agent's computer");
    expect(workspace.files.size).toBe(0);
    await harness.dispose();
  });

  test("is not offered outside a Turn that can name its writer", async () => {
    const workspace = new FakeWorkspace();
    const harness = await mount(
      providerWith(workspace, () =>
        Promise.resolve({
          bytes: png(),
          mediaType: "image/png" as const,
          display: ":100",
          capturedAt: "2026-08-31T00:00:00.000Z",
        }),
      ),
      false,
    );

    expect(
      (await discoverFrockbotTools(harness.tools, { turnType: "chat" })).map(
        (schema) => schema.name,
      ),
    ).not.toContain("computer_screenshot");
    await harness.dispose();
  });

  test("keeps the desktop the Turn left as the card's frame, and files nothing", async () => {
    const workspace = new FakeWorkspace();
    const frames = new FrameStorage();
    const invalidations: string[] = [];
    const harness = await mount(
      providerWith(workspace, () =>
        Promise.resolve({
          bytes: png(1280, 720),
          mediaType: "image/png" as const,
          display: ":100",
          capturedAt: "2026-09-03T00:00:10.000Z",
        }),
      ),
      true,
      {
        invalidate: (botId, kind) => invalidations.push(`${botId}:${kind}`),
      },
      frames,
    );
    const agent = await beginTurn(harness);
    await executeTool(harness, "computer_exec", { command: "pwd" });

    await harness.hooks.turnStopping(agent as never, 1);

    expect(workspace.writes).toHaveLength(0);
    expect(workspace.lists).toHaveLength(0);
    expect(frames.frame()).toMatchObject({
      bytes: png(1280, 720),
      mediaType: "image/png",
      capturedAt: "2026-09-03T00:00:10.000Z",
    });
    expect(invalidations).toEqual(["bot-1:frame"]);
    await harness.dispose();
  });

  test("a Turn's Computer actions photograph nothing until the Turn ends", async () => {
    const workspace = new FakeWorkspace();
    const frames = new FrameStorage();
    let captures = 0;
    const harness = await mount(
      providerWith(workspace, () => {
        captures += 1;
        return Promise.resolve({
          bytes: png(1280, 720),
          mediaType: "image/png" as const,
          display: ":100",
          capturedAt: "2026-09-03T00:00:10.000Z",
        });
      }),
      true,
      undefined,
      frames,
    );
    const agent = await beginTurn(harness);
    for (let call = 0; call < 5; call += 1) {
      await executeTool(harness, "computer_exec", { command: "pwd" });
    }
    expect(captures).toBe(0);

    await harness.hooks.turnStopping(agent as never, 1);

    expect(captures).toBe(1);
    expect(workspace.writes).toHaveLength(0);
    await harness.dispose();
  });

  test("a final-frame capture is refused while the User holds control", async () => {
    const workspace = new FakeWorkspace();
    const frames = new FrameStorage();
    let captures = 0;
    const harness = await mount(
      providerWith(workspace, () => {
        captures += 1;
        return Promise.reject(
          new ComputerError("human-control-active", "held by User"),
        );
      }),
      true,
      undefined,
      frames,
    );
    const agent = await beginTurn(harness);
    await executeTool(harness, "computer_exec", { command: "pwd" });

    await expect(
      harness.hooks.turnStopping(agent as never, 1),
    ).resolves.toBeUndefined();
    // The refusal reaches neither the Bot's answer nor the Turn's outcome,
    // and the card keeps whatever frame it had.
    expect(captures).toBe(1);
    expect(frames.frame()).toBeUndefined();
    expect(workspace.writes).toHaveLength(0);
    await harness.dispose();
  });
});

describe("pngDimensionsV1", () => {
  test("reads the IHDR of a PNG and refuses anything else", () => {
    expect(pngDimensionsV1(png(1280, 720))).toEqual({
      width: 1280,
      height: 720,
    });
    expect(pngDimensionsV1(new Uint8Array(8))).toBeUndefined();
    expect(pngDimensionsV1(png(0, 0))).toBeUndefined();
  });
});
