import { afterEach, describe, expect, test } from "bun:test";
import { Context } from "cordis";
import { ToolRegistry } from "./tools.js";
import type {
  ToolCall,
  ToolDefinition,
  ToolExecutionContext,
} from "@frockbot/kernel-contracts";

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
      compositionGenerationId: "test-composition-generation",
      effectId: "tool:1:1:0",
      toolCall: { id: "provider-call", name: tool.name, input: {} },
      turnType: "chat" as const,
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

describe("ToolRegistry turn admission", () => {
  async function admissionRoot(): Promise<Context> {
    const root = new Context();
    roots.push(root);
    await root.plugin(ToolRegistry);
    return root;
  }

  const work: ToolDefinition = {
    name: "work",
    description: "A work tool.",
    inputSchema: { type: "object" },
    execute: () => Promise.resolve({ content: "worked", isError: false }),
  };
  const chatOnly: ToolDefinition = {
    name: "send_to_user",
    description: "The voice to the User.",
    inputSchema: { type: "object" },
    admission: { turnTypes: ["chat"] },
    execute: () => Promise.resolve({ content: "sent", isError: false }),
  };
  const automationOnly: ToolDefinition = {
    name: "wake_parent",
    description: "Hands off to the parent conversation.",
    inputSchema: { type: "object" },
    admission: { turnTypes: ["automation", "subagent"] },
    execute: () => Promise.resolve({ content: "woke", isError: false }),
  };

  function contextFor(
    name: string,
    turnType: ToolExecutionContext["turnType"],
  ): ToolExecutionContext {
    return {
      botId: "primary",
      agentId: "primary",
      sessionId: "alice:primary",
      compositionGenerationId: "test-composition-generation",
      effectId: "tool:1:1:0",
      toolCall: { id: "provider-call", name, input: {} },
      turnType,
      signal: new AbortController().signal,
    };
  }

  test("offers a tool with no declaration on every turn type", async () => {
    const root = await admissionRoot();
    root.tools.register(work);
    for (const turnType of [
      "chat",
      "automation",
      "subagent",
      "channel",
    ] as const) {
      expect(root.tools.schemas({ turnType }).map((s) => s.name)).toEqual([
        "work",
      ]);
    }
  });

  test("trims the catalog to what the turn type admits", async () => {
    const root = await admissionRoot();
    root.tools.register(work);
    root.tools.register(chatOnly);
    root.tools.register(automationOnly);

    expect(root.tools.schemas({ turnType: "chat" }).map((s) => s.name)).toEqual(
      ["work", "send_to_user"],
    );
    expect(
      root.tools.schemas({ turnType: "automation" }).map((s) => s.name),
    ).toEqual(["work", "wake_parent"]);
    expect(
      root.tools.schemas({ turnType: "channel" }).map((s) => s.name),
    ).toEqual(["work"]);
  });

  test("bounds a tool declaration by the manifest ceiling", async () => {
    const root = await admissionRoot();
    root.tools.register(work, { admissionCeiling: ["automation"] });
    root.tools.register(chatOnly, {
      admissionCeiling: ["automation", "subagent"],
    });

    expect(root.tools.schemas({ turnType: "chat" })).toEqual([]);
    expect(
      root.tools.schemas({ turnType: "automation" }).map((s) => s.name),
    ).toEqual(["work"]);
  });

  test("denies an out-of-admission call without executing it", async () => {
    let executions = 0;
    const root = await admissionRoot();
    root.tools.register({
      ...chatOnly,
      execute: () => {
        executions += 1;
        return Promise.resolve({ content: "sent", isError: false });
      },
    });

    const denied = await root.tools.prepare(
      { id: "provider-call", name: "send_to_user", input: {} },
      contextFor("send_to_user", "automation"),
    );
    expect(denied).toMatchObject({
      kind: "denied",
      result: { isError: true },
    });
    if (denied.kind !== "denied") throw new Error("expected a denial");
    expect(denied.result.content).toContain("send_to_user");
    expect(executions).toBe(0);

    const ready = await root.tools.prepare(
      { id: "provider-call", name: "send_to_user", input: {} },
      contextFor("send_to_user", "chat"),
    );
    expect(ready.kind).toBe("ready");
  });

  test("denies a call the manifest ceiling excludes even when the tool allows it", async () => {
    const root = await admissionRoot();
    root.tools.register(chatOnly, { admissionCeiling: ["automation"] });
    const denied = await root.tools.prepare(
      { id: "provider-call", name: "send_to_user", input: {} },
      contextFor("send_to_user", "chat"),
    );
    expect(denied.kind).toBe("denied");
  });

  test("carries endsTurn through execution and reconciliation", async () => {
    const root = await admissionRoot();
    root.tools.register({
      name: "hand_off",
      description: "Ends the Turn.",
      inputSchema: { type: "object" },
      execute: () =>
        Promise.resolve({
          content: "handed off",
          isError: false,
          endsTurn: true,
        }),
      reconcile: () =>
        Promise.resolve({
          status: "recovered" as const,
          result: { content: "handed off", isError: false, endsTurn: true },
        }),
    });
    const context = contextFor("hand_off", "automation");
    const preparation = await root.tools.prepare(
      { id: "provider-call", name: "hand_off", input: {} },
      context,
    );
    if (preparation.kind !== "ready") throw new Error("tool was denied");
    expect(await root.tools.executePrepared(preparation, context)).toEqual({
      content: "handed off",
      isError: false,
      endsTurn: true,
    });
    expect(await root.tools.reconcilePrepared(preparation, context)).toEqual({
      status: "recovered",
      result: { content: "handed off", isError: false, endsTurn: true },
    });
  });
});
