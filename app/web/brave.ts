// Brave Search's implementation of the provider-neutral `WebSearchV1`. It is
// FrockBot's own search — the platform's, on the deployment's key, with
// nothing for a User to set up — and also one a person may bring on their own
// key (`./search.ts` chooses between them).
//
// THE KEY is read server-side when the Turn mounts (the deployment's) or
// leased for the one search (the person's), and sent only in the
// `X-Subscription-Token` header. It never reaches a tool argument, a tool
// result, or the event log.
//
// SPEND. On the deployment's key every request costs the deployment money, so
// where the deployment bills, one search's price is reserved under the
// search's durable effect id before the request is sent. An answered request
// is charged and a refused one released. A request that got no answer at all
// stays reserved for reconciliation, because whether Brave counted it is
// unknown. On the person's own key nothing is metered.
//
// EFFECT CLASS. Read-only, `idempotent: true`: see the contract.
import type { SearchMeterV1 } from "@frockbot/app/billing/search";
import type { WebFetchFn } from "./agent.js";
import {
  decodeWebSearchResponseV1,
  type WebSearchExecutionV1,
  type WebSearchRequestV1,
  type WebSearchResponseV1,
  type WebSearchV1,
} from "./contract.js";
import {
  accountSearchRefusalV1,
  isSearchRecordV1 as isRecord,
  readSearchJsonV1,
} from "./search-http.js";

/** Brave's Web Search API, as its reference documented it on 2026-09-24. */
export const BRAVE_WEB_SEARCH_ENDPOINT_V1 =
  "https://api.search.brave.com/res/v1/web/search";

/** The Worker secret that switches platform search on. */
export const BRAVE_SEARCH_API_KEY_SECRET_V1 = "BRAVE_SEARCH_API_KEY";

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
  /** The person's own key: refusals say so, and nothing is metered. */
  ownKey?: boolean;
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
      throw new Error(
        this.config.ownKey
          ? accountSearchRefusalV1("Brave Search", response.status)
          : refusalMessage(response.status),
      );
    }
    // Brave answered, so the search was spent whatever the body turns out to be.
    await charge?.charge();
    const body = await readSearchJsonV1(response, "Brave Search");
    return decodeWebSearchResponseV1(braveResults(body), request);
  }
}
