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

function context(
  effectId = "effect-1",
  turnType: ToolExecutionContext["turnType"] = "chat",
): ToolExecutionContext {
  return {
    botId: "bot",
    agentId: "bot",
    sessionId: "session",
    compositionGenerationId: "generation",
    effectId,
    turnType,
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
  permitConnection?: () => Promise<boolean>;
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
    ...(options.permitConnection
      ? { permitConnection: options.permitConnection }
      : {}),
  });
  if (feature) await root.mount(feature);
  return { root, requests, feature };
}

async function run(
  root: Awaited<ReturnType<typeof mount>>["root"],
  c: ToolCall,
  turnType: ToolExecutionContext["turnType"] = "chat",
) {
  const prepared = await root.tools.prepare(c, context("effect-1", turnType));
  if (prepared.kind === "denied") return prepared.result;
  return root.tools.executePrepared(prepared, context("effect-1", turnType));
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

  test("a revoked Connection refuses the call the admitted snapshot still names", async () => {
    const { root, requests } = await mount({
      respond: (url) =>
        url.pathname.endsWith("/tools")
          ? Response.json(TOOL_LIST)
          : Response.json({
              successful: true,
              data: { id: "msg_1" },
              error: null,
            }),
      permitConnection: async () => false,
    });
    const result = await run(
      root,
      call("gmail", "send_email", { to: "a@example.com", body: "hi" }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("revoked");
    expect(
      requests.some((entry) => entry.url.pathname.includes("/execute/")),
    ).toBe(false);
    await root.dispose();
  });

  test("registers the app's namespace with its tools, and executes one", async () => {
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
    // The tools are absent from the native schema list: disclosed on request.
    expect(root.tools.schemas({ turnType: "chat" }).map((s) => s.name)).toEqual(
      ["batch", "get_dynamic_tools", "call_dynamic_tool"],
    );
    expect(requests).toHaveLength(0);
    expect(root.tools.registeredNames?.()).not.toContain("gmail/send_email");
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
    expect(root.tools.registeredNames?.()).toContain("gmail/send_email");
    await root.dispose();
  });

  test("listing namespaces does not ask the provider for schemas", async () => {
    const { root, requests } = await mount({
      respond: () => Response.json(TOOL_LIST),
    });
    const listed = await run(root, {
      id: "list",
      name: "get_dynamic_tools",
      input: {},
    });
    expect(listed.isError).toBe(false);
    expect(listed.content).toContain("gmail");
    expect(requests).toHaveLength(0);
    await root.dispose();
  });

  test("answers a voice or Bot-to-Bot question with the app's tools too", async () => {
    // A question handed over from the voice session or another Bot runs as an
    // `agent` Turn. It is work like any automation Turn and gets the same
    // tools: refusing them here is what made a Bot on a call report that its
    // mailbox had been disconnected.
    const { root, requests } = await mount({
      respond: (url) =>
        url.pathname.endsWith("/tools")
          ? Response.json(TOOL_LIST)
          : Response.json({
              successful: true,
              data: { id: "msg_2" },
              error: null,
            }),
    });
    const result = await run(
      root,
      call("gmail", "send_email", { to: "a@example.com", body: "hi" }),
      "agent",
    );
    expect(result).toEqual({
      content: JSON.stringify({ id: "msg_2" }),
      isError: false,
    });
    expect(
      requests.some((r) => r.url.pathname.includes("/tools/execute/")),
    ).toBe(true);
    await root.dispose();
  });

  test("pins each tool's schema for the Turn so a remount keeps it", async () => {
    const pinned = new Map<string, unknown>();
    const first = await mount({
      respond: () => Response.json(TOOL_LIST),
      pinned,
    });
    expect(first.requests).toHaveLength(0);
    const read = await run(first.root, {
      id: "disclose",
      name: "get_dynamic_tools",
      input: { namespace: "gmail", toolName: "send_email" },
    });
    expect(read.isError).toBe(false);
    expect(first.requests).toHaveLength(1);
    expect([...pinned.keys()]).toEqual(["connection-1/send_email"]);
    const second = await mount({
      respond: () => {
        throw new Error("provider must not be asked again");
      },
      pinned,
    });
    const disclosed = await run(second.root, {
      id: "disclose-again",
      name: "get_dynamic_tools",
      input: { namespace: "gmail", toolName: "send_email" },
    });
    expect(second.requests).toHaveLength(0);
    expect(disclosed.isError).toBe(false);
    expect(disclosed.content).toContain("send_email");
    expect(second.root.tools.registeredNames?.()).toContain("gmail/send_email");
  });

  test("reads one tool from the account catalog, never the whole app", async () => {
    const asked: (string | undefined)[] = [];
    const root = createAgentRuntimeHarness();
    const feature = createConfiguredConnectRuntimeContribution({
      capability: CAPABILITY,
      userId: "tim",
      connection: CONNECTION,
      apiKey: "project-key",
      fetch: () => Promise.reject(new Error("provider must not be asked")),
      readAccountCatalog: (toolName) => {
        asked.push(toolName);
        return Promise.resolve(
          toolName === undefined
            ? {
                kind: "directory",
                tools: [
                  { name: "send_email", description: "Sends an email." },
                  { name: "list_labels", description: "Lists labels." },
                ],
              }
            : toolName === "send_email"
              ? {
                  kind: "catalog",
                  catalog: {
                    schemaVersion: 1,
                    toolkitSlug: "gmail",
                    tools: [
                      {
                        slug: "GMAIL_SEND_EMAIL",
                        name: "send_email",
                        description: "Sends an email.",
                        inputSchema: { type: "object", properties: {} },
                        version: "v1",
                      },
                    ],
                  },
                }
              : { kind: "unavailable", message: "No such tool here." },
        );
      },
    });
    await root.mount(feature!);
    const listed = await run(root, {
      id: "list",
      name: "get_dynamic_tools",
      input: { namespace: "gmail" },
    });
    expect(listed.content).toContain("list_labels");
    const read = await run(root, {
      id: "read",
      name: "get_dynamic_tools",
      input: { namespace: "gmail", toolName: "send_email" },
    });
    expect(read.content).toContain("inputSchema");
    const missing = await run(root, {
      id: "missing",
      name: "get_dynamic_tools",
      input: { namespace: "gmail", toolName: "fly" },
    });
    expect(missing).toEqual({ content: "No such tool here.", isError: true });
    expect(asked).toEqual([undefined, "send_email", "fly"]);
    await root.dispose();
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
