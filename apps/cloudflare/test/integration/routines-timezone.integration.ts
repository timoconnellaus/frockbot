// The account zone, end to end: the Profile a browser saves, the Routine that
// was never asked for a zone, and the firing the Bot Durable Object arms for
// itself under whichever zone the account now names.
//
// Nothing here reaches past the gateway to make a zone move: the zone is saved
// through `/api/settings/application`, exactly as the Settings renderer saves
// it, and read back through the Routines list the panel draws.
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  asUser,
  botStateStubV1,
  dueAtWithFiringHeadroomV1,
  expectJson,
  expectOkJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  settledRoutineFiringV1,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

interface RoutinesListV1 {
  routines: Array<{ routineId: string; nextRunAt?: string }>;
}

interface StoredRunProbe {
  runId: string;
  status: string;
  admission?: { origin?: { routineId: string; trigger: string } };
}

/** The wall clock a moment shows on, in one zone: what a person reads. */
function wallClock(instant: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(instant));
}

async function profileRevision(userId: string): Promise<number> {
  return (
    (await expectOkJson(await asUser(userId, "/api/settings/application"))) as {
      revision: number;
    }
  ).revision;
}

async function saveTimezone(
  userId: string,
  commandId: string,
  timezone: string,
): Promise<Response> {
  return postAsUser(userId, "/api/settings/application", {
    schemaVersion: 1,
    commandId,
    expectedRevision: await profileRevision(userId),
    sectionId: "profile",
    ownerId: userId,
    values: { name: "Zone tester", timezone },
  });
}

async function savedTimezone(userId: string): Promise<unknown> {
  const frame = (await expectOkJson(
    await asUser(userId, "/api/settings/application"),
  )) as { sections: Array<{ fields: Array<{ id: string; value?: unknown }> }> };
  return frame.sections[0]!.fields.find((field) => field.id === "timezone")
    ?.value;
}

async function createDailyRoutine(
  userId: string,
  botId: string,
  routineId: string,
  schedule: string,
): Promise<void> {
  await expectOkJson(
    await postAsUser(userId, `/api/bots/${botId}/routines`, {
      schemaVersion: 1,
      type: "routine/create",
      commandId: `create-${routineId}`,
      botId,
      routineId,
      name: "Morning brief",
      prompt: "Summarize overnight email.",
      schedule,
    }),
  );
}

/**
 * The clock a Routine already fired under once, written the way the object
 * writes it. A clock is persisted only once a firing has been claimed, so a
 * test about what happens to an existing clock has to start from one.
 */
async function seedClockV1(
  userId: string,
  botId: string,
  routineId: string,
  clock: { timezone?: string; dueAt: number },
): Promise<void> {
  await runInDurableObject(
    botStateStubV1(userId, botId),
    async (_instance, state) => {
      const record = await state.storage.get<{ updatedAt: string }>(
        `routine:${routineId}`,
      );
      await state.storage.put(`routine-schedule:${routineId}`, {
        schemaVersion: 1,
        routineId,
        anchor: record!.updatedAt,
        ...(clock.timezone === undefined ? {} : { timezone: clock.timezone }),
        dueAt: clock.dueAt,
      });
    },
  );
}

async function storedClockV1(
  userId: string,
  botId: string,
  routineId: string,
): Promise<Record<string, unknown> | undefined> {
  return runInDurableObject(
    botStateStubV1(userId, botId),
    async (_instance, state) =>
      state.storage.get<Record<string, unknown>>(
        `routine-schedule:${routineId}`,
      ),
  );
}

async function nextRunAt(
  userId: string,
  botId: string,
  routineId: string,
): Promise<string> {
  const listed = (await expectOkJson(
    await asUser(userId, `/api/bots/${botId}/routines`),
  )) as RoutinesListV1;
  const routine = listed.routines.find((one) => one.routineId === routineId);
  if (typeof routine?.nextRunAt !== "string") {
    throw new Error(`no next run for ${routineId}: ${JSON.stringify(listed)}`);
  }
  return routine.nextRunAt;
}

