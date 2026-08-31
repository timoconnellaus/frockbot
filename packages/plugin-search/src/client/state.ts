import type { InjectionKey, Ref } from "vue";
import type {
  ClientSearchResultsV1,
  SearchIndexStateV1,
  SearchRowKindV1,
} from "../shared.js";

/**
 * The Search surface's client state.
 *
 * It renders backend state and submits commands; it is not a second authority.
 * The index state, the grouping, and every deep link come from the route, so
 * the overlay never assembles one out of parts it might get wrong.
 */
export interface SearchWebData {
  query: string;
  /** Undefined until a query has been run at all: "empty" and "no results" differ. */
  results?: ClientSearchResultsV1;
  loading: boolean;
  rebuilding: boolean;
  error?: string;
  includeArchived: boolean;
  includeTools: boolean;
  indexState: SearchIndexStateV1;
  /** Runs the current query, debounced by the caller. */
  run(): Promise<void>;
  setQuery(value: string): void;
  setIncludeArchived(value: boolean): void;
  setIncludeTools(value: boolean): void;
  /** Rebuilds the whole index from the Bots' own stored runs. */
  rebuild(): Promise<void>;
  /** Switches to the Bot and scrolls its conversation to the turn. */
  openHit(botId: string, runId: string, deepLink: string): Promise<void>;
  open(): void;
  close(): void;
}

export function searchKindsV1(includeTools: boolean): SearchRowKindV1[] {
  return includeTools ? ["user", "assistant", "tool"] : ["user", "assistant"];
}

export const searchWebDataKey: InjectionKey<Ref<SearchWebData>> = Symbol(
  "frockbot-search-web-data",
);
