// Slice K2 end to end: the managed and plugin-borne Skill sources, through the
// gateway a browser talks to.
//
// One User, one Bot, four claims, every one read back out of what the Bot
// durably recorded for the Turn:
//
//  1. The managed Skills — first-party, compiled into the Skills Package's
//     artifact — are in the injected catalog, under the Composition the Turn
//     pinned, with no Workspace file behind them.
//  2. A Catalog entry the User installs contributes its Skills as
//     `plugin/<packageId>/<slug>`, indexed at the pinned generation and never
//     copied into any instruction root.
//  3. Uninstalling that entry removes its Skills from the *next* Turn. Nothing
//     is deleted, because nothing was written.
//  4. Invoking a managed Skill by ref expands its body into the Turn's first
//     step, exactly as invoking a Bot's own Skill does.
//
// Every request crosses `SELF.fetch` into the deployed Worker. The only thing
// seeded behind the gateway is the Catalog generation itself, which is a
// publisher's act, not the product's.
import {
  catalogContentHashV1,
  catalogEntryKeyV1,
  catalogIndexKeyV1,
  CATALOG_POINTER_KEY_V1,
} from "@frockbot/catalog-core";
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  asUser,
  expectOkJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  readStoredRunWithEventsV1,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

const GENERATION = "gen-skills-1";
const CATALOG_PACKAGE = "skillful";
const CATALOG_VERSION = "0.0.1";
const MANIFEST_HASH = "d".repeat(64);
const PLUGIN_SLUG = "roster-check";
const PLUGIN_REF = `plugin/${CATALOG_PACKAGE}/${PLUGIN_SLUG}`;
const PLUGIN_BODY = "PLUGIN-SKILL-BODY: read the roster before the standup.";
const MANAGED_REF = "managed/add-connector";
/** A line only the managed `add-connector` body carries. */
const MANAGED_BODY_MARKER = "Install it and switch it on";

const ENTRY = {
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
      body: PLUGIN_BODY,
    },
  ],
};

const INDEX = {
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
};

beforeAll(async () => {
  const indexDocument = JSON.stringify(INDEX);
  // Generation objects first, the mutable pointer last: nothing may name a
  // generation before every object in it exists.
  await env.PACKAGE_CATALOG.put(
    catalogEntryKeyV1(GENERATION, ENTRY.catalogId),
    JSON.stringify(ENTRY),
  );
  await env.PACKAGE_CATALOG.put(catalogIndexKeyV1(GENERATION), indexDocument);
  await env.PACKAGE_CATALOG.put(
    CATALOG_POINTER_KEY_V1,
    JSON.stringify({
      schemaVersion: 1,
      generation: GENERATION,
      indexHash: await catalogContentHashV1(indexDocument),
    }),
  );
});

interface StoredRun {}

/** The session events the Bot Durable Object durably recorded for one run. */
async function runEvents(
  userId: string,
  botId: string,
  runId: string,
): Promise<Array<Record<string, unknown>>> {
  const run = await readStoredRunWithEventsV1<StoredRun>(userId, botId, runId);
  return (run?.events ?? []) as unknown as Array<Record<string, unknown>>;
}

function systemPromptOfStep(
  events: Array<Record<string, unknown>>,
  step: number,
): string {
  const request = events.find(
    (event) => event.type === "model/request" && event.step === step,
  ) as { request?: { system?: string } } | undefined;
  return request?.request?.system ?? "";
}

async function currentRevision(userId: string): Promise<number> {
  return (
    (await expectOkJson(await asUser(userId, "/api/settings"))) as {
      revision: number;
    }
  ).revision;
}

async function turn(
  userId: string,
  botId: string,
  commandId: string,
  body: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  const response = await postAsUser(userId, `/api/bots/${botId}/turns`, {
    schemaVersion: 1,
    commandId,
    ...body,
  });
  expect({
    status: response.status,
    body: await response.text(),
  }).toMatchObject({ status: 200 });
  return runEvents(userId, botId, commandId);
}

