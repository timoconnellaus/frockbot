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
  applets: boolean | "unreachable";
  pluginAuthoring?: boolean;
  /** The artifact bucket a Plugin's module is stored in; bound by default. */
  artifacts?: boolean;
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
    readSkillIndex: () =>
      Promise.resolve({
        schemaVersion: 1,
        revision: "",
        status: "ready",
        deleted: false,
        entries: [],
        pending: [],
        detachedReferences: [],
      }),
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
    ctx: {
      storage: {
        get: () => Promise.resolve(undefined),
        put: () => Promise.resolve(),
        delete: () => Promise.resolve(true),
        list: () => Promise.resolve(new Map()),
      },
    },
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
    const { state, features } = mount({ applets: true });
    expect(
      await createBotSkillsHost(state, IDENTITY, TURN, features),
    ).toBeUndefined();
  });

  test("binds the Bot's own root and its Turn provenance when it is bound", async () => {
    const workspace = new FakeWorkspace();
    const { state, features } = mount({ applets: true, workspace });
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

  test("withholds the managed Applets Skill exactly when the switch is off", async () => {
    const workspace = new FakeWorkspace();
    const enabled = mount({ applets: true, workspace });
    const on = await createBotSkillsHost(
      enabled.state,
      IDENTITY,
      TURN,
      enabled.features,
    );
    expect(on?.withheldManagedSlugs).toEqual([]);

    const disabled = mount({ applets: false, workspace });
    const off = await createBotSkillsHost(
      disabled.state,
      IDENTITY,
      TURN,
      disabled.features,
    );
    expect(off?.withheldManagedSlugs).toEqual(["applets"]);

    // Unreadable is off, as it is for the tools the Skill teaches.
    const broken = mount({ applets: "unreachable", workspace });
    const unreachable = await createBotSkillsHost(
      broken.state,
      IDENTITY,
      TURN,
      broken.features,
    );
    expect(unreachable?.withheldManagedSlugs).toEqual(["applets", "plugins"]);
  });

  test("withholds the managed Plugins Skill exactly when authoring is off", async () => {
    const workspace = new FakeWorkspace();
    const authoringOff = mount({
      applets: true,
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
      applets: true,
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
      applets: true,
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
