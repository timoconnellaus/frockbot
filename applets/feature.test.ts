import { describe, expect, test } from "bun:test";
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolRegistration,
} from "@frockbot/core/contracts";
import {
  createAppletsFeature,
  type AppletCapabilityHostV1,
  type AppletCheckResultV1,
  type AppletsRuntimeHostV1,
} from "./feature.js";

const USER = "user-42";
const APPLET = `${USER}.${"a".repeat(32)}`;

const TURN = { sessionId: `${USER}:bot-1`, runId: "run-1", turnId: "turn-1" };

interface Recorded {
  writes: { appletId: string; path: string; text: string; effectId: string }[];
  checks: { appletId: string; effectId: string }[];
}

function harness(capability: Partial<AppletCapabilityHostV1> = {}) {
  const recorded: Recorded = { writes: [], checks: [] };
  const source = new Map<string, string>([
    ["server.ts", "export default class {}"],
    ["ui.tsx", "export default () => null;"],
  ]);
  const applets: AppletCapabilityHostV1 = {
    list: () => Promise.resolve([]),
    create: () =>
      Promise.resolve({
        appletId: APPLET,
        displayName: "Todo",
        status: "draft" as const,
        tools: [],
        createdAt: "2026-09-03T00:00:00.000Z",
      }),
    files: () =>
      Promise.resolve(
        [...source].map(([path, text]) => ({ path, size: text.length })),
      ),
    readFile: (input) => {
      const text = source.get(input.path);
      if (text === undefined) throw new Error(`"${input.path}" is not-found`);
      return Promise.resolve(text);
    },
    writeFile: (input, scope) => {
      recorded.writes.push({ ...input, effectId: scope.effectId });
      source.set(input.path, input.text);
      return Promise.resolve();
    },
    check: (input, scope) => {
      recorded.checks.push({
        appletId: input.appletId,
        effectId: scope.effectId,
      });
      return Promise.resolve<AppletCheckResultV1>({
        status: "checked",
        tools: ["add_todo"],
        previewUrl: `http://ui.localhost:8797/packages/${"a".repeat(64)}.html`,
      });
    },
    publish: () =>
      Promise.resolve({
        status: "published" as const,
        appletId: APPLET,
        generationId: "g1",
        tools: ["add_todo"],
      }),
    revert: () =>
      Promise.resolve({
        status: "published" as const,
        appletId: APPLET,
        generationId: "g2",
        tools: ["add_todo"],
      }),
    delete: () => Promise.resolve({ status: "deleted" as const }),
    focus: () =>
      Promise.resolve({
        schemaVersion: 1 as const,
        appletId: APPLET,
        changedAt: "2026-09-03T00:00:00.000Z",
      }),
    generations: () => Promise.resolve([]),
    readFocused: () =>
      Promise.resolve({
        schemaVersion: 1 as const,
        appletId: null,
        changedAt: "2026-09-03T00:00:00.000Z",
      }),
    ...capability,
  };
  const host: AppletsRuntimeHostV1 = { applets, turn: TURN };
  const definitions: ToolDefinition[] = [];
  const tools: ToolRegistration = {
    register: (definition: ToolDefinition) => {
      definitions.push(definition);
      return () => {};
    },
  } as unknown as ToolRegistration;
  createAppletsFeature(host)({ tools } as never);
  const call = async (name: string, input: unknown = {}) => {
    const definition = definitions.find((entry) => entry.name === name);
    if (!definition) throw new Error(`no ${name} tool`);
    return await definition.execute(input, {} as ToolExecutionContext);
  };
  return { call, recorded, source, names: definitions.map((one) => one.name) };
}

