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
  const view = (await browser.json()) as {
    accounts: { authorization: string }[];
  };
  expect(view).toMatchObject({ schemaVersion: 1, ownerId: userId });
  // A fresh User already holds the platform's own ambient account — that is
  // what lets their first Bot answer with no configuration — and nothing in
  // the frame is a credential.
  expect(
    view.accounts.every((account) => account.authorization !== "api-key"),
  ).toBe(true);
  expect(JSON.stringify(view)).not.toMatch(/apiKey|credential|token/i);

  const native = await SELF.fetch(
    "https://bot.frockbot.com/api/settings/connections",
    { headers },
  );
  expect(native.status).toBe(200);
  expect(await native.json()).toEqual(view);
});
