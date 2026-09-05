import type { ConnectedToolV1 } from "./tool-contracts.js";
export interface ToolkitSummary {
  slug: string;
  name: string;
  description: string;
  logo?: string;
  managedOAuth: boolean;
}
export interface TriggerTypeSummary {
  slug: string;
  name: string;
  description: string;
  configSchema: Record<string, unknown>;
  version: string;
  needsSetup: boolean;
}
export interface TriggerInstanceSummary {
  id: string;
  accountId: string;
  triggerType: string;
  config: Record<string, unknown>;
  disabled: boolean;
}
export interface AuthConfigSummary {
  id: string;
  toolkitSlug: string;
  name?: string;
}

export type ComposioFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ComposioClientConfig {
  apiKey: string;
  baseUrl?: string;
  fetch?: ComposioFetch;
}

export interface CreateConnectLinkInput {
  userId: string;
  authConfigId: string;
  callbackUrl: string;
  alias?: string;
}

export interface ConnectLink {
  connectedAccountId: string;
  redirectUrl: string;
  expiresAt: string;
}

export interface ConnectedAccountSummary {
  id: string;
  status: string;
  toolkitSlug: string;
  alias?: string;
  userId?: string;
  disabled?: boolean;
  authConfigId?: string;
}

export interface ExecuteComposioToolInput {
  toolSlug: string;
  userId: string;
  connectedAccountId: string;
  arguments: Record<string, unknown>;
  version?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Composio returned an invalid response");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || !candidate) {
    throw new Error(`Composio response omitted ${key}`);
  }
  return candidate;
}

function connectedAccountSummary(
  value: unknown,
  requireUserId = false,
): ConnectedAccountSummary {
  const account = asRecord(value);
  const toolkit = asRecord(account.toolkit);
  const userId = requireUserId
    ? requiredString(account, "user_id")
    : typeof account.user_id === "string"
      ? account.user_id
      : undefined;
  return {
    id: requiredString(account, "id"),
    status: requiredString(account, "status"),
    disabled:
      account.is_disabled === true ||
      (typeof account.auth_config === "object" &&
        account.auth_config !== null &&
        (account.auth_config as Record<string, unknown>).is_disabled === true),
    toolkitSlug: requiredString(toolkit, "slug"),
    alias: typeof account.alias === "string" ? account.alias : undefined,
    ...(userId ? { userId } : {}),
    ...(typeof account.auth_config === "object" &&
    account.auth_config !== null &&
    typeof (account.auth_config as Record<string, unknown>).id === "string"
      ? { authConfigId: (account.auth_config as { id: string }).id }
      : {}),
  };
}

export class ComposioRequestError extends Error {
  constructor(readonly status: number) {
    super(`The service could not complete this request (${status})`);
    this.name = "ComposioRequestError";
  }
}

