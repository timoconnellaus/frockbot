// Two Turns that never ended: one hung for seventeen minutes with nothing on
// screen because nothing bounded a Turn's wall clock, and a provider that
// rejected a request before it started took the whole Turn down rather than
// being tried once more.
import { afterEach, describe, expect, test } from "bun:test";
import {
  LlmEffectNotStartedError,
  type LlmProvider,
  ModelProviderFailureError,
  SessionStore,
} from "@frockbot/kernel-contracts";
import { LlmRegistry } from "@frockbot/plugin-models";
import { SystemPromptRegistry } from "@frockbot/plugin-prompt";
import { ToolRegistry } from "@frockbot/plugin-tools";
import { AgentRegistry } from "./agent.js";
import { Context, type Plugin } from "cordis";
import { AgentLoop, TURN_DEADLINE_REASON_V1 } from "./index.js";

const roots: Context[] = [];
const allowEffect = () => Promise.resolve(true);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => root.fiber.dispose()));
});

async function mount(
  provider: LlmProvider,
  config: {
    turnDeadlineMs?: number;
    retry?: {
      now?: () => number;
      random?: () => number;
      sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    };
  } = {},
): Promise<Context> {
  const root = new Context();
  roots.push(root);
  await root.plugin(SessionStore, {});
  await root.plugin(SystemPromptRegistry);
  await root.plugin(LlmRegistry);
  await root.plugin(ToolRegistry);
  await root.plugin(AgentRegistry);
  const promptPlugin: Plugin.Function = (ctx) =>
    ctx.systemPrompt.register({ id: "identity", render: () => "Be useful." });
  promptPlugin.inject = ["systemPrompt"];
  const providerPlugin: Plugin.Function = (ctx) => ctx.llm.register(provider);
  providerPlugin.inject = ["llm"];
  await root.plugin(promptPlugin);
  await root.plugin(providerPlugin);
  await root.plugin(AgentLoop, {
    maxSteps: 4,
    composition: {
      generationId: "generation-1",
      artifactSetHash: "a".repeat(64),
    },
    ...config,
  });
  return root;
}

