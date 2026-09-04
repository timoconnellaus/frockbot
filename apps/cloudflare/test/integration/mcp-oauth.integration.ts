// The whole `mcp-oauth` slice through the product's own HTTP surface.
//
// Seam S4 (gateway → the Package's own authorization routes → the User Durable
// Object), the public callback seam an authorization server redirects a browser
// into, seam S5 (a Turn in the Bot Durable Object), and seam S7 (the Durable
// Object's outbound OAuth and MCP requests). The authorization server and the
// protected MCP endpoint are impersonated at the outbound seam, so every
// request shape here is the production one.
import { describe, expect, it } from "vitest";
import {
  mcpOAuthEndpoint,
  mcpOAuthExpireEndpoint,
  mcpOAuthLedgerEndpoint,
} from "../harness/miniflare.ts";

/**
 * This file's own connector. The outbound stub is one shared module for the
 * whole parallel run, so its counters and switches are scoped to a tenant and
 * no test file can perturb another's.
 */
const TENANT = "integration-oauth";
const MCP_OAUTH_ENDPOINT = mcpOAuthEndpoint(TENANT);
import {
  asUser,
  expectOkJson,
  freshUserId,
  ORIGIN,
  postAsUser,
  provisionThroughGateway,
  toolCallTriggerPrompt,
  useApplicationArtifact,
} from "./fixtures.ts";
import { env, runInDurableObject, SELF } from "cloudflare:test";

useApplicationArtifact();

const MCP_PACKAGE = "mcp";
const OAUTH_CONNECTION_TYPE = "mcp-remote-oauth";
const ECHO_TOOL = "mcp__oauth_example__echo";

interface ConnectionView {
  connectionId: string;
  connectionTypeId: string;
  state: string;
  failure?: string;
  settings?: Record<string, unknown>;
  safeMetadata: Record<string, unknown>;
}

interface UserSettingsView {
  revision: number;
  connections: ConnectionView[];
}

interface StoredRun {
  runId: string;
  events: { type: string; [key: string]: unknown }[];
}

interface Ledger {
  registrations: number;
  codeExchanges: number;
  refreshes: number;
  revocations: number;
  authorizeResource: string;
  tokenResource: string;
  refreshResource: string;
  codeChallengeMethod: string;
  pkceRejections: number;
}

async function ledger(): Promise<Ledger> {
  return (await (await fetch(mcpOAuthLedgerEndpoint(TENANT))).json()) as Ledger;
}

async function readUserSettings(userId: string): Promise<UserSettingsView> {
  return (await expectOkJson(
    await asUser(userId, "/api/settings"),
  )) as UserSettingsView;
}

function botStub(userId: string, botId: string) {
  return env.BOT_STATES.get(env.BOT_STATES.idFromName(`${userId}:${botId}`));
}

async function offeredTools(
  userId: string,
  botId: string,
  runId: string,
): Promise<string[]> {
  const run = await runInDurableObject(
    botStub(userId, botId),
    async (_instance, state) => state.storage.get<StoredRun>(`run:${runId}`),
  );
  const request = run?.events.find((event) => event.type === "model/request");
  return (
    (request as { request?: { tools?: { name: string }[] } } | undefined)
      ?.request?.tools ?? []
  ).map((tool) => tool.name);
}

async function toolResult(
  userId: string,
  botId: string,
  runId: string,
): Promise<{ name: string; content: string; isError: boolean } | undefined> {
  const run = await runInDurableObject(
    botStub(userId, botId),
    async (_instance, state) => state.storage.get<StoredRun>(`run:${runId}`),
  );
  return run?.events.find((event) => event.type === "tool/result") as
    { name: string; content: string; isError: boolean } | undefined;
}

function runTurn(
  userId: string,
  botId: string,
  text: string,
  commandId: string,
): Promise<Response> {
  return postAsUser(userId, `/api/bots/${botId}/turns`, {
    schemaVersion: 1,
    commandId,
    text,
  });
}

