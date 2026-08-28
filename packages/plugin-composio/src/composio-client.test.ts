import { describe, expect, test } from "bun:test";
import { ComposioClient } from "./composio-client.ts";

describe("ComposioClient", () => {
  test("creates a hosted Connect Link without exposing the project key", async () => {
    let captured: { url: string; init?: RequestInit } | undefined;
    const client = new ComposioClient({
      apiKey: "project-secret",
      fetch: (input: string | URL | Request, init?: RequestInit) => {
        captured = { url: String(input), init };
        return Promise.resolve(
          Response.json(
            {
              connected_account_id: "ca_123",
              redirect_url: "https://connect.composio.dev/link/ln_123",
              expires_at: "2026-08-28T01:00:00.000Z",
            },
            { status: 201 },
          ),
        );
      },
    });

    const result = await client.createConnectLink({
      userId: "user-123",
      authConfigId: "ac_gmail",
      callbackUrl: "https://bot.frockbot.com/api/connections/composio/callback",
      alias: "personal",
    });

    expect(result).toEqual({
      connectedAccountId: "ca_123",
      redirectUrl: "https://connect.composio.dev/link/ln_123",
      expiresAt: "2026-08-28T01:00:00.000Z",
    });
    expect(captured?.url).toBe(
      "https://backend.composio.dev/api/v3.1/connected_accounts/link",
    );
    expect(new Headers(captured?.init?.headers).get("x-api-key")).toBe(
      "project-secret",
    );
    expect(JSON.parse(String(captured?.init?.body))).toEqual({
      auth_config_id: "ac_gmail",
      user_id: "user-123",
      callback_url:
        "https://bot.frockbot.com/api/connections/composio/callback",
      alias: "personal",
    });
  });

  test("executes a tool against an explicit connected account", async () => {
    let body: unknown;
    const client = new ComposioClient({
      apiKey: "secret",
      fetch: (_input: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return Promise.resolve(Response.json({ data: { ok: true } }));
      },
    });

    expect(
      await client.executeTool({
        toolSlug: "GMAIL_FETCH_EMAILS",
        userId: "user-123",
        connectedAccountId: "ca_123",
        arguments: { max_results: 5 },
      }),
    ).toEqual({ data: { ok: true } });
    expect(body).toEqual({
      user_id: "user-123",
      connected_account_id: "ca_123",
      version: "latest",
      arguments: { max_results: 5 },
    });
  });

  test("bounds provider failures without leaking response bodies", async () => {
    const client = new ComposioClient({
      apiKey: "secret",
      fetch: () =>
        Promise.resolve(new Response("token=provider-secret", { status: 401 })),
    });

    let failure: unknown;
    try {
      await client.createConnectLink({
        userId: "user-123",
        authConfigId: "ac_gmail",
        callbackUrl: "https://bot.frockbot.com/callback",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error ? failure.message : "").toBe(
      "Composio request failed (401)",
    );
  });
});
