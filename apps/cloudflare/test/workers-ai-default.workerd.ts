import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import {
  WORKERS_AI_CONNECTION_ID,
  WORKERS_AI_DEFAULT_MODEL,
} from "@frockbot/plugin-provider-workers-ai/catalog";

interface FreshUserRpc {
  readConfiguration(input: unknown): Promise<{
    revision: number;
    packages: Array<{ packageId: string; state: string }>;
    connections: Array<{
      connectionId: string;
      state: string;
      providerType?: string;
    }>;
    newBotModelTemplate?: {
      connectionId: string;
      providerModelId: string;
    };
    newBotModelTemplateSource?: string;
  }>;
  createBot(input: unknown): Promise<{ status: string }>;
}

describe("ambient Workers AI default", () => {
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
      packages: [
        expect.objectContaining({
          packageId: "provider-workers-ai",
          state: "installed",
        }),
      ],
      connections: [
        expect.objectContaining({
          connectionId: WORKERS_AI_CONNECTION_ID,
          state: "ready",
          providerType: "workers-ai",
        }),
      ],
      newBotModelTemplate: {
        connectionId: WORKERS_AI_CONNECTION_ID,
        providerModelId: WORKERS_AI_DEFAULT_MODEL,
      },
      newBotModelTemplateSource: "auto",
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
          name: "Workers AI Bot",
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
