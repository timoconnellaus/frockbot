// The two Plugin tools that put an approval card in the conversation. A card
// is read in the position it landed in, so neither may race another such
// effect dispatched beside it in one `batch`.
import { expect, test } from "bun:test";
import type {
  PluginApprovalAskV1,
  PluginAuthoringHostV1,
} from "./authoring.js";
import type { ToolCall, ToolExecutionContext } from "@frockbot/core/contracts";
import { createAgentRuntimeHarness } from "@frockbot/app/testkit";
import { pluginTools } from "./feature.js";

const SESSION = "user:plugins";

const ask = (approvalId: string): PluginApprovalAskV1 => ({
  approvalId,
  action: "Run the Plugin demo",
  rationale: "The Bot built this Plugin and asks to run it.",
  risk: "high",
  replayed: false,
});

/** Runs one Plugin tool against an open step and reports what it appended. */
async function runPluginTool(name: string, effectId: string) {
  const harness = createAgentRuntimeHarness();
  const session = harness.sessions.create(SESSION);
  session.append({ type: "turn/start", turn: 1 });
  session.append({ type: "step/start", turn: 1, step: 1 });
  session.append({
    type: "tool/call",
    turn: 1,
    step: 1,
    occurrenceId: effectId,
    name,
    input: { pluginId: "demo" },
  });
  await session.flush();
  const host = {
    plugins: {
      publish: async (_input: { pluginId: string }, id: string) => ({
        status: "pending-approval" as const,
        pluginId: "demo",
        ask: ask(id.replaceAll(":", ".")),
      }),
      enable: async (_input: { pluginId: string }, id: string) => ({
        status: "pending-approval" as const,
        pluginId: "demo",
        ask: ask(id.replaceAll(":", ".")),
      }),
      list: async () => [],
    } as unknown as PluginAuthoringHostV1,
    turn: { sessionId: SESSION, runId: "run-1", turnId: "run-1" },
  };
  for (const definition of pluginTools(host, harness.sessions)) {
    harness.tools.register(definition);
  }
  const call: ToolCall = {
    id: "call-1",
    name,
    input: { pluginId: "demo" },
  };
  const context: ToolExecutionContext = {
    botId: "bot",
    agentId: "agent",
    sessionId: SESSION,
    compositionGenerationId: "1970-01-01T00:00:00.000Z:0123456789abcdef",
    effectId,
    toolCall: call,
    turnType: "chat",
    signal: new AbortController().signal,
  };
  const preparation = await harness.tools.prepare(call, context);
  if (preparation.kind !== "ready") {
    throw new Error(`${name} was denied: ${preparation.result.content}`);
  }
  const result = await harness.tools.executePrepared(preparation, context);
  const ordered = harness.tools.orderedEffect(call);
  // The harness reads the journal back on dispose and fails a tool that
  // appended a card without declaring the ordering, so this closes the run
  // rather than leaking it.
  await harness.dispose();
  return { result, ordered, events: [...session.activeRunJournal] };
}

for (const name of ["plugin_publish", "plugin_enable"]) {
  test(`${name} puts its card in the conversation as an ordered effect`, async () => {
    const effectId = "tool:1:1:0";
    const { result, ordered, events } = await runPluginTool(name, effectId);
    expect(result.isError).toBe(false);
    expect(
      events.filter((event) => event.type === "send/to-user"),
    ).toMatchObject([
      {
        occurrenceId: effectId,
        payload: { type: "approval", approvalId: "tool.1.1.0" },
      },
    ]);
    expect(ordered).toBe(true);
  });
}
