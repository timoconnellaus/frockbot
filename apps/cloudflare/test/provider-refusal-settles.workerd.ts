// A provider that refuses settles the Turn; nothing escapes uncaught.
//
// The CI log for the revoked-key e2e carried, from the Worker itself:
//
//   ✘ [ERROR] Uncaught Error: Bot turn ended with outcome model-error:
//             Model request failed (401)
//
// The spec passed — it was expecting a failure — but the failure was reaching
// the runtime as an *uncaught* error, so the route answered 500 over a Turn
// that had already settled itself properly: a real `turn/end`, a durable
// `failed` record, the reason on it. The rethrow was the whole defect, the same
// class as the timeout blocker one layer up.
//
// The claim needs the deployed object, because it is a claim about what the
// Turn RPC *returns* when the Package throws: a Bun double cannot fail a real
// provider through a real Connection.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { provisionBot } from "./provision-bot.ts";

interface RefusalRpc {
  listRuns(input: unknown): Promise<{
    runs: Array<{
      runId: string;
      status: string;
      outcome?: { type: string; message: string };
    }>;
  }>;
}

/** Words that describe the machine and must never reach a chat bubble. */
const JARGON = [
  "reconcil",
  "outcome model-error",
  "durable",
  "401",
  "Ollama",
  "Bot turn ended",
];

describe("a Turn whose provider refused", () => {
  test("settles, answers its caller, and says something a person can read", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      schemaVersion: 1 as const,
      userId: `refusal-user-${suffix}`,
      botId: `refusal-bot-${suffix}`,
    };
    // The revoked key: the Ollama Cloud stub answers `/v1/chat/completions`
    // 401, which is exactly what the e2e's revoked-key spec produces.
    await provisionBot(identity, "workerd-revoked-key");
    const name = `${identity.userId}:${identity.botId}`;
    const stub = env.BOT_STATES.getByName(name);

    // The whole defect in one line: this used to reject, and the route turned
    // the rejection into a 500 with an uncaught error in the Worker log.
    const completion = await stub.run({
      ...identity,
      command: {
        runId: "run-1",
        sessionId: name,
        acceptedAt: new Date().toISOString(),
        text: "hello",
      },
    });
    expect(completion.runId).toBe("run-1");

    // Settled durably, with the provider's own words kept where the debug
    // surface reads them.
    const stored = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<{ status: string; failure?: string }>("run:run-1"),
    );
    expect(stored?.status).toBe("failed");
    // Genuinely the provider's refusal, not some other way to fail a Turn.
    expect(stored?.failure).toContain("401");

    // And the Bot is not wedged: nothing is holding the next Turn.
    const active = await runInDurableObject(stub, (_instance, state) =>
      state.storage.get<string>("active-run"),
    );
    expect(active).toBeUndefined();

    // What the person reads is the sentence for the outcome, never the
    // diagnostic — `runFailureCopyV1` maps it on the way to the wire.
    const runs = await (stub as unknown as RefusalRpc).listRuns({
      ...identity,
      query: { schemaVersion: 1 },
    });
    const projected = runs.runs.find((run) => run.runId === "run-1");
    expect(projected?.status).toBe("failed");
    const message = projected?.outcome?.message ?? "";
    expect(message.length).toBeGreaterThan(0);
    for (const word of JARGON) expect(message).not.toContain(word);
  });
});