describe("a Turn that runs out of wall clock", () => {
  test("ends as interrupted, saying why, instead of hanging", async () => {
    const provider: LlmProvider = {
      id: "silent",
      // A provider that accepted the request and will never answer. This is
      // the seventeen-minute Turn, reproduced.
      // eslint-disable-next-line require-yield
      async *stream(_request, signal) {
        await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        });
      },
    };
    const root = await mount(provider, { turnDeadlineMs: 25 });
    const handle = await root.agents.create({
      botId: "deadline-bot",
      sessionId: "deadline",
      provider: "silent",
      model: "test-model",
      admitEffect: allowEffect,
    });

    handle.agent.send("Take your time.");
    await handle.agent.whenIdle();

    // The model request is left in the log with no answer — it carries its
    // own key, so it could be sent again — and the deadline settles the Turn
    // regardless, because a run the clock stopped will never resume.
    const journal = handle.agent.session.events;
    expect(journal.some((event) => event.type === "model/request")).toBe(true);
    expect(journal.some((event) => event.type === "assistant/message")).toBe(
      false,
    );
    const step = journal.findLast((event) => event.type === "step/end");
    if (step?.type !== "step/end") throw new Error("the step never ended");
    expect(step.outcome).toBe("interrupted");
    const end = journal.findLast((event) => event.type === "turn/end");
    if (end?.type !== "turn/end") throw new Error("the Turn never ended");
    expect(end.outcome).toBe("interrupted");
    expect(end.reason).toBe(TURN_DEADLINE_REASON_V1);
    // The last event settles the Turn; nothing is left open behind it.
    expect(journal[journal.length - 1]?.type).toBe("turn/end");
    expect(handle.agent.status).toBe("idle");
  });

  test("settles an open tool call too, so the journal never ends over one", async () => {
    // The deadline landing mid-tool is the other way an open Turn was left
    // behind: a `turn/end` written over an unresolved tool occurrence is an
    // invalid journal, so the occurrence has to be closed first.
    const provider: LlmProvider = {
      id: "one-tool-then-silence",
      async *stream() {
        yield {
          type: "tool-call" as const,
          call: { id: "provider-call", name: "stall", input: {} },
        };
        yield { type: "finish" as const, reason: "tool-calls" as const };
      },
    };
    const root = await mount(provider, { turnDeadlineMs: 40 });
    const toolPlugin: Plugin.Function = (ctx) =>
      ctx.tools.register({
        name: "stall",
        description: "Never answers.",
        inputSchema: { type: "object" },
        execute: (_input, context) =>
          new Promise((_resolve, reject) => {
            context.signal.addEventListener(
              "abort",
              () => reject(context.signal.reason),
              { once: true },
            );
          }),
      });
    toolPlugin.inject = ["tools"];
    await root.plugin(toolPlugin);
    const handle = await root.agents.create({
      botId: "deadline-tool-bot",
      sessionId: "deadline-tool",
      provider: "one-tool-then-silence",
      model: "test-model",
      admitEffect: allowEffect,
    });

    handle.agent.send("Call the tool that never answers.");
    await handle.agent.whenIdle();

    const journal = handle.agent.session.events;
    const result = journal.findLast((event) => event.type === "tool/result");
    if (result?.type !== "tool/result") {
      throw new Error("the tool call was left open");
    }
    expect(result.status).toBe("interrupted");
    const end = journal.findLast((event) => event.type === "turn/end");
    if (end?.type !== "turn/end") throw new Error("the Turn never ended");
    expect(end.outcome).toBe("interrupted");
    expect(journal[journal.length - 1]?.type).toBe("turn/end");
  });

  test("is reported as the deadline, never as a Stop the person did not press", async () => {
    const provider: LlmProvider = {
      id: "never-reached",
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new Error("the Turn should never have got this far");
      },
    };
    const root = await mount(provider, { turnDeadlineMs: 25 });
    // Stalling before the first model request leaves no uncertain effect, so
    // the Turn settles on its own terms and the reason it carries is the one
    // under test. The deadline aborts the same controller Stop does; the
    // person must not be told they stopped it.
    let stalled: (() => void) | undefined;
    root.on("agent/pre-step", async (_agent, _inputs, _turn, _step, next) => {
      await new Promise<void>((_resolve, reject) => {
        stalled = () => reject(new Error("stalled"));
      });
      return next();
    });
    // The deadline aborts the loop's controller, which the stalled hook does
    // not itself watch; releasing it here stands in for whatever slow thing a
    // real Turn was waiting on noticing that nobody is waiting any more.
    setTimeout(() => stalled?.(), 60);
    const handle = await root.agents.create({
      botId: "deadline-reason-bot",
      sessionId: "deadline-reason",
      provider: "never-reached",
      model: "test-model",
      admitEffect: allowEffect,
    });

    handle.agent.send("Stall before the model.");
    await handle.agent.whenIdle();

    const end = handle.agent.session.events.findLast(
      (event) => event.type === "turn/end",
    );
    if (end?.type !== "turn/end") throw new Error("the Turn never ended");
    expect(end.outcome).toBe("interrupted");
    expect(end.reason).toBe(TURN_DEADLINE_REASON_V1);
  });
});

describe("a model request the provider says never started", () => {
  test("is tried once more, and the Turn succeeds on the retry", async () => {
    let attempts = 0;
    const provider: LlmProvider = {
      id: "flaky-binding",
      async *stream() {
        attempts += 1;
        if (attempts === 1) {
          throw new LlmEffectNotStartedError(
            "model binding was not resolvable",
          );
        }
        yield { type: "text-delta", text: "Second time lucky." } as const;
        yield { type: "finish", reason: "completed" } as const;
      },
    };
    const root = await mount(provider);
    const handle = await root.agents.create({
      botId: "retry-bot",
      sessionId: "retry",
      provider: "flaky-binding",
      model: "test-model",
      admitEffect: allowEffect,
    });

    handle.agent.send("Say hello.");
    await handle.agent.whenIdle();

    expect(attempts).toBe(2);
    expect(handle.agent.session.events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "completed",
    });
    // Two dispatches of one key, so the log shows both sends and the retry
    // that connected them.
    const sends = handle.agent.session.events.filter(
      (event) => event.type === "model/request",
    );
    expect(sends).toHaveLength(2);
    expect(new Set(sends.map((event) => event.request.requestId)).size).toBe(1);
    expect(
      handle.agent.session.events.filter(
        (event) => event.type === "model/retry",
      ),
    ).toHaveLength(1);
  });

  test("is not retried a second time", async () => {
    let attempts = 0;
    const provider: LlmProvider = {
      id: "always-rejects",
      async *stream() {
        attempts += 1;
        throw new LlmEffectNotStartedError("invalid api key");
      },
    };
    const root = await mount(provider);
    const handle = await root.agents.create({
      botId: "no-retry-bot",
      sessionId: "no-retry",
      provider: "always-rejects",
      model: "test-model",
      admitEffect: allowEffect,
    });

    handle.agent.send("Say hello.");
    await handle.agent.whenIdle();

    expect(attempts).toBe(2);
    expect(handle.agent.session.events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "model-error",
      reason: "invalid api key",
    });
  });

  test("an uncertain failure is retried once, under the same key", async () => {
    const dispatched: string[] = [];
    const provider: LlmProvider = {
      id: "uncertain",
      async *stream(request) {
        dispatched.push(request.requestId);
        // The call may well have run. Retrying is safe anyway, because the
        // retry carries the same idempotency key.
        throw new Error("connection reset mid-stream");
      },
    };
    const root = await mount(provider);
    const handle = await root.agents.create({
      botId: "uncertain-bot",
      sessionId: "uncertain",
      provider: "uncertain",
      model: "test-model",
      admitEffect: allowEffect,
    });

    handle.agent.send("Say hello.");
    await handle.agent.whenIdle();

    expect(dispatched).toHaveLength(2);
    expect(dispatched[0]).toBe(dispatched[1]);
    expect(handle.agent.session.events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "model-error",
    });
  });
});

