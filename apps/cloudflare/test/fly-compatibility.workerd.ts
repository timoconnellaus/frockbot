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
    const firstEvents = await stub.durableSessionEvents();
    expect(firstEvents.length).toBeGreaterThan(0);
    expect(firstEvents.map((event) => event.seq)).toEqual(
      firstEvents.map((_, index) => index),
    );

    // This Bot follows the User's default model, so its first admitted Turn
    // claimed its own model Assignment: a client renames it against the
    // revision it reads, exactly as the hosted client does.
    // SAFETY: the generated stub type for `readConfiguration` is too deep for
    // the compiler to instantiate here; this names the one field it reads.
    const settingsRpc = stub as unknown as {
      readConfiguration(input: unknown): Promise<{ revision: number }>;
    };
    const renamedFrom = (await settingsRpc.readConfiguration(identity))
      .revision;
    expect(renamedFrom).toBeGreaterThan(0);
    await stub.executeConfiguration({
      ...identity,
      command: {
        schemaVersion: 1,
        type: "bot/update-profile",
        commandId: "rename-1",
        expectedRevision: renamedFrom,
        botId: identity.botId,
        profile: { name: "Remounted Workerd Bot" },
      },
    });

    const second = await stub.run({
      ...identity,
      command: {
        runId: "run-2",
        sessionId: `${identity.userId}:${identity.botId}`,
        acceptedAt: "2026-08-29T00:01:00.000Z",
        text: "same resident root",
      },
    });
    expect(second.text).toBe("Ollama reply");
    const residentEvents = await stub.durableSessionEvents();
    expect(
      residentEvents.findLast((event) => event.type === "model/request"),
    ).toMatchObject({
      request: { system: expect.stringContaining("Remounted Workerd Bot") },
    });
    expect(residentEvents.length).toBeGreaterThan(firstEvents.length);

    await evictDurableObject(stub);

    expect(await stub.durableSessionEvents()).toEqual(residentEvents);
    const reconstructed = await stub.run({
      ...identity,
      command: {
        runId: "run-3",
        sessionId: `${identity.userId}:${identity.botId}`,
        acceptedAt: "2026-08-29T00:02:00.000Z",
        text: "after eviction",
      },
    });
    expect(reconstructed.text).toBe("Ollama reply");
    expect((await stub.durableSessionEvents()).length).toBeGreaterThan(
      residentEvents.length,
    );
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
