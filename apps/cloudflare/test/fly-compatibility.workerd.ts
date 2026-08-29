import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { FlyCompatibilityProbe } from "./fly-compatibility-worker.ts";

function probe(name: string) {
  return env.FLY_COMPATIBILITY.getByName(name);
}

describe("Fly provider in a Durable Object", () => {
  test("loads the probe as a Workerd Durable Object export", () => {
    expect(FlyCompatibilityProbe.name).toBe("FlyCompatibilityProbe");
  });

  test("mounts through the provider-neutral Computer interface", async () => {
    const result = await probe(`mount-${crypto.randomUUID()}`).mountProvider();

    expect(result).toEqual({
      providerId: "fly-sprite",
      generation: 1,
      durableMountCount: 1,
    });
  });

  test("serializes concurrent durable events without loss", async () => {
    const stub = probe(`ordering-${crypto.randomUUID()}`);

    const admitted = await Promise.all([
      stub.appendDurableEvent("first"),
      stub.appendDurableEvent("second"),
      stub.appendDurableEvent("third"),
    ]);

    expect(admitted.map((event) => event.sequence).sort()).toEqual([1, 2, 3]);
    expect(await stub.durableEvents()).toEqual(
      [...admitted].sort((left, right) => left.sequence - right.sequence),
    );
  });

  test("runs durable scheduled work through the alarm seam", async () => {
    const stub = probe(`alarm-${crypto.randomUUID()}`);
    await stub.scheduleDurableEvent("scheduled");

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.durableEvents()).toEqual([
      { sequence: 1, label: "scheduled" },
    ]);
  });

  test("remounts after eviction while durable probe state survives", async () => {
    const stub = probe(`eviction-${crypto.randomUUID()}`);
    const beforeEviction = await stub.mountProvider();

    await evictDurableObject(stub);

    const afterEviction = await stub.mountProvider();
    expect(beforeEviction).toMatchObject({
      providerId: "fly-sprite",
      generation: 1,
    });
    expect(afterEviction).toEqual({
      providerId: "fly-sprite",
      generation: 1,
      durableMountCount: beforeEviction.durableMountCount + 1,
    });
  });

  test.skipIf(env.FROCKBOT_RUN_LIVE_SPRITE_TEST !== "1")(
    "records the Sprites HTTP framing incompatibility in Workerd",
    async () => {
      expect(env.SPRITES_TOKEN).not.toBe("");
      const spriteName = `frockbot-test-${crypto.randomUUID().slice(0, 8)}`;
      const message = `workerd-${crypto.randomUUID()}`;
      const stub = probe(`live-${crypto.randomUUID()}`);

      try {
        await expect(
          stub.probeLiveWorkspace(spriteName, message),
        ).rejects.toThrow(/preserved HTTP chunk boundaries/);
      } finally {
        await stub.deleteLiveSprite(spriteName);
      }
    },
  );
});
