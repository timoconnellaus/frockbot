// The whole accounting path: provider usage -> model/usage journal event ->
// settled-Turn Bot outbox -> authoritative User ledger -> hosted projection.
import { env, runInDurableObject } from "cloudflare:test";
import type { UsageReportV1 } from "@frockbot/plugin-billing";
import { describe, expect, it } from "vitest";
import {
  asUser,
  expectOkJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

function userStub(userId: string) {
  return env.USER_CONFIGURATIONS.get(
    env.USER_CONFIGURATIONS.idFromName(userId),
  );
}

describe("a settled Turn's usage ledger", () => {
  it("records exactly one reported model entry at the pinned price", async () => {
    const userId = freshUserId("usage");
    const botId = "spend-bot";
    await provisionThroughGateway({ userId, botId });

    await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/turns`, {
        schemaVersion: 1,
        commandId: "usage-turn-1",
        text: "hello",
      }),
    );

    const entries = await runInDurableObject(
      userStub(userId),
      async (_instance, state) =>
        state.storage.sql
          .exec<{
            entry_id: string;
            bot_id: string;
            run_id: string;
            provider: string;
            model: string;
            input_tokens: number;
            output_tokens: number;
            estimated: number;
            cost_micros: number;
          }>(
            "SELECT entry_id, bot_id, run_id, provider, model, input_tokens, output_tokens, estimated, cost_micros FROM usage_entries",
          )
          .toArray(),
    );
    expect(entries).toEqual([
      expect.objectContaining({
        bot_id: botId,
        run_id: "usage-turn-1",
        provider: "ollama-cloud",
        model: "glm-5.3-flash:cloud",
        input_tokens: 20,
        output_tokens: 6,
        estimated: 0,
        // $0.15/M input + $0.50/M output = 6 micro-dollars.
        cost_micros: 6,
      }),
    ]);

    const report = (await expectOkJson(
      await asUser(userId, "/api/usage"),
    )) as UsageReportV1;
    expect(report).toMatchObject({
      currentMonthCostMicros: 6,
      currentMonthInputTokens: 20,
      currentMonthOutputTokens: 6,
      estimatedCalls: 0,
      unknownPriceCalls: 0,
      bots: [expect.objectContaining({ id: botId, costMicros: 6 })],
      models: [
        expect.objectContaining({
          id: "ollama-cloud/glm-5.3-flash:cloud",
          costMicros: 6,
        }),
      ],
    });
  });
});
