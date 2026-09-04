import { afterEach, describe, expect, test } from "bun:test";
import {
  type PromptAssemblyContext,
  type PromptSection,
  type ToolCall,
  type ToolDefinition,
  type ToolExecutionContext,
} from "@frockbot/kernel-contracts";
import { Context, Service } from "cordis";
import {
  CALL_DYNAMIC_TOOL_NAME,
  FROCKBOT_NAMESPACE_USE_INSTRUCTIONS,
  GET_DYNAMIC_TOOLS_NAME,
  ToolRegistry,
} from "./tools.js";

class PromptFixture extends Service {
  readonly sections = new Map<string, PromptSection>();

  constructor(ctx: Context) {
    super(ctx, "systemPrompt");
  }

  register(section: PromptSection): () => void {
    this.sections.set(section.id, section);
    return () => this.sections.delete(section.id);
  }

  async assemble(context: PromptAssemblyContext) {
    const sections = await Promise.all(
      [...this.sections.values()].map(async (section) => ({
        id: section.id,
        text: await section.render(context),
      })),
    );
    return {
      sections,
      text: sections
        .map(({ text }) => text.trim())
        .filter(Boolean)
        .join("\n\n"),
    };
  }
}

const roots: Context[] = [];

async function rootWithTools(prompt = false): Promise<Context> {
  const root = new Context();
  roots.push(root);
  if (prompt) await root.plugin(PromptFixture);
  await root.plugin(ToolRegistry);
  return root;
}

function contextFor(call: ToolCall): ToolExecutionContext {
  return {
    botId: "bot-1",
    agentId: "bot-1",
    sessionId: "user-1:bot-1",
    compositionGenerationId: "generation-1",
    effectId: "tool:1:1:0",
    toolCall: call,
    turnType: "chat",
    signal: new AbortController().signal,
  };
}

async function invoke(root: Context, name: string, input: unknown) {
  const call = { id: "call-1", name, input };
  const context = contextFor(call);
  const preparation = await root.tools.prepare(call, context);
  if (preparation.kind === "denied") return preparation.result;
  return root.tools.executePrepared(preparation, context);
}

function dynamicTool(
  namespace: string,
  name: string,
  description = `${namespace}/${name}`,
): ToolDefinition {
  return {
    namespace,
    name,
    description,
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
    },
    execute: (input) =>
      Promise.resolve({ content: JSON.stringify(input), isError: false }),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => root.fiber.dispose()));
});

