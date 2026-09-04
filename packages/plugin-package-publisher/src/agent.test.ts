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
import { createPackagePublisherAgentPlugin } from "./agent.js";
import type {
  PackagePublicationReceiptV1,
  PackageRevisionHistoryV1,
} from "./shared.js";

const history: PackageRevisionHistoryV1 = {
  schemaVersion: 1,
  revision: 1,
  activePackageRevision: 1,
  revisions: [
    {
      packageRevision: 1,
      applicationHash: "sha256:one",
      publishedAt: "2026-09-01T00:00:00.000Z",
      checks: [{ name: "test", status: "passed" }],
    },
  ],
};

async function execute(
  tools: Pick<ToolRegistry, "prepare" | "executePrepared">,
  name: string,
  input: unknown,
): Promise<{ content: string; isError: boolean }> {
  const context = {
    botId: "bot-1",
    agentId: "bot-1",
    compositionGenerationId: "bootstrap",
    turnType: "chat" as const,
    effectId: "tool:1:1:0",
    sessionId: "session-1",
    signal: new AbortController().signal,
  };
  const prepared = await tools.prepare(
    {
      id: crypto.randomUUID(),
      name: "call_dynamic_tool",
      input: { namespace: "frockbot", toolName: name, arguments: input },
    },
    context,
  );
  if (prepared.kind !== "ready") throw new Error("tool was denied");
  return tools.executePrepared(prepared, context);
}

describe("Package Publisher Agent contribution", () => {
  test("lets any Bot list, publish, and roll back its User's shared setup", async () => {
    const commands: unknown[] = [];
    const executedCommands: string[] = [];
    const active = (commandId: string): PackagePublicationReceiptV1 => ({
      schemaVersion: 1,
      commandId,
      status: "active",
      revision: 2,
      packageRevision: 1,
      applicationHash: "sha256:one",
    });
    const harness = await createPluginHarness([
      ComputerRegistry,
      SystemPromptRegistry,
      ToolRegistry,
    ]);
    const provider: ComputerProvider = {
      id: "fixture",
      open: (identity, tenant, assignment) =>
        Promise.resolve({
          assignment,
          identity,
          tenant,
          exec: {
            execute: (request) => {
              const command = (request.args ?? []).join(" ");
              executedCommands.push(command);
              const content = command.includes("archive --format=tar")
                ? "source snapshot"
                : "application artifact";
              return Promise.resolve({
                exitCode: 0,
                stdout: new TextEncoder().encode(content),
                stderr: new Uint8Array(),
                outputTruncated: false,
              });
            },
          },
          close: () => Promise.resolve(),
        }),
    };
    harness.root.computers.register(provider);
    const fiber = await harness.mount(
      createPackagePublisherAgentPlugin(
        {
          read: () => Promise.resolve(history),
          publish: (command) => {
            commands.push(command);
            return Promise.resolve(active(command.commandId));
          },
          rollback: (command) => {
            commands.push(command);
            return Promise.resolve(active(command.commandId));
          },
        },
        {
          userId: "user-1",
          defaultProviderId: "fixture",
        },
      ),
    );

    expect(
      harness.root.tools.schemas({ turnType: "chat" }).map((tool) => tool.name),
    ).toEqual(["get_dynamic_tools", "call_dynamic_tool"]);
    expect(
      JSON.parse(
        (await execute(harness.root.tools, "list_setup_revisions", {})).content,
      ),
    ).toEqual(history);
    await execute(harness.root.tools, "publish_setup", {
      checks: [{ name: "test", status: "passed" }],
    });
    await execute(harness.root.tools, "rollback_setup", {
      packageRevision: 1,
    });
    expect(commands).toHaveLength(2);
    expect(executedCommands[0]).toContain("git -C /home/box/setup init");
    expect(executedCommands.slice(1)).toHaveLength(2);
    expect(commands[0]).toMatchObject({
      expectedRevision: 1,
      candidate: {
        source: "source snapshot",
        applicationArtifact: "application artifact",
      },
    });
    expect(commands[1]).toMatchObject({
      expectedRevision: 1,
      packageRevision: 1,
    });

    await fiber.dispose();
    expect(
      harness.root.tools.schemas({ turnType: "chat" }).map((tool) => tool.name),
    ).toEqual(["get_dynamic_tools", "call_dynamic_tool"]);
    await harness.dispose();
  });

  // A deployment with no Computer registers no Computer tool, so a prompt that
  // still promises one sends the model hunting for a sandbox it cannot reach.
  test("promises no Computer when the deployment has none", async () => {
    const harness = await createPluginHarness([
      ComputerRegistry,
      SystemPromptRegistry,
      ToolRegistry,
    ]);
    const fiber = await harness.mount(
      createPackagePublisherAgentPlugin(
        {
          read: () => Promise.resolve(history),
          publish: () => {
            throw new Error("not called");
          },
          rollback: () => {
            throw new Error("not called");
          },
        },
        {
          userId: "user-1",
          defaultProviderId: "fixture",
          configured: false,
        },
      ),
    );
    const prompt = await harness.root.systemPrompt.assemble({
      sessionId: "session-1",
      provider: "fixture",
      model: "fixture",
      turnType: "chat",
    });
    expect(prompt.text).not.toContain("Computer");
    expect(prompt.text).not.toContain("/home/box");
    // The Package Publisher still says what it does; only the Computer
    // sentence goes.
    expect(prompt.text).toContain("publish_setup");
    await fiber.dispose();
    await harness.dispose();
  });

  test("keeps the Computer sentence when a Computer is configured", async () => {
    const harness = await createPluginHarness([
      ComputerRegistry,
      SystemPromptRegistry,
      ToolRegistry,
    ]);
    const fiber = await harness.mount(
      createPackagePublisherAgentPlugin(
        {
          read: () => Promise.resolve(history),
          publish: () => {
            throw new Error("not called");
          },
          rollback: () => {
            throw new Error("not called");
          },
        },
        { userId: "user-1", defaultProviderId: "fixture" },
      ),
    );
    const prompt = await harness.root.systemPrompt.assemble({
      sessionId: "session-1",
      provider: "fixture",
      model: "fixture",
      turnType: "chat",
    });
    expect(prompt.text).toContain("/home/box/setup using the Computer");
    await fiber.dispose();
    await harness.dispose();
  });

  test("satisfies built-in Package conventions", () => {
    expect(verifyPluginPackage({ packageJson, manifest })).toMatchObject({
      name: "@frockbot/plugin-package-publisher",
      contributionKinds: ["backend", "runtime", "client"],
    });
  });
});
