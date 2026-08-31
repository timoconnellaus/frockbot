// The Routines routes as a browser reaches them: `SELF.fetch` through the real
// gateway, the real Package Contribution, and the real Bot Durable Object.
//
// Nothing fires. The claim is that the durable record, the command path and the
// projection agree, and that a Bot the caller does not own is not reachable.
import { describe, expect, it } from "vitest";
import {
  asUser,
  expectJson,
  expectOkJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

interface RoutineList {
  schemaVersion: 1;
  botId: string;
  routines: Array<{
    routineId: string;
    name: string;
    enabled: boolean;
    schedule?: string;
    trigger?: { kind: string };
    timezone: string;
    createdBy: { kind: string };
  }>;
}

function createCommand(botId: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    type: "routine/create",
    commandId: `create-${botId}`,
    botId,
    routineId: "brief",
    name: "Morning brief",
    prompt: "Summarize overnight email.",
    schedule: "0 7 * * *",
    timezone: "Australia/Sydney",
    ...overrides,
  };
}

describe("Routines round-trip through the gateway", () => {
  it("carries a created Routine from the command to the list", async () => {
    const userId = freshUserId("routines-create");
    const botId = "routines-bot";
    await provisionThroughGateway({ userId, botId });

    const receipt = await expectOkJson(
      await postAsUser(
        userId,
        `/api/bots/${botId}/routines`,
        createCommand(botId),
      ),
    );
    expect(receipt).toMatchObject({
      status: "applied",
      routine: { routineId: "brief", enabled: true },
    });

    const listed = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/routines`),
    )) as RoutineList;
    expect(listed.routines).toHaveLength(1);
    expect(listed.routines[0]).toMatchObject({
      name: "Morning brief",
      schedule: "0 7 * * *",
      timezone: "Australia/Sydney",
      enabled: true,
      createdBy: { kind: "user" },
    });

    // Nothing has fired, so the run log exists and is empty.
    expect(
      await expectOkJson(
        await asUser(userId, `/api/bots/${botId}/routines/brief/runs`),
      ),
    ).toMatchObject({ routineId: "brief", entries: [] });
  });

  it("pauses a Routine to enabled:false and resumes it", async () => {
    const userId = freshUserId("routines-pause");
    const botId = "routines-pause-bot";
    await provisionThroughGateway({ userId, botId });
    await expectOkJson(
      await postAsUser(
        userId,
        `/api/bots/${botId}/routines`,
        createCommand(botId),
      ),
    );

    await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/routines`, {
        schemaVersion: 1,
        type: "routine/pause",
        commandId: `pause-${botId}`,
        botId,
        routineId: "brief",
      }),
    );
    const paused = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/routines`),
    )) as RoutineList;
    expect(paused.routines[0]).toMatchObject({ enabled: false });

    await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/routines`, {
        schemaVersion: 1,
        type: "routine/resume",
        commandId: `resume-${botId}`,
        botId,
        routineId: "brief",
      }),
    );
    const resumed = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/routines`),
    )) as RoutineList;
    expect(resumed.routines[0]).toMatchObject({ enabled: true });
  });

  it("answers an invalid cron with 400 and the reason, writing nothing", async () => {
    const userId = freshUserId("routines-invalid");
    const botId = "routines-invalid-bot";
    await provisionThroughGateway({ userId, botId });

    const response = await postAsUser(
      userId,
      `/api/bots/${botId}/routines`,
      createCommand(botId, { schedule: "not a cron" }),
    );
    expect(response.status).toBe(400);
    expect(await expectJson(response)).toMatchObject({
      error: expect.stringContaining("five fields") as unknown as string,
    });

    const listed = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/routines`),
    )) as RoutineList;
    expect(listed.routines).toEqual([]);
  });

  it("refuses a Routine carrying both a schedule and a webhook trigger", async () => {
    const userId = freshUserId("routines-xor");
    const botId = "routines-xor-bot";
    await provisionThroughGateway({ userId, botId });

    const response = await postAsUser(
      userId,
      `/api/bots/${botId}/routines`,
      createCommand(botId, { trigger: { kind: "webhook" } }),
    );
    expect(response.status).toBe(400);
    expect(await expectJson(response)).toMatchObject({
      error: expect.stringContaining("never both") as unknown as string,
    });
  });

  it("does not reach another User's Bot", async () => {
    const ownerId = freshUserId("routines-owner");
    const intruderId = freshUserId("routines-intruder");
    const botId = "routines-owned-bot";
    await provisionThroughGateway({ userId: ownerId, botId });
    await expectOkJson(
      await postAsUser(
        ownerId,
        `/api/bots/${botId}/routines`,
        createCommand(botId),
      ),
    );

    const listed = await asUser(intruderId, `/api/bots/${botId}/routines`);
    expect(listed.status).toBe(404);
    const posted = await postAsUser(
      intruderId,
      `/api/bots/${botId}/routines`,
      createCommand(botId, { commandId: "intrusion" }),
    );
    expect(posted.status).toBe(404);

    // The owner's Routine is untouched.
    const owner = (await expectOkJson(
      await asUser(ownerId, `/api/bots/${botId}/routines`),
    )) as RoutineList;
    expect(owner.routines).toHaveLength(1);
  });
});
