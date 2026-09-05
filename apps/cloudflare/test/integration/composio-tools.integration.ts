import { SELF, env, evictDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import type { SessionEvent } from "@frockbot/kernel-contracts";
import {
  asUser,
  expectOkJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  readStoredRunWithEventsV1,
  toolCallTriggerPrompt,
  useApplicationArtifact,
} from "./fixtures.ts";
useApplicationArtifact();

it("one Gmail connection lets both Bots discover and call tools with durable intent and result", async () => {
  const userId = freshUserId("gmail-tools");
  const botIds = ["gmail-first", "gmail-second"];
  await provisionThroughGateway({ userId, botId: botIds[0]! });
  const created = await postAsUser(userId, "/api/bots", {
    schemaVersion: 1,
    type: "bot/create",
    commandId: "second-gmail-bot",
    expectedRevision: 1,
    botId: botIds[1],
    name: "Second Bot",
  });
  expect(created.status).toBe(201);
  const started = await postAsUser(
    userId,
    "/api/plugins/composio/connections",
    {
      schemaVersion: 1,
      type: "connection/start",
      commandId: "shared-gmail",
      connectionTypeId: "app",
      connectorId: "gmail",
      alias: "Work inbox",
    },
  );
  expect(started.status).toBe(201);
  const link = (await started.json()) as { redirectUrl: string };
  expect(
    (await SELF.fetch(link.redirectUrl, { redirect: "manual" })).status,
  ).toBe(303);
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode("shared-gmail"),
  );
  const namespace = `gmail--${Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16)}`;
  for (const botId of botIds) {
    const commandId = `tools-${botId}`;
    const turn = {
      schemaVersion: 1,
      commandId,
      text: toolCallTriggerPrompt(
        ["get_dynamic_tools", { namespace }],
        [
          "call_dynamic_tool",
          {
            namespace,
            toolName: "GMAIL_FETCH_EMAILS",
            arguments: { query: "unread" },
            mcpDetails: {
              description: "Read recent messages in my work inbox",
            },
          },
        ],
      ),
    };
    await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/turns`, turn),
    );
    const read = () =>
      readStoredRunWithEventsV1<{ events: SessionEvent[] }>(
        userId,
        botId,
        commandId,
      );
    const run = await read();
    const events = run?.events ?? [];
    const intent = events.find(
      (event) =>
        event.type === "tool/call" && event.name === "call_dynamic_tool",
    );
    const result = events.find(
      (event) =>
        event.type === "tool/result" && event.name === "call_dynamic_tool",
    );
    expect(intent).toBeDefined();
    expect(result).toMatchObject({
      isError: false,
      content: expect.stringContaining("Hello from your inbox"),
    });
    expect(intent!.seq).toBeLessThan(result!.seq);
    expect(
      events.some(
        (event) =>
          event.type === "tool/result" && event.name === "get_dynamic_tools",
      ),
    ).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(
      /test-composio-backend-key|connected_account_id|composio_search_tools/,
    );
    const stub = env.BOT_STATES.getByName(`${userId}:${botId}`);
    await evictDurableObject(stub);
    await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/turns`, turn),
    );
    expect(
      (await read())?.events.filter(
        (event) =>
          event.type === "tool/call" && event.name === "call_dynamic_tool",
      ),
    ).toHaveLength(1);
  }
  await expectOkJson(
    await postAsUser(
      userId,
      "/api/plugins/composio/connections/shared-gmail/revoke",
      { schemaVersion: 1, type: "connection/revoke" },
    ),
  );
  for (const botId of botIds) {
    const response = await asUser(userId, `/api/bots/${botId}/settings`);
    expect(response.status).toBe(200);
    // A fresh Turn must resolve the revoked grant as absent for either Bot.
    await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/turns`, {
        schemaVersion: 1,
        commandId: `revoked-${botId}`,
        text: toolCallTriggerPrompt([
          "call_dynamic_tool",
          {
            namespace,
            toolName: "GMAIL_FETCH_EMAILS",
            arguments: {},
            mcpDetails: { description: "Read email" },
          },
        ]),
      }),
    );
    const run = await readStoredRunWithEventsV1<{ events: SessionEvent[] }>(
      userId,
      botId,
      `revoked-${botId}`,
    );
    expect(
      run?.events.find(
        (event) =>
          event.type === "tool/result" && event.name === "call_dynamic_tool",
      ),
    ).toMatchObject({ isError: true });
  }
});
