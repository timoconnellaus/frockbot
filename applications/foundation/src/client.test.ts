import { describe, expect, test } from "bun:test";
import { foundationClientPlugins } from "./client.js";
import { compileFoundationApplication } from "./runtime.js";

describe("foundation client composition", () => {
  test("matches the client contribution set compiled from the descriptor", async () => {
    const plan = await compileFoundationApplication();

    expect(foundationClientPlugins).toHaveLength(
      plan.contributions.client.length,
    );
  });
});