describe("connecting an OAuth-protected MCP server", () => {
  it("authorizes in the browser, then serves a Bot's tools and refreshes them silently", async () => {
    const userId = freshUserId("mcp-oauth");
    const botId = "mcp-oauth-bot";
    await provisionThroughGateway({ userId, botId });
    const before = await ledger();

    const settings = await readUserSettings(userId);
    await expectOkJson(
      await postAsUser(userId, "/api/settings", {
        schemaVersion: 1,
        type: "user/install-package",
        commandId: "install-mcp-oauth",
        expectedRevision: settings.revision,
        packageId: MCP_PACKAGE,
        version: "0.0.1",
      }),
    );

    // 1. The User presses connect. The redirect is minted by the host, from an
    //    authenticated request, and nothing else in the answer is usable.
    const started = (await expectJsonWithStatus(
      await postAsUser(userId, "/api/plugins/mcp/connections", {
        schemaVersion: 1,
        type: "connection/start",
        commandId: "mcp-oauth-connect-1",
        connectionTypeId: OAUTH_CONNECTION_TYPE,
        label: "OAuth Example",
        settings: {
          url: MCP_OAUTH_ENDPOINT,
          transport: "streamable-http",
        },
      }),
      201,
    )) as { status: string; connectionId: string; redirectUrl: string };
    expect(started.status).toBe("authorization-required");
    expect(started).not.toHaveProperty("codeVerifier");

    const authorizeUrl = new URL(started.redirectUrl);
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizeUrl.searchParams.get("resource")).toBe(MCP_OAUTH_ENDPOINT);

    // The Connection exists and is not ready: a URL has been minted, and
    // nothing has been proved.
    expect(
      (await readUserSettings(userId)).connections.find(
        (connection) => connection.connectionId === started.connectionId,
      )!.state,
    ).toBe("authorizing");

    // 2. The browser follows it, and the authorization server redirects back
    //    to the public callback with a code and the signed state.
    const authorized = await fetch(started.redirectUrl, { redirect: "manual" });
    expect(authorized.status).toBe(303);
    const callback = new URL(authorized.headers.get("location")!);
    expect(callback.origin).toBe(ORIGIN);
    expect(callback.pathname).toBe("/api/plugins/mcp/callback");

    // 3. The callback is public: `SELF.fetch` with no session header at all,
    //    which is exactly how a browser arrives back from the authorization
    //    server. The User it acts as comes only from the signed state.
    const completed = await SELF.fetch(callback.toString(), {
      redirect: "manual",
    });
    expect(completed.status).toBe(303);
    expect(completed.headers.get("location")).toBe(
      `${ORIGIN}/?connection=mcp-ready`,
    );

    const connection = (await readUserSettings(userId)).connections.find(
      (candidate) => candidate.connectionId === started.connectionId,
    )!;
    expect(connection.state).toBe("ready");
    expect(connection.connectionTypeId).toBe(OAUTH_CONNECTION_TYPE);
    expect(connection.safeMetadata).toMatchObject({
      protocolVersion: "2025-06-18",
      toolCount: 1,
    });
    // Not a token in sight on the projection the client reads.
    expect(JSON.stringify(connection)).not.toContain("mcp-access");
    expect(JSON.stringify(connection)).not.toContain("mcp-refresh");

    const afterConnect = await ledger();
    expect(afterConnect.registrations).toBeGreaterThan(0);
    expect(afterConnect.codeExchanges).toBe(1);
    expect(afterConnect.pkceRejections).toBe(0);
    expect(afterConnect.tokenResource).toBe(MCP_OAUTH_ENDPOINT);

    // 4. The enabled Connection's tools reach every Bot on its next Turn.
    expect(
      (await runTurn(userId, botId, "hello", "mcp-oauth-turn-1")).status,
    ).toBe(200);
    expect(await offeredTools(userId, botId, "mcp-oauth-turn-1")).toContain(
      ECHO_TOOL,
    );

    // 5. And the model can call one: the bearer the token endpoint issued is
    //    what opened the MCP server.
    expect(
      (
        await runTurn(
          userId,
          botId,
          toolCallTriggerPrompt([ECHO_TOOL, { message: "ping" }]),
          "mcp-oauth-turn-call",
        )
      ).status,
    ).toBe(200);
    const called = await toolResult(userId, botId, "mcp-oauth-turn-call");
    expect(called).toBeDefined();
    expect(called!.isError).toBe(false);
    expect(JSON.parse(called!.content)).toEqual({
      echoed: { message: "ping" },
    });

    const afterUse = await ledger();
    // The mount refreshed on the way out of the lease, because the server's
    // token was inside the refresh skew.
    expect(afterUse.refreshes).toBeGreaterThan(0);
    expect(afterUse.refreshResource).toBe(MCP_OAUTH_ENDPOINT);

    // 6. The server expires every token it has issued. The next Turn refreshes
    //    silently and the Bot never notices.
    await fetch(mcpOAuthExpireEndpoint(TENANT), { method: "POST" });
    const beforeRecovery = await ledger();
    expect(
      (
        await runTurn(
          userId,
          botId,
          toolCallTriggerPrompt([ECHO_TOOL, { message: "again" }]),
          "mcp-oauth-turn-refreshed",
        )
      ).status,
    ).toBe(200);
    const recovered = await toolResult(
      userId,
      botId,
      "mcp-oauth-turn-refreshed",
    );
    expect(recovered).toBeDefined();
    expect(recovered!.isError).toBe(false);
    expect(JSON.parse(recovered!.content)).toEqual({
      echoed: { message: "again" },
    });
    expect((await ledger()).refreshes).toBeGreaterThan(
      beforeRecovery.refreshes,
    );
    // And no second authorization: the User was not asked to press anything.
    expect((await ledger()).codeExchanges).toBe(1);
  });

  it("refuses a callback that carries no valid signed state", async () => {
    const userId = freshUserId("mcp-oauth-forged");
    const before = await ledger();
    const response = await SELF.fetch(
      `${ORIGIN}/api/plugins/mcp/callback?code=made-up&state=not-a-state`,
      { redirect: "manual" },
    );
    expect(response.status).toBe(400);
    expect((await ledger()).codeExchanges).toBe(before.codeExchanges);
    // And nothing was created for anyone: this User holds only the ambient
    // Frock AI Connection its first configuration read bootstraps, and no
    // MCP Connection at all.
    expect(
      (await readUserSettings(userId)).connections.filter(
        (connection) => connection.connectionTypeId === OAUTH_CONNECTION_TYPE,
      ),
    ).toHaveLength(0);
  });
});

async function expectJsonWithStatus(
  response: Response,
  status: number,
): Promise<unknown> {
  const text = await response.text();
  expect({ status: response.status, body: text.slice(0, 300) }).toMatchObject({
    status,
  });
  return JSON.parse(text) as unknown;
}
