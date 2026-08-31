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
  ComputerRegistry,
  computerBotPathKeyV1,
  type ComputerHandle,
  type ComputerProvider,
  type ComputerWorkspace,
  type WorkspaceLayoutV1,
} from "@frockbot/computer-core";
import { createPluginHarness } from "@frockbot/plugin-testkit";
import {
  SessionStore,
  type WorkspaceEntryV1,
  type WorkspaceGenerationV1,
  type WorkspacePathV1,
  type WorkspaceRootV1,
  type WorkspaceWriterV1,
} from "@frockbot/kernel-contracts";
import { createComputerAgentPlugin, pngDimensionsV1 } from "./agent.js";

const LAYOUT: WorkspaceLayoutV1 = {
  schemaVersion: 1,
  home: "/home/box",
  roots: [
    {
      kind: "package-declared",
      scope: "user",
      mountPath: "/home/box/agent-data/user-packages/{package}/{root}",
      access: "read-write",
    },
  ],
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

/** An in-memory `ComputerWorkspace` that records every write it admitted. */
class FakeWorkspace implements ComputerWorkspace {
  readonly layout = LAYOUT;
  readonly files = new Map<
    string,
    { bytes: Uint8Array; generation: WorkspaceGenerationV1 }
  >();
  readonly deleted: string[] = [];
  private sequence = 0;

  private key(path: WorkspacePathV1): string {
    return path.path;
  }

  read(path: WorkspacePathV1) {
    const held = this.files.get(this.key(path));
    return Promise.resolve(
      held
        ? {
            status: "ok" as const,
            file: { path, generation: held.generation, bytes: held.bytes },
          }
        : { status: "not-found" as const, reason: "no such file" },
    );
  }

  stat(path: WorkspacePathV1) {
    const held = this.files.get(this.key(path));
    return Promise.resolve(
      held
        ? {
            status: "ok" as const,
            entry: { path, generation: held.generation },
          }
        : { status: "not-found" as const, reason: "no such file" },
    );
  }

  list(request: { root: WorkspaceRootV1; prefix?: string }) {
    const entries: WorkspaceEntryV1[] = [...this.files.entries()]
      .filter(([path]) => !request.prefix || path.startsWith(request.prefix))
      .map(([path, held]) => ({
        path: { root: request.root, path },
        generation: held.generation,
      }));
    return Promise.resolve({ status: "ok" as const, entries });
  }

  write(request: {
    path: WorkspacePathV1;
    bytes: Uint8Array;
    writer: WorkspaceWriterV1;
  }) {
    this.sequence += 1;
    const generation: WorkspaceGenerationV1 = {
      schemaVersion: 1,
      generationId: `gen-${this.sequence}`,
      // A stand-in digest with the shape the decoders require.
      contentHash: this.sequence.toString(16).padStart(64, "a"),
      size: request.bytes.byteLength,
      writer: request.writer,
      writtenAt: new Date(1_700_000_000_000 + this.sequence).toISOString(),
    };
    this.files.set(this.key(request.path), {
      bytes: request.bytes,
      generation,
    });
    return Promise.resolve({ status: "ok" as const, generation });
  }

  delete(request: { path: WorkspacePathV1 }) {
    const held = this.files.get(this.key(request.path));
    this.deleted.push(request.path.path);
    this.files.delete(this.key(request.path));
    return Promise.resolve(
      held
        ? { status: "ok" as const, generation: held.generation }
        : { status: "not-found" as const, reason: "no such file" },
    );
  }
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
        close: () => Promise.resolve(),
      }),
  };
}

async function mount(provider: ComputerProvider, writer = true) {
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
    }),
  );
  return harness;
}

async function capture(
  harness: Awaited<ReturnType<typeof createPluginHarness>>,
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
    { id: crypto.randomUUID(), name: "computer_screenshot", input: {} },
    context,
  );
  if (prepared.kind !== "ready") throw new Error(prepared.result.content);
  return harness.root.tools.executePrepared(prepared, context);
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
