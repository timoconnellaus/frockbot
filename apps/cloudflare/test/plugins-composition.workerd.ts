// The User owns the Composition; a Bot mirrors it before admission (ADR 0026).
//
// Two claims against the real User and Bot Durable Objects: a generation the
// User pins is what the next admitted Turn on any of that User's Bots runs
// under — whichever way that Turn is admitted, a chat Turn or a Routine
// firing — and the outcome of that activation lands on the User's record, not
// the Bot's.
import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { provisionBot, provisionSiblingBot } from "./provision-bot.ts";
import { hydratedStoredRunsV1 } from "./session-log-probe.ts";
import { toolCallTriggerPrompt } from "./harness/miniflare.ts";
import { dynamicToolInputV1 } from "./dynamic-tools.ts";
import { decodePluginDescriptorV1 } from "@frockbot/core/contracts";
import {
  compositionArtifactSetHashV1,
  compositionGenerationIdV1,
  type CompositionMemberV1,
} from "@frockbot/core/durable";

/**
 * A Plugin that exercises the loopback capabilities from inside a real Turn:
 * its storage round-trips a value, its settings read what the Bot holds, and
 * `capabilities.list()` reports the Bot's authority — all through the Bot
 * Durable Object, which is what the per-User stub routes to.
 */
const STORE_PLUGIN_ID = "probe-store";
const STORE_PLUGIN_SOURCE = `
export const tools = [
  { name: "store_roundtrip", description: "Writes, lists and reads a value", inputSchema: { type: "object" }, idempotent: false },
];
export async function execute(tool, input, ctx) {
  if (tool !== "store_roundtrip") return "unknown tool";
  const put = await ctx.storage.put({ key: "greeting", value: { word: input.word } });
  const got = await ctx.storage.get({ key: "greeting" });
  const missing = await ctx.storage.get({ key: "absent" });
  const listed = await ctx.storage.list({});
  const settings = await ctx.settings.read();
  const authority = await ctx.capabilities.list();
  return JSON.stringify({
    put: put.status,
    got: got.value,
    missing: missing.value,
    keys: listed.status === "available" ? listed.entries.map((entry) => entry.key) : listed,
    settings: settings.status === "available" ? settings.values : settings,
    authority: authority.status,
    connections: authority.status === "available" ? authority.connections.length : -1,
    bot: ctx.bot.botId,
    user: ctx.user.userId,
  });
}
`;
const STORE_PLUGIN_DESCRIPTOR = decodePluginDescriptorV1({
  id: STORE_PLUGIN_ID,
  displayName: "Probe store",
  version: "0.0.1",
  contractVersion: 4,
  tools: [
    {
      name: "store_roundtrip",
      description: "Writes, lists and reads a value",
      inputSchema: { type: "object" },
    },
  ],
  hooks: [],
  grants: ["storage"],
  contextKeys: ["user", "bot", "session"],
});

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

interface CompositionRpc {
  readComposition(input: unknown): Promise<{
    current: {
      generationId: string;
      status: string;
      createdAt: string;
      artifactSetHash: string;
      members: unknown[];
    };
    lastKnownGood: { generationId: string };
  }>;
  readCompositionGeneration(
    input: unknown,
  ): Promise<{ generationId: string; status: string } | undefined>;
  proposeComposition(input: unknown): Promise<void>;
  listCompositionGenerations(
    input: unknown,
  ): Promise<{ generations: { generationId: string; status: string }[] }>;
  setFeatures(input: unknown): Promise<unknown>;
  createApplet(input: unknown): Promise<{ appletId: string }>;
  recordAppletGeneration(input: unknown): Promise<{ appletId: string }>;
}

interface BotRpc {
  run(command: unknown): Promise<{ runId: string }>;
  listCompositionGenerations(input: unknown): Promise<{
    botId: string;
    currentGenerationId: string;
    generations: { generationId: string; isCurrent: boolean }[];
  }>;
  executeRoutineCommand(input: unknown): Promise<{ status: string }>;
  readPluginEnablement(input: unknown): Promise<{ revision: number }>;
  setPluginEnabled(input: unknown): Promise<
    | {
        status: "applied";
        enablement: { revision: number; enabled: Record<string, boolean> };
      }
    | { status: "conflict"; currentRevision: number }
  >;
}

function user(userId: string): CompositionRpc {
  // SAFETY: the generated stub type is too deep to instantiate here; this
  // names only the methods the test calls.
  return env.USER_CONFIGURATIONS.getByName(userId) as unknown as CompositionRpc;
}

