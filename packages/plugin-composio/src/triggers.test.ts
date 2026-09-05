import { expect, test } from "bun:test";
import type { ConnectionView } from "@frockbot/configuration-core";
import type { RoutineSubscriptionIntentV1 } from "@frockbot/connection-core";
import type { ComposioStorage } from "./user-configuration.js";
import { ComposioClient } from "./composio-client.js";
import { ComposioTriggerSubscriptions } from "./triggers.js";

function fixture() {
  const values = new Map<string, unknown>();
  const storage: ComposioStorage = {
    get: async <T>(key: string) =>
      structuredClone(values.get(key)) as T | undefined,
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      if (typeof key === "string") values.set(key, structuredClone(value));
      else
        for (const [name, item] of Object.entries(key))
          values.set(name, structuredClone(item));
    },
    setAlarm: async () => {},
    getAlarm: async () => null,
    transaction: async (fn) => fn(storage),
  };
  let state: ConnectionView["state"] = "ready";
  let currentAccountId = "ca_one";
  let normalizedConfig: Record<string, unknown> = {};
  let refuseCreate = false;
  let instance:
    | { id: string; connected_account_id: string; disabled_at: string | null }
    | undefined;
  const mutations: string[] = [],
    deliveries: unknown[] = [];
  let beforeRead: (() => Promise<void>) | undefined;
  let beforeReadResponse: (() => Promise<void>) | undefined;
  let beforeDelete: (() => Promise<void>) | undefined;
  let beforeCreateResponse: (() => Promise<void>) | undefined;
  let beforeAccount: (() => Promise<void>) | undefined;
  let loseCreateResponse = false,
    loseDeliveryResponse = false;
  const client = new ComposioClient({
    apiKey: "secret",
    fetch: async (url, init) => {
      const path = new URL(String(url)).pathname.replace("/api/v3.1", "");
      if (path.startsWith("/connected_accounts/")) {
        const wait = beforeAccount;
        beforeAccount = undefined;
        await wait?.();
        return Response.json({
          id: path.split("/").at(-1)!,
          user_id: "owner",
          alias: "connection-one",
          status: path.endsWith(currentAccountId) ? "ACTIVE" : "REVOKED",
          toolkit: { slug: "gmail" },
        });
      }
      if (path === "/triggers_types")
        return Response.json({
          items: [
            {
              slug: "GMAIL_NEW_GMAIL_MESSAGE",
              name: "New email in Gmail",
              description: "A new email arrives",
              toolkit: { slug: "gmail" },
              config: {},
              version: "20260905_00",
            },
          ],
        });
      if (path === "/trigger_instances/active") {
        const wait = beforeRead;
        beforeRead = undefined;
        await wait?.();
        const response = Response.json({
          items:
            instance &&
            instance.connected_account_id ===
              new URL(String(url)).searchParams.get("connected_account_ids")
              ? [
                  {
                    ...instance,
                    trigger_name: "GMAIL_NEW_GMAIL_MESSAGE",
                    trigger_config: normalizedConfig,
                  },
                ]
              : [],
        });
        const respond = beforeReadResponse;
        beforeReadResponse = undefined;
        await respond?.();
        return response;
      }
      mutations.push(init?.method ?? "GET");
      expect(
        [...values.entries()].some(
          ([key, value]) =>
            key.startsWith("composio:trigger-effect:") &&
            (value as { status: string }).status === "intent",
        ),
      ).toBe(true);
      if (init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toMatchObject({
          connected_account_id: currentAccountId,
          trigger_config: expect.any(Object),
          toolkit_versions: { gmail: "20260905_00" },
        });
        if (refuseCreate) return Response.json({}, { status: 422 });
        instance = {
          id: currentAccountId === "ca_one" ? "ti_one" : "ti_two",
          connected_account_id: currentAccountId,
          disabled_at: null,
        };
        const wait = beforeCreateResponse;
        beforeCreateResponse = undefined;
        await wait?.();
        if (loseCreateResponse) throw new Error("response lost");
        return Response.json({ trigger_id: instance.id });
      }
      if (init?.method === "DELETE") {
        const wait = beforeDelete;
        beforeDelete = undefined;
        await wait?.();
        instance = undefined;
      } else if (instance)
        instance.disabled_at =
          JSON.parse(String(init?.body)).status === "disable"
            ? "2026-09-05T00:00:00Z"
            : null;
      return Response.json({ status: "success" });
    },
  });
  const make = () =>
    new ComposioTriggerSubscriptions({
      storage,
      client,
      webhookConfigured: true,
      connections: async () => [
        {
          connectionId: "connection-one",
          packageId: "composio",
          connectionTypeId: "app",
          displayName: "Work",
          state,
          generation: state,
          safeMetadata: {
            connectedAccountId: currentAccountId,
            toolkitSlug: "gmail",
            toolkitName: "Gmail",
          },
        },
      ],
      deliver: async (_user, botId, input) => {
        deliveries.push({ botId, ...input });
        if (loseDeliveryResponse) {
          loseDeliveryResponse = false;
          throw new Error("delivery response lost");
        }
        return { status: "accepted" };
      },
    });
  return {
    make,
    beforeReadResponse: (wait: () => Promise<void>) => {
      beforeReadResponse = wait;
    },
    beforeDelete: (wait: () => Promise<void>) => {
      beforeDelete = wait;
    },
    reconnect: () => {
      state = "ready";
      currentAccountId = "ca_two";
    },
    beforeCreateResponse: (wait: () => Promise<void>) => {
      beforeCreateResponse = wait;
    },
    normalize: (config: Record<string, unknown>) => {
      normalizedConfig = config;
    },
    refuseCreate: (refuse: boolean) => {
      refuseCreate = refuse;
    },
    beforeAccount: (wait: () => Promise<void>) => {
      beforeAccount = wait;
    },
    beforeRead: (wait: () => Promise<void>) => {
      beforeRead = wait;
    },
    mutations,
    deliveries,
    values,
    drop: () => {
      instance = undefined;
    },
    revoke: () => {
      state = "revoked";
    },
    loseCreate: () => {
      loseCreateResponse = true;
    },
    loseDelivery: () => {
      loseDeliveryResponse = true;
    },
  };
}
function intent(
  id: string,
  revision = 1,
  enabled = true,
  deleted = false,
): RoutineSubscriptionIntentV1 {
  return {
    schemaVersion: 1,
    subscriptionId: id,
    routineId: `routine-${id}`,
    revision,
    enabled,
    deleted,
    trigger: {
      connectionId: "connection-one",
      triggerType: "GMAIL_NEW_GMAIL_MESSAGE",
      config: {},
    },
  };
}
const event = {
  schemaVersion: 1 as const,
  eventId: "msg_one",
  accountId: "ca_one",
  triggerId: "ti_one",
  triggerType: "GMAIL_NEW_GMAIL_MESSAGE",
  data: { subject: "Hello" },
};
test("two Bots share a provider instance; pause and deletion preserve another Routine's subscription", async () => {
  const f = fixture();
  await f.make().sync("owner", "bot-one", intent("one"));
  await f.make().sync("owner", "bot-two", intent("two"));
  expect(f.mutations).toEqual(["POST"]);
  await f.make().sync("owner", "bot-one", intent("one", 2, false));
  expect(f.mutations).toEqual(["POST"]);
  await f.make().receive("owner", event);
  expect(f.deliveries).toHaveLength(1);
  expect(f.deliveries[0]).toMatchObject({
    botId: "bot-two",
    routineId: "routine-two",
    body: '{"subject":"Hello"}',
  });
  await f.make().receive("owner", event);
  expect(f.deliveries).toHaveLength(1);
  await f.make().sync("owner", "bot-two", intent("two", 2, false));
  expect(f.mutations).toEqual(["POST", "PATCH"]);
  await f.make().sync("owner", "bot-one", intent("one", 3, false, true));
  expect(f.mutations).toEqual(["POST", "PATCH"]);
  await f.make().sync("owner", "bot-two", intent("two", 3, false, true));
  expect(f.mutations).toEqual(["POST", "PATCH", "DELETE"]);
});
test("a provider-dropped listener is visible on read and repaired only by an explicit Routine change", async () => {
  const f = fixture();
  await f.make().sync("owner", "bot", intent("one"));
  f.drop();
  expect(
    (await f.make().statuses("owner", "bot", { "routine-one": "one" }))[
      "routine-one"
    ]?.status,
  ).toBe("missing");
  expect(f.mutations).toEqual(["POST"]);
  await f.make().sync("owner", "bot", intent("one", 2));
  expect(f.mutations).toEqual(["POST", "POST"]);
});
test("an interrupted provider create reconciles after reconstruction without a second create", async () => {
  const f = fixture();
  f.loseCreate();
  await f.make().sync("owner", "bot", intent("one"));
  for (const [key, value] of f.values)
    if (key.startsWith("composio:trigger-group:"))
      f.values.set(key, { ...(value as object), leaseUntil: 0 });
  await f.make().alarm("owner");
  expect(f.mutations).toEqual(["POST"]);
  expect(
    (await f.make().statuses("owner", "bot", { "routine-one": "one" }))[
      "routine-one"
    ]?.status,
  ).toBe("active");
});
test("an interrupted event retries the same opaque Bot admission id, and revocation deletes its listeners", async () => {
  const f = fixture();
  await f.make().sync("owner", "bot", intent("one"));
  f.loseDelivery();
  await expect(f.make().receive("owner", event)).rejects.toThrow();
  await f.make().alarm("owner");
  expect(f.deliveries).toHaveLength(2);
  expect(f.deliveries[0]).toEqual(f.deliveries[1]);
  await f.make().receive("owner", event);
  expect(f.deliveries).toHaveLength(2);
  f.revoke();
  await f.make().removeConnection("owner", "connection-one");
  expect(f.mutations.at(-1)).toBe("DELETE");
});

