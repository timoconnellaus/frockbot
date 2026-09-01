// Ollama Cloud's implementation of the provider-neutral `WebSearchV1`.
//
// WHY A NON-MODEL TOOL LIVES IN A MODEL PROVIDER PACKAGE. `/api/web_search`
// authenticates with the *same* key as `/api/chat` (measured, and recorded in
// `docs/research/ollama-cloud-auth.md`), and a credential is openable only by
// the Package that owns its Connection: `credentialLease.open` is called with
// this Package's id and the User Durable Object refuses any other. Putting the
// search transport anywhere else would mean either a second credential for the
// same account or a Package opening a Connection it does not own. The
// precedent is `plugin-composio`, whose tools are likewise a Connection-backed
// Capability. The tool's *contract* is not provider-specific: it lives in
// `@frockbot/plugin-web/contract`, and a second provider satisfies it with no
// change here and none in the kernel.
//
// AUTHORITY. `web_search` needs an enabled Assignment of the
// `ollama-cloud-web-search` Capability bound to a ready `ollama-cloud-account`
// Connection. Without one this module mounts nothing and the tool is simply
// absent from the catalog, which is what "fail visibly" means for a tool: the
// model is never offered a capability the Bot does not hold.
//
// EFFECT CLASS. Read-only, `idempotent: true`. A search records no intent and
// recovers by re-running.
import {
  decodeWebSearchResponseV1,
  createWebSearchToolDefinitionV1,
  type WebSearchExecutionV1,
  type WebSearchRequestV1,
  type WebSearchResponseV1,
  type WebSearchV1,
} from "@frockbot/plugin-web/contract";
import type { CredentialLeaseV1 } from "@frockbot/connection-core";
// The `credentialLease` service is declared once, by `./runtime.ts`; this
// module consumes that augmentation rather than restating it.
import type {} from "./runtime.js";
import type { Plugin } from "cordis";
import {
  DEFAULT_OLLAMA_API_BASE_URL,
  decodeOllamaApiBaseUrl,
  type OllamaFetch,
} from "./client.js";

/** The provider answer is bounded before it is parsed, as chat's is. */
const MAX_SEARCH_RESPONSE_BYTES = 256 * 1024;

/**
 * Compose the web-search endpoint from a Connection's endpoint root — the
 * *same* resolved base chat uses, so a Connection pointed at a local Ollama or
 * an Ollama-compatible host searches there too rather than silently reaching
 * `https://ollama.com` with that host's key.
 */
export function ollamaWebSearchUrl(apiBaseUrl?: string): string {
  return `${decodeOllamaApiBaseUrl(apiBaseUrl ?? DEFAULT_OLLAMA_API_BASE_URL)}/api/web_search`;
}

async function boundedJson(
  response: Response,
  maximum: number,
): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximum) {
    throw new Error("Ollama Cloud web search response is too large");
  }
  const chunks: Uint8Array[] = [];
  let length = 0;
  const reader = response.body?.getReader();
  if (reader) {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximum) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Ollama Cloud web search response is too large");
      }
      chunks.push(chunk.value);
    }
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error("Ollama Cloud web search returned invalid JSON");
  }
}

export interface OllamaWebSearchClientConfig {
  apiBaseUrl?: string;
  fetch?: OllamaFetch;
}

/** The transport, and nothing else: no authority, no credential of its own. */
export class OllamaCloudWebSearchClient {
  private readonly endpoint: string;
  private readonly fetcher: OllamaFetch;

  constructor(config: OllamaWebSearchClientConfig = {}) {
    this.endpoint = ollamaWebSearchUrl(config.apiBaseUrl);
    // Workerd rejects a detached global `fetch`, so the default forwards.
    this.fetcher =
      config.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  async search(
    apiKey: string,
    request: WebSearchRequestV1,
    signal?: AbortSignal,
  ): Promise<WebSearchResponseV1> {
    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query: request.query,
        max_results: request.maxResults,
      }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 401 || response.status === 403) {
        throw new Error(
          "Ollama Cloud rejected the key for web search (HTTP " +
            `${response.status})`,
        );
      }
      throw new Error(`Ollama Cloud web search failed (${response.status})`);
    }
    return decodeWebSearchResponseV1(
      await boundedJson(response, MAX_SEARCH_RESPONSE_BYTES),
      request,
    );
  }
}

interface CredentialLeaseOpener {
  open(input: {
    accountId: string;
    connectionId: string;
    packageId: string;
    lease: CredentialLeaseV1;
  }): Promise<string>;
}

export interface OllamaWebSearchRuntimeConfig {
  accountId: string;
  connectionId: string;
  connectionGeneration: string;
  packageId: "provider-ollama-cloud";
  /** The endpoint root carried on the Connection's own settings bag. */
  apiBaseUrl?: string;
  /**
   * The Package-level `web-search-max-results` setting: the User's ceiling on
   * how many results one search returns, whatever the model asked for. Absent
   * leaves the model's own request — bounded by the contract — untouched.
   */
  maxResults?: number;
  leaseCredential(
    effectId: string,
    expectedGeneration?: string,
  ): Promise<CredentialLeaseV1>;
  settleCredential(effectId: string): Promise<void>;
  fetch?: OllamaFetch;
  now?: () => number;
}