describe("progressive tool disclosure", () => {
  test("keeps namespaced schemas hidden and always exposes the two meta-tools", async () => {
    const root = await rootWithTools();
    root.tools.register({
      name: "native_read",
      description: "Native.",
      inputSchema: { type: "object" },
      execute: () => Promise.resolve({ content: "read", isError: false }),
    });
    root.tools.register(dynamicTool("mail", "search"));

    expect(
      root.tools.schemas({ turnType: "chat" }).map(({ name }) => name),
    ).toEqual(["native_read", GET_DYNAMIC_TOOLS_NAME, CALL_DYNAMIC_TOOL_NAME]);
    expect(root.tools.registeredNames?.()).toEqual([
      CALL_DYNAMIC_TOOL_NAME,
      GET_DYNAMIC_TOOLS_NAME,
      "mail/search",
      "native_read",
    ]);
    const schemas = root.tools.schemas({ turnType: "chat" });
    for (const name of [GET_DYNAMIC_TOOLS_NAME, CALL_DYNAMIC_TOOL_NAME]) {
      const description = schemas.find(
        (schema) => schema.name === name,
      )?.description;
      expect(description).toContain(
        "IMPORTANT: Always call get_dynamic_tools for this namespace/tool before calling to ensure correct parameters.",
      );
      expect(description).toContain(
        "get_dynamic_tools({ namespace, toolName })",
      );
      expect(description).toContain("200 characters");
      expect(description).toContain("status is not ready");
    }
    expect(
      schemas.find(({ name }) => name === GET_DYNAMIC_TOOLS_NAME)?.inputSchema,
    ).toEqual({
      type: "object",
      properties: {
        namespace: {
          description: "Dynamic namespace to inspect, e.g. an MCP server.",
          type: "string",
        },
        pattern: {
          description:
            "RE2 regex pattern to search namespace and tool names (max 256 chars).",
          type: "string",
        },
        toolName: {
          description:
            "Tool name within the namespace. Requires namespace to be set.",
          type: "string",
        },
      },
    });
    expect(
      schemas.find(({ name }) => name === CALL_DYNAMIC_TOOL_NAME)?.inputSchema,
    ).toEqual({
      type: "object",
      properties: {
        arguments: {
          description:
            "Arguments to pass to the tool, as described by the tool descriptor.",
          type: "object",
        },
        mcpDetails: {
          description:
            "MCP-specific call metadata. Set only for external MCP namespaces; omit for frockbot.",
          type: "object",
          properties: {
            description: { type: "string" },
            requestSmartModeApproval: { type: "boolean" },
            smartModeBlockReason: { type: "string" },
          },
          required: ["description"],
        },
        namespace: { type: "string" },
        toolName: { type: "string" },
      },
      required: ["namespace", "toolName"],
    });
  });

  test("returns catalog, pattern, namespace, and single-tool forms", async () => {
    const root = await rootWithTools();
    const longDescription = "x".repeat(201);
    root.tools.registerNamespace({
      name: "mail",
      description: "Mail namespace",
      status: "ready",
    });
    root.tools.register(dynamicTool("mail", "search_threads", longDescription));
    root.tools.register(dynamicTool("mail", "send_message"));
    root.tools.register(dynamicTool("calendar", "search_events"));

    const catalogResult = await invoke(root, GET_DYNAMIC_TOOLS_NAME, {});
    expect(catalogResult.isError).toBe(false);
    const catalog = JSON.parse(catalogResult.content);
    expect(catalog).toMatchObject({
      mode: "catalog",
      namespaces: [
        {
          namespace: "calendar",
          tools: [{ tool: "search_events" }],
        },
        {
          namespace: "mail",
          namespaceDescription: "Mail namespace",
          namespaceStatus: "ready",
        },
      ],
    });
    const truncated = catalog.namespaces[1].tools.find(
      (tool: { tool: string }) => tool.tool === "search_threads",
    ).description as string;
    expect([...truncated]).toHaveLength(200);
    expect(truncated.endsWith("... [truncated]")).toBe(true);
    expect(catalogResult.content).not.toContain("inputSchema");
    expect(await invoke(root, GET_DYNAMIC_TOOLS_NAME, undefined)).toEqual(
      catalogResult,
    );

    const pattern = JSON.parse(
      (
        await invoke(root, GET_DYNAMIC_TOOLS_NAME, {
          pattern: "threads|calendar",
        })
      ).content,
    );
    expect(pattern.namespaces).toEqual([
      expect.objectContaining({
        namespace: "calendar",
        tools: [expect.objectContaining({ tool: "search_events" })],
      }),
      expect.objectContaining({
        namespace: "mail",
        tools: [expect.objectContaining({ tool: "search_threads" })],
      }),
    ]);

    const scopedPattern = JSON.parse(
      (
        await invoke(root, GET_DYNAMIC_TOOLS_NAME, {
          namespace: "mail",
          pattern: "send",
        })
      ).content,
    );
    expect(scopedPattern.namespaces[0].tools).toEqual([
      expect.objectContaining({ tool: "send_message" }),
    ]);

    const namespace = JSON.parse(
      (await invoke(root, GET_DYNAMIC_TOOLS_NAME, { namespace: "mail" }))
        .content,
    );
    expect(namespace.tools).toHaveLength(2);
    const threadSchema = namespace.tools.find(
      (tool: { tool: string }) => tool.tool === "search_threads",
    );
    expect(threadSchema).toEqual({
      tool: "search_threads",
      description: longDescription,
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
      },
    });

    const single = JSON.parse(
      (
        await invoke(root, GET_DYNAMIC_TOOLS_NAME, {
          namespace: "mail",
          toolName: "search_threads",
        })
      ).content,
    );
    // Plus the envelope the schema has to be wrapped in; see the dedicated
    // test below.
    expect(single).toMatchObject(threadSchema as Record<string, unknown>);
  });

  test("returns tool errors for invalid patterns and unknown lookups", async () => {
    const root = await rootWithTools();
    root.tools.register(dynamicTool("mail", "search"));

    for (const pattern of ["[", "(a+)+$", "x".repeat(257)]) {
      expect(
        await invoke(root, GET_DYNAMIC_TOOLS_NAME, { pattern }),
      ).toMatchObject({ isError: true });
    }
    expect(
      await invoke(root, GET_DYNAMIC_TOOLS_NAME, { namespace: "missing" }),
    ).toEqual({ content: "Namespace not found", isError: true });
    // A name that was not found says which names there are, so the model can
    // correct a spelling in one step instead of re-reading the catalogue.
    expect(
      await invoke(root, GET_DYNAMIC_TOOLS_NAME, {
        namespace: "mail",
        toolName: "missing",
      }),
    ).toEqual({
      content:
        'Tool not found: "missing" in namespace "mail". Tools in this namespace: search',
      isError: true,
    });
    expect(
      await invoke(root, GET_DYNAMIC_TOOLS_NAME, { toolName: "search" }),
    ).toEqual({ content: "toolName requires namespace", isError: true });
    expect(
      await invoke(root, CALL_DYNAMIC_TOOL_NAME, {
        namespace: "missing",
        toolName: "search",
      }),
    ).toEqual({
      content: 'Namespace not found: "missing". Available namespaces: mail',
      isError: true,
    });
    expect(
      await invoke(root, CALL_DYNAMIC_TOOL_NAME, {
        namespace: "mail",
        toolName: "missing",
      }),
    ).toEqual({
      content:
        'Tool not found: "missing" in namespace "mail". Tools in this namespace: search',
      isError: true,
    });
  });

  test("names the wrong field in a malformed call_dynamic_tool envelope", async () => {
    // F3: every one of these answered with the single string "Invalid input
    // for tool: call_dynamic_tool". The Bot re-read the schema twice, ran a
    // deliberate plumbing test against `echo`, failed identically, and spent
    // seven steps without authoring anything. These are the exact envelopes it
    // sent (user `packages-2`, Bot `smith-b867c90c`, run events seq 18-52).
    const root = await rootWithTools();
    root.tools.register(dynamicTool("mail", "search"));

    const recorded: Array<[unknown, string[]]> = [
      // `{"args": "<json string>", "packageId": …}`
      [
        { args: '{"text":"plumbing test"}', packageId: "frockbot" },
        [
          '"namespace" is missing — you sent "packageId"; the field is "namespace"',
          '"toolName" is missing; it must be a non-empty string',
          'the tool\'s own input goes in "arguments" as an object, not in "args"',
        ],
      ],
      // `{"args":"{\"text\":\"plumbing test\"}","name":"echo","namespace":"frockbot"}`
      [
        {
          args: '{"text":"plumbing test"}',
          name: "echo",
          namespace: "frockbot",
        },
        [
          '"toolName" is missing — you sent "name"; the field is "toolName"',
          'the tool\'s own input goes in "arguments" as an object, not in "args"',
        ],
      ],
      // The same mistake made with the right key: JSON text, not an object.
      [
        {
          namespace: "mail",
          toolName: "search",
          arguments: '{"value":"x"}',
        },
        [
          '"arguments" must be a JSON object, not a string — send the object itself, not JSON text',
        ],
      ],
      [
        "namespace=mail",
        [
          "call_dynamic_tool input is invalid: it must be an object, not a string",
        ],
      ],
    ];

    for (const [input, fragments] of recorded) {
      const result = await invoke(root, CALL_DYNAMIC_TOOL_NAME, input);
      expect(result.isError).toBe(true);
      for (const fragment of fragments) {
        expect(result.content).toContain(fragment);
      }
      // Always the worked envelope, so the next attempt has a shape to copy.
      expect(result.content).toContain(
        'Expected {"namespace":"<namespace>","toolName":"<tool>","arguments":',
      );
      expect(result.content).not.toBe(
        "Invalid input for tool: call_dynamic_tool",
      );
    }
  });

  test("single-tool discovery echoes the envelope the schema goes inside", async () => {
    // F3: `get_dynamic_tools({namespace, toolName})` returned the inner
    // `inputSchema` and nothing else, and the model then sent that inner shape
    // as the whole `call_dynamic_tool` input.
    const root = await rootWithTools();
    root.tools.register(dynamicTool("mail", "search"));
    const single = JSON.parse(
      (
        await invoke(root, GET_DYNAMIC_TOOLS_NAME, {
          namespace: "mail",
          toolName: "search",
        })
      ).content,
    ) as { namespace: string; callWith: unknown };

    expect(single.namespace).toBe("mail");
    expect(single.callWith).toEqual({
      tool: CALL_DYNAMIC_TOOL_NAME,
      input: {
        namespace: "mail",
        toolName: "search",
        arguments: "<an object matching inputSchema>",
      },
    });
  });

  test("prepares and executes the inner call through every registry hook", async () => {
    const root = await rootWithTools();
    const order: string[] = [];
    root.tools.register({
      ...dynamicTool("frockbot", "write_setup"),
      idempotent: true,
      execute: (input) => {
        order.push(`body:${JSON.stringify(input)}`);
        return Promise.resolve({ content: "written", isError: false });
      },
    });
    root.on("tools/pre-execute", async (call, _context, next) => {
      order.push(`pre:${call.name}`);
      return next();
    });
    root.on("tools/execute", async (call, _context, next) => {
      order.push(`execute:${call.name}`);
      return next();
    });
    root.on("tools/post-execute", async (call, _result, _context, next) => {
      order.push(`post:${call.name}`);
      return next();
    });
    root.on("tools/result", (call) => order.push(`result:${call.name}`));

    const outer: ToolCall = {
      id: "same-call-id",
      name: CALL_DYNAMIC_TOOL_NAME,
      input: {
        namespace: "frockbot",
        toolName: "write_setup",
        arguments: { value: "one" },
      },
    };
    const context = contextFor(outer);
    const preparation = await root.tools.prepare(outer, context);
    expect(preparation).toMatchObject({
      kind: "ready",
      idempotent: true,
      call: {
        id: "same-call-id",
        name: "write_setup",
        input: { value: "one" },
      },
    });
    if (preparation.kind !== "ready") throw new Error("call was denied");
    expect(await root.tools.executePrepared(preparation, context)).toEqual({
      content: "written",
      isError: false,
    });
    expect(order).toEqual([
      "pre:write_setup",
      "execute:write_setup",
      'body:{"value":"one"}',
      "post:write_setup",
      "result:write_setup",
    ]);
  });

  test("requires call metadata for external namespaces and blocks non-ready ones", async () => {
    const root = await rootWithTools();
    root.tools.registerNamespace({
      name: "mail",
      external: true,
      status: "ready",
    });
    root.tools.register(dynamicTool("mail", "search"));
    root.tools.registerNamespace({
      name: "calendar",
      external: true,
      status: "needsAuth",
    });
    root.tools.register(dynamicTool("calendar", "search"));

    expect(
      await invoke(root, CALL_DYNAMIC_TOOL_NAME, {
        namespace: "mail",
        toolName: "search",
        arguments: {},
      }),
    ).toEqual({
      content: 'External namespace "mail" requires mcpDetails.description',
      isError: true,
    });
    expect(
      await invoke(root, CALL_DYNAMIC_TOOL_NAME, {
        namespace: "mail",
        toolName: "search",
        arguments: { value: "ok" },
        mcpDetails: { description: "Search the connected mailbox" },
      }),
    ).toEqual({ content: '{"value":"ok"}', isError: false });
    expect(
      await invoke(root, CALL_DYNAMIC_TOOL_NAME, {
        namespace: "calendar",
        toolName: "search",
        mcpDetails: { description: "Search calendar" },
      }),
    ).toEqual({
      content: "Namespace is not ready: calendar (needsAuth)",
      isError: true,
    });
  });

  test("propagates an inner tool error as the meta-tool result", async () => {
    const root = await rootWithTools();
    root.tools.register({
      ...dynamicTool("frockbot", "fail"),
      execute: () =>
        Promise.resolve({ content: "inner failure", isError: true }),
    });

    expect(
      await invoke(root, CALL_DYNAMIC_TOOL_NAME, {
        namespace: "frockbot",
        toolName: "fail",
      }),
    ).toEqual({ content: "inner failure", isError: true });
  });

  test("renders an escaped prompt catalog and omits the block when empty", async () => {
    const root = await rootWithTools(true);
    expect(
      (root.systemPrompt as PromptFixture).assemble({
        sessionId: "session",
        provider: "provider",
        model: "model",
        turnType: "chat",
      }),
    ).resolves.toMatchObject({ text: "" });

    root.tools.registerNamespace({
      name: "mail&\"'work",
      status: "ready",
      useInstructions: 'Use <schema> & "call".\nThen invoke.',
    });
    root.tools.register(dynamicTool("mail&\"'work", 'search<"mail'));
    root.tools.register(dynamicTool("frockbot", "package_author"));
    const assembly = await root.systemPrompt.assemble({
      sessionId: "session",
      provider: "provider",
      model: "model",
      turnType: "chat",
    });

    expect(assembly.text).toBe(
      [
        "<dynamic_tool_catalog>",
        "These dynamic tool namespaces were available when this conversation started. Availability may have changed, so use get_dynamic_tools to check current state before calling call_dynamic_tool.",
        "",
        "<dynamic_tool_namespaces>",
        `<namespace name="frockbot" tools="package_author" namespaceUseInstructions="${FROCKBOT_NAMESPACE_USE_INSTRUCTIONS}" />`,
        '<namespace name="mail&amp;&quot;&apos;work" tools="search&lt;&quot;mail" namespaceUseInstructions="Use &lt;schema&gt; &amp; &quot;call&quot;.&#10;Then invoke." namespaceStatus="ready" />',
        "</dynamic_tool_namespaces>",
        "</dynamic_tool_catalog>",
      ].join("\n"),
    );
  });

  test("rejects duplicate namespace/tool identities but permits the same bare name elsewhere", async () => {
    const root = await rootWithTools();
    root.tools.register(dynamicTool("mail-one", "search"));
    root.tools.register(dynamicTool("mail-two", "search"));
    expect(() =>
      root.tools.register(dynamicTool("mail-one", "search")),
    ).toThrow('tool "mail-one/search" is already registered');
    root.tools.registerNamespace({ name: "mail-one" });
    expect(() => root.tools.registerNamespace({ name: "mail-one" })).toThrow(
      'tool namespace "mail-one" is already registered',
    );
  });
});

