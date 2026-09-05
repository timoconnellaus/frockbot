import {
  SELF,
  env,
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { expect, it } from "vitest";
import type { SessionEvent } from "@frockbot/kernel-contracts";
import {
  asUser,
  expectOkJson,
  freshUserId,
  listStoredRunsWithEventsV1,
  postAsUser,
  provisionThroughGateway,
  readStoredRunWithEventsV1,
  settledRoutineFiringV1,
  toolCallTriggerPrompt,
  useApplicationArtifact,
} from "./fixtures.ts";
import { deliverComposioEvent, toolkitNamespace } from "./composio-helpers.ts";
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
  const triggerType = "GOOGLECALENDAR_EVENT_STARTING_SOON_TRIGGER";
  const triggerCatalog = (await expectOkJson(
    await asUser(userId, `/api/bots/${botId}/routines/triggers`),
  )) as {
    items: Array<{ connectionId: string; triggerType: string; name: string }>;
  };
  expect(
    triggerCatalog.items.filter((item) => item.triggerType === triggerType),
  ).toHaveLength(2);
  expect(triggerCatalog.items).toContainEqual(
    expect.objectContaining({
      connectionId: "calendar-work",
      name: "Event starting soon in Google Calendar",
    }),
  );
  await expectOkJson(
    await postAsUser(userId, `/api/bots/${botId}/turns`, {
      schemaVersion: 1,
      commandId: "create-meeting-routine",
      text:
        "Before an event starts in Google Calendar, prepare a meeting brief.\n" +
        toolCallTriggerPrompt(
          ["routine_manage", { action: "list_triggers" }],
          [
            "routine_manage",
            {
              action: "create",
              routineId: "meeting-brief",
              name: "Meeting brief",
              prompt: "Prepare a brief for the meeting in the event input.",
              trigger: {
                composio: {
                  connectionId: "calendar-work",
                  triggerType,
                  config: {
                    calendarId: "primary",
                    countdownWindowMinutes: 60,
                    includeAllDay: false,
                    interval: 2,
                    minutesBeforeStart: 10,
                  },
                },
              },
            },
          ],
        ),
    }),
  );
  const authored = await readStoredRunWithEventsV1<{ events: SessionEvent[] }>(
    userId,
    botId,
    "create-meeting-routine",
  );
  const authorResults = authored!.events.filter(
    (e) => e.type === "tool/result" && e.name === "routine_manage",
  );
  expect(authorResults).toHaveLength(2);
  expect(
    authorResults.every((e) => e.type === "tool/result" && !e.isError),
  ).toBe(true);
  const payload = {
    calendar_id: "primary",
    event_id: "calendar-event-one",
    countdown_window_minutes: 60,
    summary: "Team meeting",
    start_time: "2026-09-05T09:00:00+10:00",
    minutes_until_start: 10,
  };
  const deliver = () =>
    deliverComposioEvent({
      eventId: "calendar-starting-one",
      accountId: "ca_calendar-work",
      triggerId: "ti_ca_calendar-work",
      triggerType,
      data: payload,
    });
  const bot = env.BOT_STATES.getByName(`${userId}:${botId}`);
  await evictDurableObject(user);
  await evictDurableObject(bot);
  expect((await deliver()).status).toBe(202);
  await evictDurableObject(bot);
  await runDurableObjectAlarm(bot);
  const firing = await settledRoutineFiringV1<{
    runId: string;
    status: string;
    events: SessionEvent[];
    admission: { turnType: string; origin?: { routineId?: string } };
  }>(userId, botId, "meeting-brief");
  expect(firing.admission.turnType).toBe("automation");
  expect(
    JSON.stringify(firing.events.filter((e) => e.type === "user/message")),
  ).toContain("Team meeting");
  expect((await deliver()).status).toBe(202);
  await runDurableObjectAlarm(bot);
  const runs = await listStoredRunsWithEventsV1<{
    admission?: { turnType: string };
  }>(userId, botId);
  expect(
    runs.filter((run) => run.admission?.turnType === "automation"),
  ).toHaveLength(1);
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
  await runInDurableObject(user, async (_instance, state) => {
    const groups = await state.storage.list<{ status: string }>({
      prefix: "composio:trigger-group:",
    });
    expect([...groups.values()].map((item) => item.status)).toEqual([
      "deleted",
    ]);
  });
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
