// The Routines gateway Contribution: the authenticated HTTP surface.
//
// Three routes, all Bot-scoped and all beside `/api/bots/:id/settings`:
//
//   GET  /api/bots/:botId/routines                  list
//   POST /api/bots/:botId/routines                  one command
//   GET  /api/bots/:botId/routines/:routineId/runs  the bounded run log
//
// …and one that is not authenticated at all:
//
//   POST /api/bots/:botId/routines/:routineId/hook  one webhook delivery
//
// That last one is a `publicRoute`: an external caller has no session, so it
// runs before the gateway authenticates anything. Its only credential is the
// signed key it presents, which is verified in constant time *before* a Durable
// Object is addressed — the gateway is stateless and could not otherwise map a
// Bot to its User without creating an object on an anonymous caller's word.
//
// The gateway owns none of this state. It carries the request to the Bot
// Durable Object, which proves directory membership before it answers — so a
// Bot that is not this User's is a 404 here for the same reason it is one on
// `/api/bots/:id/settings`, and never because this module checked.
import type { Plugin } from "cordis";
import {
  RoutineHookError,
  ROUTINE_HOOK_BODY_MAX_BYTES,
  routineDeliveryIdV1,
  verifyRoutineHookTokenV1,
} from "./hook.js";
import {
  decodeRoutineCommandV1,
  decodeRoutineCommandReceiptV1,
  decodeRoutineListViewV1,
  decodeRoutineRunListViewV1,
  RoutineDecodeError,
  type RoutineCommandReceiptV1,
  type RoutineCommandV1,
  type RoutineListViewV1,
  type RoutineRunListViewV1,
} from "./shared.js";

/** One delivery, as the Bot Durable Object answers it. */
export interface RoutineHookDeliveryReceiptV1 {
  status: "accepted" | "duplicate";
  fireId: string;
}

export interface RoutinesGatewayHost {
  /**
   * The HMAC secret webhook keys are signed with, or nothing. Absent means the
   * door is closed: a delivery is refused rather than admitted unverified.
   */
  routineHookSecret?: string;
  deliverRoutineHook(
    userId: string,
    botId: string,
    delivery: {
      routineId: string;
      keyVersion: number;
      digest: string;
      deliveryId: string;
      body: string;
      contentType?: string | null;
    },
  ): Promise<RoutineHookDeliveryReceiptV1>;
  listRoutines(userId: string, botId: string): Promise<RoutineListViewV1>;
  executeRoutineCommand(
    userId: string,
    botId: string,
    command: RoutineCommandV1,
  ): Promise<RoutineCommandReceiptV1>;
  listRoutineRuns(
    userId: string,
    botId: string,
    routineId: string,
  ): Promise<RoutineRunListViewV1>;
}

export interface RoutinesBackendRouteContribution {
  packageId: string;
  publicRoute?(
    request: Request,
    url: URL,
    context: { userId?: string; client: "browser" | "desktop" },
  ): Promise<Response | undefined>;
  route(
    request: Request,
    url: URL,
    context: { userId?: string; client: "browser" | "desktop" },
  ): Promise<Response | undefined>;
}

const ROUTINES = /^\/api\/bots\/([^/]+)\/routines$/;
const ROUTINE_RUNS = /^\/api\/bots\/([^/]+)\/routines\/([^/]+)\/runs$/;
const ROUTINE_HOOK = /^\/api\/bots\/([^/]+)\/routines\/([^/]+)\/hook$/;

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

function pathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new RoutineDecodeError("request path is invalid");
  }
}

/**
 * A Bot the caller does not own, or one that does not exist, is the same
 * answer: 404. The authority raises `BotNotFoundError`; nothing here
 * distinguishes the two cases, which is the point.
 */
function isMissingBot(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error.name === "BotNotFoundError" || error.name === "RoutineNotFoundError")
  );
}

function errorResponse(error: unknown): Response {
  if (isMissingBot(error)) {
    return jsonError(404, error instanceof Error ? error.message : "not found");
  }
  if (
    error instanceof RoutineDecodeError ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "RoutineDecodeError")
  ) {
    return jsonError(
      400,
      error instanceof Error ? error.message : "Routine request is invalid",
    );
  }
  return jsonError(
    500,
    error instanceof Error ? error.message : "Routine request failed",
  );
}

/**
 * One webhook delivery, from the open internet.
 *
 * The order of the checks is the whole design. The key is verified against the
 * deployment's secret first, in constant time; only a token that was minted here
 * names a User and a Bot, and only then is a Durable Object addressed. Nothing
 * an anonymous caller sends decides which object exists.
 */