function bot(identity: { userId: string; botId: string }): BotRpc {
  return env.BOT_STATES.getByName(
    `${identity.userId}:${identity.botId}`,
  ) as unknown as BotRpc;
}

async function pinnedGeneration(
  identity: { userId: string; botId: string },
  runId: string,
): Promise<string | undefined> {
  return runInDurableObject(
    env.BOT_STATES.getByName(`${identity.userId}:${identity.botId}`),
    async (_instance, state) => {
      const runs = await hydratedStoredRunsV1<{
        runId: string;
        sessionId: string;
        compositionGenerationId?: string;
      }>(state.storage);
      return runs.find((run) => run.runId === runId)?.compositionGenerationId;
    },
  );
}

async function turn(
  identity: { userId: string; botId: string },
  runId: string,
): Promise<void> {
  await bot(identity).run({
    schemaVersion: 1,
    ...identity,
    command: {
      runId,
      sessionId: `${identity.userId}:${identity.botId}`,
      acceptedAt: new Date().toISOString(),
      text: "hello",
    },
  });
}

/**
 * The pin each admitted run took, by run id. `pinnedGeneration` answers for
 * one known run; a firing mints its own id, so this returns the lot.
 */
async function pinnedGenerations(identity: {
  userId: string;
  botId: string;
}): Promise<Array<{ runId: string; compositionGenerationId?: string }>> {
  return runInDurableObject(
    env.BOT_STATES.getByName(`${identity.userId}:${identity.botId}`),
    async (_instance, state) => {
      const runs = await hydratedStoredRunsV1<{
        runId: string;
        sessionId: string;
        compositionGenerationId?: string;
        admission?: { origin?: { routineId?: string } };
      }>(state.storage);
      return runs
        .filter((run) => run.admission?.origin?.routineId === "brief")
        .map((run) => ({
          runId: run.runId,
          ...(run.compositionGenerationId === undefined
            ? {}
            : { compositionGenerationId: run.compositionGenerationId }),
        }));
    },
  );
}

/**
 * Runs `store_roundtrip` as a real Turn of `identity` and returns what the
 * Plugin saw through the loopback.
 */
async function storeRoundtrip(
  identity: { userId: string; botId: string },
  runId: string,
  word: string,
): Promise<Record<string, unknown>> {
  await bot(identity).run({
    schemaVersion: 1,
    ...identity,
    command: {
      runId,
      sessionId: `${identity.userId}:${identity.botId}`,
      acceptedAt: new Date().toISOString(),
      text: toolCallTriggerPrompt([
        "call_dynamic_tool",
        dynamicToolInputV1({
          namespace: STORE_PLUGIN_ID,
          toolName: "store_roundtrip",
          input: { word },
        }),
      ]),
    },
  });

  const runs = await runInDurableObject(
    env.BOT_STATES.getByName(`${identity.userId}:${identity.botId}`),
    (_instance, state) =>
      hydratedStoredRunsV1<{
        runId: string;
        sessionId: string;
        events: Array<{ type: string; content?: string; name?: string }>;
      }>(state.storage),
  );
  const run = runs.find((candidate) => candidate.runId === runId);
  const result = run?.events.find(
    (event) =>
      event.type === "tool/result" &&
      typeof event.content === "string" &&
      event.content.includes('"put"'),
  );
  expect(
    result,
    JSON.stringify(run?.events.map((event) => event.type)),
  ).toBeDefined();
  const raw = (result as { content?: string }).content ?? "";
  const outer = JSON.parse(raw) as { content?: string };
  return JSON.parse(
    typeof outer.content === "string" ? outer.content : raw,
  ) as Record<string, unknown>;
}

/** What one Plugin's storage key holds in a Bot's own Durable Object. */
async function storedGreeting(identity: {
  userId: string;
  botId: string;
}): Promise<unknown> {
  return runInDurableObject(
    env.BOT_STATES.getByName(`${identity.userId}:${identity.botId}`),
    (_instance, state) =>
      state.storage.get(`plugin:storage:${STORE_PLUGIN_ID}:greeting`),
  );
}

