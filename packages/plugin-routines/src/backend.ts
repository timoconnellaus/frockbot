// The Routines gateway Contribution: the authenticated HTTP surface.
//
// Three routes, all Bot-scoped and all beside `/api/bots/:id/settings`:
//
//   GET  /api/bots/:botId/routines                  list
//   POST /api/bots/:botId/routines                  one command
//   GET  /api/bots/:botId/routines/:routineId/runs  the bounded run log
//
// The gateway owns none of this state. It carries the request to the Bot
// Durable Object, which proves directory membership before it answers — so a
// Bot that is not this User's is a 404 here for the same reason it is one on
// `/api/bots/:id/settings`, and never because this module checked.
import type { Plugin } from "cordis";
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

export interface RoutinesGatewayHost {
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
  route(
    request: Request,
    url: URL,
    context: { userId?: string; client: "browser" | "desktop" },
  ): Promise<Response | undefined>;
}

const ROUTINES = /^\/api\/bots\/([^/]+)\/routines$/;
const ROUTINE_RUNS = /^\/api\/bots\/([^/]+)\/routines\/([^/]+)\/runs$/;

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

export function createRoutinesBackendContribution(
  host: RoutinesGatewayHost,
): RoutinesBackendRouteContribution {
  return {
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
}

export namespace createRoutinesBackendContribution {
  export function plugin(
    host: RoutinesGatewayHost,
    lifecycle: { mount(value: RoutinesBackendRouteContribution): () => void },
  ): Plugin {
    return () => lifecycle.mount(createRoutinesBackendContribution(host));
  }
}