test("a last-subscriber deletion cannot overtake a new subscriber while provider reconciliation is suspended", async () => {
  const f = fixture();
  await f.make().sync("owner", "bot-one", intent("one"));
  let release!: () => void, entered!: () => void;
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.beforeRead(async () => {
    entered();
    await gate;
  });
  const deletion = f
    .make()
    .sync("owner", "bot-one", intent("one", 2, false, true));
  await reading;
  await f.make().sync("owner", "bot-two", intent("two"));
  release();
  await deletion;
  await f.make().alarm("owner");
  expect(f.mutations).toEqual(["POST"]);
  expect(
    (await f.make().statuses("owner", "bot-two", { "routine-two": "two" }))[
      "routine-two"
    ]?.status,
  ).toBe("active");
});
test("pausing an existing listener succeeds after its Connection becomes unavailable", async () => {
  const f = fixture();
  await f.make().sync("owner", "bot", intent("one"));
  f.revoke();
  await f.make().sync("owner", "bot", intent("one", 2, false));
  expect(f.mutations).toEqual(["POST", "DELETE"]);
});

test("a deletion that reaches the User before a suspended create leaves a tombstone the older create cannot cross", async () => {
  const f = fixture();
  let release!: () => void, entered!: () => void;
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.beforeAccount(async () => {
    entered();
    await gate;
  });
  const create = f.make().sync("owner", "bot", intent("one"));
  await reading;
  await f.make().sync("owner", "bot", intent("one", 2, false, true));
  release();
  await create;
  expect(f.mutations).toEqual([]);
  expect(f.values.get("composio:subscription:one")).toMatchObject({
    intent: { revision: 2, deleted: true },
  });
});

