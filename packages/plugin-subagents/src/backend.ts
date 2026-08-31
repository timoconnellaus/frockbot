// The Subagents gateway Contribution: the authenticated HTTP surface.
//
// One route in G1:
//
//   GET /api/bots/:botId/tasks   the Bot's task list
//
// The gateway owns none of this state. It carries the request to the *parent*
// Bot Durable Object — the authority, per ADR 0017 — which proves directory
// membership before it answers, so a Bot that is not this User's is a 404 here
// for the same reason it is one on `/api/bots/:id/settings`, and never because
// this module checked.
//
// A child Session is never reachable from here. The Subagent Durable Object is
// an execution host with no route of its own, and a task's summary reaches the
// User through this list and through the parent's transcript — never as a
// second conversation.
import type { Plugin } from "cordis";
import { SubagentDecodeError } from "./records.js";
import { decodeTaskListViewV1, type TaskListViewV1 } from "./shared.js";

export interface SubagentsGatewayHost {
  listTasks(userId: string, botId: string): Promise<TaskListViewV1>;
}

export interface SubagentsBackendRouteContribution {
  packageId: string;
  route(
    request: Request,
    url: URL,
    context: { userId?: string; client: "browser" | "desktop" },
  ): Promise<Response | undefined>;
}

const TASKS = /^\/api\/bots\/([^/]+)\/tasks$/;

/**
 * A Bot id may not carry `#`, and this is one of the two doors that is why.
 *
 * The Subagent Durable Object is `<userId>:<botId>#task:<taskId>` in the same
 * namespace as the Bot's own object (ADR 0017), so a `#` smuggled through a
 * path segment would let a caller name an object the directory never minted.
 * `PUBLIC_IDENTIFIER_PATTERN` excludes `#`; this route restates the check at
 * its own door rather than trusting the next one.
 */
const BOT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function jsonError(status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

function pathSegment(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new SubagentDecodeError("request path is invalid");
  }
  if (!BOT_ID.test(decoded)) {
    throw new SubagentDecodeError("invalid bot id");
  }
  return decoded;
}

/** A Bot the caller does not own, and one that does not exist, are one answer. */
function isMissingBot(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error.name === "BotNotFoundError" || error.name === "TaskNotFoundError")
  );
}

function errorResponse(error: unknown): Response {
  if (isMissingBot(error)) {
    return jsonError(404, error instanceof Error ? error.message : "not found");
  }
  if (
    error instanceof SubagentDecodeError ||
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "SubagentDecodeError")
  ) {
    return jsonError(
      400,
      error instanceof Error ? error.message : "task request is invalid",
    );
  }
  return jsonError(
    500,
    error instanceof Error ? error.message : "task request failed",
  );
}

export function createSubagentsBackendContribution(
  host: SubagentsGatewayHost,
): SubagentsBackendRouteContribution {
  return {
    packageId: "subagents",
    async route(request, url, context) {
      const tasks = TASKS.exec(url.pathname);
      if (!tasks) return undefined;
      if (!context.userId) return undefined;
      if ([...url.searchParams.keys()].length > 0) {
        return jsonError(400, "task routes take no query parameters");
      }
      if (request.method !== "GET") {
        return jsonError(405, "method not allowed");
      }
      try {
        const botId = pathSegment(tasks[1]!);
        return Response.json(
          decodeTaskListViewV1(await host.listTasks(context.userId, botId)),
        );
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

export namespace createSubagentsBackendContribution {
  export function plugin(
    host: SubagentsGatewayHost,
    lifecycle: { mount(value: SubagentsBackendRouteContribution): () => void },
  ): Plugin {
    return () => lifecycle.mount(createSubagentsBackendContribution(host));
  }
}
