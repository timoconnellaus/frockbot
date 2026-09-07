import { describe, expect, test } from "bun:test";
import {
  createAgentRuntimeHarness,
  verifyPluginPackage,
} from "@frockbot/plugin-testkit";
import manifest from "../frockbot.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };
import { createIdentityFeature, DEFAULT_IDENTITY_TEXT } from "./agent.js";

const assemblyContext = {
  sessionId: "session",
  provider: "fixture",
  model: "fixture",
  turnType: "chat" as const,
};

describe("identity feature", () => {
  test("registers and disposes a prompt section", async () => {
    const runtime = createAgentRuntimeHarness();
    await runtime.mount(createIdentityFeature());

    const assembled = await runtime.systemPrompt.assemble(assemblyContext);
    expect(assembled.text).toContain(DEFAULT_IDENTITY_TEXT);
    expect(assembled.sections).toContainEqual({
      id: "identity",
      text: DEFAULT_IDENTITY_TEXT,
    });

    await runtime.dispose();
    const afterDispose = await runtime.systemPrompt.assemble(assemblyContext);
    expect(
      afterDispose.sections.some((section) => section.id === "identity"),
    ).toBe(false);
    expect(afterDispose.text).not.toContain(DEFAULT_IDENTITY_TEXT);
  });

  test("supports package-owned identity configuration", async () => {
    const runtime = createAgentRuntimeHarness();
    await runtime.mount(
      createIdentityFeature({
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

  test("satisfies plugin package conventions", () => {
    expect(verifyPluginPackage({ packageJson, manifest })).toMatchObject({
      name: "@frockbot/plugin-identity",
      contributionKinds: ["runtime"],
    });
  });
});
