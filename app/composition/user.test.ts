import { describe, expect, test } from "bun:test";
import {
  ISOLATE_CONTRACT_VERSION,
  servedPluginContractVersionsV1,
} from "@frockbot/core/contracts";
import {
  bootstrapGeneration,
  DurableCompositionStore,
} from "@frockbot/core/durable";
import { MemoryStorage } from "@frockbot/core/durable/testing";
import {
  decodeSeededPluginV1,
  type SeededPluginV1,
} from "@frockbot/app/plugins/catalog";
import {
  readUserCompositionV1,
  reconcileInstalledProviderPluginsV1,
  reconcileSeededCompositionV1,
} from "./user.js";

function store(storage = new MemoryStorage()) {
  return new DurableCompositionStore({
    state: { storage } as unknown as DurableObjectState,
    bootstrap: () =>
      bootstrapGeneration({ createdAt: "2026-09-01T00:00:00.000Z" }),
  });
}

/** The contract a deployment that has moved on no longer serves. */
const RETIRED_CONTRACT_V1 = servedPluginContractVersionsV1()[0]! - 1;

function seeded(
  pluginId: string,
  contentHash = "a".repeat(64),
  seed: "default-on" | "installable" = "default-on",
  contractVersion = ISOLATE_CONTRACT_VERSION - 1,
): SeededPluginV1 {
  return decodeSeededPluginV1({
    pluginId,
    displayName: pluginId,
    description: `The ${pluginId} plugin`,
    seed,
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
      contractVersion,
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

  test("a descriptor the catalog moved on reaches the next read, at the same bytes", async () => {
    const subject = store();
    // The deployment moved a Plugin's descriptor to a new contract without
    // touching its module, so the account carries the artifact it will always
    // carry and a descriptor the runtime refuses.
    await reconcileSeededCompositionV1({
      store: subject,
      userId: "user-1",
      seeded: [
        seeded("weather", "a".repeat(64), "default-on", RETIRED_CONTRACT_V1),
      ],
      now: new Date("2026-09-12T00:00:00.000Z"),
    });
    const stale = (await subject.current()).members[0]!;
    expect(stale.artifact.contentHash).toBe("a".repeat(64));
    expect(servedPluginContractVersionsV1()).not.toContain(
      stale.descriptor.contractVersion,
    );
    const repaired = await reconcileSeededCompositionV1({
      store: subject,
      userId: "user-1",
      seeded: [
        seeded(
          "weather",
          "a".repeat(64),
          "default-on",
          ISOLATE_CONTRACT_VERSION,
        ),
      ],
      now: new Date("2026-09-12T00:01:00.000Z"),
    });
    const carried = repaired!.members[0]!;
    expect(carried.artifact.contentHash).toBe("a".repeat(64));
    expect(servedPluginContractVersionsV1()).toContain(
      carried.descriptor.contractVersion,
    );
    // And it holds still on the catalog it just followed: the descriptor is
    // compared, not re-proposed on every read.
    expect(
      await reconcileSeededCompositionV1({
        store: subject,
        userId: "user-1",
        seeded: [
          seeded(
            "weather",
            "a".repeat(64),
            "default-on",
            ISOLATE_CONTRACT_VERSION,
          ),
        ],
      }),
    ).toBeUndefined();
  });

  test("a page the catalog moved on reaches the next read, at the same module", async () => {
    const withPage = (pageHash: string): SeededPluginV1 => {
      const plugin = seeded("strobe");
      return decodeSeededPluginV1({
        ...plugin,
        descriptor: {
          ...plugin.descriptor,
          views: [
            {
              slot: "conversation.panel",
              surfaceId: "strobe",
              label: "Strobe",
              page: "strobe.html",
            },
          ],
        },
        pages: [{ path: "strobe.html", contentHash: pageHash, size: 3 }],
      });
    };
    const subject = store();
    await reconcileSeededCompositionV1({
      store: subject,
      userId: "user-1",
      seeded: [withPage("b".repeat(64))],
      now: new Date("2026-09-24T00:00:00.000Z"),
    });
    // Only the page changed: the module and descriptor an account carries are
    // the ones it will keep, so the page alone has to move it.
    const moved = await reconcileSeededCompositionV1({
      store: subject,
      userId: "user-1",
      seeded: [withPage("c".repeat(64))],
      now: new Date("2026-09-24T00:01:00.000Z"),
    });
    expect(moved!.members[0]!.pages).toEqual([
      { path: "strobe.html", contentHash: "c".repeat(64), size: 3 },
    ]);
    expect(
      await reconcileSeededCompositionV1({
        store: subject,
        userId: "user-1",
        seeded: [withPage("c".repeat(64))],
      }),
    ).toBeUndefined();
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

describe("installing a provider Plugin from the account's own command", () => {
  /** The catalog entry an install of `provider-deepseek` would carry. */
  function providerPlugin(
    contentHash = "b".repeat(64),
    contractVersion = ISOLATE_CONTRACT_VERSION - 1,
  ): SeededPluginV1 {
    return decodeSeededPluginV1({
      pluginId: "deepseek",
      displayName: "DeepSeek",
      description: "Runs replies on DeepSeek models.",
      seed: "installable",
      artifact: {
        contentHash,
        size: 12,
        mediaType: "application/javascript",
        bundlerVersion: "seed",
      },
      descriptor: {
        id: "deepseek",
        displayName: "DeepSeek",
        version: "1.0.0",
        contractVersion,
        tools: [],
        hooks: [],
        grants: [],
        modelProviders: [{ id: "deepseek", protocolVersion: 1 }],
        contextKeys: ["user", "bot", "session"],
      },
    });
  }

  async function read(
    storage: MemoryStorage,
    catalog: readonly SeededPluginV1[],
    installedPackageIds: readonly string[],
  ) {
    return readUserCompositionV1(
      { ctx: { storage } as unknown as DurableObjectState },
      { userId: "user-1", catalog, adminOpened: [], installedPackageIds },
    );
  }

  test("an install puts the artifact in the account's Composition, and an uninstall takes it out", async () => {
    const storage = new MemoryStorage();
    const catalog = [providerPlugin()];
    const before = await read(storage, catalog, []);
    expect(
      before.current.members.map((member) => member.packageId),
    ).not.toContain("deepseek");

    const installed = await read(storage, catalog, ["provider-deepseek"]);
    const member = installed.current.members.find(
      (candidate) => candidate.packageId === "deepseek",
    );
    expect(member).toBeDefined();
    expect(member!.provenance.kind).toBe("installed");
    expect(member!.artifact.contentHash).toBe("b".repeat(64));

    const removed = await read(storage, catalog, []);
    expect(
      removed.current.members.map((candidate) => candidate.packageId),
    ).not.toContain("deepseek");
  });

  test("an account that installed nothing carries nothing, and a re-read holds still", async () => {
    const storage = new MemoryStorage();
    const catalog = [providerPlugin()];
    await read(storage, catalog, []);
    const first = await read(storage, catalog, ["provider-deepseek"]);
    const second = await read(storage, catalog, ["provider-deepseek"]);
    expect(second.current.generationId).toBe(first.current.generationId);
  });

  test("a deployment that updated the artifact reaches the next read", async () => {
    const storage = new MemoryStorage();
    const before = await read(
      storage,
      [providerPlugin()],
      ["provider-deepseek"],
    );
    const after = await read(
      storage,
      [providerPlugin("c".repeat(64))],
      ["provider-deepseek"],
    );
    expect(after.current.generationId).not.toBe(before.current.generationId);
    expect(
      after.current.members.find((member) => member.packageId === "deepseek")!
        .artifact.contentHash,
    ).toBe("c".repeat(64));
  });

  test("an install follows a descriptor the deployment moved on, at the same bytes", async () => {
    const storage = new MemoryStorage();
    const before = await read(
      storage,
      [providerPlugin("b".repeat(64), RETIRED_CONTRACT_V1)],
      ["provider-deepseek"],
    );
    const stale = before.current.members.find(
      (member) => member.packageId === "deepseek",
    )!;
    expect(stale.artifact.contentHash).toBe("b".repeat(64));
    expect(servedPluginContractVersionsV1()).not.toContain(
      stale.descriptor.contractVersion,
    );
    const after = await read(
      storage,
      [providerPlugin("b".repeat(64), ISOLATE_CONTRACT_VERSION)],
      ["provider-deepseek"],
    );
    expect(servedPluginContractVersionsV1()).toContain(
      after.current.members.find((member) => member.packageId === "deepseek")!
        .descriptor.contractVersion,
    );
  });

  test("installation leaves the seeded set alone", async () => {
    const storage = new MemoryStorage();
    const catalog = [seeded("email"), providerPlugin()];
    const snapshot = await read(storage, catalog, ["provider-deepseek"]);
    expect(
      snapshot.current.members.map((member) => member.packageId).toSorted(),
    ).toEqual(["deepseek", "email"]);
    expect(
      snapshot.current.members.find((member) => member.packageId === "email")!
        .provenance.kind,
    ).toBe("user");
  });

  test("a read follows each desired set through install, uninstall and reinstall", async () => {
    const storage = new MemoryStorage();
    const catalog = [providerPlugin()];
    const install = await read(storage, catalog, ["provider-deepseek"]);
    const uninstall = await read(storage, catalog, []);
    const reinstall = await read(storage, catalog, ["provider-deepseek"]);
    expect(install.current.members.map((member) => member.packageId)).toEqual([
      "deepseek",
    ]);
    expect(uninstall.current.members).toEqual([]);
    expect(reinstall.current.members.map((member) => member.packageId)).toEqual(
      ["deepseek"],
    );
    // Each desired set reached the pin — none of the three collapsed into a
    // generation the store already held.
    const pins = [
      install.current.generationId,
      uninstall.current.generationId,
      reinstall.current.generationId,
    ];
    expect(new Set(pins).size).toBe(3);
  });

  test("install, uninstall and reinstall under one clock reading each reach their own pin", async () => {
    // The clock is the account's own read: a fixed `now` is what a test
    // supplies, and what two proposals in one millisecond would look like.
    const subject = store();
    const at = new Date("2026-09-18T00:00:00.000Z");
    const reconcile = (installedPackageIds: readonly string[]) =>
      reconcileInstalledProviderPluginsV1({
        store: subject,
        userId: "user-1",
        catalog: [providerPlugin()],
        installedPackageIds,
        now: at,
      });
    const installed = await reconcile(["provider-deepseek"]);
    const uninstalled = await reconcile([]);
    const reinstalled = await reconcile(["provider-deepseek"]);
    expect(installed?.members.map((member) => member.packageId)).toEqual([
      "deepseek",
    ]);
    expect(uninstalled?.members).toEqual([]);
    expect(reinstalled?.members.map((member) => member.packageId)).toEqual([
      "deepseek",
    ]);
    // Each proposal is stamped later than the generation it derives from, so
    // the store's "never rewrite a generation" rule never sees a repeated id.
    const stamps = [installed, uninstalled, reinstalled].map((generation) =>
      Date.parse(generation!.createdAt),
    );
    expect(stamps[1]!).toBeGreaterThan(stamps[0]!);
    expect(stamps[2]!).toBeGreaterThan(stamps[1]!);
    const current = await subject.current();
    expect(current.generationId).toBe(reinstalled!.generationId);
    expect(current.members.map((member) => member.packageId)).toEqual([
      "deepseek",
    ]);
  });

  test("reconciliation is idempotent and only touches what it installs", async () => {
    const subject = store();
    const proposed = await reconcileInstalledProviderPluginsV1({
      store: subject,
      userId: "user-1",
      catalog: [providerPlugin()],
      installedPackageIds: ["provider-deepseek"],
      now: new Date("2026-09-18T00:00:00.000Z"),
    });
    expect(proposed?.members.map((member) => member.packageId)).toEqual([
      "deepseek",
    ]);
    const again = await reconcileInstalledProviderPluginsV1({
      store: subject,
      userId: "user-1",
      catalog: [providerPlugin()],
      installedPackageIds: ["provider-deepseek"],
      now: new Date("2026-09-18T00:01:00.000Z"),
    });
    expect(again).toBeUndefined();
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
