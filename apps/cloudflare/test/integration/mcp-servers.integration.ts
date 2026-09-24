// Remote MCP servers, end to end through the gateway: the Connectors row, an
// add by address with and without a token, a sign-in to a server behind
// OAuth, a Bot calling the server's tool under its namespace, the call's audit
// row, and the removal. The server is the harness stub at `mcp.example.test`,
// and its authorization server the one at `mcp-auth.example.test`.
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  asUser,
  expectOkJson,
  freshUserId,
  MCP_AUTH_STUB_ORIGIN,
  MCP_STUB_ORIGIN,
  MCP_TEST_TOKEN,
  postAsUser,
  provisionThroughGateway,
  toolCallTriggerPrompt,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

interface ConnectionRow {
  connectionId: string;
  packageId: string;
  displayName: string;
  state: string;
  failure?: string;
  authorization?: { kind: string };
  settings?: Record<string, unknown>;
  safeMetadata: Record<string, unknown>;
}

async function servers(userId: string): Promise<ConnectionRow[]> {
  const settings = (await expectOkJson(
    await asUser(userId, "/api/settings"),
  )) as { connections: ConnectionRow[] };
  return settings.connections.filter(
    (row) => row.packageId === "mcp" && row.state !== "revoked",
  );
}

function addServer(
  userId: string,
  commandId: string,
  path: string,
  token?: string,
) {
  return postAsUser(userId, "/api/connections", {
    schemaVersion: 1,
    type: token ? "connection/create-api-key" : "connection/create",
    commandId,
    packageId: "mcp",
    connectionTypeId: "mcp-server",
    label: "Example",
    ...(token ? { apiKey: token } : {}),
    settings: { url: `${MCP_STUB_ORIGIN}${path}` },
  });
}

async function callEcho(userId: string, botId: string, commandId: string) {
  return (await expectOkJson(
    await postAsUser(userId, `/api/bots/${botId}/turns`, {
      schemaVersion: 1,
      commandId,
      text: toolCallTriggerPrompt([
        "call_dynamic_tool",
        {
          namespace: "mcp-example",
          toolName: "echo",
          arguments: { message: "hello" },
          mcpDetails: { description: "Checking the server answers" },
        },
      ]),
    }),
  )) as {
    events: Array<{ type: string; content?: string; isError?: boolean }>;
  };
}

/**
 * Starts a sign-in to the server `userId` added, approves it at the stub
 * authorization server, and answers where the server sent the browser back.
 */
async function signInReturn(
  userId: string,
  connectionId: string,
  commandId: string,
  returnClient?: string,
): Promise<URL> {
  const start = (await expectOkJson(
    await postAsUser(
      userId,
      `/api/plugins/mcp/connections/${connectionId}/authorize`,
      {
        schemaVersion: 1,
        type: "connection/start",
        commandId,
        connectionTypeId: "mcp-server",
        ...(returnClient ? { returnClient } : {}),
      },
    ),
  )) as { status: string; redirectUrl: string };
  expect(start.status).toBe("authorization-required");
  expect(new URL(start.redirectUrl).origin).toBe(MCP_AUTH_STUB_ORIGIN);
  // The authorization server approves at once and sends the browser back.
  const approved = await fetch(start.redirectUrl, { redirect: "manual" });
  return new URL(approved.headers.get("location")!);
}

async function addSignInServer(userId: string, commandId: string) {
  expect(
    await expectOkJson(await addServer(userId, commandId, "/oauth/mcp")),
  ).toMatchObject({ status: "failed" });
  const [pending] = await servers(userId);
  expect(pending).toMatchObject({
    state: "failed",
    authorization: { kind: "grant" },
  });
  return pending!.connectionId;
}

