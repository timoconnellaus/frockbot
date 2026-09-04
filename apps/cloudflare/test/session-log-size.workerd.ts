// A production-shaped storage regression in real workerd SQLite. The legacy
// Bot begins one write away from SQLITE_TOOBIG, then admits a Turn that writes
// thirty 80 KB model requests through the kernel's ordinary persistence seam.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import {
  bootstrapGeneration,
  type CompositionGenerationV1,
} from "@frockbot/kernel-composition/generation";
import { Session, type SessionEvent } from "@frockbot/kernel-contracts";
import {
  BotDurableAuthority,
  SESSION_EVENT_PAGE_BYTES_V1,
  SessionEventLog,
  createStoredRunCodecV1,
  sessionEventLogPagePrefixV1,
  sessionEventPayloadPrefixV1,
  type BotDurableAuthorityHooks,
  type StoredRunV1,
} from "@frockbot/kernel-do";
import { describe, expect, test } from "vitest";

const SESSION_ID = "session-log-size-user:session-log-size-bot";
const LARGE_REQUEST_BYTES = 80_000;
const STEPS = 30;

const codec = createStoredRunCodecV1<undefined>({
  decodeRunId: (value) => String(value),
  decodeConfigurationSnapshot: () => undefined,
});

function bootstrap(): Promise<CompositionGenerationV1> {
  return bootstrapGeneration(
    [
      {
        packageId: "shell",
        specifier: "@frockbot/plugin-shell",
        version: "0.0.1",
        manifest: { id: "shell", version: "0.0.1" },
      },
    ],
    { createdAt: "2026-09-04T00:00:00.000Z" },
  );
}

function legacyEvents(): SessionEvent[] {
  const session = new Session(SESSION_ID, () => {});
  session.appendBatch([
    { type: "turn/start", turn: 1 },
    { type: "step/start", turn: 1, step: 1 },
    {
      type: "user/message",
      turn: 1,
      step: 1,
      messageId: "legacy-message",
      text: "Earlier work",
    },
    {
      type: "model/request",
      turn: 1,
      step: 1,
      request: {
        requestId: "legacy-request",
        provider: "fake",
        model: "large-context",
        system: "p".repeat(1_900_000),
        messages: [{ role: "user", content: "Earlier work" }],
        tools: [],
      },
    },
    {
      type: "assistant/message",
      turn: 1,
      step: 1,
      requestId: "legacy-request",
      text: "Done earlier.",
      toolCalls: [],
    },
    { type: "step/end", turn: 1, step: 1, outcome: "completed" },
    { type: "turn/end", turn: 1, outcome: "completed" },
  ]);
  return [...session.events];
}

function legacyRun(events: SessionEvent[]): StoredRunV1<undefined> {
  return {
    runId: "legacy-run",
    commandFingerprint: "legacy-fingerprint",
    sessionId: SESSION_ID,
    acceptedAt: "2026-09-04T00:00:00.000Z",
    input: "Earlier work",
    events,
    effectAdmissions: [],
    status: "completed",
    responseText: "Done earlier.",
    phase: "executing",
    compositionGenerationId: "legacy-generation",
    configurationSnapshot: undefined,
    previousEventCount: 0,
  };
}

function bot() {
  return env.BOT_STATES.getByName(SESSION_ID);
}

describe("a near-limit legacy Session in workerd SQLite", () => {
  test("migrates on admission and completes thirty large steps", async () => {
    const result = await runInDurableObject(bot(), async (_instance, state) => {
      const previous = legacyEvents();
      await state.storage.put({
        "latest-events": previous,
        "run:legacy-run": legacyRun(previous),
        "run-index:2026-09-04T00:00:00.000Z:legacy-run": "legacy-run",
      });

      const hooks: BotDurableAuthorityHooks<undefined> = {
        resolveAdmissionSnapshot: () => Promise.resolve(undefined),
        bootstrapComposition: () => bootstrap(),
        admittedSnapshot: () => Promise.resolve(undefined),
        executeTurn: async (input) => {
          let seq = input.previousEvents.length;
          const events: SessionEvent[] = [];
          const persist = async (
            batch: Array<Omit<SessionEvent, "seq" | "timestamp">>,
          ) => {
            const stamped = batch.map(
              (event) =>
                ({
                  ...event,
                  seq: seq++,
                  timestamp: "2026-09-04T00:01:00.000Z",
                }) as SessionEvent,
            );
            events.push(...stamped);
            await input.persistSessionEvents(input.command.sessionId, stamped);
          };

          await persist([{ type: "turn/start", turn: 2 } as never]);
          for (let step = 1; step <= STEPS; step += 1) {
            await persist([
              { type: "step/start", turn: 2, step } as never,
              {
                type: "model/request",
                turn: 2,
                step,
                request: {
                  requestId: `request-${step}`,
                  provider: "fake",
                  model: "large-context",
                  system: "s".repeat(LARGE_REQUEST_BYTES),
                  messages: [{ role: "user", content: "Keep going" }],
                  tools: [],
                },
              } as never,
              {
                type: "assistant/message",
                turn: 2,
                step,
                requestId: `request-${step}`,
                text: step === STEPS ? "All done." : "",
                toolCalls: [],
              } as never,
              {
                type: "step/end",
                turn: 2,
                step,
                outcome: "completed",
              } as never,
            ]);
          }
          await persist([
            { type: "turn/end", turn: 2, outcome: "completed" } as never,
          ]);
          return { runId: input.command.runId, text: "All done.", events };
        },
        notification: () => undefined,
        scheduledDeadlines: () => Promise.resolve([]),
        scheduledWorkInFlight: () => false,
        deferScheduledWork: () => Promise.resolve(),
        settleScheduledWork: () => Promise.resolve(),
      };
      const authority = new BotDurableAuthority<undefined>({
        state,
        codec,
        hooks,
      });
      const completion = await authority.run({
        userId: "session-log-size-user",
        botId: "session-log-size-bot",
        runId: "large-run",
        sessionId: SESSION_ID,
        acceptedAt: "2026-09-04T00:01:00.000Z",
        text: "Keep going",
      });
      const stored =
        (await state.storage.get<Record<string, unknown>>("run:large-run"))!;
      const log = new SessionEventLog(state.storage);
      const exact = await log.read(SESSION_ID);
      const pages = await state.storage.list<unknown>({
        prefix: sessionEventLogPagePrefixV1(SESSION_ID),
      });
      const payloads = await state.storage.list<unknown>({
        prefix: sessionEventPayloadPrefixV1(SESSION_ID),
      });
      const encoder = new TextEncoder();
      return {
        text: completion.text,
        modelRequests: exact.filter((event) => event.type === "model/request")
          .length,
        legacyExists: (await state.storage.get("latest-events")) !== undefined,
        rawRunHasEvents: Object.hasOwn(stored, "events"),
        rawRunStatus: stored.status,
        pageCount: pages.size,
        payloadCount: payloads.size,
        maximumPageBytes: Math.max(
          0,
          ...[...pages.values()].map(
            (page) => encoder.encode(JSON.stringify(page)).byteLength,
          ),
        ),
      };
    });

    expect(result).toMatchObject({
      text: "All done.",
      modelRequests: STEPS + 1,
      legacyExists: false,
      rawRunHasEvents: false,
      rawRunStatus: "completed",
    });
    expect(result.pageCount).toBeGreaterThan(0);
    expect(result.payloadCount).toBeGreaterThan(STEPS);
    expect(result.maximumPageBytes).toBeLessThanOrEqual(
      SESSION_EVENT_PAGE_BYTES_V1,
    );
  });
});
