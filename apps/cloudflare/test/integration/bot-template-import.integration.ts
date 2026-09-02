// Slice M, import half, end to end through `SELF.fetch`.
//
// User A builds a Bot, exports it and publishes the share as `link`. User B —
// a different account, with their own Catalog pin and their own installs —
// pastes the link, gets a review card, confirms it, and ends up with a Bot of
// their own.
//
// The four claims: the card is shown before anything is applied; the imported
// Skill is loadable on the new Bot, which is only true if its recorded writer
// is user B; the imported webhook Routine is present but disabled; and **no
// Connection was created by the import, even though the source Bot had one.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  MCP_ENDPOINT,
  MCP_GOOD_API_KEY,
  TOOL_CALL_TRIGGER,
} from "../harness/miniflare.ts";
import {
  asUser,
  expectOkJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

const SKILL_SLUG = "reconcile-ledger";
const SKILL_BODY = "IMPORTED-SKILL-BODY: open the ledger, then reconcile it.";
const ROUTINE_PROMPT = "IMPORTED-ROUTINE-PROMPT: handle the payload.";

interface ImportRecord {
  importId: string;
  botId: string;
  botName: string;
  status: string;
  skills: string[];
  routines: { slug: string; disabled: boolean }[];
  connections: { name: string; connectionTypeId?: string; url?: string }[];
  packages: { catalogId: string; status: string }[];
  steps: { key: string; status: string; failure?: string }[];
  failure?: string;
}

/** The generation ledger the Bot Durable Object keeps for its own root. */
async function skillWriters(
  userId: string,
  botId: string,
): Promise<{ kind: string; userId?: string; botId?: string }[]> {
  return runInDurableObject(
    env.BOT_STATES.get(env.BOT_STATES.idFromName(`${userId}:${botId}`)),
    async (_instance, state) => {
      const held = await state.storage.list<{
        generation?: { writer?: { kind: string; userId?: string } };
      }>({ prefix: "workspace:generation:" });
      return [...held.values()].flatMap((entry) =>
        entry.generation?.writer ? [entry.generation.writer] : [],
      );
    },
  );
}

async function buildSourceBot(userId: string, botId: string): Promise<string> {
  await provisionThroughGateway({ userId, botId });

  const written = (await expectOkJson(
    await postAsUser(userId, `/api/bots/${botId}/turns`, {
      schemaVersion: 1,
      commandId: "import-skill-write",
      text: `${TOOL_CALL_TRIGGER}skill_write:${JSON.stringify({
        name: "Reconcile ledger",
        description: "Use this when reconciling the ledger.",
        body: SKILL_BODY,
        slug: SKILL_SLUG,
      })}`,
    }),
  )) as { events: { type: string; isError?: boolean; content?: string }[] };
  const result = written.events.find((event) => event.type === "tool/result");
  expect(result?.isError, result?.content).toBe(false);

  await expectOkJson(
    await postAsUser(userId, `/api/bots/${botId}/routines`, {
      schemaVersion: 1,
      type: "routine/create",
      commandId: "import-routine-1",
      botId,
      name: "On delivery",
      prompt: ROUTINE_PROMPT,
      trigger: { kind: "webhook" },
      timezone: "Australia/Sydney",
    }),
  );

  // A keyed MCP Connection, so the template carries a placeholder.
  const settings = (await expectOkJson(
    await asUser(userId, "/api/settings"),
  )) as { revision: number };
  await expectOkJson(
    await postAsUser(userId, "/api/settings", {
      schemaVersion: 1,
      type: "user/install-package",
      commandId: "import-install-mcp",
      expectedRevision: settings.revision,
      packageId: "mcp",
      version: "0.0.1",
    }),
  );
  await expectOkJson(
    await postAsUser(userId, "/api/connections", {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: "import-connect-mcp",
      packageId: "mcp",
      connectionTypeId: "mcp-remote-key",
      label: "Example connector",
      apiKey: MCP_GOOD_API_KEY,
      settings: { url: MCP_ENDPOINT, transport: "streamable-http" },
    }),
  );

  const staged = (await expectOkJson(
    await postAsUser(userId, "/api/bot-templates", {
      schemaVersion: 1,
      type: "template/stage",
      commandId: "import-stage-1",
      botId,
    }),
  )) as { share: { shareId: string } };
  await expectOkJson(
    await postAsUser(userId, "/api/bot-templates", {
      schemaVersion: 1,
      type: "template/set-visibility",
      commandId: "import-visibility-1",
      shareId: staged.share.shareId,
      visibility: "link",
    }),
  );
  return staged.share.shareId;
}

describe("importing another User's Bot template", () => {
  it("reviews, confirms, and creates a Bot with no borrowed authority", async () => {
    const ownerId = freshUserId("tpl-owner");
    const importerId = freshUserId("tpl-importer");
    const shareId = await buildSourceBot(ownerId, "tpl-source-bot");
    // User B is a real, separately provisioned account.
    await provisionThroughGateway({
      userId: importerId,
      botId: "tpl-importer-home",
    });

    // THE REVIEW CARD. Planning is a read.
    const planned = (await expectOkJson(
      await postAsUser(importerId, "/api/bot-template-imports", {
        schemaVersion: 1,
        type: "template/plan-import",
        commandId: "plan-1",
        shareId,
      }),
    )) as ImportRecord;
    expect(planned.status).toBe("planned");
    expect(planned.skills).toEqual([SKILL_SLUG]);
    expect(planned.routines).toEqual([{ slug: "on-delivery", disabled: true }]);
    // The keyed server the source had is a line telling user B to connect it.
    expect(planned.connections).toEqual([
      {
        name: "Example connector",
        connectionTypeId: "mcp-remote-key",
        hint: "This server needs your own Connection and credential.",
      },
    ]);
    expect(planned.steps.every((step) => step.status === "pending")).toBe(true);

    // Nothing applied yet: the Bot the card names does not exist.
    const beforeConfirm = (await expectOkJson(
      await asUser(importerId, "/api/bots"),
    )) as { bots: { botId: string }[] };
    expect(beforeConfirm.bots.some((bot) => bot.botId === planned.botId)).toBe(
      false,
    );

    // THE CONFIRMATION.
    const applied = (await expectOkJson(
      await postAsUser(importerId, "/api/bot-template-imports", {
        schemaVersion: 1,
        type: "template/apply-import",
        commandId: "apply-1",
        importId: planned.importId,
      }),
    )) as ImportRecord;
    expect(applied.failure, JSON.stringify(applied.steps)).toBeUndefined();
    expect(applied.status).toBe("applied");

    // The Bot exists, and it is user B's.
    const afterConfirm = (await expectOkJson(
      await asUser(importerId, "/api/bots"),
    )) as { bots: { botId: string }[] };
    expect(
      afterConfirm.bots.filter((bot) => bot.botId === planned.botId),
    ).toHaveLength(1);

    // THE SKILL IS LOADABLE, which is only true of a writer this Bot's own
    // authority admits — and the ledger says which one.
    const catalog = (await expectOkJson(
      await asUser(importerId, `/api/bots/${planned.botId}/skills`),
    )) as { skills: { ref: string }[] };
    expect(catalog.skills.map((entry) => entry.ref)).toContain(
      `bot/${SKILL_SLUG}`,
    );
    const writers = await skillWriters(importerId, planned.botId);
    expect(writers).toContainEqual({ kind: "user", userId: importerId });
    expect(writers.some((entry) => entry.userId === ownerId)).toBe(false);

    // THE ROUTINE IS PRESENT AND DISABLED, with its prose intact and no key.
    const routines = (await expectOkJson(
      await asUser(importerId, `/api/bots/${planned.botId}/routines`),
    )) as {
      routines: {
        prompt: string;
        enabled: boolean;
        trigger?: { kind: string };
        createdBy: { kind: string };
      }[];
    };
    expect(routines.routines).toHaveLength(1);
    expect(routines.routines[0]).toMatchObject({
      prompt: ROUTINE_PROMPT,
      enabled: false,
      trigger: { kind: "webhook" },
      createdBy: { kind: "user" },
    });
    expect(JSON.stringify(routines)).not.toContain(MCP_GOOD_API_KEY);

    // NO CONNECTION. User B's account gained none even though the source Bot
    // had one.
    const importerSettings = (await expectOkJson(
      await asUser(importerId, "/api/settings"),
    )) as { connections: { connectionTypeId: string }[] };
    expect(
      importerSettings.connections.some(
        (connection) => connection.connectionTypeId === "mcp-remote-key",
      ),
    ).toBe(false);
    expect(JSON.stringify(importerSettings)).not.toContain(MCP_GOOD_API_KEY);

    const importedSettings = (await expectOkJson(
      await asUser(importerId, `/api/bots/${planned.botId}/settings`),
    )) as Record<string, unknown>;
    expect(importedSettings).not.toHaveProperty("connections");

    // REPLAY. Confirming again is a read: no second Bot, no second Routine.
    await expectOkJson(
      await postAsUser(importerId, "/api/bot-template-imports", {
        schemaVersion: 1,
        type: "template/apply-import",
        commandId: "apply-2",
        importId: planned.importId,
      }),
    );
    const replayed = (await expectOkJson(
      await asUser(importerId, "/api/bots"),
    )) as { bots: { botId: string }[] };
    expect(
      replayed.bots.filter((bot) => bot.botId === planned.botId),
    ).toHaveLength(1);
    const replayedRoutines = (await expectOkJson(
      await asUser(importerId, `/api/bots/${planned.botId}/routines`),
    )) as { routines: unknown[] };
    expect(replayedRoutines.routines).toHaveLength(1);
  });
});
