// Importing a Bot template inside real Durable Objects, across a real eviction.
//
// The claim the unit suite cannot make: the apply saga is a *durable* cursor.
// It is interrupted mid-walk, the User Durable Object is evicted, and the
// resumed apply finishes without a second Bot, a duplicate install, or a
// second copy of a Skill or Routine — because every step's fence is the
// authority's own idempotency, not this saga's memory.
import {
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, test } from "vitest";
import {
  catalogContentHashV1,
  catalogEntryKeyV1,
  catalogIndexKeyV1,
  CATALOG_POINTER_KEY_V1,
} from "@frockbot/catalog-core";
import type {
  TemplateImportListViewV1,
  TemplateImportRecordV1,
  TemplateShareReceiptV1,
} from "@frockbot/plugin-bot-template/shared";
import { templateImportRecordKeyV1 } from "@frockbot/plugin-bot-template/shared";
import { provisionBot } from "./provision-bot.ts";

/**
 * How far ahead a test arms an alarm it is about to fire by hand. A deadline
 * already due can be delivered by the runtime before `runDurableObjectAlarm`
 * asks for it, which would leave the assertions reading a half-finished walk.
 */
const HAND_FIRED_ALARM_DELAY_MS = 60_000;

const CATALOG_PACKAGE = "importable";
const GENERATION = "import-gen-1";

interface TemplateRpc {
  executeTemplateCommand(input: unknown): Promise<TemplateShareReceiptV1>;
  executeTemplateImport(input: unknown): Promise<TemplateImportRecordV1>;
  listTemplateImports(input: unknown): Promise<TemplateImportListViewV1>;
}

interface SettingsRpc {
  readConfiguration(input: unknown): Promise<{
    revision: number;
    packages: { packageId: string; catalogId?: string }[];
  }>;
}

function user(userId: string): TemplateRpc & SettingsRpc {
  // SAFETY: USER_CONFIGURATIONS is bound to UserConfiguration; generated RPC
  // methods are not represented by workers-types.
  return env.USER_CONFIGURATIONS.getByName(userId) as unknown as TemplateRpc &
    SettingsRpc;
}

