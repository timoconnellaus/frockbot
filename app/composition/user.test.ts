import { describe, expect, test } from "bun:test";
import {
  bootstrapGeneration,
  DurableCompositionStore,
} from "@frockbot/core/durable";
import { MemoryStorage } from "@frockbot/core/durable/memory-storage.fixture";
import {
  decodeSeededPluginV1,
  type SeededPluginV1,
} from "@frockbot/app/plugins/catalog";
import { reconcileSeededCompositionV1 } from "./user.js";

function store(storage = new MemoryStorage()) {
  return new DurableCompositionStore({
    state: { storage } as unknown as DurableObjectState,
    bootstrap: () =>
      bootstrapGeneration({ createdAt: "2026-09-01T00:00:00.000Z" }),
  });
}

function seeded(
  pluginId: string,
  contentHash = "a".repeat(64),
): SeededPluginV1 {
  return decodeSeededPluginV1({
    pluginId,
    displayName: pluginId,
    description: `The ${pluginId} plugin`,
    seed: "default-on",
    hidden: false,
    artifact: {
      contentHash,
      size: 12,
      mediaType: "application/javascript",
      bundlerVersion: "seed",
    },
    descriptor: {
      id: pluginId,
      displayName: pluginId,
      version: "1.0.0",
      contractVersion: 4,
      tools: [{ name: "ping", description: "Pings", inputSchema: {} }],
      hooks: [],
      grants: [],
      contextKeys: ["user", "bot", "session"],
    },
  });
}

describe("reconciling the deployment's catalog into a User's Composition", () => {
  test("seeds what the account should carry, pinned for the next Turn, and then holds still", async () => {
    const subject = store();
    const bootstrap = await subject.current();
    const proposed = await reconcileSeededCompositionV1({
      store: subject,
      userId: "user-1",
      seeded: [seeded("weather")],
      now: new Date("2026-09-12T00:00:00.000Z"),
    });
    expect(proposed?.members.map((member) => member.packageId)).toEqual([
      "weather",
    ]);
    expect(proposed?.parentGenerationId).toBe(bootstrap.generationId);
    expect(proposed?.origin).toEqual({ kind: "bootstrap" });
    expect((await subject.current()).generationId).toBe(proposed!.generationId);
    // Same catalog, same members: nothing to propose.
    expect(
      await reconcileSeededCompositionV1({
        store: subject,
        userId: "user-1",
        seeded: [seeded("weather")],
      }),
    ).toBeUndefined();
  });

  test("follows the catalog: a new artifact, a removed plugin, an opened gate", async () => {
    const subject = store();
    await reconcileSeededCompositionV1({
      store: subject,
      userId: "user-1",
      seeded: [seeded("weather")],
      now: new Date("2026-09-12T00:00:00.000Z"),
    });
    const rebuilt = await reconcileSeededCompositionV1({
      store: subject,
      userId: "user-1",
      seeded: [seeded("weather", "b".repeat(64)), seeded("greeter")],
      now: new Date("2026-09-12T00:01:00.000Z"),
    });
    expect(
      rebuilt?.members.map((member) => member.artifact.contentHash),
    ).toEqual(["a".repeat(64), "b".repeat(64)]);
    expect(rebuilt?.members.map((member) => member.packageId)).toEqual([
      "greeter",
      "weather",
    ]);
    const removed = await reconcileSeededCompositionV1({
      store: subject,
      userId: "user-1",
      seeded: [],
      now: new Date("2026-09-12T00:02:00.000Z"),
    });
    expect(removed?.members).toEqual([]);
  });

  test("keeps what a Bot wrote beside the seeded set", async () => {
    const subject = store();
    const bootstrap = await subject.current();
    const authored = {
      ...seededMember("authored"),
      provenance: {
        kind: "bot" as const,
        packageId: "authored",
        version: "1.0.0",
        botId: "bot-1",
        sessionId: "user-1:bot-1",
        turnId: "turn-1",
        runId: "run-1",
        authoredAt: "2026-09-11T00:00:00.000Z",
      },
    };
    const { compositionArtifactSetHashV1, compositionGenerationIdV1 } =
      await import("@frockbot/core/durable");
    const createdAt = "2026-09-11T00:00:00.000Z";
    const artifactSetHash = await compositionArtifactSetHashV1([authored]);
    await subject.propose(
      {
        schemaVersion: 1,
        generationId: compositionGenerationIdV1(createdAt, artifactSetHash),
        artifactSetHash,
        parentGenerationId: bootstrap.generationId,
        createdAt,
        origin: {
          kind: "bot-authored",
          runId: "run-1",
          sessionId: "user-1:bot-1",
          turnId: "turn-1",
        },
        members: [authored],
        status: "pending",
      },
      { pin: true },
    );
    const proposed = await reconcileSeededCompositionV1({
      store: subject,
      userId: "user-1",
      seeded: [seeded("weather")],
      now: new Date("2026-09-12T00:00:00.000Z"),
    });
    expect(proposed?.members.map((member) => member.packageId)).toEqual([
      "authored",
      "weather",
    ]);
  });
});

function seededMember(pluginId: string) {
  const plugin = seeded(pluginId);
  return {
    packageId: pluginId,
    version: plugin.descriptor.version,
    artifact: plugin.artifact,
    descriptor: plugin.descriptor,
  };
}
