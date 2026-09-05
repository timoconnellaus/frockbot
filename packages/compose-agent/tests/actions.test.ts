import { describe, expect, it } from "bun:test";
import {
  createTool,
  requestAction,
  toolCallAction,
  toolMiddleware,
} from "../src";
import { buildAgent, kindsOf } from "./helpers/agent";
import { lookupTool } from "./helpers/other-package";
import { anyValidator, validator } from "./helpers/validator";
import type { ModelRequest, ToolOutcome } from "../src";

const workValidator = validator<unknown, { name: string; delay: number }>(
  (value) => {
    const raw = value as { name?: unknown; delay?: unknown } | null;
    if (typeof raw?.name !== "string") {
      return { issues: [{ message: "expected a string", path: ["name"] }] };
    }
    return { value: { name: raw.name, delay: Number(raw.delay ?? 0) } };
  },
);

const outcomesOf = (
  entries: ReadonlyArray<{ kind: string }>,
): Array<ToolOutcome> =>
  (entries as ReadonlyArray<{ kind: string; outcome?: ToolOutcome }>)
    .filter((entry) => entry.kind === "tool-result")
    .map((entry) => entry.outcome!);

describe("D. Requests and tool calls are actions", () => {
  it("middleware can rewrite what the model sees or veto the step", async () => {
    const seen: Array<ModelRequest> = [];
    const { client, agent, session } = await buildAgent({
      sections: [{ name: "base", text: "Be helpful." }],
      tools: [lookupTool],
      script: [{ chunks: ["first"] }, { chunks: ["second"] }],
    });

    // Registered first, so it sits closest to the handler and sees exactly what
    // the model provider is handed.
    client.use(requestAction, ({ input, next }) => {
      seen.push(input);
      return next(input);
    });
    // Registered with `first`, so it wraps the recorder and rewrites first.
    client.use(
      requestAction,
      ({ input, next }) =>
        next({
          ...input,
          system: `${input.system}\n\nRewritten.`,
          tools: [],
          options: { temperature: 0 },
        }),
      { first: true },
    );

    agent.send("go");
    await agent.idle();

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      system: "Be helpful.\n\nRewritten.",
      tools: [],
      options: { temperature: 0 },
    });
    expect(session.messages().at(-1)).toEqual({
      role: "assistant",
      content: "first",
      toolCalls: [],
    });

    // A veto: the middleware answers without calling `next`, and neither the
    // loop nor the provider can tell.
    const veto = client.use(
      requestAction,
      () => ({ text: "vetoed", toolCalls: [] }),
      { first: true },
    );
    agent.send("again");
    await agent.idle();
    veto();

    expect(seen).toHaveLength(1);
    expect(session.messages().at(-1)).toEqual({
      role: "assistant",
      content: "vetoed",
      toolCalls: [],
    });
    expect(session.snapshot().at(-1)).toMatchObject({
      kind: "turn-closed",
      reason: "complete",
    });

    // The provider never advanced, so the second scripted response is still next.
    agent.send("a third time");
    await agent.idle();
    expect(session.messages().at(-1)).toEqual({
      role: "assistant",
      content: "second",
      toolCalls: [],
    });

    await client.destroy();
  });

  it("middleware can rewrite the arguments, replace the result, or refuse the call", async () => {
    const ran: Array<string> = [];
    const shout = createTool({
      name: "shout",
      description: "Shout a word",
      validator: workValidator,
      execute: ({ name }) => {
        ran.push(name);
        return name.toUpperCase();
      },
    });
    const secret = createTool({
      name: "secret",
      description: "Never allowed to run",
      validator: anyValidator,
      execute: () => {
        ran.push("secret");
        return "leaked";
      },
    });

    const { client, agent, session } = await buildAgent({
      tools: [shout, secret, lookupTool],
      script: [
        {
          toolCalls: [
            { name: "shout", args: { name: "hello" } },
            { name: "secret", args: {} },
            { name: "lookup", args: { query: "cats" } },
          ],
        },
        { chunks: ["done"] },
      ],
    });

    // Rewrite the arguments, with the tool's own types.
    client.use(
      toolCallAction,
      toolMiddleware(shout, ({ input, next }) =>
        next({ ...input.args, name: `${input.args.name} world` }),
      ),
    );
    // Refuse the call outright: the model reads it as an error.
    const refusal: ToolOutcome = { ok: false, error: "refused by policy" };
    client.use(toolCallAction, ({ input, next }) =>
      input.call.name === "secret" ? refusal : next(input),
    );
    // Replace the result after the tool has run.
    client.use(
      toolCallAction,
      toolMiddleware(lookupTool, async ({ input, next }) => {
        const outcome = await next(input.args);
        return outcome.ok ? { ok: true, value: { found: 99 } } : outcome;
      }),
    );

    agent.send("go");
    await agent.idle();

    expect(ran).toEqual(["hello world"]);
    expect(outcomesOf(session.snapshot())).toEqual([
      { ok: true, value: "HELLO WORLD" },
      { ok: false, error: "refused by policy" },
      { ok: true, value: { found: 99 } },
    ]);
    // The refusal reaches the model as a tool error, like any other failure.
    expect(session.messages()[3]).toEqual({
      role: "tool",
      callId: "call-2",
      name: "secret",
      content: "refused by policy",
      isError: true,
    });

    await client.destroy();
  });

  it("invalid arguments produce an error result rather than a thrown exception", async () => {
    const { client, agent, session } = await buildAgent({
      tools: [lookupTool],
      script: [
        { toolCalls: [{ name: "lookup", args: { query: 42 } }] },
        { chunks: ["recovered"] },
      ],
    });

    agent.send("go");
    await agent.idle();

    expect(outcomesOf(session.snapshot())).toEqual([
      {
        ok: false,
        error: 'invalid arguments for tool "lookup": expected a string',
      },
    ]);
    // The turn carried on and closed normally; nothing was thrown out of it.
    expect(session.snapshot().at(-1)).toMatchObject({
      kind: "turn-closed",
      reason: "complete",
    });
    expect(client.errors.state).toEqual([]);

    await client.destroy();
  });

  it("tool calls run with their declared concurrency and results keep the model order", async () => {
    const timeline: Array<string> = [];
    const work = createTool({
      name: "work",
      description: "Do a piece of work",
      validator: workValidator,
      concurrency: "parallel",
      execute: async ({ name, delay }) => {
        timeline.push(`start:${name}`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        timeline.push(`end:${name}`);
        return name;
      },
    });
    const alone = createTool({
      name: "alone",
      description: "Must run by itself",
      validator: workValidator,
      concurrency: "exclusive",
      execute: async ({ name }) => {
        timeline.push(`start:${name}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        timeline.push(`end:${name}`);
        return name;
      },
    });

    const { client, agent, session } = await buildAgent({
      tools: [work, alone],
      script: [
        {
          toolCalls: [
            { name: "work", args: { name: "a", delay: 10 } },
            { name: "work", args: { name: "b", delay: 0 } },
            { name: "alone", args: { name: "c" } },
            { name: "work", args: { name: "d", delay: 0 } },
          ],
        },
        { chunks: ["done"] },
      ],
    });

    agent.send("go");
    await agent.idle();

    // a and b share a batch and overlap; c runs alone; d follows it.
    expect(timeline).toEqual([
      "start:a",
      "start:b",
      "end:b",
      "end:a",
      "start:c",
      "end:c",
      "start:d",
      "end:d",
    ]);
    // However they finished, the results are in the order the model issued them.
    expect(outcomesOf(session.snapshot())).toEqual([
      { ok: true, value: "a" },
      { ok: true, value: "b" },
      { ok: true, value: "c" },
      { ok: true, value: "d" },
    ]);
    expect(
      session
        .snapshot()
        .filter((entry) => entry.kind === "tool-result")
        .map((entry) => entry.callId),
    ).toEqual(["call-1", "call-2", "call-3", "call-4"]);

    await client.destroy();
  });

  it("a throwing tool keeps the turn going and a failing model closes it", async () => {
    const boom = createTool({
      name: "boom",
      description: "Always throws",
      validator: anyValidator,
      execute: () => {
        throw new Error("the tool exploded");
      },
    });

    const thrown = await buildAgent({
      tools: [boom],
      script: [
        { toolCalls: [{ name: "boom", args: {} }] },
        { chunks: ["carried on"] },
      ],
    });
    thrown.agent.send("go");
    await thrown.agent.idle();

    expect(outcomesOf(thrown.session.snapshot())).toEqual([
      { ok: false, error: "the tool exploded" },
    ]);
    expect(thrown.session.messages().at(-1)).toEqual({
      role: "assistant",
      content: "carried on",
      toolCalls: [],
    });
    expect(thrown.session.snapshot().at(-1)).toMatchObject({
      kind: "turn-closed",
      reason: "complete",
    });
    await thrown.client.destroy();

    const failing = await buildAgent({
      script: [{ chunks: ["partial"], error: "the endpoint exploded" }],
    });
    failing.agent.send("go");
    await failing.agent.idle();

    expect(kindsOf(failing.session.snapshot())).toEqual([
      "turn-opened",
      "input",
      "step-opened",
      "chunk",
      "assistant",
      "error",
      "step-closed",
      "turn-closed",
    ]);
    expect(failing.session.snapshot().at(-3)).toMatchObject({
      kind: "error",
      scope: "model",
      message: "the endpoint exploded",
    });
    expect(failing.session.snapshot().at(-1)).toMatchObject({
      kind: "turn-closed",
      reason: "error",
    });
    expect(failing.agent.status.state).toBe("idle");

    await failing.client.destroy();
  });
});
