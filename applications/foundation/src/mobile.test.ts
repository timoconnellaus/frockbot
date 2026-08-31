import { expect, test } from "bun:test";
import { foundationMobilePackages } from "./mobile.ts";
import { compileFoundationApplicationDeclarations } from "./runtime.ts";

test("foundation mobile declaration follows immutable application order", () => {
  expect(foundationMobilePackages.map(({ specifier }) => specifier)).toEqual([
    "@frockbot/plugin-mobile-clipboard",
    "@frockbot/plugin-mobile-notifications",
  ]);
  const compiled = compileFoundationApplicationDeclarations();
  expect(
    compiled.packages
      .filter(({ id }) => compiled.contributions.mobile.includes(id))
      .map(({ specifier }) => specifier),
  ).toEqual(foundationMobilePackages.map(({ specifier }) => specifier));
  for (const pkg of foundationMobilePackages) {
    expect(pkg.manifest).toMatchObject({
      schemaVersion: 1,
      contributions: { mobile: expect.any(String) },
    });
  }
});
