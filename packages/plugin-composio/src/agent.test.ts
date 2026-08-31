import { afterEach, describe, expect, test } from "bun:test";
import { type SessionEvent, SessionStore } from "@frockbot/kernel-contracts";
import { ToolRegistry } from "@frockbot/plugin-tools";
import { Context } from "cordis";
import { createComposioRouterPlugin } from "./agent.js";
import { ComposioClient } from "./composio-client.js";

const roots: Context[] = [];

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
      sessionId: "user-1:primary",
      effectId: "tool:1:1:0",
      signal: new AbortController().signal,
    };

    const invented = await root.tools.prepare(
      {
        id: "invented",
        name: "composio_execute_tool",
        input: { toolSlug: "GMAIL_FETCH_EMAILS", arguments: {} },
      },
      context,
    );
    if (invented.kind !== "ready") throw new Error("execute tool was denied");
    expect(await root.tools.executePrepared(invented, context)).toMatchObject({
      isError: true,
    });
    expect(calls).toEqual([]);

    const search = await root.tools.prepare(
      {
        id: "search",
        name: "composio_search_tools",
        input: { query: "fetch emails" },
      },
      context,
    );
    if (search.kind !== "ready") throw new Error("search tool was denied");
    expect(await root.tools.executePrepared(search, context)).toMatchObject({
      isError: false,
    });

    const exact = await root.tools.prepare(
      {
        id: "exact",
        name: "composio_execute_tool",
        input: { toolSlug: "GMAIL_FETCH_EMAILS", arguments: {} },
      },
      context,
    );
    if (exact.kind !== "ready") throw new Error("execute tool was denied");
    expect(await root.tools.executePrepared(exact, context)).toMatchObject({
      isError: false,
    });
    expect(calls).toHaveLength(2);
    expect(authorizationCalls).toBe(2);
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
            name: "composio_search_tools",
            input: {},
          },
        ],
      },
      {
        type: "tool/call",
        turn: 1,
        step: 1,
        occurrenceId: "tool:1:1:0",
        name: "composio_search_tools",
        input: {},
      },
      {
        type: "tool/result",
        turn: 1,
        step: 1,
        occurrenceId: "tool:1:1:0",
        name: "composio_search_tools",
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
      sessionId: "resumed-session",
      effectId: "tool:1:1:1",
      signal: new AbortController().signal,
    };
    const execution = await root.tools.prepare(
      {
        id: "execute-after-eviction",
        name: "composio_execute_tool",
        input: { toolSlug: "GMAIL_FETCH_EMAILS", arguments: {} },
      },
      context,
    );
    if (execution.kind !== "ready") throw new Error("execute tool was denied");

    await expect(
      root.tools.executePrepared(execution, context),
    ).resolves.toMatchObject({ isError: false });
    expect(calls).toHaveLength(1);
  });
});
