import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { createConfiguredComposioBackendContribution } from "@frockbot/plugin-composio/backend";
import { decodeStartConnectionResultV1 } from "@frockbot/connection-core";

interface UserRpc {
  composioRequest(input: unknown): Promise<unknown>;
  readConfiguration(input: unknown): Promise<{
    connections: Array<{
      connectionId: string;
      state: string;
      safeMetadata: unknown;
    }>;
  }>;
}

test("Gmail connects through the public callback into a reconstructed User DO and revokes account-wide", async () => {
  const userId = "connect-gmail-workerd";
  const stub = env.USER_CONFIGURATIONS.getByName(userId);
  const rpc = stub as unknown as UserRpc;
  const gateway = createConfiguredComposioBackendContribution({
    readSecret: (name) =>
      name === "COMPOSIO_API_KEY"
        ? "test-composio-backend-key"
        : name === "FROCKBOT_AUTHORIZATION_STATE_SECRET"
          ? "workerd-mcp-oauth-state-secret-0123456789abcdef"
          : undefined,
    composioRequest: async (owner, command) => {
      expect(owner).toBe(userId);
      return JSON.parse(
        JSON.stringify(
          await rpc.composioRequest({
            schemaVersion: 1,
            userId: owner,
            command,
          }),
        ),
      );
    },
  });
  const startUrl = new URL(
    "https://bot.frockbot.com/api/plugins/composio/connections",
  );
  const response = await gateway.route(
    new Request(startUrl, {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: 1,
        type: "connection/start",
        commandId: "gmail-workerd-connection",
        connectionTypeId: "app",
        connectorId: "gmail",
      }),
    }),
    startUrl,
    { userId, client: "browser" },
  );
  expect(response?.status, await response?.clone().text()).toBe(201);
  const link = decodeStartConnectionResultV1(await response!.json());
  if (link.status !== "authorization-required")
    throw new Error("Expected authorization");
  await evictDurableObject(stub);
  const callbackUrl = new URL(link.redirectUrl);
  expect(
    (
      await gateway.publicRoute!(new Request(callbackUrl), callbackUrl, {
        userId: "forged",
        client: "browser",
      })
    )?.status,
  ).toBe(303);
  await evictDurableObject(stub);
  const read = () =>
    rpc.readConfiguration({
      schemaVersion: 1,
      userId,
    });
  const connected = await read();
  expect(
    connected.connections.find(
      (row) => row.connectionId === "gmail-workerd-connection",
    )?.state,
  ).toBe("ready");
  expect(JSON.stringify(connected)).not.toContain("test-composio-backend-key");
  expect(JSON.stringify(connected)).not.toContain("redirectUrl");
  // Replaying the callback is a read of the durable terminal result.
  await gateway.publicRoute!(new Request(callbackUrl), callbackUrl, {
    client: "browser",
  });
  expect(
    (await read()).connections.filter((row) => row.state === "ready"),
  ).toHaveLength(1);
  const revoke = await rpc.composioRequest({
    schemaVersion: 1,
    userId,
    command: {
      schemaVersion: 1,
      operation: "revoke",
      connectionId: "gmail-workerd-connection",
    },
  });
  expect(revoke).toMatchObject({ status: "revoked" });
  await evictDurableObject(stub);
  expect(
    (await read()).connections.find(
      (row) => row.connectionId === "gmail-workerd-connection",
    )?.state,
  ).toBe("revoked");
});
