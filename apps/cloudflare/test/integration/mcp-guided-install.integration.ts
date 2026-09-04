// GrokBot's `add-connector`, end to end: a Catalog entry with setup fields and
// an OAuth server, installed with the values a User typed, connected, enabled,
// used — and then broken by the server and repaired by the User.
//
// The seam this exercises that no other test does is the *sequence*: catalog
// entry detail → `setupFields` → `user/install-package{values}` → the Package's
// own authorization route → the public callback → account enablement →
// a Turn. Everything crosses the gateway, and the connector is impersonated at
// the outbound seam, so nothing is injected past a Package boundary.
import {
  catalogContentHashV1,
  catalogEntryKeyV1,
  catalogIndexKeyV1,
  catalogSetupFieldKeyV1,
  CATALOG_POINTER_KEY_V1,
  decodeCatalogEntryV1,
  decodeCatalogIndexV1,
  type CatalogEntryV1,
  type CatalogIndexV1,
} from "@frockbot/catalog-core";
import type { UserSettingsViewV1 } from "@frockbot/configuration-core";
import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import {
  mcpOAuthAcceptEndpoint,
  mcpOAuthEndpoint,
  mcpOAuthRejectEndpoint,
} from "../harness/miniflare.ts";

/** This file's own connector; the stub is shared by the whole parallel run. */
const TENANT = "integration-guided";
const MCP_OAUTH_ENDPOINT = mcpOAuthEndpoint(TENANT);
import {
  asUser,
  expectOkJson,
  freshUserId,
  ORIGIN,
  postAsUser,
  provisionThroughGateway,
  readStoredRunWithEventsV1,
  toolCallTriggerPrompt,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

const GENERATION = "gen-guided-install-1";
const CATALOG_ID = "mcp-oauth-connector";
const ECHO_TOOL = "mcp__oauth_connector__echo";

/**
 * One connector entry, shaped like the marketplace bundles GrokBot installs:
 * a Package, a remote MCP server behind OAuth, and the setup fields the User
 * fills in before any of it happens.
 */
const ENTRY: CatalogEntryV1 = decodeCatalogEntryV1({
  schemaVersion: 1,
  catalogId: CATALOG_ID,
  packageId: "mcp",
  displayName: "OAuth Connector",
  description: "A remote MCP connector behind OAuth.",
  version: "0.0.1",
  kind: "package",
  manifestHash: "f".repeat(64),
  servers: [
    {
      name: "OAuth Connector",
      transport: "streamable-http",
      url: MCP_OAUTH_ENDPOINT,
      auth: "oauth",
    },
  ],
  setupFields: [
    {
      type: "string",
      title: "Region",
      description: "Which region your connector account lives in.",
      maxLength: 64,
    },
  ],
  skills: [],
});

const INDEX: CatalogIndexV1 = decodeCatalogIndexV1({
  schemaVersion: 1,
  generation: GENERATION,
  entries: [
    {
      catalogId: ENTRY.catalogId,
      packageId: ENTRY.packageId,
      displayName: ENTRY.displayName,
      description: ENTRY.description,
      version: ENTRY.version,
      manifestHash: ENTRY.manifestHash,
      kind: ENTRY.kind,
    },
  ],
});

beforeAll(async () => {
  const indexDocument = JSON.stringify(INDEX);
  await env.PACKAGE_CATALOG.put(
    catalogEntryKeyV1(GENERATION, ENTRY.catalogId),
    JSON.stringify(ENTRY),
  );
  await env.PACKAGE_CATALOG.put(catalogIndexKeyV1(GENERATION), indexDocument);
  await env.PACKAGE_CATALOG.put(
    CATALOG_POINTER_KEY_V1,
    JSON.stringify({
      schemaVersion: 1,
      generation: GENERATION,
      indexHash: await catalogContentHashV1(indexDocument),
    }),
  );
  await fetch(mcpOAuthAcceptEndpoint(TENANT), { method: "POST" });
});

interface StoredRun {
  runId: string;
  events: { type: string; [key: string]: unknown }[];
}

async function readUserSettings(userId: string): Promise<UserSettingsViewV1> {
  return (await expectOkJson(
    await asUser(userId, "/api/settings"),
  )) as UserSettingsViewV1;
}

async function offeredTools(
  userId: string,
  botId: string,
  runId: string,
): Promise<string[]> {
  const run = await readStoredRunWithEventsV1<StoredRun>(userId, botId, runId);
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
): Promise<{ content: string; isError: boolean } | undefined> {
  const run = await readStoredRunWithEventsV1<StoredRun>(userId, botId, runId);
  return run?.events.find((event) => event.type === "tool/result") as
    { content: string; isError: boolean } | undefined;
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

/** Start, follow the server's 303, and land on the public callback. */
async function authorize(
  userId: string,
  body: Record<string, unknown>,
): Promise<string> {
  const response = await postAsUser(userId, "/api/plugins/mcp/connections", {
    schemaVersion: 1,
    type: "connection/start",
    connectionTypeId: "mcp-remote-oauth",
    ...body,
  });
  expect(response.status).toBe(201);
  const started = (await response.json()) as {
    connectionId: string;
    redirectUrl: string;
  };
  const redirected = await fetch(started.redirectUrl, { redirect: "manual" });
  expect(redirected.status).toBe(303);
  const completed = await SELF.fetch(redirected.headers.get("location")!, {
    redirect: "manual",
  });
  expect(completed.headers.get("location")).toBe(
    `${ORIGIN}/?connection=mcp-ready`,
  );
  return started.connectionId;
}

describe("installing a connector from the Catalog and connecting it", () => {
  it("carries the setup values into the install, then connects, runs, breaks and repairs", async () => {
    const userId = freshUserId("guided-install");
    const botId = "guided-install-bot";
    await provisionThroughGateway({ userId, botId });

    // 1. The entry detail is what the setup form is built from.
    const detail = decodeCatalogEntryV1(
      await expectOkJson(
        await asUser(
          userId,
          `/catalog/v1/entry/${CATALOG_ID}?generation=${GENERATION}`,
        ),
      ),
    );
    expect(detail.setupFields).toHaveLength(1);
    expect(detail.servers[0]).toMatchObject({ auth: "oauth" });
    const fieldKey = catalogSetupFieldKeyV1(detail.setupFields[0]!, 0);
    expect(fieldKey).toBe("region");

    // 2. Install with the values the User typed. They are recorded on the
    //    installation, so the install is reproducible from durable state
    //    rather than from a form that is gone.
    const settings = await readUserSettings(userId);
    await expectOkJson(
      await postAsUser(userId, "/api/settings", {
        schemaVersion: 1,
        type: "user/install-package",
        commandId: "guided-install-1",
        expectedRevision: settings.revision,
        packageId: detail.packageId,
        version: detail.version,
        catalogId: detail.catalogId,
        catalogGeneration: GENERATION,
        values: { [fieldKey]: "ap-southeast-2" },
      }),
    );
    const installed = (await readUserSettings(userId)).packages.find(
      (item) => item.packageId === "mcp",
    );
    expect(installed).toMatchObject({
      state: "installed",
      catalogId: CATALOG_ID,
      catalogGeneration: GENERATION,
      values: { region: "ap-southeast-2" },
    });

    // 3. Connect the entry's OAuth server, through the host-authored path.
    const connectionId = await authorize(userId, {
      commandId: "guided-connect-1",
      label: "OAuth Connector",
      settings: {
        url: detail.servers[0]!.url,
        transport: detail.servers[0]!.transport,
      },
    });
    let connection = (await readUserSettings(userId)).connections.find(
      (candidate) => candidate.connectionId === connectionId,
    )!;
    expect(connection.state).toBe("ready");
    expect(connection.pendingAuthorization).toBeUndefined();

    // 4. The enabled Connection's tools reach every Bot.
    expect(
      (await runTurn(userId, botId, "hello", "guided-turn-1")).status,
    ).toBe(200);
    expect(await offeredTools(userId, botId, "guided-turn-1")).toContain(
      ECHO_TOOL,
    );
    expect(
      (
        await runTurn(
          userId,
          botId,
          toolCallTriggerPrompt([ECHO_TOOL, { message: "ping" }]),
          "guided-turn-call",
        )
      ).status,
    ).toBe(200);
    expect(
      JSON.parse(
        (await toolResult(userId, botId, "guided-turn-call"))!.content,
      ),
    ).toEqual({ echoed: { message: "ping" } });

    // 5. The connector stops honouring the grant. The next Turn loses the
    //    tools, and the User gets a card rather than silence.
    await fetch(mcpOAuthRejectEndpoint(TENANT), { method: "POST" });
    expect(
      (await runTurn(userId, botId, "hello", "guided-turn-broken")).status,
    ).toBe(200);
    expect(
      await offeredTools(userId, botId, "guided-turn-broken"),
    ).not.toContain(ECHO_TOOL);
    connection = (await readUserSettings(userId)).connections.find(
      (candidate) => candidate.connectionId === connectionId,
    )!;
    expect(connection.pendingAuthorization).toMatchObject({
      reason: "needs-auth",
      connectionId,
      label: "OAuth Connector",
    });
    // The card the client draws carries nothing that could be followed.
    expect(JSON.stringify(connection.pendingAuthorization)).not.toContain(
      "http",
    );
    const status = (await expectOkJson(
      await asUser(userId, "/api/mcp/servers"),
    )) as { servers: { state: string }[] };
    expect(status.servers[0]).toMatchObject({ state: "needs-auth" });

    // 6. The User presses Reconnect. Same Connection, fresh PKCE and state.
    await fetch(mcpOAuthAcceptEndpoint(TENANT), { method: "POST" });
    expect(
      await authorize(userId, {
        commandId: "guided-connect-2",
        connectionId,
      }),
    ).toBe(connectionId);

    connection = (await readUserSettings(userId)).connections.find(
      (candidate) => candidate.connectionId === connectionId,
    )!;
    expect(connection.state).toBe("ready");
    expect(connection.pendingAuthorization).toBeUndefined();

    expect(
      (await runTurn(userId, botId, "hello", "guided-turn-repaired")).status,
    ).toBe(200);
    expect(await offeredTools(userId, botId, "guided-turn-repaired")).toContain(
      ECHO_TOOL,
    );
  });
});
