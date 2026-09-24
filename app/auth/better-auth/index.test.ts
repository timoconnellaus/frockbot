import { expect, test } from "bun:test";
import { BETTER_AUTH_PACKAGE_V1, identityCreationHooksV1 } from "./index.ts";
import type { AuthIdentityCandidateV1 } from "@frockbot/core/contracts";

test("the identity provider's write waits on the access authority's answer", async () => {
  const asked: AuthIdentityCandidateV1[] = [];
  const hooks = identityCreationHooksV1(async (candidate) => {
    asked.push(candidate);
    return candidate.email === "invited@example.com" && candidate.emailVerified;
  });

  expect(
    await hooks.user.create.before({
      email: "invited@example.com",
      emailVerified: true,
    }),
  ).toEqual({
    data: { email: "invited@example.com", emailVerified: true },
  });
  // The same address, unverified, is a different claim.
  expect(await hooks.user.create.before({ email: "invited@example.com" })).toBe(
    false,
  );
  expect(
    await hooks.user.create.before({
      email: "stranger@example.com",
      emailVerified: true,
    }),
  ).toBe(false);
  // A provider that returns no email must not be admitted by omission.
  expect(await hooks.user.create.before({})).toBe(false);
  expect(asked).toEqual([
    { email: "invited@example.com", emailVerified: true },
    { email: "invited@example.com", emailVerified: false },
    { email: "stranger@example.com", emailVerified: true },
    { email: "", emailVerified: false },
  ]);
});

test("the native door signs with the live hosted key, under any other name", () => {
  // Renaming what the native door signs with would invalidate every code and
  // bearer already issued, which is every signed-in phone and Mac.
  expect(BETTER_AUTH_PACKAGE_V1.nativeTokenSecret.name).toBe(
    "BETTER_AUTH_SECRET",
  );
  expect(
    BETTER_AUTH_PACKAGE_V1.nativeTokenSecret.read({
      BETTER_AUTH_SECRET: "live",
    }),
  ).toBe("live");
});

test("stores no identity, and signs nobody in, without a database", async () => {
  const stub = BETTER_AUTH_PACKAGE_V1.create({
    BETTER_AUTH_SECRET: "x".repeat(32),
    BETTER_AUTH_URL: "https://bot.example",
    GOOGLE_CLIENT_ID: "id",
    GOOGLE_CLIENT_SECRET: "secret",
  });
  expect(stub.storedIdentity).toBeUndefined();
  expect(stub.listStoredIdentities).toBeUndefined();
  expect(stub.deleteStoredIdentity).toBeUndefined();
  expect(
    (await stub.handler(new Request("https://bot.example/api/auth/x"))).status,
  ).toBe(503);
});

test("forgets an identity with its sessions and linked accounts, in one batch", async () => {
  const batches: Array<Array<{ sql: string; args: unknown[] }>> = [];
  const database = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({ sql, args }),
    }),
    batch: async (statements: Array<{ sql: string; args: unknown[] }>) => {
      batches.push(statements);
      return [];
    },
  } as unknown as D1Database;
  const store = BETTER_AUTH_PACKAGE_V1.create({ AUTH_DB: database });
  await store.deleteStoredIdentity!("user-1");
  // A session left behind would still sign the deleted User in.
  expect(batches).toEqual([
    [
      { sql: 'delete from "session" where "userId" = ?', args: ["user-1"] },
      { sql: 'delete from "account" where "userId" = ?', args: ["user-1"] },
      { sql: 'delete from "user" where "id" = ?', args: ["user-1"] },
    ],
  ]);
});
