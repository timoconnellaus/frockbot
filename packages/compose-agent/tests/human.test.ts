import { describe, expect, it } from "bun:test";
import { createTool, deriveMessages, toolCallAction } from "../src";
import { buildAgent, kindsOf, watchLoop } from "./helpers/agent";
import { anyValidator, queryValidator } from "./helpers/validator";
import type { ToolCallInput, ToolOutcome } from "../src";

/** A tool a person presses, and the model may also call. */
const noteTool = createTool({
  name: "note",
  description: "Write a note",
  validator: queryValidator,
  execute: (args) => `noted ${args.query}`,
});

/** A tool that reports whether the call it was given can be cancelled. */
const abortTool = createTool({
  name: "abortable",
  description: "Report the signal it was handed",
  validator: anyValidator,
  execute: (_args, context) => context.signal.aborted,
});

describe("a tool a person invokes", () => {
  it("runs through the same action, so middleware sees a click and a model call alike", async () => {
    const seen: Array<ToolCallInput> = [];
    const { client, agent } = await buildAgent({
      tools: [noteTool],
      script: [
        { toolCalls: [{ name: "note", args: { query: "from the model" } }] },
        { chunks: ["done"] },
      ],
    });
    client.use(
      toolCallAction,
      ({ input, next }) => {
        seen.push(input);
        return next(input);
      },
      { first: true },
    );

    const pressed = await agent.invoke("note", { query: "from a person" });
    agent.send("your turn");
    await agent.idle();

    expect(pressed).toEqual({ ok: true, value: "noted from a person" });
    expect(seen.map((one) => one.origin)).toEqual(["human", undefined]);
    expect(seen.map((one) => one.call.args)).toEqual([
      { query: "from a person" },
      { query: "from the model" },
    ]);

    await client.destroy();
  });

  it("is refused by middleware exactly as a model call is", async () => {
    const { client, agent } = await buildAgent({ tools: [noteTool] });
    client.use(toolCallAction, ({ input }): ToolOutcome => {
      if (input.origin !== "human") return { ok: true, value: "unreached" };
      return { ok: false, error: `a person may not run "${input.call.name}"` };
    });

    const outcome = await agent.invoke("note", { query: "anything" });

    expect(outcome).toEqual({
      ok: false,
      error: 'a person may not run "note"',
    });
    await client.destroy();
  });

  it("validates its arguments and names a tool nothing registers", async () => {
    const { client, agent } = await buildAgent({ tools: [noteTool] });

    expect(await agent.invoke("note", { query: 7 })).toMatchObject({
      ok: false,
    });
    expect(await agent.invoke("nowhere", {})).toEqual({
      ok: false,
      error: 'unknown tool "nowhere"',
    });

    await client.destroy();
  });

  it("runs against the tools registered right now, with no turn open", async () => {
    const { client, agent, tools } = await buildAgent();
    expect(await agent.invoke("note", { query: "early" })).toEqual({
      ok: false,
      error: 'unknown tool "note"',
    });

    const remove = tools.register(noteTool);
    expect(await agent.invoke("note", { query: "late" })).toEqual({
      ok: true,
      value: "noted late",
    });

    remove();
    expect(await agent.invoke("note", { query: "gone" })).toEqual({
      ok: false,
      error: 'unknown tool "note"',
    });

    await client.destroy();
  });

  it("is not cancelled by cancelling the turn, because it is not part of one", async () => {
    const { client, agent } = await buildAgent({ tools: [abortTool] });

    void agent.cancel();
    expect(await agent.invoke("abortable")).toEqual({ ok: true, value: false });

    await client.destroy();
  });
});

describe("the session a human step leaves behind", () => {
  it("appends the call and its outcome without opening a turn", async () => {
    const { client, agent, session } = await buildAgent({ tools: [noteTool] });

    await agent.invoke("note", { query: "the panel" });

    expect(kindsOf(session.snapshot())).toEqual([
      "human-tool-call",
      "human-tool-result",
    ]);
    expect(agent.status.state).toBe("idle");
    const [call, result] = session.snapshot();
    expect(call).toMatchObject({ kind: "human-tool-call", turn: 0 });
    expect(result).toMatchObject({
      kind: "human-tool-result",
      name: "note",
      outcome: { ok: true, value: "noted the panel" },
    });

    await client.destroy();
  });

  it("reads to the model as a note in the operator voice, and derives the same twice", async () => {
    const { client, agent, session } = await buildAgent({
      tools: [noteTool],
      script: [{ chunks: ["understood"] }],
    });

    await agent.invoke("note", { query: "the panel" });
    agent.send("what did I just do?");
    await agent.idle();

    const messages = session.messages();
    expect(messages[0]).toEqual({
      role: "user",
      content:
        'The operator ran the tool "note" with {"query":"the panel"} — result: noted the panel',
    });
    // No orphan: nothing in the transcript quotes a call the model never made.
    expect(messages.some((one) => one.role === "tool")).toBe(false);
    expect(deriveMessages(session.snapshot())).toEqual(messages);

    await client.destroy();
  });

  it("says so when the tool refused, and when the model never asked for it", async () => {
    const { client, agent, session } = await buildAgent({ tools: [noteTool] });

    await agent.invoke("nowhere");

    expect(session.messages()).toEqual([
      {
        role: "user",
        content:
          'The operator ran the tool "nowhere" — result: error: unknown tool "nowhere"',
      },
    ]);

    await client.destroy();
  });

  it("is seen by the model in its next turn, without restarting the loop", async () => {
    const { client, agent, session } = await buildAgent({
      tools: [noteTool],
      script: [{ chunks: ["first"] }, { chunks: ["second"] }],
    });
    const loop = watchLoop(client);

    agent.send("hello");
    await agent.idle();
    await agent.invoke("note", { query: "mid-conversation" });
    agent.send("and now?");
    await agent.idle();

    const notes = session
      .snapshot()
      .filter((entry) => entry.kind === "human-tool-result");
    // The note belongs beside the turn it followed, not before the first one.
    expect(notes[0]?.turn).toBe(1);
    expect(session.messages().map((one) => one.role)).toEqual([
      "user",
      "assistant",
      "user",
      "user",
      "assistant",
    ]);

    loop.stop();
    expect(loop.statuses).toEqual(["active"]);
    await client.destroy();
  });

  it("is refused once the loop has been removed", async () => {
    const { client, agent, session } = await buildAgent({ tools: [noteTool] });

    await client.setPluginList(
      client.pluginList.state.filter((entry) => entry.id !== "loop"),
    );

    expect(await agent.invoke("note", { query: "too late" })).toEqual({
      ok: false,
      error: "the agent has been removed",
    });
    expect(session.snapshot()).toEqual([]);

    await client.destroy();
  });
});
