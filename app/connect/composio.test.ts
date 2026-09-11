import { describe, expect, test } from "bun:test";
import {
  ComposioClient,
  ComposioRequestError,
  connectToolNameV1,
  decodeConnectedAccountSummaryV1,
} from "./composio.js";

interface Recorded {
  url: string;
  init: RequestInit | undefined;
}

function client(respond: (recorded: Recorded) => Response) {
  const recorded: Recorded[] = [];
  const instance = new ComposioClient({
    apiKey: "project-key",
    fetch: (input, init) => {
      const entry = { url: String(input), init };
      recorded.push(entry);
      return Promise.resolve(respond(entry));
    },
  });
  return { client: instance, recorded };
}

describe("the provider client", () => {
  test("names a Bot-facing tool without its toolkit prefix", () => {
    expect(connectToolNameV1("GMAIL_SEND_EMAIL", "gmail")).toBe("send_email");
    expect(connectToolNameV1("OTHER_THING", "gmail")).toBe("other_thing");
  });

  test("sends the project key on every request and refuses a bad status", async () => {
    const { client: c, recorded } = client(
      () => new Response("nope", { status: 503 }),
    );
    await expect(c.getConnectedAccount("ca_1")).rejects.toBeInstanceOf(
      ComposioRequestError,
    );
    expect(new Headers(recorded[0]?.init?.headers).get("x-api-key")).toBe(
      "project-key",
    );
    expect(recorded[0]?.url).toBe(
      "https://backend.composio.dev/api/v3.1/connected_accounts/ca_1",
    );
  });

  test("mints a sign-in link for one User and one auth config", async () => {
    const { client: c, recorded } = client(() =>
      Response.json({
        link_token: "lt",
        connected_account_id: "ca_new",
        redirect_url: "https://connect.example/go",
        expires_at: "2026-09-11T00:10:00.000Z",
      }),
    );
    const link = await c.createConnectLink({
      userId: "user-1",
      authConfigId: "ac_gmail",
      callbackUrl: "https://bot.frockbot.com/api/connect/callback",
    });
    expect(link).toEqual({
      connectedAccountId: "ca_new",
      redirectUrl: "https://connect.example/go",
      expiresAt: "2026-09-11T00:10:00.000Z",
    });
    expect(JSON.parse(String(recorded[0]?.init?.body))).toEqual({
      auth_config_id: "ac_gmail",
      user_id: "user-1",
      callback_url: "https://bot.frockbot.com/api/connect/callback",
    });
  });

  test("refuses a sign-in destination that is not https", async () => {
    const { client: c } = client(() =>
      Response.json({
        connected_account_id: "ca",
        redirect_url: "http://connect.example/go",
        expires_at: "x",
      }),
    );
    await expect(
      c.createConnectLink({ userId: "u", authConfigId: "a", callbackUrl: "c" }),
    ).rejects.toThrow("invalid sign-in destination");
  });

  test("decodes every account status and nothing else", () => {
    for (const status of [
      "INITIALIZING",
      "INITIATED",
      "ACTIVE",
      "FAILED",
      "EXPIRED",
      "INACTIVE",
      "REVOKED",
    ] as const) {
      expect(
        decodeConnectedAccountSummaryV1({
          id: "ca",
          status,
          toolkit: { slug: "gmail" },
        }).status,
      ).toBe(status);
    }
    expect(() =>
      decodeConnectedAccountSummaryV1({
        id: "ca",
        status: "WEIRD",
        toolkit: { slug: "gmail" },
      }),
    ).toThrow("unknown account status");
    expect(
      decodeConnectedAccountSummaryV1({
        id: "ca",
        status: "ACTIVE",
        toolkit: { slug: "gmail" },
        auth_config: { id: "ac", is_disabled: true },
      }).disabled,
    ).toBe(true);
  });

  test("lists only the important tools of one app", async () => {
    const { client: c, recorded } = client(() =>
      Response.json({
        items: [
          {
            slug: "GMAIL_SEND_EMAIL",
            name: "Send email",
            description: "Sends an email.",
            version: "20250930_00",
            toolkit: { slug: "gmail" },
            input_parameters: {
              type: "object",
              properties: { to: { type: "string" } },
              required: ["to"],
            },
          },
          {
            slug: "GMAIL_FETCH_EMAILS",
            name: "Fetch",
            description: "Fetches.",
            version: "20250930_00",
            toolkit: { slug: "gmail" },
            input_parameters: {
              type: "object",
              properties: { query: { type: "string" } },
              required: ["query"],
            },
          },
        ],
        next_cursor: null,
      }),
    );
    const tools = await c.listImportantTools("gmail");
    const url = new URL(recorded[0]!.url);
    expect(url.pathname).toBe("/api/v3.1/tools");
    expect(url.searchParams.get("toolkit_slug")).toBe("gmail");
    expect(url.searchParams.get("important")).toBe("true");
    expect(tools.map((tool) => tool.name)).toEqual([
      "send_email",
      "fetch_emails",
    ]);
    expect(tools[1]?.inputSchema).toEqual({
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    });
  });

  test("refuses a tool whose input schema is not an object schema", async () => {
    const { client: c } = client(() =>
      Response.json({
        items: [
          {
            slug: "GMAIL_FETCH_EMAILS",
            description: "Fetches.",
            version: "20250930_00",
            toolkit: { slug: "gmail" },
            input_parameters: {
              query: { type: "string", required: true },
            },
          },
        ],
        next_cursor: null,
      }),
    );
    await expect(c.listImportantTools("gmail")).rejects.toThrow(
      "invalid tool schema",
    );
  });

  test("refuses a tool listed under another app", async () => {
    const { client: c } = client(() =>
      Response.json({
        items: [
          {
            slug: "SLACK_POST",
            description: "d",
            version: "v",
            toolkit: { slug: "slack" },
            input_parameters: {},
          },
        ],
      }),
    );
    await expect(c.listImportantTools("gmail")).rejects.toThrow("another app");
  });

  test("executes a tool against one account and reads the tool-level outcome", async () => {
    const { client: c, recorded } = client(() =>
      Response.json({ successful: false, error: "bad to", data: {} }),
    );
    const result = await c.executeTool({
      toolSlug: "GMAIL_SEND_EMAIL",
      userId: "user-1",
      connectedAccountId: "ca_1",
      arguments: { to: "x" },
      version: "20250930_00",
    });
    expect(result).toEqual({ successful: false, data: {}, error: "bad to" });
    expect(recorded[0]?.url).toBe(
      "https://backend.composio.dev/api/v3.1/tools/execute/GMAIL_SEND_EMAIL",
    );
    expect(JSON.parse(String(recorded[0]?.init?.body))).toEqual({
      user_id: "user-1",
      connected_account_id: "ca_1",
      arguments: { to: "x" },
      version: "20250930_00",
    });
  });

  test("treats an account already gone as deleted, and revokes upstream", async () => {
    const gone = client(() => new Response("", { status: 404 }));
    await expect(gone.client.deleteConnectedAccount("ca_1")).resolves.toBe(
      undefined,
    );
    expect(gone.recorded[0]?.url).toContain("revoke_on_delete=true");
    expect(gone.recorded[0]?.init?.method).toBe("DELETE");
    const down = client(() => new Response("", { status: 500 }));
    await expect(down.client.deleteConnectedAccount("ca_1")).rejects.toThrow();
  });

  test("bounds a listing by its cursor chain", async () => {
    const { client: c } = client(() =>
      Response.json({ items: [], next_cursor: "same" }),
    );
    await expect(c.listAuthConfigs()).rejects.toThrow("invalid list cursor");
  });
});
