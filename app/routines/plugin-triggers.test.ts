// A Plugin-triggered Routine at the webhook door (ADR 0026 step 8): the
// same key, the same replay guard, and the Plugin asked between the checks
// and the firing.
import { describe, expect, test } from "bun:test";
import {
  mintRoutineHookTokenV1,
  routineDeliveryIdV1,
  routineHookDigestV1,
  routineHookHeadersV1,
  verifyRoutineHookTokenV1,
} from "./hook.js";
import { RoutineScheduler } from "./scheduler.js";
import { ROUTINE_DELIVERY_PREFIX } from "./storage-keys.js";
import {
  RoutineStore,
  type RoutinePluginTriggerDeliveryV1,
  type RoutinePluginTriggerSeamV1,
} from "./store.js";
import { createMemoryRoutineStorageV1 } from "./testing.js";
import type { RoutineCommandV1 } from "./shared.js";

const SECRET = "a-signing-secret-of-at-least-thirty-two-bytes";
const USER = { kind: "user" as const };

function harness(seam?: RoutinePluginTriggerSeamV1) {
  const storage = createMemoryRoutineStorageV1();
  const scheduler = new RoutineScheduler(storage);
  const store = new RoutineStore(storage, {
    firings: scheduler,
    hookKeys: {
      async mint({ routineId, keyVersion }) {
        const token = await mintRoutineHookTokenV1(SECRET, {
          u: "tim",
          b: "scout",
          r: routineId,
          v: keyVersion,
        });
        return {
          token,
          digest: await routineHookDigestV1(token),
          path: `/api/bots/scout/routines/${routineId}/hook`,
        };
      },
    },
    ...(seam ? { pluginTriggers: seam } : {}),
  });
  const create: RoutineCommandV1 = {
    schemaVersion: 1,
    type: "routine/create",
    commandId: "cmd-create",
    botId: "scout",
    routineId: "alerts",
    name: "Weather alerts",
    prompt: "Tell the User what the alert means.",
    trigger: { kind: "plugin", pluginId: "weather", trigger: "alert" },
  };
  return { storage, scheduler, store, create };
}

async function prepare(
  token: string,
  body: string,
  options: { idempotencyKey?: string; headers?: Record<string, string> } = {},
) {
  const claims = await verifyRoutineHookTokenV1(SECRET, token);
  return {
    routineId: claims.r,
    keyVersion: claims.v,
    digest: await routineHookDigestV1(token),
    deliveryId: await routineDeliveryIdV1(
      claims.r,
      body,
      options.idempotencyKey,
    ),
    body,
    contentType: "application/json",
    ...(options.headers ? { headers: options.headers } : {}),
  };
}

async function deliver(
  store: RoutineStore,
  token: string,
  body: string,
  options: { idempotencyKey?: string; headers?: Record<string, string> } = {},
) {
  return store.deliverHook(await prepare(token, body, options));
}

