// The disposable cleanup a User whose Applets predate Bot ownership runs when
// its User Durable Object is next loaded (ADR 0027).
//
// The release requires it: a directory entry with no `ownerBotId` names nobody
// who may change it, and a Composition generation whose Applet members carry
// no access cannot be pinned. Such a User must come back with the entry gone
// and its state queued for cleanup, the pin moved to a generation holding the
// same Plugins and no Applets, and a fresh conversation working. Only an
// evicted object can make that claim, because the cleanup runs once, in the
// constructor, before any request or alarm can read the old records.
import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { expect, test, vi } from "vitest";
import {
  appletStateNameV1,
  compositionArtifactSetHashV1,
  compositionGenerationIdV1,
  decodeCompositionGenerationV1,
  type CompositionMemberV1,
} from "@frockbot/core/durable";
import { provisionBot } from "./provision-bot.ts";

const RECEIPT_KEY = "maintenance:bot-owned-applets:2026-09-14";

interface Receipt {
  at: string;
  removedApplets: number;
  removedGenerations: number;
  replacement?: string;
}

test("a User with old-shape Applets drops them, keeps its Plugins, and converses again", async () => {
  const suffix = crypto.randomUUID();
  const identity = {
    schemaVersion: 1 as const,
    userId: `applet-cleanup-user-${suffix}`,
    botId: `applet-cleanup-bot-${suffix}`,
  };
  await provisionBot(identity);
  const { userId } = identity;
  await (
    env.USER_CONFIGURATIONS.getByName(userId) as unknown as {
      setFeatures(input: unknown): Promise<unknown>;
    }
  ).setFeatures({
    schemaVersion: 1,
    userId,
    command: { schemaVersion: 1, type: "user/set-features", applets: true },
    updatedBy: "workerd-admin",
  });
  const sessionId = `${userId}:${identity.botId}`;
  const bot = env.BOT_STATES.getByName(sessionId);

  // The conversation this User already had, which is what pins a generation.
  const before = await bot.run({
    ...identity,
    command: {
      runId: `run-before-${suffix}`,
      sessionId,
      acceptedAt: "2026-09-01T00:00:00.000Z",
      text: "hello",
    },
  });
  expect(before.text).toBe("Ollama reply");

  const userStub = env.USER_CONFIGURATIONS.getByName(userId);
  // Old Applets were minted with the same 32-hex secret as current Applets;
  // only their directory and Composition records lacked Bot ownership.
  const legacyApplet = `${userId}.${"a".repeat(32)}`;
  const legacyCreatedAt = "2026-09-02T00:00:00.000Z";

  // The User as the deployment finds it: an Applet entry and a pinned
  // Composition generation written before Applets had an owner Bot. The
  // receipt goes with them, because this User was last written by the build
  // that had never heard of the cleanup.
  const seeded = await runInDurableObject(
    userStub,
    async (_instance, state) => {
      const pin = await state.storage.get<{ generationId: string }>(
        "composition:current",
      );
      expect(pin).toBeDefined();
      const current = await state.storage.get<
        Record<string, unknown> & { members: CompositionMemberV1[] }
      >(`composition:generation:${pin!.generationId}`);
      expect(current).toBeDefined();
      const members = current!.members;
      const artifactSetHash = await compositionArtifactSetHashV1(members);
      const legacyId = compositionGenerationIdV1(
        legacyCreatedAt,
        artifactSetHash,
      );
      const legacyGeneration: Record<string, unknown> = {
        ...current,
        generationId: legacyId,
        artifactSetHash,
        parentGenerationId: pin!.generationId,
        createdAt: legacyCreatedAt,
        status: "active",
        // The old member shape: no `ownerBotId`, no `sharedWithBotIds`.
        applets: [
          {
            kind: "applet",
            appletId: legacyApplet,
            generationId: "legacy-g1",
            tools: [
              {
                name: "legacy_tool",
                description: "A tool from before Bot ownership",
                inputSchema: { type: "object" },
              },
            ],
            provenance: {
              kind: "user",
              packageId: "applets",
              version: "0.0.1",
              userId,
              authoredAt: legacyCreatedAt,
            },
          },
        ],
      };
      delete legacyGeneration.summary;
      await state.storage.put({
        // The old entry shape: no `ownerBotId`, `sharedWithBotIds` or
        // `available`.
        [`applets:entry:${legacyApplet}`]: {
          schemaVersion: 1,
          appletId: legacyApplet,
          displayName: "Old tracker",
          currentGenerationId: "legacy-g1",
          tools: [
            {
              name: "legacy_tool",
              description: "A tool from before Bot ownership",
              inputSchema: { type: "object" },
            },
          ],
          provenance: { kind: "user" },
          createdAt: legacyCreatedAt,
          status: "published",
        },
        [`composition:generation:${legacyId}`]: legacyGeneration,
        [`composition:index:${legacyCreatedAt}:${legacyId}`]: legacyId,
        "composition:current": { generationId: legacyId, artifactSetHash },
        "composition:last-known-good": legacyId,
      });
      await state.storage.delete(RECEIPT_KEY);
      return { legacyId, members };
    },
  );

  // The Applet's own state, so its cleanup is observable.
  const appletState = env.APPLET_STATES.get(
    env.APPLET_STATES.idFromName(appletStateNameV1(userId, legacyApplet)),
  );
  await runInDurableObject(appletState, async (_instance, state) => {
    await state.storage.put("probe", "the old Applet's data");
  });

  await evictDurableObject(userStub);

  const after = await runInDurableObject(
    userStub,
    async (_instance, state) => ({
      entry: await state.storage.get(`applets:entry:${legacyApplet}`),
      receipt: await state.storage.get<Receipt>(RECEIPT_KEY),
      legacyGeneration: await state.storage.get(
        `composition:generation:${seeded.legacyId}`,
      ),
      legacyIndex: await state.storage.get(
        `composition:index:${legacyCreatedAt}:${seeded.legacyId}`,
      ),
      pin: await state.storage.get<{
        generationId: string;
        artifactSetHash: string;
      }>("composition:current"),
      lastKnownGood: await state.storage.get<string>(
        "composition:last-known-good",
      ),
    }),
  );
  expect(after.entry).toBeUndefined();
  expect(after.receipt).toMatchObject({
    removedApplets: 1,
    removedGenerations: 1,
    replacement: expect.any(String),
  });
  expect(after.legacyGeneration).toBeUndefined();
  expect(after.legacyIndex).toBeUndefined();
  // The pin and the fallback moved together, to the replacement.
  expect(after.pin?.generationId).toBe(after.receipt?.replacement);
  expect(after.pin?.generationId).not.toBe(seeded.legacyId);
  expect(after.lastKnownGood).toBe(after.receipt?.replacement);

  // The replacement decodes, holds the same Plugins, and no Applets: the next
  // Turn resolves Applets from the directory again.
  const replacement = await runInDurableObject(
    userStub,
    async (_instance, state) =>
      state.storage.get(`composition:generation:${after.pin!.generationId}`),
  );
  const decoded = decodeCompositionGenerationV1(replacement);
  expect(decoded.members).toEqual(seeded.members);
  expect(decoded.applets).toBeUndefined();
  expect(decoded.artifactSetHash).toBe(after.pin?.artifactSetHash);

  // The entry's state is queued for the same cleanup a deletion uses, and the
  // alarm the constructor armed drains it.
  await vi.waitFor(
    async () => {
      await runDurableObjectAlarm(userStub);
      expect(
        await runInDurableObject(userStub, async (_instance, state) => [
          ...(await state.storage.list({ prefix: "applets:cleanup:" })).keys(),
        ]),
      ).toEqual([]);
    },
    { timeout: 10_000, interval: 100 },
  );
  expect(
    await runInDurableObject(
      appletState,
      async (_instance, state) => (await state.storage.list()).size,
    ),
  ).toBe(0);

  // The conversation itself is not the disposable part, and a fresh one works.
  const reply = await bot.run({
    ...identity,
    command: {
      runId: `run-fresh-${suffix}`,
      sessionId,
      acceptedAt: "2026-09-14T00:00:00.000Z",
      text: "hello again",
    },
  });
  expect(reply.text).toBe("Ollama reply");
  expect(
    (
      await (
        userStub as unknown as {
          listApplets(input: unknown): Promise<{ applets: unknown[] }>;
        }
      ).listApplets({ schemaVersion: 1, userId, botId: identity.botId })
    ).applets,
  ).toEqual([]);

  // The cleanup is once, not on every load: a record of the old shape written
  // after the receipt survives the next eviction untouched.
  const straggler = `${userId}.straggler`;
  await runInDurableObject(userStub, async (_instance, state) => {
    await state.storage.put(`applets:entry:${straggler}`, {
      schemaVersion: 1,
      appletId: straggler,
      displayName: "Straggler",
      tools: [],
      provenance: { kind: "user" },
      createdAt: legacyCreatedAt,
      status: "draft",
    });
  });
  await evictDurableObject(userStub);
  expect(
    await runInDurableObject(userStub, async (_instance, state) => ({
      receipt: await state.storage.get<Receipt>(RECEIPT_KEY),
      straggler: await state.storage.get(`applets:entry:${straggler}`),
      cleanup: await state.storage.get(`applets:cleanup:${straggler}`),
    })),
  ).toEqual({
    receipt: after.receipt,
    straggler: expect.objectContaining({ appletId: straggler }),
    cleanup: undefined,
  });
});
