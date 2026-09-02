import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import {
  CATALOG_POINTER_KEY_V1,
  catalogContentHashV1,
  catalogEntryKeyV1,
  catalogIndexKeyV1,
} from "@frockbot/catalog-core";
import { canonicalJson, sha256 } from "@frockbot/kernel-composition/compiler";
import type { UserSettingsViewV1 } from "@frockbot/configuration-core";

const MODULE = `export const tools = [
  { name: "track_parcel", description: "Tracks a parcel", inputSchema: { type: "object" }, idempotent: true },
];
export async function execute(tool, input, ctx) {
  const connectionId = String(input?.connectionId ?? "");
  const capabilities = await ctx.capabilities.list();
  const connected = capabilities.status === "available"
    && capabilities.connections.some((connection) => connection.connectionId === connectionId);
  if (!connected) return JSON.stringify(await ctx.connection(connectionId));
  return "catalog parcel " + String(input?.id ?? "unknown");
}
`;

function suffix() {
  return crypto.randomUUID().slice(0, 8);
}

async function publishCatalog(generation: string) {
  const contentHash = await sha256(MODULE);
  const manifest = {
    schemaVersion: 3 as const,
    id: "parcel-tracking",
    displayName: "Parcel tracking",
    version: "0.0.1",
    compatibility: { frockbot: "*" },
    dependencies: {},
    contributions: {
      runtime: { entry: "./package.js", host: "bot-isolate" as const },
    },
    configuration: {
      settings: [],
      connectionTypes: [
        {
          id: "shipping-account",
          displayName: "Shipping account",
          allowMultiple: false,
          authorization: { kind: "none" as const, driverId: "shipping" },
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
        description: "Tracks a parcel",
        inputSchema: { type: "object" },
      },
    ],
    permissions: [],
  };
  const manifestHash = await sha256(canonicalJson(manifest));
  const entry = {
    schemaVersion: 1,
    catalogId: "parcel-tracking",
    packageId: "parcel-tracking",
    displayName: "Parcel tracking",
    description: "Tracks parcels across carriers.",
    version: "0.0.1",
    kind: "package",
    manifestHash,
    tags: ["shipping", "tracking"],
    servers: [],
    setupFields: [],
    skills: [],
    bundle: {
      contentHash,
      size: new TextEncoder().encode(MODULE).byteLength,
      mediaType: "application/javascript",
      bundlerVersion: "workerd-catalog-fixture@1",
      manifest,
      sourceHash: contentHash,
    },
  };
  const indexDocument = canonicalJson({
    schemaVersion: 1,
    generation,
    entries: [
      {
        catalogId: entry.catalogId,
        packageId: entry.packageId,
        displayName: entry.displayName,
        description: entry.description,
        version: entry.version,
        manifestHash,
        kind: entry.kind,
        contentHash,
        tags: entry.tags,
      },
    ],
  });
  const indexHash = await catalogContentHashV1(indexDocument);
  await env.PACKAGE_CATALOG.put(
    catalogEntryKeyV1(generation, entry.catalogId),
    canonicalJson(entry),
  );
  await env.PACKAGE_CATALOG.put(catalogIndexKeyV1(generation), indexDocument);
  await env.PACKAGE_CATALOG.put(
    CATALOG_POINTER_KEY_V1,
    canonicalJson({ schemaVersion: 1, generation, indexHash }),
  );
  await env.APPLICATION_ARTIFACTS.put(`packages/${contentHash}.mjs`, MODULE);
  await env.APPLICATION_ARTIFACTS.put(`packages/${contentHash}.ts`, MODULE);
  return { contentHash };
}

describe("a Bot installing a Package from the Catalog", () => {
  test("installs hash-pinned code, remounts after a Connection appears, and package_undo removes it", async () => {
    const id = suffix();
    const userId = `catalog-user-${id}`;
    const botId = `catalog-bot-${id}`;
    const generation = `catalog-${id}`;
    const { contentHash } = await publishCatalog(generation);
    const user = env.USER_CONFIGURATIONS.getByName(userId) as unknown as {
      readConfiguration(input: unknown): Promise<UserSettingsViewV1>;
    };
    // First read pins exactly the generation the Bot tools will search.
    expect(
      (await user.readConfiguration({ schemaVersion: 1, userId }))
        .catalogGeneration,
    ).toBe(generation);
    const probe = env.AUTHORING.getByName(`catalog-probe-${id}`);

    const installed = await probe.runTurn({
      runId: `catalog-install-${id}`,
      userId,
      botId,
      tool: "package_install",
      input: {
        catalogId: "parcel-tracking",
        contentHash,
        summary: "Added parcel tracking",
      },
    });
    expect(installed.text).toContain('ok:Installed Package "Parcel tracking"');
    expect(installed.text).toContain("inert until the User connects");
    expect((await probe.currentGeneration()).summary).toBe(
      "Added parcel tracking",
    );

    const used = await probe.runTurn({
      runId: `catalog-use-${id}`,
      userId,
      botId,
      tool: "track_parcel",
      input: { id: "AU123", connectionId: "shipping-1" },
    });
    expect(used.text).toContain('ok:{"status":"unavailable"');
    expect(used.loaderCalls).toBe(1);

    // This ready snapshot represents the User-created Connection. It changes
    // the binding digest, so the next admitted Turn mounts a different isolate
    // and the Package sees the Connection with no Package-local grant step.
    const connected = await probe.runTurn({
      runId: `catalog-connected-${id}`,
      userId,
      botId,
      tool: "track_parcel",
      input: { id: "AU123", connectionId: "shipping-1" },
      connections: [
        {
          connectionId: "shipping-1",
          packageId: "parcel-tracking",
          connectionTypeId: "shipping-account",
          displayName: "Shipping",
          generation: "shipping-generation-1",
          safeMetadata: {},
        },
      ],
    });
    expect(connected.text).toBe("ok:catalog parcel AU123");
    expect(connected.loaderCalls).toBe(1);
    expect(connected.loaderIds).not.toEqual(used.loaderIds);

    const undone = await probe.runTurn({
      runId: `catalog-undo-${id}`,
      userId,
      botId,
      tool: "package_undo",
      input: {},
    });
    expect(undone.text).toContain("ok:Package setup will return");
    expect(
      (
        await user.readConfiguration({ schemaVersion: 1, userId })
      ).packages.some((pkg) => pkg.packageId === "parcel-tracking"),
    ).toBe(false);
    expect(
      (await probe.currentGeneration()).members.map(
        (member) => member.packageId,
      ),
    ).toEqual(["shell"]);
  });
});
