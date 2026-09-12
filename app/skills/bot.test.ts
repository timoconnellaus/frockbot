import { describe, expect, test } from "bun:test";
import { FakeWorkspace } from "@frockbot/app/skills/testing";
import type { ShellBotStateV1 } from "@frockbot/app/shell/backend-state";
import { createBotSkillsHost, listSkills } from "./bot.ts";

const IDENTITY = { userId: "user-1", botId: "bot-1" };
const TURN = { runId: "run-9", turnId: "turn-4", sessionId: "user-1:bot-1" };

/**
 * A Bot host whose User Durable Object answers the account's features read as
 * the harness says, with or without a Workspace file surface bound.
 */
function botState(options: {
  applets: boolean | "unreachable";
  pluginAuthoring?: boolean;
  workspace?: FakeWorkspace;
}): ShellBotStateV1 {
  const rpc = {
    readFeatures: () => {
      if (options.applets === "unreachable") {
        throw new Error("the User object is unavailable");
      }
      return Promise.resolve({
        schemaVersion: 1,
        applets: options.applets,
        pluginAuthoring: options.pluginAuthoring ?? true,
        updatedAt: "2026-09-11T00:00:00.000Z",
        updatedBy: "owner",
      });
    },
  };
  return {
    env: {
      USER_CONFIGURATIONS: {
        idFromName: (name: string) => name,
        get: () => rpc,
      },
      ...(options.workspace ? { WORKSPACE_FILES: options.workspace } : {}),
    },
    authority: { validateIdentity: () => Promise.resolve() },
  } as unknown as ShellBotStateV1;
}

describe("the Bot Skills seam", () => {
  test("mounts nothing when the Workspace file surface is unbound", async () => {
    const state = botState({ applets: true });
    expect(await createBotSkillsHost(state, IDENTITY, TURN)).toBeUndefined();
  });

  test("binds the Bot's own root and its Turn provenance when it is bound", async () => {
    const workspace = new FakeWorkspace();
    const state = botState({ applets: true, workspace });
    const host = await createBotSkillsHost(state, IDENTITY, TURN);
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

  test("withholds the managed Applets Skill exactly when the switch is off", async () => {
    const workspace = new FakeWorkspace();
    const on = await createBotSkillsHost(
      botState({ applets: true, workspace }),
      IDENTITY,
      TURN,
    );
    expect(on?.withheldManagedSlugs).toEqual([]);

    const off = await createBotSkillsHost(
      botState({ applets: false, workspace }),
      IDENTITY,
      TURN,
    );
    expect(off?.withheldManagedSlugs).toEqual(["applets"]);

    // Unreadable is off, as it is for the tools the Skill teaches.
    const unreachable = await createBotSkillsHost(
      botState({ applets: "unreachable", workspace }),
      IDENTITY,
      TURN,
    );
    expect(unreachable?.withheldManagedSlugs).toEqual(["applets", "plugins"]);
  });

  test("withholds the managed Plugins Skill exactly when authoring is off", async () => {
    const workspace = new FakeWorkspace();
    const off = await createBotSkillsHost(
      botState({ applets: true, pluginAuthoring: false, workspace }),
      IDENTITY,
      TURN,
    );
    expect(off?.withheldManagedSlugs).toEqual(["plugins"]);
    const on = await createBotSkillsHost(
      botState({ applets: true, pluginAuthoring: true, workspace }),
      IDENTITY,
      TURN,
    );
    expect(on?.withheldManagedSlugs).toEqual([]);
  });
});

describe("the composer's Skill list", () => {
  const refs = (catalog: { skills: Array<{ ref: string }> }) =>
    catalog.skills.map((entry) => entry.ref);

  test("offers the managed Applets Skill when the switch is on", async () => {
    const state = botState({ applets: true, workspace: new FakeWorkspace() });
    const listed = refs(await listSkills(state, IDENTITY));
    expect(listed).toContain("managed/applets");
    expect(listed).toContain("managed/add-connector");
  });

  test("leaves the managed Applets Skill out when the switch is off", async () => {
    const state = botState({ applets: false, workspace: new FakeWorkspace() });
    const listed = refs(await listSkills(state, IDENTITY));
    expect(listed).not.toContain("managed/applets");
    // Only that Skill follows the switch; the rest of the managed set stays.
    expect(listed).toContain("managed/add-connector");
    expect(listed).toContain("managed/export-bot-template");
  });

  test("a switch that cannot be read lists no Applets Skill", async () => {
    const state = botState({
      applets: "unreachable",
      workspace: new FakeWorkspace(),
    });
    expect(refs(await listSkills(state, IDENTITY))).not.toContain(
      "managed/applets",
    );
  });
});
