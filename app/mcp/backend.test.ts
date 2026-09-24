import { describe, expect, test } from "bun:test";
import type {
  ConnectionCommandReceiptV1,
  ConnectionCommandV1,
} from "@frockbot/core/connection";
import { createMcpBackendContribution } from "./backend.js";
import { signMcpOAuthStateV1 } from "./oauth-state.js";

const ORIGIN = "https://bot.frockbot.test";
const now = Date.parse("2026-09-24T00:00:00.000Z");
const keyring = JSON.stringify({
  schemaVersion: 1,
  currentKeyId: "primary",
  keys: {
    primary: btoa(
      String.fromCharCode(...Uint8Array.from({ length: 32 }, (_, i) => i + 1)),
    )
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, ""),
  },
});

function harness(
  answer: (command: ConnectionCommandV1) => ConnectionCommandReceiptV1,
) {
  const executed: { userId: string; command: ConnectionCommandV1 }[] = [];
  const routes = createMcpBackendContribution({
    mcpSignInKeyring: keyring,
    now: () => now,
    executeConnection: async (userId, command) => {
      executed.push({ userId, command });
      return answer(command);
    },
  });
  return { routes, executed };
}

async function bodyOf(response: Response | undefined): Promise<unknown> {
  return response?.json();
}

function receipt(
  command: ConnectionCommandV1,
  rest: Partial<ConnectionCommandReceiptV1> = {},
): ConnectionCommandReceiptV1 {
  return {
    schemaVersion: 1,
    commandId: command.commandId,
    connectionId: "connection-1",
    status: "applied",
    ...rest,
  };
}

describe("the MCP sign-in routes", () => {
  test("start a sign-in with this gateway's own return page", async () => {
    const { routes, executed } = harness((command) =>
      receipt(command, {
        oauth: {
          attemptId: command.commandId,
          status: "waiting",
          authorizationUrl: "https://auth.example.test/authorize?x=1",
          expiresAt: now + 600_000,
        },
      }),
    );
    const url = new URL(
      `${ORIGIN}/api/plugins/mcp/connections/connection-1/authorize`,
    );
    const response = await routes.route(
      new Request(url, {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: 1,
          type: "connection/start",
          commandId: "cx-1",
          connectionTypeId: "mcp-server",
          returnClient: "macos",
        }),
      }),
      url,
      { userId: "tim" },
    );
    expect(await bodyOf(response)).toEqual({
      schemaVersion: 1,
      status: "authorization-required",
      connectionId: "connection-1",
      redirectUrl: "https://auth.example.test/authorize?x=1",
      expiresAt: new Date(now + 600_000).toISOString(),
    });
    expect(executed).toEqual([
      {
        userId: "tim",
        command: {
          schemaVersion: 1,
          type: "connection/oauth",
          commandId: "cx-1",
          attemptId: "cx-1",
          packageId: "mcp",
          action: "start",
          connectionId: "connection-1",
          callbackUrl: `${ORIGIN}/api/mcp/oauth/callback/macos`,
        },
      },
    ]);
    const anonymous = await routes.route(new Request(url), url, {});
    expect(anonymous?.status).toBe(401);
  });

  test("remove a server for an installed app's Disconnect", async () => {
    const { routes, executed } = harness((command) => receipt(command));
    const url = new URL(
      `${ORIGIN}/api/plugins/mcp/connections/connection-1/revoke`,
    );
    const response = await routes.route(
      new Request(url, {
        method: "POST",
        body: JSON.stringify({ schemaVersion: 1, type: "connection/revoke" }),
      }),
      url,
      { userId: "tim" },
    );
    expect(await bodyOf(response)).toEqual({
      schemaVersion: 1,
      status: "revoked",
    });
    expect(executed[0]?.command).toMatchObject({
      type: "connection/disconnect",
      connectionId: "connection-1",
    });
  });

  test("the callback addresses nothing until its state verifies", async () => {
    const { routes, executed } = harness((command) => receipt(command));
    for (const state of ["", "forged.state", "x".repeat(5_000)]) {
      const url = new URL(
        `${ORIGIN}/api/mcp/oauth/callback/android?code=c&state=${state}`,
      );
      const page = await routes.publicRoute(new Request(url), url);
      expect(page?.status).toBe(200);
      expect(await page?.text()).toContain("expired");
    }
    const expired = await signMcpOAuthStateV1(keyring, {
      userId: "tim",
      connectionId: "connection-1",
      attemptId: "cx-1",
      expiresAt: now,
    });
    const url = new URL(
      `${ORIGIN}/api/mcp/oauth/callback?code=c&state=${expired}`,
    );
    await routes.publicRoute(new Request(url), url);
    expect(executed).toEqual([]);
  });

  test("the callback completes the sign-in its state names, and hands back to the app", async () => {
    const { routes, executed } = harness((command) =>
      receipt(command, {
        oauth: { attemptId: "cx-1", status: "ready" },
      }),
    );
    const state = await signMcpOAuthStateV1(keyring, {
      userId: "tim",
      connectionId: "connection-1",
      attemptId: "cx-1",
      expiresAt: now + 60_000,
    });
    const url = new URL(
      `${ORIGIN}/api/mcp/oauth/callback/android?code=c&state=${state}`,
    );
    const response = await routes.publicRoute(new Request(url), url);
    expect(response?.status).toBe(303);
    expect(response?.headers.get("location")).toBe(
      `${ORIGIN}/api/connect/callback/android`,
    );
    expect(executed).toEqual([
      {
        userId: "tim",
        command: {
          schemaVersion: 1,
          type: "connection/oauth",
          commandId: "mcp-return-cx-1",
          attemptId: "cx-1",
          packageId: "mcp",
          action: "complete",
          connectionId: "connection-1",
          code: url.href,
        },
      },
    ]);
    const browser = new URL(
      `${ORIGIN}/api/mcp/oauth/callback?code=c&state=${state}`,
    );
    const page = await routes.publicRoute(new Request(browser), browser);
    expect(await page?.text()).toContain("Signed in");
  });

  test("serves FrockBot's client metadata document", async () => {
    const { routes } = harness((command) => receipt(command));
    const url = new URL(`${ORIGIN}/api/mcp/oauth/client`);
    const response = await routes.publicRoute(new Request(url), url);
    expect(await response?.json()).toMatchObject({
      client_id: `${ORIGIN}/api/mcp/oauth/client`,
      client_name: "FrockBot",
      token_endpoint_auth_method: "none",
    });
    const other = new URL(`${ORIGIN}/api/mcp/oauth/elsewhere`);
    expect(await routes.publicRoute(new Request(other), other)).toBeUndefined();
  });
});
