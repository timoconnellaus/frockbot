// The Subagents gateway Contribution: the authenticated HTTP surface.
//
// Three routes:
//
//   GET  /api/bots/:botId/tasks                 the Bot's task list
//   GET  /api/bots/:botId/tasks/:taskId         one task
//   POST /api/bots/:botId/tasks/:taskId/stop    explicit, authenticated cancel
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
import { isTaskIdV1, SubagentDecodeError } from "./records.js";
import {
  decodeTaskListViewV1,
  decodeTaskViewV1,
  type TaskListViewV1,
  type TaskViewV1,
} from "./shared.js";
import { defineGatewayContribution } from "@frockbot/kernel-contracts/contributions";

export interface SubagentsGatewayHost {
  listTasks(userId: string, botId: string): Promise<TaskListViewV1>;
  readTask(userId: string, botId: string, taskId: string): Promise<TaskViewV1>;
  /**
   * The User's own cancellation. It is the same durable act the Bot's
   * `task_stop` performs, through a second authenticated door — never a second
   * mechanism, so a task cannot be terminal on one path and live on the other.
   */
  stopTask(userId: string, botId: string, taskId: string): Promise<TaskViewV1>;
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
const TASK = /^\/api\/bots\/([^/]+)\/tasks\/([^/]+)$/;
const TASK_STOP = /^\/api\/bots\/([^/]+)\/tasks\/([^/]+)\/stop$/;

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

/**
 * A task id from a path segment. Restated here for the same reason the Bot id
 * is: a task id becomes part of a Durable Object name (ADR 0017), so the door
 * it arrives at is the door that checks it.
 */
function taskSegment(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new SubagentDecodeError("request path is invalid");
  }
  if (!isTaskIdV1(decoded)) {
    throw new SubagentDecodeError("invalid task id");
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
      const task = TASK.exec(url.pathname);
      const stop = TASK_STOP.exec(url.pathname);
      if (!tasks && !task && !stop) return undefined;
      if (!context.userId) return undefined;
      if ([...url.searchParams.keys()].length > 0) {
        return jsonError(400, "task routes take no query parameters");
      }
      const userId = context.userId;
      try {
        if (stop) {
          if (request.method !== "POST") {
            return jsonError(405, "method not allowed");
          }
          return Response.json(
            decodeTaskViewV1(
              await host.stopTask(
                userId,
                pathSegment(stop[1]!),
                taskSegment(stop[2]!),
              ),
            ),
          );
        }
        if (request.method !== "GET") {
          return jsonError(405, "method not allowed");
        }
        if (task) {
          return Response.json(
            decodeTaskViewV1(
              await host.readTask(
                userId,
                pathSegment(task[1]!),
                taskSegment(task[2]!),
              ),
            ),
          );
        }
        return Response.json(
          decodeTaskListViewV1(
            await host.listTasks(userId, pathSegment(tasks![1]!)),
          ),
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

/**
 * The manifest's gateway `backend` entry, resolved by specifier. The
 * application looks this descriptor up in its Contribution table; it never
 * branches on which Package it belongs to.
 */
export const backendContribution = defineGatewayContribution<
  SubagentsGatewayHost,
  SubagentsBackendRouteContribution
>({
  specifier: "@frockbot/plugin-subagents/backend",
  create: createSubagentsBackendContribution.plugin,
});
