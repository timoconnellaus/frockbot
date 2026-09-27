import { describe, expect, test } from "bun:test";
import { createAgentRuntimeHarness } from "@frockbot/app/testkit";
import { createIdentityFeature, defaultIdentityTextV1 } from "./agent.js";

const assemblyContext = {
  sessionId: "session",
  provider: "fixture",
  model: "fixture",
  turnType: "chat" as const,
};

describe("identity feature", () => {
  test("registers and disposes a prompt section", async () => {
    const runtime = createAgentRuntimeHarness();
    await runtime.mount(createIdentityFeature({ productName: "FrockBot" }));

    const assembled = await runtime.systemPrompt.assemble(assemblyContext);
    expect(assembled.text).toContain(defaultIdentityTextV1("FrockBot"));
    expect(assembled.sections).toContainEqual({
      id: "identity",
      text: defaultIdentityTextV1("FrockBot"),
    });

    await runtime.dispose();
    const afterDispose = await runtime.systemPrompt.assemble(assemblyContext);
    expect(
      afterDispose.sections.some((section) => section.id === "identity"),
    ).toBe(false);
    expect(afterDispose.text).not.toContain(defaultIdentityTextV1("FrockBot"));
  });

  test("supports package-owned identity configuration", async () => {
    const runtime = createAgentRuntimeHarness();
    await runtime.mount(
      createIdentityFeature({
        productName: "FrockBot",
        sectionId: "persona",
        text: "You are a test bot.",
        order: 50,
      }),
    );

    expect(
      (await runtime.systemPrompt.assemble(assemblyContext)).sections,
    ).toContainEqual({ id: "persona", text: "You are a test bot." });
    await runtime.dispose();
  });
});
