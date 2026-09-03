import { describe, expect, test } from "bun:test";
import type { CatalogEntryV1, CatalogIndexV1 } from "@frockbot/catalog-core";
import type {
  UserConfigurationCommandV1,
  UserSettingsViewV1,
} from "@frockbot/configuration-core";
import {
  compositionArtifactSetHashV1,
  decodeCompositionGenerationV1,
  type CompositionGenerationV1,
} from "@frockbot/kernel-composition/generation";
import { decodeFrockBotManifest } from "@frockbot/kernel-composition";
import {
  authorshipManifestKey,
  type AuthoredManifestRecordV1,
} from "@frockbot/plugin-authoring/records";
import {
  createPackageCatalogHost,
  type BotPackageCatalogReader,
  type PackageCatalogCompositionStore,
  type PackageCatalogStorage,
} from "./backend-package-catalog.ts";

const CONTENT_HASH = "b".repeat(64);
const MANIFEST_HASH = "a".repeat(64);
const UI_CONTENT_HASH = "d".repeat(64);
const UI_SIZE = 42;
const CREATED_AT = "2026-09-02T00:00:00.000Z";

const manifest = {
  schemaVersion: 5 as const,
  id: "parcel-tracking",
  displayName: "Parcel tracking",
  version: "0.0.1",
  compatibility: { frockbot: "*" },
  dependencies: {},
  contributions: {
    runtime: { entry: "./package.js", host: "bot-isolate" as const },
    client: {
      kind: "iframe" as const,
      pages: [
        {
          id: "main",
          artifact: {
            contentHash: UI_CONTENT_HASH,
            size: UI_SIZE,
            mediaType: "text/html" as const,
            bundlerVersion: "frockbot-inline-html@1",
          },
          mounts: [{ slot: "frockbot.tool-result:track_parcel" }],
        },
      ],
    },
  },
  configuration: {
    settings: [],
    connectionTypes: [
      {
        id: "shipping-account",
        displayName: "Shipping account",
        allowMultiple: false,
        authorization: { kind: "grant" as const, driverId: "shipping-oauth" },
        capabilities: ["track"],
      },
    ],
    capabilities: [
      {
        id: "track",
        kind: "tool" as const,
        connectionTypes: ["shipping-account"],
      },
    ],
  },
  tools: [
    {
      name: "track_parcel",
      description: "Tracks a parcel.",
      inputSchema: { type: "object" },
    },
  ],
  permissions: [],
};

const entry: CatalogEntryV1 = {
  schemaVersion: 1,
  catalogId: "parcel-tracking",
  packageId: "parcel-tracking",
  displayName: "Parcel tracking",
  description: "Tracks parcels across carriers.",
  version: "0.0.1",
  kind: "package",
  manifestHash: MANIFEST_HASH,
  tags: ["shipping", "tracking"],
  servers: [],
  setupFields: [],
  skills: [],
  bundle: {
    contentHash: CONTENT_HASH,
    size: 512,
    mediaType: "application/javascript",
    bundlerVersion: "catalog-test@1",
    manifest,
  },
};

const index: CatalogIndexV1 = {
  schemaVersion: 1,
  generation: "catalog-1",
  entries: [
    {
      catalogId: entry.catalogId,
      packageId: entry.packageId,
      displayName: entry.displayName,
      description: entry.description,
      version: entry.version,
      kind: entry.kind,
      manifestHash: entry.manifestHash,
      contentHash: CONTENT_HASH,
      tags: entry.tags,
    },
  ],
};

async function bootstrap(): Promise<CompositionGenerationV1> {
  const members = [
    {
      packageId: "shell",
      specifier: "@frockbot/plugin-shell",
      version: "0.0.1",
      manifestHash: "c".repeat(64),
      provenance: {
        kind: "first-party" as const,
        packageId: "shell",
        version: "0.0.1",
      },
    },
  ];
  return decodeCompositionGenerationV1({
    schemaVersion: 1,
    generationId: "bootstrap-generation",
    artifactSetHash: await compositionArtifactSetHashV1(members),
    createdAt: "2026-09-01T00:00:00.000Z",
    origin: { kind: "bootstrap" },
    members,
    status: "active",
  });
}

