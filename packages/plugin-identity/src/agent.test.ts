import { describe, expect, test } from "bun:test";
import { SystemPromptRegistry } from "@frockbot/agent-core";
import {
  createPluginHarness,
  verifyPluginPackage,
} from "@frockbot/plugin-testkit";
import manifest from "../frockbot.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };
import { createIdentityPlugin, DEFAULT_IDENTITY_TEXT } from "./agent.js";

describe("identity plugin", () => {
  test("registers and disposes a prompt section", async () => {
    const harness = await createPluginHarness([SystemPromptRegistry]);
    const fiber = await harness.mount(createIdentityPlugin());

    expect(
      await harness.root.systemPrompt.assemble({
        sessionId: "session",
        provider: "fixture",
        model: "fixture",
      }),
    ).toMatchObject({
      text: DEFAULT_IDENTITY_TEXT,
      sections: [{ id: "identity", text: DEFAULT_IDENTITY_TEXT }],
    });

    await fiber.dispose();
    expect(
      await harness.root.systemPrompt.assemble({
        sessionId: "session",
        provider: "fixture",
        model: "fixture",
      }),
    ).toEqual({ text: "", sections: [] });
    await harness.dispose();
  });

  test("supports package-owned identity configuration", async () => {
    const harness = await createPluginHarness([SystemPromptRegistry]);
    await harness.mount(
      createIdentityPlugin({
        sectionId: "persona",
        text: "You are a test bot.",
        order: 50,
      }),
    );

    expect(
      await harness.root.systemPrompt.assemble({
        sessionId: "session",
        provider: "fixture",
        model: "fixture",
      }),
    ).toMatchObject({
      sections: [{ id: "persona", text: "You are a test bot." }],
    });
    await harness.dispose();
  });

  test("satisfies plugin package conventions", () => {
    expect(verifyPluginPackage({ packageJson, manifest })).toMatchObject({
      name: "@frockbot/plugin-identity",
      contributionKinds: ["runtime"],
    });
  });
});
