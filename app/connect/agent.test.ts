import { describe, expect, test } from "bun:test";
import { createAgentRuntimeHarness } from "@frockbot/app/testkit";
import type { ToolCall, ToolExecutionContext } from "@frockbot/core/contracts";
import type { ConnectionView } from "@frockbot/core/configuration";
import { createConfiguredConnectRuntimeContribution } from "./agent.js";

const CONNECTION: ConnectionView = {
  connectionId: "connection-1",
  packageId: "connect",
  connectionTypeId: "connect-gmail",
  displayName: "Gmail",
  state: "ready",
  generation: "g1",
  safeMetadata: {
    toolkitSlug: "gmail",
    toolkitName: "Gmail",
    connectedAccountId: "ca_1",
    namespace: "gmail",
    startedAt: "2026-09-11T00:00:00.000Z",
  },
};

const CAPABILITY = {
  packageId: "connect",
  capabilityId: "connect-gmail-tools",
  connectionId: "connection-1",
};

function context(effectId = "effect-1"): ToolExecutionContext {
  return {
    botId: "bot",
    agentId: "bot",
    sessionId: "session",
    compositionGenerationId: "generation",
    effectId,
    turnType: "chat",
    signal: new AbortController().signal,
  };
}

function call(
  namespace: string,
  toolName: string,
  args: unknown,
  id = "call-1",
): ToolCall {
  return {
    id,
    name: "call_dynamic_tool",
    input: { namespace, toolName, arguments: args },
  };
}

const TOOL_LIST = {
  items: [
    {
      slug: "GMAIL_SEND_EMAIL",
      name: "Send email",
      description: "Sends an email.",
      version: "20250930_00",
      toolkit: { slug: "gmail" },
      input_parameters: {
        type: "object",
        properties: { to: { type: "string" }, body: { type: "string" } },
        required: ["to"],
      },
    },
  ],
  next_cursor: null,
};

async function mount(options: {
  respond: (url: URL, init: RequestInit | undefined) => Response;
  connection?: ConnectionView;
  apiKey?: string;
  pinned?: Map<string, unknown>;
}) {
  const requests: { url: URL; init: RequestInit | undefined }[] = [];
  const root = createAgentRuntimeHarness();
  const feature = createConfiguredConnectRuntimeContribution({
    capability: CAPABILITY,
    userId: "tim",
    connection: options.connection ?? CONNECTION,
    apiKey: options.apiKey ?? "project-key",
    fetch: (input, init) => {
      const entry = { url: new URL(String(input)), init };
      requests.push(entry);
      return Promise.resolve(options.respond(entry.url, init));
    },
    ...(options.pinned
      ? {
          pinToolCatalog: async (connectionId, read) => {
            const existing = options.pinned!.get(connectionId);
            if (existing !== undefined) return existing;
            const value = await read();
            options.pinned!.set(connectionId, value);
            return value;
          },
        }
      : {}),
  });
  if (feature) await root.mount(feature);
  return { root, requests, feature };
}

async function run(
  root: Awaited<ReturnType<typeof mount>>["root"],
  c: ToolCall,
) {
  const prepared = await root.tools.prepare(c, context());
  if (prepared.kind === "denied") return prepared.result;
  return root.tools.executePrepared(prepared, context());
}

describe("a connected app in a Bot's Turn", () => {
  test("mounts nothing for a Connection that is not ready, or without a key", async () => {
    const none = await mount({
      respond: () => Response.json(TOOL_LIST),
      connection: { ...CONNECTION, state: "disabled" },
    });
    expect(none.feature).toBeUndefined();
    const keyless = await mount({
      respond: () => Response.json(TOOL_LIST),
      apiKey: "",
    });
    expect(keyless.feature).toBeUndefined();
  });

  test("registers the app's namespace with its important tools, and executes one", async () => {
    const { root, requests } = await mount({
      respond: (url) =>
        url.pathname.endsWith("/tools")
          ? Response.json(TOOL_LIST)
          : Response.json({
              successful: true,
              data: { id: "msg_1" },
              error: null,
            }),
    });
    expect(root.tools.registeredNames?.()).toContain("gmail/send_email");
    // The tools are absent from the native schema list: disclosed on request.
    expect(root.tools.schemas({ turnType: "chat" }).map((s) => s.name)).toEqual(
      ["get_dynamic_tools", "call_dynamic_tool"],
    );
    const result = await run(
      root,
      call("gmail", "send_email", { to: "a@example.com", body: "hi" }),
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content)).toEqual({ id: "msg_1" });
    const execute = requests.find((r) =>
      r.url.pathname.includes("/tools/execute/"),
    )!;
    expect(execute.url.pathname).toBe(
      "/api/v3.1/tools/execute/GMAIL_SEND_EMAIL",
    );
    expect(JSON.parse(String(execute.init?.body))).toEqual({
      user_id: "tim",
      connected_account_id: "ca_1",
      arguments: { to: "a@example.com", body: "hi" },
      version: "20250930_00",
    });
    await root.dispose();
  });

  test("reads the catalog through the Turn's pin so a remount keeps its schemas", async () => {
    const pinned = new Map<string, unknown>();
    const first = await mount({
      respond: () => Response.json(TOOL_LIST),
      pinned,
    });
    expect(first.requests).toHaveLength(1);
    const second = await mount({
      respond: () => {
        throw new Error("provider must not be asked again");
      },
      pinned,
    });
    expect(second.requests).toHaveLength(0);
    expect(second.root.tools.registeredNames?.()).toContain("gmail/send_email");
  });

  test("a refusal from the app is an error the model can act on", async () => {
    const { root } = await mount({
      respond: (url) =>
        url.pathname.endsWith("/tools")
          ? Response.json(TOOL_LIST)
          : Response.json({
              successful: false,
              data: {},
              error: "recipient is required",
            }),
    });
    const result = await run(root, call("gmail", "send_email", {}));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("recipient is required");
  });

  test("a failure after dispatch says the outcome is unknown, never to retry", async () => {
    const { root } = await mount({
      respond: (url) =>
        url.pathname.endsWith("/tools")
          ? Response.json(TOOL_LIST)
          : new Response("", { status: 502 }),
    });
    const result = await run(root, call("gmail", "send_email", { to: "x" }));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Do not repeat it");
  });

  test("an unreachable provider mounts no tools and does not fail the Turn", async () => {
    const { root, feature } = await mount({
      respond: () => new Response("", { status: 503 }),
    });
    expect(feature).toBeDefined();
    expect(root.tools.registeredNames?.()).not.toContain("gmail/send_email");
    const result = await run(root, call("gmail", "send_email", { to: "x" }));
    expect(result.isError).toBe(true);
  });
});
