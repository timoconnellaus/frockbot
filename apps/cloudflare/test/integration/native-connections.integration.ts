import { SELF } from "cloudflare:test";
import { expect, test } from "vitest";
import { nativeHeaders } from "../native-session-fixture.ts";
import { asUser, freshUserId, useApplicationArtifact } from "./fixtures.ts";

useApplicationArtifact();

test("browser and native see the same secret-free Connectors home", async () => {
  const userId = freshUserId("native-connections");
  const headers = await nativeHeaders(userId);
  const browser = await asUser(userId, "/api/settings/connections");
  expect(browser.status).toBe(200);
  const view = await browser.json();
  expect(view).toMatchObject({
    schemaVersion: 1,
    ownerId: userId,
    accounts: [],
  });
  const native = await SELF.fetch(
    "https://bot.frockbot.com/api/settings/connections",
    { headers },
  );
  expect(native.status).toBe(200);
  expect(await native.json()).toEqual(view);
});
