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

export interface ComposioToolSummary {
  slug: string;
  name: string;
  description?: string;
}

export interface ConnectedAccountSummary {
  id: string;
  status: string;
  toolkitSlug: string;
  alias?: string;
  userId?: string;
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
    toolkitSlug: requiredString(toolkit, "slug"),
    alias: typeof account.alias === "string" ? account.alias : undefined,
    ...(userId ? { userId } : {}),
  };
}

export class ComposioRequestError extends Error {
  constructor(readonly status: number) {
    super(`Composio request failed (${status})`);
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
      if (nextCursor === undefined || nextCursor === null || nextCursor === "") {
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

  async searchTools(
    toolkitSlug: string,
    search?: string,
  ): Promise<ComposioToolSummary[]> {
    const query = new URLSearchParams();
    query.append("toolkit_slugs", toolkitSlug);
    if (search?.trim()) query.append("search", search.trim());
    const value = asRecord(await this.request(`/tools?${query.toString()}`));
    if (!Array.isArray(value.items)) {
      throw new Error("Composio returned an invalid tool list");
    }
    return value.items.map((candidate) => {
      const tool = asRecord(candidate);
      return {
        slug: requiredString(tool, "slug"),
        name: requiredString(tool, "name"),
        description:
          typeof tool.description === "string" ? tool.description : undefined,
      };
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
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers,
    });
    if (!response.ok) {
      throw new ComposioRequestError(response.status);
    }
    return response.json();
  }
}
