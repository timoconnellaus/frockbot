import { describe, expect, test } from "bun:test";
import type {
  ConnectionCommandReceiptV1,
  ConnectionCommandV1,
} from "@frockbot/core/connection";
import { createConnectBackendContribution } from "./backend.js";

const CONTEXT = { userId: "tim", client: "browser" as const };

function contribution(
  answer: (command: ConnectionCommandV1) => ConnectionCommandReceiptV1,
) {
  const commands: ConnectionCommandV1[] = [];
  const backend = createConnectBackendContribution({
    executeConnection: (_userId, command) => {
      commands.push(command);
      return Promise.resolve(answer(command));
    },
  });
  return { backend, commands };
}

function post(path: string, body: unknown): [Request, URL] {
  const url = new URL(`https://bot.frockbot.com${path}`);
  return [
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    url,
  ];
}

describe("the Connected apps gateway routes", () => {
  test("starts a hosted grant and answers with the sign-in destination", async () => {
    const { backend, commands } = contribution((command) => ({
      schemaVersion: 1,
      commandId: command.commandId,
      connectionId: "connection-1",
      status: "applied",
      oauth: {
        attemptId: command.commandId,
        status: "waiting",
        authorizationUrl: "https://connect.example/go",
        expiresAt: Date.UTC(2026, 8, 11),
      },
    }));
    const response = await backend.route(
      ...post("/api/plugins/connect/connections", {
        schemaVersion: 1,
        type: "connection/start",
        commandId: "start-1",
        connectionTypeId: "connect-gmail",
        returnClient: "android",
      }),
      CONTEXT,
    );
    expect(response?.status).toBe(200);
    const body: unknown = await response!.json();
    expect(body).toEqual({
      schemaVersion: 1,
      status: "authorization-required",
      connectionId: "connection-1",
      redirectUrl: "https://connect.example/go",
      expiresAt: "2026-09-11T00:00:00.000Z",
    });
    expect(commands[0]).toMatchObject({
      type: "connection/oauth",
      action: "start",
      packageId: "connect",
      commandId: "start-1",
      connectionTypeId: "connect-gmail",
      // The app's own return page, on this gateway's origin.
      callbackUrl: "https://bot.frockbot.com/api/connect/callback/android",
    });
  });

  test("refuses an app this deployment does not offer, before any command", async () => {
    const { backend, commands } = contribution(() => {
      throw new Error("must not be called");
    });
    const response = await backend.route(
      ...post("/api/plugins/connect/connections", {
        schemaVersion: 1,
        type: "connection/start",
        commandId: "start-2",
        connectionTypeId: "connect-fax",
      }),
      CONTEXT,
    );
    expect(response?.status).toBe(400);
    expect(commands).toHaveLength(0);
  });

  test("says connecting is unavailable when the User object could not start one", async () => {
    const { backend } = contribution((command) => ({
      schemaVersion: 1,
      commandId: command.commandId,
      connectionId: "none",
      status: "failed",
    }));
    const response = await backend.route(
      ...post("/api/plugins/connect/connections", {
        schemaVersion: 1,
        type: "connection/start",
        commandId: "start-3",
        connectionTypeId: "connect-slack",
      }),
      CONTEXT,
    );
    expect(response?.status).toBe(400);
    expect(((await response?.json()) as { error: string }).error).toContain(
      "isn't available",
    );
  });

  test("revokes through a disconnect command that also revokes upstream", async () => {
    const { backend, commands } = contribution((command) => ({
      schemaVersion: 1,
      commandId: command.commandId,
      connectionId: "connection-1",
      status: "applied",
    }));
    const response = await backend.route(
      ...post("/api/plugins/connect/connections/connection-1/revoke", {
        schemaVersion: 1,
        type: "connection/revoke",
      }),
      CONTEXT,
    );
    const body: unknown = await response!.json();
    expect(body).toEqual({
      schemaVersion: 1,
      status: "revoked",
    });
    expect(commands[0]).toMatchObject({
      type: "connection/disconnect",
      connectionId: "connection-1",
      revokeUpstream: true,
    });
  });

  test("requires a session on both authenticated routes", async () => {
    const { backend } = contribution(() => {
      throw new Error("must not be called");
    });
    const response = await backend.route(
      ...post("/api/plugins/connect/connections", {}),
      { client: "browser" },
    );
    expect(response?.status).toBe(401);
  });

  test("the return page is public, sends a person back, and touches nothing", async () => {
    const { backend, commands } = contribution(() => {
      throw new Error("must not be called");
    });
    const ok = await backend.publicRoute!(
      new Request(
        "https://bot.frockbot.com/api/connect/callback?status=success",
      ),
      new URL("https://bot.frockbot.com/api/connect/callback?status=success"),
      {},
    );
    expect(ok?.status).toBe(200);
    expect(await ok?.text()).toContain("Back to FrockBot");
    const failed = await backend.publicRoute!(
      new Request(
        "https://bot.frockbot.com/api/connect/callback?status=failed",
      ),
      new URL("https://bot.frockbot.com/api/connect/callback?status=failed"),
      {},
    );
    expect(await failed?.text()).toContain("Back to FrockBot");
    expect(commands).toHaveLength(0);
    // Each app's own page: Android's verified link has already opened the
    // app, so its page carries no script; the Mac page hands over on the
    // app's scheme, under a nonce, with nothing from the query attached.
    const android = await backend.publicRoute!(
      new Request(
        "https://bot.frockbot.com/api/connect/callback/android?status=success&connectedAccountId=ca_1",
      ),
      new URL(
        "https://bot.frockbot.com/api/connect/callback/android?status=success&connectedAccountId=ca_1",
      ),
      {},
    );
    const androidPage = await android!.text();
    expect(androidPage).toContain("Head back to the FrockBot app");
    expect(androidPage).not.toContain("<script");
    expect(androidPage).not.toContain("ca_1");
    expect(android!.headers.get("content-security-policy")).not.toContain(
      "script-src",
    );
    const mac = await backend.publicRoute!(
      new Request(
        "https://bot.frockbot.com/api/connect/callback/macos?status=success&connectedAccountId=ca_1",
      ),
      new URL(
        "https://bot.frockbot.com/api/connect/callback/macos?status=success&connectedAccountId=ca_1",
      ),
      {},
    );
    const macPage = await mac!.text();
    expect(macPage).toContain(
      "frockbot://bot.frockbot.com/api/connect/callback/macos",
    );
    expect(macPage).not.toContain("ca_1");
    expect(mac!.headers.get("content-security-policy")).toMatch(
      /script-src 'nonce-[0-9a-f-]{36}'/,
    );
    // Not a page of ours.
    expect(
      await backend.publicRoute!(
        new Request("https://bot.frockbot.com/api/connect/callback/ios"),
        new URL("https://bot.frockbot.com/api/connect/callback/ios"),
        {},
      ),
    ).toBeUndefined();
    const other = await backend.publicRoute!(
      new Request("https://bot.frockbot.com/api/other"),
      new URL("https://bot.frockbot.com/api/other"),
      {},
    );
    expect(other).toBeUndefined();
  });
});
