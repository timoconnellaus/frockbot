// A model request that ran out of time settles the Turn instead of escaping.
//
// The blocker this file describes: a tool-heavy step against a real Flock AI
// model crossed the gateway's sixty-second budget, the abort surfaced out of
// the Agent as `Model response outcome is uncertain: The operation was aborted
// due to timeout`, the authority parked the run on a reconciliation and
// rethrew — and the `POST /api/bots/<bot>/turns` the composer was holding open
// answered 500 after 65 seconds. On screen: "Couldn't reach the Bot. Check your
// connection and try again", blaming a network that was fine, over a Bot that
// stayed wedged behind a banner nothing could ever resolve.
//
// ADR 0028 already settled the question for recovery: park only when somebody
// can be asked, and Flock AI keeps no addressable copy of a completion, so
// nobody can. This is that rule on the live path.
import { describe, expect, test } from "bun:test";
import {
  bootstrapGeneration,
  type CompositionGenerationV1,
} from "@frockbot/kernel-composition/generation";
import {
  MODEL_FIRST_BYTE_DEADLINE_REASON_V1,
  type SessionEvent,
} from "@frockbot/kernel-contracts";
import {
  BotDurableAuthority,
  type BotDurableAuthorityHooks,
  type OwnedBotTurnCommand,
} from "./authority.ts";
import { MemoryStorage } from "./memory-storage.fixture.ts";
import {
  BotTurnExecutionError,
  BotTurnReconciliationRequiredError,
} from "./turn-errors.ts";
import { createStoredRunCodecV1 } from "./run-records.ts";

const codec = createStoredRunCodecV1<undefined>({
  decodeRunId: (value) => value as string,
  decodeConfigurationSnapshot: () => undefined,
});

const identity = { userId: "user-1", botId: "primary" };
const SESSION_ID = "user-1:primary";

/** Providers that keep an addressable copy of a completion. Neither does. */
const RECONCILING_PROVIDERS = new Set(["foundation"]);

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
    { createdAt: "2026-09-03T00:00:00.000Z" },
  );
}

function command(runId: string, text: string): OwnedBotTurnCommand {
  return {
    ...identity,
    runId,
    sessionId: SESSION_ID,
    acceptedAt: "2026-09-03T00:00:01.000Z",
    text,
  };
}

/**
 * An authority whose Package stalls its model request past the budget: it
 * journals the request, streams a first line, then unwinds exactly as the
 * Agent loop does on a deadline — a `model/reconciliation-required` carrying
 * the deadline's own sentence, and no `turn/end`.
 */
function createAuthority(
  storage: MemoryStorage,
  provider: string,
  options: { providerReconciles?: boolean; refuseWith?: string } = {},
): BotDurableAuthority<undefined> {
  const hooks: BotDurableAuthorityHooks<undefined> = {
    resolveAdmissionSnapshot: () => Promise.resolve(undefined),
    bootstrapComposition: () => bootstrap(),
    admittedSnapshot: () => Promise.resolve(undefined),
    ...(options.providerReconciles === undefined
      ? { providerReconciles: (id: string) => RECONCILING_PROVIDERS.has(id) }
      : { providerReconciles: () => options.providerReconciles as boolean }),
    executeTurn: async (input) => {
      let seq = input.previousEvents.length;
      const appended: SessionEvent[] = [];
      const persist = async (
        ...events: Omit<SessionEvent, "seq" | "timestamp">[]
      ) => {
        const stamped = events.map(
          (event) =>
            ({
              ...event,
              seq: seq++,
              timestamp: "2026-09-03T00:00:10.000Z",
            }) as SessionEvent,
        );
        appended.push(...stamped);
        await input.persistSessionEvents(input.command.sessionId, stamped);
      };
      await persist(
        { type: "turn/start", turn: 1 } as never,
        { type: "step/start", turn: 1, step: 1 } as never,
        {
          type: "user/message",
          turn: 1,
          step: 1,
          messageId: "message-1",
          text: input.command.text,
        } as never,
        {
          type: "model/request",
          turn: 1,
          step: 1,
          request: {
            requestId: "request-1",
            provider,
            model: "@flock/auto",
            system: "system",
            messages: [{ role: "user", content: input.command.text }],
            tools: [],
          },
        } as never,
        {
          type: "assistant/chunk",
          turn: 1,
          step: 1,
          requestId: "request-1",
          text: "On it — building it now.",
        } as never,
      );
      // A provider that refused definitively — a revoked key answering 401 —
      // reaches a real `turn/end`, the way the Agent loop settles a model
      // error it never has to reconcile.
      if (options.refuseWith) {
        await persist(
          {
            type: "model/effect-not-started",
            turn: 1,
            step: 1,
            requestId: "request-1",
            reason: options.refuseWith,
          } as never,
          {
            type: "step/end",
            turn: 1,
            step: 1,
            outcome: "model-error",
          } as never,
          {
            type: "turn/end",
            turn: 1,
            outcome: "model-error",
            reason: options.refuseWith,
          } as never,
        );
        throw new BotTurnExecutionError(
          `Bot turn ended with outcome model-error: ${options.refuseWith}`,
          appended,
        );
      }
      const reason = `Model response outcome is uncertain: ${MODEL_FIRST_BYTE_DEADLINE_REASON_V1}`;
      await persist({
        type: "model/reconciliation-required",
        turn: 1,
        step: 1,
        requestId: "request-1",
        reason,
      } as never);
      throw new BotTurnReconciliationRequiredError(reason, appended);
    },
    notification: () => undefined,
    scheduledDeadlines: () => Promise.resolve([]),
    scheduledWorkInFlight: () => false,
    deferScheduledWork: () => Promise.resolve(),
    settleScheduledWork: () => Promise.resolve(),
    interruptTurn: () => {},
  };
  return new BotDurableAuthority<undefined>({
    state: { storage } as unknown as DurableObjectState,
    codec,
    hooks,
  });
}

