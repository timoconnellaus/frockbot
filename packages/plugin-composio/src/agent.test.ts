import { test, expect } from "bun:test";
import { Context } from "cordis";
import { ToolRegistry } from "@frockbot/plugin-tools";
import { createConfiguredComposioRuntimeContribution } from "./agent.js";
import { decodeConnectedToolsV1 } from "./tool-contracts.js";

const catalog = {
  schemaVersion: 1,
  namespace: "gmail--account-one",
  label: "Gmail — Work",
  tools: [
    {
      name: "GMAIL_FETCH_EMAILS",
      description: "Read email",
      version: "20260905_00",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" } },
      },
    },
  ],
};

test("every Bot receives the same account namespace, only through progressive disclosure", async () => {
  const requests: unknown[] = [];
  for (const botId of ["first-bot", "second-bot"]) {
    const root = new Context();
    await root.plugin(ToolRegistry);
    const plugin = await createConfiguredComposioRuntimeContribution({
      capability: {
        packageId: "composio",
        capabilityId: "app-tools",
        connectionId: "account-one",
      },
      composioRequest: async (value) => {
        requests.push(value);
        return (value as { operation: string }).operation === "list-tools"
          ? catalog
          : { content: '{"messages":[]}', isError: false };
      },
    });
    if (!plugin) throw new Error("Expected account tools");
    await root.plugin(plugin);
    try {
      expect(
        root.tools.schemas({ turnType: "chat" }).map((tool) => tool.name),
      ).toEqual(["get_dynamic_tools", "call_dynamic_tool"]);
      const call = {
        id: "call-one",
        name: "call_dynamic_tool",
        input: {
          namespace: catalog.namespace,
          toolName: "GMAIL_FETCH_EMAILS",
          arguments: { query: "unread" },
          mcpDetails: { description: "Read my recent email" },
        },
      };
      const context = {
        botId,
        agentId: botId,
        sessionId: `session-${botId}`,
        compositionGenerationId: "generation-one",
        turnType: "chat" as const,
        effectId: "tool:1:1:0",
        toolCall: call,
        signal: new AbortController().signal,
      };
      const prepared = await root.tools.prepare(call, context);
      if (prepared.kind !== "ready")
        throw new Error("Expected prepared dynamic call");
      expect(prepared.idempotent).toBe(false);
      expect(await root.tools.executePrepared(prepared, context)).toMatchObject(
        { isError: false },
      );
      expect(
        await root.tools.reconcilePrepared(prepared, context),
      ).toMatchObject({ status: "unavailable" });
      const cancelled = new AbortController();
      cancelled.abort();
      expect(
        await root.tools.executePrepared(prepared, {
          ...context,
          signal: cancelled.signal,
        }),
      ).toMatchObject({ isError: true });
    } finally {
      await root.fiber.dispose();
    }
  }
  expect(
    requests.filter(
      (value) => (value as { operation: string }).operation === "execute-tool",
    ),
  ).toHaveLength(2);
  expect(JSON.stringify(requests)).not.toMatch(
    /API_KEY|connected_account_id|composio_execute|composio_search/,
  );
});
test("malformed or unversioned provider definitions never mount", () => {
  expect(() =>
    decodeConnectedToolsV1({
      ...catalog,
      tools: [{ ...catalog.tools[0], version: "latest" }],
    }),
  ).toThrow("definition");
  expect(() =>
    decodeConnectedToolsV1({
      ...catalog,
      tools: [catalog.tools[0], catalog.tools[0]],
    }),
  ).toThrow("definition");
});
test("an ungranted capability advertises no tool", async () => {
  expect(
    await createConfiguredComposioRuntimeContribution({
      capability: { packageId: "composio", capabilityId: "app-tools" },
    }),
  ).toBeUndefined();
});
