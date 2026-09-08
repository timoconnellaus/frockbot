import { describe, expect, test } from "bun:test";
import {
  constantTimeEqualsV1,
  decodeRoutineHookDeliveryV1,
  mintRoutineHookTokenV1,
  renderRoutineDeliveryV1,
  routineDeliveryIdV1,
  routineHookDigestV1,
  RoutineHookError,
  verifyRoutineHookTokenV1,
  ROUTINE_HOOK_CUE_MAX_BYTES,
} from "./hook.js";
import { RoutineScheduler } from "./scheduler.js";
import { RoutineStore } from "./store.js";
import { createMemoryRoutineStorageV1 } from "./testing.js";
import type { RoutineCommandV1 } from "./shared.js";

const SECRET = "a-signing-secret-long-enough-to-be-a-secret";
const CLAIMS = { u: "tim", b: "scout", r: "brief", v: 1 } as const;
const USER = { kind: "user" } as const;

describe("the hook token", () => {
  test("verifies a token it minted, and returns its claims", async () => {
    const token = await mintRoutineHookTokenV1(SECRET, CLAIMS);
    expect(await verifyRoutineHookTokenV1(SECRET, token)).toEqual({
      ...CLAIMS,
    });
  });

  test("is deterministic, so it never has to be stored", async () => {
    expect(await mintRoutineHookTokenV1(SECRET, CLAIMS)).toBe(
      await mintRoutineHookTokenV1(SECRET, CLAIMS),
    );
  });

  test("refuses a tampered payload, signature, or secret", async () => {
    const token = await mintRoutineHookTokenV1(SECRET, CLAIMS);
    const [payload, signature] = token.split(".") as [string, string];
    const forgedPayload = `${await mintRoutineHookTokenV1(SECRET, {
      ...CLAIMS,
      r: "other",
    }).then((other) => other.split(".")[0])}.${signature}`;

    for (const bad of [
      forgedPayload,
      `${payload}.${signature.slice(0, -2)}AA`,
      `${payload}.`,
      payload,
      "",
      "not-a-token",
    ]) {
      await expect(verifyRoutineHookTokenV1(SECRET, bad)).rejects.toThrow(
        /webhook key is invalid/,
      );
    }
    await expect(
      verifyRoutineHookTokenV1(`${SECRET}-different`, token),
    ).rejects.toThrow(/webhook key is invalid/);
  });

  test("refuses to sign or verify without a real secret", async () => {
    await expect(mintRoutineHookTokenV1("", CLAIMS)).rejects.toThrow(
      /ROUTINE_HOOK_SECRET/,
    );
    const refusal = await verifyRoutineHookTokenV1("short", "a.b").catch(
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(RoutineHookError);
    // A door that was never given a key is unavailable, not broken, and the
    // caller is told that and nothing more: the reason names the deployment's
    // secret variable and stays in the log.
    expect((refusal as RoutineHookError).status).toBe(503);
    expect((refusal as RoutineHookError).message).toContain(
      "ROUTINE_HOOK_SECRET",
    );
    expect((refusal as RoutineHookError).publicMessage).toBe(
      "webhook delivery is not configured",
    );
    expect((refusal as RoutineHookError).publicMessage).not.toContain(
      "ROUTINE_HOOK_SECRET",
    );
  });

  test("a key version is part of the token, so a rotation is a new token", async () => {
    expect(await mintRoutineHookTokenV1(SECRET, CLAIMS)).not.toBe(
      await mintRoutineHookTokenV1(SECRET, { ...CLAIMS, v: 2 }),
    );
    expect(
      (
        await verifyRoutineHookTokenV1(
          SECRET,
          await mintRoutineHookTokenV1(SECRET, { ...CLAIMS, v: 2 }),
        )
      ).v,
    ).toBe(2);
  });

  test("compares in constant time, and still compares correctly", () => {
    expect(constantTimeEqualsV1("abc", "abc")).toBe(true);
    expect(constantTimeEqualsV1("abc", "abd")).toBe(false);
    expect(constantTimeEqualsV1("abc", "abcd")).toBe(false);
    expect(constantTimeEqualsV1("", "")).toBe(true);
  });
});

describe("delivery identity", () => {
  test("is unique per request when the caller sent no idempotency key", async () => {
    // Two real events with the same payload are two deliveries. Hashing the
    // body used to turn the second one into a `duplicate` receipt and no
    // firing, with nothing anywhere saying an event had been swallowed.
    expect(await routineDeliveryIdV1("brief", '{"ping":true}')).not.toBe(
      await routineDeliveryIdV1("brief", '{"ping":true}'),
    );
    expect(await routineDeliveryIdV1("brief", "{}")).not.toBe(
      await routineDeliveryIdV1("other", "{}"),
    );
  });

  test("is the caller's key when it sent one, whatever the body says", async () => {
    expect(await routineDeliveryIdV1("brief", "{}", "abc")).toBe(
      await routineDeliveryIdV1("brief", '{"different":true}', "abc"),
    );
    expect(await routineDeliveryIdV1("brief", "{}", "abc")).not.toBe(
      await routineDeliveryIdV1("brief", "{}", "def"),
    );
  });
});

describe("the delivery rendering", () => {
  test("truncates at 4 KiB and says so", () => {
    const rendered = renderRoutineDeliveryV1("x".repeat(10_000), "text/plain");
    expect(rendered).toContain("(text/plain)");
    expect(rendered).toContain("truncated at 4096 bytes");
    expect(rendered.length).toBeLessThan(ROUTINE_HOOK_CUE_MAX_BYTES + 200);
  });

  test("leaves a small body whole", () => {
    expect(renderRoutineDeliveryV1('{"ok":true}')).toContain('{"ok":true}');
  });
});

describe("the delivery codec", () => {
  test("refuses anything that is not exactly a delivery", () => {
    const valid = {
      routineId: "brief",
      keyVersion: 1,
      digest: "a".repeat(64),
      deliveryId: "b".repeat(64),
      body: "{}",
    };
    expect(decodeRoutineHookDeliveryV1(valid)).toEqual(valid);
    for (const bad of [
      { ...valid, keyVersion: 0 },
      { ...valid, digest: "not-a-digest" },
      { ...valid, deliveryId: "short" },
      { ...valid, routineId: "" },
      { ...valid, body: 1 },
      { ...valid, extra: true },
    ]) {
      expect(() => decodeRoutineHookDeliveryV1(bad)).toThrow();
    }
  });
});

function harness() {
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
  });
  const create: RoutineCommandV1 = {
    schemaVersion: 1,
    type: "routine/create",
    commandId: "cmd-create",
    botId: "scout",
    routineId: "brief",
    name: "Delivered brief",
    prompt: "Summarize the payload.",
    trigger: { kind: "webhook" },
    timezone: "UTC",
  };
  return { storage, scheduler, store, create };
}

