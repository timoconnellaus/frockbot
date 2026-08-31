import { describe, expect, test } from "bun:test";
import { SystemPromptRegistry } from "@frockbot/plugin-prompt";
import { ToolRegistry } from "@frockbot/plugin-tools";
import {
  ComputerRegistry,
  type ComputerProvider,
} from "@frockbot/computer-core";
import {
  createPluginHarness,
  verifyPluginPackage,
} from "@frockbot/plugin-testkit";
import manifest from "../frockbot.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };
import { createComputerAgentPlugin } from "./agent.js";

async function execute(
  harness: Awaited<ReturnType<typeof createPluginHarness>>,
  name: string,
  input: unknown,
) {
  const context = {
    botId: "bot-1",
    agentId: "run-9",
    compositionGenerationId: "bootstrap",
    sessionId: "session-1",
    signal: new AbortController().signal,
  };
  const prepared = await harness.root.tools.prepare(
    { id: crypto.randomUUID(), name, input },
    context,
  );
  if (prepared.kind !== "ready") throw new Error(prepared.result.content);
  return harness.root.tools.executePrepared(prepared, context);
}

describe("computer agent contribution", () => {
  test("routes generic tools through the Bot's selected Computer provider", async () => {
    const calls: string[] = [];
    const provider: ComputerProvider = {
      id: "fixture",
      open: async (identity, tenant, assignment) => {
        calls.push(`open:${identity.userId}:${tenant.botId}`);
        return {
          assignment,
          identity,
          tenant,
          exec: {
            execute: async (request) => {
              calls.push(
                `exec:${request.executable}:${request.args?.join(" ")}`,
              );
              return {
                exitCode: 0,
                stdout: new TextEncoder().encode("/workspace/bot-1"),
                stderr: new Uint8Array(),
                outputTruncated: false,
              };
            },
          },
          browser: {
            perform: async (action) => {
              calls.push(`browser:${action.type}`);
              return { accessibilitySnapshot: "button: Continue" };
            },
          },
          close: () => Promise.resolve(),
        };
      },
    };
    const harness = await createPluginHarness([
      ComputerRegistry,
      ToolRegistry,
      SystemPromptRegistry,
    ]);
    harness.root.computers.register(provider);
    await harness.mount(
      createComputerAgentPlugin({
        userId: "user-1",
        defaultProviderId: "fixture",
      }),
    );

    const exec = await execute(harness, "computer_exec", { command: "pwd" });
    const browser = await execute(harness, "computer_browser", {
      action: "snapshot",
    });

    expect(exec).toMatchObject({ content: "/workspace/bot-1", isError: false });
    expect(browser).toMatchObject({
      content: "button: Continue",
      isError: false,
    });
    expect(calls).toEqual([
      "open:user-1:bot-1",
      "exec:/bin/bash:-lc pwd",
      "open:user-1:bot-1",
      "browser:snapshot",
    ]);
    await harness.dispose();
  });

  test("satisfies plugin package conventions", () => {
    expect(verifyPluginPackage({ packageJson, manifest })).toMatchObject({
      name: "@frockbot/plugin-computer",
      contributionKinds: ["runtime", "client"],
    });
  });
});
