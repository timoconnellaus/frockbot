import { describe, expect, test } from "bun:test";
import { FakeWorkspace } from "@frockbot/app/skills/testing";
import type { ShellBotStateV1 } from "@frockbot/app/shell/backend-state";
import { userAccountFeaturesReaderV1 } from "@frockbot/app/settings/bot";
import { createBotSkillsHost, listSkills } from "./bot.ts";

const IDENTITY = { userId: "user-1", botId: "bot-1" };
const TURN = { runId: "run-9", turnId: "turn-4", sessionId: "user-1:bot-1" };

/**
 * A Bot host whose User Durable Object answers the account's features read as
 * the harness says, with or without a Workspace file surface bound.
 */
function botState(options: {
  featuresReachable?: boolean;
  pluginAuthoring?: boolean;
  /** The artifact bucket a Plugin's module is stored in; bound by default. */
  artifacts?: boolean;
  workspace?: FakeWorkspace;
}): ShellBotStateV1 {
  const rpc = {
    readFeatures: () => {
      if (options.featuresReachable === false) {
        throw new Error("the User object is unavailable");
      }
      return Promise.resolve({
        schemaVersion: 1,
        pluginAuthoring: options.pluginAuthoring ?? true,
        plugins: [],
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
      ...(options.artifacts === false ? {} : { APPLICATION_ARTIFACTS: {} }),
      ...(options.workspace ? { WORKSPACE_FILES: options.workspace } : {}),
    },
    authority: { validateIdentity: () => Promise.resolve() },
  } as unknown as ShellBotStateV1;
}

/** The state plus the one account-features reader a runtime mount makes. */
function mount(options: Parameters<typeof botState>[0]): {
  state: ShellBotStateV1;
  features: ReturnType<typeof userAccountFeaturesReaderV1>;
} {
  const state = botState(options);
  return { state, features: userAccountFeaturesReaderV1(state, IDENTITY) };
}

describe("the Bot Skills seam", () => {
  test("mounts nothing when the Workspace file surface is unbound", async () => {
    const { state, features } = mount({});
    expect(
      await createBotSkillsHost(state, IDENTITY, TURN, features),
    ).toBeUndefined();
  });

  test("binds the Bot's own root and its Turn provenance when it is bound", async () => {
    const workspace = new FakeWorkspace();
    const { state, features } = mount({ workspace });
    const host = await createBotSkillsHost(state, IDENTITY, TURN, features);
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

  test("withholds the managed Plugins Skill when authoring cannot be read", async () => {
    const workspace = new FakeWorkspace();
    const broken = mount({ featuresReachable: false, workspace });
    const unreachable = await createBotSkillsHost(
      broken.state,
      IDENTITY,
      TURN,
      broken.features,
    );
    expect(unreachable?.withheldManagedSlugs).toEqual(["plugins"]);
  });

  test("withholds the managed Plugins Skill exactly when authoring is off", async () => {
    const workspace = new FakeWorkspace();
    const authoringOff = mount({
      pluginAuthoring: false,
      workspace,
    });
    const off = await createBotSkillsHost(
      authoringOff.state,
      IDENTITY,
      TURN,
      authoringOff.features,
    );
    expect(off?.withheldManagedSlugs).toEqual(["plugins"]);
    const authoringOn = mount({
      pluginAuthoring: true,
      workspace,
    });
    const on = await createBotSkillsHost(
      authoringOn.state,
      IDENTITY,
      TURN,
      authoringOn.features,
    );
    expect(on?.withheldManagedSlugs).toEqual([]);
    // The Skill goes exactly where the tools go, and the tools need the
    // bucket a published module is stored in.
    const noBucket = mount({
      pluginAuthoring: true,
      artifacts: false,
      workspace,
    });
    const unbound = await createBotSkillsHost(
      noBucket.state,
      IDENTITY,
      TURN,
      noBucket.features,
    );
    expect(unbound?.withheldManagedSlugs).toEqual(["plugins"]);
  });
});

describe("the composer's Skill list", () => {
  const refs = (catalog: { skills: Array<{ ref: string }> }) =>
    catalog.skills.map((entry) => entry.ref);

  test("offers the managed connector Skill", async () => {
    const state = botState({ workspace: new FakeWorkspace() });
    const listed = refs(await listSkills(state, IDENTITY));
    expect(listed).toContain("managed/add-connector");
  });

  test("a features read that cannot be reached still lists the connector Skill", async () => {
    const state = botState({
      featuresReachable: false,
      workspace: new FakeWorkspace(),
    });
    expect(refs(await listSkills(state, IDENTITY))).toContain(
      "managed/add-connector",
    );
  });
});
