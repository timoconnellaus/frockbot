// Routines against a real Bot Durable Object.
//
// The claim: a Routine is durable Bot state. It is created, paused and deleted
// through the production RPCs — the same ones the gateway calls — and it
// survives eviction, because "Persist enough state to resume safely after
// Durable Object eviction" is not a property of the object staying resident.
//
// The scheduler is exercised against the same object: the alarm the kernel
// arms, the firing it mints, and the automation Turn `authority.run` admits
// from inside the Durable Object.
import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, test } from "vitest";
import {
  mintRoutineHookTokenV1,
  routineDeliveryIdV1,
  routineHookDigestV1,
  verifyRoutineHookTokenV1,
} from "@frockbot/plugin-routines/hook";
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

    // Nothing has fired yet, so the run log is empty and says so rather
    // than 404.
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

interface StoredRunProbe {
  runId: string;
  sessionId: string;
  status: string;
  admission?: {
    turnType: string;
    origin?: {
      kind: string;
      routineId: string;
      fireId: string;
      trigger: string;
    };
  };
}

/**
 * Seed the Routine's durable clock as though the object had been evicted while
 * the occurrence passed. There is no clock to move in workerd, so the debt is
 * written instead — which is exactly the record a slept-through Routine leaves.
 */
async function backdate(
  identity: { userId: string; botId: string },
  routineId: string,
  dueAt: number,
): Promise<void> {
  await runInDurableObject(
    bot(identity.userId, identity.botId),
    async (_instance, state) => {
      const record = await state.storage.get<{ updatedAt: string }>(
        `routine:${routineId}`,
      );
      await state.storage.put(`routine-schedule:${routineId}`, {
        schemaVersion: 1,
        routineId,
        anchor: record!.updatedAt,
        dueAt,
      });
    },
  );
}

async function storedRuns(identity: {
  userId: string;
  botId: string;
}): Promise<StoredRunProbe[]> {
  return runInDurableObject(
    bot(identity.userId, identity.botId),
    async (_instance, state) => {
      const runs = await state.storage.list<StoredRunProbe>({ prefix: "run:" });
      return [...runs.values()];
    },
  );
}

async function armedAlarm(identity: {
  userId: string;
  botId: string;
}): Promise<number | null> {
  return runInDurableObject(
    bot(identity.userId, identity.botId),
    (_instance, state) => state.storage.getAlarm(),
  );
}

async function createRoutine(
  identity: { userId: string; botId: string },
  command: Record<string, unknown>,
): Promise<void> {
  const receipt = await routines(
    identity.userId,
    identity.botId,
  ).executeRoutineCommand({
    schemaVersion: 1,
    ...identity,
    command: { schemaVersion: 1, botId: identity.botId, ...command },
  });
  expect(receipt).toMatchObject({ status: "applied" });
}

