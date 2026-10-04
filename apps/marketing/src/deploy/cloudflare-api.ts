/**
 * The slice of the Cloudflare REST API the deploy flow calls, on the signed-in
 * person's behalf.
 *
 * Every call carries that person's token and nothing of ours. A call that
 * fails throws `CloudflareApiErrorV1` with Cloudflare's own codes, which is
 * what the account checks read to pick the right fix.
 */

export const CLOUDFLARE_API_V1 = "https://api.cloudflare.com/client/v4";

export class CloudflareApiErrorV1 extends Error {
  constructor(
    readonly status: number,
    readonly codes: readonly number[],
    message: string,
    readonly path: string,
  ) {
    super(message);
  }

  has(code: number): boolean {
    return this.codes.includes(code);
  }
}

export type FetchV1 = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

interface EnvelopeV1<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: T;
  result_info?: { page?: number; total_pages?: number; cursor?: string };
}

export interface CloudflareUserV1 {
  readonly id: string;
  readonly email: string;
}

export interface CloudflareAccountV1 {
  readonly id: string;
  readonly name: string;
}

export interface AccessOrganizationV1 {
  readonly name: string;
  readonly auth_domain: string;
}

export interface AccessApplicationV1 {
  readonly id: string;
  readonly aud: string;
  readonly name: string;
  readonly domain: string;
}

export interface AccessApplicationInputV1 {
  readonly name: string;
  readonly domain: string;
  readonly decision: "allow" | "bypass";
  /** For `allow`: the one email admitted. */
  readonly email?: string;
}

export interface ScriptSummaryV1 {
  readonly id: string;
  readonly migration_tag?: string;
}

export interface ScriptUploadV1 {
  readonly metadata: Record<string, unknown>;
  readonly modules: readonly {
    readonly name: string;
    readonly contentType: string;
    readonly body: Uint8Array<ArrayBuffer>;
  }[];
}

