import {
  env,
  evictDurableObject,
  runInDurableObject,
  SELF,
} from "cloudflare:test";
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
} from "./fixtures.ts";
useApplicationArtifact();
test("native and browser share archive, restore, deletion and redacted history across owner eviction", async () => {
  const userId = freshUserId("native-recovery"),
    botId = "recovery-alpha";
  await provisionThroughGateway({ userId, botId });
  const headers = await nativeHeaders(userId);
  const native = (path: string, body?: unknown) =>
    SELF.fetch(`https://bot.frockbot.com${path}`, {
      headers: { ...headers, "content-type": "application/json" },
      ...(body === undefined
        ? {}
        : { method: "POST", body: JSON.stringify(body) }),
    });
  const path = `/api/bots/${botId}/lifecycle`;
  const archive = {
    schemaVersion: 1,
    type: "bot/archive",
    commandId: "native-archive",
    botId,
  };
  const receipt = decodeProtocol(
    "BotLifecycleReceipt",
    await (await native(path, archive)).json(),
  );
  expect(receipt.status).toBe("applied");
  expect(receipt.lifecycle.status).toBe("archived");
  await evictDurableObject(env.USER_CONFIGURATIONS.getByName(userId));
  expect(await (await postAsUser(userId, path, archive)).json()).toEqual(
    receipt,
  );
  const states = decodeProtocol(
    "BotLifecycleDirectory",
    await (await native("/api/bots/lifecycles")).json(),
  );
  expect(states.lifecycles).toContainEqual(receipt.lifecycle);
  expect(await (await asUser(userId, "/api/bots/lifecycles")).json()).toEqual(
    states,
  );
  const restore = {
    schemaVersion: 1,
    type: "bot/restore",
    commandId: "browser-restore",
    botId,
  };
  expect(
    decodeProtocol(
      "BotLifecycleReceipt",
      await (await postAsUser(userId, path, restore)).json(),
    ).lifecycle.status,
  ).toBe("active");
  const historyPath = `/api/bots/${botId}/composition/generations?limit=10`;
  const history = decodeProtocol(
    "SetupHistory",
    await (await native(historyPath)).json(),
  );
  expect(history.generations.length).toBeGreaterThan(0);
  await evictDurableObject(botStateStubV1(userId, botId));
  expect(await (await asUser(userId, historyPath)).json()).toEqual(history);
  const auditPath = `/api/audit?botId=${botId}&limit=30`;
  expect(
    decodeProtocol("AuditPage", await (await native(auditPath)).json()),
  ).toEqual(await (await asUser(userId, auditPath)).json());
  const stranger = freshUserId("recovery-stranger");
  expect((await postAsUser(stranger, path, restore)).status).toBe(404);
  const deletion = {
    schemaVersion: 1,
    type: "bot/delete",
    commandId: "native-delete",
    botId,
  };
  const deleted = decodeProtocol(
    "BotLifecycleReceipt",
    await (await native(path, deletion)).json(),
  );
  expect(deleted.status).toBe("applied");
  expect(deleted.lifecycle.status).toBe("deleted");
  // Workerd’s post-delete eviction helper does not complete in this scenario.
  // Inspect the committed owner receipt directly; archive above and setup
  // reads exercise actual eviction. Post-delete eviction remains unqualified.
  const committed = await runInDurableObject(
    env.USER_CONFIGURATIONS.getByName(userId),
    async (_instance, state) =>
      state.storage.get<{ receipt: unknown }>(
        "flock:lifecycle-receipt:native-delete",
      ),
  );
  expect(committed?.receipt).toEqual(deleted);
  expect(await (await postAsUser(userId, path, deletion)).json()).toEqual(
    deleted,
  );
  expect(
    decodeProtocol("BotDirectory", await (await native("/api/bots")).json())
      .bots,
  ).toEqual([]);
  const unavailable = await native(historyPath);
  expect(unavailable.status).toBe(400);
  expect((await asUser(userId, historyPath)).status).toBe(unavailable.status);
});
