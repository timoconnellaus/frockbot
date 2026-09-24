// Brave Search's implementation of the provider-neutral `WebSearchV1`: the
// platform's own search, with nothing for a User to set up.
//
// AUTHORITY. `web_search` is the Web Package's `web-search` Capability. Like
// `web_fetch` it needs no Connection, so a Bot holds it while its Web switch
// is on — provided the deployment holds `BRAVE_SEARCH_API_KEY`. Without the
// key nothing mounts: the model is never offered a search it cannot run, and
// `web_fetch` is unaffected.
//
// THE KEY is the deployment's, read server-side when the Turn mounts and sent
// only in the `X-Subscription-Token` header. It never reaches a tool argument,
// a tool result, or the event log.
//
// SPEND. Every request costs the deployment money, so where the deployment
// bills, one search's price is reserved under the search's durable effect id
// before the request is sent. An answered request is charged and a refused one
// released. A request that got no answer at all stays reserved for
// reconciliation, because whether Brave counted it is unknown.
//
// EFFECT CLASS. Read-only, `idempotent: true`: see the contract.
import type {
  AgentRuntimeV1,
  RuntimeFeatureV1,
} from "@frockbot/core/contracts";
import type { SearchMeterV1 } from "@frockbot/app/billing/search";
import { readBoundedBodyV1, type WebFetchFn } from "./agent.js";
import {
  createWebSearchToolDefinitionV1,
  decodeWebSearchResponseV1,
  type WebSearchExecutionV1,
  type WebSearchRequestV1,
  type WebSearchResponseV1,
  type WebSearchV1,
} from "./contract.js";

/** Brave's Web Search API, as its reference documented it on 2026-09-24. */
export const BRAVE_WEB_SEARCH_ENDPOINT_V1 =
  "https://api.search.brave.com/res/v1/web/search";

/** The Worker secret that switches platform search on. */
export const BRAVE_SEARCH_API_KEY_SECRET_V1 = "BRAVE_SEARCH_API_KEY";

/** Ten results with their metadata are a few tens of KiB. */
const MAX_SEARCH_RESPONSE_BYTES = 256 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Brave's `web.results` in the contract's shape; nothing else it sends. */
function braveResults(body: unknown): { results: unknown[] } {
  if (!isRecord(body)) throw new Error("Brave Search returned invalid JSON");
  // A query nothing matched has no `web` section at all.
  if (body.web === undefined) return { results: [] };
  if (!isRecord(body.web) || !Array.isArray(body.web.results)) {
    throw new Error("Brave Search returned an unexpected response");
  }
  return {
    results: body.web.results.map((row) =>
      isRecord(row)
        ? { title: row.title, url: row.url, snippet: row.description }
        : row,
    ),
  };
}

/** What a refusal tells the model; never the key, never Brave's own body. */
function refusalMessage(status: number): string {
  if (status === 401 || status === 403) {
    return `Web search is unavailable right now (HTTP ${status}).`;
  }
  if (status === 429) {
    return "Web search is busy. Try again in a moment (HTTP 429).";
  }
  if (status === 422) {
    return "Web search could not run this query. Try a shorter one (HTTP 422).";
  }
  return `Web search failed (HTTP ${status}).`;
}

export interface BraveWebSearchConfigV1 {
  apiKey: string;
  /** Present where the deployment bills: one search's charge per effect. */
  meter?: SearchMeterV1;
  fetch?: WebFetchFn;
}

export class BraveWebSearchV1 implements WebSearchV1 {
  private readonly fetcher: WebFetchFn;

  constructor(private readonly config: BraveWebSearchConfigV1) {
    // Workerd rejects a detached global `fetch`, so the default forwards.
    this.fetcher =
      config.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  async search(
    request: WebSearchRequestV1,
    execution: WebSearchExecutionV1,
  ): Promise<WebSearchResponseV1> {
    const url = new URL(BRAVE_WEB_SEARCH_ENDPOINT_V1);
    url.searchParams.set("q", request.query);
    url.searchParams.set("count", String(request.maxResults));
    url.searchParams.set("result_filter", "web");
    // Plain snippets: decoration markers would be noise in the model's context.
    url.searchParams.set("text_decorations", "false");
    const charge = await this.config.meter?.reserve({
      effectId: execution.effectId,
      botId: execution.botId,
      sessionId: execution.sessionId,
    });
    // A throw here — a network failure or a cancelled Turn — leaves the
    // reservation held: Brave may have counted the request.
    const response = await this.fetcher(url.toString(), {
      method: "GET",
      headers: {
        accept: "application/json",
        "x-subscription-token": this.config.apiKey,
      },
      signal: execution.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      await charge?.release();
      throw new Error(refusalMessage(response.status));
    }
    // Brave answered, so the search was spent whatever the body turns out to be.
    await charge?.charge();
    const { bytes, truncated } = await readBoundedBodyV1(
      response,
      MAX_SEARCH_RESPONSE_BYTES,
    );
    if (truncated) throw new Error("Brave Search response is too large");
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error("Brave Search returned invalid JSON");
    }
    return decodeWebSearchResponseV1(braveResults(body), request);
  }
}

/**
 * The enablement fence. A Bot holds `web_search` only through this Package's
 * enabled `web-search` Capability, and only while the deployment holds a key.
 */
export function createConfiguredWebSearchRuntimeContribution(config: {
  capability: {
    packageId: string;
    capabilityId: string;
    connectionId?: string;
  };
  /** The deployment's key; absent, the deployment has no search to offer. */
  apiKey: string | undefined;
  meter?: SearchMeterV1;
  fetch?: WebFetchFn;
}): RuntimeFeatureV1<AgentRuntimeV1> | undefined {
  if (
    config.capability.packageId !== "web" ||
    config.capability.capabilityId !== "web-search" ||
    !config.apiKey
  ) {
    return undefined;
  }
  const provider = new BraveWebSearchV1({
    apiKey: config.apiKey,
    ...(config.meter ? { meter: config.meter } : {}),
    ...(config.fetch ? { fetch: config.fetch } : {}),
  });
  return (runtime) =>
    runtime.tools.register(createWebSearchToolDefinitionV1(provider), {
      admissionCeiling: ["chat", "agent", "automation", "subagent"],
      subagentRoleCeiling: ["executor"],
    });
}
