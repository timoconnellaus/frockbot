// The Audit Package's gateway Contribution.
//
// It sits on the same host as Flock's `/api/bots` and the Search Package's
// `/api/search`, for the same reason: the gateway is where an authenticated
// `userId` exists, and audit is User-scoped by construction — there is no
// cross-User table to leak from, and the User Durable Object refuses any RPC
// naming a User it is not.
//
// The route owns no state. It decodes the query string into the exact
// `AuditQueryV1` every other caller uses, asks the User Durable Object, and
// answers. An unexpected or repeated parameter is a refusal rather than
// something quietly ignored: a client that means something the route does not
// implement finds out, instead of being handed a page it will misread as
// filtered.
//
// `?as=activity` answers the same table as the Activity page reads it: a
// Turn's effects in one place to a row, in sentences (`activity.ts`).
//
// `POST /api/audit/rebuild` has no control in the app. Rebuilding is upkeep,
// not something a person should have to do; the route stays because it is
// how the table is re-projected after the projection changes, and how an
// operator clears a truncation marker, acting as the account.
import {
  AUDIT_ACTIVITY_FILTER_NAMES_V1,
  AUDIT_ACTIVITY_MAX_ROWS_V1,
  AUDIT_KINDS_V1,
  AUDIT_MAX_CURSOR_LENGTH_V1,
  AUDIT_MAX_RESULTS_V1,
  AuditDecodeError,
  decodeAuditQueryV1,
  type AuditActivityFilterV1,
  type AuditActivityPageV1,
  type AuditActivityQueryV1,
  type AuditKindV1,
  type AuditQueryV1,
  type AuditRebuildReceiptV1,
  type ClientAuditPageV1,
} from "./shared.js";
import { activityPageV1 } from "./activity.js";
import type { BotDirectoryViewV1 } from "@frockbot/app/flock/shared";
import { defineGatewayContribution } from "@frockbot/core/contracts/contributions";

export interface AuditGatewayHost {
  readAudit(userId: string, query: AuditQueryV1): Promise<ClientAuditPageV1>;
  readActivity(
    userId: string,
    query: AuditActivityQueryV1,
  ): Promise<AuditActivityPageV1>;
  rebuildAuditIndex(userId: string): Promise<AuditRebuildReceiptV1>;
  /**
   * The Bot directory, for Activity's rows. An entry is stored against a Bot
   * id, and an id is not what a person reading their own history is looking
   * at; the same directory names the filter above the list, so both agree by
   * construction.
   */
  listBots(userId: string): Promise<BotDirectoryViewV1>;
}

export interface AuditBackendRouteContribution {
  packageId: string;
  route(
    request: Request,
    url: URL,
    context: { userId?: string; client: "browser" | "desktop" },
  ): Promise<Response | undefined>;
}

const ALLOWED_PARAMS = new Set(["botId", "kind", "target", "before", "limit"]);

/** What `?as=activity` may be asked: the Bot, the filter and the page. */
const ACTIVITY_PARAMS = new Set(["botId", "filter", "before", "limit", "as"]);

function refuseUnknownParams(url: URL, allowed: ReadonlySet<string>): void {
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key)) {
      throw new AuditDecodeError(`audit query.${key} is not allowed`);
    }
    if (url.searchParams.getAll(key).length > 1) {
      throw new AuditDecodeError(`audit query.${key} is repeated`);
    }
  }
}

/** The Activity query string, decoded. */
export function decodeActivityRequestQueryV1(url: URL): AuditActivityQueryV1 {
  refuseUnknownParams(url, ACTIVITY_PARAMS);
  const botId = url.searchParams.get("botId");
  const filter = url.searchParams.get("filter");
  const before = url.searchParams.get("before");
  const limit = url.searchParams.get("limit");
  if (
    filter !== null &&
    !AUDIT_ACTIVITY_FILTER_NAMES_V1.includes(filter as AuditActivityFilterV1)
  ) {
    throw new AuditDecodeError("activity query.filter is invalid");
  }
  if (botId !== null && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(botId)) {
    throw new AuditDecodeError("activity query.botId is invalid");
  }
  if (before !== null && before.length > AUDIT_MAX_CURSOR_LENGTH_V1) {
    throw new AuditDecodeError(
      "activity query.before must be a bounded string",
    );
  }
  if (limit !== null && !/^[1-9][0-9]{0,2}$/.test(limit)) {
    throw new AuditDecodeError(
      "activity query.limit must be a bounded integer",
    );
  }
  return {
    ...(botId === null ? {} : { botId }),
    ...(filter === null ? {} : { filter: filter as AuditActivityFilterV1 }),
    ...(before === null ? {} : { before }),
    ...(limit === null
      ? {}
      : { limit: Math.min(Number(limit), AUDIT_ACTIVITY_MAX_ROWS_V1) }),
  };
}

