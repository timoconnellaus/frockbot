// Seam S4 (gateway → connections route → User Durable Object) and seam S7
// (User Durable Object → outbound Ollama Cloud).
//
// Incident 4 — "Failed to fetch" when the User pressed Connect — lived on S4,
// which had unit coverage on both sides and none across.
// Incident 5 — a garbage key reached `ready` — lived on S7: every catalog read
// Ollama Cloud offers answers 200 for any key, so only `POST /api/chat`
// distinguishes a good key from a bad one, and validation did not call it.
import { describe, expect, it } from "vitest";
import {
  asUser,
  expectOkJson,
  freshUserId,
  OLLAMA_BAD_API_KEY,
  OLLAMA_GOOD_API_KEY,
  postAsUser,
  PROVISIONED_MODEL,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

interface ConnectionView {
  connectionId: string;
  state: string;
  failure?: string;
}

async function installProvider(userId: string): Promise<void> {
  await expectOkJson(
    await postAsUser(userId, "/api/settings", {
      schemaVersion: 1,
      type: "user/install-package",
      commandId: "install-provider",
      expectedRevision: 0,
      packageId: PROVISIONED_MODEL.packageId,
      version: "0.0.1",
    }),
  );
}

function connect(
  userId: string,
  commandId: string,
  apiKey: string,
): Promise<Response> {
  return postAsUser(userId, "/api/connections", {
    schemaVersion: 1,
    type: "connection/create-api-key",
    commandId,
    packageId: PROVISIONED_MODEL.packageId,
    connectionTypeId: PROVISIONED_MODEL.connectionTypeId,
    label: "Integration",
    apiKey,
  });
}

async function readConnection(
  userId: string,
  connectionId: string,
): Promise<ConnectionView> {
  const settings = (await expectOkJson(
    await asUser(userId, "/api/settings"),
  )) as { connections: ConnectionView[] };
  const connection = settings.connections.find(
    (candidate) => candidate.connectionId === connectionId,
  );
  expect(connection).toBeDefined();
  return connection!;
}

describe("creating an API key Connection through the gateway", () => {
  it("answers the browser with JSON, never a transport failure", async () => {
    const userId = freshUserId("connect-ok");
    await installProvider(userId);

    const response = await connect(userId, "connect-1", OLLAMA_GOOD_API_KEY);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
  });

  it("leaves a key the provider rejects for inference failed, with the reason", async () => {
    const userId = freshUserId("connect-bad");
    await installProvider(userId);

    const receipt = (await expectOkJson(
      await connect(userId, "connect-bad", OLLAMA_BAD_API_KEY),
    )) as { connectionId: string; status: string };

    const connection = await readConnection(userId, receipt.connectionId);
    expect(connection.state).not.toBe("ready");
    expect(connection.state).toBe("failed");
    expect(connection.failure ?? "").toMatch(/inference/i);
    expect(connection.failure ?? "").toContain("Unauthorized");
  });

  it("reaches ready for a key the provider accepts for inference", async () => {
    const userId = freshUserId("connect-good");
    await installProvider(userId);

    const receipt = (await expectOkJson(
      await connect(userId, "connect-good", OLLAMA_GOOD_API_KEY),
    )) as { connectionId: string; status: string };
    expect(receipt.status).toBe("applied");

    const connection = await readConnection(userId, receipt.connectionId);
    expect(connection.state).toBe("ready");
    expect(connection.failure).toBeUndefined();
  });

  it("answers a Connection command lookup for the command the client sent", async () => {
    const userId = freshUserId("connect-lookup");
    await installProvider(userId);
    await connect(userId, "connect-lookup", OLLAMA_GOOD_API_KEY);

    const lookup = await asUser(
      userId,
      `/api/connection-commands?packageId=${PROVISIONED_MODEL.packageId}&commandId=connect-lookup`,
    );
    expect(lookup.status).toBe(200);
    expect(await lookup.json()).toMatchObject({
      schemaVersion: 1,
      commandId: "connect-lookup",
      status: "applied",
    });
  });
});
