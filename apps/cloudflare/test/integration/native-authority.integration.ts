import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { freshUserId } from "./fixtures.ts";

it("the User owner persists native issuance and revocation, refusing other User scope and replay", async () => {
  const userId = freshUserId("native");
  const stub = env.USER_CONFIGURATIONS.get(
    env.USER_CONFIGURATIONS.idFromName(userId),
  );
  const command = {
    schemaVersion: 1,
    action: "issue",
    userId,
    sessionId: "native-proof",
    expiresAt: Date.now() + 60_000,
    hello: {
      schemaVersion: 1,
      protocolVersion: 1,
      nativeVersion: "1.1.0",
      catalogs: [],
    },
  };
  const issued = await stub.nativeSession(command);
  expect(issued.status === "ok" ? issued.record?.sessionId : null).toBe(
    "native-proof",
  );
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.sync();
    expect(state.storage.kv.get("native:sessions:v1")).toBeDefined();
  });
  const reopened = env.USER_CONFIGURATIONS.get(
    env.USER_CONFIGURATIONS.idFromName(userId),
  );
  expect(
    await reopened.nativeSession({ ...command, action: "read" }),
  ).toMatchObject({ status: "ok", record: { userId } });
  expect(
    await reopened.nativeSession({
      ...command,
      userId: "another-user",
      action: "read",
    }),
  ).toMatchObject({ status: "refused" });
  await reopened.nativeSession({ ...command, action: "revoke" });
  expect(await reopened.nativeSession({ ...command, action: "read" })).toEqual({
    schemaVersion: 1,
    status: "ok",
    record: null,
  });
  expect(await reopened.nativeSession(command)).toMatchObject({
    status: "refused",
  });
});
