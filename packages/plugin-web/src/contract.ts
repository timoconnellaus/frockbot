// The provider-neutral web-search contract.
//
// The register (`docs/research/grokbot-computer.md:564`, row 47) names web
// search as a first-class tool but records no schema, no bound, and no error
// shape for it: none was ever measured. Everything here is FrockBot's own
// contract, defined from first principles, and it is deliberately narrower
// than any one provider's API so a second provider can satisfy it unchanged —
// the two-provider check the constitution applies to the model interface.
//
// This module holds no transport. `plugin-provider-ollama-cloud` implements
// {@link WebSearchV1} over `POST {apiBaseUrl}/api/web_search`; this Package
// never imports it.
import type { ToolDefinition, ToolSchema } from "@frockbot/kernel-contracts";

export const WEB_SEARCH_TOOL_NAME_V1 = "web_search";

/** Input bounds. A query longer than this is a paste, not a search. */
export const WEB_SEARCH_MAX_QUERY_LENGTH_V1 = 400;
export const WEB_SEARCH_MIN_RESULTS_V1 = 1;
export const WEB_SEARCH_MAX_RESULTS_V1 = 10;
export const WEB_SEARCH_DEFAULT_RESULTS_V1 = 5;

/**
 * Output bounds. A snippet is an orientation aid, not the page: a Bot that
 * wants the page calls `web_fetch`. Truncating here keeps one search from
 * spending a Turn's context, and keeps the durable `tool/result` small.
 */
export const WEB_SEARCH_MAX_SNIPPET_LENGTH_V1 = 1000;

export interface WebSearchResultV1 {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResponseV1 {
  query: string;
  results: WebSearchResultV1[];
}

export interface WebSearchRequestV1 {
  query: string;
  maxResults: number;
}

/**
 * What one search runs under: the durable effect identity of the tool call and
 * its cancellation signal. Both are kernel vocabulary, not provider
 * vocabulary — a provider that needs a per-call credential lease keys it on
 * `effectId`, and one that needs neither ignores both.
 */
export interface WebSearchExecutionV1 {
  effectId: string;
  signal: AbortSignal;
}

/** The narrow interface a search provider Package implements. */
export interface WebSearchV1 {
  search(
    request: WebSearchRequestV1,
    execution: WebSearchExecutionV1,
  ): Promise<WebSearchResponseV1>;
}

export const WEB_SEARCH_INPUT_SCHEMA_V1: ToolSchema["inputSchema"] = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description: "What to search the public web for.",
      minLength: 1,
      maxLength: WEB_SEARCH_MAX_QUERY_LENGTH_V1,
    },
    max_results: {
      type: "integer",
      description: `How many results to return, ${WEB_SEARCH_MIN_RESULTS_V1}–${WEB_SEARCH_MAX_RESULTS_V1}. Defaults to ${WEB_SEARCH_DEFAULT_RESULTS_V1}.`,
      minimum: WEB_SEARCH_MIN_RESULTS_V1,
      maximum: WEB_SEARCH_MAX_RESULTS_V1,
    },
  },
  required: ["query"],
  additionalProperties: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Decode the model's arguments at the tool seam. Throws with a plain reason. */
export function decodeWebSearchInputV1(input: unknown): WebSearchRequestV1 {
  if (!isRecord(input)) throw new Error("web_search input must be an object");
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (query.length === 0 || query.length > WEB_SEARCH_MAX_QUERY_LENGTH_V1) {
    throw new Error(
      `web_search query must be 1–${WEB_SEARCH_MAX_QUERY_LENGTH_V1} characters`,
    );
  }
  const requested = input.max_results ?? WEB_SEARCH_DEFAULT_RESULTS_V1;
  if (
    typeof requested !== "number" ||
    !Number.isSafeInteger(requested) ||
    requested < WEB_SEARCH_MIN_RESULTS_V1 ||
    requested > WEB_SEARCH_MAX_RESULTS_V1
  ) {
    throw new Error(
      `web_search max_results must be an integer ${WEB_SEARCH_MIN_RESULTS_V1}–${WEB_SEARCH_MAX_RESULTS_V1}`,
    );
  }
  return { query, maxResults: requested };
}

function boundedSnippet(value: unknown): string {
  const text =
    typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return text.slice(0, WEB_SEARCH_MAX_SNIPPET_LENGTH_V1);
}

/**
 * Decode a provider's answer at the seam it crosses. Anything the provider
 * adds is dropped, a result with no usable `url` is dropped, and the list is
 * trimmed to what was asked for — the model never sees a provider's shape.
 */
export function decodeWebSearchResponseV1(
  value: unknown,
  request: WebSearchRequestV1,
): WebSearchResponseV1 {
  if (!isRecord(value)) throw new Error("web search response is invalid");
  const rows = value.results;
  if (!Array.isArray(rows)) throw new Error("web search response is invalid");
  const results: WebSearchResultV1[] = [];
  for (const row of rows) {
    if (results.length >= request.maxResults) break;
    if (!isRecord(row)) continue;
    const url = typeof row.url === "string" ? row.url.trim() : "";
    if (url.length === 0 || url.length > 2048) continue;
    const title = typeof row.title === "string" ? row.title.trim() : "";
    results.push({
      title: title.slice(0, 300),
      url,
      // Ollama names the field `content`; the contract names it `snippet`.
      snippet: boundedSnippet(row.snippet ?? row.content ?? row.description),
    });
  }
  return { query: request.query, results };
}

/**
 * The durable `tool/result` body. The kernel event carries `content: string`
 * (`kernel-contracts/src/types.ts`), so every tool emits stable JSON rather
 * than prose: a later reader parses it instead of re-reading a sentence.
 */
export function encodeWebSearchResultV1(response: WebSearchResponseV1): string {
  return JSON.stringify(response);
}

/**
 * Build the `web_search` tool over any {@link WebSearchV1}. The definition,
 * its bounds, and its durable result shape live here so a second provider
 * Package contributes the same tool by supplying transport alone.
 *
 * `idempotent: true`: a search is read-only, so recovery after eviction
 * re-runs it rather than reconciling a recorded effect.
 */
export function createWebSearchToolDefinitionV1(
  provider: WebSearchV1,
): ToolDefinition {
  return {
    name: WEB_SEARCH_TOOL_NAME_V1,
    description:
      "Search the public web and return titles, URLs and short snippets. Use web_fetch to read a result in full.",
    inputSchema: WEB_SEARCH_INPUT_SCHEMA_V1,
    idempotent: true,
    validate: (input: unknown) => {
      try {
        decodeWebSearchInputV1(input);
        return true;
      } catch {
        return false;
      }
    },
    execute: async (input, context) => {
      let request: WebSearchRequestV1;
      try {
        request = decodeWebSearchInputV1(input);
      } catch (error) {
        return {
          content: JSON.stringify({
            error: "web-search-invalid-input",
            message: error instanceof Error ? error.message : "invalid input",
          }),
          isError: true,
        };
      }
      try {
        const response = await provider.search(request, {
          effectId: context.effectId,
          signal: context.signal,
        });
        return { content: encodeWebSearchResultV1(response), isError: false };
      } catch (error) {
        return {
          content: JSON.stringify({
            error: "web-search-failed",
            query: request.query,
            message: (error instanceof Error
              ? error.message
              : "web search failed"
            ).slice(0, 500),
          }),
          isError: true,
        };
      }
    },
  };
}
