/** A provider stand-in at the HTTP boundary; the production User DO owns all product state. */
export function createComposioFake(authorizationOrigin?: string) {
  const accounts = new Map<
    string,
    {
      id: string;
      user_id: string;
      alias: string;
      status: string;
      toolkit: { slug: string };
      auth_config: { id: string };
    }
  >();
  const configs = new Map<string, string>();
  const triggers = new Map<
    string,
    {
      id: string;
      connected_account_id: string;
      trigger_name: string;
      trigger_config: Record<string, unknown>;
      disabled_at: string | null;
    }
  >();
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url),
      path = url.pathname.replace("/api/v3.1", "");
    if (request.headers.get("x-api-key") !== "test-composio-backend-key")
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    if (path === "/toolkits")
      return Response.json({
        items: [
          {
            slug: "gmail",
            name: "Gmail",
            meta: { description: "Read and send email" },
            composio_managed_auth_schemes: ["oauth2"],
          },
        ],
      });
    if (path === "/auth_configs") {
      if (request.method === "POST") {
        const input = (await request.json()) as { toolkit: { slug: string } };
        const id = `ac_${input.toolkit.slug}`;
        configs.set(input.toolkit.slug, id);
        return Response.json({ auth_config: { id }, toolkit: input.toolkit });
      }
      return Response.json({
        items: [...configs].map(([slug, id]) => ({
          id,
          toolkit: { slug },
          status: "ENABLED",
        })),
      });
    }
    if (path === "/connected_accounts/link") {
      const input = (await request.json()) as {
        user_id: string;
        alias: string;
        auth_config_id: string;
        callback_url: string;
      };
      const id = `ca_${input.alias}`;
      accounts.set(id, {
        id,
        user_id: input.user_id,
        alias: input.alias,
        status: "ACTIVE",
        toolkit: { slug: "gmail" },
        auth_config: { id: input.auth_config_id },
      });
      const redirect = new URL(input.callback_url);
      redirect.searchParams.set("connected_account_id", id);
      redirect.searchParams.set("status", "success");
      const authorization = authorizationOrigin
        ? new URL(authorizationOrigin)
        : redirect;
      if (authorizationOrigin)
        authorization.searchParams.set("callback", redirect.toString());
      return Response.json({
        connected_account_id: id,
        redirect_url: authorization.toString(),
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      });
    }
    if (path === "/tools")
      return Response.json({
        items: [
          {
            slug: "GMAIL_FETCH_EMAILS",
            name: "Fetch emails",
            description: "Read recent Gmail messages",
            toolkit: { slug: "gmail" },
            version: "20260905_00",
            input_parameters: {
              type: "object",
              properties: { query: { type: "string" } },
            },
          },
        ],
      });
    if (path === "/tools/execute/GMAIL_FETCH_EMAILS") {
      const input = (await request.json()) as {
        connected_account_id: string;
        user_id: string;
        version: string;
        arguments?: { query?: string };
      };
      const account = accounts.get(input.connected_account_id);
      if (
        account?.user_id !== input.user_id ||
        account?.status !== "ACTIVE" ||
        input.version !== "20260905_00"
      )
        return Response.json({}, { status: 403 });
      if (input.arguments?.query === "fake-response-lost")
        return Response.json({}, { status: 503 });
      if (input.arguments?.query === "fake-refusal")
        return Response.json({}, { status: 422 });
      return Response.json({
        successful: true,
        data: {
          messages: [{ id: "mail-one", subject: "Hello from your inbox" }],
        },
      });
    }
    if (path === "/triggers_types")
      return Response.json({
        items: [
          {
            slug: "GMAIL_NEW_GMAIL_MESSAGE",
            name: "When a new email arrives in Gmail",
            description: "Run when your inbox receives a new message.",
            toolkit: { slug: "gmail" },
            config: {
              type: "object",
              properties: {
                label: {
                  type: "string",
                  title: "Mailbox label",
                  description:
                    "Optional: listen only to messages with this label.",
                },
              },
            },
            version: "20260905_00",
          },
        ],
      });
    if (path === "/trigger_instances/active")
      return Response.json({
        items: [...triggers.values()].filter(
          (item) =>
            item.connected_account_id ===
            url.searchParams.get("connected_account_ids"),
        ),
      });
    const upsert = /^\/trigger_instances\/([A-Z_]+)\/upsert$/.exec(path);
    if (upsert && request.method === "POST") {
      const input = (await request.json()) as {
        connected_account_id: string;
        trigger_config: Record<string, unknown>;
      };
      if (accounts.get(input.connected_account_id)?.status !== "ACTIVE")
        return Response.json({}, { status: 403 });
      const id = `ti_${input.connected_account_id}`;
      triggers.set(id, {
        id,
        connected_account_id: input.connected_account_id,
        trigger_name: upsert[1]!,
        trigger_config: input.trigger_config,
        disabled_at: null,
      });
      return Response.json({ trigger_id: id });
    }
    const managed = /^\/trigger_instances\/manage\/([^/]+)$/.exec(path);
    if (managed) {
      const instance = triggers.get(managed[1]!);
      if (!instance) return Response.json({}, { status: 404 });
      if (request.method === "DELETE") triggers.delete(instance.id);
      else if (request.method === "PATCH")
        instance.disabled_at =
          ((await request.json()) as { status: string }).status === "disable"
            ? new Date().toISOString()
            : null;
      return Response.json({ status: "success" });
    }
    if (path === "/connected_accounts")
      return Response.json({
        items: [...accounts.values()].filter(
          (account) => account.user_id === url.searchParams.get("user_ids"),
        ),
      });
    const match = /^\/connected_accounts\/([^/]+)(\/revoke)?$/.exec(path);
    if (match) {
      const account = accounts.get(decodeURIComponent(match[1]!));
      if (!account) return Response.json({ error: "Missing" }, { status: 404 });
      if (request.method === "DELETE") {
        accounts.delete(account.id);
        return Response.json({});
      }
      if (match[2]) account.status = "REVOKED";
      return Response.json(account);
    }
    return Response.json(
      { error: "Unexpected provider request" },
      { status: 404 },
    );
  };
}
