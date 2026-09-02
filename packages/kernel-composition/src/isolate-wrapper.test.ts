import { describe, expect, test } from "bun:test";
import {
  BOT_ISOLATE_DEADLINE_SOURCE,
  BOT_ISOLATE_INVOCATION_SOURCE,
  BOT_ISOLATE_MAIN_MODULE,
  BOT_ISOLATE_PACKAGE_MODULE,
  BOT_ISOLATE_WRAPPER_SOURCE,
  botIsolateModuleMap,
} from "./isolate-wrapper.ts";

type Deadline = (work: () => unknown, deadlineMs: number) => Promise<unknown>;

// The wrapper ships as generated text, so the tested function is compiled from
// exactly the source the wrapper embeds rather than from a TypeScript twin.
const withIsolateDeadline = new Function(
  `${BOT_ISOLATE_DEADLINE_SOURCE}\nreturn withIsolateDeadline;`,
)() as Deadline;

type DecodeInvocation = (value: unknown) => unknown;

const decodeInvocation = new Function(
  `${BOT_ISOLATE_INVOCATION_SOURCE}\nreturn decodeInvocation;`,
)() as DecodeInvocation;

function invocation(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    tool: "reverse_text",
    input: { text: "a" },
    botId: "bot-1",
    sessionId: "user-1:bot-1",
    runId: "run-1",
    turnId: "turn-1",
    generationId: "gen-1",
    deadlineMs: 1_000,
    ...overrides,
  };
}

function never(): Promise<never> {
  return new Promise(() => {});
}

describe("the generated wrapper's deadline", () => {
  test("resolves work that finishes inside the deadline", async () => {
    await expect(withIsolateDeadline(() => "done", 1_000)).resolves.toBe(
      "done",
    );
  });

  test("rejects work that outlives the deadline", async () => {
    await expect(withIsolateDeadline(never, 10)).rejects.toThrow(
      "isolate invocation exceeded its deadline of 10ms",
    );
  });

  test("turns a synchronous throw into a rejection", async () => {
    await expect(
      withIsolateDeadline(() => {
        throw new Error("boom");
      }, 1_000),
    ).rejects.toThrow("boom");
  });

  test("refuses a deadline outside the contract bound", async () => {
    for (const deadline of [0, -1, 60_001, 1.5, Number.NaN]) {
      await expect(withIsolateDeadline(() => "done", deadline)).rejects.toThrow(
        "isolate invocation deadline is out of range",
      );
    }
  });

  test("does not hold the isolate open after the work settles", async () => {
    const started = Date.now();
    await withIsolateDeadline(() => "done", 50_000);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("the generated wrapper's invocation decoder", () => {
  test("accepts exactly the declared invocation", () => {
    expect(decodeInvocation(invocation())).toMatchObject({
      tool: "reverse_text",
    });
  });

  test("refuses an invocation carrying an undeclared field", () => {
    expect(() =>
      decodeInvocation(invocation({ capabilities: ["models:invoke"] })),
    ).toThrow("isolate tool invocation has invalid fields");
  });

  test("refuses an invocation missing a declared field", () => {
    const { turnId: _turnId, ...missing } = invocation();
    expect(() => decodeInvocation(missing)).toThrow(
      "isolate tool invocation has invalid fields",
    );
  });
});

describe("the generated wrapper module map", () => {
  test("is exactly two entries", () => {
    const modules = botIsolateModuleMap("export const tools = [];");
    expect(Object.keys(modules).sort()).toEqual([
      BOT_ISOLATE_MAIN_MODULE,
      BOT_ISOLATE_PACKAGE_MODULE,
    ]);
    expect(modules[BOT_ISOLATE_MAIN_MODULE]?.js).toBe(
      BOT_ISOLATE_WRAPPER_SOURCE,
    );
    expect(modules[BOT_ISOLATE_PACKAGE_MODULE]?.js).toBe(
      "export const tools = [];",
    );
  });

  test("exposes only the wrapper entrypoint to the loader", () => {
    expect(BOT_ISOLATE_WRAPPER_SOURCE).toContain(
      'import { WorkerEntrypoint } from "cloudflare:workers";',
    );
    expect(BOT_ISOLATE_WRAPPER_SOURCE).toContain("async health()");
    expect(BOT_ISOLATE_WRAPPER_SOURCE).toContain(
      "async execute(rawInvocation)",
    );
    expect(BOT_ISOLATE_WRAPPER_SOURCE).toContain(
      "return capabilities.schedule(request);",
    );
  });
});