export class ComposioClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetcher: ComposioFetch;

  constructor(config: ComposioClientConfig) {
    if (!config.apiKey.trim()) throw new Error("Composio API key is required");
    this.apiKey = config.apiKey;
    this.baseUrl = (
      config.baseUrl ?? "https://backend.composio.dev/api/v3.1"
    ).replace(/\/$/, "");
    this.fetcher = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async createConnectLink(input: CreateConnectLinkInput): Promise<ConnectLink> {
    const value = asRecord(
      await this.request("/connected_accounts/link", {
        method: "POST",
        body: JSON.stringify({
          auth_config_id: input.authConfigId,
          user_id: input.userId,
          callback_url: input.callbackUrl,
          ...(input.alias ? { alias: input.alias } : {}),
        }),
      }),
    );
    return {
      connectedAccountId: requiredString(value, "connected_account_id"),
      redirectUrl: requiredString(value, "redirect_url"),
      expiresAt: requiredString(value, "expires_at"),
    };
  }

  async listConnectedAccounts(
    userId: string,
  ): Promise<ConnectedAccountSummary[]> {
    const accounts: ConnectedAccountSummary[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const query = new URLSearchParams();
      query.append("user_ids", userId);
      query.append("limit", "100");
      if (cursor) query.append("cursor", cursor);
      const value = asRecord(
        await this.request(`/connected_accounts?${query.toString()}`),
      );
      if (!Array.isArray(value.items)) {
        throw new Error("Composio returned an invalid account list");
      }
      accounts.push(
        ...value.items.map((candidate) => connectedAccountSummary(candidate)),
      );
      const nextCursor = value.next_cursor;
      if (
        nextCursor === undefined ||
        nextCursor === null ||
        nextCursor === ""
      ) {
        return accounts;
      }
      if (typeof nextCursor !== "string" || seenCursors.has(nextCursor)) {
        throw new Error("Composio returned an invalid account cursor");
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    throw new Error("Composio account pagination exceeded its limit");
  }

  async listToolkits(): Promise<ToolkitSummary[]> {
    const items = await this.pages(
      "/toolkits?limit=100&sort_by=alphabetically&include_deprecated=false",
    );
    return items.map((candidate) => {
      const toolkit = asRecord(candidate);
      const meta = asRecord(toolkit.meta);
      return {
        slug: requiredString(toolkit, "slug"),
        name: requiredString(toolkit, "name").slice(0, 120),
        description: (typeof meta.description === "string"
          ? meta.description
          : ""
        ).slice(0, 500),
        ...(typeof meta.logo === "string" && meta.logo.startsWith("https://")
          ? { logo: meta.logo }
          : {}),
        managedOAuth:
          Array.isArray(toolkit.composio_managed_auth_schemes) &&
          toolkit.composio_managed_auth_schemes.some(
            (scheme) => String(scheme).toLowerCase() === "oauth2",
          ),
      };
    });
  }

  async listAuthConfigs(): Promise<AuthConfigSummary[]> {
    return (await this.pages("/auth_configs?limit=50")).flatMap((candidate) => {
      const config = asRecord(candidate);
      if (config.status !== "ENABLED") return [];
      return [
        {
          id: requiredString(config, "id"),
          toolkitSlug: requiredString(asRecord(config.toolkit), "slug"),
          ...(typeof config.name === "string" ? { name: config.name } : {}),
        },
      ];
    });
  }

  async createManagedAuthConfig(
    toolkitSlug: string,
    name: string,
  ): Promise<AuthConfigSummary> {
    const result = asRecord(
      await this.request("/auth_configs", {
        method: "POST",
        body: JSON.stringify({
          toolkit: { slug: toolkitSlug },
          auth_config: { type: "use_composio_managed_auth", name },
        }),
      }),
    );
    return {
      id: requiredString(asRecord(result.auth_config), "id"),
      toolkitSlug: requiredString(asRecord(result.toolkit), "slug"),
      name,
    };
  }

  private async pages(path: string): Promise<unknown[]> {
    const items: unknown[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = asRecord(
        await this.request(
          path + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""),
        ),
      );
      if (!Array.isArray(result.items) || result.items.length > 1000)
        throw new Error("Connector catalog is invalid");
      items.push(...result.items);
      if (items.length > 1000)
        throw new Error("Connector catalog exceeded its limit");
      if (!result.next_cursor) return items;
      if (
        typeof result.next_cursor !== "string" ||
        seen.has(result.next_cursor)
      )
        throw new Error("Connector catalog cursor is invalid");
      cursor = result.next_cursor;
      seen.add(cursor);
    }
    throw new Error("Connector catalog pagination exceeded its limit");
  }

  async listTools(
    toolkitSlug: string,
    authConfigId: string,
  ): Promise<ConnectedToolV1[]> {
    const query = new URLSearchParams({
      toolkit_slug: toolkitSlug,
      auth_config_ids: authConfigId,
      include_deprecated: "false",
      toolkit_versions: "latest",
      limit: "100",
    });
    const values = await this.pages(`/tools?${query}`);
    return values.map((value) => {
      const tool = asRecord(value);
      if (
        asRecord(tool.toolkit).slug !== toolkitSlug ||
        !requiredString(tool, "slug").startsWith(
          `${toolkitSlug.toUpperCase()}_`,
        )
      )
        throw new Error("The service returned a tool for another connector");
      const parameters = asRecord(tool.input_parameters);
      const inputSchema =
        parameters.type === "object"
          ? parameters
          : {
              type: "object",
              properties: Object.fromEntries(
                Object.entries(parameters).map(([key, value]) => {
                  const { required: _, ...schema } = asRecord(value);
                  return [key, schema];
                }),
              ),
              required: Object.entries(parameters)
                .filter(([, value]) => asRecord(value).required === true)
                .map(([key]) => key),
            };
      return {
        name: requiredString(tool, "slug"),
        description: requiredString(tool, "description"),
        inputSchema,
        version: requiredString(tool, "version"),
      };
    });
  }

  async listTriggerTypes(toolkitSlug: string): Promise<TriggerTypeSummary[]> {
    const query = new URLSearchParams({
      toolkit_slugs: toolkitSlug,
      toolkit_versions: "latest",
      limit: "50",
    });
    const values = await this.pages(`/triggers_types?${query}`);
    return values.map((raw) => {
      const value = asRecord(raw),
        slug = requiredString(value, "slug");
      if (
        asRecord(value.toolkit).slug !== toolkitSlug ||
        !slug.startsWith(`${toolkitSlug.toUpperCase()}_`)
      )
        throw new Error("This event belongs to another connector");
      const config = asRecord(value.config);
      const configSchema =
        config.type === "object"
          ? config
          : {
              type: "object",
              properties: Object.fromEntries(
                Object.entries(config).map(([key, raw]) => {
                  const { required: _, ...field } = asRecord(raw);
                  if (field.type === "enum" && Array.isArray(field.options)) {
                    field.type = "string";
                    field.enum = field.options;
                    delete field.options;
                  }
                  return [key, field];
                }),
              ),
              required: Object.entries(config)
                .filter(([, raw]) => asRecord(raw).required === true)
                .map(([key]) => key),
            };
      return {
        slug,
        name: requiredString(value, "name"),
        description:
          typeof value.description === "string" ? value.description : "",
        configSchema,
        version: requiredString(value, "version"),
        needsSetup: value.requires_webhook_endpoint_setup === true,
      };
    });
  }
  async listTriggerInstances(
    accountId: string,
  ): Promise<TriggerInstanceSummary[]> {
    const query = new URLSearchParams({
      connected_account_ids: accountId,
      show_disabled: "true",
      limit: "50",
    });
    const values = await this.pages(`/trigger_instances/active?${query}`);
    return values.map((raw) => {
      const value = asRecord(raw);
      if (value.connected_account_id !== accountId)
        throw new Error("This event belongs to another account");
      return {
        id: requiredString(value, "id"),
        accountId,
        triggerType: requiredString(value, "trigger_name"),
        config: asRecord(value.trigger_config),
        disabled: !!value.disabled_at,
      };
    });
  }
  async upsertTrigger(input: {
    accountId: string;
    triggerType: string;
    toolkit: string;
    version: string;
    config: Record<string, unknown>;
  }): Promise<string> {
    const value = asRecord(
      await this.request(
        `/trigger_instances/${encodeURIComponent(input.triggerType)}/upsert`,
        {
          method: "POST",
          body: JSON.stringify({
            connected_account_id: input.accountId,
            trigger_config: input.config,
            toolkit_versions: { [input.toolkit]: input.version },
          }),
        },
      ),
    );
    return requiredString(value, "trigger_id");
  }
  setTriggerEnabled(id: string, enabled: boolean): Promise<unknown> {
    return this.request(`/trigger_instances/manage/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status: enabled ? "enable" : "disable" }),
    });
  }
  deleteTrigger(id: string): Promise<unknown> {
    return this.request(`/trigger_instances/manage/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  async getConnectedAccount(
    connectedAccountId: string,
  ): Promise<ConnectedAccountSummary> {
    return connectedAccountSummary(
      await this.request(
        `/connected_accounts/${encodeURIComponent(connectedAccountId)}`,
      ),
      true,
    );
  }

  revokeConnectedAccount(connectedAccountId: string): Promise<unknown> {
    return this.request(
      `/connected_accounts/${encodeURIComponent(connectedAccountId)}/revoke`,
      { method: "POST" },
    );
  }

  deleteConnectedAccount(connectedAccountId: string): Promise<unknown> {
    return this.request(
      `/connected_accounts/${encodeURIComponent(connectedAccountId)}`,
      { method: "DELETE" },
    );
  }

  executeTool(input: ExecuteComposioToolInput): Promise<unknown> {
    return this.request(
      `/tools/execute/${encodeURIComponent(input.toolSlug)}`,
      {
        method: "POST",
        body: JSON.stringify({
          user_id: input.userId,
          connected_account_id: input.connectedAccountId,
          version: input.version ?? "latest",
          arguments: input.arguments,
        }),
      },
    );
  }

  private async request(
    path: string,
    init: RequestInit = {},
  ): Promise<unknown> {
    const headers = new Headers(init.headers);
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    headers.set("x-api-key", this.apiKey);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        redirect: "manual",
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new ComposioRequestError(response.status);
      }
      if (response.status === 204) return {};
      const reader = response.body?.getReader();
      if (!reader) throw new Error("The service returned an empty response");
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 8_000_000) {
          await reader.cancel();
          throw new Error("The service response exceeded its size limit");
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return JSON.parse(new TextDecoder().decode(bytes));
    } finally {
      clearTimeout(timeout);
    }
  }
}
