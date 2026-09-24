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
    expect(
      await expectOkJson(await addServer(userId, "add-oauth", "/oauth/mcp")),
    ).toMatchObject({ status: "failed" });
    const [pending] = await servers(userId);
    expect(pending).toMatchObject({
      state: "failed",
      authorization: { kind: "grant" },
    });

    const start = (await expectOkJson(
      await postAsUser(
        userId,
        `/api/plugins/mcp/connections/${pending!.connectionId}/authorize`,
        {
          schemaVersion: 1,
          type: "connection/start",
          commandId: "sign-in",
          connectionTypeId: "mcp-server",
        },
      ),
    )) as { status: string; redirectUrl: string };
    expect(start.status).toBe("authorization-required");
    expect(new URL(start.redirectUrl).origin).toBe(MCP_AUTH_STUB_ORIGIN);

    // The authorization server approves at once and sends the browser back.
    const approved = await fetch(start.redirectUrl, { redirect: "manual" });
    const back = new URL(approved.headers.get("location")!);
    expect(back.pathname).toBe("/api/mcp/oauth/callback");

    // A state FrockBot did not sign is refused before anything is asked.
    const forged = new URL(back);
    forged.searchParams.set("state", "forged");
    expect(await (await SELF.fetch(forged)).text()).toContain("expired");
    expect((await servers(userId))[0]?.state).toBe("failed");

    // The browser that comes back carries no session; the state is enough.
    expect(await (await SELF.fetch(back)).text()).toContain("Signed in");
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
});
