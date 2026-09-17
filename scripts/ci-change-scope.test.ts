import { expect, test } from "bun:test";
import { slowTierRequiredV1 } from "./ci-change-scope";

test("a push that only touches a separately deployed site skips the slow tier", () => {
  expect(
    slowTierRequiredV1([
      "apps/marketing/src/index.html",
      "apps/marketing/package.json",
    ]),
  ).toBe(false);
  expect(slowTierRequiredV1(["apps/admin-portal/src/main.ts"])).toBe(false);
  expect(
    slowTierRequiredV1([
      "apps/marketing/src/index.html",
      "apps/admin-portal/src/main.ts",
    ]),
  ).toBe(false);
});

test("anything the application is built from obliges the slow tier", () => {
  for (const path of [
    "apps/cloudflare/src/gateway.ts",
    "core/deadline.ts",
    "app/billing/stripe.ts",
    "providers/catalog/models.ts",
    "apps/native/lib/main.dart",
    "package.json",
    "bun.lock",
    ".github/workflows/main.yml",
    "scripts/validate.ts",
  ])
    expect(slowTierRequiredV1([path])).toBe(true);
});

test("one unrecognised path among skippable ones is enough to oblige it", () => {
  expect(
    slowTierRequiredV1(["apps/marketing/src/index.html", "core/deadline.ts"]),
  ).toBe(true);
});

test("a prefix is a directory, not a string the path merely starts with", () => {
  // `apps/marketing-experiments/` is not `apps/marketing/`, and a deployable
  // nobody has classified must not inherit the skip by sharing a name.
  expect(slowTierRequiredV1(["apps/marketing-experiments/index.ts"])).toBe(
    true,
  );
  expect(slowTierRequiredV1(["apps/admin-portal-v2/main.ts"])).toBe(true);
});

test("an undetermined change set is treated as obliging everything", () => {
  // A force push, a first push, or a range that could not be resolved reports
  // no paths. That is absence of evidence, not evidence the push was empty.
  expect(slowTierRequiredV1([])).toBe(true);
});
