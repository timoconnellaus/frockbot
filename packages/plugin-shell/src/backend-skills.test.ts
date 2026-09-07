import { describe, expect, test } from "bun:test";
import { FakeWorkspace } from "@frockbot/plugin-skills/testing";
import { createBotSkillsHost } from "./backend-skills.ts";

const IDENTITY = { userId: "user-1", botId: "bot-1" };
const TURN = { runId: "run-9", turnId: "turn-4", sessionId: "user-1:bot-1" };

describe("the Bot Skills seam", () => {
  test("mounts nothing when the Workspace file surface is unbound", () => {
    expect(createBotSkillsHost(IDENTITY, TURN, {})).toBeUndefined();
  });

  test("binds the Bot's own root and its Turn provenance when it is bound", () => {
    const workspace = new FakeWorkspace();
    const host = createBotSkillsHost(IDENTITY, TURN, {
      WORKSPACE_FILES: workspace,
    });
    expect(host).toBeDefined();
    expect(host?.owner).toEqual(IDENTITY);
    expect(host?.writer).toEqual({
      sessionId: "user-1:bot-1",
      turnId: "turn-4",
      runId: "run-9",
    });
    expect(host?.reads).toBe(workspace);
    expect(host?.files).toBe(workspace);
    // The seam reaches the Workspace and nothing else: no Computer is opened
    // to build it, so a hibernated Computer changes none of this.
    expect(workspace.calls).toEqual([]);
  });
});
