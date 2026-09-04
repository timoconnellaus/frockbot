// Seam S4 (gateway → the MCP Package's own route → User Durable Object),
// seam S5 (gateway → Bot Durable Object turn) and seam S7 (Durable Object →
// outbound MCP server), for the lifecycle a remote MCP server has after it is
// added: its durable record, its instructions, its restart, and the two
// refusals this build records rather than performs.
//
// The server is impersonated at the outbound seam, exactly as in
// `mcp-tools.integration.ts`: nothing crosses a Package boundary to make it
// work, so the request shapes are the production ones.
import { describe, expect, it } from "vitest";
import {
  MCP_ENDPOINT,
  MCP_GOOD_API_KEY,
  MCP_UNREACHABLE_ENDPOINT,
} from "../harness/miniflare.ts";
import {
  asUser,
  expectOkJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  readStoredRunWithEventsV1,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

const MCP_PACKAGE = "mcp";
const ECHO_TOOL = "mcp__example__echo";

interface McpServerRecord {
  serverId: string;
  label: string;
  url: string;
  state: string;
  serverEpoch: number;
  toolCount: number;
  instructions?: string;
  lastHandshakeAt: string;
  failure?: { code: string; message: string };
}

interface McpStatusView {
  servers: McpServerRecord[];
  refusals: { code: string; message: string; transport?: string }[];
  quotas: { maxServers: number };
}

interface McpReceipt {
  commandId: string;
  status: string;
  serverId?: string;
  code?: string;
  failure?: string;
}

interface StoredRun {
  runId: string;
  events: { type: string; [key: string]: unknown }[];
}

async function installMcp(userId: string): Promise<void> {
  const settings = (await expectOkJson(
    await asUser(userId, "/api/settings"),
  )) as { revision: number };
  await expectOkJson(
    await postAsUser(userId, "/api/settings", {
      schemaVersion: 1,
      type: "user/install-package",
      commandId: "install-mcp",
      expectedRevision: settings.revision,
      packageId: MCP_PACKAGE,
      version: "0.0.1",
    }),
  );
}

async function readStatus(userId: string): Promise<McpStatusView> {
  return (await expectOkJson(
    await asUser(userId, "/api/mcp/servers"),
  )) as McpStatusView;
}

async function lifecycle(
  userId: string,
  command: Record<string, unknown>,
): Promise<McpReceipt> {
  return (await expectOkJson(
    await postAsUser(userId, "/api/mcp/servers", {
      schemaVersion: 1,
      ...command,
    }),
  )) as McpReceipt;
}

async function runTurn(
  userId: string,
  botId: string,
  commandId: string,
): Promise<void> {
  const response = await postAsUser(userId, `/api/bots/${botId}/turns`, {
    schemaVersion: 1,
    commandId,
    text: "hello",
  });
  expect(response.status).toBe(200);
}

/** The exact normalized tool list the session log recorded for one run. */
async function offeredTools(
  userId: string,
  botId: string,
  runId: string,
): Promise<{ name: string; description?: string }[]> {
  const run = await readStoredRunWithEventsV1<StoredRun>(userId, botId, runId);
  expect(run).toBeDefined();
  const request = run!.events.find((event) => event.type === "model/request");
  expect(request).toBeDefined();
  return (
    (
      request as {
        request?: { tools?: { name: string; description?: string }[] };
      }
    ).request?.tools ?? []
  );
}

describe("the MCP server lifecycle", () => {
  it("adds, renames, instructs and restarts a server through its own routes", async () => {
    const userId = freshUserId("mcp-lifecycle");
    const botId = "mcp-lifecycle-bot";
    await provisionThroughGateway({ userId, botId });
    await installMcp(userId);

    // An empty projection is a real answer, not a 404.
    expect(await readStatus(userId)).toMatchObject({
      servers: [],
      refusals: [],
    });

    const added = await lifecycle(userId, {
      type: "mcp/add-server",
      commandId: "add-1",
      label: "Example",
      url: MCP_ENDPOINT,
      transport: "streamable-http",
      apiKey: MCP_GOOD_API_KEY,
    });
    expect(added.status).toBe("applied");
    const serverId = added.serverId!;

    const afterAdd = await readStatus(userId);
    expect(afterAdd.servers).toHaveLength(1);
    expect(afterAdd.servers[0]).toMatchObject({
      serverId,
      label: "Example",
      url: MCP_ENDPOINT,
      state: "ready",
      serverEpoch: 1,
      toolCount: 1,
    });
    expect(afterAdd.quotas.maxServers).toBe(16);

    // Renaming is the ordinary Connection command; the record follows it, and
    // so do the tool names, because the slug comes from the label.
    await expectOkJson(
      await postAsUser(userId, "/api/connections", {
        schemaVersion: 1,
        type: "connection/update-label",
        commandId: "rename-1",
        connectionId: serverId,
        label: "Renamed",
      }),
    );
    expect((await readStatus(userId)).servers[0]?.label).toBe("Renamed");

    await expectOkJson(
      await postAsUser(userId, "/api/connections", {
        schemaVersion: 1,
        type: "connection/update-label",
        commandId: "rename-2",
        connectionId: serverId,
        label: "Example",
      }),
    );

    // A restart bumps the epoch and re-handshakes; the record says so.
    const restarted = await lifecycle(userId, {
      type: "mcp/restart",
      commandId: "restart-1",
      serverId,
    });
    expect(restarted.status).toBe("applied");
    const afterRestart = await readStatus(userId);
    expect(afterRestart.servers[0]).toMatchObject({
      serverEpoch: 2,
      state: "ready",
    });
    expect(
      Date.parse(afterRestart.servers[0]!.lastHandshakeAt),
    ).toBeGreaterThanOrEqual(Date.parse(afterAdd.servers[0]!.lastHandshakeAt));

    // Instructions become the description the server's tools carry in the
    // next admitted Turn's model request — the only durable place a User can
    // prove the model was told.
    await lifecycle(userId, {
      type: "mcp/set-instructions",
      commandId: "instruct-1",
      serverId,
      instructions: "Always echo before answering.",
    });
    expect((await readStatus(userId)).servers[0]?.instructions).toBe(
      "Always echo before answering.",
    );

    await runTurn(userId, botId, "mcp-lifecycle-turn");
    const tools = await offeredTools(userId, botId, "mcp-lifecycle-turn");
    const echo = tools.find((tool) => tool.name === ECHO_TOOL);
    expect(echo).toBeDefined();
    expect(echo!.description).toContain("Always echo before answering.");

    // Clearing them takes it back out of the next request.
    await lifecycle(userId, {
      type: "mcp/set-instructions",
      commandId: "instruct-clear",
      serverId,
      instructions: "",
    });
    await runTurn(userId, botId, "mcp-lifecycle-turn-2");
    const cleared = await offeredTools(userId, botId, "mcp-lifecycle-turn-2");
    expect(
      cleared.find((tool) => tool.name === ECHO_TOOL)?.description ?? "",
    ).not.toContain("Always echo before answering.");
  });

  it("records an unreachable server as a durable, visible error", async () => {
    const userId = freshUserId("mcp-error");
    await provisionThroughGateway({ userId, botId: "mcp-error-bot" });
    await installMcp(userId);

    const receipt = await lifecycle(userId, {
      type: "mcp/add-server",
      commandId: "add-down",
      label: "Down",
      url: MCP_UNREACHABLE_ENDPOINT,
      transport: "streamable-http",
    });
    expect(receipt.status).toBe("failed");
    expect(receipt.code).toBe("unreachable");

    const status = await readStatus(userId);
    expect(status.servers[0]).toMatchObject({
      label: "Down",
      state: "error",
      toolCount: 0,
    });
    expect(status.servers[0]?.failure?.code).toBe("unreachable");
    expect(status.servers[0]?.failure?.message).toContain("503");
  });

  it("refuses a stdio server durably instead of pretending to add it", async () => {
    const userId = freshUserId("mcp-stdio");
    await provisionThroughGateway({ userId, botId: "mcp-stdio-bot" });
    await installMcp(userId);

    const receipt = await lifecycle(userId, {
      type: "mcp/add-server",
      commandId: "add-stdio",
      label: "Beeper",
      url: "stdio://beeper",
      transport: "stdio",
    });

    expect(receipt).toMatchObject({
      status: "refused",
      code: "unsupported-transport",
    });
    const status = await readStatus(userId);
    // No Connection, and no server: a refusal, not a broken row.
    expect(status.servers).toHaveLength(0);
    expect(status.refusals[0]).toMatchObject({
      code: "unsupported-transport",
      transport: "stdio",
    });
    const settings = (await expectOkJson(
      await asUser(userId, "/api/settings"),
    )) as { connections: { packageId: string }[] };
    expect(
      settings.connections.filter(
        (connection) => connection.packageId === MCP_PACKAGE,
      ),
    ).toHaveLength(0);
  });
});