test("normalized provider configs route by durable instance IDs and shared IDs keep every enabled subscriber alive", async () => {
  const f = fixture();
  f.normalize({ label: "INBOX" });
  await f.make().sync("owner", "bot-one", intent("one"));
  await f.make().receive("owner", event);
  expect(f.deliveries).toHaveLength(1);
  const other = {
    ...intent("two"),
    trigger: {
      ...intent("two").trigger!,
      config: { label: "INBOX", another_default: true },
    },
  };
  await f.make().sync("owner", "bot-two", other);
  expect(f.mutations).toEqual(["POST", "POST"]);
  await f.make().sync("owner", "bot-one", intent("one", 2, false));
  await f.make().sync("owner", "bot-one", intent("one", 3, false, true));
  expect(f.mutations).toEqual(["POST", "POST"]);
  await f.make().receive("owner", { ...event, eventId: "msg_two" });
  expect(f.deliveries.at(-1)).toMatchObject({ botId: "bot-two" });
  await f.make().removeBot("owner", "bot-two");
  expect(f.mutations).toEqual(["POST", "POST", "DELETE"]);
});
test("a definite provider refusal stays failed until an explicit repair", async () => {
  const f = fixture();
  f.refuseCreate(true);
  await f.make().sync("owner", "bot", intent("one"));
  expect(
    (await f.make().statuses("owner", "bot", { "routine-one": "one" }))[
      "routine-one"
    ]?.status,
  ).toBe("failed");
  await f.make().alarm("owner");
  expect(f.mutations).toEqual(["POST"]);
  f.refuseCreate(false);
  await f.make().sync("owner", "bot", intent("one", 2));
  expect(f.mutations).toEqual(["POST", "POST"]);
});