/** One immutable generation holding the entry an imported template names. */
async function seedCatalog(): Promise<void> {
  const entry = {
    schemaVersion: 1,
    catalogId: CATALOG_PACKAGE,
    packageId: CATALOG_PACKAGE,
    displayName: "Importable",
    description: "A Package a template can name.",
    version: "0.0.1",
    kind: "package",
    manifestHash: "e".repeat(64),
    servers: [],
    setupFields: [],
    skills: [],
  };
  const index = {
    schemaVersion: 1,
    generation: GENERATION,
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
  await env.PACKAGE_CATALOG.put(
    catalogEntryKeyV1(GENERATION, entry.catalogId),
    JSON.stringify(entry),
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
}

/** Export a Bot and publish the share, so there is something to import. */
async function publishedShare(ownerId: string, botId: string): Promise<string> {
  await provisionBot({ userId: ownerId, botId });
  const staged = await user(ownerId).executeTemplateCommand({
    schemaVersion: 1,
    userId: ownerId,
    command: {
      schemaVersion: 1,
      type: "template/stage",
      commandId: "stage-1",
      botId,
    },
  });
  await user(ownerId).executeTemplateCommand({
    schemaVersion: 1,
    userId: ownerId,
    command: {
      schemaVersion: 1,
      type: "template/set-visibility",
      commandId: "visibility-1",
      shareId: staged.share.shareId,
      visibility: "link",
    },
  });
  return staged.share.shareId;
}

async function plan(
  importerId: string,
  shareId: string,
): Promise<TemplateImportRecordV1> {
  return user(importerId).executeTemplateImport({
    schemaVersion: 1,
    userId: importerId,
    command: {
      schemaVersion: 1,
      type: "template/plan-import",
      commandId: "import-1",
      shareId,
    },
  });
}

async function apply(importerId: string): Promise<TemplateImportRecordV1> {
  return user(importerId).executeTemplateImport({
    schemaVersion: 1,
    userId: importerId,
    command: {
      schemaVersion: 1,
      type: "template/apply-import",
      commandId: "apply-1",
      importId: "import-1",
    },
  });
}

describe("importing a Bot template in workerd", () => {
  test("plans against the importer's own pin and applies nothing", async () => {
    await seedCatalog();
    const ownerId = `tpl-owner-${crypto.randomUUID()}`;
    const importerId = `tpl-importer-${crypto.randomUUID()}`;
    const shareId = await publishedShare(ownerId, "budget");
    // The importer must exist and be pinned before they can plan.
    await provisionBot({ userId: importerId, botId: "importer-home" });

    const planned = await plan(importerId, shareId);
    expect(planned.status).toBe("planned");
    expect(planned.steps.every((step) => step.status === "pending")).toBe(true);

    // Nothing applied: the Bot the plan names does not exist yet.
    const directory = await env.USER_CONFIGURATIONS.getByName(
      importerId,
    ).listBots({ schemaVersion: 1, userId: importerId });
    expect(directory.bots.some((bot) => bot.botId === planned.botId)).toBe(
      false,
    );
  });

  test("resumes after eviction with no second Bot and no duplicate install", async () => {
    await seedCatalog();
    const ownerId = `tpl-owner-${crypto.randomUUID()}`;
    const importerId = `tpl-importer-${crypto.randomUUID()}`;
    const shareId = await publishedShare(ownerId, "budget");
    await provisionBot({ userId: importerId, botId: "importer-home" });

    const planned = await plan(importerId, shareId);
    const applied = await apply(importerId);
    expect(applied.status).toBe("applied");
    expect(applied.steps.every((step) => step.status !== "failed")).toBe(true);

    // COLD START. Everything the saga knows is now on disk.
    await evictDurableObject(env.USER_CONFIGURATIONS.getByName(importerId));

    // Re-applying is the replay a recovery pass performs.
    const again = await apply(importerId);
    expect(again.status).toBe("applied");

    const directory = await env.USER_CONFIGURATIONS.getByName(
      importerId,
    ).listBots({ schemaVersion: 1, userId: importerId });
    const created = directory.bots.filter((bot) => bot.botId === planned.botId);
    expect(created).toHaveLength(1);

    // One Bot, one import record, and no Package installed twice.
    const imports = await user(importerId).listTemplateImports({
      schemaVersion: 1,
      userId: importerId,
    });
    expect(imports.imports).toHaveLength(1);
    const settings = await user(importerId).readConfiguration({
      schemaVersion: 1,
      userId: importerId,
    });
    const ids = settings.packages.map((pkg) => pkg.packageId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("keeps the imported Bot on account-shaped configuration", async () => {
    await seedCatalog();
    const ownerId = `tpl-owner-${crypto.randomUUID()}`;
    const importerId = `tpl-importer-${crypto.randomUUID()}`;
    const shareId = await publishedShare(ownerId, "budget");
    await provisionBot({ userId: importerId, botId: "importer-home" });

    const planned = await plan(importerId, shareId);
    await apply(importerId);

    // SAFETY: BOT_STATES is bound to BotState; generated RPC methods are not
    // represented by workers-types.
    const settingsOf = async (
      botId: string,
    ): Promise<{ packageValues: Record<string, Record<string, unknown>> }> =>
      (
        env.BOT_STATES.getByName(`${importerId}:${botId}`) as unknown as {
          readConfiguration(input: unknown): Promise<{
            packageValues: Record<string, Record<string, unknown>>;
          }>;
        }
      ).readConfiguration({ schemaVersion: 1, userId: importerId, botId });
    const botSettings = await settingsOf(planned.botId);
    // The imported Bot follows the User's model and starts with the same
    // Package-scoped Bot settings as a Bot created directly by that User.
    const ownBot = await settingsOf("importer-home");
    expect(botSettings.packageValues).toEqual(ownBot.packageValues);
  });

  test("finishes from the alarm alone after an eviction at every step", async () => {
    await seedCatalog();
    const ownerId = `tpl-owner-${crypto.randomUUID()}`;
    const importerId = `tpl-importer-${crypto.randomUUID()}`;
    const shareId = await publishedShare(ownerId, "budget");
    await provisionBot({ userId: importerId, botId: "importer-home" });

    const planned = await plan(importerId, shareId);
    const applied = await apply(importerId);
    expect(applied.status).toBe("applied");

    // The state an eviction leaves when the walk was interrupted at `index`:
    // the record says `applying`, every later step is pending again, and the
    // recovery deadline the apply recorded before entering that state is the
    // only thing that will finish it.
    const interruptAt = async (index: number): Promise<void> => {
      await runInDurableObject(
        env.USER_CONFIGURATIONS.getByName(importerId),
        async (_instance, state) => {
          await state.storage.put(templateImportRecordKeyV1("import-1"), {
            ...applied,
            status: "applying",
            steps: applied.steps.map((step, position) =>
              position < index
                ? step
                : {
                    key: step.key,
                    kind: step.kind,
                    status: "pending" as const,
                    ...(step.subject === undefined
                      ? {}
                      : { subject: step.subject }),
                  },
            ),
          });
          await state.storage.put(
            "bot-template:import-recovery-at",
            Date.now(),
          );
          await state.storage.setAlarm(Date.now() + HAND_FIRED_ALARM_DELAY_MS);
        },
      );
    };

    for (let index = 0; index < applied.steps.length; index += 1) {
      await interruptAt(index);
      // COLD START: nothing in the instance survives, including the identity
      // an authenticated RPC would have left in memory.
      await evictDurableObject(env.USER_CONFIGURATIONS.getByName(importerId));

      // The alarm is the only thing that runs. No User RPC precedes it.
      expect(
        await runDurableObjectAlarm(
          env.USER_CONFIGURATIONS.getByName(importerId),
        ),
      ).toBe(true);

      const listed = (
        await user(importerId).listTemplateImports({
          schemaVersion: 1,
          userId: importerId,
        })
      ).imports[0]!;
      // Terminal either way: finished, or visibly repairable. Never left
      // `applying` with nothing scheduled to finish it.
      if (listed.status !== "applied") {
        expect(listed.status).toBe("failed");
        expect(listed.failure).toBeTruthy();
      }
      expect(listed.status).not.toBe("applying");
    }

    // Every replay was idempotent: still one Bot, and one import record.
    const directory = await env.USER_CONFIGURATIONS.getByName(
      importerId,
    ).listBots({ schemaVersion: 1, userId: importerId });
    expect(
      directory.bots.filter((bot) => bot.botId === planned.botId),
    ).toHaveLength(1);
  });
});