async function fixture(
  options: {
    connected?: boolean;
    uiAvailable?: boolean;
    /** A deployment with no published Catalog pins no generation. */
    pinned?: boolean;
  } = {},
) {
  const log: string[] = [];
  const records = new Map<string, unknown>();
  const storage: PackageCatalogStorage = {
    get: (key) => Promise.resolve(records.get(key) as never),
    put: (values) => {
      log.push("bot-intent-or-outcome");
      for (const [key, value] of Object.entries(values))
        records.set(key, value);
      return Promise.resolve();
    },
  };
  let good = await bootstrap();
  const generations = new Map([[good.generationId, good]]);
  const proposed: CompositionGenerationV1[] = [];
  const composition: PackageCatalogCompositionStore = {
    current: () => Promise.resolve(proposed.at(-1) ?? good),
    lastKnownGood: () => Promise.resolve(good),
    read: (generationId) => Promise.resolve(generations.get(generationId)),
    propose: (generation) => {
      log.push("composition-propose");
      proposed.push(generation);
      generations.set(generation.generationId, generation);
      return Promise.resolve();
    },
    list: () =>
      Promise.resolve({
        generations: [...proposed].reverse().concat(good),
      }),
    revert: async (toGenerationId, origin, options) => {
      const target = generations.get(toGenerationId)!;
      const createdAt = options?.createdAt ?? CREATED_AT;
      const generation = decodeCompositionGenerationV1({
        ...target,
        generationId: `${createdAt}:revert-catalog`,
        parentGenerationId: (proposed.at(-1) ?? good).generationId,
        createdAt,
        origin,
        status: "pending",
      });
      proposed.push(generation);
      generations.set(generation.generationId, generation);
      log.push("composition-revert");
      return generation;
    },
  };
  const catalog: BotPackageCatalogReader = {
    readIndex: () => Promise.resolve(index),
    readEntry: ({ catalogId }) =>
      Promise.resolve(catalogId === entry.catalogId ? entry : undefined),
    readSource: () => Promise.resolve(undefined),
    headArtifact: () => Promise.resolve({ size: 512 }),
    headUiArtifact: () =>
      Promise.resolve(options.uiAvailable === false ? undefined : { size: 42 }),
  };
  let user: UserSettingsViewV1 = {
    schemaVersion: 1,
    revision: 0,
    profile: { name: "User" },
    packages: [],
    connections: options.connected
      ? [
          {
            connectionId: "shipping-1",
            packageId: entry.packageId,
            connectionTypeId: "shipping-account",
            displayName: "Shipping",
            state: "ready",
            safeMetadata: {},
          },
        ]
      : [],
    ...(options.pinned === false
      ? {}
      : { catalogGeneration: "catalog-1", catalogIndexHash: "d".repeat(64) }),
  };
  const commands: UserConfigurationCommandV1[] = [];
  const userAuthority = {
    read: () => Promise.resolve(structuredClone(user)),
    execute: (command: UserConfigurationCommandV1) => {
      log.push("user-effect");
      commands.push(command);
      user = {
        ...user,
        revision: user.revision + 1,
        packages:
          command.type === "user/uninstall-package"
            ? user.packages.filter(
                (candidate) => candidate.packageId !== command.packageId,
              )
            : command.type === "user/install-package"
              ? [
                  {
                    packageId: command.packageId,
                    version: command.version,
                    state: "installed",
                    catalogId: command.catalogId,
                    catalogGeneration: command.catalogGeneration,
                    contentHash: command.contentHash,
                    provenance: "catalog",
                  },
                ]
              : user.packages,
      };
      return Promise.resolve({
        schemaVersion: 1 as const,
        commandId: command.commandId,
        revision: user.revision,
        status: "applied" as const,
      });
    },
  };
  const host = createPackageCatalogHost({
    storage,
    composition,
    catalog,
    user: userAuthority,
    userId: "user-1",
    botId: "bot-1",
    runId: "run-1",
    turnId: "turn-1",
    now: () => new Date(CREATED_AT),
  });
  return {
    host,
    log,
    records,
    proposed,
    commands,
    get user() {
      return user;
    },
    activateLatest() {
      good = decodeCompositionGenerationV1({
        ...proposed.at(-1)!,
        status: "active",
      });
      generations.set(good.generationId, good);
      proposed.length = 0;
    },
  };
}

