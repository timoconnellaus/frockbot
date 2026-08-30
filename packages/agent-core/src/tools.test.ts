import { afterEach, describe, expect, test } from "bun:test";
import { Context } from "cordis";
import {
  ToolRegistry,
  type ToolDefinition,
  type ToolExecutionContext,
} from "./tools.js";
import type { ToolCall } from "./types.js";

const roots: Context[] = [];

async function registryFixture(tool: ToolDefinition): Promise<{
  root: Context;
  call: ToolCall;
  context: ToolExecutionContext;
}> {
  const root = new Context();
  roots.push(root);
  await root.plugin(ToolRegistry);
  root.tools.register(tool);
  return {
    root,
    call: { id: "provider-call", name: tool.name, input: {} },
    context: {
      botId: "primary",
      agentId: "primary",
      sessionId: "alice:primary",
      effectId: "tool:1:1:0",
      toolCall: { id: "provider-call", name: tool.name, input: {} },
      signal: new AbortController().signal,
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => root.fiber.dispose()));
});

describe("ToolRegistry effect reconciliation", () => {
  test("retries an idempotent definition with the same durable effect id", async () => {
    const effects: string[] = [];
    const fixture = await registryFixture({
      name: "idempotent",
      description: "Idempotent fixture.",
      inputSchema: { type: "object" },
      idempotent: true,
      execute(_input, context) {
        effects.push(context.effectId);
        return Promise.resolve({ content: "settled", isError: false });
      },
    });
    const preparation = await fixture.root.tools.prepare(
      fixture.call,
      fixture.context,
    );
    if (preparation.kind !== "ready") throw new Error("tool was denied");

    expect(
      await fixture.root.tools.reconcilePrepared(preparation, fixture.context),
    ).toEqual({
      status: "recovered",
      result: { content: "settled", isError: false },
    });
    expect(effects).toEqual(["tool:1:1:0"]);
  });

  test("retrieves a non-idempotent result without executing the effect", async () => {
    let executions = 0;
    const reconciled: string[] = [];
    const fixture = await registryFixture({
      name: "non-idempotent",
      description: "Non-idempotent fixture.",
      inputSchema: { type: "object" },
      execute() {
        executions += 1;
        return Promise.resolve({ content: "duplicate", isError: false });
      },
      reconcile(_input, context) {
        reconciled.push(context.effectId);
        return Promise.resolve({
          status: "recovered",
          result: { content: "original", isError: false },
        });
      },
    });
    const preparation = await fixture.root.tools.prepare(
      fixture.call,
      fixture.context,
    );
    if (preparation.kind !== "ready") throw new Error("tool was denied");

    expect(
      await fixture.root.tools.reconcilePrepared(preparation, fixture.context),
    ).toEqual({
      status: "recovered",
      result: { content: "original", isError: false },
    });
    expect(executions).toBe(0);
    expect(reconciled).toEqual(["tool:1:1:0"]);
  });

  test("does not let middleware elevate a non-idempotent durable effect", async () => {
    let executions = 0;
    let retrievals = 0;
    const fixture = await registryFixture({
      name: "guarded",
      description: "Guarded fixture.",
      inputSchema: { type: "object" },
      execute() {
        executions += 1;
        return Promise.resolve({ content: "duplicate", isError: false });
      },
      reconcile() {
        retrievals += 1;
        return Promise.resolve({
          status: "recovered",
          result: { content: "original", isError: false },
        });
      },
    });
    fixture.root.on("tools/pre-execute", async (_call, _context, next) => {
      const prepared = await next();
      return prepared.kind === "ready"
        ? { ...prepared, idempotent: true }
        : prepared;
    });

    const preparation = await fixture.root.tools.prepare(
      fixture.call,
      fixture.context,
    );
    if (preparation.kind !== "ready") throw new Error("tool was denied");
    expect(preparation.idempotent).toBe(true);

    expect(
      await fixture.root.tools.reconcilePrepared(preparation, fixture.context),
    ).toEqual({
      status: "recovered",
      result: { content: "original", isError: false },
    });
    expect(executions).toBe(0);
    expect(retrievals).toBe(1);

    expect(
      await fixture.root.tools.reconcilePrepared(
        {
          ...preparation,
          call: { ...fixture.call, input: { changed: true } },
        },
        fixture.context,
      ),
    ).toMatchObject({ status: "unavailable" });
    expect(executions).toBe(0);
  });

  test("normalizes unavailable outcomes to a bounded reason", async () => {
    const fixture = await registryFixture({
      name: "pending",
      description: "Pending fixture.",
      inputSchema: { type: "object" },
      execute: () => Promise.resolve({ content: "duplicate", isError: false }),
      reconcile: () =>
        Promise.resolve({
          status: "unavailable",
          reason: "💥".repeat(1_000),
        }),
    });
    const preparation = await fixture.root.tools.prepare(
      fixture.call,
      fixture.context,
    );
    if (preparation.kind !== "ready") throw new Error("tool was denied");

    const outcome = await fixture.root.tools.reconcilePrepared(
      preparation,
      fixture.context,
    );
    expect(outcome.status).toBe("unavailable");
    if (outcome.status !== "unavailable") return;
    expect(new TextEncoder().encode(outcome.reason).byteLength).toBe(512);
  });

  test("returns unavailable when a non-idempotent definition has no retrieval seam", async () => {
    const fixture = await registryFixture({
      name: "opaque",
      description: "Opaque fixture.",
      inputSchema: { type: "object" },
      execute: () => Promise.resolve({ content: "effect", isError: false }),
    });
    const preparation = await fixture.root.tools.prepare(
      fixture.call,
      fixture.context,
    );
    if (preparation.kind !== "ready") throw new Error("tool was denied");

    expect(
      await fixture.root.tools.reconcilePrepared(preparation, fixture.context),
    ).toEqual({
      status: "unavailable",
      reason: "Tool opaque does not support effect reconciliation",
    });
  });
});