test("a never-started paused subscription cannot block retiring another listener", async () => {
  const f = fixture();
  await f.make().sync("owner", "bot-one", intent("one"));
  const other = {
    ...intent("two", 1, false),
    trigger: { ...intent("two").trigger!, config: { label: "other" } },
  };
  await f.make().sync("owner", "bot-two", other);
  await f.make().sync("owner", "bot-one", intent("one", 2, false, true));
  expect(f.mutations).toEqual(["POST", "DELETE"]);
});

test("a delivery waits for an unresolved shared creation before fixing its destinations", async () => {
  const f = fixture();
  f.normalize({ label: "INBOX" });
  await f.make().sync("owner", "bot-one", intent("one"));
  let release!: () => void, entered!: () => void;
  const reading = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.beforeCreateResponse(async () => {
    entered();
    await gate;
  });
  const create = f.make().sync("owner", "bot-two", {
    ...intent("two"),
    trigger: {
      ...intent("two").trigger!,
      config: { label: "INBOX", default_flag: true },
    },
  });
  await reading;
  await expect(f.make().receive("owner", event)).rejects.toThrow(
    "creation result",
  );
  expect(f.deliveries).toHaveLength(0);
  release();
  await create;
  await f.make().receive("owner", event);
  expect(f.deliveries).toHaveLength(2);
});
test("the Bot's current binding selects status even if an old deletion tombstone arrives last", async () => {
  const f = fixture();
  await f
    .make()
    .sync("owner", "bot", { ...intent("new"), routineId: "same-routine" });
  await f.make().sync("owner", "bot", {
    ...intent("old", 2, false, true),
    routineId: "same-routine",
  });
  expect(
    (await f.make().statuses("owner", "bot", { "same-routine": "new" }))[
      "same-routine"
    ]?.status,
  ).toBe("active");
});

test("an explicit Routine repair can use a reconnected account while old queued input remains fenced", async () => {
  const f = fixture();
  await f.make().sync("owner", "bot", intent("one"));
  f.loseDelivery();
  await expect(f.make().receive("owner", event)).rejects.toThrow();
  f.revoke();
  await f.make().removeConnection("owner", "connection-one");
  f.reconnect();
  await f.make().sync("owner", "bot", intent("one", 2));
  await f.make().alarm("owner");
  expect(f.deliveries).toHaveLength(1);
  expect(
    (await f.make().statuses("owner", "bot", { "routine-one": "one" }))[
      "routine-one"
    ]?.status,
  ).toBe("active");
  await expect(f.make().receive("owner", event)).rejects.toThrow(
    "previous connection",
  );
  await f.make().receive("owner", {
    ...event,
    eventId: "msg_reconnected",
    accountId: "ca_two",
    triggerId: "ti_two",
  });
  expect(f.deliveries).toHaveLength(2);
});

