import { describe, expect, test } from "bun:test";
import { SessionStore } from "@frockbot/kernel-contracts";
import { Context } from "cordis";
import {
  PACKAGE_INSPECT_INPUT_SCHEMA_V1,
  PACKAGE_INSTALL_INPUT_SCHEMA_V1,
  PACKAGE_REMOVE_INPUT_SCHEMA_V1,
  PACKAGE_SEARCH_INPUT_SCHEMA_V1,
  PACKAGE_UPDATE_INPUT_SCHEMA_V1,
  decodePackageInstallInputV1,
} from "./shared.ts";
import {
  createPackageInstallTool,
  type PackageCatalogChangeRequestV1,
  type PackageCatalogHost,
} from "./agent.ts";

const CONTEXT = {
  botId: "bot-1",
  agentId: "bot-1",
  sessionId: "user-1:bot-1",
  compositionGenerationId: "generation-1",
  turnType: "chat" as const,
  effectId: "tool:1:1:0",
  signal: new AbortController().signal,
};

function host(seen: PackageCatalogChangeRequestV1[] = []): PackageCatalogHost {
  return {
    effectIdFor: () => Promise.resolve("catalog-effect-1"),
    search: () => Promise.resolve({ generation: "catalog-1", entries: [] }),
    inspect: () =>
      Promise.resolve({
        generation: "catalog-1",
        entry: {
          schemaVersion: 1,
          catalogId: "parcel-tracking",
          packageId: "parcel-tracking",
          displayName: "Parcel tracking",
          description: "Tracks parcels.",
          version: "0.0.1",
          kind: "package",
          manifestHash: "a".repeat(64),
          servers: [],
          setupFields: [],
          skills: [],
        },
        declaredTools: [],
        connectionTypes: [],
        missingConnectionTypes: [],
        inert: false,
      }),
    change: (request) => {
      seen.push(request);
      return Promise.resolve({
        status: "recorded",
        action: request.change.action,
        effectId: request.effectId,
        packageId: "parcel-tracking",
        displayName: "Parcel tracking",
        version: "0.0.1",
        contentHash: "b".repeat(64),
        generationId: "generation-2",
        missingConnectionTypes: ["shipping-account"],
      });
    },
  };
}

describe("Package Catalog tool schemas", () => {
  test("expose the five exact input DTOs", () => {
    expect(PACKAGE_SEARCH_INPUT_SCHEMA_V1.required).toEqual(["query"]);
    expect(PACKAGE_INSPECT_INPUT_SCHEMA_V1.required).toEqual(["catalogId"]);
    // `contentHash` is optional: a first-party Catalog entry names reviewed
    // compiled-in code and publishes no bundle, so it has no hash to send.
    // Requiring one made `package_install` by chat refuse every seeded entry
    // while the Plugins page installed the same one fine.
    expect(PACKAGE_INSTALL_INPUT_SCHEMA_V1.required).toEqual(["catalogId"]);
    expect(PACKAGE_UPDATE_INPUT_SCHEMA_V1).toBe(
      PACKAGE_INSTALL_INPUT_SCHEMA_V1,
    );
    expect(PACKAGE_REMOVE_INPUT_SCHEMA_V1.required).toEqual(["packageId"]);
    expect(
      decodePackageInstallInputV1({
        catalogId: "parcel-tracking",
        contentHash: "b".repeat(64),
        summary: "Added parcel tracking",
      }).summary,
    ).toBe("Added parcel tracking");
    expect(() =>
      decodePackageInstallInputV1({
        catalogId: "parcel-tracking",
        contentHash: "b".repeat(64),
        summary: "Added\nparcel tracking",
      }),
    ).toThrow("one trimmed line");
  });

  test("records mutation intent before calling the host and logs the result", async () => {
    const root = new Context();
    await root.plugin(SessionStore);
    const seen: PackageCatalogChangeRequestV1[] = [];
    const session = root.sessions.create(CONTEXT.sessionId);
    session.appendBatch([
      { type: "turn/start", turn: 2 },
      { type: "step/start", turn: 2, step: 1 },
    ]);
    const tool = createPackageInstallTool(host(seen), root.sessions);

    const result = await tool.execute(
      { catalogId: "parcel-tracking", contentHash: "b".repeat(64) },
      CONTEXT,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("inert until the User connects");
    expect(result.content).toContain("Do not ask or prompt");
    expect(seen).toHaveLength(1);
    expect(session.events.slice(-2).map((event) => event.type)).toEqual([
      "package/catalog-change-intent",
      "package/catalog-changed",
    ]);
    await root.fiber.dispose();
  });
});
