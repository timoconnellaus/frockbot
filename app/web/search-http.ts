// What every search provider's transport shares: a bounded JSON read, and the
// refusal the model sees when a provider the person brought turns a search
// down. Neither ever quotes a key or the provider's own error body.
import { readBoundedBodyV1 } from "./agent.js";

/** Ten results with their metadata are a few tens of KiB. */
export const MAX_SEARCH_RESPONSE_BYTES_V1 = 256 * 1024;

export async function readSearchJsonV1(
  response: Response,
  providerName: string,
): Promise<unknown> {
  const { bytes, truncated } = await readBoundedBodyV1(
    response,
    MAX_SEARCH_RESPONSE_BYTES_V1,
  );
  if (truncated) throw new Error(`${providerName} response is too large`);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(`${providerName} returned invalid JSON`);
  }
}

export function isSearchRecordV1(
  value: unknown,
): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A refusal from the person's own provider. It says whose search it was, so
 * the model tells them to fix their setup rather than retrying, and it never
 * suggests FrockBot's search will step in: it does not.
 */
export function accountSearchRefusalV1(
  providerName: string,
  status: number,
): string {
  if (status === 401 || status === 403) {
    return `Your ${providerName} search refused the request (HTTP ${status}). The key or address saved for web search may be wrong or revoked.`;
  }
  if (status === 402 || status === 432 || status === 433) {
    return `Your ${providerName} search is out of credit or over its plan limit (HTTP ${status}).`;
  }
  if (status === 429) {
    return `Your ${providerName} search is rate limited. Try again in a moment (HTTP 429).`;
  }
  return `Your ${providerName} search failed (HTTP ${status}).`;
}
