// Seam S5 (application Worker → Bot Durable Object turns and runs) and the
// Turn half of seam S7 (Bot Durable Object → outbound Ollama Cloud).
//
// Incident 1 lived here: `listRuns` threw past the route, the application
// Worker died, and workerd's own HTML error page reached `apiRequest`, which
// called `response.json()` on it — "Unexpected token '<'". The route now
// answers a stored run the codec refuses with JSON and a reason.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  asUser,
  expectJson,
  expectOkJson,
  freshUserId,
  OLLAMA_FLAKY_API_KEY,
  OLLAMA_REVOKED_API_KEY,
  postAsUser,
  provisionThroughGateway,
  readStoredRunWithEventsV1,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

interface RunView {
  runId: string;
  status?: string;
  outcome?: { type: string; message?: string };
}

function botStub(userId: string, botId: string) {
  return env.BOT_STATES.get(env.BOT_STATES.idFromName(`${userId}:${botId}`));
}

async function runTurn(
  userId: string,
  botId: string,
  text: string,
  commandId: string,
): Promise<{ response: Response; body: unknown }> {
  const response = await postAsUser(userId, `/api/bots/${botId}/turns`, {
    schemaVersion: 1,
    commandId,
    text,
  });
  return { response, body: await response.json() };
}

describe("a Turn through the gateway, the loaded artifact and the Bot", () => {
  it("retries one transient provider rejection and journals the wait", async () => {
    const userId = freshUserId("turn-503");
    const botId = "flaky-bot";
    await provisionThroughGateway({
      userId,
      botId,
      apiKey: OLLAMA_FLAKY_API_KEY,
    });

    const { response, body } = await runTurn(
      userId,
      botId,
      "hello",
      "turn-command-503",
    );
    expect(response.status).toBe(200);
    expect(JSON.stringify(body)).toContain("Ollama reply");

    const stored = await readStoredRunWithEventsV1<{
      events: Array<{
        type: string;
        classification?: string;
        delayMs?: number;
      }>;
    }>(userId, botId, "turn-command-503");
    expect(
      stored?.events.filter((event) => event.type === "model/request"),
    ).toHaveLength(2);
    expect(
      stored?.events.filter((event) => event.type === "assistant/message"),
    ).toHaveLength(1);
    const retries = stored?.events.filter(
      (event) => event.type === "model/retry",
    );
    expect(retries).toHaveLength(1);
    expect(retries?.[0]).toMatchObject({ classification: "transient" });
    expect(retries?.[0]?.delayMs).toBeGreaterThanOrEqual(250);
    expect(retries?.[0]?.delayMs).toBeLessThanOrEqual(500);
  });

  it("answers with the provider's reply and lists the run afterwards", async () => {
    const userId = freshUserId("turn");
    const botId = "turn-bot";
    await provisionThroughGateway({ userId, botId });

    const { response, body } = await runTurn(
      userId,
      botId,
      "hello",
      "turn-command-1",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(JSON.stringify(body)).toContain("Ollama reply");

    const list = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/turns`),
    )) as { runs: RunView[] };
    expect(list.runs.length).toBeGreaterThan(0);
    expect(list.runs.map((run) => run.runId)).toContain("turn-command-1");
  });

  it("carries a provider rejection into the run's durable failure", async () => {
    // The key validates (`POST /api/chat` accepts it) so the Connection
    // reaches `ready` and the Bot is created — then the provider rejects the
    // Turn's streaming call, exactly as a key revoked after setup would.
    const userId = freshUserId("turn-401");
    const botId = "failing-bot";
    await provisionThroughGateway({
      userId,
      botId,
      apiKey: OLLAMA_REVOKED_API_KEY,
    });

    const { response, body } = await runTurn(
      userId,
      botId,
      "hello",
      "turn-command-401",
    );
    // A Turn the provider refused settles itself — a `turn/end`, a durable
    // `failed` record, the provider's own words on it — and the request that
    // started it answers with that settlement. It used to answer 500 over the
    // top of it, which logged `Uncaught Error: Bot turn ended with outcome
    // model-error: Model request failed (401)` in the Worker and told the
    // person their connection was at fault.
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect((body as { error?: string }).error).toBeUndefined();

    // The failure is durable, so the client reads it again after a reload
    // rather than only on the request that produced it.
    const list = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/turns`),
    )) as { runs: RunView[] };
    const run = list.runs.find((entry) => entry.runId === "turn-command-401");
    expect(run).toBeDefined();
    expect(run?.status).toBe("failed");

    const stored = await readStoredRunWithEventsV1<{
      events: Array<{ type: string }>;
    }>(userId, botId, "turn-command-401");
    expect(
      stored?.events.filter((event) => event.type === "model/request"),
    ).toHaveLength(1);
    expect(
      stored?.events.filter((event) => event.type === "model/retry"),
    ).toHaveLength(0);

    // And what it says is written for the person. The provider's status code
    // and the outcome's name stay on the stored record, which is what the
    // debug surface reads; neither belongs in a chat bubble.
    const message = run?.outcome?.message ?? "";
    expect(message).not.toBe("");
    expect(message).not.toContain("model-error");
    expect(message).not.toContain("401");
    expect(message).not.toContain("Ollama");
  });
});

describe("a stored run the current codec refuses", () => {
  it("is a JSON failure with its reason, never workerd's HTML error page", async () => {
    const userId = freshUserId("codec");
    const botId = "codec-bot";
    await provisionThroughGateway({ userId, botId });

    // Planted through the Bot Durable Object's own storage: no command can
    // produce a record the codec refuses, and the incident was a record
    // written by an older codec that a newer one no longer accepts.
    await runInDurableObject(
      botStub(userId, botId),
      async (_instance, state) => {
        await state.storage.put({
          "run:planted": { runId: "planted", events: "not-an-array" },
          "run-index:2026-01-01T00:00:00.000Z:planted": "planted",
        });
      },
    );

    const response = await asUser(userId, `/api/bots/${botId}/turns`);

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await expectJson(response)) as { error: string };
    expect(body.error).toContain("stored run");
    // The incident's actual symptom: an HTML body decoded as JSON.
    expect(JSON.stringify(body).startsWith("<")).toBe(false);
    expect(body.error.startsWith("<")).toBe(false);
  });
});
