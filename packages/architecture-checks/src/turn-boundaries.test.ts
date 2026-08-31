// Constitution — Architecture checks: "a Turn that does not use the Computer
// makes no Computer interface call" and "a Skill written outside the Bot's own
// authority is not loaded as an instruction".
import { describe, expect, test } from "bun:test";
import {
  ComputerRegistry,
  type ComputerProvider,
} from "@frockbot/computer-core";
import { AgentRegistry } from "@frockbot/kernel-agent-loop/agent";
import { AgentLoop } from "@frockbot/kernel-agent-loop";
import {
  SessionStore,
  type LlmProvider,
  type NormalizedModelRequest,
  type ToolDefinition,
} from "@frockbot/kernel-contracts";
import { createComputerAgentPlugin } from "@frockbot/plugin-computer/agent";
import { LlmRegistry } from "@frockbot/plugin-models";
import { SystemPromptRegistry } from "@frockbot/plugin-prompt";
import {
  botInstructionRootV1,
  createSkillsRuntimePlugin,
} from "@frockbot/plugin-skills";
import { FakeWorkspace, skillMarkdown } from "@frockbot/plugin-skills/testing";
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
      open: (identity, tenant, assignment) => {
        computerCalls.push(`open:${identity.userId}:${tenant.botId}`);
        return Promise.resolve({
          assignment,
          identity,
          tenant,
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

  test(
    "a Skill written outside the Bot's own authority is not loaded as an instruction — " +
      '"The kernel treats every Workspace file as data. Only Skills under the ' +
      "Bot's own instruction root, written under the Bot's own authority or its " +
      "User's, are loaded as instructions.\"",
    async () => {
      // Five candidates sit in the Workspace, all named SKILL.md, all parsing.
      // Two are the Bot's own authority; three are not. A sixth sits under the
      // Bot's own *Memory* root, which is not an instruction root at all.
      const owner = { userId: "user-1", botId: "bot-1" };
      const ownRoot = botInstructionRootV1(owner);
      const botWriter = {
        kind: "bot" as const,
        botId: "bot-1",
        sessionId: "user-1:bot-1",
        turnId: "turn-1",
        runId: "run-1",
      };
      const workspace = await FakeWorkspace.seeded([
        {
          root: ownRoot,
          path: "skills/own-bot/SKILL.md",
          text: skillMarkdown(
            "own-bot",
            "Use this when the Bot itself wrote the Skill.",
            "OWN-BOT-BODY",
          ),
          writer: botWriter,
        },
        {
          root: ownRoot,
          path: "skills/own-user/SKILL.md",
          text: skillMarkdown(
            "own-user",
            "Use this when the Bot's User wrote the Skill.",
            "OWN-USER-BODY",
          ),
          writer: { kind: "user", userId: "user-1" },
        },
        {
          root: ownRoot,
          path: "skills/first-party/SKILL.md",
          text: skillMarkdown(
            "first-party-skill",
            "PACKAGE-INSTRUCTION",
            "PACKAGE-BODY",
          ),
          writer: { kind: "first-party", packageId: "memory" },
        },
        {
          root: ownRoot,
          path: "skills/other-bot/SKILL.md",
          text: skillMarkdown(
            "other-bot-skill",
            "OTHER-BOT-INSTRUCTION",
            "OTHER-BOT-BODY",
          ),
          writer: { ...botWriter, botId: "bot-2" },
        },
        {
          root: ownRoot,
          path: "skills/other-user/SKILL.md",
          text: skillMarkdown(
            "other-user-skill",
            "OTHER-USER-INSTRUCTION",
            "OTHER-USER-BODY",
          ),
          writer: { kind: "user", userId: "user-2" },
        },
        {
          root: { kind: "bot-memory", userId: "user-1", botId: "bot-1" },
          path: "skills/memory-root/SKILL.md",
          text: skillMarkdown(
            "memory-root-skill",
            "MEMORY-ROOT-INSTRUCTION",
            "MEMORY-ROOT-BODY",
          ),
          writer: botWriter,
        },
      ]);

      const requests: NormalizedModelRequest[] = [];
      const model: LlmProvider = {
        id: "skill-reader",
        async *stream(request) {
          requests.push(request);
          yield { type: "text-delta", text: "read" };
          yield { type: "finish", reason: "completed" };
        },
      };

      const root = new Context();
      await root.plugin(SessionStore, {});
      await root.plugin(SystemPromptRegistry);
      await root.plugin(LlmRegistry);
      await root.plugin(ToolRegistry);
      await root.plugin(AgentRegistry);
      const providerPlugin: Plugin.Function = (ctx) => ctx.llm.register(model);
      providerPlugin.inject = ["llm"];
      await root.plugin(providerPlugin);
      await root.plugin(
        createSkillsRuntimePlugin({
          owner,
          reads: workspace,
          files: workspace,
          writer: {
            sessionId: "user-1:bot-1",
            turnId: "turn-1",
            runId: "run-1",
          },
        }),
      );
      await root.plugin(AgentLoop, { maxSteps: 2, composition: COMPOSITION });

      const handle = await root.agents.create({
        botId: "bot-1",
        sessionId: "user-1:bot-1",
        provider: model.id,
        model: "test-model",
      });
      handle.agent.send("What Skills do you have?");
      await handle.agent.whenIdle();

      const system = requests.at(0)?.system ?? "";
      expect(system).toContain("<agent_skills>");
      expect(system).toContain("skills/own-bot/SKILL.md");
      expect(system).toContain("skills/own-user/SKILL.md");
      // The refused four reach the model in no form at all: not their paths,
      // not their descriptions, not their bodies.
      for (const forbidden of [
        "PACKAGE-INSTRUCTION",
        "OTHER-BOT-INSTRUCTION",
        "OTHER-USER-INSTRUCTION",
        "MEMORY-ROOT-INSTRUCTION",
        "skills/first-party/SKILL.md",
        "skills/other-bot/SKILL.md",
        "skills/other-user/SKILL.md",
        "skills/memory-root/SKILL.md",
      ]) {
        expect(system).not.toContain(forbidden);
      }
      // Nor through the on-demand disclosure tool.
      const disclosure = await root.tools.executePrepared(
        {
          kind: "ready",
          call: {
            id: "call-1",
            name: "skill_load",
            input: { path: "skills/other-bot/SKILL.md" },
          },
          idempotent: true,
        },
        {
          botId: "bot-1",
          agentId: handle.agent.id,
          sessionId: "user-1:bot-1",
          compositionGenerationId: COMPOSITION.generationId,
          signal: new AbortController().signal,
        },
      );
      expect(disclosure.isError).toBe(true);
      expect(disclosure.content).not.toContain("OTHER-BOT-BODY");

      // The injection is visible in durable state, refusals included.
      const injected = handle.agent.session.events.find(
        (event) => event.type === "skill/injected",
      );
      expect(injected).toMatchObject({ type: "skill/injected", turn: 1 });
      if (injected?.type !== "skill/injected") throw new Error("unreachable");
      expect(injected.skills.map((skill) => skill.path)).toEqual([
        "skills/own-bot/SKILL.md",
        "skills/own-user/SKILL.md",
      ]);
      expect(injected.refusals.map((refusal) => refusal.path)).toEqual([
        "skills/first-party/SKILL.md",
        "skills/other-bot/SKILL.md",
        "skills/other-user/SKILL.md",
      ]);
      expect(
        injected.refusals.every((refusal) =>
          refusal.reason.startsWith("authority:"),
        ),
      ).toBe(true);

      await root.fiber.dispose();
    },
  );
});
