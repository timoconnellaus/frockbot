// Routines against a real Bot Durable Object.
//
// The claim: a Routine is durable Bot state. It is created, paused and deleted
// through the production RPCs — the same ones the gateway calls — and it
// survives eviction, because "Persist enough state to resume safely after
// Durable Object eviction" is not a property of the object staying resident.
//
// Nothing here fires anything. D1 ships records, commands and the surfaces that
// read them; the scheduler is the next PR, and the run log is correspondingly
// empty at every point in this test.
import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { provisionBot } from "./provision-bot.ts";

function bot(userId: string, botId: string) {
  return env.BOT_STATES.getByName(`${userId}:${botId}`);
}

interface RoutineRpc {
  listRoutines(input: unknown): Promise<{
    routines: Array<{
      routineId: string;
      name: string;
      enabled: boolean;
      schedule?: string;
      createdBy: { kind: string };
    }>;
  }>;
  executeRoutineCommand(input: unknown): Promise<{
    status: string;
    routine?: { routineId: string; enabled: boolean };
    routineId?: string;
  }>;
  listRoutineRuns(input: unknown): Promise<{ entries: unknown[] }>;
}

function routines(userId: string, botId: string): RoutineRpc {
  // SAFETY: the generated stub type for the Bot RPCs is too deep for the
  // compiler to instantiate here; this names only the methods this test calls.
  return bot(userId, botId) as unknown as RoutineRpc;
}

describe("Routines in Workerd", () => {
  test("create, pause and delete are durable across Durable Object eviction", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      userId: `routines-user-${suffix}`,
      botId: `routines-bot-${suffix}`,
    };
    await provisionBot(identity);
    const rpc = routines(identity.userId, identity.botId);
    const envelope = { schemaVersion: 1 as const, ...identity };

    const created = await rpc.executeRoutineCommand({
      ...envelope,
      command: {
        schemaVersion: 1,
        type: "routine/create",
        commandId: `create-${suffix}`,
        botId: identity.botId,
        routineId: "brief",
        name: "Morning brief",
        prompt: "Summarize overnight email.",
        schedule: "0 7 * * *",
        timezone: "Australia/Sydney",
      },
    });
    expect(created).toMatchObject({ status: "applied" });

    // THE EVICTION. Nothing is held in memory on the object's behalf.
    await evictDurableObject(bot(identity.userId, identity.botId));

    const listed = await routines(identity.userId, identity.botId).listRoutines(
      envelope,
    );
    expect(listed.routines).toHaveLength(1);
    expect(listed.routines[0]).toMatchObject({
      routineId: "brief",
      name: "Morning brief",
      enabled: true,
      schedule: "0 7 * * *",
      // A User wrote it, and the record says so.
      createdBy: { kind: "user" },
    });

    // D1 fires nothing, so the run log is empty and says so rather than 404.
    expect(
      (
        await routines(identity.userId, identity.botId).listRoutineRuns({
          ...envelope,
          routineId: "brief",
        })
      ).entries,
    ).toEqual([]);

    await routines(identity.userId, identity.botId).executeRoutineCommand({
      ...envelope,
      command: {
        schemaVersion: 1,
        type: "routine/pause",
        commandId: `pause-${suffix}`,
        botId: identity.botId,
        routineId: "brief",
      },
    });
    await evictDurableObject(bot(identity.userId, identity.botId));
    expect(
      (await routines(identity.userId, identity.botId).listRoutines(envelope))
        .routines[0],
    ).toMatchObject({ enabled: false });

    const deleted = await routines(
      identity.userId,
      identity.botId,
    ).executeRoutineCommand({
      ...envelope,
      command: {
        schemaVersion: 1,
        type: "routine/delete",
        commandId: `delete-${suffix}`,
        botId: identity.botId,
        routineId: "brief",
      },
    });
    expect(deleted).toMatchObject({ status: "deleted", routineId: "brief" });
    await evictDurableObject(bot(identity.userId, identity.botId));
    expect(
      (await routines(identity.userId, identity.botId).listRoutines(envelope))
        .routines,
    ).toEqual([]);
  });

  test("a replayed command id applies once, across eviction", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      userId: `routines-replay-${suffix}`,
      botId: `routines-replay-bot-${suffix}`,
    };
    await provisionBot(identity);
    const envelope = { schemaVersion: 1 as const, ...identity };
    const command = {
      schemaVersion: 1,
      type: "routine/create",
      commandId: `create-${suffix}`,
      botId: identity.botId,
      routineId: "brief",
      name: "Morning brief",
      prompt: "Summarize overnight email.",
      schedule: "@daily",
      timezone: "UTC",
    };

    const first = await routines(
      identity.userId,
      identity.botId,
    ).executeRoutineCommand({ ...envelope, command });
    await evictDurableObject(bot(identity.userId, identity.botId));
    const replay = await routines(
      identity.userId,
      identity.botId,
    ).executeRoutineCommand({ ...envelope, command });

    expect(replay).toEqual(first);
    expect(
      (await routines(identity.userId, identity.botId).listRoutines(envelope))
        .routines,
    ).toHaveLength(1);
  });

  test("a Routine whose cron cannot be parsed is never written", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      userId: `routines-bad-${suffix}`,
      botId: `routines-bad-bot-${suffix}`,
    };
    await provisionBot(identity);
    const envelope = { schemaVersion: 1 as const, ...identity };
    let refusal: unknown;
    try {
      await routines(identity.userId, identity.botId).executeRoutineCommand({
        ...envelope,
        command: {
          schemaVersion: 1,
          type: "routine/create",
          commandId: `create-${suffix}`,
          botId: identity.botId,
          routineId: "brief",
          name: "Broken",
          prompt: "Never runs.",
          schedule: "not a cron",
          timezone: "UTC",
        },
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toContain("five fields");
    expect(
      (await routines(identity.userId, identity.botId).listRoutines(envelope))
        .routines,
    ).toEqual([]);
  });
});