async function deliverHook(
  host: RoutinesGatewayHost,
  request: Request,
  match: RegExpExecArray,
): Promise<Response> {
  if (request.method !== "POST") return jsonError(405, "method not allowed");
  const presented =
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    request.headers.get("x-routine-key") ??
    "";
  const secret = host.routineHookSecret;
  if (!secret) {
    return jsonError(503, "webhook delivery is not configured");
  }
  let body: string;
  try {
    body = await request.text();
  } catch {
    return jsonError(400, "webhook body could not be read");
  }
  if (new TextEncoder().encode(body).length > ROUTINE_HOOK_BODY_MAX_BYTES) {
    return jsonError(413, "webhook body is too large");
  }
  try {
    const claims = await verifyRoutineHookTokenV1(secret, presented);
    // The path and the key must agree. A token for one Routine presented at
    // another's door is as good as forged.
    if (
      claims.b !== pathSegment(match[1]!) ||
      claims.r !== pathSegment(match[2]!)
    ) {
      throw new RoutineHookError(401, "webhook key is invalid");
    }
    const receipt = await host.deliverRoutineHook(claims.u, claims.b, {
      routineId: claims.r,
      keyVersion: claims.v,
      digest: await routineHookDigestOf(presented),
      deliveryId: await routineDeliveryIdV1(
        claims.r,
        body,
        request.headers.get("idempotency-key"),
      ),
      body,
      contentType: request.headers.get("content-type"),
    });
    // 202 either way: the firing is durable and queued, and a replay answers
    // with the firing the first delivery already made.
    return Response.json(
      {
        schemaVersion: 1,
        status: receipt.status,
        routineId: claims.r,
        fireId: receipt.fireId,
      },
      { status: 202 },
    );
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "RoutineHookError"
    ) {
      const hookError = error as RoutineHookError;
      return jsonError(hookError.status, hookError.message);
    }
    if (isMissingBot(error)) return jsonError(404, "Routine not found");
    return jsonError(
      500,
      error instanceof Error ? error.message : "webhook delivery failed",
    );
  }
}

/** Imported lazily so the client bundle never pulls the hook module in. */
async function routineHookDigestOf(token: string): Promise<string> {
  const { routineHookDigestV1 } = await import("./hook.js");
  return routineHookDigestV1(token);
}

export function createRoutinesBackendContribution(
  host: RoutinesGatewayHost,
): RoutinesBackendRouteContribution {
  const contribution: RoutinesBackendRouteContribution = {
    packageId: "routines",
    async route(request, url, context) {
      if (!context.userId) return undefined;
      const list = ROUTINES.exec(url.pathname);
      const runs = ROUTINE_RUNS.exec(url.pathname);
      if (!list && !runs) return undefined;
      if ([...url.searchParams.keys()].length > 0) {
        return jsonError(400, "Routine routes take no query parameters");
      }
      try {
        const botId = pathSegment((list ?? runs)![1]!);
        if (runs) {
          if (request.method !== "GET") {
            return jsonError(405, "method not allowed");
          }
          return Response.json(
            decodeRoutineRunListViewV1(
              await host.listRoutineRuns(
                context.userId,
                botId,
                pathSegment(runs[2]!),
              ),
            ),
          );
        }
        if (request.method === "GET") {
          return Response.json(
            decodeRoutineListViewV1(
              await host.listRoutines(context.userId, botId),
            ),
          );
        }
        if (request.method !== "POST") {
          return jsonError(405, "method not allowed");
        }
        const command = decodeRoutineCommandV1(await request.json());
        if (command.botId !== botId) {
          return jsonError(
            400,
            "Routine command does not match the request path",
          );
        }
        return Response.json(
          decodeRoutineCommandReceiptV1(
            await host.executeRoutineCommand(context.userId, botId, command),
          ),
        );
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
  contribution.publicRoute = async (request, url) => {
    const hook = ROUTINE_HOOK.exec(url.pathname);
    return hook ? deliverHook(host, request, hook) : undefined;
  };
  return contribution;
}

export namespace createRoutinesBackendContribution {
  export function plugin(
    host: RoutinesGatewayHost,
    lifecycle: { mount(value: RoutinesBackendRouteContribution): () => void },
  ): Plugin {
    return () => lifecycle.mount(createRoutinesBackendContribution(host));
  }
}
