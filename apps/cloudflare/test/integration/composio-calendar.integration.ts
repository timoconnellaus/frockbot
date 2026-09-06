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
import { toolkitNamespace } from "./composio-helpers.ts";
useApplicationArtifact();

it("Calendar and Gmail use the same connection, account-wide tool and event paths with independent accounts", async () => {
  const userId = freshUserId("calendar-proof");
  const botIds = ["calendar-helper", "meeting-helper"];
  await provisionThroughGateway({ userId, botId: botIds[0]! });
  expect(
    (
      await postAsUser(userId, "/api/bots", {
        schemaVersion: 1,
        type: "bot/create",
        commandId: "second-calendar-bot",
        expectedRevision: 1,
        botId: botIds[1],
        name: "Meeting helper",
      })
    ).status,
  ).toBe(201);
  const catalog = (await expectOkJson(
    await asUser(userId, "/api/plugins/composio/catalog"),
  )) as {
    items: Array<{ id: string; name: string }>;
  };
  expect(catalog.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "gmail", name: "Gmail" }),
      expect.objectContaining({
        id: "googlecalendar",
        name: "Google Calendar",
      }),
    ]),
  );
  for (const [connectionId, connectorId, alias] of [
    ["calendar-work", "googlecalendar", "Work calendar"],
    ["calendar-personal", "googlecalendar", "Personal calendar"],
    ["calendar-proof-inbox", "gmail", "Work inbox"],
  ]) {
    const start = await postAsUser(
      userId,
      "/api/plugins/composio/connections",
      {
        schemaVersion: 1,
        type: "connection/start",
        commandId: connectionId,
        connectionTypeId: "app",
        connectorId,
        alias,
      },
    );
    expect(start.status).toBe(201);
    const link = (await start.json()) as { redirectUrl: string };
    expect(
      (await SELF.fetch(link.redirectUrl, { redirect: "manual" })).status,
    ).toBe(303);
  }
  const user = env.USER_CONFIGURATIONS.getByName(userId);
  await evictDurableObject(user);
  const settings = (await expectOkJson(
    await asUser(userId, "/api/settings"),
  )) as {
    connections: Array<{
      connectionId: string;
      state: string;
      displayName: string;
    }>;
  };
  expect(settings.connections).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        connectionId: "calendar-work",
        state: "ready",
        displayName: "Work calendar",
      }),
      expect.objectContaining({
        connectionId: "calendar-personal",
        state: "ready",
        displayName: "Personal calendar",
      }),
    ]),
  );
  const workNamespace = await toolkitNamespace(
    "googlecalendar",
    "calendar-work",
  );
  const personalNamespace = await toolkitNamespace(
    "googlecalendar",
    "calendar-personal",
  );
  expect(workNamespace).not.toBe(personalNamespace);
  for (const botId of botIds) {
    const commandId = `calendar-tools-${botId}`;
    await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/turns`, {
        schemaVersion: 1,
        commandId,
        text:
          "Read my upcoming meetings.\n" +
          toolCallTriggerPrompt(
            ["get_dynamic_tools", { namespace: workNamespace }],
            [
              "call_dynamic_tool",
              {
                namespace: workNamespace,
                toolName: "GOOGLECALENDAR_EVENTS_LIST",
                arguments: {
                  calendarId: "primary",
                  singleEvents: true,
                  orderBy: "startTime",
                  maxResults: 10,
                },
                mcpDetails: { description: "Read upcoming meetings" },
              },
            ],
          ),
      }),
    );
    const run = await readStoredRunWithEventsV1<{ events: SessionEvent[] }>(
      userId,
      botId,
      commandId,
    );
    const events = run!.events;
    const disclosure = events.find(
      (e) => e.type === "tool/result" && e.name === "get_dynamic_tools",
    );
    expect(disclosure).toMatchObject({
      isError: false,
      content: expect.stringContaining("GOOGLECALENDAR_EVENTS_LIST"),
    });
    expect(JSON.stringify(disclosure)).not.toContain("GMAIL_FETCH_EMAILS");
    const intent = events.find(
      (e) => e.type === "tool/call" && e.name === "call_dynamic_tool",
    )!;
    const result = events.find(
      (e) => e.type === "tool/result" && e.name === "call_dynamic_tool",
    )!;
    expect(result).toMatchObject({
      isError: false,
      content: expect.stringContaining("Team meeting"),
    });
    expect(intent.seq).toBeLessThan(result.seq);
    expect(JSON.stringify(events)).not.toMatch(
      /test-composio-backend-key|connected_account_id/,
    );
  }
  const botId = botIds[1]!;
  await expectOkJson(
    await postAsUser(
      userId,
      "/api/plugins/composio/connections/calendar-work/revoke",
      {
        schemaVersion: 1,
        type: "connection/revoke",
      },
    ),
  );
  for (const namespace of [workNamespace, personalNamespace]) {
    const commandId =
      namespace === workNamespace ? "revoked-calendar" : "personal-calendar";
    await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/turns`, {
        schemaVersion: 1,
        commandId,
        text: toolCallTriggerPrompt([
          "call_dynamic_tool",
          {
            namespace,
            toolName: "GOOGLECALENDAR_EVENTS_LIST",
            arguments: { calendarId: "primary" },
            mcpDetails: { description: "Read upcoming meetings" },
          },
        ]),
      }),
    );
    const run = await readStoredRunWithEventsV1<{ events: SessionEvent[] }>(
      userId,
      botId,
      commandId,
    );
    expect(
      run!.events.find(
        (e) => e.type === "tool/result" && e.name === "call_dynamic_tool",
      ),
    ).toMatchObject({ isError: namespace === workNamespace });
  }
});