describe("the Applets tools", () => {
  test("the catalog is the eleven applet_ verbs", () => {
    expect(harness().names).toEqual([
      "applet_list",
      "applet_create",
      "applet_files",
      "applet_read_file",
      "applet_write_file",
      "applet_check",
      "applet_publish",
      "applet_revert",
      "applet_delete",
      "applet_focus",
      "applet_generations",
    ]);
  });

  test("applet_delete delegates to the authority and reports failures honestly", async () => {
    const deleted: string[] = [];
    const { call } = harness({
      delete: async ({ appletId }) => {
        deleted.push(appletId);
        return { status: "deleted" };
      },
    });
    expect((await call("applet_delete", { appletId: APPLET })).isError).toBe(
      false,
    );
    expect(deleted).toEqual([APPLET]);
    const failing = harness({
      delete: async () => {
        throw new Error("Deletion failed");
      },
    });
    expect(
      (await failing.call("applet_delete", { appletId: APPLET })).isError,
    ).toBe(true);
  });

  test("applet_files lists the source paths and their sizes", async () => {
    const { call } = harness();
    const result = await call("applet_files", { appletId: APPLET });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("server.ts — 23 bytes");
    expect(result.content).toContain("ui.tsx — 26 bytes");
  });

  test("applet_read_file answers with the file itself", async () => {
    const { call } = harness();
    expect(
      (await call("applet_read_file", { appletId: APPLET, path: "ui.tsx" }))
        .content,
    ).toBe("export default () => null;");
    const missing = await call("applet_read_file", {
      appletId: APPLET,
      path: "nope.ts",
    });
    expect(missing.isError).toBe(true);
    expect(missing.content).toContain("not-found");
  });

  test("applet_write_file replaces the file and names the next step", async () => {
    const { call, recorded, source } = harness();
    const result = await call("applet_write_file", {
      appletId: APPLET,
      path: "server.ts",
      text: "export default class B {}",
    });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("applet_check");
    expect(source.get("server.ts")).toBe("export default class B {}");
    expect(recorded.writes[0]?.effectId).toBe(
      `applet:turn-1:write:server.ts:${APPLET}`,
    );
  });

  test("applet_write_file refuses a path that leaves the Applet", async () => {
    const { call, recorded } = harness();
    for (const path of ["../escape.ts", "/etc/passwd", "a//b.ts"]) {
      const result = await call("applet_write_file", {
        appletId: APPLET,
        path,
        text: "x",
      });
      expect(result.isError).toBe(true);
      expect(result.content).toContain("path is invalid");
    }
    expect(recorded.writes).toHaveLength(0);
  });

  test("applet_check answers with the tools and the preview URL", async () => {
    const { call, recorded } = harness();
    const result = await call("applet_check", { appletId: APPLET });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("builds");
    expect(result.content).toContain("add_todo");
    expect(result.content).toContain(
      `http://ui.localhost:8797/packages/${"a".repeat(64)}.html`,
    );
    expect(recorded.checks[0]?.effectId).toBe(`applet:turn-1:check:${APPLET}`);
  });

  test("a failing check hands back every diagnostic and no next-step guess", async () => {
    const { call } = harness({
      check: () =>
        Promise.resolve<AppletCheckResultV1>({
          status: "failed",
          reason: "the build failed at the typecheck stage",
          diagnostics: [
            "server.ts:12:5 Property 'titel' does not exist.",
            "ui.tsx:3:9 no raw colours",
          ],
        }),
    });
    const result = await call("applet_check", { appletId: APPLET });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("typecheck stage");
    expect(result.content).toContain("server.ts:12:5");
    expect(result.content).toContain("ui.tsx:3:9");
  });

  test("applet_create writes the scaffold and names the loop, not the Computer", async () => {
    const { call, recorded } = harness();
    const result = await call("applet_create", { displayName: "Todo" });
    expect(result.isError).toBe(false);
    expect(recorded.writes.map((write) => write.path)).toEqual([
      "README.md",
      "applet.json",
      "ui.tsx",
      "server.ts",
    ]);
    expect(result.content).toContain("applet_write_file");
    expect(result.content).toContain("applet_check");
    expect(result.content).toContain("applet_publish");
    expect(result.content).not.toContain("/home/box");
    expect(result.content).not.toContain("applet build");
  });

  test("a publish failure is the reason and the diagnostics, and nothing changed", async () => {
    const { call } = harness({
      publish: () =>
        Promise.resolve({
          status: "failed" as const,
          appletId: APPLET,
          generationId: "unbuilt",
          reason: "the build failed at the lint stage",
          diagnostics: ["ui.tsx:3:9 no raw colours"],
        }),
    });
    const result = await call("applet_publish", { appletId: APPLET });
    expect(result.content).toContain("the build failed at the lint stage");
    expect(result.content).toContain("ui.tsx:3:9 no raw colours");
    expect(result.content).toContain("still on the generation it was on");
  });
});