describe("classified model retry policy", () => {
  test("backs off with injected time and random before a transient retry", async () => {
    let attempts = 0;
    let now = 10_000;
    const sleeps: number[] = [];
    const provider: LlmProvider = {
      id: "transient-once",
      async *stream() {
        attempts += 1;
        if (attempts === 1) {
          throw new ModelProviderFailureError({
            classification: "transient",
            reason: "service unavailable",
          });
        }
        yield { type: "text-delta", text: "Recovered." } as const;
        yield { type: "finish", reason: "completed" } as const;
      },
    };
    const root = await mount(provider, {
      retry: {
        now: () => now,
        random: () => 1,
        sleep: (milliseconds) => {
          sleeps.push(milliseconds);
          now += milliseconds;
          return Promise.resolve();
        },
      },
    });
    const handle = await root.agents.create({
      botId: "transient-bot",
      sessionId: "transient",
      provider: provider.id,
      model: "test-model",
      admitEffect: allowEffect,
    });

    handle.agent.send("Try the provider.");
    await handle.agent.whenIdle();

    expect(attempts).toBe(2);
    expect(sleeps).toEqual([500]);
    expect(
      handle.agent.session.events.find((event) => event.type === "model/retry"),
    ).toMatchObject({
      attempt: 2,
      classification: "transient",
      delayMs: 500,
    });
  });

  test("does not retry a permanent failure", async () => {
    let attempts = 0;
    const provider: LlmProvider = {
      id: "permanent",
      async *stream() {
        attempts += 1;
        throw new ModelProviderFailureError({
          classification: "permanent",
          reason: "credentials were refused",
        });
      },
    };
    const root = await mount(provider);
    const handle = await root.agents.create({
      botId: "permanent-bot",
      sessionId: "permanent",
      provider: provider.id,
      model: "test-model",
      admitEffect: allowEffect,
    });

    handle.agent.send("Try the provider.");
    await handle.agent.whenIdle();

    expect(attempts).toBe(1);
    expect(
      handle.agent.session.events.filter(
        (event) => event.type === "model/retry",
      ),
    ).toHaveLength(0);
  });

  test("does not schedule a retry beyond the remaining Turn deadline", async () => {
    let attempts = 0;
    const provider: LlmProvider = {
      id: "deadline-bound",
      async *stream() {
        attempts += 1;
        throw new ModelProviderFailureError({
          classification: "transient",
          reason: "service unavailable",
        });
      },
    };
    const root = await mount(provider, {
      turnDeadlineMs: 400,
      retry: { now: () => 0, random: () => 1 },
    });
    const handle = await root.agents.create({
      botId: "bounded-bot",
      sessionId: "bounded",
      provider: provider.id,
      model: "test-model",
      admitEffect: allowEffect,
    });

    handle.agent.send("Try the provider.");
    await handle.agent.whenIdle();

    expect(attempts).toBe(1);
  });
});

// Named so a reader who greps for the reason string finds where it is set.
test("the deadline reason tells the person what to do about it", () => {
  expect(TURN_DEADLINE_REASON_V1).toContain("Try sending it again");
});
