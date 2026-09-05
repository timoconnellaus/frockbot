import { composioFixtures } from "./composio-fixtures.ts";

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
        items: composioFixtures.map((item) => ({
          slug: item.slug,
          name: item.name,
          meta: { description: item.description },
          composio_managed_auth_schemes: ["oauth2"],
        })),
      });
    if (path === "/auth_configs") {
      if (request.method === "POST") {
        const input = (await request.json()) as { toolkit: { slug: string } };
        if (!composioFixtures.some((item) => item.slug === input.toolkit.slug))
          return Response.json({}, { status: 400 });
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
      const slug = [...configs].find(
        ([, id]) => id === input.auth_config_id,
      )?.[0];
      if (!slug) return Response.json({}, { status: 400 });
      const id = `ca_${input.alias}`;
      accounts.set(id, {
        id,
        user_id: input.user_id,
        alias: input.alias,
        status: "ACTIVE",
        toolkit: { slug },
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
        items: composioFixtures
          .filter(
            (item) =>
              item.slug === url.searchParams.get("toolkit_slug") &&
              configs.get(item.slug) ===
                url.searchParams.get("auth_config_ids"),
          )
          .map((item) => ({
            ...item.tool,
            toolkit: { slug: item.slug },
            version: item.version,
          })),
      });
    const execute = /^\/tools\/execute\/([A-Z_]+)$/.exec(path);
    if (execute) {
      const fixture = composioFixtures.find(
        (item) => item.tool.slug === execute[1],
      );
      const input = (await request.json()) as {
        connected_account_id: string;
        user_id: string;
        version: string;
        arguments?: { query?: string; calendarId?: string };
      };
      const account = accounts.get(input.connected_account_id);
      if (
        !fixture ||
        account?.user_id !== input.user_id ||
        account?.status !== "ACTIVE" ||
        account.toolkit.slug !== fixture.slug ||
        input.version !== fixture.version
      )
        return Response.json({}, { status: 403 });
      if (input.arguments?.query === "fake-response-lost")
        return Response.json({}, { status: 503 });
      if (
        input.arguments?.query === "fake-refusal" ||
        input.arguments?.calendarId === "me"
      )
        return Response.json({}, { status: 422 });
      return Response.json({ successful: true, data: fixture.result });
    }
    if (path === "/triggers_types")
      return Response.json({
        items: composioFixtures
          .filter((item) => item.slug === url.searchParams.get("toolkit_slugs"))
          .map((item) => ({
            ...item.trigger,
            toolkit: { slug: item.slug },
            version: item.version,
          })),
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
        toolkit_versions: Record<string, string>;
      };
      const account = accounts.get(input.connected_account_id);
      const fixture = composioFixtures.find(
        (item) => item.trigger.slug === upsert[1],
      );
      if (
        !fixture ||
        account?.status !== "ACTIVE" ||
        account.toolkit.slug !== fixture.slug ||
        input.toolkit_versions[fixture.slug] !== fixture.version
      )
        return Response.json({}, { status: 403 });
      const propertyNames =
        fixture.slug === "googlecalendar"
          ? [
              "calendarId",
              "countdownWindowMinutes",
              "includeAllDay",
              "interval",
              "minutesBeforeStart",
            ]
          : ["label"];
      if (
        Object.keys(input.trigger_config).some(
          (key) => !propertyNames.includes(key),
        )
      )
        return Response.json({}, { status: 422 });
      const configKey = (config: Record<string, unknown>) =>
        JSON.stringify(
          Object.fromEntries(
            Object.entries(config).sort(([a], [b]) => a.localeCompare(b)),
          ),
        );
      const existing = [...triggers.values()].find(
        (item) =>
          item.connected_account_id === input.connected_account_id &&
          item.trigger_name === upsert[1] &&
          configKey(item.trigger_config) === configKey(input.trigger_config),
      );
      const baseId = `ti_${input.connected_account_id}`;
      const id =
        existing?.id ??
        (triggers.has(baseId) ? `${baseId}_${crypto.randomUUID()}` : baseId);
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
