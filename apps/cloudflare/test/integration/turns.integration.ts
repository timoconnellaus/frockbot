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
  OLLAMA_REVOKED_API_KEY,
  postAsUser,
  provisionThroughGateway,
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
    // A failed Turn is a JSON failure with a reason, not a transport error and
    // not an HTML page.
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("application/json");
    const reason = (body as { error?: string }).error ?? "";
    expect(reason).not.toBe("");
    // The reason names what the provider said. `plugin-provider-ollama-cloud`
    // reports the transport status rather than the response body, so `401` is
    // the provider's text that reaches the client today; the assertion is on
    // the status the stub returned, not on a generic "failed".
    expect(reason).toContain("model-error");
    expect(reason).toContain("401");

    // And the same reason is durable, so the client can read it again after a
    // reload rather than only seeing it on the failing request.
    const list = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/turns`),
    )) as { runs: RunView[] };
    const run = list.runs.find((entry) => entry.runId === "turn-command-401");
    expect(run).toBeDefined();
    expect(run?.status).toBe("failed");
    expect(run?.outcome?.message ?? "").toBe(reason);
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
