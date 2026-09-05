import { evictDurableObject, SELF } from "cloudflare:test";
import { expect, test } from "vitest";
import { decodeProtocol } from "@frockbot/protocol-schemas";
import { nativeHeaders } from "../native-session-fixture.ts";
import {
  asUser,
  postAsUser,
  freshUserId,
  provisionThroughGateway,
  botStateStubV1,
  useApplicationArtifact,
  OLLAMA_REVOKED_API_KEY,
} from "./fixtures.ts";
useApplicationArtifact();

test("browser and native share failed notices and idempotent unread/acknowledgement after owner eviction", async () => {
  const userId = freshUserId("native-inbox"),
    botId = "inbox-alpha";
  await provisionThroughGateway({
    userId,
    botId,
    apiKey: OLLAMA_REVOKED_API_KEY,
  });
  const headers = await nativeHeaders(userId);
  const native = (path: string, body?: unknown) =>
    SELF.fetch(`https://bot.frockbot.com${path}`, {
      headers: { ...headers, "content-type": "application/json" },
      ...(body === undefined
        ? {}
        : { method: "POST", body: JSON.stringify(body) }),
    });
  const settings = (await (
    await asUser(userId, `/api/bots/${botId}/settings`)
  ).json()) as { revision: number };
  expect(
    (
      await postAsUser(userId, `/api/bots/${botId}/settings`, {
        schemaVersion: 1,
        type: "bot/update-notifications",
        commandId: "enable-notices",
        expectedRevision: settings.revision,
        botId,
        notifications: { enabled: true },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await postAsUser(userId, `/api/bots/${botId}/turns`, {
        schemaVersion: 1,
        commandId: "failed-turn",
        text: "hello",
      })
    ).status,
  ).toBe(200);
  const read = async () =>
    decodeProtocol(
      "NotificationDirectory",
      await (await native("/api/bots/notifications")).json(),
    );
  const notices = await read();
  expect(notices.notifications).toHaveLength(1);
  expect(notices.notifications[0]!.title).toContain("couldn't finish");
  expect(notices.notifications[0]!.body).not.toContain("401");
  expect(
    await (await asUser(userId, "/api/bots/notifications")).json(),
  ).toEqual(notices);
  const unread = decodeProtocol(
    "UnreadDirectory",
    await (await native("/api/bots/unread")).json(),
  ).unread[0]!;
  expect(unread.botId).toBe(botId);
  const command = {
    schemaVersion: 1,
    type: "bot/mark-unread",
    commandId: "native-read-1",
    botId,
  };
  const receipt = decodeProtocol(
    "MarkReadReceipt",
    await (await native(`/api/bots/${botId}/unread`, command)).json(),
  );
  await evictDurableObject(botStateStubV1(userId, botId));
  expect(
    await (
      await postAsUser(userId, `/api/bots/${botId}/unread`, command)
    ).json(),
  ).toEqual(receipt);
  expect((await read()).notifications).toHaveLength(1); // read status does not dismiss an update
  const ack = {
    schemaVersion: 1,
    action: "acknowledge",
    notificationId: notices.notifications[0]!.notificationId,
  };
  expect((await native(`/api/bots/${botId}/notifications`, ack)).status).toBe(
    200,
  );
  await evictDurableObject(botStateStubV1(userId, botId));
  expect(
    (await postAsUser(userId, `/api/bots/${botId}/notifications`, ack)).status,
  ).toBe(200);
  expect((await read()).notifications).toEqual([]);
  expect(
    await (await asUser(userId, "/api/bots/notifications")).json(),
  ).toEqual({ schemaVersion: 1, notifications: [] });
  const stranger = freshUserId("other-inbox");
  expect(
    (await postAsUser(stranger, `/api/bots/${botId}/notifications`, ack))
      .status,
  ).toBe(404);
});
