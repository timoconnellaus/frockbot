// The `batch` meta-tool: what it dispatches, what it keys each call on, and
// what it refuses.
import { describe, expect, test } from "bun:test";
import { LoopHookListV1 } from "@frockbot/core/contracts";
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
} from "@frockbot/core/contracts";
import { BATCH_MAX_CALLS_V1, BATCH_TOOL_NAME, ToolRegistry } from "./tools.js";

const CONTEXT: ToolExecutionContext = {
  botId: "primary",
  agentId: "primary",
  sessionId: "alice:primary",
  compositionGenerationId: "test-composition-generation",
  effectId: "tool:1:1:0",
  toolCall: { id: "provider-call", name: BATCH_TOOL_NAME, input: {} },
  turnType: "chat",
  signal: new AbortController().signal,
};

function registry(...definitions: ToolDefinition[]): ToolRegistry {
  const tools = new ToolRegistry(new LoopHookListV1());
  for (const definition of definitions) tools.register(definition);
  return tools;
}

async function runBatch(
  tools: ToolRegistry,
  calls: unknown,
): Promise<ToolExecutionResult> {
  const call = { id: "provider-call", name: BATCH_TOOL_NAME, input: { calls } };
  const preparation = await tools.prepare(call, CONTEXT);
  if (preparation.kind === "denied") return preparation.result;
  return tools.executePrepared(preparation, { ...CONTEXT, toolCall: call });
}

/** A tool that records the effect id every call ran under. */
function recorder(name: string, effects: string[]): ToolDefinition {
  return {
    name,
    description: `${name} fixture.`,
    inputSchema: { type: "object" },
    execute: (input, context) => {
      effects.push(context.effectId);
      return Promise.resolve({
        content: `${name}:${JSON.stringify(input)}`,
        isError: false,
      });
    },
  };
}

/** A tool whose dispatch throws, so the caller cannot see whether it ran. */
function thrower(name: string, idempotent: boolean): ToolDefinition {
  return {
    name,
    description: `${name} fixture.`,
    inputSchema: { type: "object" },
    idempotent,
    execute: () => Promise.reject(new Error("fetch failed")),
  };
}

