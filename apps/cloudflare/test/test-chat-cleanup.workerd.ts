import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";

test("incident cleanup precedes old history reads and survives eviction", async () => {
  const identity = {
    userId: "vgpqfaCcwnPlzjYdb2mIfNcOW1YV0SkG",
    botId: "bob-daff7ee3",
  };
  const stub = env.BOT_STATES.getByName(`${identity.userId}:${identity.botId}`);
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put({
      identity,
      "bot-configuration": { name: "Bob" },
      "latest-events": [{ type: "model/reconciliation-required" }],
    });
    for (let page = 0; page < 3; page++) {
      const records: Record<string, unknown> = {};
      for (let n = page * 64; n < (page + 1) * 64; n++)
        records[`run:${n}`] = { status: "completed" };
      await state.storage.put(records);
    }
  });
  await evictDurableObject(stub);
  await runInDurableObject(stub, async (_instance, state) => {
    expect((await state.storage.list({ prefix: "run:" })).size).toBe(0);
    expect(await state.storage.get("latest-events")).toBeUndefined();
    expect(await state.storage.get("identity")).toEqual(identity);
    expect(await state.storage.get("bot-configuration")).toEqual({
      name: "Bob",
    });
    expect(
      await state.storage.get("maintenance:chat-reset:2026-09-08"),
    ).toMatchObject({ botId: identity.botId, deletedKeys: 193 });
    await state.storage.put("run:new", { status: "completed" });
  });
  await evictDurableObject(stub);
  await runInDurableObject(stub, async (_instance, state) => {
    expect(await state.storage.get("run:new")).toEqual({ status: "completed" });
  });
});
