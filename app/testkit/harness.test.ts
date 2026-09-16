// The harness's own guard: a tool whose effect takes a position in the
// conversation has to declare `orderedEffect`, and the harness every feature
// test already uses is what notices when one does not. It reads the journal
// back after the run rather than watching dispatch, so what it checks is
// exactly what the durable log says happened.
import { expect, test } from "bun:test";
import type {
  ToolDefinition,
  ToolExecutionContext,
} from "@frockbot/core/contracts";
import { createAgentRuntimeHarness } from "./harness.js";

const SESSION = "user:guard";
const EFFECT = "tool:1:1:0";

/** A tool that puts a bubble on the log under its own effect id. */
function sender(orderedEffect: boolean): ToolDefinition {
  return {
    name: "speak",
    description: "Appends a bubble.",
    inputSchema: { type: "object" },
    ...(orderedEffect ? { orderedEffect: true } : {}),
    execute: async () => ({ content: "said", isError: false }),
  };
}

async function runTool(definition: ToolDefinition, append: boolean) {
  const harness = createAgentRuntimeHarness();
  const session = harness.sessions.create(SESSION);
  harness.tools.register({
    ...definition,
    execute: async (_input, context) => {
      if (append) {
        session.append({
          type: "send/to-user",
          turn: 1,
          step: 1,
          occurrenceId: context.effectId,
          payload: { type: "text", text: "hello" },
        });
        await session.flush();
      }
      return { content: "said", isError: false };
    },
  });
  const call = { id: "call-1", name: definition.name, input: {} };
  const context: ToolExecutionContext = {
    botId: "bot",
    agentId: "agent",
    sessionId: SESSION,
    compositionGenerationId: "1970-01-01T00:00:00.000Z:0123456789abcdef",
    effectId: EFFECT,
    toolCall: call,
    turnType: "chat",
    signal: new AbortController().signal,
  };
  // What the loop journals before it dispatches: the guard reads the tool
  // name off this row to decide which definition owned the append.
  session.append({
    type: "tool/call",
    turn: 1,
    step: 1,
    occurrenceId: EFFECT,
    name: call.name,
    input: call.input,
  });
  await session.flush();
  const preparation = await harness.tools.prepare(call, context);
  if (preparation.kind !== "ready") throw new Error("the call was denied");
  await harness.tools.executePrepared(preparation, context);
  return harness;
}

test("a tool that appends a conversation-positioned event undeclared fails the harness", async () => {
  const harness = await runTool(sender(false), true);
  await expect(harness.dispose()).rejects.toThrow(/orderedEffect/);
});

test("declaring the ordering clears the same tool", async () => {
  const harness = await runTool(sender(true), true);
  await harness.dispose();
});

test("a tool that appends nothing needs no declaration", async () => {
  const harness = await runTool(sender(false), false);
  await harness.dispose();
});
