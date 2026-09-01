// The five subagent roles, and the tool reach each one has.
//
// A role is the *second* ceiling dimension on the tool catalog. The first is
// the turn type: a `subagent` Turn is never offered `Task`, `user_voice`, or
// anything else a Package declared chat-only. The second is the role: within
// the work tools a subagent Turn does reach, `browserUse` reaches the browser
// and not the shell, and `watchVideo` reaches neither.
//
// The kernel holds none of this. `ToolRegistry` treats a role exactly as it
// treats a turn type — an opaque string a registration may narrow itself by —
// and every table below is *declaration*: a Package says which roles its tool
// serves, in its own tool definition or its own manifest Capability, and the
// registry intersects the two. This module is where the first-party Packages'
// answers are written down together so they can be read as one catalog and
// tested as one table.
//
// Reference: `docs/research/grokbot-computer.md` l.351–356.

import { TASK_TYPES_V1, type TaskTypeV1 } from "./records.js";

/** A subagent role. The same five names a `Task` may name as its `type`. */
export type SubagentRoleV1 = TaskTypeV1;

/** Every role, in catalog order. */
export const SUBAGENT_ROLES_V1: readonly SubagentRoleV1[] = TASK_TYPES_V1;

/**
 * What each role is for, in one line, as the `Task` tool describes it and as
 * the task list shows it.
 */
export const SUBAGENT_ROLE_SUMMARIES_V1: Record<SubagentRoleV1, string> = {
  executor: "does general work with the Bot's full work toolset",
  browserUse: "drives web pages through the browser, and nothing else",
  computerUse: "drives the shared desktop: shell, screen, and browser",
  watchVideo: "watches the attachments it was given and reports on them",
  videoReview: "reviews the attachments it was given and reports on them",
};

/**
 * The reach one tool declares, as the set of roles it is offered to.
 *
 * A Package writes the literal array in its own tool definition — these
 * constants are the record of what the first-party answers *are*, not a
 * runtime dependency: `plugin-computer` cannot import this Package, and should
 * not have to, for the kernel to enforce the ceiling.
 */
export const SUBAGENT_TOOL_REACH_V1 = {
  /**
   * Reading, and the attachments a task was handed. Every role, including the
   * two video roles, whose whole job is to read what they were given.
   */
  read: SUBAGENT_ROLES_V1,
  /** Handing the Turn back to the parent. Every role can finish. */
  handoff: SUBAGENT_ROLES_V1,
  /** General work tools: memory, skills, routines, MCP, the web, authoring. */
  work: ["executor"],
  /** Page-level browser control. */
  browser: ["executor", "browserUse", "computerUse"],
  /** The shell and the desktop screen: `computer_exec`, screenshots, processes. */
  desktop: ["executor", "computerUse"],
} as const satisfies Record<string, readonly SubagentRoleV1[]>;

/** The reach names, for a table-driven test to walk. */
export type SubagentToolReachV1 = keyof typeof SUBAGENT_TOOL_REACH_V1;

/**
 * Whether a tool of this reach is offered to this role — the same predicate
 * `ToolRegistry` applies, restated over the reach names so the catalog can be
 * asserted as a table rather than as a mounted runtime.
 */
export function subagentRoleAdmitsV1(
  role: SubagentRoleV1,
  reach: SubagentToolReachV1,
): boolean {
  return (SUBAGENT_TOOL_REACH_V1[reach] as readonly string[]).includes(role);
}