describe("the Routine scheduler on the Bot Durable Object's one alarm", () => {
  test("arms the alarm on the Routine's next occurrence", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      userId: `routines-alarm-${suffix}`,
      botId: `routines-alarm-bot-${suffix}`,
    };
    await provisionBot(identity);

    // No Routine, no alarm.
    expect(await armedAlarm(identity)).toBeNull();

    await createRoutine(identity, {
      type: "routine/create",
      commandId: `create-${suffix}`,
      routineId: "brief",
      name: "Hourly brief",
      prompt: "Summarize overnight email.",
      schedule: "0 * * * *",
      timezone: "UTC",
    });

    const armed = await armedAlarm(identity);
    expect(armed).not.toBeNull();
    // The next top of the hour, and nothing sooner.
    expect(armed!).toBeGreaterThan(Date.now());
    expect(armed!).toBeLessThanOrEqual(Date.now() + 60 * 60_000);

    // Pausing it takes the alarm away: there is nothing left to wake for.
    await routines(identity.userId, identity.botId).executeRoutineCommand({
      schemaVersion: 1,
      ...identity,
      command: {
        schemaVersion: 1,
        type: "routine/pause",
        commandId: `pause-${suffix}`,
        botId: identity.botId,
        routineId: "brief",
      },
    });
    expect(await armedAlarm(identity)).toBeNull();
  });

  test("a Routine three hours late fires exactly once through the alarm", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      userId: `routines-late-${suffix}`,
      botId: `routines-late-bot-${suffix}`,
    };
    await provisionBot(identity);
    await createRoutine(identity, {
      type: "routine/create",
      commandId: `create-${suffix}`,
      routineId: "brief",
      name: "Hourly brief",
      prompt: "Summarize overnight email.",
      schedule: "0 * * * *",
      timezone: "UTC",
    });
    await backdate(identity, "brief", Date.now() - 3 * 60 * 60_000);

    expect(
      await runDurableObjectAlarm(bot(identity.userId, identity.botId)),
    ).toBe(true);

    const runs = await storedRuns(identity);
    const automation = runs.filter(
      (run) => run.admission?.origin?.routineId === "brief",
    );
    expect(automation).toHaveLength(1);
    expect(automation[0]).toMatchObject({
      status: "completed",
      sessionId: "routine:brief",
      admission: {
        turnType: "automation",
        origin: { kind: "routine", trigger: "cron" },
      },
    });
    // The fire id is the run id: a retry is refused by the kernel's own
    // idempotency rather than running the Routine a second time.
    expect(automation[0]!.admission!.origin!.fireId).toBe(automation[0]!.runId);

    // One firing, and one entry saying what it slept through.
    const log = await routines(identity.userId, identity.botId).listRoutineRuns(
      { schemaVersion: 1, ...identity, routineId: "brief" },
    );
    expect(
      (log.entries as Array<{ status: string }>).map((entry) => entry.status),
    ).toEqual(["ok", "skipped"]);

    // Draining again fires nothing: the clock advanced before the Turn ran.
    await runDurableObjectAlarm(bot(identity.userId, identity.botId));
    expect(
      (await storedRuns(identity)).filter(
        (run) => run.admission?.origin?.routineId === "brief",
      ),
    ).toHaveLength(1);
  });

  test("arms the one alarm on the earliest deadline the object owes", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      userId: `routines-min-${suffix}`,
      botId: `routines-min-bot-${suffix}`,
    };
    await provisionBot(identity);
    await createRoutine(identity, {
      type: "routine/create",
      commandId: `late-${suffix}`,
      routineId: "late",
      name: "Nightly",
      prompt: "Summarize the day.",
      schedule: "0 23 * * *",
      timezone: "UTC",
    });
    const afterOne = await armedAlarm(identity);

    await createRoutine(identity, {
      type: "routine/create",
      commandId: `soon-${suffix}`,
      routineId: "soon",
      name: "Hourly",
      prompt: "Check the queue.",
      schedule: "0 * * * *",
      timezone: "UTC",
    });
    const afterTwo = await armedAlarm(identity);

    // One object, one alarm, and it is the minimum of everything owed —
    // Routines beside the Shell's own saga deadlines, never a second timer.
    expect(afterTwo).not.toBeNull();
    expect(afterTwo!).toBeLessThanOrEqual(afterOne!);
    expect(afterTwo!).toBeLessThanOrEqual(Date.now() + 60 * 60_000);

    // Deleting the sooner one hands the alarm back to the later one.
    await routines(identity.userId, identity.botId).executeRoutineCommand({
      schemaVersion: 1,
      ...identity,
      command: {
        schemaVersion: 1,
        type: "routine/delete",
        commandId: `delete-${suffix}`,
        botId: identity.botId,
        routineId: "soon",
      },
    });
    expect(await armedAlarm(identity)).toBe(afterOne);
  });

  test("run_now queues a manual firing that the alarm drains", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      userId: `routines-manual-${suffix}`,
      botId: `routines-manual-bot-${suffix}`,
    };
    await provisionBot(identity);
    await createRoutine(identity, {
      type: "routine/create",
      commandId: `create-${suffix}`,
      routineId: "brief",
      name: "Webhook brief",
      prompt: "Summarize overnight email.",
      trigger: { kind: "webhook" },
      timezone: "UTC",
    });

    const receipt = await routines(
      identity.userId,
      identity.botId,
    ).executeRoutineCommand({
      schemaVersion: 1,
      ...identity,
      command: {
        schemaVersion: 1,
        type: "routine/run",
        commandId: `run-${suffix}`,
        botId: identity.botId,
        routineId: "brief",
      },
    });
    expect(receipt).toMatchObject({ status: "fired", routineId: "brief" });

    // It survives eviction, because it is a durable record and not a timer.
    await evictDurableObject(bot(identity.userId, identity.botId));
    await runDurableObjectAlarm(bot(identity.userId, identity.botId));

    const runs = await storedRuns(identity);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: "completed",
      admission: {
        turnType: "automation",
        origin: { routineId: "brief", trigger: "manual" },
      },
    });
  });
});

