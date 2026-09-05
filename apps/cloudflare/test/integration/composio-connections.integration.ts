import { expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import {
  asUser,
  expectOkJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();
it("a direct Gmail connector completes a public callback, survives replay, and disconnects", async () => {
  const userId = freshUserId("gmail-connect");
  await provisionThroughGateway({ userId, botId: "gmail-integration-bot" });
  const catalog = (await expectOkJson(
    await asUser(userId, "/api/plugins/composio/catalog"),
  )) as { items: Array<{ id: string; name: string }> };
  expect(catalog.items).toContainEqual(
    expect.objectContaining({ id: "gmail", name: "Gmail" }),
  );
  const startResponse = await postAsUser(
    userId,
    "/api/plugins/composio/connections",
    {
      schemaVersion: 1,
      type: "connection/start",
      commandId: "gmail-integration-one",
      connectionTypeId: "app",
      connectorId: "gmail",
    },
  );
  expect(startResponse.status).toBe(201);
  const started = (await startResponse.json()) as { redirectUrl: string };
  const callback = new URL(started.redirectUrl);
  callback.searchParams.set("user_id", "forged");
  // No as_user query or session: the callback is dispatched before auth.
  const response = await SELF.fetch(callback.toString(), {
    redirect: "manual",
  });
  expect(response.status).toBe(303);
  await SELF.fetch(callback.toString(), { redirect: "manual" });
  const settings = (await expectOkJson(
    await asUser(userId, "/api/settings"),
  )) as { connections: Array<{ connectionId: string; state: string }> };
  expect(
    settings.connections.filter(
      (row) => row.connectionId === "gmail-integration-one",
    ),
  ).toEqual([expect.objectContaining({ state: "ready" })]);
  expect(JSON.stringify(settings)).not.toMatch(
    /test-composio-backend-key|redirectUrl|authorizationStateId/,
  );
  expect(
    await expectOkJson(
      await postAsUser(
        userId,
        "/api/plugins/composio/connections/gmail-integration-one/revoke",
        { schemaVersion: 1, type: "connection/revoke" },
      ),
    ),
  ).toMatchObject({ status: "revoked" });
});