async function deliver(
  store: RoutineStore,
  token: string,
  body: string,
  idempotencyKey?: string,
) {
  const claims = await verifyRoutineHookTokenV1(SECRET, token);
  return store.deliverHook({
    routineId: claims.r,
    keyVersion: claims.v,
    digest: await routineHookDigestV1(token),
    deliveryId: await routineDeliveryIdV1(claims.r, body, idempotencyKey),
    body,
    contentType: "application/json",
  });
}

describe("the durable half of the check", () => {
  test("mints a key once, on the receipt and nowhere else", async () => {
    const { store, create } = harness();
    const receipt = await store.execute(create, USER);
    expect(receipt).toMatchObject({ status: "applied" });
    const minted = receipt.status === "applied" ? receipt.hook : undefined;
    expect(minted).toMatchObject({
      routineId: "brief",
      keyVersion: 1,
      path: "/api/bots/scout/routines/brief/hook",
    });

    // A replay of the same command id answers without the key: a key a replay
    // could re-read would not be a secret.
    const replay = await store.execute(create, USER);
    expect(replay.status === "applied" && replay.hook).toBeUndefined();

    // The listing says a key exists and never what it is.
    const listed = await store.list("scout");
    expect(listed.routines[0]).toMatchObject({ hookKeyVersion: 1 });
    expect(JSON.stringify(listed)).not.toContain(minted!.token);
    // And the durable record holds a digest, not the token.
    const key = await store.readHookKey("brief");
    expect(key?.digest).toBe(await routineHookDigestV1(minted!.token));
    expect(JSON.stringify(key)).not.toContain(minted!.token);
  });

  test("accepts a good key once and answers a replay with the same firing", async () => {
    const { scheduler, store, create } = harness();
    const receipt = await store.execute(create, USER);
    const token = (receipt as { hook: { token: string } }).hook.token;

    // A replay is a delivery the caller itself said was the same one, by
    // sending the key twice.
    const first = await deliver(store, token, '{"event":"push"}', "evt-1");
    expect(first.status).toBe("accepted");
    const second = await deliver(store, token, '{"event":"push"}', "evt-1");
    expect(second).toEqual({ status: "duplicate", fireId: first.fireId });

    const fired: string[] = [];
    await scheduler.settle(async (fire) => {
      fired.push(fire.fireId);
      expect(fire.trigger).toBe("webhook");
      expect(fire.cue).toContain('{"event":"push"}');
      return { status: "ok" };
    });
    expect(fired).toEqual([first.fireId]);
  });

  test("two distinct deliveries with identical bodies are two firings", async () => {
    const { scheduler, store, create } = harness();
    const receipt = await store.execute(create, USER);
    const token = (receipt as { hook: { token: string } }).hook.token;

    // A provider that sends `{"event":"push"}` twice sent two events. Without
    // an `Idempotency-Key` nothing has claimed they are the same delivery, and
    // the second used to be answered `duplicate` and never fired — a swallowed
    // event with no trace anywhere.
    const first = await deliver(store, token, '{"event":"push"}');
    const second = await deliver(store, token, '{"event":"push"}');
    expect(first.status).toBe("accepted");
    expect(second.status).toBe("accepted");
    expect(second.fireId).not.toBe(first.fireId);

    const fired: string[] = [];
    await scheduler.settle(async (fire) => {
      fired.push(fire.fireId);
      return { status: "ok" };
    });
    expect(fired.sort()).toEqual([first.fireId, second.fireId].sort());
  });

  test("a rotated key retires the one before it", async () => {
    const { store, create } = harness();
    const created = await store.execute(create, USER);
    const old = (created as { hook: { token: string } }).hook.token;

    const rotated = await store.execute(
      {
        schemaVersion: 1,
        type: "routine/rotate-key",
        commandId: "cmd-rotate",
        botId: "scout",
        routineId: "brief",
      },
      USER,
    );
    const fresh = (rotated as { hook: { token: string; keyVersion: number } })
      .hook;
    expect(fresh.keyVersion).toBe(2);

    // The old key still carries a perfectly good signature, and is refused
    // anyway: the durable record is the authority.
    await expect(deliver(store, old, "{}")).rejects.toThrow(
      /webhook key is invalid/,
    );
    expect((await deliver(store, fresh.token, "{}")).status).toBe("accepted");
  });

  test("a revoked key leaves the door shut", async () => {
    const { store, create } = harness();
    const created = await store.execute(create, USER);
    const token = (created as { hook: { token: string } }).hook.token;

    await store.execute(
      {
        schemaVersion: 1,
        type: "routine/revoke-key",
        commandId: "cmd-revoke",
        botId: "scout",
        routineId: "brief",
      },
      USER,
    );
    await expect(deliver(store, token, "{}")).rejects.toThrow(
      /webhook key is invalid/,
    );
    expect(
      (await store.list("scout")).routines[0]?.hookKeyVersion,
    ).toBeUndefined();
  });

  test("a paused Routine says so, and an unknown one does not", async () => {
    const { store, create } = harness();
    const created = await store.execute(create, USER);
    const token = (created as { hook: { token: string } }).hook.token;

    await store.execute(
      {
        schemaVersion: 1,
        type: "routine/pause",
        commandId: "cmd-pause",
        botId: "scout",
        routineId: "brief",
      },
      USER,
    );
    const paused = await deliver(store, token, "{}").catch(
      (error: unknown) => error,
    );
    expect((paused as RoutineHookError).status).toBe(409);

    await store.execute(
      {
        schemaVersion: 1,
        type: "routine/delete",
        commandId: "cmd-delete",
        botId: "scout",
        routineId: "brief",
      },
      USER,
    );
    const gone = await deliver(store, token, "{}").catch(
      (error: unknown) => error,
    );
    expect((gone as RoutineHookError).status).toBe(404);
  });

  test("a wrong key version is refused even with the right digest", async () => {
    const { store, create } = harness();
    const created = await store.execute(create, USER);
    const token = (created as { hook: { token: string } }).hook.token;
    const refusal = await store
      .deliverHook({
        routineId: "brief",
        keyVersion: 2,
        digest: await routineHookDigestV1(token),
        deliveryId: "c".repeat(64),
        body: "{}",
      })
      .catch((error: unknown) => error);
    expect((refusal as RoutineHookError).status).toBe(401);
  });

  test("a caller's idempotency key collapses two different bodies into one firing", async () => {
    const { scheduler, store, create } = harness();
    const created = await store.execute(create, USER);
    const token = (created as { hook: { token: string } }).hook.token;

    const first = await deliver(store, token, '{"a":1}', "delivery-7");
    const second = await deliver(store, token, '{"a":2}', "delivery-7");
    expect(second).toEqual({ status: "duplicate", fireId: first.fireId });

    let fired = 0;
    await scheduler.settle(() => {
      fired += 1;
      return Promise.resolve({ status: "ok" as const });
    });
    expect(fired).toBe(1);
  });

  test("a Bot with no signing secret records the Routine and refuses the key", async () => {
    const storage = createMemoryRoutineStorageV1();
    const scheduler = new RoutineScheduler(storage);
    const store = new RoutineStore(storage, { firings: scheduler });
    const { create } = harness();

    const receipt = await store.execute(create, USER);
    expect(receipt.status === "applied" && receipt.hook).toBeUndefined();
    expect((await store.list("scout")).routines).toHaveLength(1);
    await expect(
      store.execute(
        {
          schemaVersion: 1,
          type: "routine/rotate-key",
          commandId: "cmd-rotate",
          botId: "scout",
          routineId: "brief",
        },
        USER,
      ),
    ).rejects.toThrow(/ROUTINE_HOOK_SECRET/);
  });
});
