// Constitution — Architecture checks: "a Turn that does not use the Computer
// makes no Computer interface call" and "a Skill written outside the Bot's own
// authority is not loaded as an instruction".
import { describe, expect, it, test } from "bun:test";
import {
  ComputerRegistry,
  type ComputerProvider,
} from "@frockbot/computer-core";
import { AgentRegistry } from "@frockbot/kernel-agent-loop/agent";
import { AgentLoop } from "@frockbot/kernel-agent-loop";
import {
  SessionStore,
  type LlmProvider,
  type ToolDefinition,
} from "@frockbot/kernel-contracts";
import { createComputerAgentPlugin } from "@frockbot/plugin-computer/agent";
import { LlmRegistry } from "@frockbot/plugin-models";
import { SystemPromptRegistry } from "@frockbot/plugin-prompt";
import { ToolRegistry } from "@frockbot/plugin-tools";
import { Context, type Plugin } from "cordis";

const COMPOSITION = {
  generationId: "1970-01-01T00:00:00.000Z:0123456789abcdef",
  artifactSetHash: "a".repeat(64),
};

describe("Turn boundaries", () => {
  test("a Turn that does not use the Computer makes no Computer interface call", async () => {
    // Every entry point of the provider-neutral Computer interface records
    // itself. The Computer is assigned and its tools are mounted, so the Turn
    // *could* reach it; the check is that it does not.
    const computerCalls: string[] = [];
    const provider: ComputerProvider = {
      id: "recording",
      open: (target, assignment) => {
        computerCalls.push(`open:${target.userId}:${target.botId}`);
        return Promise.resolve({
          assignment,
          exec: {
            execute: () => {
              computerCalls.push("exec");
              return Promise.resolve({
                exitCode: 0,
                stdout: new Uint8Array(),
                stderr: new Uint8Array(),
                outputTruncated: false,
              });
            },
          },
          browser: {
            perform: () => {
              computerCalls.push("browser");
              return Promise.resolve({ accessibilitySnapshot: "" });
            },
          },
          close: () => Promise.resolve(),
        });
      },
    };

    const echo: ToolDefinition = {
      name: "echo",
      description: "Echo the input back.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      idempotent: true,
      execute: (input) =>
        Promise.resolve({
          content: String((input as { text: string }).text),
          isError: false,
        }),
    };

    let calledTool = false;
    const model: LlmProvider = {
      id: "computer-free",
      async *stream() {
        if (!calledTool) {
          calledTool = true;
          yield {
            type: "tool-call",
            call: {
              id: "call-1",
              name: "echo",
              input: { text: "no computer" },
            },
          };
          yield { type: "finish", reason: "tool-calls" };
          return;
        }
        yield { type: "text-delta", text: "done" };
        yield { type: "finish", reason: "completed" };
      },
    };

    const root = new Context();
    await root.plugin(SessionStore, {});
    await root.plugin(SystemPromptRegistry);
    await root.plugin(LlmRegistry);
    await root.plugin(ToolRegistry);
    await root.plugin(ComputerRegistry);
    await root.plugin(AgentRegistry);
    const providerPlugin: Plugin.Function = (ctx) => {
      const disposeModel = ctx.llm.register(model);
      const disposeTool = ctx.tools.register(echo);
      const disposeComputer = ctx.computers.register(provider);
      return () => {
        disposeComputer();
        disposeTool();
        disposeModel();
      };
    };
    providerPlugin.inject = ["llm", "tools", "computers"];
    await root.plugin(providerPlugin);
    await root.plugin(
      createComputerAgentPlugin({
        userId: "user-1",
        defaultProviderId: "recording",
      }),
    );
    await root.plugin(AgentLoop, { maxSteps: 4, composition: COMPOSITION });

    // The Computer tools really are mounted: this Turn declines them.
    expect(root.tools.schemas().map((schema) => schema.name)).toContain(
      "computer_exec",
    );

    const handle = await root.agents.create({
      botId: "bot-1",
      sessionId: "session-1",
      provider: model.id,
      model: "test-model",
    });
    handle.agent.send("Say something without the Computer");
    await handle.agent.whenIdle();

    expect(calledTool).toBe(true);
    expect(computerCalls).toEqual([]);
    await root.fiber.dispose();
  });

  // No Skills loader exists yet. This check is recorded, not invented: the
  // constitutional sentence it must prove is quoted verbatim.
  it.todo(
    "a Skill written outside the Bot's own authority is not loaded as an instruction — " +
      '"The kernel treats every Workspace file as data. Only Skills under the ' +
      "Bot's own instruction root, written under the Bot's own authority or its " +
      "User's, are loaded as instructions.\"",
    () => {
      // Intentionally unimplemented: there is no Skills loader to check yet.
    },
  );
});
