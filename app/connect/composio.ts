// The provider behind Connected apps, as this application speaks to it: raw
// fetch against its v3.1 REST API with the deployment's project key. Nothing
// here holds User authority; the callers decide which User and which account
// a request is for, and every answer is decoded at this seam before anything
// downstream reads it.
//
// Verified against https://backend.composio.dev/api/v3.1/openapi.json on
// 2026-09-11. The one v3.1-only call this module needs is nothing: revocation
// goes through `DELETE ?revoke_on_delete=true`, which both versions carry.

export const COMPOSIO_DEFAULT_BASE_URL =
  "https://backend.composio.dev/api/v3.1";

/** Longest provider answer read into memory before it is parsed. */
const MAX_RESPONSE_BYTES = 8_000_000;
const REQUEST_TIMEOUT_MS = 30_000;
/** Most pages one listing walks before it is called unbounded. */
const MAX_PAGES = 10;

export type ComposioFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ComposioClientConfig {
  apiKey: string;
  baseUrl?: string;
  fetch?: ComposioFetch;
}

/** The seven states a connected account reports. */
export type ConnectedAccountStatusV1 =
  | "INITIALIZING"
  | "INITIATED"
  | "ACTIVE"
  | "FAILED"
  | "EXPIRED"
  | "INACTIVE"
  | "REVOKED";

export interface ConnectedAccountSummaryV1 {
  id: string;
  status: ConnectedAccountStatusV1;
  toolkitSlug: string;
  disabled: boolean;
  statusReason?: string;
}

export interface ConnectLinkV1 {
  connectedAccountId: string;
  redirectUrl: string;
  expiresAt: string;
}

export interface AuthConfigSummaryV1 {
  id: string;
  toolkitSlug: string;
}

/** One tool the provider offers for an app, as a Bot will be shown it. */
export interface ConnectToolV1 {
  /** The provider's slug, e.g. `GMAIL_SEND_EMAIL`; what execution names. */
  slug: string;
  /** The Bot-facing name inside the namespace, e.g. `send_email`. */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  version: string;
}

export interface ExecuteToolInputV1 {
  toolSlug: string;
  userId: string;
  connectedAccountId: string;
  arguments: Record<string, unknown>;
  version?: string;
}

export interface ExecuteToolResultV1 {
  successful: boolean;
  data: unknown;
  error?: string;
}

/** A provider answer the caller can act on by status. */
export class ComposioRequestError extends Error {
  constructor(readonly status: number) {
    super(`The service could not complete this request (${status})`);
    this.name = "ComposioRequestError";
  }
}

const ACCOUNT_STATUSES: readonly ConnectedAccountStatusV1[] = [
  "INITIALIZING",
  "INITIATED",
  "ACTIVE",
  "FAILED",
  "EXPIRED",
  "INACTIVE",
  "REVOKED",
];

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The service returned an invalid response");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || !candidate) {
    throw new Error(`The service response omitted ${key}`);
  }
  return candidate;
}

/**
 * The Bot-facing tool name: the provider's `GMAIL_SEND_EMAIL` shown inside the
 * `gmail` namespace as `send_email`. The toolkit prefix is the namespace, and
 * repeating it in every name would double what the prompt pays for.
 */
export function connectToolNameV1(slug: string, toolkitSlug: string): string {
  const prefix = `${toolkitSlug.toUpperCase()}_`;
  const bare = slug.startsWith(prefix) ? slug.slice(prefix.length) : slug;
  return bare.toLowerCase();
}

export function decodeConnectedAccountSummaryV1(
  value: unknown,
): ConnectedAccountSummaryV1 {
  const account = asRecord(value);
  const status = account.status;
  if (
    typeof status !== "string" ||
    !ACCOUNT_STATUSES.includes(status as ConnectedAccountStatusV1)
  ) {
    throw new Error("The service returned an unknown account status");
  }
  const authConfig =
    typeof account.auth_config === "object" && account.auth_config !== null
      ? (account.auth_config as Record<string, unknown>)
      : {};
  return {
    id: requiredString(account, "id"),
    status: status as ConnectedAccountStatusV1,
    toolkitSlug: requiredString(asRecord(account.toolkit), "slug"),
    disabled: account.is_disabled === true || authConfig.is_disabled === true,
    ...(typeof account.status_reason === "string" && account.status_reason
      ? { statusReason: account.status_reason.slice(0, 500) }
      : {}),
  };
}

/** A tool's input schema as the provider publishes it: a JSON-schema object. */
function inputSchemaOf(parameters: Record<string, unknown>) {
  if (parameters.type !== "object") {
    throw new Error("The service returned an invalid tool schema");
  }
  return parameters;
}