async function storedRun(
  authority: BotDurableAuthority<undefined>,
  runId: string,
) {
  return (await authority.readRun(runId))!;
}

describe("a model request that ran out of time", () => {
  test("settles the Turn and answers the caller instead of throwing", async () => {
    const storage = new MemoryStorage();
    const authority = createAuthority(storage, "flock-ai");

    // The `POST /turns` the composer is holding open. It resolves — this is
    // the whole defect: it used to reject, and the route answered 500.
    const completion = await authority.run(command("run-1", "build me one"));

    expect(completion.runId).toBe("run-1");
    const run = await storedRun(authority, "run-1");
    expect(run.status).toBe("failed");
    // The ordinary run-terminal path: the open Turn is closed rather than left
    // for the next message to trip over.
    const terminal = run.events.findLast((event) => event.type === "turn/end");
    expect(terminal).toMatchObject({ turn: 1, outcome: "interrupted" });
    // The words the person watched arrive are kept.
    expect(run.events.some((event) => event.type === "assistant/chunk")).toBe(
      true,
    );
    // The stored reason is the diagnostic, and it carries the sentence the
    // client's copy layer reads back out of it.
    expect(run.failure).toContain(MODEL_FIRST_BYTE_DEADLINE_REASON_V1);
    // Nothing is left holding the Bot: the next message is admitted.
    expect(storage.values.get("active-run")).toBeUndefined();
  });

  test("still parks when the provider can actually be asked", async () => {
    const storage = new MemoryStorage();
    const authority = createAuthority(storage, "foundation");

    // A provider that keeps a durable copy loses nothing by waiting, so the
    // uncertainty is preserved exactly as before and the caller still learns
    // the Turn did not settle.
    await expect(
      authority.run(command("run-1", "build me one")),
    ).rejects.toThrow();

    const run = await storedRun(authority, "run-1");
    expect(run.status).toBe("reconciliation-required");
    expect(run.events.some((event) => event.type === "turn/end")).toBe(false);
  });

  // The same leak, one layer over: a Turn that reached a real `turn/end` and a
  // durable `failed` record was *still* rethrown, so the Worker logged
  // `Uncaught Error: Bot turn ended with outcome model-error: Model request
  // failed (401)` and the route answered 500 over a settlement that had
  // already happened.
  test("a provider that refused settles and answers, with no uncaught error", async () => {
    const storage = new MemoryStorage();
    const authority = createAuthority(storage, "flock-ai", {
      refuseWith: "Model request failed (401)",
    });

    const completion = await authority.run(command("run-1", "hello"));

    expect(completion.runId).toBe("run-1");
    const run = await storedRun(authority, "run-1");
    expect(run.status).toBe("failed");
    expect(
      run.events.findLast((event) => event.type === "turn/end"),
    ).toMatchObject({ outcome: "model-error" });
    // The provider's own words stay on the record for the debug surface; the
    // client maps the outcome to a sentence (`runFailureCopyV1`).
    expect(run.failure).toContain("401");
    expect(storage.values.get("active-run")).toBeUndefined();
  });
});
