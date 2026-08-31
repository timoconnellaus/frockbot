// The webhook door as the open internet reaches it: `SELF.fetch` with no
// session at all, through the gateway's pre-auth `publicRoute`, the real
// signature check, and the real Bot Durable Object.
//
// Every request here is anonymous. The key is the whole credential, and the
// only privileged thing this file does is read the durable run record — because
// what has to be proved is that a firing did or did not happen, and the client
// projection cannot say which Routine produced a run.
import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
  SELF,
} from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { mintRoutineHookTokenV1 } from "@frockbot/plugin-routines/hook";
import {
  expectJson,
  expectOkJson,
  freshUserId,
  ORIGIN,
  postAsUser,
  provisionThroughGateway,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

interface StoredRunProbe {
  runId: string;
  status: string;
  admission?: { origin?: { routineId: string; trigger: string } };
}

function botStub(userId: string, botId: string) {
  return env.BOT_STATES.get(env.BOT_STATES.idFromName(`${userId}:${botId}`));
}

async function automationRuns(
  userId: string,
  botId: string,
): Promise<StoredRunProbe[]> {
  const runs = await runInDurableObject(
    botStub(userId, botId),
    async (_instance, state) => [
      ...(
        await state.storage.list<StoredRunProbe>({ prefix: "run:" })
      ).values(),
    ],
  );
  return runs.filter((run) => run.admission?.origin?.routineId === "brief");
}

/** A delivery exactly as an external system makes it: no session, one key. */
function deliverHook(
  botId: string,
  token: string,
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return SELF.fetch(`${ORIGIN}/api/bots/${botId}/routines/brief/hook`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...headers,
    },
    body,
  });
}

async function webhookRoutine(label: string) {
  const userId = freshUserId(label);
  const botId = `${label}-bot`;
  await provisionThroughGateway({ userId, botId });
  const receipt = (await expectOkJson(
    await postAsUser(userId, `/api/bots/${botId}/routines`, {
      schemaVersion: 1,
      type: "routine/create",
      commandId: `create-${botId}`,
      botId,
      routineId: "brief",
      name: "Delivered brief",
      prompt: "Summarize the payload.",
      trigger: { kind: "webhook" },
      timezone: "UTC",
    }),
  )) as { hook?: { token: string; keyVersion: number; path: string } };
  // The key comes back once, on the creating receipt, with the path it is
  // presented against.
  expect(receipt.hook).toMatchObject({
    keyVersion: 1,
    path: `/api/bots/${botId}/routines/brief/hook`,
  });
  return { userId, botId, token: receipt.hook!.token };
}