describe("the managed and plugin-borne Skill sources", () => {
  it("injects both under the pinned Composition, drops the plugin ones on uninstall, and expands an invoked managed body", async () => {
    const userId = freshUserId("skill-sources");
    const botId = "skill-sources-bot";
    await provisionThroughGateway({ userId, botId });

    await expectOkJson(
      await postAsUser(userId, "/api/settings", {
        schemaVersion: 1,
        type: "user/install-package",
        commandId: "install-skillful",
        expectedRevision: await currentRevision(userId),
        packageId: CATALOG_PACKAGE,
        version: CATALOG_VERSION,
        catalogId: CATALOG_PACKAGE,
        catalogGeneration: GENERATION,
      }),
    );

    const installed = await turn(userId, botId, "skills-turn-1", {
      text: "What Skills do you have?",
    });

    const system = systemPromptOfStep(installed, 1);
    expect(system).toContain("<agent_skills>");
    // The plugin-borne Skill, named by its qualified ref.
    expect(system).toContain(PLUGIN_REF);
    expect(system).toContain('source="plugin"');
    expect(system).toContain("Use this when checking the roster.");
    // Progressive disclosure holds for a plugin Skill too: the catalog is the
    // description, never the body.
    expect(system).not.toContain(PLUGIN_BODY);
    // The managed set, first-party and read-only.
    expect(system).toContain(MANAGED_REF);
    expect(system).toContain('source="managed"');

    // The catalog is injected under the Composition this Turn pinned: both
    // records are in the same Turn's durable log.
    const pinned = installed.find(
      (event) => event.type === "composition/pinned",
    );
    const injected = installed.find(
      (event) => event.type === "skill/injected",
    ) as
      | {
          turn?: number;
          skills?: Array<{ path: string; generationId: string }>;
        }
      | undefined;
    expect(pinned).toMatchObject({ turn: 1 });
    expect(injected).toMatchObject({ turn: 1 });
    expect(injected?.skills?.map((skill) => skill.path)).toEqual([
      "managed/add-connector/SKILL.md",
      "managed/applets/SKILL.md",
      "managed/export-bot-template/SKILL.md",
      "managed/import-bot-template/SKILL.md",
      "managed/learn-from-demonstration/SKILL.md",
      `plugin/${CATALOG_PACKAGE}/${PLUGIN_SLUG}/SKILL.md`,
    ]);
    // The plugin Skill's generation names the pinned Catalog generation, so
    // the exact bytes the Turn read are reconstructable.
    expect(injected?.skills?.at(-1)?.generationId).toBe(
      `catalog:${GENERATION}`,
    );

    // The composer's popover sees the same catalog, refs and all, never a body.
    const popover = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/skills`),
    )) as { skills: Array<{ ref: string }> };
    expect(popover.skills.map((entry) => entry.ref)).toContain(PLUGIN_REF);
    expect(popover.skills.map((entry) => entry.ref)).toContain(MANAGED_REF);
    expect(JSON.stringify(popover)).not.toContain(PLUGIN_BODY);

    // Invoking a managed Skill expands its body into step 1, exactly as
    // invoking a Bot's own does.
    const invoked = await turn(userId, botId, "skills-turn-invoke", {
      text: "Connect me to something.",
      skills: [{ schemaVersion: 1, source: "managed", slug: "add-connector" }],
    });
    const invokedSystem = systemPromptOfStep(invoked, 1);
    expect(invokedSystem).toContain("<invoked_skills>");
    expect(invokedSystem).toContain(MANAGED_BODY_MARKER);
    expect(
      invoked.find((event) => event.type === "skill/invoked"),
    ).toMatchObject({
      ref: { schemaVersion: 1, source: "managed", slug: "add-connector" },
    });

    // Uninstalling removes the entry's Skills from the next Turn. Nothing was
    // written, so nothing is deleted — the index simply has nothing to read.
    await expectOkJson(
      await postAsUser(userId, "/api/settings", {
        schemaVersion: 1,
        type: "user/uninstall-package",
        commandId: "uninstall-skillful",
        expectedRevision: await currentRevision(userId),
        packageId: CATALOG_PACKAGE,
      }),
    );

    const afterUninstall = await turn(userId, botId, "skills-turn-2", {
      text: "What Skills do you have now?",
    });
    const laterSystem = systemPromptOfStep(afterUninstall, 1);
    expect(laterSystem).not.toContain(PLUGIN_REF);
    expect(laterSystem).toContain(MANAGED_REF);
  });
});