/**
 * The credential is leased per tool call, keyed by the call's durable
 * `effectId`, opened inside this Package, used, and settled — the same shape
 * the model path uses. The key never reaches a tool argument, a tool result,
 * or the event log.
 */
class ConnectionBackedWebSearch implements WebSearchV1 {
  constructor(
    private readonly config: OllamaWebSearchRuntimeConfig,
    private readonly credentialLease: CredentialLeaseOpener,
    private readonly client: OllamaCloudWebSearchClient,
  ) {}

  /** The request, capped by the Package-level setting when the User set one. */
  private bound(request: WebSearchRequestV1): WebSearchRequestV1 {
    const ceiling = this.config.maxResults;
    if (ceiling === undefined || request.maxResults <= ceiling) return request;
    return { ...request, maxResults: ceiling };
  }

  async search(
    request: WebSearchRequestV1,
    execution: WebSearchExecutionV1,
  ): Promise<WebSearchResponseV1> {
    const effectId = execution.effectId;
    // The User's ceiling is applied before the provider is asked, so a model
    // that requests more than the User allows never causes the extra results
    // to be fetched, let alone recorded on the Turn.
    const bounded = this.bound(request);
    const lease = await this.config.leaseCredential(
      effectId,
      this.config.connectionGeneration,
    );
    try {
      if (
        lease.effectId !== effectId ||
        lease.connectionId !== this.config.connectionId ||
        lease.credentialGeneration !== this.config.connectionGeneration ||
        Date.parse(lease.expiresAt) <= (this.config.now ?? Date.now)()
      ) {
        throw new Error("Ollama Cloud credential lease is invalid");
      }
      const apiKey = await this.credentialLease.open({
        accountId: this.config.accountId,
        connectionId: this.config.connectionId,
        packageId: this.config.packageId,
        lease,
      });
      return await this.client.search(apiKey, bounded, execution.signal);
    } finally {
      await this.config.settleCredential(effectId).catch(() => undefined);
    }
  }
}

/** Mount `web_search` for one authorized Connection. */
export function createOllamaWebSearchRuntimePlugin(
  config: OllamaWebSearchRuntimeConfig,
): Plugin.Function {
  const plugin: Plugin.Function = (ctx) => {
    const client = new OllamaCloudWebSearchClient({
      ...(config.apiBaseUrl === undefined
        ? {}
        : { apiBaseUrl: config.apiBaseUrl }),
      ...(config.fetch ? { fetch: config.fetch } : {}),
    });
    const definition = createWebSearchToolDefinitionV1(
      new ConnectionBackedWebSearch(config, ctx.credentialLease, client),
    );
    return ctx.tools.register(definition, {
      admissionCeiling: ["chat", "automation", "subagent", "channel"],
      subagentRoleCeiling: ["executor"],
    });
  };
  plugin.inject = ["tools", "credentialLease"];
  return plugin;
}

/**
 * The Assignment fence (D3): `web_search` exists for a Bot only through an
 * enabled Assignment of `ollama-cloud-web-search` bound to a Connection. There
 * is no unauthenticated fallback provider.
 */
export function createConfiguredOllamaWebSearchRuntimeContribution(config: {
  assignment: {
    packageId: string;
    capabilityId: string;
    connectionId?: string;
    state: string;
  };
  accountId: string;
  connectionId: string;
  connectionGeneration: string;
  apiBaseUrl?: string;
  /** `web-search-max-results`, when this User set it on the Package. */
  maxResults?: number;
  leaseCredential(
    effectId: string,
    expectedGeneration?: string,
  ): Promise<CredentialLeaseV1>;
  settleCredential(effectId: string): Promise<void>;
  fetch?: OllamaFetch;
}): Plugin.Function | undefined {
  if (
    config.assignment.packageId !== "provider-ollama-cloud" ||
    config.assignment.capabilityId !== "ollama-cloud-web-search" ||
    config.assignment.state !== "enabled" ||
    config.assignment.connectionId !== config.connectionId
  ) {
    return undefined;
  }
  return createOllamaWebSearchRuntimePlugin({
    accountId: config.accountId,
    connectionId: config.connectionId,
    connectionGeneration: config.connectionGeneration,
    packageId: "provider-ollama-cloud",
    ...(config.apiBaseUrl === undefined
      ? {}
      : { apiBaseUrl: config.apiBaseUrl }),
    ...(config.maxResults === undefined
      ? {}
      : { maxResults: config.maxResults }),
    leaseCredential: config.leaseCredential,
    settleCredential: config.settleCredential,
    ...(config.fetch ? { fetch: config.fetch } : {}),
  });
}
