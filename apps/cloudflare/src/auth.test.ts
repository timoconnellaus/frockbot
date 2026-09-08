import { expect, test } from "bun:test";
import { signupDatabaseHooksV1 } from "./auth.ts";

test("a closed deployment refuses the account better-auth is about to create", async () => {
  const asked: string[] = [];
  const hooks = signupDatabaseHooksV1(async (email) => {
    asked.push(email);
    return email === "admin@example.com";
  });

  expect(
    await hooks.user.create.before({ email: "admin@example.com" }),
  ).toEqual({ data: { email: "admin@example.com" } });
  expect(
    await hooks.user.create.before({ email: "stranger@example.com" }),
  ).toBe(false);
  // A provider that returns no email must not be admitted by omission.
  expect(await hooks.user.create.before({})).toBe(false);
  expect(asked).toEqual(["admin@example.com", "stranger@example.com", ""]);
});