test("simultaneous starts that are both paused resolve their own unknown state without a circular wait", async () => {
  const f = fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting: (() => void)[] = [];
  let reads = 0;
  const wait = async () => {
    f.beforeRead(wait);
    reads++;
    waiting.splice(0).forEach((resolve) => resolve());
    await gate;
  };
  const untilReads = async (n: number) => {
    while (reads < n)
      await new Promise<void>((resolve) => waiting.push(resolve));
  };
  f.beforeRead(wait);
  const one = f.make().sync("owner", "bot-one", intent("one"));
  await untilReads(1);
  const other = {
    ...intent("two"),
    trigger: { ...intent("two").trigger!, config: { label: "other" } },
  };
  const two = f.make().sync("owner", "bot-two", other);
  await untilReads(2);
  const pauseOne = f.make().sync("owner", "bot-one", intent("one", 2, false));
  await untilReads(3);
  const pauseTwo = f
    .make()
    .sync("owner", "bot-two", { ...other, revision: 2, enabled: false });
  await untilReads(4);
  f.beforeRead(async () => {});
  release();
  await Promise.all([one, two, pauseOne, pauseTwo]);
  await f.make().alarm("owner");
  expect(f.mutations).toEqual([]);
  expect(
    (await f.make().statuses("owner", "bot-one", { "routine-one": "one" }))[
      "routine-one"
    ]?.status,
  ).toBe("paused");
  expect(
    (await f.make().statuses("owner", "bot-two", { "routine-two": "two" }))[
      "routine-two"
    ]?.status,
  ).toBe("paused");
});
test("a newly bound paused config cannot disable another Routine's normalized instance", async () => {
  const f = fixture();
  f.normalize({ label: "INBOX" });
  await f.make().sync("owner", "bot-one", intent("one"));
  await f.make().sync("owner", "bot-two", {
    ...intent("two", 1, false),
    trigger: { ...intent("two").trigger!, config: { label: "INBOX" } },
  });
  expect(f.mutations).toEqual(["POST"]);
  expect(
    (await f.make().statuses("owner", "bot-one", { "routine-one": "one" }))[
      "routine-one"
    ]?.status,
  ).toBe("active");
});

test("a new binding cannot settle against an instance whose deletion is already dispatched", async () => {
  const f = fixture();
  f.normalize({ label: "INBOX" });
  await f.make().sync("owner", "bot-one", intent("one"));
  let release!: () => void, entered!: () => void;
  const enteredDelete = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.beforeDelete(async () => {
    entered();
    await gate;
  });
  const deleting = f
    .make()
    .sync("owner", "bot-one", intent("one", 2, false, true));
  await enteredDelete;
  await f.make().sync("owner", "bot-two", {
    ...intent("two"),
    trigger: { ...intent("two").trigger!, config: { label: "INBOX" } },
  });
  release();
  await deleting;
  await f.make().alarm("owner");
  expect(f.mutations).toEqual(["POST", "DELETE", "POST"]);
  expect(
    (await f.make().statuses("owner", "bot-two", { "routine-two": "two" }))[
      "routine-two"
    ]?.status,
  ).toBe("active");
});

test("a delayed provider read cannot bind an instance deleted before its response arrives", async () => {
  const f = fixture();
  f.normalize({ label: "INBOX" });
  await f.make().sync("owner", "bot-one", intent("one"));
  const deletingGate = Promise.withResolvers<void>();
  const deletingEntered = Promise.withResolvers<void>();
  f.beforeDelete(async () => {
    deletingEntered.resolve();
    await deletingGate.promise;
  });
  const deleting = f
    .make()
    .sync("owner", "bot-one", intent("one", 2, false, true));
  await deletingEntered.promise;
  const readingGate = Promise.withResolvers<void>();
  const readingEntered = Promise.withResolvers<void>();
  f.beforeReadResponse(async () => {
    readingEntered.resolve();
    await readingGate.promise;
  });
  const creating = f.make().sync("owner", "bot-two", {
    ...intent("two"),
    trigger: { ...intent("two").trigger!, config: { label: "INBOX" } },
  });
  await readingEntered.promise;
  deletingGate.resolve();
  await deleting;
  readingGate.resolve();
  await creating;
  await f.make().alarm("owner");
  expect(f.mutations).toEqual(["POST", "DELETE", "POST"]);
  expect(
    (await f.make().statuses("owner", "bot-two", { "routine-two": "two" }))[
      "routine-two"
    ]?.status,
  ).toBe("active");
});