describe("the User-owned Composition", () => {
  test("a generation the User pins is what every Bot's next Turn runs under, and it activates on the User", async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const first = { userId, botId: "bot-1" };
    const second = { userId, botId: "bot-2" };
    await provisionBot(first);
    await provisionSiblingBot(second, 1);

    // The bootstrap: one generation, the same for both Bots.
    await turn(first, "run-1");
    const bootstrap = (
      await user(userId).readComposition({
        schemaVersion: 1,
        userId,
      })
    ).current;
    expect(await pinnedGeneration(first, "run-1")).toBe(bootstrap.generationId);
    expect(bootstrap.status).toBe("active");

    // A new generation, proposed on the User and pinned for the next Turn.
    const createdAt = "2026-09-12T00:00:00.000Z";
    const proposed = {
      ...bootstrap,
      generationId: `${createdAt}:${bootstrap.generationId.split(":").at(-1)}`,
      parentGenerationId: bootstrap.generationId,
      createdAt,
      origin: {
        kind: "bot-authored",
        runId: "run-1",
        sessionId: `${userId}:bot-1`,
        turnId: "run-1",
      },
      status: "pending",
    };
    await user(userId).proposeComposition({
      schemaVersion: 1,
      userId,
      generation: proposed,
      pin: true,
      expectedCurrentGenerationId: bootstrap.generationId,
    });

    await turn(second, "run-2");
    await turn(first, "run-3");

    expect(await pinnedGeneration(second, "run-2")).toBe(proposed.generationId);
    expect(await pinnedGeneration(first, "run-3")).toBe(proposed.generationId);
    const after = await user(userId).readComposition({
      schemaVersion: 1,
      userId,
    });
    expect(after.current.generationId).toBe(proposed.generationId);
    expect(after.current.status).toBe("active");
    expect(after.lastKnownGood.generationId).toBe(proposed.generationId);
    expect(
      (
        await user(userId).readCompositionGeneration({
          schemaVersion: 1,
          userId,
          generationId: bootstrap.generationId,
        })
      )?.status,
    ).toBe("superseded");
    // The Turn that ran before the proposal keeps the generation it pinned.
    expect(await pinnedGeneration(first, "run-1")).toBe(bootstrap.generationId);
  });

  test("the Composition each Bot lists is the User's whole history, not its mirror", async () => {
    // The mirror a Bot keeps is two generations deep. The settings list has
    // to answer from the User, so a third generation must still be there.
    const userId = `user-${crypto.randomUUID()}`;
    const first = { userId, botId: "bot-1" };
    const second = { userId, botId: "bot-2" };
    await provisionBot(first);
    await provisionSiblingBot(second, 1);
    await turn(first, "run-1");

    let parent = (
      await user(userId).readComposition({ schemaVersion: 1, userId })
    ).current;
    const proposedIds: string[] = [];
    for (const hour of ["02", "03"]) {
      const createdAt = `2026-09-12T${hour}:00:00.000Z`;
      const generation = {
        ...parent,
        generationId: `${createdAt}:${parent.generationId.split(":").at(-1)}`,
        parentGenerationId: parent.generationId,
        createdAt,
        origin: {
          kind: "bot-authored",
          runId: `install-${hour}`,
          sessionId: `${userId}:bot-1`,
          turnId: `install-${hour}`,
        },
        status: "pending",
      };
      await user(userId).proposeComposition({
        schemaVersion: 1,
        userId,
        generation,
        pin: true,
        expectedCurrentGenerationId: parent.generationId,
      });
      proposedIds.push(generation.generationId);
      parent = { ...generation, status: "active" };
    }
    const listing = await bot(first).listCompositionGenerations({
      schemaVersion: 1,
      ...first,
      query: { limit: 10 },
    });
    expect(listing.botId).toBe("bot-1");
    expect(listing.currentGenerationId).toBe(proposedIds.at(-1));
    expect(listing.generations.map((entry) => entry.generationId)).toEqual(
      expect.arrayContaining(proposedIds),
    );
    expect(listing.generations.length).toBeGreaterThanOrEqual(3);
    expect(
      listing.generations
        .filter((entry) => entry.isCurrent)
        .map((entry) => entry.generationId),
    ).toEqual([proposedIds.at(-1)]);

    // The sibling Bot, which has admitted nothing, lists the same history.
    const sibling = await bot(second).listCompositionGenerations({
      schemaVersion: 1,
      ...second,
      query: { limit: 10 },
    });
    expect(sibling.botId).toBe("bot-2");
    expect(sibling.generations.map((entry) => entry.generationId)).toEqual(
      listing.generations.map((entry) => entry.generationId),
    );
  });

  test("an Applet the User's directory gained lands in the User's Composition", async () => {
    // Publishing an Applet proposes a new generation. It has to be proposed
    // into the User's store, or the id the next Turn pins is one the User has
    // never heard of.
    const userId = `user-${crypto.randomUUID()}`;
    const identity = { userId, botId: "bot-1" };
    await provisionBot(identity);
    // What an admin does before an account's Bots see Applets at all.
    await user(userId).setFeatures({
      schemaVersion: 1,
      userId,
      command: { schemaVersion: 1, type: "user/set-features", applets: true },
      updatedBy: "workerd-admin",
    });
    await turn(identity, "run-1");
    const before = (
      await user(userId).readComposition({ schemaVersion: 1, userId })
    ).current;

    const applet = await user(userId).createApplet({
      schemaVersion: 1,
      userId,
      displayName: "Expenses",
      provenance: { kind: "user" },
    });
    await user(userId).recordAppletGeneration({
      schemaVersion: 1,
      userId,
      appletId: applet.appletId,
      generationId: "applet-g1",
      tools: [
        {
          name: "file_expense",
          description: "Files an expense",
          inputSchema: { type: "object" },
        },
      ],
    });

    await turn(identity, "run-2");

    const after = await user(userId).readComposition({
      schemaVersion: 1,
      userId,
    });
    expect(after.current.generationId).not.toBe(before.generationId);
    expect(after.current.status).toBe("active");
    expect(await pinnedGeneration(identity, "run-2")).toBe(
      after.current.generationId,
    );
    const generation = await user(userId).readCompositionGeneration({
      schemaVersion: 1,
      userId,
      generationId: after.current.generationId,
    });
    expect(
      (
        generation as unknown as {
          applets?: { appletId: string; generationId: string }[];
        }
      ).applets,
    ).toEqual([
      expect.objectContaining({
        appletId: applet.appletId,
        generationId: "applet-g1",
      }),
    ]);
  });

  test("a Bot's enable map is its own", async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const identity = { userId, botId: "bot-1" };
    await provisionBot(identity);
    const rpc = bot(identity);
    expect(
      await rpc.readPluginEnablement({ schemaVersion: 1, ...identity }),
    ).toMatchObject({ revision: 0 });
    const off = await rpc.setPluginEnabled({
      schemaVersion: 1,
      ...identity,
      pluginId: "weather",
      enabled: false,
      expectedRevision: 0,
    });
    expect(off).toEqual({
      status: "applied",
      enablement: expect.objectContaining({
        revision: 1,
        enabled: { weather: false },
      }),
    });
    expect(
      await rpc.setPluginEnabled({
        schemaVersion: 1,
        ...identity,
        pluginId: "weather",
        enabled: true,
        expectedRevision: 0,
      }),
    ).toEqual({ status: "conflict", currentRevision: 1 });
    // The other Bot of the same User is untouched.
    const sibling = { userId, botId: "bot-2" };
    await provisionSiblingBot(sibling, 1);
    expect(
      await bot(sibling).readPluginEnablement({ schemaVersion: 1, ...sibling }),
    ).toMatchObject({ revision: 0, enabled: {} });
  });

  test("a Bot whose first admission is a Routine firing pins the User's generation", async () => {
    // A chat Turn is not the only way in. A firing is admitted from inside the
    // object's own alarm, and if the Bot has not mirrored the User's pin by
    // then it bootstraps a generation of its own and pins that — an id the
    // User has never heard of, which fails the moment activation commits.
    const userId = `user-${crypto.randomUUID()}`;
    const identity = { userId, botId: "bot-1" };
    await provisionBot(identity);

    const bootstrap = (
      await user(userId).readComposition({ schemaVersion: 1, userId })
    ).current;
    const createdAt = "2026-09-12T01:00:00.000Z";
    const pinned = {
      ...bootstrap,
      generationId: `${createdAt}:${bootstrap.generationId.split(":").at(-1)}`,
      parentGenerationId: bootstrap.generationId,
      createdAt,
      origin: {
        kind: "bot-authored",
        runId: "install-1",
        sessionId: `${userId}:bot-1`,
        turnId: "install-1",
      },
      status: "pending",
    };
    await user(userId).proposeComposition({
      schemaVersion: 1,
      userId,
      generation: pinned,
      pin: true,
      expectedCurrentGenerationId: bootstrap.generationId,
    });

    // The Bot has admitted nothing at this point; the firing is its first.
    expect(
      await bot(identity).executeRoutineCommand({
        schemaVersion: 1,
        ...identity,
        command: {
          schemaVersion: 1,
          botId: identity.botId,
          type: "routine/create",
          commandId: `create-${userId}`,
          routineId: "brief",
          name: "Hourly brief",
          prompt: "Summarize overnight email.",
          schedule: "0 * * * *",
        },
      }),
    ).toMatchObject({ status: "applied" });
    await runInDurableObject(
      env.BOT_STATES.getByName(`${userId}:${identity.botId}`),
      async (_instance, state) => {
        const record = await state.storage.get<{ updatedAt: string }>(
          "routine:brief",
        );
        await state.storage.put("routine-schedule:brief", {
          schemaVersion: 1,
          routineId: "brief",
          anchor: record!.updatedAt,
          dueAt: Date.now() - 60 * 60_000,
        });
      },
    );
    expect(
      await runDurableObjectAlarm(
        env.BOT_STATES.getByName(`${userId}:${identity.botId}`),
      ),
    ).toBe(true);

    const fired = await pinnedGenerations(identity);
    expect(fired).toHaveLength(1);
    expect(fired[0]?.compositionGenerationId).toBe(pinned.generationId);
    // And the activation landed on the User, which is the only place the
    // generation exists.
    const after = await user(userId).readComposition({
      schemaVersion: 1,
      userId,
    });
    expect(after.current).toMatchObject({
      generationId: pinned.generationId,
      status: "active",
    });
  });

  test("a plugin in a real Turn reaches storage, settings and the Bot's authority through the loopback", async () => {
    const userId = `user-${crypto.randomUUID()}`;
    const identity = { userId, botId: "bot-1" };
    const second = { userId, botId: "bot-2" };
    await provisionBot(identity);
    await provisionSiblingBot(second, 1);
    await turn(identity, "run-0");
    const bootstrap = (
      await user(userId).readComposition({ schemaVersion: 1, userId })
    ).current;

    // The artifact is seeded the way a build would store it: content-addressed.
    const contentHash = await sha256Hex(STORE_PLUGIN_SOURCE);
    await env.APPLICATION_ARTIFACTS.put(
      `packages/${contentHash}.mjs`,
      STORE_PLUGIN_SOURCE,
    );
    const createdAt = "2026-09-12T01:00:00.000Z";
    const members: CompositionMemberV1[] = [
      {
        packageId: STORE_PLUGIN_ID,
        version: "0.0.1",
        descriptor: STORE_PLUGIN_DESCRIPTOR,
        provenance: {
          kind: "bot",
          packageId: STORE_PLUGIN_ID,
          version: "0.0.1",
          botId: "bot-1",
          sessionId: `${userId}:bot-1`,
          turnId: "run-0",
          runId: "run-0",
          authoredAt: createdAt,
        },
        artifact: {
          contentHash,
          size: STORE_PLUGIN_SOURCE.length,
          mediaType: "application/javascript",
          bundlerVersion: "probe-seed",
        },
      },
    ];
    const artifactSetHash = await compositionArtifactSetHashV1(members);
    await user(userId).proposeComposition({
      schemaVersion: 1,
      userId,
      generation: {
        schemaVersion: 1,
        generationId: compositionGenerationIdV1(createdAt, artifactSetHash),
        artifactSetHash,
        parentGenerationId: bootstrap.generationId,
        createdAt,
        origin: {
          kind: "bot-authored",
          runId: "run-0",
          sessionId: `${userId}:bot-1`,
          turnId: "run-0",
        },
        members,
        status: "pending",
      },
      pin: true,
      expectedCurrentGenerationId: bootstrap.generationId,
    });

    const inner = await storeRoundtrip(identity, "run-1", "hello");
    expect(inner).toMatchObject({
      put: "available",
      got: { word: "hello" },
      missing: null,
      keys: ["greeting"],
      settings: {},
      authority: "available",
      bot: "bot-1",
      user: userId,
    });
    expect(inner.connections as number).toBeGreaterThanOrEqual(1);

    // The binding digest names only the User, so this Bot is served the worker
    // the first Bot's object loaded — including the `CAPABILITIES` stub minted
    // there. The stub must still answer, and it must route by the scope's Bot:
    // this Turn's writes land in this Bot's own object, not the first one's.
    const sibling = await storeRoundtrip(second, "run-2", "world");
    expect(sibling).toMatchObject({
      put: "available",
      got: { word: "world" },
      keys: ["greeting"],
      authority: "available",
      bot: "bot-2",
      user: userId,
    });
    expect(await storedGreeting(second)).toEqual({ word: "world" });
    expect(await storedGreeting(identity)).toEqual({ word: "hello" });
  });
});
