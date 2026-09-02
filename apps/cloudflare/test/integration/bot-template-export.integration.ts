// Slice M, export half, end to end through `SELF.fetch`.
//
// One Bot is built the way a User builds one: a Skill authored by the Agent
// loop inside the Bot Durable Object, a webhook Routine created over the
// Routines route, and a keyed MCP Connection created over the Connections
// route with a real API key. The Bot then packs itself with its own
// `bot_export_template` tool, its User publishes the share, and the published
// blob is fetched from the *unauthenticated* `/templates/v1/:shareId`.
//
// What the blob must contain: the Skill's body and the Routine's prompt.
// What it must not: the API key, any `connectionId`, the server's URL, or a
// webhook key — and the keyed server must be a `needs-connection` placeholder
// instead. What another User must see while the share is private: 404.
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  MCP_ENDPOINT,
  MCP_GOOD_API_KEY,
  TOOL_CALL_TRIGGER,
} from "../harness/miniflare.ts";
import {
  asUser,
  expectOkJson,
  freshUserId,
  ORIGIN,
  postAsUser,
  provisionThroughGateway,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

const SKILL_SLUG = "reconcile-ledger";
const SKILL_BODY = "TEMPLATE-SKILL-BODY: open the ledger, then reconcile it.";
const ROUTINE_PROMPT = "TEMPLATE-ROUTINE-PROMPT: handle the delivered payload.";

interface ShareRecord {
  shareId: string;
  hash: string;
  botId: string;
  visibility: string;
  revokedAt?: string;
}

async function writeSkill(userId: string, botId: string): Promise<void> {
  const turn = (await expectOkJson(
    await postAsUser(userId, `/api/bots/${botId}/turns`, {
      schemaVersion: 1,
      commandId: "template-skill-write",
      text: `${TOOL_CALL_TRIGGER}skill_write:${JSON.stringify({
        name: "Reconcile ledger",
        description: "Use this when reconciling the ledger.",
        body: SKILL_BODY,
        slug: SKILL_SLUG,
      })}`,
    }),
  )) as {
    events: Array<{ type: string; content?: string; isError?: boolean }>;
  };
  const result = turn.events.find((event) => event.type === "tool/result");
  expect(result?.isError, result?.content).toBe(false);
}

async function createWebhookRoutine(
  userId: string,
  botId: string,
): Promise<void> {
  await expectOkJson(
    await postAsUser(userId, `/api/bots/${botId}/routines`, {
      schemaVersion: 1,
      type: "routine/create",
      commandId: "template-routine-1",
      botId,
      name: "On delivery",
      prompt: ROUTINE_PROMPT,
      trigger: { kind: "webhook" },
      timezone: "Australia/Sydney",
    }),
  );
}

async function addKeyedMcpConnection(userId: string): Promise<string> {
  const settings = (await expectOkJson(
    await asUser(userId, "/api/settings"),
  )) as { revision: number };
  await expectOkJson(
    await postAsUser(userId, "/api/settings", {
      schemaVersion: 1,
      type: "user/install-package",
      commandId: "template-install-mcp",
      expectedRevision: settings.revision,
      packageId: "mcp",
      version: "0.0.1",
    }),
  );
  const receipt = (await expectOkJson(
    await postAsUser(userId, "/api/connections", {
      schemaVersion: 1,
      type: "connection/create-api-key",
      commandId: "template-connect-mcp",
      packageId: "mcp",
      connectionTypeId: "mcp-remote-key",
      label: "Example connector",
      apiKey: MCP_GOOD_API_KEY,
      settings: { url: MCP_ENDPOINT, transport: "streamable-http" },
    }),
  )) as { connectionId: string };
  return receipt.connectionId;
}

describe("exporting a Bot as a shareable template", () => {
  it("packs the recipe, publishes it, and leaks nothing", async () => {
    const userId = freshUserId("template-export");
    const botId = "template-export-bot";
    await provisionThroughGateway({ userId, botId });
    await writeSkill(userId, botId);
    await createWebhookRoutine(userId, botId);
    const connectionId = await addKeyedMcpConnection(userId);

    // THE BOT PACKS ITSELF. `bot_export_template` is a chat-turn tool that
    // reaches the User's own staging command and nothing wider.
    const exported = (await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/turns`, {
        schemaVersion: 1,
        commandId: "template-export-1",
        text: `${TOOL_CALL_TRIGGER}bot_export_template:{}`,
      }),
    )) as {
      events: Array<{
        type: string;
        content?: string;
        isError?: boolean;
        payload?: { type?: string; title?: string; body?: string };
      }>;
    };
    const toolResult = exported.events.find(
      (event) => event.type === "tool/result",
    );
    expect(toolResult?.isError, toolResult?.content).toBe(false);

    // The Bot's report to its User is an `agent-card`, not a publication.
    const card = exported.events.find(
      (event) => event.payload?.type === "agent-card",
    );
    expect(card?.payload?.title).toBe("Bot template staged");
    expect(card?.payload?.body).toContain("Memory");

    // A staged share is private, and it is the User who publishes it.
    const staged = (await expectOkJson(
      await asUser(userId, "/api/bot-templates"),
    )) as { shares: ShareRecord[] };
    expect(staged.shares).toHaveLength(1);
    const share = staged.shares[0]!;
    expect(share.botId).toBe(botId);
    expect(share.visibility).toBe("private");

    // PRIVATE IS PRIVATE. Neither an anonymous caller nor another User may read
    // it, and both get the same answer a missing share gives.
    const otherUserId = freshUserId("template-reader");
    for (const response of [
      await SELF.fetch(`${ORIGIN}/templates/v1/${share.shareId}`),
      await asUser(otherUserId, `/templates/v1/${share.shareId}`),
    ]) {
      expect(response.status).toBe(404);
    }

    await expectOkJson(
      await postAsUser(userId, "/api/bot-templates", {
        schemaVersion: 1,
        type: "template/set-visibility",
        commandId: "template-visibility-1",
        shareId: share.shareId,
        visibility: "link",
      }),
    );

    // THE PUBLISHED BLOB, fetched with no credential at all.
    const published = await SELF.fetch(
      `${ORIGIN}/templates/v1/${share.shareId}`,
    );
    expect(published.status).toBe(200);
    expect(published.headers.get("etag")).toBe(`"${share.hash}"`);
    const document = await published.text();

    const template = JSON.parse(document) as {
      profile: { avatar: { kind: string } };
      skills: Array<{ slug: string; body: string }>;
      routines: Array<{ slug: string; prompt: string; triggerKind?: string }>;
      mcpServers: Array<{ kind: string; connectionTypeId?: string }>;
    };

    // The recipe is there.
    expect(template.skills.map((skill) => skill.slug)).toContain(SKILL_SLUG);
    expect(template.skills[0]!.body).toBe(SKILL_BODY);
    expect(template.routines[0]!.prompt).toBe(ROUTINE_PROMPT);
    expect(template.routines[0]!.triggerKind).toBe("webhook");
    expect(template.profile.avatar.kind).toBe("sheep");

    // The keyed server is a placeholder the importer fills themselves.
    expect(template.mcpServers).toEqual([
      {
        kind: "needs-connection",
        name: "Example connector",
        connectionTypeId: "mcp-remote-key",
        hint: "This server needs your own Connection and credential.",
      },
    ]);

    // Nothing else travelled.
    expect(document).not.toContain(MCP_GOOD_API_KEY);
    expect(document).not.toContain(connectionId);
    expect(document).not.toContain("connectionId");
    expect(document).not.toContain(MCP_ENDPOINT);
    expect(document).not.toContain("memory");
    expect(document).not.toContain("digest");

    // REVOCATION IS THE ONLY THING THAT CAN HAPPEN TO AN IMMUTABLE BLOB.
    await expectOkJson(
      await postAsUser(userId, "/api/bot-templates", {
        schemaVersion: 1,
        type: "template/revoke",
        commandId: "template-revoke-1",
        shareId: share.shareId,
      }),
    );
    expect(
      (await SELF.fetch(`${ORIGIN}/templates/v1/${share.shareId}`)).status,
    ).toBe(404);
  });
});
