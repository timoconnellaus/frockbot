// The Search Package's gateway Contribution.
//
// It sits on the same host as Flock's `/api/bots`, for the same reason: the
// gateway is where an authenticated `userId` exists, and search is User-scoped
// by construction — there is no cross-User store to leak from, and the User
// Durable Object refuses any RPC naming a User it is not.
//
// The route owns no state. It decodes the query, asks the User Durable Object,
// joins the live Bot directory, and answers. Archived Bots are excluded unless
// asked for, and hidden Bots are returned labelled rather than dropped: the
// sidebar hides them, which is not the same as them not existing.
import type { Plugin } from "cordis";
import type {
  BotIdentityDirectoryViewV1,
  BotLifecycleDirectoryViewV1,
} from "@frockbot/plugin-flock/shared";
import { groupSearchHitsV1, type SearchBotDescriptorV1 } from "./groups.js";
import {
  decodeSearchQueryV1,
  SearchDecodeError,
  SEARCH_MAX_CURSOR_LENGTH_V1,
  SEARCH_MAX_QUERY_LENGTH_V1,
  type ClientSearchRebuildReceiptV1,
  type ClientSearchResultsV1,
  type SearchIndexResultsV1,
  type SearchQueryV1,
  type SearchRowKindV1,
} from "./shared.js";
import { defineGatewayContribution } from "@frockbot/kernel-contracts/contributions";

export interface SearchGatewayHost {
  searchTranscripts(
    userId: string,
    query: SearchQueryV1,
  ): Promise<SearchIndexResultsV1>;
  rebuildSearchIndex(userId: string): Promise<ClientSearchRebuildReceiptV1>;
  listBotIdentities(userId: string): Promise<BotIdentityDirectoryViewV1>;
  listBotLifecycles(userId: string): Promise<BotLifecycleDirectoryViewV1>;
}

export interface SearchBackendRouteContribution {
  packageId: string;
  route(
    request: Request,
    url: URL,
    context: { userId?: string; client: "browser" | "desktop" },
  ): Promise<Response | undefined>;
}

const ALLOWED_PARAMS = new Set([
  "q",
  "before",
  "kinds",
  "botId",
  "includeArchived",
]);

/**
 * The query string, decoded into the exact DTO.
 *
 * URL parameters are the loosest input the Package takes, so they are turned
 * into the same `SearchQueryV1` every other caller uses and decoded by the
 * same decoder. An unexpected parameter is a refusal rather than something
 * quietly ignored, so a client that means something the route does not
 * implement finds out.
 */
export function decodeSearchRequestQueryV1(url: URL): SearchQueryV1 {
  for (const key of url.searchParams.keys()) {
    if (!ALLOWED_PARAMS.has(key)) {
      throw new SearchDecodeError(`search query.${key} is not allowed`);
    }
    if (url.searchParams.getAll(key).length > 1) {
      throw new SearchDecodeError(`search query.${key} is repeated`);
    }
  }
  const query = url.searchParams.get("q") ?? "";
  if (query.length > SEARCH_MAX_QUERY_LENGTH_V1) {
    throw new SearchDecodeError("search query.q must be a bounded string");
  }
  const before = url.searchParams.get("before");
  if (before !== null && before.length > SEARCH_MAX_CURSOR_LENGTH_V1) {
    throw new SearchDecodeError("search query.before must be a bounded string");
  }
  const kinds = url.searchParams.get("kinds");
  const includeArchived = url.searchParams.get("includeArchived");
  if (
    includeArchived !== null &&
    !["true", "false"].includes(includeArchived)
  ) {
    throw new SearchDecodeError("search query.includeArchived is invalid");
  }
  const botId = url.searchParams.get("botId");
  return decodeSearchQueryV1({
    schemaVersion: 1,
    query,
    ...(before === null ? {} : { before }),
    ...(kinds === null
      ? {}
      : {
          kinds: kinds
            .split(",")
            .map((kind) => kind.trim())
            .filter((kind) => kind.length > 0)
            .filter(
              (kind, index, all) => all.indexOf(kind) === index,
            ) as SearchRowKindV1[],
        }),
    ...(botId === null ? {} : { botId }),
    ...(includeArchived === null
      ? {}
      : { includeArchived: includeArchived === "true" }),
  });
}

function errorResponse(error: unknown): Response {
  if (
    error instanceof SearchDecodeError ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "SearchDecodeError")
  ) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "search request is invalid",
        code: "invalid-request",
        definitive: true,
      },
      { status: 400 },
    );
  }
  return Response.json(
    { error: error instanceof Error ? error.message : "search failed" },
    { status: 500 },
  );
}

/** The live directory a query is grouped and filtered against. */
async function readDirectory(
  host: SearchGatewayHost,
  userId: string,
): Promise<SearchBotDescriptorV1[]> {
  const [identities, lifecycles] = await Promise.all([
    host.listBotIdentities(userId),
    host.listBotLifecycles(userId),
  ]);
  const status = new Map(
    lifecycles.lifecycles.map((lifecycle) => [
      lifecycle.botId,
      lifecycle.status,
    ]),
  );
  return identities.identities.map((identity) => ({
    botId: identity.botId,
    name: identity.name,
    archived: status.get(identity.botId) === "archived",
    hidden: identity.hiddenFromSidebar,
  }));
}

export function createSearchBackendContribution(
  host: SearchGatewayHost,
): SearchBackendRouteContribution {
  return {
    packageId: "search",
    async route(request, url, context) {
      if (!context.userId) return undefined;
      const isSearch = url.pathname === "/api/search";
      const isRebuild = url.pathname === "/api/search/rebuild";
      if (!isSearch && !isRebuild) return undefined;
      const userId = context.userId;
      try {
        if (isRebuild) {
          if (request.method !== "POST") {
            return Response.json(
              { error: "method not allowed" },
              { status: 405 },
            );
          }
          return Response.json(await host.rebuildSearchIndex(userId));
        }
        if (request.method !== "GET") {
          return Response.json(
            { error: "method not allowed" },
            { status: 405 },
          );
        }
        const query = decodeSearchRequestQueryV1(url);
        const [results, directory] = await Promise.all([
          host.searchTranscripts(userId, query),
          readDirectory(host, userId),
        ]);
        // Archiving is already applied inside the index, against this same
        // live directory, so this route filters nothing: it only names the
        // Bots the hits belong to. One filter, in the place that owns the
        // rows, is the only way the two can never disagree.
        const grouped: ClientSearchResultsV1 = groupSearchHitsV1(
          results,
          directory,
        );
        return Response.json(grouped);
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

export namespace createSearchBackendContribution {
  export function plugin(
    host: SearchGatewayHost,
    lifecycle: { mount(value: SearchBackendRouteContribution): () => void },
  ): Plugin {
    return () => lifecycle.mount(createSearchBackendContribution(host));
  }
}

/**
 * The manifest's gateway `backend` entry, resolved by specifier. The
 * application looks this descriptor up in its Contribution table; it never
 * branches on which Package it belongs to.
 */
export const backendContribution = defineGatewayContribution<
  SearchGatewayHost,
  SearchBackendRouteContribution
>({
  specifier: "@frockbot/plugin-search/backend",
  create: createSearchBackendContribution.plugin,
});
