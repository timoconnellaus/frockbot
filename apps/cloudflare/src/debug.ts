import type { BotDebugQueryV1 } from "@frockbot/plugin-shell/debug-protocol";
import { decodeBotIdV1 } from "@frockbot/configuration-core";

/**
 * The operator surface: `/api/debug/*`, authorized by a shared token rather
 * than by a session, so it can be read from a terminal while a Bot is wedged
 * and nobody is signed in.
 *
 * It is read-only. Nothing here admits a Turn, reconciles a run, or writes
 * durable state — an operator looking at a stuck Bot must not be the thing
 * that moves it.
 */
export interface DebugGatewaySurface {
  /** Absent (or empty) disables the whole surface; the routes then 404. */
  token?: string;
  listUsers(): Promise<
    Array<{ id: string; email: string; name: string; createdAt: string }>
  >;
  listBots(userId: string): Promise<unknown>;
  snapshot(
    userId: string,
    botId: string,
    query: BotDebugQueryV1,
  ): Promise<unknown>;
}

const DEBUG_PREFIX = "/api/debug";

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

/**
 * Length-independent, constant-time within a length: a token comparison that
 * returns early leaks the token one character at a time.
 */
function tokenMatches(presented: string, expected: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(presented);
  const right = encoder.encode(expected);
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function presentedToken(request: Request): string | undefined {
  const header = request.headers.get("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) {
    return header.slice("bearer ".length).trim();
  }
  return request.headers.get("x-frockbot-debug-token")?.trim() ?? undefined;
}

function debugQuery(url: URL): BotDebugQueryV1 {
  const query: BotDebugQueryV1 = { schemaVersion: 1 };
  const limit = url.searchParams.get("limit");
  if (limit !== null) {
    const parsed = Number(limit);
    if (!Number.isSafeInteger(parsed)) throw new Error("limit is invalid");
    query.limit = parsed;
  }
  const before = url.searchParams.get("before");
  if (before !== null) query.before = before;
  const events = url.searchParams.get("events");
  if (events !== null) query.events = events === "true" || events === "1";
  return query;
}

/**
 * Mounted ahead of authentication in the gateway, so it answers with no
 * session. Returns `undefined` for any path it does not own.
 */
export function createDebugRoute(
  surface: DebugGatewaySurface | undefined,
): (request: Request, url: URL) => Promise<Response | undefined> {
  return async (request, url) => {
    if (
      url.pathname !== DEBUG_PREFIX &&
      !url.pathname.startsWith(`${DEBUG_PREFIX}/`)
    ) {
      return undefined;
    }
    // An unconfigured deployment does not admit that the surface exists.
    if (!surface?.token) return jsonError(404, "not found");
    const presented = presentedToken(request);
    if (!presented || !tokenMatches(presented, surface.token)) {
      return jsonError(401, "debug token required");
    }
    if (request.method !== "GET") return jsonError(405, "method not allowed");

    const path = url.pathname.slice(DEBUG_PREFIX.length);
    try {
      if (path === "" || path === "/") {
        return Response.json({
          schemaVersion: 1,
          routes: [
            "GET /api/debug/users",
            "GET /api/debug/bots?userId=<id>",
            "GET /api/debug/bots/<botId>?userId=<id>&limit=<n>&events=true&before=<cursor>",
            "GET /api/debug/bots/<botId>/runs/<runId>?userId=<id>",
          ],
        });
      }
      if (path === "/users") {
        return Response.json({
          schemaVersion: 1,
          users: await surface.listUsers(),
        });
      }

      const userId = url.searchParams.get("userId")?.trim();
      if (path === "/bots") {
        if (!userId) return jsonError(400, "userId is required");
        return Response.json(await surface.listBots(userId));
      }

      const runMatch = path.match(/^\/bots\/([^/]+)\/runs\/([^/]+)$/);
      const botMatch = path.match(/^\/bots\/([^/]+)$/);
      if (!runMatch && !botMatch) return jsonError(404, "not found");
      if (!userId) return jsonError(400, "userId is required");
      const botId = decodeBotIdV1(
        decodeURIComponent((runMatch ?? botMatch)![1]!),
      );
      const query = runMatch
        ? {
            schemaVersion: 1 as const,
            runId: decodeURIComponent(runMatch[2]!),
          }
        : debugQuery(url);
      return Response.json(await surface.snapshot(userId, botId, query));
    } catch (error) {
      // The operator is the audience: the message is the finding, and a stack
      // that reached here is more useful than a generic 500.
      return Response.json(
        {
          error: error instanceof Error ? error.message : "debug read failed",
          ...(error instanceof Error && error.stack
            ? { stack: error.stack }
            : {}),
        },
        { status: 500 },
      );
    }
  };
}
