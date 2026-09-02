// The remote Package Catalog, end to end through `SELF.fetch`.
//
// Seeds one immutable generation into the real `PACKAGE_CATALOG` bucket, reads
// it back through the gateway route a browser uses, installs an entry from the
// pinned generation, and then uninstalls it — checking on the way that an
// install off the pinned generation is refused with a visible failure and that
// uninstalling leaves the User's Connection untouched (ADR 0019).
//
// Nothing here reaches R2 on the product's behalf except the seed: every read
// crosses the gateway, exactly as the browser and the Bot Durable Object do.
import {
  catalogContentHashV1,
  catalogEntryKeyV1,
  catalogIndexKeyV1,
  CATALOG_POINTER_KEY_V1,
  decodeCatalogEntryV1,
  decodeCatalogIndexV1,
  type CatalogEntryV1,
  type CatalogIndexV1,
} from "@frockbot/catalog-core";
import type { UserSettingsViewV1 } from "@frockbot/configuration-core";
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  asUser,
  CUSTOM_MODELS_PACKAGE_ID,
  expectOkJson,
  freshUserId,
  OLLAMA_GOOD_API_KEY,
  postAsUser,
  PROVISIONED_MODEL,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

const GENERATION = "gen-integration-1";
const MANIFEST_HASH = "e".repeat(64);

/**
 * The seeded entry is a Package the running application also compiles in, so
 * the install it admits is one the rest of the product can act on — which is
 * the point of the seed catalog: the compiled-in Packages appear in the remote
 * index too.
 */
const ENTRY: CatalogEntryV1 = decodeCatalogEntryV1({
  schemaVersion: 1,
  catalogId: PROVISIONED_MODEL.packageId,
  packageId: PROVISIONED_MODEL.packageId,
  displayName: "Ollama Cloud",
  description: "Models served by Ollama Cloud.",
  version: "0.0.1",
  kind: "package",
  manifestHash: MANIFEST_HASH,
  servers: [],
  setupFields: [],
  skills: [],
});

const INDEX: CatalogIndexV1 = decodeCatalogIndexV1({
  schemaVersion: 1,
  generation: GENERATION,
  entries: [
    {
      catalogId: ENTRY.catalogId,
      packageId: ENTRY.packageId,
      displayName: ENTRY.displayName,
      description: ENTRY.description,
      version: ENTRY.version,
      manifestHash: ENTRY.manifestHash,
      kind: ENTRY.kind,
    },
  ],
});

const indexDocument = JSON.stringify(INDEX);
const entryDocument = JSON.stringify(ENTRY);

beforeAll(async () => {
  const indexHash = await catalogContentHashV1(indexDocument);
  // Generation objects first, the mutable pointer last: nothing may name a
  // generation before every object in it exists.
  await env.PACKAGE_CATALOG.put(
    catalogEntryKeyV1(GENERATION, ENTRY.catalogId),
    entryDocument,
  );
  await env.PACKAGE_CATALOG.put(catalogIndexKeyV1(GENERATION), indexDocument);
  await env.PACKAGE_CATALOG.put(
    CATALOG_POINTER_KEY_V1,
    JSON.stringify({ schemaVersion: 1, generation: GENERATION, indexHash }),
  );
});

async function readUserSettings(userId: string): Promise<UserSettingsViewV1> {
  return (await expectOkJson(
    await asUser(userId, "/api/settings"),
  )) as UserSettingsViewV1;
}

