import { afterEach, describe, expect, test } from "bun:test";
import {
  AgentRegistry,
  type AgentOptions,
  LlmRegistry,
  type LlmProvider,
  SessionStore,
  SystemPromptRegistry,
  ToolRegistry,
  type ToolDefinition,
} from "@frockbot/agent-core";
import { Context, type Plugin } from "cordis";
import { AgentLoop } from "./index.js";

const roots: Context[] = [];

async function mountRuntime(
  provider: LlmProvider,
  tool?: ToolDefinition,
): Promise<Context> {
  const root = new Context();
  roots.push(root);
  await root.plugin(SessionStore);
  await root.plugin(SystemPromptRegistry);
  await root.plugin(LlmRegistry);
  await root.plugin(ToolRegistry);
  await root.plugin(AgentRegistry);

  const promptPlugin: Plugin.Function = (ctx) =>
    ctx.systemPrompt.register({
      id: "identity",
      render: () => "You are the FrockBot test agent.",
    });
  promptPlugin.inject = ["systemPrompt"];
  const providerPlugin: Plugin.Function = (ctx) => ctx.llm.register(provider);
  providerPlugin.inject = ["llm"];
  await root.plugin(promptPlugin);
  await root.plugin(providerPlugin);

  if (tool) {
    const toolPlugin: Plugin.Function = (ctx) => ctx.tools.register(tool);
    toolPlugin.inject = ["tools"];
    await root.plugin(toolPlugin);
  }
  await root.plugin(AgentLoop, { maxSteps: 4 });
  return root;
}

async function eventually(
  assertion: () => void,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let latestError: unknown;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch (error) {
      latestError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw latestError;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => root.fiber.dispose()));
});

describe("AgentLoop", () => {
  test("streams, journals a tool before execution, and repeats the model step", async () => {
    const requests: string[] = [];
    let toolWasJournaled = false;
    let turnStoppingSawCompletedJournal = false;
    let observedPromptSessionId: string | undefined;
    let observedToolIdentity:
      { botId: string; agentId: string; sessionId: string } | undefined;
    let root: Context;
    const provider: LlmProvider = {
      id: "scripted",
      async *stream(request) {
        requests.push(request.requestId);
        if (requests.length === 1) {
          yield { type: "text-delta", text: "Checking. " };
          yield {
            type: "tool-call",
            call: { id: "call-1", name: "echo", input: { value: "hello" } },
          };
          yield { type: "finish", reason: "tool-calls" };
          return;
        }
        const result = request.messages.findLast(
          (message) => message.role === "tool",
        );
        yield {
          type: "text-delta",
          text: `Tool returned ${result?.role === "tool" ? result.content : "nothing"}.`,
        };
        yield { type: "finish", reason: "completed" };
      },
    };
    const tool: ToolDefinition = {
      name: "echo",
      description: "Return a supplied value.",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      },
      validate: (input) =>
        typeof input === "object" &&
        input !== null &&
        typeof (input as { value?: unknown }).value === "string",
      async execute(input, context) {
        const session = root.agents.get("general")?.session;
        toolWasJournaled = session?.events.at(-1)?.type === "tool/call";
        const identifiedContext = context as typeof context & {
          agentId: string;
        };
        observedToolIdentity = {
          botId: context.botId,
          agentId: identifiedContext.agentId,
          sessionId: context.sessionId,
        };
        return {
          content: (input as { value: string }).value,
          isError: false,
        };
      },
    };

    root = await mountRuntime(provider, tool);
    root.systemPrompt.register({
      id: "session-observer",
      render: (context) => {
        observedPromptSessionId = context.sessionId;
        return "";
      },
    });
    root.on("agent/turn-stopping", (agent) => {
      turnStoppingSawCompletedJournal =
        agent.session.events.at(-1)?.type === "turn/end";
      return Promise.resolve();
    });
    const agentOptions: AgentOptions & { agentId: string } = {
      botId: "general-bot",
      agentId: "general",
      sessionId: "owner:general:conversation-1",
      provider: "scripted",
      model: "test-model",
    };
    const handle = await root.agents.create(agentOptions);
    handle.agent.send("Use the echo tool.");
    await handle.agent.whenIdle();

    const events = handle.agent.session.events;
    expect(requests).toHaveLength(2);
    expect(toolWasJournaled).toBe(true);
    expect(turnStoppingSawCompletedJournal).toBe(true);
    expect(handle.agent.id).toBe("general");
    expect(handle.agent.botId).toBe("general-bot");
    expect(handle.agent.session.id).toBe("owner:general:conversation-1");
    expect(observedPromptSessionId).toBe("owner:general:conversation-1");
    expect(observedToolIdentity).toEqual({
      botId: "general-bot",
      agentId: "general",
      sessionId: "owner:general:conversation-1",
    });
    expect(events.filter((event) => event.type === "step/start")).toHaveLength(
      2,
    );
    expect(events.filter((event) => event.type === "step/end")).toHaveLength(2);
    expect(events.filter((event) => event.type === "turn/start")).toHaveLength(
      1,
    );
    expect(events.filter((event) => event.type === "turn/end")).toHaveLength(1);
    expect(
      events.find((event) => event.type === "model/request"),
    ).toMatchObject({
      request: {
        provider: "scripted",
        model: "test-model",
        system: "You are the FrockBot test agent.",
        tools: [{ name: "echo" }],
      },
    });
    expect(events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "completed",
    });
    expect(handle.agent.session.deriveMessages().at(-1)).toMatchObject({
      role: "assistant",
      content: "Tool returned hello.",
    });

    const session = handle.agent.session;
    await handle.dispose();
    expect(root.agents.list()).toEqual([]);
    expect(session.events.at(-1)?.type).toBe("session/disposed");
  });

  test("cancels an active stream and closes its step and turn", async () => {
    const provider: LlmProvider = {
      id: "blocking",
      async *stream(_request, signal) {
        await new Promise<void>((_resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
        yield { type: "finish", reason: "completed" };
      },
    };
    const root = await mountRuntime(provider);
    const handle = await root.agents.create({
      botId: "bot-2",
      sessionId: "agent-2",
      provider: "blocking",
      model: "test-model",
    });

    handle.agent.send("Wait forever.");
    await eventually(() =>
      expect(
        handle.agent.session.events.some(
          (event) => event.type === "model/request",
        ),
      ).toBe(true),
    );
    handle.agent.cancel();
    await handle.agent.whenIdle();

    const stepEnds = handle.agent.session.events.filter(
      (event) => event.type === "step/end",
    );
    const turnEnds = handle.agent.session.events.filter(
      (event) => event.type === "turn/end",
    );
    expect(stepEnds).toHaveLength(1);
    expect(turnEnds).toHaveLength(1);
    expect(stepEnds[0]).toMatchObject({ outcome: "cancelled" });
    expect(turnEnds[0]).toMatchObject({ outcome: "cancelled" });
  });
});
