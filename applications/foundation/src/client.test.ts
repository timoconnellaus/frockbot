import { describe, expect, test } from "bun:test";
import { foundationClientPlugins } from "./client.js";
import { compileFoundationApplication } from "./runtime.js";

describe("foundation client composition", () => {
  test("matches the client contribution set compiled from the descriptor", async () => {
    const plan = await compileFoundationApplication();

    // Artifact-backed members are excluded on purpose: their client
    // Contribution is an immutable iframe page the shell hosts, not a Plugin
    // compiled into this bundle (ADR 0022 decision 8), so it has no entry in
    // the client Contribution table and never should.
    const compiledIntoTheBundle = plan.packages.filter(
      (pkg) =>
        pkg.artifact === undefined &&
        plan.contributions.client.includes(pkg.id),
    );

    expect(foundationClientPlugins).toHaveLength(compiledIntoTheBundle.length);
  });
});