describe("Bot Package Catalog host", () => {
  test("searches the pinned index and inspects Connection readiness", async () => {
    const { host } = await fixture();
    await expect(host.search({ query: "shipping" })).resolves.toMatchObject({
      generation: "catalog-1",
      entries: [{ catalogId: "parcel-tracking" }],
    });
    await expect(
      host.inspect({ catalogId: "parcel-tracking" }),
    ).resolves.toMatchObject({
      declaredTools: ["track_parcel"],
      missingConnectionTypes: ["shipping-account"],
      inert: true,
    });
  });

  test("explains an unpinned Catalog in words a person can act on", async () => {
    const { host } = await fixture({ pinned: false });
    // F4: an unpinned User used to be told "this User has no pinned Package
    // Catalog generation", which the Bot then relayed verbatim.
    for (const call of [
      () => host.search({ query: "shipping" }),
      () => host.inspect({ catalogId: "parcel-tracking" }),
    ]) {
      await expect(call()).rejects.toThrow(
        "No Package Catalog is published for this deployment, so there is nothing to search or install",
      );
    }
  });

  test("persists the iframe manifest before the User effect, appends a summary generation, and replays", async () => {
    const test = await fixture();
    const request = {
      effectId: "catalog-effect-1",
      sessionId: "user-1:bot-1",
      position: { turn: 1, step: 1 },
      change: {
        action: "install" as const,
        input: {
          catalogId: "parcel-tracking",
          contentHash: CONTENT_HASH,
          summary: "Added parcel tracking",
        },
      },
    };

    const first = await test.host.change(request);
    const replay = await test.host.change(request);

    expect(first).toEqual(replay);
    expect(test.commands).toHaveLength(1);
    expect(test.log.indexOf("bot-intent-or-outcome")).toBeLessThan(
      test.log.indexOf("user-effect"),
    );
    expect(test.proposed).toHaveLength(1);
    expect(test.proposed[0]).toMatchObject({
      summary: "Added parcel tracking",
      status: "pending",
      origin: { kind: "bot-catalog", action: "install" },
    });
    expect(test.proposed[0]?.members).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          packageId: "parcel-tracking",
          provenance: expect.objectContaining({
            kind: "catalog",
            contentHash: CONTENT_HASH,
          }),
          artifact: expect.objectContaining({ contentHash: CONTENT_HASH }),
        }),
      ]),
    );
    expect(first).toMatchObject({
      missingConnectionTypes: ["shipping-account"],
    });
    const stored = test.records.get(
      authorshipManifestKey(MANIFEST_HASH),
    ) as AuthoredManifestRecordV1;
    expect(
      decodeFrockBotManifest(stored.manifest).contributions.client,
    ).toEqual(manifest.contributions.client);
  });

  test("refuses an install whose manifest-referenced iframe artifact was not published", async () => {
    const test = await fixture({ uiAvailable: false });

    await expect(
      test.host.change({
        effectId: "catalog-missing-ui",
        sessionId: "user-1:bot-1",
        position: { turn: 1, step: 1 },
        change: {
          action: "install",
          input: {
            catalogId: "parcel-tracking",
            contentHash: CONTENT_HASH,
          },
        },
      }),
    ).resolves.toMatchObject({
      status: "refused",
      reason: expect.stringContaining("iframe artifact"),
    });
    expect(test.commands).toHaveLength(0);
    expect(test.proposed).toHaveLength(0);
  });

  test("hash mismatch and required-core removal are refused before User state changes", async () => {
    const test = await fixture();
    await expect(
      test.host.change({
        effectId: "catalog-wrong-hash",
        sessionId: "user-1:bot-1",
        position: { turn: 1, step: 1 },
        change: {
          action: "install",
          input: {
            catalogId: "parcel-tracking",
            contentHash: "e".repeat(64),
          },
        },
      }),
    ).resolves.toMatchObject({
      status: "refused",
      reason: expect.stringContaining("not"),
    });
    await expect(
      test.host.change({
        effectId: "catalog-remove-core",
        sessionId: "user-1:bot-1",
        position: { turn: 1, step: 1 },
        change: { action: "remove", input: { packageId: "shell" } },
      }),
    ).resolves.toMatchObject({
      status: "refused",
      reason: expect.stringContaining("required or non-Catalog"),
    });
    expect(test.commands).toHaveLength(0);
    expect(test.proposed).toHaveLength(0);
  });

  test("package undo reverses an install in User state and appends a revert generation", async () => {
    const test = await fixture();
    await test.host.change({
      effectId: "catalog-effect-install",
      sessionId: "user-1:bot-1",
      position: { turn: 1, step: 1 },
      change: {
        action: "install",
        input: { catalogId: "parcel-tracking", contentHash: CONTENT_HASH },
      },
    });

    const request = {
      input: {},
      effectId: "undo-catalog-effect",
      sessionId: "user-1:bot-1",
      position: { turn: 2, step: 1 },
    };
    const first = await test.host.undoCatalogChange(request);
    const replay = await test.host.undoCatalogChange(request);

    expect(first).toEqual(replay);
    expect(first).toMatchObject({
      status: "recorded",
      targetGenerationId: "bootstrap-generation",
    });
    expect(test.commands.map((command) => command.type)).toEqual([
      "user/install-package",
      "user/uninstall-package",
    ]);
    expect(test.user.packages).toEqual([]);
    expect(test.proposed.at(-1)).toMatchObject({
      origin: { kind: "revert", revertsTo: "bootstrap-generation" },
      status: "pending",
    });
  });
});