describe("a Plugin-triggered Routine", () => {
  test("is keyed like a webhook one, and the Plugin sees the delivery first", async () => {
    const seen: RoutinePluginTriggerDeliveryV1[] = [];
    const { scheduler, store, create } = harness({
      async deliver(input) {
        seen.push(input);
        return {
          status: "fire",
          text: `Storm warning for ${JSON.parse(input.body).city}`,
        };
      },
    });
    const receipt = await store.execute(create, USER, "UTC");
    expect(receipt).toMatchObject({ status: "applied" });
    const token = (receipt as { hook: { token: string } }).hook.token;

    const first = await deliver(store, token, '{"city":"Wollongong"}', {
      idempotencyKey: "evt-1",
      headers: { "x-signature": "abc", "content-type": "application/json" },
    });
    expect(first).toMatchObject({ status: "accepted" });
    expect(seen).toEqual([
      {
        routineId: "alerts",
        pluginId: "weather",
        trigger: "alert",
        headers: { "x-signature": "abc", "content-type": "application/json" },
        body: '{"city":"Wollongong"}',
      },
    ]);

    // The firing carries what the Plugin said, not the raw body.
    const cues: string[] = [];
    await scheduler.settle(async (fire) => {
      cues.push(fire.cue);
      expect(fire.trigger).toBe("webhook");
      return { status: "ok" };
    }, "UTC");
    expect(cues).toHaveLength(1);
    expect(cues[0]).toContain("Storm warning for Wollongong");
    expect(cues[0]).not.toContain('{"city":"Wollongong"}');

    // A replay answers with the firing already made and asks the Plugin
    // nothing twice.
    const again = await deliver(store, token, '{"city":"Wollongong"}', {
      idempotencyKey: "evt-1",
    });
    expect(again).toEqual({
      status: "duplicate",
      fireId: (first as { fireId: string }).fireId,
    });
    expect(seen).toHaveLength(1);
  });

  test("a drop is a receipt, never a firing, and a replay says why again", async () => {
    let asked = 0;
    const { scheduler, store, create } = harness({
      async deliver() {
        asked += 1;
        return { status: "drop", reason: "not for this Bot" };
      },
    });
    const token = (
      (await store.execute(create, USER, "UTC")) as { hook: { token: string } }
    ).hook.token;
    const dropped = await deliver(store, token, "{}", {
      idempotencyKey: "evt-2",
    });
    expect(dropped).toEqual({ status: "dropped", reason: "not for this Bot" });
    let fired = 0;
    await scheduler.settle(async () => {
      fired += 1;
      return { status: "ok" };
    }, "UTC");
    expect(fired).toBe(0);
    expect(
      await deliver(store, token, "{}", { idempotencyKey: "evt-2" }),
    ).toEqual({ status: "dropped", reason: "not for this Bot" });
    expect(asked).toBe(1);
  });

  test("with no Plugin seam the delivery is refused, never recorded", async () => {
    const { storage, store, create } = harness();
    const token = (
      (await store.execute(create, USER, "UTC")) as { hook: { token: string } }
    ).hook.token;
    await expect(deliver(store, token, "{}")).rejects.toMatchObject({
      status: 500,
      message: "this Bot cannot reach its Plugins",
    });
    expect((await storage.list({ prefix: ROUTINE_DELIVERY_PREFIX })).size).toBe(
      0,
    );
  });

  test("paused while the Plugin answers, the firing is refused", async () => {
    let entered = () => {};
    const asking = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { scheduler, store, create } = harness({
      async deliver() {
        entered();
        await held;
        return { status: "fire", text: "Storm warning" };
      },
    });
    const token = (
      (await store.execute(create, USER, "UTC")) as { hook: { token: string } }
    ).hook.token;
    const delivering = deliver(store, token, "{}", { idempotencyKey: "evt-3" });
    await asking;
    expect(
      await store.execute(
        {
          schemaVersion: 1,
          type: "routine/pause",
          commandId: "cmd-pause",
          botId: "scout",
          routineId: "alerts",
        },
        USER,
        "UTC",
      ),
    ).toMatchObject({ status: "applied" });
    release();
    await expect(delivering).rejects.toMatchObject({
      status: 409,
      message: "Routine is paused",
    });
    let fired = 0;
    await scheduler.settle(async () => {
      fired += 1;
      return { status: "ok" };
    }, "UTC");
    expect(fired).toBe(0);
  });

  test("two copies of one delivery ask the Plugin once", async () => {
    let asked = 0;
    let entered = () => {};
    const asking = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { scheduler, store, create } = harness({
      async deliver() {
        asked += 1;
        entered();
        await held;
        return { status: "fire", text: "Storm warning" };
      },
    });
    const token = (
      (await store.execute(create, USER, "UTC")) as { hook: { token: string } }
    ).hook.token;
    const input = await prepare(token, "{}", { idempotencyKey: "evt-4" });
    const first = store.deliverHook(input);
    await asking;
    const second = store.deliverHook(input);
    release();
    const [one, two] = await Promise.all([first, second]);
    expect(asked).toBe(1);
    expect(one).toMatchObject({ status: "accepted" });
    expect(two).toEqual({
      status: "duplicate",
      fireId: (one as { fireId: string }).fireId,
    });
    let fired = 0;
    await scheduler.settle(async () => {
      fired += 1;
      return { status: "ok" };
    }, "UTC");
    expect(fired).toBe(1);
  });

  test("a webhook Routine never asks a Plugin", async () => {
    let asked = 0;
    const { store, create } = harness({
      async deliver() {
        asked += 1;
        return { status: "drop" };
      },
    });
    const token = (
      (await store.execute(
        { ...create, routineId: "brief", trigger: { kind: "webhook" } },
        USER,
        "UTC",
      )) as { hook: { token: string } }
    ).hook.token;
    expect(await deliver(store, token, "{}")).toMatchObject({
      status: "accepted",
    });
    expect(asked).toBe(0);
  });
});

describe("the headers a Plugin trigger is shown", () => {
  test("keep what a sender signs with, never the door's credential", () => {
    expect(
      routineHookHeadersV1([
        ["Authorization", "Bearer key"],
        ["X-Routine-Key", "key"],
        ["Cookie", "a=b"],
        ["Host", "bot.example"],
        ["X-Signature", "sig"],
        ["Content-Type", "application/json"],
      ]),
    ).toEqual({ "x-signature": "sig", "content-type": "application/json" });
  });

  test("stop at the bound rather than carrying an unbounded set", () => {
    const kept = routineHookHeadersV1(
      Array.from({ length: 200 }, (_, index) => [
        `x-h-${index}`,
        "v".repeat(100),
      ]),
    );
    expect(Object.keys(kept).length).toBeLessThan(200);
    expect(Object.keys(kept).length).toBeGreaterThan(0);
  });
});