export class CloudflareApiV1 {
  constructor(
    private readonly token: string,
    private readonly fetcher: FetchV1 = (input, init) => fetch(input, init),
  ) {}

  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
    init: { headers?: Record<string, string>; raw?: BodyInit } = {},
  ): Promise<EnvelopeV1<T>> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      ...init.headers,
    };
    let payload: BodyInit | undefined = init.raw;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const response = await this.fetcher(`${CLOUDFLARE_API_V1}${path}`, {
      method,
      headers,
      ...(payload === undefined ? {} : { body: payload }),
    });
    const text = await response.text();
    let envelope: EnvelopeV1<T> | undefined;
    try {
      envelope = JSON.parse(text) as EnvelopeV1<T>;
    } catch {
      envelope = undefined;
    }
    if (!response.ok || !envelope || envelope.success === false) {
      const errors = envelope?.errors ?? [];
      throw new CloudflareApiErrorV1(
        response.status,
        errors.map((e) => e.code),
        errors.map((e) => e.message).join("; ") ||
          `Cloudflare answered ${response.status} to ${method} ${path}`,
        path,
      );
    }
    return envelope;
  }

  private async result<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    return (await this.call<T>(method, path, body)).result;
  }

  /** Every page of a paged list. */
  private async all<T>(path: string): Promise<T[]> {
    const found: T[] = [];
    const separator = path.includes("?") ? "&" : "?";
    for (let page = 1; page < 50; page += 1) {
      const envelope = await this.call<T[]>(
        "GET",
        `${path}${separator}page=${page}&per_page=50`,
      );
      found.push(...(envelope.result ?? []));
      const total = envelope.result_info?.total_pages ?? 1;
      if (page >= total || (envelope.result ?? []).length === 0) break;
    }
    return found;
  }

  /** `null` when the thing is not there, rather than an error. */
  private async maybe<T>(method: string, path: string): Promise<T | null> {
    try {
      return await this.result<T>(method, path);
    } catch (error) {
      if (error instanceof CloudflareApiErrorV1 && error.status === 404)
        return null;
      throw error;
    }
  }

  user(): Promise<CloudflareUserV1> {
    return this.result("GET", "/user");
  }

  accounts(): Promise<CloudflareAccountV1[]> {
    return this.all("/accounts");
  }

  /** The account's `workers.dev` subdomain, or `null` when it has none yet. */
  async workersSubdomain(accountId: string): Promise<string | null> {
    try {
      const found = await this.result<{ subdomain?: string }>(
        "GET",
        `/accounts/${accountId}/workers/subdomain`,
      );
      return found.subdomain || null;
    } catch (error) {
      if (
        error instanceof CloudflareApiErrorV1 &&
        (error.status === 404 || error.has(10007))
      ) {
        return null;
      }
      throw error;
    }
  }

  async createWorkersSubdomain(
    accountId: string,
    subdomain: string,
  ): Promise<string> {
    const made = await this.result<{ subdomain: string }>(
      "PUT",
      `/accounts/${accountId}/workers/subdomain`,
      { subdomain },
    );
    return made.subdomain;
  }

  /** The account's Zero Trust account, which exists once Zero Trust is turned on. */
  zeroTrustAccount(accountId: string): Promise<unknown> {
    return this.maybe("GET", `/accounts/${accountId}/gateway`);
  }

  accessOrganization(accountId: string): Promise<AccessOrganizationV1 | null> {
    return this.maybe("GET", `/accounts/${accountId}/access/organizations`);
  }

  createAccessOrganization(
    accountId: string,
    organization: AccessOrganizationV1,
  ): Promise<AccessOrganizationV1> {
    return this.result("POST", `/accounts/${accountId}/access/organizations`, {
      ...organization,
      login_design: {},
      is_ui_read_only: false,
    });
  }

  accessApplications(accountId: string): Promise<AccessApplicationV1[]> {
    return this.all(`/accounts/${accountId}/access/apps`);
  }

  /**
   * Create or update the one application for this destination.
   *
   * Found by domain, so a second deploy converges on the same application and
   * the same audience tag instead of stacking a new one beside it.
   */
  async putAccessApplication(
    accountId: string,
    input: AccessApplicationInputV1,
    existing: readonly AccessApplicationV1[],
  ): Promise<AccessApplicationV1> {
    const include =
      input.decision === "allow"
        ? [{ email: { email: input.email } }]
        : [{ everyone: {} }];
    const body = {
      type: "self_hosted",
      name: input.name,
      domain: input.domain,
      session_duration: "720h",
      app_launcher_visible: input.decision === "allow",
      policies: [
        {
          name: input.decision === "allow" ? "Owner" : "Reached by the Worker",
          decision: input.decision,
          include,
          precedence: 1,
        },
      ],
    };
    const found = existing.find((app) => app.domain === input.domain);
    return found
      ? this.result(
          "PUT",
          `/accounts/${accountId}/access/apps/${found.id}`,
          body,
        )
      : this.result("POST", `/accounts/${accountId}/access/apps`, body);
  }

  async ensureR2Bucket(accountId: string, name: string): Promise<void> {
    const found = await this.maybe(
      "GET",
      `/accounts/${accountId}/r2/buckets/${name}`,
    );
    if (!found)
      await this.result("POST", `/accounts/${accountId}/r2/buckets`, { name });
  }

  /** Lists buckets, which is how an account without R2 turned on is told apart. */
  async r2Buckets(accountId: string): Promise<{ name: string }[]> {
    const found = await this.result<{ buckets?: { name: string }[] }>(
      "GET",
      `/accounts/${accountId}/r2/buckets`,
    );
    return found.buckets ?? [];
  }

  async ensureVectorizeIndex(
    accountId: string,
    name: string,
    config: { dimensions: number; metric: string },
  ): Promise<void> {
    const found = await this.maybe(
      "GET",
      `/accounts/${accountId}/vectorize/v2/indexes/${name}`,
    );
    if (!found) {
      await this.result("POST", `/accounts/${accountId}/vectorize/v2/indexes`, {
        name,
        config,
      });
    }
  }

  async script(
    accountId: string,
    name: string,
  ): Promise<ScriptSummaryV1 | null> {
    const scripts = await this.result<ScriptSummaryV1[]>(
      "GET",
      `/accounts/${accountId}/workers/scripts`,
    );
    return scripts.find((s) => s.id === name) ?? null;
  }

  async scriptSecretNames(accountId: string, name: string): Promise<string[]> {
    const found = await this.maybe<{ name: string }[]>(
      "GET",
      `/accounts/${accountId}/workers/scripts/${name}/secrets`,
    );
    return (found ?? []).map((s) => s.name);
  }

  async uploadScript(
    accountId: string,
    name: string,
    upload: ScriptUploadV1,
  ): Promise<void> {
    const form = new FormData();
    form.append(
      "metadata",
      new File([JSON.stringify(upload.metadata)], "metadata.json", {
        type: "application/json",
      }),
    );
    for (const module of upload.modules) {
      form.append(
        module.name,
        new File([module.body], module.name, { type: module.contentType }),
      );
    }
    await this.call(
      "PUT",
      `/accounts/${accountId}/workers/scripts/${name}`,
      undefined,
      {
        raw: form,
      },
    );
  }

  async deleteScript(accountId: string, name: string): Promise<void> {
    try {
      await this.result(
        "DELETE",
        `/accounts/${accountId}/workers/scripts/${name}?force=true`,
      );
    } catch (error) {
      if (!(error instanceof CloudflareApiErrorV1 && error.status === 404))
        throw error;
    }
  }

  /** Puts the Worker on the account's `workers.dev` subdomain. */
  async enableWorkersDev(accountId: string, name: string): Promise<void> {
    await this.result(
      "POST",
      `/accounts/${accountId}/workers/scripts/${name}/subdomain`,
      { enabled: true, previews_enabled: false },
    );
  }
}
