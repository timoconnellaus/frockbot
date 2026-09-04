// The production HTTP path under the workload that used to wedge a Bot: a
// long tool-driven Turn whose normalized prompt is about 80 KB on every step.
import { runInDurableObject } from "cloudflare:test";
import { SessionEventLog } from "@frockbot/kernel-do";
import { describe, expect, it } from "vitest";
import {
  asUser,
  botStateStubV1,
  expectOkJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  repeatedToolCallPrompt,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

const HISTORY_TEXT_BYTES = 29_000;
const MODEL_STEPS = 60;

describe("a sixty-step Turn through the production gateway", () => {
  it("completes with bounded run state and a readable transcript", async () => {
    const userId = freshUserId("session-log-size");
    const botId = "session-log-size-bot";
    const sessionId = `${userId}:${botId}`;
    await provisionThroughGateway({ userId, botId });

    // Two ordinary prior Turns make every request in the subject Turn exceed
    // 80 KB without violating the public per-message limit or crossing the
    // 70%-of-150k compaction threshold before admission.
    for (let turn = 1; turn <= 2; turn += 1) {
      const warmup = await postAsUser(userId, `/api/bots/${botId}/turns`, {
        schemaVersion: 1,
        commandId: `session-log-warmup-${turn}`,
        text: `${turn}:${"h".repeat(HISTORY_TEXT_BYTES)}`,
      });
      expect(warmup.status).toBe(200);
    }

    const runId = "session-log-sixty-steps";
    const response = await postAsUser(userId, `/api/bots/${botId}/turns`, {
      schemaVersion: 1,
      commandId: runId,
      text: `${repeatedToolCallPrompt(
        MODEL_STEPS - 1,
        "get_dynamic_tools",
        {},
      )}\n${"p".repeat(HISTORY_TEXT_BYTES)}`,
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(JSON.stringify(body)).toContain("Ollama reply");

    const transcript = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/turns`),
    )) as { runs: Array<{ runId: string; status: string }> };
    expect(transcript.runs).toContainEqual(
      expect.objectContaining({ runId, status: "completed" }),
    );

    const durable = await runInDurableObject(
      botStateStubV1(userId, botId),
      async (_instance, state) => {
        const raw = (await state.storage.get<{
          status: string;
          eventRange: { startSeq: number; endSeq: number };
        }>(`run:${runId}`))!;
        const projections = await new SessionEventLog(
          state.storage,
        ).readProjections(
          sessionId,
          raw.eventRange.startSeq,
          raw.eventRange.endSeq,
        );
        const requestBytes = projections
          .filter(
            (event): event is { request: { bytes: number } } =>
              typeof event === "object" &&
              event !== null &&
              (event as { type?: unknown }).type === "model/request",
          )
          .map((event) => event.request.bytes);
        return {
          status: raw.status,
          hasEmbeddedEvents: Object.hasOwn(raw, "events"),
          runBytes: new TextEncoder().encode(JSON.stringify(raw)).byteLength,
          requestBytes,
        };
      },
    );

    expect(durable.status).toBe("completed");
    expect(durable.hasEmbeddedEvents).toBe(false);
    expect(durable.runBytes).toBeLessThan(256 * 1024);
    expect(durable.requestBytes).toHaveLength(MODEL_STEPS);
    expect(Math.min(...durable.requestBytes)).toBeGreaterThanOrEqual(80_000);
  }, 120_000);
});
