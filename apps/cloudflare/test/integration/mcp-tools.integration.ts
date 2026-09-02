// Seam S4 (gateway → connections route → User Durable Object), seam S5
// (gateway → Bot Durable Object turn) and seam S7 (Durable Object → outbound
// MCP server), for the whole path a remote MCP server takes to a Bot's tools.
//
// The server is impersonated at the outbound seam, not injected: `plugin-mcp`
// reaches it with the Package's own `fetch`, so a test that stubs
// `https://mcp.example.test` proves the production request shapes and nothing
// crosses a Package boundary to make it work.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MCP_ENDPOINT, MCP_GOOD_API_KEY } from "../harness/miniflare.ts";
import {
  asUser,
  expectOkJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

const MCP_PACKAGE = "mcp";
const MCP_CONNECTION_TYPE = "mcp-remote-key";
const ECHO_TOOL = "mcp__example__echo";

/** The marker the stubbed model reads to answer with a tool call. */
const TOOL_CALL_TRIGGER = "frockbot-test-tool-call:";

interface ConnectionView {
  connectionId: string;
  state: string;
  failure?: string;
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

function botStub(userId: string, botId: string) {
  return env.BOT_STATES.get(env.BOT_STATES.idFromName(`${userId}:${botId}`));
}

async function readUserSettings(userId: string): Promise<UserSettingsView> {
  return (await expectOkJson(
    await asUser(userId, "/api/settings"),
  )) as UserSettingsView;
}

/** Install `mcp` and add one server Connection labelled `Example`. */
async function addMcpServer(
  userId: string,
  options: { commandId: string; apiKey: string },
): Promise<ConnectionView> {
  const settings = await readUserSettings(userId);
  await expectOkJson(
    await postAsUser(userId, "/api/settings", {
      schemaVersion: 1,
      type: "user/install-package",
      commandId: `install-mcp-${options.commandId}`,
      expectedRevision: settings.revision,
      packageId: MCP_PACKAGE,
      version: "0.0.1",
    }),
  );
  const receipt = (await expectOkJson(
    await postAsUser(userId, "/api/connections", {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: options.commandId,
      packageId: MCP_PACKAGE,
      connectionTypeId: MCP_CONNECTION_TYPE,
      label: "Example",
      apiKey: options.apiKey,
      settings: { url: MCP_ENDPOINT, transport: "streamable-http" },
    }),
  )) as { connectionId: string };
  const view = (await readUserSettings(userId)).connections.find(
    (connection) => connection.connectionId === receipt.connectionId,
  );
  expect(view).toBeDefined();
  return view!;
}

async function runTurn(
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

/** Every tool name the Bot durably recorded offering the model on one run. */
async function offeredTools(
  userId: string,
  botId: string,
  runId: string,
): Promise<string[]> {
  const run = await runInDurableObject(
    botStub(userId, botId),
    async (_instance, state) => state.storage.get<StoredRun>(`run:${runId}`),
  );
  expect(run).toBeDefined();
  const request = run!.events.find((event) => event.type === "model/request");
  expect(request).toBeDefined();
  const tools = (
    (request as { request?: { tools?: { name: string }[] } }).request?.tools ??
    []
  ).map((tool) => tool.name);
  return tools;
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

describe("a remote MCP server reaching every Bot through account enablement", () => {
  it("validates the server, offers its tools, and calls one", async () => {
    const userId = freshUserId("mcp");
    const botId = "mcp-bot";
    await provisionThroughGateway({ userId, botId });

    const connection = await addMcpServer(userId, {
      commandId: "add-mcp-1",
      apiKey: MCP_GOOD_API_KEY,
    });

    // The handshake is the validation: what the server said about itself is on
    // the Connection.
    expect(connection).toMatchObject({ state: "ready" });
    expect(connection.safeMetadata).toMatchObject({
      protocolVersion: "2025-06-18",
      toolCount: 1,
      serverName: "Example MCP",
    });

    // The next admitted Turn carries the enabled server's tools in the exact
    // normalized model request the session log records.
    const after = await runTurn(userId, botId, "hello", "mcp-turn-after");
    expect(after.status).toBe(200);
    expect(await offeredTools(userId, botId, "mcp-turn-after")).toContain(
      ECHO_TOOL,
    );

    // And the model can call one: the result the Bot records is the payload
    // the MCP server returned.
    const called = await runTurn(
      userId,
      botId,
      `${TOOL_CALL_TRIGGER}${ECHO_TOOL}:{"message":"ping"}`,
      "mcp-turn-call",
    );
    expect(called.status).toBe(200);
    const result = await toolResult(userId, botId, "mcp-turn-call");
    expect(result).toBeDefined();
    expect(result!.name).toBe(ECHO_TOOL);
    expect(result!.isError).toBe(false);
    expect(JSON.parse(result!.content)).toEqual({
      echoed: { message: "ping" },
    });

    // Disabling the Package takes its tools away from every Bot at the next
    // admitted Turn without changing the Connection.
    const enabled = await readUserSettings(userId);
    await expectOkJson(
      await postAsUser(userId, "/api/settings", {
        schemaVersion: 1,
        type: "user/set-package-enabled",
        commandId: "disable-mcp",
        expectedRevision: enabled.revision,
        packageId: MCP_PACKAGE,
        enabled: false,
      }),
    );
    const disabled = await runTurn(userId, botId, "hello", "mcp-turn-disabled");
    expect(disabled.status).toBe(200);
    expect(
      await offeredTools(userId, botId, "mcp-turn-disabled"),
    ).not.toContain(ECHO_TOOL);
  });

  it("leaves a server that rejects the key failed, with its reason", async () => {
    const userId = freshUserId("mcp-bad-key");
    const botId = "mcp-bad-key-bot";
    await provisionThroughGateway({ userId, botId });

    const connection = await addMcpServer(userId, {
      commandId: "add-mcp-bad",
      apiKey: "not-the-key",
    });

    expect(connection.state).toBe("failed");
    expect(connection.failure ?? "").toContain("401");
  });
});