describe("MCP servers", () => {
  it("offers a server by address on the Connectors surface", async () => {
    const userId = freshUserId("mcp-row");
    await provisionThroughGateway({ userId, botId: "row" });
    const frame = (await expectOkJson(
      await asUser(userId, "/api/settings/connections"),
    )) as {
      providers: Array<{
        packageId: string;
        connectionTypeId: string;
        authorization: string;
        settings?: Array<{ id: string }>;
      }>;
    };
    expect(
      frame.providers.find((provider) => provider.packageId === "mcp"),
    ).toMatchObject({
      connectionTypeId: "mcp-server",
      authorization: "api-key",
      settings: [{ id: "url" }],
    });
  });

  it("adds a server, lists its tools, and runs one for a Bot", async () => {
    const userId = freshUserId("mcp-open");
    const botId = "mcp-bot";
    await provisionThroughGateway({ userId, botId });
    expect(
      await expectOkJson(await addServer(userId, "add-open", "/mcp")),
    ).toMatchObject({ status: "applied" });
    const [server] = await servers(userId);
    expect(server).toMatchObject({
      state: "ready",
      authorization: { kind: "none" },
      settings: { url: `${MCP_STUB_ORIGIN}/mcp` },
      safeMetadata: {
        namespace: "mcp-example",
        host: "mcp.example.test",
        serverName: "stub-mcp",
      },
    });

    const turn = await callEcho(userId, botId, "call-echo");
    const result = turn.events.find((event) => event.type === "tool/result");
    expect(result).toMatchObject({ isError: false, content: "echo: hello" });

    // The call is audited against the server's host, not its namespace.
    const audit = (await expectOkJson(
      await asUser(userId, "/api/audit?kind=mcp"),
    )) as { entries: Array<{ target: string; toolName: string }> };
    expect(audit.entries).toContainEqual(
      expect.objectContaining({
        target: "remote:mcp.example.test",
        toolName: "mcp-example/echo",
      }),
    );
  });

  it("holds a server's token and fails one added without it", async () => {
    const userId = freshUserId("mcp-token");
    await provisionThroughGateway({ userId, botId: "token" });
    expect(
      await expectOkJson(await addServer(userId, "add-bare", "/secure/mcp")),
    ).toMatchObject({ status: "failed" });
    const [failed] = await servers(userId);
    expect(failed?.state).toBe("failed");
    expect(failed?.failure).toContain("token");

    expect(
      await expectOkJson(
        await addServer(userId, "add-token", "/secure/mcp", MCP_TEST_TOKEN),
      ),
    ).toMatchObject({ status: "applied" });
    // The retry replaced the failed add rather than sitting beside it, and
    // nothing the settings read carries is the token.
    const rows = await servers(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      state: "ready",
      authorization: { kind: "api-key" },
    });
    expect(
      JSON.stringify(await (await asUser(userId, "/api/settings")).json()),
    ).not.toContain(MCP_TEST_TOKEN);
  });

  it("takes a removed server's tools away from every Bot", async () => {
    const userId = freshUserId("mcp-remove");
    const botId = "remove-bot";
    await provisionThroughGateway({ userId, botId });
    await expectOkJson(await addServer(userId, "add", "/mcp"));
    const [server] = await servers(userId);
    expect(
      await expectOkJson(
        await postAsUser(userId, "/api/connections", {
          schemaVersion: 1,
          type: "connection/disconnect",
          commandId: "remove",
          connectionId: server!.connectionId,
          revokeUpstream: false,
        }),
      ),
    ).toMatchObject({ status: "applied" });
    expect(await servers(userId)).toEqual([]);
    const turn = await callEcho(userId, botId, "call-after-remove");
    expect(
      turn.events.find((event) => event.type === "tool/result"),
    ).toMatchObject({ isError: true });
  });

  it("removes a server from an installed app's Disconnect", async () => {
    const userId = freshUserId("mcp-old-app");
    await provisionThroughGateway({ userId, botId: "old-app" });
    await expectOkJson(await addServer(userId, "add", "/mcp"));
    const [server] = await servers(userId);
    // An app that has not taken the patch sends a server with no token to
    // its Package's revoke door, as it does every account it does not key.
    expect(
      await expectOkJson(
        await postAsUser(
          userId,
          `/api/plugins/mcp/connections/${server!.connectionId}/revoke`,
          { schemaVersion: 1, type: "connection/revoke" },
        ),
      ),
    ).toEqual({ schemaVersion: 1, status: "revoked" });
    expect(await servers(userId)).toEqual([]);
  });

  it("signs in to a server behind OAuth, and a Bot calls it", async () => {
    const userId = freshUserId("mcp-oauth");
    const botId = "oauth-bot";
    await provisionThroughGateway({ userId, botId });
    const connectionId = await addSignInServer(userId, "add-oauth");
    const back = await signInReturn(userId, connectionId, "sign-in");
    expect(back.pathname).toBe("/api/mcp/oauth/callback");
    const callback = `${back.pathname}${back.search}`;

    // A state FrockBot did not sign is refused before anything is asked.
    const forged = new URL(back);
    forged.searchParams.set("state", "forged");
    expect(await (await SELF.fetch(forged)).text()).toContain("expired");

    // Whoever else the link reaches trades nothing: a browser signed in to
    // no account, or to another one — the victim of a link someone else
    // started, who has just signed in to the server as themselves.
    const victim = freshUserId("mcp-oauth-victim");
    await provisionThroughGateway({ userId: victim, botId: "victim-bot" });
    for (const elsewhere of [
      await SELF.fetch(back),
      await asUser(victim, callback),
    ]) {
      expect(elsewhere.status).toBe(200);
      expect(await elsewhere.text()).toContain(
        "Finish signing in from FrockBot",
      );
    }
    expect((await servers(userId))[0]?.state).toBe("failed");
    expect(await servers(victim)).toEqual([]);

    // The browser of the account that started it finishes it.
    expect(await (await asUser(userId, callback)).text()).toContain(
      "Signed in",
    );
    const [ready] = await servers(userId);
    expect(ready).toMatchObject({
      state: "ready",
      authorization: { kind: "grant" },
    });
    expect(
      JSON.stringify(await (await asUser(userId, "/api/settings")).json()),
    ).not.toMatch(/oauth-(access|refresh)-/);

    const turn = await callEcho(userId, botId, "call-oauth");
    expect(
      turn.events.find((event) => event.type === "tool/result"),
    ).toMatchObject({ isError: false, content: "echo: hello" });

    // Removing the server revokes the grant FrockBot was given.
    expect(
      await expectOkJson(
        await postAsUser(userId, "/api/connections", {
          schemaVersion: 1,
          type: "connection/disconnect",
          commandId: "remove-oauth",
          connectionId: ready!.connectionId,
          revokeUpstream: false,
        }),
      ),
    ).toMatchObject({ status: "applied" });
    const revoked = (await (
      await fetch(`${MCP_AUTH_STUB_ORIGIN}/__revoked`)
    ).json()) as string[];
    expect(revoked.some((token) => token.startsWith("oauth-refresh-"))).toBe(
      true,
    );
  });

  it("finishes an app's sign-in only under the session that started it", async () => {
    const userId = freshUserId("mcp-oauth-app");
    await provisionThroughGateway({ userId, botId: "app-bot" });
    const connectionId = await addSignInServer(userId, "add-app");
    const back = await signInReturn(userId, connectionId, "app-in", "android");
    expect(back.pathname).toBe("/api/mcp/oauth/callback/android");

    // The app's browser holds no session: its page trades nothing and hands
    // the answer to the app through the app's own return link.
    const page = await SELF.fetch(back, { redirect: "manual" });
    expect(page.status).toBe(303);
    const link = new URL(page.headers.get("location")!);
    expect(link.pathname).toBe("/api/connect/callback/android");
    expect((await servers(userId))[0]?.state).toBe("failed");

    // The app sends it back under its own session.
    const answer = {
      schemaVersion: 1,
      state: link.searchParams.get("mcp_state"),
      code: link.searchParams.get("mcp_code"),
      ...(link.searchParams.has("mcp_iss")
        ? { iss: link.searchParams.get("mcp_iss") }
        : {}),
    };
    const victim = freshUserId("mcp-oauth-app-victim");
    await provisionThroughGateway({ userId: victim, botId: "victim-bot" });
    const refused = await postAsUser(victim, "/api/mcp/oauth/complete", answer);
    expect(refused.status).toBe(403);
    expect((await servers(userId))[0]?.state).toBe("failed");
    expect(
      (
        await SELF.fetch(new URL("/api/mcp/oauth/complete", back), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(answer),
        })
      ).status,
    ).toBe(401);

    expect(
      await expectOkJson(
        await postAsUser(userId, "/api/mcp/oauth/complete", answer),
      ),
    ).toEqual({ schemaVersion: 1, status: "ready", connectionId });
    expect((await servers(userId))[0]).toMatchObject({
      state: "ready",
      authorization: { kind: "grant" },
    });
  });
});