describe("a dynamic tool called by its bare name", () => {
  test("is answered with the envelope, not a dead-end Unknown tool", async () => {
    // `applet_list` is listed to the model by bare name in
    // `<dynamic_tool_namespaces>`, so the model reaches for it that way. The
    // refusal used to be `Unknown tool: applet_list` and nothing else — a dead
    // end for a tool that was right there.
    const root = await rootWithTools();
    root.tools.register(dynamicTool("applets", "applet_list"));

    const result = await invoke(root, "applet_list", {});

    expect(result.isError).toBe(true);
    expect(result.content).toContain("applet_list");
    expect(result.content).toContain(CALL_DYNAMIC_TOOL_NAME);
    expect(result.content).toContain(
      '{"namespace":"applets","toolName":"applet_list"',
    );
    expect(result.content).toContain(GET_DYNAMIC_TOOLS_NAME);
  });

  test("names every namespace the bare name is in", async () => {
    const root = await rootWithTools();
    root.tools.register(dynamicTool("mail-one", "search"));
    root.tools.register(dynamicTool("mail-two", "search"));

    const result = await invoke(root, "search", {});

    expect(result.isError).toBe(true);
    expect(result.content).toContain("mail-one");
    expect(result.content).toContain("mail-two");
  });

  test("a name in no namespace still says only that it is unknown", async () => {
    const root = await rootWithTools();
    root.tools.register(dynamicTool("applets", "applet_list"));

    const result = await invoke(root, "not_a_tool", {});

    expect(result.content).toBe("Unknown tool: not_a_tool");
  });
});
