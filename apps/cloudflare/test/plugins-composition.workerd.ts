// The User owns the Composition; a Bot mirrors it before admission (ADR 0026).
//
// Two claims against the real User and Bot Durable Objects: a generation the
// User pins is what the next admitted Turn on any of that User's Bots runs
// under, and the outcome of that activation lands on the User's record, not
// the Bot's.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { provisionBot, provisionSiblingBot } from "./provision-bot.ts";
import { hydratedStoredRunsV1 } from "./session-log-probe.ts";

interface CompositionRpc {
  readComposition(input: unknown): Promise<{
    current: { generationId: string; status: string; createdAt: string };
    lastKnownGood: { generationId: string };
  }>;
  readCompositionGeneration(
    input: unknown,
  ): Promise<{ generationId: string; status: string } | undefined>;
  proposeComposition(input: unknown): Promise<void>;
  listCompositionGenerations(
    input: unknown,
  ): Promise<{ generations: { generationId: string; status: string }[] }>;
}

interface BotRpc {
  run(command: unknown): Promise<{ runId: string }>;
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
});
