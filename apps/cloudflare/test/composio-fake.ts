/** A provider stand-in at the HTTP boundary; the production User DO owns all product state. */
export function createComposioFake() {
  const accounts = new Map<
    string,
    {
      id: string;
      user_id: string;
      alias: string;
      status: string;
      toolkit: { slug: string };
    }
  >();
  const configs = new Map<string, string>();
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
      });
      const redirect = new URL(input.callback_url);
      redirect.searchParams.set("connected_account_id", id);
      redirect.searchParams.set("status", "success");
      return Response.json({
        connected_account_id: id,
        redirect_url: redirect.toString(),
        expires_at: new Date(Date.now() + 600_000).toISOString(),
      });
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
