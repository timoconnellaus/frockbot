// The search providers a person brings: Exa and Tavily on their own key, and
// SearXNG at their own address. Brave on their own key is `./brave.ts` with
// `ownKey`. Each implements the provider-neutral `WebSearchV1` by transport
// alone, and none is metered: the person pays the provider, not FrockBot.
//
// The key or address arrives already opened for one search and is used for
// that one request. Every answer is decoded into the contract's shape at the
// seam, so nothing else a provider sends reaches the model.
import type { WebFetchFn } from "./agent.js";
import {
  decodeWebSearchResponseV1,
  WEB_SEARCH_MAX_SNIPPET_LENGTH_V1,
  type WebSearchExecutionV1,
  type WebSearchRequestV1,
  type WebSearchResponseV1,
  type WebSearchV1,
} from "./contract.js";
import { normalizeSearxngUrlV1 } from "./search-choice.js";
import {
  accountSearchRefusalV1,
  isSearchRecordV1 as isRecord,
  readSearchJsonV1,
} from "./search-http.js";

/** Exa's search API, as its reference documented it on 2026-09-30. */
export const EXA_SEARCH_ENDPOINT_V1 = "https://api.exa.ai/search";

/** Tavily's search API, as its reference documented it on 2026-09-30. */
export const TAVILY_SEARCH_ENDPOINT_V1 = "https://api.tavily.com/search";

export interface AccountSearchProviderConfigV1 {
  /** The key, or for SearXNG the instance's address, opened for this search. */
  secret: string;
  fetch?: WebFetchFn;
}

function fetcherFor(config: AccountSearchProviderConfigV1): WebFetchFn {
  // Workerd rejects a detached global `fetch`, so the default forwards.
  return config.fetch ?? ((input, init) => globalThis.fetch(input, init));
}

/**
 * What every one of these providers does with its answer: a refusal becomes
 * the person-facing error, and each `results` row is mapped to the contract's
 * shape by the provider's own snippet field before the seam decodes it.
 */
async function decodeAnswer(
  response: Response,
  providerName: string,
  request: WebSearchRequestV1,
  snippetOf: (row: Record<string, unknown>) => unknown,
): Promise<WebSearchResponseV1> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(accountSearchRefusalV1(providerName, response.status));
  }
  const body = await readSearchJsonV1(response, providerName);
  if (!isRecord(body) || !Array.isArray(body.results)) {
    throw new Error(`${providerName} returned an unexpected response`);
  }
  return decodeWebSearchResponseV1(
    {
      results: body.results.map((row) =>
        isRecord(row)
          ? { title: row.title, url: row.url, snippet: snippetOf(row) }
          : row,
      ),
    },
    request,
  );
}

export class ExaWebSearchV1 implements WebSearchV1 {
  constructor(private readonly config: AccountSearchProviderConfigV1) {}

  async search(
    request: WebSearchRequestV1,
    execution: WebSearchExecutionV1,
  ): Promise<WebSearchResponseV1> {
    const response = await fetcherFor(this.config)(EXA_SEARCH_ENDPOINT_V1, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-api-key": this.config.secret,
      },
      body: JSON.stringify({
        query: request.query,
        numResults: request.maxResults,
        type: "auto",
        // The snippet is the page's own text, cut to what the contract keeps.
        contents: { text: { maxCharacters: WEB_SEARCH_MAX_SNIPPET_LENGTH_V1 } },
      }),
      signal: execution.signal,
    });
    return decodeAnswer(response, "Exa", request, (row) =>
      typeof row.text === "string" ? row.text : row.summary,
    );
  }
}

export class TavilyWebSearchV1 implements WebSearchV1 {
  constructor(private readonly config: AccountSearchProviderConfigV1) {}

  async search(
    request: WebSearchRequestV1,
    execution: WebSearchExecutionV1,
  ): Promise<WebSearchResponseV1> {
    const response = await fetcherFor(this.config)(TAVILY_SEARCH_ENDPOINT_V1, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: `Bearer ${this.config.secret}`,
      },
      body: JSON.stringify({
        query: request.query,
        max_results: request.maxResults,
        // One credit a search; `advanced` costs the person two.
        search_depth: "basic",
        topic: "general",
      }),
      signal: execution.signal,
    });
    return decodeAnswer(response, "Tavily", request, (row) => row.content);
  }
}

/**
 * A SearXNG instance's JSON API. The instance must list `json` under
 * `search.formats` in its `settings.yml`; one that does not answers 403,
 * which is reported as exactly that.
 */
export class SearxngWebSearchV1 implements WebSearchV1 {
  constructor(private readonly config: AccountSearchProviderConfigV1) {}

  async search(
    request: WebSearchRequestV1,
    execution: WebSearchExecutionV1,
  ): Promise<WebSearchResponseV1> {
    // Checked again here, not only when saved: the address is what this
    // request reaches from inside the Bot's Durable Object.
    const url = new URL("search", normalizeSearxngUrlV1(this.config.secret));
    url.searchParams.set("q", request.query);
    url.searchParams.set("format", "json");
    const response = await fetcherFor(this.config)(url.toString(), {
      method: "GET",
      headers: { accept: "application/json" },
      // A redirect could lead anywhere, so it is a failure, not a hop.
      redirect: "manual",
      signal: execution.signal,
    });
    if (response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(
        "Your SearXNG instance refused the JSON format (HTTP 403). Add json to search.formats in its settings.yml.",
      );
    }
    // SearXNG has no result-count parameter; the decoder trims to the ask.
    return decodeAnswer(response, "SearXNG", request, (row) => row.content);
  }
}
