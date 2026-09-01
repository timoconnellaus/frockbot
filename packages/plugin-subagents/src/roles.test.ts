import { describe, expect, test } from "bun:test";
import { TASK_TYPES_V1 } from "./records.js";
import {
  SUBAGENT_ROLES_V1,
  SUBAGENT_ROLE_SUMMARIES_V1,
  SUBAGENT_TOOL_REACH_V1,
  subagentRoleAdmitsV1,
  type SubagentRoleV1,
  type SubagentToolReachV1,
} from "./roles.js";

describe("the subagent role catalogs", () => {
  test("names exactly the five roles a Task may ask for", () => {
    expect(SUBAGENT_ROLES_V1).toEqual(TASK_TYPES_V1);
    expect(Object.keys(SUBAGENT_ROLE_SUMMARIES_V1).sort()).toEqual(
      [...TASK_TYPES_V1].sort(),
    );
  });

  /**
   * The table, exactly as `docs/research/grokbot-computer.md` l.351–356 states
   * it: `executor` gets every work tool, `browserUse` gets the browser page
   * tools and nothing else, `computerUse` gets the shell, the desktop and the
   * browser, and the two video roles get what they were given to read and no
   * Computer at all.
   */
  const table: Record<SubagentRoleV1, readonly SubagentToolReachV1[]> = {
    executor: ["read", "handoff", "work", "browser", "desktop"],
    browserUse: ["read", "handoff", "browser"],
    computerUse: ["read", "handoff", "browser", "desktop"],
    watchVideo: ["read", "handoff"],
    videoReview: ["read", "handoff"],
  };

  for (const role of SUBAGENT_ROLES_V1) {
    test(`${role} reaches exactly its catalog`, () => {
      const reaches = Object.keys(
        SUBAGENT_TOOL_REACH_V1,
      ) as SubagentToolReachV1[];
      const admitted = reaches.filter((reach) =>
        subagentRoleAdmitsV1(role, reach),
      );
      expect(admitted.sort()).toEqual([...table[role]].sort());
    });
  }

  test("no role reaches the Computer except executor and computerUse", () => {
    for (const role of SUBAGENT_ROLES_V1) {
      const desktop = subagentRoleAdmitsV1(role, "desktop");
      expect(desktop).toBe(role === "executor" || role === "computerUse");
    }
  });

  test("every role can read its attachments and hand its Turn back", () => {
    for (const role of SUBAGENT_ROLES_V1) {
      expect(subagentRoleAdmitsV1(role, "read")).toBe(true);
      expect(subagentRoleAdmitsV1(role, "handoff")).toBe(true);
    }
  });
});
