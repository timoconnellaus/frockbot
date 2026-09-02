import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import {
  FLOCK_AI_CONNECTION_ID,
  FLOCK_AI_DEFAULT_MODEL,
} from "@frockbot/plugin-provider-flock-ai/catalog";

interface FreshUserRpc {
  readConfiguration(input: unknown): Promise<{
    revision: number;
    packages: Array<{ packageId: string; state: string }>;
    connections: Array<{
      connectionId: string;
      state: string;
      providerType?: string;
    }>;
    platformModel?: {
      connectionId: string;
      providerModelId: string;
    };
  }>;
  createBot(input: unknown): Promise<{ status: string }>;
}

describe("ambient Flock AI default", () => {
  test("a fresh User can run a Turn without configuring credentials", async () => {
    const suffix = crypto.randomUUID();
    const userId = `workers-ai-user-${suffix}`;
    const botId = `workers-ai-bot-${suffix}`;
    const user = env.USER_CONFIGURATIONS.getByName(
      userId,
    ) as unknown as FreshUserRpc;

    const settings = await user.readConfiguration({
      schemaVersion: 1,
      userId,
    });
    expect(settings).toMatchObject({
      packages: expect.arrayContaining([
        expect.objectContaining({
          packageId: "provider-flock-ai",
          state: "installed",
        }),
      ]),
      connections: expect.arrayContaining([
        expect.objectContaining({
          connectionId: FLOCK_AI_CONNECTION_ID,
          state: "ready",
          providerType: "flock-ai",
        }),
      ]),
      platformModel: {
        connectionId: FLOCK_AI_CONNECTION_ID,
        providerModelId: FLOCK_AI_DEFAULT_MODEL,
      },
    });

    await expect(
      user.createBot({
        schemaVersion: 1,
        userId,
        command: {
          schemaVersion: 1,
          type: "bot/create",
          commandId: `create-${suffix}`,
          expectedRevision: 0,
          botId,
          name: "Flock AI Bot",
        },
      }),
    ).resolves.toMatchObject({ status: "applied" });

    const bot = env.BOT_STATES.getByName(`${userId}:${botId}`);
    const result = await bot.run({
      schemaVersion: 1,
      userId,
      botId,
      command: {
        runId: `run-${suffix}`,
        sessionId: `${userId}:${botId}`,
        acceptedAt: "2026-09-01T00:00:00.000Z",
        text: "Say hello.",
      },
    });
    expect(result.text).toBe("Workers AI reply");
  });
});
