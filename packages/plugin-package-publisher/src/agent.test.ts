import { describe, expect, test } from "bun:test";
import { SystemPromptRegistry, ToolRegistry } from "@frockbot/agent-core";
import { ComputerRegistry } from "@frockbot/computer-core";
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
  tools: ToolRegistry,
  name: string,
  input: unknown,
): Promise<{ content: string; isError: boolean }> {
  const controller = new AbortController();
  const prepared = await tools.prepare(
    { id: crypto.randomUUID(), name, input },
    {
      botId: "bot-1",
      agentId: "bot-1",
      sessionId: "session-1",
      signal: controller.signal,
    },
  );
  if (prepared.kind !== "ready") throw new Error("tool was denied");
  return tools.executePrepared(prepared, {
    botId: "bot-1",
    agentId: "bot-1",
    sessionId: "session-1",
    signal: controller.signal,
  });
}

describe("Package Publisher Agent contribution", () => {
  test("lets any Bot list, publish, and roll back its User's shared setup", async () => {
    const commands: unknown[] = [];
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
    harness.root.computers.register({
      id: "fixture",
      open: (_target, assignment) =>
        Promise.resolve({
          assignment,
          exec: {
            execute: (request) => {
              const command = (request.args ?? []).join(" ");
              const content = command.includes("git -C")
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
    });
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

    expect(harness.root.tools.schemas().map((tool) => tool.name)).toEqual([
      "list_setup_revisions",
      "publish_setup",
      "rollback_setup",
    ]);
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
    expect(harness.root.tools.schemas()).toEqual([]);
    await harness.dispose();
  });

  test("satisfies built-in Package conventions", () => {
    expect(verifyPluginPackage({ packageJson, manifest })).toMatchObject({
      name: "@frockbot/plugin-package-publisher",
      contributionKinds: ["backend", "runtime", "client"],
    });
  });
});
