import { afterEach, describe, expect, test } from "bun:test";
import { type SessionEvent, SessionStore } from "@frockbot/kernel-contracts";
import { ToolRegistry } from "@frockbot/plugin-tools";
import { Context } from "cordis";
import {
  composioNamespaceV1,
  createComposioPlugin,
  createComposioRouterPlugin,
} from "./agent.js";
import { ComposioClient } from "./composio-client.js";

const roots: Context[] = [];
const namespace = composioNamespaceV1("gmail", "ca_123");

function dynamicCall(
  id: string,
  toolName: string,
  arguments_: Record<string, unknown>,
) {
  return {
    id,
    name: "call_dynamic_tool",
    input: {
      namespace,
      toolName,
      arguments: arguments_,
      mcpDetails: { description: `Use ${toolName} for this test.` },
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => root.fiber.dispose()));
});

describe("Composio router Plugin", () => {
  test("refuses invented slugs until search returns the exact tool", async () => {
    const calls: string[] = [];
    let authorizationCalls = 0;
    const client = new ComposioClient({
      apiKey: "secret",
      fetch: (input) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("/tools?")) {
          return Promise.resolve(
            Response.json({
              items: [
                {
                  slug: "GMAIL_FETCH_EMAILS",
                  name: "Fetch emails",
                  description: "Fetch Gmail messages",
                },
              ],
            }),
          );
        }
        return Promise.resolve(Response.json({ data: { messages: [] } }));
      },
    });
    const root = new Context();
    roots.push(root);
    await root.plugin(SessionStore);
    await root.plugin(ToolRegistry);
    await root.plugin(
      createComposioRouterPlugin({
        client,
        userId: "user-1",
        toolkitSlug: "gmail",
        authorizeEffect: () => {
          authorizationCalls += 1;
          return Promise.resolve({
            connectedAccountId: "ca_123",
            toolkitSlug: "gmail",
          });
        },
      }),
    );
    const context = {
      botId: "primary",
      agentId: "primary",
      compositionGenerationId: "bootstrap",
      turnType: "chat" as const,
      sessionId: "user-1:primary",
      effectId: "tool:1:1:0",
      signal: new AbortController().signal,
    };

    const invented = await root.tools.prepare(
      dynamicCall("invented", "composio_execute_tool", {
        toolSlug: "GMAIL_FETCH_EMAILS",
        arguments: {},
      }),
      context,
    );
    if (invented.kind !== "ready") throw new Error("execute tool was denied");
    expect(await root.tools.executePrepared(invented, context)).toMatchObject({
      isError: true,
    });
    expect(calls).toEqual([]);

    const search = await root.tools.prepare(
      dynamicCall("search", "composio_search_tools", {
        query: "fetch emails",
      }),
      context,
    );
    if (search.kind !== "ready") throw new Error("search tool was denied");
    expect(await root.tools.executePrepared(search, context)).toMatchObject({
      isError: false,
    });

    const exact = await root.tools.prepare(
      dynamicCall("exact", "composio_execute_tool", {
        toolSlug: "GMAIL_FETCH_EMAILS",
        arguments: {},
      }),
      context,
    );
    if (exact.kind !== "ready") throw new Error("execute tool was denied");
    expect(await root.tools.executePrepared(exact, context)).toMatchObject({
      isError: false,
    });
    expect(calls).toHaveLength(2);
    expect(authorizationCalls).toBe(3);
  });

  test("restores searched slug authorization from the durable session", async () => {
    const timestamp = "2026-08-28T00:00:00.000Z";
    const durableEvents = [
      {
        type: "session/created",
        createdAt: timestamp,
      },
      {
        type: "assistant/message",
        turn: 1,
        step: 1,
        requestId: "search-request",
        text: "",
        toolCalls: [
          {
            id: "search-before-eviction",
            name: "call_dynamic_tool",
            input: dynamicCall(
              "search-before-eviction",
              "composio_search_tools",
              {},
            ).input,
          },
        ],
      },
      {
        type: "tool/call",
        turn: 1,
        step: 1,
        occurrenceId: "tool:1:1:0",
        name: "call_dynamic_tool",
        input: dynamicCall(
          "search-before-eviction",
          "composio_search_tools",
          {},
        ).input,
      },
      {
        type: "tool/result",
        turn: 1,
        step: 1,
        occurrenceId: "tool:1:1:0",
        name: "call_dynamic_tool",
        content: JSON.stringify([
          {
            slug: "GMAIL_FETCH_EMAILS",
            name: "Fetch emails",
            description: "Fetch Gmail messages",
          },
        ]),
        isError: false,
        status: "completed",
      },
    ].map((event, seq) => ({ ...event, seq, timestamp })) as SessionEvent[];
    const calls: string[] = [];
    const client = new ComposioClient({
      apiKey: "secret",
      fetch: (input) => {
        calls.push(String(input));
        return Promise.resolve(Response.json({ data: { messages: [] } }));
      },
    });
    const root = new Context();
    roots.push(root);
    await root.plugin(SessionStore, {
      initialSessions: { "resumed-session": durableEvents },
    });
    root.sessions.create("resumed-session");
    await root.plugin(ToolRegistry);
    await root.plugin(
      createComposioRouterPlugin({
        client,
        userId: "user-1",
        toolkitSlug: "gmail",
        authorizeEffect: () =>
          Promise.resolve({
            connectedAccountId: "ca_123",
            toolkitSlug: "gmail",
          }),
      }),
    );
    const context = {
      botId: "primary",
      agentId: "primary",
      compositionGenerationId: "bootstrap",
      turnType: "chat" as const,
      sessionId: "resumed-session",
      effectId: "tool:1:1:1",
      signal: new AbortController().signal,
    };
    const execution = await root.tools.prepare(
      dynamicCall("execute-after-eviction", "composio_execute_tool", {
        toolSlug: "GMAIL_FETCH_EMAILS",
        arguments: {},
      }),
      context,
    );
    if (execution.kind !== "ready") throw new Error("execute tool was denied");

    await expect(
      root.tools.executePrepared(execution, context),
    ).resolves.toMatchObject({ isError: false });
    expect(calls).toHaveLength(1);
  });

  test("derives a stable GrokBot-style namespace from toolkit and account", () => {
    expect(composioNamespaceV1("github", "acct_acme-42")).toBe(
      "user-Github--acct-acme-42",
    );
  });

  test("registers static per-tool integrations under the account namespace", async () => {
    const root = new Context();
    roots.push(root);
    await root.plugin(ToolRegistry);
    await root.plugin(
      createComposioPlugin({
        client: new ComposioClient({ apiKey: "secret" }),
        userId: "user-1",
        toolkitSlug: "github",
        connectedAccountId: "acct_acme-42",
        tools: [
          {
            slug: "GITHUB_SEARCH_ISSUES",
            name: "search_issues",
            description: "Search issues.",
            inputSchema: { type: "object" },
          },
        ],
      }),
    );

    expect(root.tools.registeredNames?.()).toContain(
      "user-Github--acct-acme-42/search_issues",
    );
    const call = {
      id: "static",
      name: "call_dynamic_tool",
      input: {
        namespace: "user-Github--acct-acme-42",
        toolName: "search_issues",
      },
    };
    const preparation = await root.tools.prepare(call, {
      botId: "primary",
      agentId: "primary",
      compositionGenerationId: "bootstrap",
      turnType: "chat",
      sessionId: "user-1:primary",
      effectId: "tool:1:1:0",
      signal: new AbortController().signal,
    });
    expect(preparation).toMatchObject({
      kind: "denied",
      result: {
        content:
          'External namespace "user-Github--acct-acme-42" requires mcpDetails.description',
      },
    });
  });
});
