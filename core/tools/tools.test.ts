import { describe, expect, test } from "bun:test";
import { LoopHookListV1 } from "@frockbot/core/contracts";
import { ToolRegistry } from "./tools.js";
import type {
  ToolCall,
  ToolDefinition,
  ToolExecutionContext,
} from "@frockbot/core/contracts";

function registryFixture(tool: ToolDefinition): {
  hooks: LoopHookListV1;
  tools: ToolRegistry;
  call: ToolCall;
  context: ToolExecutionContext;
} {
  const hooks = new LoopHookListV1();
  const tools = new ToolRegistry(hooks);
  tools.register(tool);
  return {
    hooks,
    tools,
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

describe("ToolRegistry effect keying", () => {
  test("deny-only guards run after pre-execute and cannot be lifted", async () => {
    const order: string[] = [];
    const fixture = registryFixture({
      name: "guarded_order",
      description: "Guard ordering fixture.",
      inputSchema: { type: "object" },
      execute: () => {
        order.push("execute");
        return Promise.resolve({ content: "ran", isError: false });
      },
    });
    fixture.hooks.add({
      prepareTool: async (_call, _context, next) => {
        order.push("pre-execute");
        return next();
      },
    });
    fixture.tools.guard(() => {
      order.push("deny");
      return { reason: "first guard denied the call" };
    });
    fixture.tools.guard(() => {
      order.push("later-guard");
      return undefined;
    });

    const preparation = await fixture.tools.prepare(
      fixture.call,
      fixture.context,
    );
    expect(preparation).toEqual({
      kind: "denied",
      call: fixture.call,
      result: { content: "first guard denied the call", isError: true },
    });
    expect(order).toEqual(["pre-execute", "deny"]);
    expect(order).not.toContain("execute");
  });

  test("hands the occurrence's own id to the definition as its effect id", async () => {
    const effects: string[] = [];
    const fixture = registryFixture({
      name: "idempotent",
      description: "Idempotent fixture.",
      inputSchema: { type: "object" },
      idempotent: true,
      execute(_input, context) {
        effects.push(context.effectId);
        return Promise.resolve({ content: "settled", isError: false });
      },
    });
    const preparation = await fixture.tools.prepare(
      fixture.call,
      fixture.context,
    );
    if (preparation.kind !== "ready") throw new Error("tool was denied");

    expect(
      await fixture.tools.executePrepared(preparation, fixture.context),
    ).toEqual({ content: "settled", isError: false });
    expect(effects).toEqual(["tool:1:1:0"]);
  });

  // An occurrence with a journaled intent and no result is executed again
  // under the same effect id. The registry asks the provider nothing; a tool
  // that must not repeat an external effect answers from what that key already
  // holds.
  test("re-runs under the same effect id, and the tool answers from its own record", async () => {
    const sent = new Map<string, string>();
    const dispatches: string[] = [];
    const fixture = registryFixture({
      name: "external_action",
      description: "External-effect fixture.",
      inputSchema: { type: "object" },
      execute(_input, context) {
        const recorded = sent.get(context.effectId);
        if (recorded) {
          return Promise.resolve({ content: recorded, isError: false });
        }
        dispatches.push(context.effectId);
        sent.set(context.effectId, "sent as message-1");
        return Promise.resolve({
          content: "sent as message-1",
          isError: false,
        });
      },
    });
    const preparation = await fixture.tools.prepare(
      fixture.call,
      fixture.context,
    );
    if (preparation.kind !== "ready") throw new Error("tool was denied");

    const first = await fixture.tools.executePrepared(
      preparation,
      fixture.context,
    );
    const retried = await fixture.tools.executePrepared(
      preparation,
      fixture.context,
    );

    expect(retried).toEqual(first);
    expect(dispatches).toEqual(["tool:1:1:0"]);
  });

  test("carries the definition's idempotence onto the preparation", async () => {
    const fixture = registryFixture({
      name: "opaque",
      description: "Opaque fixture.",
      inputSchema: { type: "object" },
      execute: () => Promise.resolve({ content: "effect", isError: false }),
    });
    const preparation = await fixture.tools.prepare(
      fixture.call,
      fixture.context,
    );

    expect(preparation).toMatchObject({ kind: "ready", idempotent: false });
  });

  test("lets middleware raise idempotence on the preparation", async () => {
    const fixture = registryFixture({
      name: "guarded",
      description: "Guarded fixture.",
      inputSchema: { type: "object" },
      execute: () => Promise.resolve({ content: "ran", isError: false }),
    });
    fixture.hooks.add({
      prepareTool: async (_call, _context, next) => {
        const prepared = await next();
        return prepared.kind === "ready"
          ? { ...prepared, idempotent: true }
          : prepared;
      },
    });

    const preparation = await fixture.tools.prepare(
      fixture.call,
      fixture.context,
    );

    expect(preparation).toMatchObject({ kind: "ready", idempotent: true });
  });
});

describe("ToolRegistry turn admission", () => {
  function admissionRegistry(): ToolRegistry {
    return new ToolRegistry(new LoopHookListV1());
  }

  function admittedNames(
    tools: ToolRegistry,
    admission: {
      turnType: ToolExecutionContext["turnType"];
      subagentRole?: string;
    },
  ): string[] {
    return tools
      .schemas(admission)
      .map((schema) => schema.name)
      .filter(
        (name) => name !== "get_dynamic_tools" && name !== "call_dynamic_tool",
      );
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
    const tools = admissionRegistry();
    tools.register(work);
    for (const turnType of ["chat", "automation", "subagent"] as const) {
      expect(admittedNames(tools, { turnType })).toEqual(["work"]);
    }
  });

  test("trims the catalog to what the turn type admits", async () => {
    const tools = admissionRegistry();
    tools.register(work);
    tools.register(chatOnly);
    tools.register(automationOnly);

    expect(admittedNames(tools, { turnType: "chat" })).toEqual([
      "work",
      "send_to_user",
    ]);
    expect(admittedNames(tools, { turnType: "automation" })).toEqual([
      "work",
      "wake_parent",
    ]);
  });

  test("bounds a tool declaration by the manifest ceiling", async () => {
    const tools = admissionRegistry();
    tools.register(work, { admissionCeiling: ["automation"] });
    tools.register(chatOnly, {
      admissionCeiling: ["automation", "subagent"],
    });

    expect(admittedNames(tools, { turnType: "chat" })).toEqual([]);
    expect(admittedNames(tools, { turnType: "automation" })).toEqual(["work"]);
  });

  test("denies an out-of-admission call without executing it", async () => {
    let executions = 0;
    const tools = admissionRegistry();
    tools.register({
      ...chatOnly,
      execute: () => {
        executions += 1;
        return Promise.resolve({ content: "sent", isError: false });
      },
    });

    const denied = await tools.prepare(
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

    const ready = await tools.prepare(
      { id: "provider-call", name: "send_to_user", input: {} },
      contextFor("send_to_user", "chat"),
    );
    expect(ready.kind).toBe("ready");
  });

  test("denies a call the manifest ceiling excludes even when the tool allows it", async () => {
    const tools = admissionRegistry();
    tools.register(chatOnly, { admissionCeiling: ["automation"] });
    const denied = await tools.prepare(
      { id: "provider-call", name: "send_to_user", input: {} },
      contextFor("send_to_user", "chat"),
    );
    expect(denied.kind).toBe("denied");
  });

  test("carries endsTurn through execution", async () => {
    const tools = admissionRegistry();
    tools.register({
      name: "hand_off",
      description: "Ends the Turn.",
      inputSchema: { type: "object" },
      execute: () =>
        Promise.resolve({
          content: "handed off",
          isError: false,
          endsTurn: true,
        }),
    });
    const context = contextFor("hand_off", "automation");
    const preparation = await tools.prepare(
      { id: "provider-call", name: "hand_off", input: {} },
      context,
    );
    if (preparation.kind !== "ready") throw new Error("tool was denied");
    expect(await tools.executePrepared(preparation, context)).toEqual({
      content: "handed off",
      isError: false,
      endsTurn: true,
    });
  });
  // -------------------------------------------------------------------------
  // The second ceiling dimension: the subagent role.
  //
  // The registry treats a role exactly as it treats a turn type — an opaque
  // string a registration may narrow itself by. It reads no meaning into
  // "browserUse"; it only intersects declaration with manifest ceiling and
  // filters.
  // -------------------------------------------------------------------------

  const desktop: ToolDefinition = {
    name: "computer_exec",
    description: "Runs a shell command on the Computer.",
    inputSchema: { type: "object" },
    admission: {
      turnTypes: ["chat", "automation", "subagent"],
      subagentRoles: ["executor", "computerUse"],
    },
    execute: () => Promise.resolve({ content: "ran", isError: false }),
  };
  const browser: ToolDefinition = {
    name: "computer_browser",
    description: "Drives the browser on the Computer.",
    inputSchema: { type: "object" },
    admission: {
      turnTypes: ["chat", "automation", "subagent"],
      subagentRoles: ["executor", "browserUse", "computerUse"],
    },
    execute: () => Promise.resolve({ content: "snapshot", isError: false }),
  };

  test("a turn that names no role is narrowed by no role", async () => {
    const tools = admissionRegistry();
    tools.register(work);
    tools.register(desktop);
    expect(admittedNames(tools, { turnType: "chat" })).toEqual([
      "work",
      "computer_exec",
    ]);
  });

  test("trims the catalog to what the subagent role admits", async () => {
    const tools = admissionRegistry();
    tools.register(work);
    tools.register(desktop);
    tools.register(browser);

    expect(
      admittedNames(tools, {
        turnType: "subagent",
        subagentRole: "browserUse",
      }),
    ).toEqual(["work", "computer_browser"]);
    expect(
      admittedNames(tools, {
        turnType: "subagent",
        subagentRole: "computerUse",
      }),
    ).toEqual(["work", "computer_exec", "computer_browser"]);
    expect(
      admittedNames(tools, {
        turnType: "subagent",
        subagentRole: "watchVideo",
      }),
    ).toEqual(["work"]);
  });

  test("bounds a role declaration by the manifest role ceiling", async () => {
    const tools = admissionRegistry();
    tools.register(browser, { subagentRoleCeiling: ["executor"] });
    expect(
      admittedNames(tools, {
        turnType: "subagent",
        subagentRole: "browserUse",
      }),
    ).toEqual([]);
    expect(
      admittedNames(tools, {
        turnType: "subagent",
        subagentRole: "executor",
      }),
    ).toEqual(["computer_browser"]);
  });

  test("denies a call a role was never offered, without executing it", async () => {
    let executions = 0;
    const tools = admissionRegistry();
    tools.register({
      ...desktop,
      execute: () => {
        executions += 1;
        return Promise.resolve({ content: "ran", isError: false });
      },
    });
    const preparation = await tools.prepare(
      { id: "provider-call", name: "computer_exec", input: {} },
      {
        ...contextFor("computer_exec", "subagent"),
        subagentRole: "browserUse",
      },
    );
    expect(preparation.kind).toBe("denied");
    if (preparation.kind !== "denied") throw new Error("expected a denial");
    expect(preparation.result.isError).toBe(true);
    expect(preparation.result.content).toContain("browserUse");
    expect(executions).toBe(0);
  });
});
