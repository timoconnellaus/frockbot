import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { provisionBot } from "./provision-bot.ts";

function flyProbe(name: string) {
  return env.FLY_COMPATIBILITY.getByName(name);
}

function bot(name: string) {
  return env.BOT_STATES.getByName(name);
}

function user(name: string) {
  return env.USER_CONFIGURATIONS.getByName(name);
}

describe("Fly provider Workerd compatibility", () => {
  test("mounts through the provider-neutral Computer interface", async () => {
    const result = await flyProbe(
      `mount-${crypto.randomUUID()}`,
    ).mountProvider();

    expect(result).toEqual({
      providerId: "fly-sprite",
      generation: 1,
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

describe("production Bot durability in Workerd", () => {
  test("persists session events in sequence across eviction", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      schemaVersion: 1 as const,
      userId: `workerd-user-${suffix}`,
      botId: `workerd-bot-${suffix}`,
    };
    await provisionBot(identity);
    const stub = bot(`events-${suffix}`);
    const result = await stub.run({
      ...identity,
      command: {
        runId: "run-1",
        sessionId: `${identity.userId}:${identity.botId}`,
        acceptedAt: "2026-08-29T00:00:00.000Z",
        text: "hello from Workerd",
      },
    });

    expect(result.text).toBe("Ollama reply");
    const durableEvents = await stub.durableSessionEvents();
    expect(durableEvents.length).toBeGreaterThan(0);
    expect(durableEvents.map((event) => event.seq)).toEqual(
      durableEvents.map((_, index) => index),
    );

    await evictDurableObject(stub);

    expect(await stub.durableSessionEvents()).toEqual(durableEvents);
  });

  test("runs recovery through the alarm seam", async () => {
    const stub = bot(`alarm-${crypto.randomUUID()}`);
    await stub.scheduleRecoveryProbe();

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.recoveryProbe()).toEqual({
      activeRunId: "missing-run",
      alarmScheduled: true,
    });
  });
});