export class ComposioClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetcher: ComposioFetch;

  constructor(config: ComposioClientConfig) {
    if (!config.apiKey.trim()) throw new Error("A provider key is required");
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? COMPOSIO_DEFAULT_BASE_URL).replace(
      /\/$/,
      "",
    );
    // Workerd rejects a detached global `fetch`, so the default forwards.
    this.fetcher =
      config.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  /** Every enabled auth config in the project, by app. */
  async listAuthConfigs(): Promise<AuthConfigSummaryV1[]> {
    return (await this.pages("/auth_configs?limit=50")).flatMap((candidate) => {
      const config = asRecord(candidate);
      if (config.status !== "ENABLED") return [];
      return [
        {
          id: requiredString(config, "id"),
          toolkitSlug: requiredString(asRecord(config.toolkit), "slug"),
        },
      ];
    });
  }

  /** A provider-managed OAuth app for one toolkit, created once per project. */
  async createManagedAuthConfig(
    toolkitSlug: string,
    name: string,
  ): Promise<AuthConfigSummaryV1> {
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
    };
  }

  /** The hosted sign-in a person is sent to, and the account it will fill. */
  async createConnectLink(input: {
    userId: string;
    authConfigId: string;
    callbackUrl: string;
  }): Promise<ConnectLinkV1> {
    const value = asRecord(
      await this.request("/connected_accounts/link", {
        method: "POST",
        body: JSON.stringify({
          auth_config_id: input.authConfigId,
          user_id: input.userId,
          callback_url: input.callbackUrl,
        }),
      }),
    );
    const redirectUrl = requiredString(value, "redirect_url");
    if (new URL(redirectUrl).protocol !== "https:") {
      throw new Error("The service returned an invalid sign-in destination");
    }
    return {
      connectedAccountId: requiredString(value, "connected_account_id"),
      redirectUrl,
      expiresAt: requiredString(value, "expires_at"),
    };
  }

  async getConnectedAccount(
    connectedAccountId: string,
  ): Promise<ConnectedAccountSummaryV1> {
    return decodeConnectedAccountSummaryV1(
      await this.request(
        `/connected_accounts/${encodeURIComponent(connectedAccountId)}`,
      ),
    );
  }

  /**
   * Remove the account and revoke its upstream grant. Absent already counts as
   * done: a disconnect retried under the same command must not fail because
   * the first attempt got through.
   */
  async deleteConnectedAccount(connectedAccountId: string): Promise<void> {
    try {
      await this.request(
        `/connected_accounts/${encodeURIComponent(connectedAccountId)}?revoke_on_delete=true`,
        { method: "DELETE" },
      );
    } catch (error) {
      if (error instanceof ComposioRequestError && error.status === 404) return;
      throw error;
    }
  }

  /** The app's important tools: the curated subset, never the whole surface. */
  async listImportantTools(toolkitSlug: string): Promise<ConnectToolV1[]> {
    const query = new URLSearchParams({
      toolkit_slug: toolkitSlug,
      important: "true",
      include_deprecated: "false",
      limit: "100",
    });
    const values = await this.pages(`/tools?${query}`);
    return values.map((value) => {
      const tool = asRecord(value);
      const slug = requiredString(tool, "slug");
      if (
        asRecord(tool.toolkit).slug !== toolkitSlug ||
        !slug.startsWith(`${toolkitSlug.toUpperCase()}_`)
      ) {
        throw new Error("The service returned a tool for another app");
      }
      return {
        slug,
        name: connectToolNameV1(slug, toolkitSlug),
        description: requiredString(tool, "description"),
        inputSchema: inputSchemaOf(asRecord(tool.input_parameters)),
        version: requiredString(tool, "version"),
      };
    });
  }

  /**
   * Run one tool against one account. A tool-level failure is HTTP 200 with
   * `successful: false`; only transport and authorization are HTTP errors.
   */
  async executeTool(input: ExecuteToolInputV1): Promise<ExecuteToolResultV1> {
    const result = asRecord(
      await this.request(
        `/tools/execute/${encodeURIComponent(input.toolSlug)}`,
        {
          method: "POST",
          body: JSON.stringify({
            user_id: input.userId,
            connected_account_id: input.connectedAccountId,
            arguments: input.arguments,
            ...(input.version ? { version: input.version } : {}),
          }),
        },
      ),
    );
    if (typeof result.successful !== "boolean") {
      throw new Error("The service returned an invalid action result");
    }
    return {
      successful: result.successful,
      data: result.data ?? {},
      ...(typeof result.error === "string" && result.error
        ? { error: result.error.slice(0, 2000) }
        : {}),
    };
  }

  private async pages(path: string): Promise<unknown[]> {
    const items: unknown[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = asRecord(
        await this.request(
          path + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""),
        ),
      );
      if (!Array.isArray(result.items) || result.items.length > 1000) {
        throw new Error("The service returned an invalid list");
      }
      items.push(...result.items);
      if (items.length > 1000) {
        throw new Error("The service list exceeded its limit");
      }
      const next = result.next_cursor;
      if (next === undefined || next === null || next === "") return items;
      if (typeof next !== "string" || seen.has(next)) {
        throw new Error("The service returned an invalid list cursor");
      }
      seen.add(next);
      cursor = next;
    }
    throw new Error("The service list pagination exceeded its limit");
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
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetcher(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        redirect: "manual",
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
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
        if (size > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
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
