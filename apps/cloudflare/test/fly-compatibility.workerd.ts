import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, test } from "vitest";

function flyProbe(name: string) {
  return env.FLY_COMPATIBILITY.getByName(name);
}

function bot(name: string) {
  return env.BOT_STATES.getByName(name);
}

const identity = {
  schemaVersion: 1 as const,
  userId: "workerd-user",
  botId: "workerd-bot",
};

describe("Fly provider in a Durable Object", () => {
  test("mounts through the provider-neutral Computer interface", async () => {
    const result = await flyProbe(
      `mount-${crypto.randomUUID()}`,
    ).mountProvider();

    expect(result).toEqual({
      providerId: "fly-sprite",
      generation: 1,
    });
  });

  test("mounts the production Bot Contribution and reconstructs it after eviction", async () => {
    const stub = bot(`mount-${crypto.randomUUID()}`);
    const beforeEviction = await stub.inspectMountedBot(identity);

    await evictDurableObject(stub);

    const afterEviction = await stub.inspectMountedBot(identity);
    expect(beforeEviction).toMatchObject({
      mountCount: 1,
      settings: { botId: "workerd-bot", revision: 0 },
    });
    expect(afterEviction).toMatchObject({
      mountCount: 2,
      settings: beforeEviction.settings,
    });
    expect(afterEviction.residencyId).not.toBe(beforeEviction.residencyId);
  });

  test("persists production Bot session events in sequence", async () => {
    const stub = bot(`events-${crypto.randomUUID()}`);
    const result = await stub.run({
      ...identity,
      command: {
        runId: "run-1",
        sessionId: "workerd-user:workerd-bot",
        acceptedAt: "2026-08-29T00:00:00.000Z",
        text: "hello from Workerd",
      },
    });

    expect(result.text).toBe("Cordis runtime: hello from Workerd");
    const durableEvents = await stub.durableSessionEvents();
    expect(durableEvents.length).toBeGreaterThan(0);
    expect(durableEvents.map((event) => event.seq)).toEqual(
      durableEvents.map((_, index) => index),
    );

    await evictDurableObject(stub);

    expect(await stub.durableSessionEvents()).toEqual(durableEvents);
  });

  test("runs production Bot recovery through the alarm seam", async () => {
    const stub = bot(`alarm-${crypto.randomUUID()}`);
    await stub.scheduleRecoveryProbe();

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.recoveryProbe()).toEqual({
      activeRunId: "missing-run",
      alarmScheduled: true,
    });
  });

  test.skipIf(env.FROCKBOT_RUN_LIVE_SPRITE_TEST !== "1")(
    "records the Sprites HTTP framing incompatibility in Workerd",
    async () => {
      expect(env.SPRITES_TOKEN).not.toBe("");
      const spriteName = `frockbot-test-${crypto.randomUUID().slice(0, 8)}`;
      const message = `workerd-${crypto.randomUUID()}`;
      const stub = flyProbe(`live-${crypto.randomUUID()}`);

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
