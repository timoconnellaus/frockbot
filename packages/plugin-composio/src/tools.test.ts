import type { ComposioStorage } from "./user-configuration.js";
import { test, expect } from "bun:test";
import type { ConnectionView } from "@frockbot/configuration-core";
import { ComposioClient } from "./composio-client.js";
import { ConnectedAccountTools } from "./tools.js";

function fixture() {
  const values = new Map<string, unknown>();
  const storage: ComposioStorage = {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      if (typeof key === "string") values.set(key, value);
      else for (const [k, v] of Object.entries(key)) values.set(k, v);
    },
    setAlarm: async () => {},
    transaction: async <T>(
      fn: (tx: typeof storage) => Promise<T>,
    ): Promise<T> => fn(storage),
  };
  let state: ConnectionView["state"] = "ready",
    disabled = false,
    executions = 0,
    revokeDuringRead = false,
    failExecution = false;
  const connection = async (): Promise<ConnectionView> => {
    if (state !== "ready") throw new Error("This connection is unavailable");
    return {
      connectionId: "connection-one",
      packageId: "composio",
      connectionTypeId: "app",
      displayName: "Work",
      generation: state,
      state,
      safeMetadata: {
        connectedAccountId: "ca_private",
        toolkitSlug: "gmail",
        toolkitName: "Gmail",
      },
    };
  };
  const client = new ComposioClient({
    apiKey: "private-key",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/connected_accounts/ca_private")) {
        if (revokeDuringRead) state = "revoked";
        return Response.json({
          id: "ca_private",
          user_id: "owner",
          status: "ACTIVE",
          is_disabled: disabled,
          toolkit: { slug: "gmail" },
          auth_config: { id: "ac_private" },
        });
      }
      if (url.pathname.endsWith("/tools")) {
        expect(url.searchParams.get("toolkit_slug")).toBe("gmail");
        expect(url.searchParams.get("auth_config_ids")).toBe("ac_private");
        return Response.json({
          items: [
            {
              slug: "GMAIL_FETCH_EMAILS",
              description: "Read email",
              toolkit: { slug: "gmail" },
              version: "20260905_00",
              input_parameters: { query: { type: "string", required: true } },
            },
          ],
        });
      }
      executions++;
      expect(JSON.parse(String(init?.body))).toMatchObject({
        user_id: "owner",
        connected_account_id: "ca_private",
        version: "20260905_00",
      });
      if (failExecution) throw new Error("response lost");
      return Response.json({
        successful: true,
        data: { messages: ["hello"] },
        log_id: "do-not-expose",
      });
    },
  });
  return {
    tools: new ConnectedAccountTools({ client, storage, connection }),
    setDisabled: () => {
      disabled = true;
    },
    revoke: () => {
      state = "revoked";
    },
    revokeDuringRead: () => {
      revokeDuringRead = true;
    },
    loseResponse: () => {
      failExecution = true;
    },
    executions: () => executions,
  };
}
const command = {
  connectionId: "connection-one",
  toolName: "GMAIL_FETCH_EMAILS",
  version: "20260905_00",
  arguments: { query: "unread" },
  effectId: "tool:1:1:0",
  sessionId: "session-one",
};
test("the User owns provider identity and dated schemas; only tool data crosses to a Bot", async () => {
  const f = fixture();
  const catalog = await f.tools.list("owner", "connection-one");
  expect(catalog.namespace).toMatch(/^gmail--[a-f0-9]{16}$/);
  expect(catalog.tools[0]?.inputSchema).toEqual({
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  });
  expect(JSON.stringify(catalog)).not.toMatch(/private|composio/i);
  const result = await f.tools.execute("owner", command);
  expect(result).toEqual({ content: '{"messages":["hello"]}', isError: false });
});
test("revocation during the provider status read refuses the next external effect", async () => {
  const f = fixture();
  await f.tools.list("owner", "connection-one");
  f.revokeDuringRead();
  await expect(f.tools.execute("owner", command)).rejects.toThrow(
    "unavailable",
  );
  expect(f.executions()).toBe(0);
});
test("disabled provider accounts and undisclosed tools never execute", async () => {
  const f = fixture();
  await expect(f.tools.execute("owner", command)).rejects.toThrow("Discover");
  await f.tools.list("owner", "connection-one");
  f.setDisabled();
  await expect(f.tools.execute("owner", command)).rejects.toThrow(
    "reconnecting",
  );
  expect(f.executions()).toBe(0);
});
test("an uncertain provider outcome is visible and never retried by the integration", async () => {
  const f = fixture();
  await f.tools.list("owner", "connection-one");
  f.loseResponse();
  expect(await f.tools.execute("owner", command)).toMatchObject({
    isError: true,
    content: expect.stringContaining("Do not repeat"),
  });
  expect(f.executions()).toBe(1);
});
