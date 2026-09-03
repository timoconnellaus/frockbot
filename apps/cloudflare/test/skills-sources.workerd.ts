// The Skill catalog's three live sources, assembled inside a real Bot Durable
// Object over real storage.
//
// Two claims:
//
//  1. A Bot's catalog draws from its own instruction root, the managed set
//     compiled into the Skills Package's artifact, and an index over the
//     Catalog entries its User has installed — the last read from the real
//     `PACKAGE_CATALOG` bucket at the *pinned* generation, never the live
//     pointer, and never copied into any root.
//  2. Uninstalling the entry removes its Skills from the next catalog, with the
//     Bot's own and the managed set untouched. Nothing has to be deleted for
//     that to happen, because nothing was ever written.
//
// Both are read back through the production loader the Turn itself uses. The
// Turn-level claim — that the catalog is injected under the Composition the
// Turn pinned — belongs to `test/integration/skills-sources.integration.ts`,
// where a real Turn records `composition/pinned` and `skill/injected` together.
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import {
  catalogContentHashV1,
  catalogEntryKeyV1,
  catalogIndexKeyV1,
  CATALOG_POINTER_KEY_V1,
} from "@frockbot/catalog-core";
import { provisionBot } from "./provision-bot.ts";

const CATALOG_PACKAGE = "skillful";
const CATALOG_VERSION = "0.0.1";
const MANIFEST_HASH = "d".repeat(64);
const SKILL_BODY =
  "PLUGIN-SKILL-BODY: check the roster, then the roster again.";

const MANAGED_PATHS = [
  "managed/add-connector/SKILL.md",
  "managed/applets/SKILL.md",
  "managed/export-bot-template/SKILL.md",
  "managed/import-bot-template/SKILL.md",
  "managed/learn-from-demonstration/SKILL.md",
];

function bot(name: string) {
  return env.BOT_STATES.getByName(name);
}

function user(userId: string) {
  return env.USER_CONFIGURATIONS.getByName(userId);
}

/** One immutable generation with one entry that ships one Skill. */
async function seedCatalog(generation: string): Promise<void> {
  const entry = {
    schemaVersion: 1,
    catalogId: CATALOG_PACKAGE,
    packageId: CATALOG_PACKAGE,
    displayName: "Skillful",
    description: "A Package that ships a Skill.",
    version: CATALOG_VERSION,
    kind: "package",
    manifestHash: MANIFEST_HASH,
    servers: [],
    setupFields: [],
    skills: [
      {
        name: "Roster check",
        description: "Use this when checking the roster.",
        body: SKILL_BODY,
      },
    ],
  };
  const index = {
    schemaVersion: 1,
    generation,
    entries: [
      {
        catalogId: entry.catalogId,
        packageId: entry.packageId,
        displayName: entry.displayName,
        description: entry.description,
        version: entry.version,
        manifestHash: entry.manifestHash,
        kind: entry.kind,
      },
    ],
  };
  const indexDocument = JSON.stringify(index);
  // Generation objects first, the mutable pointer last: nothing may name a
  // generation before every object in it exists.
  await env.PACKAGE_CATALOG.put(
    catalogEntryKeyV1(generation, entry.catalogId),
    JSON.stringify(entry),
  );
  await env.PACKAGE_CATALOG.put(catalogIndexKeyV1(generation), indexDocument);
  await env.PACKAGE_CATALOG.put(
    CATALOG_POINTER_KEY_V1,
    JSON.stringify({
      schemaVersion: 1,
      generation,
      indexHash: await catalogContentHashV1(indexDocument),
    }),
  );
}

async function revisionOf(userId: string): Promise<number> {
  // SAFETY: the generated stub type for `readConfiguration` is too deep for the
  // compiler to instantiate here; this names the one field the test reads.
  const rpc = user(userId) as unknown as {
    readConfiguration(input: unknown): Promise<{ revision: number }>;
  };
  return (await rpc.readConfiguration({ schemaVersion: 1, userId })).revision;
}

describe("the Skill catalog's sources in Workerd", () => {
  test("draws from the Bot's root, the managed set, and the User's installed Catalog entries — and loses the last on uninstall", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const generation = `gen-skills-${suffix}`;
    const userId = `skills-user-${suffix}`;
    const identity = { userId, botId: `skills-bot-${suffix}` };
    await seedCatalog(generation);
    await provisionBot(identity);

    const stub = bot(identity.botId);
    // The Bot's own Skill, written straight to its instruction root through the
    // production Workspace surface this object serves.
    await stub.writeWorkspaceFile({
      userId: identity.userId,
      root: {
        kind: "bot-instructions",
        userId: identity.userId,
        botId: identity.botId,
      },
      path: "skills/roster/SKILL.md",
      text: "---\nname: Own roster\ndescription: Use this when rostering.\n---\n\nOwn body.\n",
      writer: {
        kind: "bot",
        botId: identity.botId,
        sessionId: `${identity.userId}:${identity.botId}`,
        turnId: "turn-1",
        runId: "run-1",
      },
      expectedGenerationId: null,
    });

    await user(userId).executeConfiguration({
      schemaVersion: 1,
      userId,
      command: {
        schemaVersion: 1,
        type: "user/install-package",
        commandId: `install-skillful-${suffix}`,
        expectedRevision: await revisionOf(userId),
        packageId: CATALOG_PACKAGE,
        version: CATALOG_VERSION,
        catalogId: CATALOG_PACKAGE,
        catalogGeneration: generation,
      },
    });

    const installed = await stub.skillCatalogProbe(identity);

    expect(installed.skills.map((skill) => skill.path)).toEqual([
      "skills/roster/SKILL.md",
      ...MANAGED_PATHS,
      `plugin/${CATALOG_PACKAGE}/roster-check/SKILL.md`,
    ]);
    const borne = installed.skills.at(-1);
    expect(borne?.ref).toBe(`plugin/${CATALOG_PACKAGE}/roster-check`);
    // The pinned generation, not the pointer: an install fixes the bytes a Turn
    // may read, and the Skill's generation names them.
    expect(borne?.generationId).toBe(`catalog:${generation}`);
    expect(installed.refusals).toEqual([]);
    expect(installed.compositionGenerationId.length).toBeGreaterThan(0);

    await user(userId).executeConfiguration({
      schemaVersion: 1,
      userId,
      command: {
        schemaVersion: 1,
        type: "user/uninstall-package",
        commandId: `uninstall-skillful-${suffix}`,
        expectedRevision: await revisionOf(userId),
        packageId: CATALOG_PACKAGE,
      },
    });

    const uninstalled = await stub.skillCatalogProbe(identity);

    expect(uninstalled.skills.map((skill) => skill.path)).toEqual([
      "skills/roster/SKILL.md",
      ...MANAGED_PATHS,
    ]);
    // The managed bodies are the artifact's, so they did not move: the same
    // Composition is mounted and the same content hashes come back.
    expect(uninstalled.compositionGenerationId).toBe(
      installed.compositionGenerationId,
    );
    expect(
      uninstalled.skills
        .filter((skill) => skill.path.startsWith("managed/"))
        .map((skill) => skill.generationId),
    ).toEqual(
      installed.skills
        .filter((skill) => skill.path.startsWith("managed/"))
        .map((skill) => skill.generationId),
    );
    expect(uninstalled.refusals).toEqual([]);
  });
});