/** The query string, decoded into the exact DTO. */
export function decodeAuditRequestQueryV1(url: URL): AuditQueryV1 {
  refuseUnknownParams(url, ALLOWED_PARAMS);
  const botId = url.searchParams.get("botId");
  const kind = url.searchParams.get("kind");
  const target = url.searchParams.get("target");
  const before = url.searchParams.get("before");
  const limit = url.searchParams.get("limit");
  if (kind !== null && !AUDIT_KINDS_V1.includes(kind as AuditKindV1)) {
    throw new AuditDecodeError("audit query.kind is invalid");
  }
  if (before !== null && before.length > AUDIT_MAX_CURSOR_LENGTH_V1) {
    throw new AuditDecodeError("audit query.before must be a bounded string");
  }
  if (limit !== null && !/^[0-9]{1,3}$/.test(limit)) {
    throw new AuditDecodeError("audit query.limit must be a bounded integer");
  }
  return decodeAuditQueryV1({
    schemaVersion: 1,
    ...(botId === null ? {} : { botId }),
    ...(kind === null ? {} : { kind }),
    ...(target === null ? {} : { target }),
    ...(before === null ? {} : { before }),
    ...(limit === null
      ? {}
      : { limit: Math.min(Number(limit), AUDIT_MAX_RESULTS_V1) }),
  });
}

function errorResponse(error: unknown): Response {
  if (
    error instanceof AuditDecodeError ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "AuditDecodeError")
  ) {
    return Response.json(
      {
        error:
          error instanceof Error ? error.message : "audit request is invalid",
        code: "invalid-request",
        definitive: true,
      },
      { status: 400 },
    );
  }
  return Response.json(
    { error: error instanceof Error ? error.message : "audit read failed" },
    { status: 500 },
  );
}

export function createAuditBackendContribution(
  host: AuditGatewayHost,
): AuditBackendRouteContribution {
  return {
    packageId: "audit",
    async route(request, url, context) {
      if (!context.userId) return undefined;
      const isRead = url.pathname === "/api/audit";
      const isRebuild = url.pathname === "/api/audit/rebuild";
      if (!isRead && !isRebuild) return undefined;
      const userId = context.userId;
      try {
        if (isRebuild) {
          if (request.method !== "POST") {
            return Response.json(
              { error: "method not allowed" },
              { status: 405 },
            );
          }
          return Response.json(await host.rebuildAuditIndex(userId));
        }
        if (request.method !== "GET") {
          return Response.json(
            { error: "method not allowed" },
            { status: 405 },
          );
        }
        const as = url.searchParams.get("as");
        if (as !== null && as !== "activity") {
          throw new AuditDecodeError("audit query.as is invalid");
        }
        if (as === null) {
          return Response.json(
            await host.readAudit(userId, decodeAuditRequestQueryV1(url)),
          );
        }
        const query = decodeActivityRequestQueryV1(url);
        const [page, directory] = await Promise.all([
          host.readActivity(userId, query),
          host.listBots(userId),
        ]);
        return Response.json(
          activityPageV1(
            page,
            Object.fromEntries(
              directory.bots.map((bot) => [bot.botId, bot.initialName]),
            ),
          ),
        );
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

/**
 * The manifest's gateway `backend` entry, resolved by specifier. The
 * application looks this descriptor up in its Contribution table; it never
 * branches on which Package it belongs to.
 */
export const backendContribution = defineGatewayContribution<
  AuditGatewayHost,
  AuditBackendRouteContribution
>({
  specifier: "@frockbot/app/audit/backend",
  mount: (host, lifecycle) =>
    lifecycle.mount(createAuditBackendContribution(host)),
});
