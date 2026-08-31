// A Routine fires, end to end, through the product's own surfaces: the command
// a browser posts, the alarm the Bot Durable Object arms for itself, and the
// automation Turn `authority.run` admits from inside that object.
//
// Nothing in this file reaches past the gateway to make the firing happen. The
// only privileged thing it does is read the durable run record, because the
// client run projection carries no admission — which is the point of the last
// assertion here.
import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  asUser,
  dueAtWithFiringHeadroomV1,
  expectOkJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

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

function botStub(userId: string, botId: string) {
  return env.BOT_STATES.get(env.BOT_STATES.idFromName(`${userId}:${botId}`));
}

/**
 * Wind the Routine's durable clock back to a moment already past. The
 * integration Worker has no fake clock, and this is the record a Routine whose
 * occurrence has arrived actually holds.
 */
async function makeDue(userId: string, botId: string): Promise<void> {
  const dueAt = await dueAtWithFiringHeadroomV1();
  await runInDurableObject(botStub(userId, botId), async (_instance, state) => {
    const record = await state.storage.get<{ updatedAt: string }>(
      "routine:brief",
    );
    await state.storage.put("routine-schedule:brief", {
      schemaVersion: 1,
      routineId: "brief",
      anchor: record!.updatedAt,
      dueAt,
    });
  });
}

async function storedRuns(
  userId: string,
  botId: string,
): Promise<StoredRunProbe[]> {
  return runInDurableObject(
    botStub(userId, botId),
    async (_instance, state) => [
      ...(
        await state.storage.list<StoredRunProbe>({ prefix: "run:" })
      ).values(),
    ],
  );
}

describe("a Routine firing, from the command to the admitted Turn", () => {
  it("fires a one-minute cron into an automation Turn with a recorded origin", async () => {
    const userId = freshUserId("routines-fire");
    const botId = "routines-fire-bot";
    await provisionThroughGateway({ userId, botId });

    await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/routines`, {
        schemaVersion: 1,
        type: "routine/create",
        commandId: `create-${botId}`,
        botId,
        routineId: "brief",
        name: "Minute brief",
        prompt: "Summarize overnight email.",
        schedule: "* * * * *",
        timezone: "UTC",
      }),
    );

    // The Routine reports a next run, because an alarm is armed on it.
    const listed = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/routines`),
    )) as { routines: Array<{ nextRunAt?: string }> };
    expect(listed.routines[0]?.nextRunAt).toBeTypeOf("string");

    const before = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/turns`),
    )) as { runs: Array<{ runId: string }> };

    await makeDue(userId, botId);
    // The object wakes itself: the alarm was armed by the command that created
    // the Routine, and nothing outside the Bot asks it to fire.
    expect(await runDurableObjectAlarm(botStub(userId, botId))).toBe(true);

    const runs = await storedRuns(userId, botId);
    const automation = runs.filter(
      (run) => run.admission?.origin?.routineId === "brief",
    );
    expect(automation).toHaveLength(1);
    expect(automation[0]).toMatchObject({
      status: "completed",
      sessionId: "routine:brief",
      admission: {
        turnType: "automation",
        origin: { kind: "routine", routineId: "brief", trigger: "cron" },
      },
    });

    // The run log holds exactly one entry for the firing, settled.
    const log = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/routines/brief/runs`),
    )) as {
      entries: Array<{ status: string; trigger: string; runId: string }>;
    };
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]).toMatchObject({
      status: "ok",
      trigger: "cron",
      runId: automation[0]!.runId,
    });

    // And the Routine now reports when it last ran.
    const after = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/routines`),
    )) as { routines: Array<{ lastRunAt?: string }> };
    expect(after.routines[0]?.lastRunAt).toBeTypeOf("string");

    // THE TRANSCRIPT. `GET /turns` is the visible-conversation projection, and
    // an automation Turn is not in the conversation: the list does not move,
    // and the run is reachable only through the Routine's run log above.
    const turns = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/turns`),
    )) as { runs: Array<Record<string, unknown>> };
    expect(turns.runs.length).toBe(before.runs.length);
    expect(
      turns.runs.find((run) => run.runId === automation[0]!.runId),
    ).toBeUndefined();
  });

  it("runs a Routine on demand and records the firing as manual", async () => {
    const userId = freshUserId("routines-run-now");
    const botId = "routines-run-now-bot";
    await provisionThroughGateway({ userId, botId });

    await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/routines`, {
        schemaVersion: 1,
        type: "routine/create",
        commandId: `create-${botId}`,
        botId,
        routineId: "brief",
        name: "Webhook brief",
        prompt: "Summarize overnight email.",
        trigger: { kind: "webhook" },
        timezone: "UTC",
      }),
    );

    const receipt = (await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/routines`, {
        schemaVersion: 1,
        type: "routine/run",
        commandId: `run-${botId}`,
        botId,
        routineId: "brief",
      }),
    )) as { status: string; fireId: string };
    // The command answers with the run id the firing will take, before it runs.
    expect(receipt).toMatchObject({ status: "fired" });

    // A manual firing is owed immediately, so the object may well have woken
    // itself already; driving the alarm is idempotent either way, and the
    // firing lands exactly once.
    await vi.waitFor(
      async () => {
        await runDurableObjectAlarm(botStub(userId, botId));
        const fired = (await storedRuns(userId, botId)).filter(
          (run) => run.admission?.origin?.routineId === "brief",
        );
        expect(fired).toHaveLength(1);
        expect(fired[0]).toMatchObject({
          runId: receipt.fireId,
          status: "completed",
          admission: { turnType: "automation", origin: { trigger: "manual" } },
        });
      },
      { timeout: 5_000, interval: 50 },
    );
  });
});
