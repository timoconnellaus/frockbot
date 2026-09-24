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

  // Mallory starts a sign-in on her own account and sends Tim its link. Tim
  // signs in to the server, and the server sends his browser back with a code
  // and Mallory's state. That code is traded for nobody.
  test("the callback trades a code only for the browser of the User who started it", async () => {
    const { routes, executed } = harness((command) =>
      receipt(command, {
        oauth: { attemptId: "cx-1", status: "ready" },
      }),
    );
    const state = await signMcpOAuthStateV1(keyring, {
      userId: "mallory",
      connectionId: "connection-1",
      attemptId: "cx-1",
      expiresAt: now + 60_000,
    });
    const url = new URL(
      `${ORIGIN}/api/mcp/oauth/callback?code=c&state=${state}&iss=https%3A%2F%2Fauth.example.test`,
    );
    for (const session of [undefined, "tim"]) {
      const page = await routes.publicRoute(new Request(url), url, {
        sessionUserId: async () => session,
      });
      expect(page?.status).toBe(200);
      expect(await page?.text()).toContain("Finish signing in from FrockBot");
    }
    const sessionless = await routes.publicRoute(new Request(url), url);
    expect(await sessionless?.text()).toContain("nothing was connected");
    expect(executed).toEqual([]);

    const page = await routes.publicRoute(new Request(url), url, {
      sessionUserId: async () => "mallory",
    });
    expect(await page?.text()).toContain("Signed in");
    const traded = new URL(`${ORIGIN}/api/mcp/oauth/callback`);
    traded.searchParams.set("state", state);
    traded.searchParams.set("code", "c");
    traded.searchParams.set("iss", "https://auth.example.test");
    expect(executed).toEqual([
      {
        userId: "mallory",
        command: {
          schemaVersion: 1,
          type: "connection/oauth",
          commandId: "mcp-return-cx-1",
          attemptId: "cx-1",
          packageId: "mcp",
          action: "complete",
          connectionId: "connection-1",
          code: traded.href,
        },
      },
    ]);
  });

  test("an app's return page hands the answer to the app, and trades nothing", async () => {
    const { routes, executed } = harness((command) => receipt(command));
    const state = await signMcpOAuthStateV1(keyring, {
      userId: "tim",
      connectionId: "connection-1",
      attemptId: "cx-1",
      expiresAt: now + 60_000,
    });
    const url = new URL(
      `${ORIGIN}/api/mcp/oauth/callback/android?code=c%2B1&state=${state}&extra=x`,
    );
    const response = await routes.publicRoute(new Request(url), url, {
      sessionUserId: async () => "tim",
    });
    expect(response?.status).toBe(303);
    const location = new URL(response?.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(
      `${ORIGIN}/api/connect/callback/android`,
    );
    expect([...location.searchParams]).toEqual([
      ["mcp_state", state],
      ["mcp_code", "c+1"],
    ]);
    expect(executed).toEqual([]);
  });

  test("an app finishes a sign-in under its own session, and only its own", async () => {
    const { routes, executed } = harness((command) =>
      receipt(command, {
        oauth: { attemptId: "cx-1", status: "ready" },
      }),
    );
    const state = await signMcpOAuthStateV1(keyring, {
      userId: "mallory",
      connectionId: "connection-1",
      attemptId: "cx-1",
      expiresAt: now + 60_000,
    });
    const url = new URL(`${ORIGIN}/api/mcp/oauth/complete`);
    const post = (body: unknown) =>
      new Request(url, { method: "POST", body: JSON.stringify(body) });
    const answer = { schemaVersion: 1, state, code: "c" };

    expect((await routes.route(post(answer), url, {}))?.status).toBe(401);
    const elsewhere = await routes.route(post(answer), url, { userId: "tim" });
    expect(elsewhere?.status).toBe(403);
    expect(await bodyOf(elsewhere)).toEqual({
      error:
        "This sign-in was started from another FrockBot account, so nothing was connected.",
    });
    for (const invalid of [
      { ...answer, schemaVersion: 2 },
      { ...answer, code: 1 },
      { ...answer, code: "c".repeat(5_000) },
      { ...answer, state: "forged.state" },
      { schemaVersion: 1, code: "c" },
    ]) {
      const refused = await routes.route(post(invalid), url, {
        userId: "mallory",
      });
      expect(refused?.status).toBe(400);
    }
    expect(executed).toEqual([]);

    const finished = await routes.route(post(answer), url, {
      userId: "mallory",
    });
    expect(await bodyOf(finished)).toEqual({
      schemaVersion: 1,
      status: "ready",
      connectionId: "connection-1",
    });
    expect(executed.map(({ userId, command }) => [userId, command])).toEqual([
      [
        "mallory",
        expect.objectContaining({
          commandId: "mcp-return-cx-1",
          action: "complete",
          code: `${ORIGIN}/api/mcp/oauth/callback?state=${state}&code=c`,
        }),
      ],
    ]);
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