describe("the webhook door against a real Bot Durable Object", () => {
  async function webhookBot(label: string) {
    const suffix = crypto.randomUUID();
    const identity = {
      userId: `routines-${label}-${suffix}`,
      botId: `routines-${label}-bot-${suffix}`,
    };
    await provisionBot(identity);
    const receipt = (await routines(
      identity.userId,
      identity.botId,
    ).executeRoutineCommand({
      schemaVersion: 1,
      ...identity,
      command: {
        schemaVersion: 1,
        type: "routine/create",
        commandId: `create-${suffix}`,
        botId: identity.botId,
        routineId: "brief",
        name: "Delivered brief",
        prompt: "Summarize the payload.",
        trigger: { kind: "webhook" },
        timezone: "UTC",
      },
    })) as unknown as { hook?: { token: string; keyVersion: number } };
    expect(receipt.hook?.keyVersion).toBe(1);
    return { identity, token: receipt.hook!.token };
  }

  async function deliver(
    identity: { userId: string; botId: string },
    token: string,
    body: string,
  ) {
    const claims = await verifyRoutineHookTokenV1(
      env.ROUTINE_HOOK_SECRET,
      token,
    );
    // SAFETY: the generated stub type for the Bot RPCs is too deep for the
    // compiler to instantiate here; this names the one method the test calls.
    return (
      bot(identity.userId, identity.botId) as unknown as {
        deliverRoutineHook(input: unknown): Promise<{
          status: string;
          fireId: string;
        }>;
      }
    ).deliverRoutineHook({
      schemaVersion: 1,
      ...identity,
      delivery: {
        routineId: claims.r,
        keyVersion: claims.v,
        digest: await routineHookDigestV1(token),
        deliveryId: await routineDeliveryIdV1(claims.r, body),
        body,
        contentType: "application/json",
      },
    });
  }

  async function fireRecords(identity: { userId: string; botId: string }) {
    return runInDurableObject(
      bot(identity.userId, identity.botId),
      async (_instance, state) => [
        ...(
          await state.storage.list<unknown>({ prefix: "routine-queue:" })
        ).values(),
        ...(
          await state.storage.list<unknown>({ prefix: "routine-fire:" })
        ).values(),
      ],
    );
  }

  test("a bad key writes no firing at all", async () => {
    const { identity, token } = await webhookBot("badkey");
    // A token minted under a different secret: a perfectly formed key that
    // this deployment never issued.
    const forged = await mintRoutineHookTokenV1(
      "a-different-signing-secret-entirely",
      { u: identity.userId, b: identity.botId, r: "brief", v: 1 },
    );
    expect(forged).not.toBe(token);
    await expect(deliver(identity, forged, "{}")).rejects.toThrow();
    expect(await fireRecords(identity)).toEqual([]);

    // And a valid signature at the wrong key version is refused too.
    const wrongVersion = await mintRoutineHookTokenV1(env.ROUTINE_HOOK_SECRET, {
      u: identity.userId,
      b: identity.botId,
      r: "brief",
      v: 2,
    });
    await expect(deliver(identity, wrongVersion, "{}")).rejects.toThrow();
    expect(await fireRecords(identity)).toEqual([]);
  });

  test("a good key makes one firing, and the same delivery twice still makes one", async () => {
    const { identity, token } = await webhookBot("goodkey");

    const first = await deliver(identity, token, '{"event":"push"}');
    expect(first.status).toBe("accepted");
    const replay = await deliver(identity, token, '{"event":"push"}');
    expect(replay).toEqual({ status: "duplicate", fireId: first.fireId });
    expect(await fireRecords(identity)).toHaveLength(1);

    // It survives eviction, because the firing is a durable record.
    await evictDurableObject(bot(identity.userId, identity.botId));
    await runDurableObjectAlarm(bot(identity.userId, identity.botId));

    const runs = await storedRuns(identity);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      status: "completed",
      admission: {
        turnType: "automation",
        origin: { routineId: "brief", trigger: "webhook" },
      },
    });
    expect(runs[0]!.runId).toBe(first.fireId);
  });
});