describe("a webhook delivery through the gateway's public route", () => {
  it("refuses a forged key with 401 and fires nothing", async () => {
    const { userId, botId } = await webhookRoutine("hook-401");

    const forged = await mintRoutineHookTokenV1(
      "a-different-signing-secret-entirely",
      { u: userId, b: botId, r: "brief", v: 1 },
    );
    const refused = await deliverHook(botId, forged, "{}");
    expect(refused.status).toBe(401);
    expect(await expectJson(refused)).toMatchObject({
      error: "webhook key is invalid",
    });

    // A missing key, and a key for another Routine at this Routine's door.
    expect((await deliverHook(botId, "", "{}")).status).toBe(401);
    expect(
      (
        await deliverHook(
          botId,
          await mintRoutineHookTokenV1(env.ROUTINE_HOOK_SECRET, {
            u: userId,
            b: botId,
            r: "other",
            v: 1,
          }),
          "{}",
        )
      ).status,
    ).toBe(401);

    expect(await automationRuns(userId, botId)).toEqual([]);
  });

  it("accepts a good key, replays to the same firing, and runs once", async () => {
    const { userId, botId, token } = await webhookRoutine("hook-ok");

    const accepted = await deliverHook(botId, token, '{"event":"push"}');
    expect(accepted.status).toBe(202);
    const receipt = (await expectJson(accepted)) as {
      status: string;
      fireId: string;
    };
    expect(receipt.status).toBe("accepted");

    const replayed = await deliverHook(botId, token, '{"event":"push"}');
    expect(replayed.status).toBe(202);
    expect(await expectJson(replayed)).toMatchObject({
      status: "duplicate",
      fireId: receipt.fireId,
    });

    await vi.waitFor(
      async () => {
        await runDurableObjectAlarm(botStub(userId, botId));
        const runs = await automationRuns(userId, botId);
        expect(runs).toHaveLength(1);
        expect(runs[0]).toMatchObject({
          runId: receipt.fireId,
          status: "completed",
          admission: { origin: { trigger: "webhook" } },
        });
      },
      { timeout: 5_000, interval: 50 },
    );

    // A third delivery, after the firing has settled, is still the same one.
    const late = await deliverHook(botId, token, '{"event":"push"}');
    expect(await expectJson(late)).toMatchObject({
      status: "duplicate",
      fireId: receipt.fireId,
    });
    expect(await automationRuns(userId, botId)).toHaveLength(1);
  });

  it("answers a paused Routine with 409 rather than swallowing the delivery", async () => {
    const { userId, botId, token } = await webhookRoutine("hook-409");
    await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/routines`, {
        schemaVersion: 1,
        type: "routine/pause",
        commandId: `pause-${botId}`,
        botId,
        routineId: "brief",
      }),
    );

    const paused = await deliverHook(botId, token, "{}");
    expect(paused.status).toBe(409);
    expect(await expectJson(paused)).toMatchObject({
      error: "Routine is paused",
    });
    expect(await automationRuns(userId, botId)).toEqual([]);
  });

  it("answers a rotated-away key with 401 and a revoked one the same", async () => {
    const { userId, botId, token } = await webhookRoutine("hook-rotate");

    const rotated = (await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/routines`, {
        schemaVersion: 1,
        type: "routine/rotate-key",
        commandId: `rotate-${botId}`,
        botId,
        routineId: "brief",
      }),
    )) as { hook?: { token: string; keyVersion: number } };
    expect(rotated.hook?.keyVersion).toBe(2);

    // The first key's signature is still valid; the Bot's record is not.
    expect((await deliverHook(botId, token, "{}")).status).toBe(401);
    expect((await deliverHook(botId, rotated.hook!.token, "{}")).status).toBe(
      202,
    );

    await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/routines`, {
        schemaVersion: 1,
        type: "routine/revoke-key",
        commandId: `revoke-${botId}`,
        botId,
        routineId: "brief",
      }),
    );
    expect((await deliverHook(botId, rotated.hook!.token, "{}")).status).toBe(
      401,
    );
  });

  it("refuses a body over the cap, and never asks the Bot about it", async () => {
    const { userId, botId, token } = await webhookRoutine("hook-413");
    const oversized = await deliverHook(botId, token, "x".repeat(70_000));
    expect(oversized.status).toBe(413);
    expect(await automationRuns(userId, botId)).toEqual([]);
  });

  it("takes the caller's Idempotency-Key over the body", async () => {
    const { userId, botId, token } = await webhookRoutine("hook-idem");
    const first = (await expectJson(
      await deliverHook(botId, token, '{"a":1}', {
        "idempotency-key": "delivery-7",
      }),
    )) as { fireId: string };
    // A different body under the same key is the same delivery.
    expect(
      await expectJson(
        await deliverHook(botId, token, '{"a":2}', {
          "idempotency-key": "delivery-7",
        }),
      ),
    ).toMatchObject({ status: "duplicate", fireId: first.fireId });

    await vi.waitFor(
      async () => {
        await runDurableObjectAlarm(botStub(userId, botId));
        expect(await automationRuns(userId, botId)).toHaveLength(1);
      },
      { timeout: 5_000, interval: 50 },
    );
  });

  it("is a public route: it never needs, and never uses, a session", async () => {
    const { botId, token } = await webhookRoutine("hook-public");
    // No `x-frockbot-user-id`, which every other route in this suite requires.
    const anonymous = await SELF.fetch(
      `${ORIGIN}/api/bots/${botId}/routines/brief/hook`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: "{}",
      },
    );
    expect(anonymous.status).toBe(202);
    // The authenticated Routine routes still refuse an anonymous caller.
    expect(
      (await SELF.fetch(`${ORIGIN}/api/bots/${botId}/routines`)).status,
    ).toBe(401);
  });
});