describe("a Routine keeps the account's clock", () => {
  it("moves a daily Routine's next run when the Profile zone moves", async () => {
    const userId = freshUserId("routine-zone");
    const botId = "routine-zone-bot";
    await provisionThroughGateway({ userId, botId });

    // The create command carries no zone at all: the Routine shape has none.
    await createDailyRoutine(userId, botId, "brief", "0 9 * * *");
    const underUtc = await nextRunAt(userId, botId, "brief");
    expect(wallClock(underUtc, "UTC")).toBe("09:00");

    const receipt = (await expectOkJson(
      await saveTimezone(userId, "zone-sydney", "Australia/Sydney"),
    )) as { status: string };
    expect(receipt.status).toBe("applied");

    const underSydney = await nextRunAt(userId, botId, "brief");
    expect(underSydney).not.toBe(underUtc);
    // 09:00 is now 09:00 where the account lives, and no longer 09:00 in UTC.
    expect(wallClock(underSydney, "Australia/Sydney")).toBe("09:00");
    expect(wallClock(underSydney, "UTC")).not.toBe("09:00");

    // And it is still 09:00 Sydney on the read after that: a rezoned clock is
    // persisted once rather than recomputed forward on every evaluation.
    const again = await nextRunAt(userId, botId, "brief");
    expect(again).toBe(underSydney);
  });

  it("refuses a crafted zone and keeps the one already saved", async () => {
    const userId = freshUserId("routine-zone-bad");
    await expectOkJson(await saveTimezone(userId, "zone-good", "US/Eastern"));
    // An alias the catalog does not list is a real zone, and is kept.
    expect(await savedTimezone(userId)).toBe("US/Eastern");

    for (const [index, crafted] of [
      "+05:00",
      "+0530",
      "Sydney-ish",
      "; DROP TABLE zones",
      "",
    ].entries()) {
      const refused = await saveTimezone(userId, `crafted-${index}`, crafted);
      expect({ crafted, status: refused.status }).toMatchObject({
        status: 400,
      });
      await expectJson(refused);
    }
    expect(await savedTimezone(userId)).toBe("US/Eastern");
  });

  it("fires a rezoned Routine once its occurrence arrives", async () => {
    const userId = freshUserId("routine-zone-fire");
    const botId = "routine-zone-fire-bot";
    await provisionThroughGateway({ userId, botId });
    await createDailyRoutine(userId, botId, "brief", "* * * * *");
    // A Routine that has run once under the old zone: its clock is written.
    await seedClockV1(userId, botId, "brief", {
      timezone: "UTC",
      dueAt: Date.now() + 3_600_000,
    });

    await expectOkJson(
      await saveTimezone(userId, "zone-sydney", "Australia/Sydney"),
    );

    // The rebuilt clock is durable, not recomputed forward on every look: read
    // twice, and the same due time comes back under the new zone.
    const rezoned = await storedClockV1(userId, botId, "brief");
    expect(rezoned).toMatchObject({ timezone: "Australia/Sydney" });
    await nextRunAt(userId, botId, "brief");
    expect(await storedClockV1(userId, botId, "brief")).toEqual(rezoned);

    // The occurrence arrives. Only `dueAt` is wound back — the clock the Bot
    // rebuilt for the new zone is the one that has to be claimable.
    const dueAt = await dueAtWithFiringHeadroomV1();
    await runInDurableObject(
      botStateStubV1(userId, botId),
      async (_instance, state) => {
        const clock = await state.storage.get<Record<string, unknown>>(
          "routine-schedule:brief",
        );
        await state.storage.put("routine-schedule:brief", { ...clock, dueAt });
      },
    );

    expect(
      await settledRoutineFiringV1<StoredRunProbe>(userId, botId),
    ).toMatchObject({
      status: "completed",
      admission: { origin: { routineId: "brief", trigger: "cron" } },
    });
  });

  it("keeps listing and firing when a Routine was stored under the retired shapes", async () => {
    const userId = freshUserId("routine-zone-legacy");
    const botId = "routine-zone-legacy-bot";
    await provisionThroughGateway({ userId, botId });
    await createDailyRoutine(userId, botId, "brief", "* * * * *");

    const dueAt = await dueAtWithFiringHeadroomV1();
    await runInDurableObject(
      botStateStubV1(userId, botId),
      async (_instance, state) => {
        const healthy =
          await state.storage.get<Record<string, unknown>>("routine:brief");
        // A Routine written by the previous release: the zone lives on the
        // record and the schedule carries the retired `CRON_TZ=` prefix.
        await state.storage.put("routine:legacy", {
          ...healthy,
          routineId: "legacy",
          name: "Legacy brief",
          schedule: "CRON_TZ=Australia/Sydney 0 9 * * *",
          timezone: "Australia/Sydney",
        });
      },
    );
    // And a clock written before the account owned the zone: no `timezone`.
    await seedClockV1(userId, botId, "brief", { dueAt });

    // The list still opens, and still answers for the Routine this deploy can
    // read; the unreadable one costs itself a next run and nothing else.
    const listed = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/routines`),
    )) as RoutinesListV1;
    expect(
      listed.routines.find((one) => one.routineId === "brief")?.nextRunAt,
    ).toBeTypeOf("string");
    // The legacy Routine is still shown — its record decodes, its retired
    // `timezone` is ignored — and only its own next run is missing.
    expect(listed.routines.map((one) => one.routineId).sort()).toEqual([
      "brief",
      "legacy",
    ]);
    expect(
      listed.routines.find((one) => one.routineId === "legacy")?.nextRunAt,
    ).toBeUndefined();

    // The Bot still settles Turns and still fires: one poisoned Routine never
    // costs the object its alarm.
    expect(
      await settledRoutineFiringV1<StoredRunProbe>(userId, botId),
    ).toMatchObject({
      status: "completed",
      admission: { origin: { routineId: "brief", trigger: "cron" } },
    });
  });
});
