import { expect, test } from "bun:test";
import { identityCreationHooksV1, type IdentityCandidateV1 } from "./auth.ts";

test("the identity provider's write waits on the access authority's answer", async () => {
  const asked: IdentityCandidateV1[] = [];
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
