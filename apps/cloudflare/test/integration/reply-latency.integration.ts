import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { SessionEvent } from "@frockbot/core/contracts";
import {
  expectOkJson,
  freshUserId,
  hydratedStoredRunsV1,
  postAsUser,
  provisionThroughGateway,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

it("a greeting exposes three schemas, sends once, and finishes after one provider call", async () => {
  const userId = freshUserId("reply-latency");
  const botId = "reply-latency-bot";
  await provisionThroughGateway({ userId, botId });
  await expectOkJson(
    await postAsUser(userId, `/api/bots/${botId}/turns`, {
      schemaVersion: 1,
      commandId: "greeting",
      text: "hi",
    }),
  );
  const stub = env.BOT_STATES.get(
    env.BOT_STATES.idFromName(`${userId}:${botId}`),
  );
  const events = await runInDurableObject(
    stub,
    async (_instance: unknown, state: DurableObjectState) => {
      const runs = await hydratedStoredRunsV1<{
        runId: string;
        sessionId: string;
        events: SessionEvent[];
      }>(state.storage);
      return runs.find((run) => run.runId === "greeting")?.events ?? [];
    },
  );
  const requests = events.filter((e) => e.type === "model/request");
  expect(requests).toHaveLength(1);
  expect(requests[0]?.request.tools.map((t) => t.name)).toEqual([
    "send_to_user",
    "get_dynamic_tools",
    "call_dynamic_tool",
  ]);
  expect(requests[0]?.request.system).toContain("computer_exec");
  expect(requests[0]?.request.system).toContain("project_create");
  expect(events.filter((e) => e.type === "send/to-user")).toHaveLength(1);
  expect(events.at(-1)).toMatchObject({
    type: "turn/end",
    outcome: "completed",
  });
});
