import { describe, expect, test } from "bun:test";
import { FakeWorkspace } from "@frockbot/plugin-skills/testing";
import {
  createBotPluginSkillsSource,
  createBotSkillsHost,
} from "./backend-skills.ts";

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

describe("the plugin-borne Skill index seam", () => {
  const READER = {
    readEntry: (generation: string, catalogId: string) =>
      Promise.resolve(
        catalogId === "skillful"
          ? {
              packageId: "skillful",
              skills: [
                {
                  name: "Roster check",
                  description: "Use this when rostering.",
                  body: `body at ${generation}`,
                },
              ],
            }
          : undefined,
      ),
  };

  test("mounts nothing when no Catalog is bound", () => {
    expect(createBotPluginSkillsSource([], undefined)).toBeUndefined();
  });

  test("reads only installed entries, at the generation each install pinned", async () => {
    const source = createBotPluginSkillsSource(
      [
        {
          packageId: "skillful",
          state: "installed",
          catalogId: "skillful",
          catalogGeneration: "gen-3",
        },
        // A first-party install carries no Catalog identity, so there is no
        // entry to index; a disabled Package's recipes are not read either.
        { packageId: "clock", state: "installed" },
        {
          packageId: "off",
          state: "disabled",
          catalogId: "off",
          catalogGeneration: "gen-3",
        },
      ],
      READER,
    );

    expect(await source?.read()).toEqual({
      status: "ok",
      packages: [
        {
          packageId: "skillful",
          catalogId: "skillful",
          generation: "gen-3",
          skills: [
            {
              name: "Roster check",
              description: "Use this when rostering.",
              body: "body at gen-3",
            },
          ],
        },
      ],
    });
  });

  test("an uninstalled entry leaves nothing to index", async () => {
    const source = createBotPluginSkillsSource([], READER);
    expect(await source?.read()).toEqual({ status: "ok", packages: [] });
  });

  test("a Catalog read that throws is an unavailable index, not a failed Turn", async () => {
    const source = createBotPluginSkillsSource(
      [
        {
          packageId: "skillful",
          state: "installed",
          catalogId: "skillful",
          catalogGeneration: "gen-3",
        },
      ],
      {
        readEntry: () => Promise.reject(new Error("R2 is down")),
      },
    );

    const outcome = await source?.read();
    expect(outcome?.status).toBe("unavailable");
    expect(outcome?.status === "unavailable" ? outcome.reason : "").toContain(
      "R2 is down",
    );
  });
});
