// Constitution — Architecture checks: "Memory is readable and writable with no
// Computer interface call".
//
// The Computer is assigned and its tools are mounted, so the Turn *could*
// reach it. Every entry point of the provider-neutral Computer interface
// records itself, and a whole Memory cycle — write, read, inject, forget —
// runs through the Memory Package. The check is that not one of those
// recordings happens.
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
} from "@frockbot/kernel-contracts";
import { createComputerAgentPlugin } from "@frockbot/plugin-computer/agent";
import {
  botMemoryRootV1,
  createMemoryRuntimePlugin,
  createTestMemoryFilesV1,
  MemoryStore,
  userMemoryRootV1,
} from "@frockbot/plugin-memory";
import { LlmRegistry } from "@frockbot/plugin-models";
import { SystemPromptRegistry } from "@frockbot/plugin-prompt";
import { ToolRegistry } from "@frockbot/plugin-tools";
import { Context, type Plugin } from "cordis";

const COMPOSITION = {
  generationId: "1970-01-01T00:00:00.000Z:0123456789abcdef",
  artifactSetHash: "a".repeat(64),
};

describe("Memory boundaries", () => {
  test("Memory is readable and writable with no Computer interface call", async () => {
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

    const owner = { userId: "user-1", botId: "bot-1" };
    const files = createTestMemoryFilesV1({ userId: owner.userId });
    const store = new MemoryStore({ files, owner });
    const writer = {
      kind: "bot" as const,
      botId: owner.botId,
      sessionId: "user-1:bot-1",
      turnId: "turn-0",
      runId: "run-0",
    };

    // WRITE — the Bot's own root and its shard of the shared User root.
    expect(
      (
        await store.write({
          root: botMemoryRootV1(owner),
          tier: "profile",
          fact: "Tim prefers blunt answers.",
          writer,
        })
      ).status,
    ).toBe("ok");
    expect(
      (
        await store.write({
          root: userMemoryRootV1(owner),
          tier: "log",
          fact: "The gym build starts in spring.",
          writer,
        })
      ).status,
    ).toBe("ok");

    // READ — both tiers, merged.
    expect((await store.read(botMemoryRootV1(owner))).profile).toHaveLength(1);
    expect((await store.read(userMemoryRootV1(owner))).recent).toHaveLength(1);

    const requests: NormalizedModelRequest[] = [];
    const model: LlmProvider = {
      id: "memory-reader",
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
    await root.plugin(ComputerRegistry);
    await root.plugin(AgentRegistry);
    const providerPlugin: Plugin.Function = (ctx) => {
      const disposeModel = ctx.llm.register(model);
      const disposeComputer = ctx.computers.register(provider);
      return () => {
        disposeComputer();
        disposeModel();
      };
    };
    providerPlugin.inject = ["llm", "computers"];
    await root.plugin(providerPlugin);
    await root.plugin(
      createComputerAgentPlugin({
        userId: owner.userId,
        defaultProviderId: "recording",
      }),
    );
    await root.plugin(
      createMemoryRuntimePlugin({
        owner,
        store,
        writer: { sessionId: "user-1:bot-1", turnId: "turn-1", runId: "run-1" },
      }),
    );
    await root.plugin(AgentLoop, { maxSteps: 2, composition: COMPOSITION });

    // The Computer tools really are mounted: this Turn simply never uses them.
    expect(root.tools.schemas().map((schema) => schema.name)).toContain(
      "computer_exec",
    );
    expect(root.tools.schemas().map((schema) => schema.name)).toEqual(
      expect.arrayContaining([
        "memory_write",
        "memory_forget",
        "memory_search",
        "memory_rebuild_index",
      ]),
    );

    const handle = await root.agents.create({
      botId: owner.botId,
      sessionId: "user-1:bot-1",
      provider: model.id,
      model: "test-model",
      admitEffect: () => Promise.resolve(true),
    });
    handle.agent.send("What do you remember?");
    await handle.agent.whenIdle();

    // INJECT — both tiers reached the model request, in GrokBot's shape.
    const system = requests.at(0)?.system ?? "";
    expect(system).toContain("User memory:");
    expect(system).toContain("Memory:");
    expect(system).toContain("Tim prefers blunt answers.");
    expect(system).toContain("[via bot-1] The gym build starts in spring.");

    // …and it is recorded in durable state, generations included.
    const injected = handle.agent.session.events.find(
      (event) => event.type === "memory/injected",
    );
    if (injected?.type !== "memory/injected") throw new Error("unreachable");
    expect(injected.facts.map((fact) => fact.text).sort()).toEqual([
      "The gym build starts in spring.",
      "Tim prefers blunt answers.",
    ]);
    expect(injected.sources.every((source) => source.generationId)).toBe(true);

    // FORGET — the last leg of the cycle, still with no Computer.
    expect(
      (
        await store.forget({
          root: botMemoryRootV1(owner),
          fact: "Tim prefers blunt answers.",
          writer,
        })
      ).status,
    ).toBe("ok");

    expect(computerCalls).toEqual([]);
    await root.fiber.dispose();
  });
});