describe("batch", () => {
  test("is offered to the model as a native tool", () => {
    const names = registry()
      .schemas({ turnType: "chat" })
      .map((schema) => schema.name);

    expect(names).toContain(BATCH_TOOL_NAME);
  });

  test("gives every call its own effect id, derived from its declared position", async () => {
    const effects: string[] = [];
    const tools = registry(recorder("alpha", effects));

    const result = await runBatch(tools, [
      { tool: "alpha", arguments: { n: 1 } },
      { tool: "alpha", arguments: { n: 2 } },
      { tool: "alpha", arguments: { n: 3 } },
    ]);

    // A dot, not a colon: an approval id may not carry a colon. Sharing one
    // id would let the journal and every effect-keyed tool collapse three
    // calls into one.
    expect([...effects].sort()).toEqual([
      "tool:1:1:0.0",
      "tool:1:1:0.1",
      "tool:1:1:0.2",
    ]);
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toMatchObject({ ran: 3, failed: 0 });
  });

  test("one failing call does not stop the others", async () => {
    const effects: string[] = [];
    const tools = registry(recorder("alpha", effects), {
      name: "explodes",
      description: "Throws.",
      inputSchema: { type: "object" },
      execute: () => Promise.reject(new Error("the bucket went away")),
    });

    const result = await runBatch(tools, [
      { tool: "alpha", arguments: {} },
      { tool: "explodes", arguments: {} },
      { tool: "alpha", arguments: {} },
    ]);

    const report = JSON.parse(result.content) as {
      ran: number;
      failed: number;
      results: Array<{ index: number; isError: boolean; content: string }>;
    };
    expect(report.ran).toBe(3);
    expect(report.failed).toBe(1);
    expect(report.results[1]).toMatchObject({
      index: 1,
      isError: true,
      content:
        "the bucket went away (the loop cannot tell whether this call took effect)",
    });
    expect(effects.length).toBe(2);
  });

  test("reports an unknown tool as that call's failure, not the batch's", async () => {
    const result = await runBatch(registry(), [
      { tool: "no_such_tool", arguments: {} },
    ]);

    const report = JSON.parse(result.content) as {
      failed: number;
      results: Array<{ isError: boolean }>;
    };
    expect(result.isError).toBe(false);
    expect(report.failed).toBe(1);
    expect(report.results[0]?.isError).toBe(true);
  });

  test("refuses to call itself", async () => {
    const result = await runBatch(registry(), [
      { tool: BATCH_TOOL_NAME, arguments: { calls: [] } },
    ]);

    const report = JSON.parse(result.content) as {
      results: Array<{ content: string }>;
    };
    expect(report.results[0]?.content).toBe("batch cannot call itself");
  });

  test("ends the Turn when any call inside it does", async () => {
    const tools = registry(recorder("alpha", []), {
      name: "finishes",
      description: "Ends the Turn.",
      inputSchema: { type: "object" },
      execute: () =>
        Promise.resolve({ content: "done", isError: false, endsTurn: true }),
    });

    const result = await runBatch(tools, [
      { tool: "alpha", arguments: {} },
      { tool: "finishes", arguments: {} },
    ]);

    // Without this a send_to_user with disposition "finish", a widget or an
    // approval inside a batch would silently fail to end the Turn.
    expect(result.endsTurn).toBe(true);
  });

  test("a structurally invalid call fails alone, and the rest still run", async () => {
    const effects: string[] = [];
    const tools = registry(recorder("alpha", effects));

    const result = await runBatch(tools, [
      { tool: "alpha", arguments: { n: 1 } },
      { tool: "alpha", arguments: { n: 2 } },
      { tool: "alpha", arguments: ["not an object"] },
    ]);

    // Losing two good calls because the third was malformed is exactly what
    // the batch exists to avoid, and the report names what was wrong with
    // that one call so the model repairs it rather than guessing.
    const report = JSON.parse(result.content) as {
      ran: number;
      failed: number;
      results: Array<{ index: number; isError: boolean; content: string }>;
    };
    expect(result.isError).toBe(false);
    expect(report).toMatchObject({ ran: 3, failed: 1 });
    expect(report.results[2]).toMatchObject({
      index: 2,
      isError: true,
      content: "batch call 2 was refused: its arguments must be an object",
    });
    expect(effects).toHaveLength(2);
  });

  test("a call missing its tool name fails alone", async () => {
    const effects: string[] = [];
    const tools = registry(recorder("alpha", effects));

    const result = await runBatch(tools, [
      { arguments: {} },
      { tool: "alpha", arguments: {} },
    ]);

    const report = JSON.parse(result.content) as {
      failed: number;
      results: Array<{ content: string }>;
    };
    expect(report.failed).toBe(1);
    expect(report.results[0]?.content).toBe(
      "batch call 0 was refused: it needs a tool name",
    );
    expect(effects).toEqual(["tool:1:1:0.1"]);
  });

  test("replaying a batch re-issues every call under the id it had before", async () => {
    // A sub-call gets no journal entry of its own, so a crash before the
    // batch's result is written replays every call in it. What stops that
    // sending the mail twice is the effect id: it comes from the declared
    // position, so the replay re-issues call N under the same key and a tool
    // honouring that key sees one effect. Deriving these ids from arrival
    // order would break replay silently.
    const keyed = (seen: string[]): ToolDefinition => ({
      name: "send_email",
      description: "Records the key each call ran under.",
      inputSchema: { type: "object" },
      execute: (input, context) => {
        seen.push(`${JSON.stringify(input)}@${context.effectId}`);
        return Promise.resolve({ content: "sent", isError: false });
      },
    });
    const first: string[] = [];
    const second: string[] = [];
    const calls = [
      { tool: "send_email", arguments: { to: "ada" } },
      { tool: "send_email", arguments: { to: "bob" } },
      { tool: "send_email", arguments: { to: "cleo" } },
    ];

    await runBatch(registry(keyed(first)), calls);
    await runBatch(registry(keyed(second)), calls);

    expect(first.sort()).toEqual([
      '{"to":"ada"}@tool:1:1:0.0',
      '{"to":"bob"}@tool:1:1:0.1',
      '{"to":"cleo"}@tool:1:1:0.2',
    ]);
    expect(second.sort()).toEqual(first);
  });

  test("refuses a batch past the declared bound, and an empty one", async () => {
    const tools = registry(recorder("alpha", []));
    const tooMany = Array.from({ length: BATCH_MAX_CALLS_V1 + 1 }, () => ({
      tool: "alpha",
      arguments: {},
    }));

    const over = await runBatch(tools, tooMany);
    const empty = await runBatch(tools, []);

    expect(over.isError).toBe(true);
    expect(over.content).toContain(String(BATCH_MAX_CALLS_V1));
    expect(empty.isError).toBe(true);
  });
});

describe("batch sub-call failures", () => {
  test("says a thrown non-idempotent call may still have taken effect", async () => {
    const tools = registry(
      thrower("send_email", false),
      thrower("read_inbox", true),
    );

    const result = await runBatch(tools, [
      { tool: "send_email", arguments: {} },
      { tool: "read_inbox", arguments: {} },
    ]);

    // The same sentence the loop gives a top-level throw: it is what the
    // model reads to decide whether retrying would send the mail twice.
    expect(JSON.parse(result.content as string).results).toEqual([
      {
        index: 0,
        tool: "send_email",
        isError: true,
        content:
          "fetch failed (the loop cannot tell whether this call took effect)",
      },
      { index: 1, tool: "read_inbox", isError: true, content: "fetch failed" },
    ]);
  });
});
