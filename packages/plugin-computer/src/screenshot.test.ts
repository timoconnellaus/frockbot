// `computer_screenshot`: parity row 25.
//
// The subject is what the tool *files*, not what `scrot` produced. Three rules
// are asserted here because they are the ones a future change could quietly
// break: the bytes go through `ComputerWorkspace.write` so the Bot is recorded
// as their writer, the root is bounded, and the model gets a reference it can
// resolve rather than a picture of a path.
import { describe, expect, test } from "bun:test";
import { SystemPromptRegistry } from "@frockbot/plugin-prompt";
import { ToolRegistry } from "@frockbot/plugin-tools";
import {
  ComputerError,
  ComputerRegistry,
  computerBotPathKeyV1,
  type ComputerHandle,
  type ComputerProvider,
} from "@frockbot/computer-core";
import { createPluginHarness } from "@frockbot/plugin-testkit";
import { SessionStore } from "@frockbot/kernel-contracts";
import { createComputerAgentPlugin, pngDimensionsV1 } from "./agent.js";
import { FakeWorkspace } from "./workspace-fixture.js";

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
): ComputerProvider {
  return {
    id: "fixture",
    open: (identity, tenant, assignment): Promise<ComputerHandle> =>
      Promise.resolve({
        assignment,
        identity,
        tenant,
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
  provider: ComputerProvider,
  writer = true,
  projectionFiles?: {
    invalidate(botId: string, kind: "screenshots" | "doctor"): void;
  },
) {
  const harness = await createPluginHarness([
    ComputerRegistry,
    ToolRegistry,
    SystemPromptRegistry,
    SessionStore,
  ]);
  harness.root.computers.register(provider);
  await harness.mount(
    createComputerAgentPlugin({
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
    }),
  );
  return harness;
}

async function executeTool(
  harness: Awaited<ReturnType<typeof createPluginHarness>>,
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
  const prepared = await harness.root.tools.prepare(
    { id: crypto.randomUUID(), name, input },
    context,
  );
  if (prepared.kind !== "ready") throw new Error(prepared.result.content);
  return harness.root.tools.executePrepared(prepared, context);
}

function capture(harness: Awaited<ReturnType<typeof createPluginHarness>>) {
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

  test("prunes to the newest twenty captures for one Bot", async () => {
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

    for (let index = 0; index < 23; index += 1) await capture(harness);

    expect(workspace.files.size).toBe(20);
    expect(workspace.deleted).toEqual([
      `${computerBotPathKeyV1("bot-1")}/run-9-1.png`,
      `${computerBotPathKeyV1("bot-1")}/run-9-2.png`,
      `${computerBotPathKeyV1("bot-1")}/run-9-3.png`,
    ]);
    await harness.dispose();
  });

  test("reports a Computer with no screenshot capability as a failure", async () => {
    const workspace = new FakeWorkspace();
    const harness = await mount({
      id: "fixture",
      open: (identity, tenant, assignment) =>
        Promise.resolve({
          assignment,
          identity,
          tenant,
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
      harness.root.tools
        .schemas({ turnType: "chat" })
        .map((schema) => schema.name),
    ).not.toContain("computer_screenshot");
    await harness.dispose();
  });

  test("captures a final frame after a Turn that used the Computer", async () => {
    const workspace = new FakeWorkspace();
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
    );
    const session = harness.root.sessions.create("session-1");
    const agent = { botId: "bot-1", session };
    await harness.root.waterfall(
      "agent/pre-step",
      agent as never,
      [],
      1,
      1,
      () => Promise.resolve({ kind: "enter" as const, inputs: [] }),
    );
    await executeTool(harness, "computer_exec", { command: "pwd" });

    await harness.root.serial("agent/turn-stopping", agent as never, 1);

    expect(workspace.writes).toHaveLength(1);
    expect(workspace.writes[0]?.writer).toEqual({
      kind: "bot",
      botId: "bot-1",
      sessionId: "session-1",
      turnId: "run-9",
      runId: "run-9",
    });
    expect(invalidations).toEqual(["bot-1:screenshots"]);
    await harness.dispose();
  });

  test("a final-frame capture is refused while the User holds control", async () => {
    const workspace = new FakeWorkspace();
    let captures = 0;
    const harness = await mount(
      providerWith(workspace, () => {
        captures += 1;
        return Promise.reject(
          new ComputerError("human-control-active", "held by User"),
        );
      }),
    );
    const session = harness.root.sessions.create("session-1");
    const agent = { botId: "bot-1", session };
    await harness.root.waterfall(
      "agent/pre-step",
      agent as never,
      [],
      1,
      1,
      () => Promise.resolve({ kind: "enter" as const, inputs: [] }),
    );
    await executeTool(harness, "computer_exec", { command: "pwd" });

    await expect(
      harness.root.serial("agent/turn-stopping", agent as never, 1),
    ).resolves.toBeUndefined();
    expect(captures).toBe(1);
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