describe("the remote Package Catalog", () => {
  it("serves the seeded generation through the gateway route", async () => {
    const userId = freshUserId("catalog-read");
    const response = await asUser(userId, "/catalog/v1/index");

    expect(response.status).toBe(200);
    expect(response.headers.get("x-frockbot-catalog-generation")).toBe(
      GENERATION,
    );
    const index = decodeCatalogIndexV1(await response.json());
    expect(index.entries.map((entry) => entry.catalogId)).toEqual([
      PROVISIONED_MODEL.packageId,
    ]);

    const entry = await asUser(
      userId,
      `/catalog/v1/entry/${PROVISIONED_MODEL.packageId}`,
    );
    expect(entry.status).toBe(200);
    expect(decodeCatalogEntryV1(await entry.json()).manifestHash).toBe(
      MANIFEST_HASH,
    );

    // An id the pinned generation does not carry is a 404, not an empty body.
    expect((await asUser(userId, "/catalog/v1/entry/weather")).status).toBe(
      404,
    );
  });

  it("pins the generation on the first settings read", async () => {
    const userId = freshUserId("catalog-pin");
    const settings = await readUserSettings(userId);

    expect(settings.catalogGeneration).toBe(GENERATION);
    expect(settings.catalogIndexHash).toBe(
      await catalogContentHashV1(indexDocument),
    );
  });

  it("refuses an install off the pinned generation", async () => {
    const userId = freshUserId("catalog-stale");
    const settings = await readUserSettings(userId);

    const refused = await postAsUser(userId, "/api/settings", {
      schemaVersion: 1,
      type: "user/install-package",
      commandId: "install-stale",
      expectedRevision: settings.revision,
      packageId: PROVISIONED_MODEL.packageId,
      version: "0.0.1",
      catalogId: PROVISIONED_MODEL.packageId,
      catalogGeneration: "gen-somewhere-else",
    });

    expect(refused.status).toBe(500);
    expect((await refused.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("is not the pinned generation"),
    });
    // The refusal changed nothing: the Package list is still the one the
    // User's first configuration read bootstrapped.
    expect((await readUserSettings(userId)).packages).toEqual(
      settings.packages,
    );
  });

  it("installs from the pinned generation and uninstalls only the row", async () => {
    const userId = freshUserId("catalog-install");
    const pinned = await readUserSettings(userId);

    await expectOkJson(
      await postAsUser(userId, "/api/settings", {
        schemaVersion: 1,
        type: "user/set-package-enabled",
        commandId: "enable-custom-models-for-catalog",
        expectedRevision: pinned.revision,
        packageId: CUSTOM_MODELS_PACKAGE_ID,
        enabled: true,
      }),
    );
    await expectOkJson(
      await postAsUser(userId, "/api/settings", {
        schemaVersion: 1,
        type: "user/install-package",
        commandId: "install-from-catalog",
        expectedRevision: pinned.revision + 1,
        packageId: PROVISIONED_MODEL.packageId,
        version: "0.0.1",
        catalogId: PROVISIONED_MODEL.packageId,
        catalogGeneration: GENERATION,
      }),
    );

    // The bootstrap already installed this first-party Package; installing it
    // from the pinned generation restates the one row with the Catalog's own
    // provenance rather than adding a second.
    const installed = await readUserSettings(userId);
    expect(
      installed.packages.filter(
        (pkg) => pkg.packageId === PROVISIONED_MODEL.packageId,
      ),
    ).toEqual([
      {
        packageId: PROVISIONED_MODEL.packageId,
        version: "0.0.1",
        state: "installed",
        catalogId: PROVISIONED_MODEL.packageId,
        catalogGeneration: GENERATION,
        provenance: "catalog",
      },
    ]);

    // The compiled-in manifest is unchanged by a Catalog install: the Catalog
    // decides availability, the application still decides what can execute.
    const manifest = (await expectOkJson(
      await asUser(userId, "/app-manifest"),
    )) as { packages: { id: string }[] };
    expect(manifest.packages.map((pkg) => pkg.id)).toContain(
      PROVISIONED_MODEL.packageId,
    );

    // The User's Connection is independent durable state.
    const connection = (await expectOkJson(
      await postAsUser(userId, "/api/connections", {
        schemaVersion: 1,
        type: "connection/create-api-key",
        commandId: "connect-catalog",
        packageId: PROVISIONED_MODEL.packageId,
        connectionTypeId: PROVISIONED_MODEL.connectionTypeId,
        label: "Catalog",
        apiKey: OLLAMA_GOOD_API_KEY,
      }),
    )) as { connectionId: string };

    const beforeUninstall = await readUserSettings(userId);
    await expectOkJson(
      await postAsUser(userId, "/api/settings", {
        schemaVersion: 1,
        type: "user/uninstall-package",
        commandId: "uninstall-from-catalog",
        expectedRevision: beforeUninstall.revision,
        packageId: PROVISIONED_MODEL.packageId,
      }),
    );

    const uninstalled = await readUserSettings(userId);
    expect(uninstalled.packages.map((pkg) => pkg.packageId)).not.toContain(
      PROVISIONED_MODEL.packageId,
    );
    // The Connection is the User's own account and is untouched.
    expect(uninstalled.connections.map((item) => item.connectionId)).toContain(
      connection.connectionId,
    );
  });
});
