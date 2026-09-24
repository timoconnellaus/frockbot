// Deleting an account and a Computer through the deployed gateway.
//
// The seam this covers is the route: the typed confirmation is checked against
// the identity the request authenticated as, the deletion is admitted with a
// 202 before any of it has happened, and an account that is gone answers as
// gone — 410 to a read, and the same 202 to a repeated deletion, so a press
// retried after its answer was lost is not an error.
import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { expect, test } from "vitest";
import { ACCOUNT_DELETED_KEY_V1 } from "@frockbot/app/account/deletion";
import {
  asUser,
  expectOkJson,
  freshUserId,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

function post(userId: string, path: string, body: unknown) {
  return asUser(userId, path, { method: "POST", body: JSON.stringify(body) });
}

test("an account is deleted against the typed phrase, and then answers as gone", async () => {
  const userId = freshUserId("deleted-account");
  await expectOkJson(await asUser(userId, "/api/bots"));

  // The development identity carries no email, so the phrase is its id.
  expect(
    await expectOkJson(await asUser(userId, "/api/account/delete")),
  ).toEqual({ schemaVersion: 1, confirmation: userId });

  const wrong = await post(userId, "/api/account/delete", {
    schemaVersion: 1,
    commandId: `delete-${crypto.randomUUID()}`,
    confirmation: "someone-else",
  });
  expect(wrong.status).toBe(409);
  expect(await wrong.json()).toMatchObject({ code: "confirmation-mismatch" });

  const commandId = `delete-${crypto.randomUUID()}`;
  const accepted = await post(userId, "/api/account/delete", {
    schemaVersion: 1,
    commandId,
    confirmation: userId.toUpperCase(),
  });
  expect(accepted.status).toBe(202);
  expect(await accepted.json()).toMatchObject({
    schemaVersion: 1,
    status: "deleting",
  });

  const user = env.USER_CONFIGURATIONS.getByName(userId);
  for (let pass = 0; pass < 40; pass += 1) {
    await runDurableObjectAlarm(user);
    const done = await runInDurableObject(
      user,
      async (_instance, state) =>
        (await state.storage.get(ACCOUNT_DELETED_KEY_V1)) !== undefined,
    );
    if (done) break;
  }
  expect(
    await runInDurableObject(user, async (_instance, state) => [
      ...(await state.storage.list()).keys(),
    ]),
  ).toEqual([ACCOUNT_DELETED_KEY_V1]);

  expect((await asUser(userId, "/api/bots")).status).toBe(410);
  const again = await post(userId, "/api/account/delete", {
    schemaVersion: 1,
    commandId,
    confirmation: userId,
  });
  expect(again.status).toBe(202);
});

test("the Computer is deleted by its own command, once", async () => {
  const userId = freshUserId("deleted-computer");
  await expectOkJson(await asUser(userId, "/api/bots"));
  const command = {
    schemaVersion: 1,
    commandId: `computer-${crypto.randomUUID()}`,
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await post(userId, "/api/computer/delete", command);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      schemaVersion: 1,
      status: "deleted",
    });
  }
  expect(
    (await post(userId, "/api/computer/delete", { schemaVersion: 1 })).status,
  ).toBe(400);
});
