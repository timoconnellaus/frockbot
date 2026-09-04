import { describe, expect, test } from "bun:test";
import { Context } from "cordis";
import {
  ComputerError,
  ComputerRegistry,
  computerIdentityKeyV1,
  decodeComputerDoctorReportV1,
  workspaceMountPathV1,
  type ComputerHandle,
  type ComputerProvider,
  type WorkspaceLayoutV1,
  normalizeComputerPath,
} from "./core.js";

function provider(id: string, opened: string[]): ComputerProvider {
  return {
    id,
    async open(identity, tenant, assignment): Promise<ComputerHandle> {
      opened.push(
        `${identity.userId}:${tenant.botId}:${assignment.generation}`,
      );
      return {
        assignment,
        identity,
        tenant: {
          botId: tenant.botId,
          directory: `agents/${tenant.botId}`,
          display: `:${100 + opened.length}`,
        },
        close: () => Promise.resolve(),
      };
    },
  };
}

const LAYOUT: WorkspaceLayoutV1 = {
  schemaVersion: 1,
  home: "/home/box",
  roots: [
    {
      kind: "bot-instructions",
      scope: "bot",
      mountPath: "/home/box/agent-data/agents/{bot}/skills",
      access: "read-write",
    },
    {
      kind: "user-memory",
      scope: "user",
      mountPath: "/home/box/agent-data/user-memory",
      access: "read-only",
    },
    {
      kind: "package-declared",
      scope: "user",
      mountPath: "/home/box/agent-data/user-packages/{package}/{root}",
      access: "read-write",
    },
  ],
};

describe("Computer paths", () => {
  test("accepts relative POSIX paths and rejects namespace escapes", () => {
    expect(normalizeComputerPath("memory/profile.md")).toBe(
      "memory/profile.md",
    );
    for (const path of [
      "/etc/passwd",
      "../secret",
      "a/./b",
      "a//b",
      "a\\b",
      " spaced.md ",
      "line\nbreak.md",
    ]) {
      expect(() => normalizeComputerPath(path)).toThrow(ComputerError);
    }
  });
});

describe("Workspace layout", () => {
  // Constitution — Computer and Workspace: durable roots are "declared by the
  // Computer Package's Workspace layout"; a root is named by kind and owner
  // and never by an absolute path.
  test("resolves a declared root to its mount path and refuses an undeclared one", () => {
    expect(
      workspaceMountPathV1(
        LAYOUT,
        { kind: "bot-instructions", userId: "u", botId: "b" },
        (botId) => `${botId}-abc`,
      ),
    ).toBe("/home/box/agent-data/agents/b-abc/skills");
    expect(
      workspaceMountPathV1(LAYOUT, { kind: "user-memory", userId: "u" }),
    ).toBe("/home/box/agent-data/user-memory");
    expect(
      workspaceMountPathV1(LAYOUT, {
        kind: "package-declared",
        userId: "u",
        packageId: "@frockbot/plugin-memory",
        rootId: "notes",
      }),
    ).toBe("/home/box/agent-data/user-packages/frockbot-plugin-memory/notes");
    expect(() =>
      workspaceMountPathV1(LAYOUT, {
        kind: "bot-memory",
        userId: "u",
        botId: "b",
      }),
    ).toThrow(ComputerError);
    expect(() =>
      workspaceMountPathV1(LAYOUT, {
        kind: "bot-instructions",
        userId: "u",
        botId: "b",
      }),
    ).toThrow("needs a Bot");
  });
});

describe("ComputerRegistry", () => {
  test("opens a Bot's selected provider without exposing provider selection to consumers", async () => {
    const root = new Context();
    await root.plugin(ComputerRegistry);
    const opened: string[] = [];
    root.computers.register(provider("sprites", opened));
    const assignment = root.computers.assign({ userId: "user-1" }, "sprites");

    const computer = await root.computers.open(
      { userId: "user-1" },
      { botId: "bot-1" },
    );

    expect(computer.assignment).toEqual(assignment);
    expect(opened).toEqual(["user-1:bot-1:1"]);
    await root.fiber.dispose();
  });

  // ADR 0012: "One Computer serves all of a User's Bots." Two Bots of one User
  // must resolve to one assignment and one generation, not two.
  test("keys the Computer assignment per User, so a User's Bots share one Computer", async () => {
    const root = new Context();
    await root.plugin(ComputerRegistry);
    const opened: string[] = [];
    root.computers.register(provider("sprites", opened));

    const assignment = root.computers.assign({ userId: "user-1" }, "sprites");

    expect(root.computers.assignment({ userId: "user-1" })).toEqual(assignment);
    const first = await root.computers.open(
      { userId: "user-1" },
      { botId: "bot-1" },
    );
    const second = await root.computers.open(
      { userId: "user-1" },
      { botId: "bot-2" },
    );

    expect(opened).toEqual(["user-1:bot-1:1", "user-1:bot-2:1"]);
    expect(first.assignment.generation).toBe(second.assignment.generation);
    expect(first.identity).toEqual(second.identity);
    // Separation between tenants is organizational: each gets its own
    // directory and desktop on the one Computer.
    expect(first.tenant.directory).not.toBe(second.tenant.directory);
    expect(first.tenant.display).not.toBe(second.tenant.display);
    await root.fiber.dispose();
  });

  test("a second User gets a separate Computer assignment", async () => {
    const root = new Context();
    await root.plugin(ComputerRegistry);
    root.computers.register(provider("sprites", []));

    root.computers.assign({ userId: "user-1" }, "sprites");

    expect(root.computers.assignment({ userId: "user-2" })).toBeUndefined();
    expect(computerIdentityKeyV1({ userId: "user-1" })).not.toBe(
      computerIdentityKeyV1({ userId: "user-2" }),
    );
    await root.fiber.dispose();
  });

  test("increments the generation when a User changes provider", async () => {
    const root = new Context();
    await root.plugin(ComputerRegistry);
    root.computers.register(provider("sprites", []));
    root.computers.register(provider("local", []));
    const identity = { userId: "user-1" };

    expect(root.computers.assign(identity, "sprites").generation).toBe(1);
    expect(root.computers.assign(identity, "local")).toMatchObject({
      providerId: "local",
      generation: 2,
    });
    await root.fiber.dispose();
  });

  test("rejects operations through a stale handle after provider reassignment", async () => {
    const root = new Context();
    await root.plugin(ComputerRegistry);
    const executable = (id: string): ComputerProvider => ({
      id,
      open: async (identity, tenant, assignment) => ({
        assignment,
        identity,
        tenant,
        exec: {
          execute: async () => ({
            exitCode: 0,
            stdout: new Uint8Array(),
            stderr: new Uint8Array(),
            outputTruncated: false,
          }),
        },
        close: () => Promise.resolve(),
      }),
    });
    root.computers.register(executable("sprites"));
    root.computers.register(executable("local"));
    const identity = { userId: "user-1" };
    root.computers.assign(identity, "sprites");
    const oldComputer = await root.computers.open(identity, {
      botId: "bot-1",
    });

    root.computers.assign(identity, "local");

    await expect(
      oldComputer.exec?.execute({ executable: "true" }),
    ).rejects.toMatchObject({ code: "stale-assignment" });
    await root.fiber.dispose();
  });

  test("keeps a provider's single-root reconciliation on the guarded handle", async () => {
    // Bob on production (2026-09-04): the provider could reconcile one root,
    // the guarded handle dropped that method, and the publish that needed
    // `dist/` pulled explicitly was refused as "cannot reconcile a single
    // durable root" while ordinary sync no longer carried build output.
    const root = new Context();
    await root.plugin(ComputerRegistry);
    const calls: string[] = [];
    const syncing: ComputerProvider = {
      id: "sprites",
      open: async (identity, tenant, assignment) => ({
        assignment,
        identity,
        tenant,
        sync: {
          reconcile: async (reason) => {
            calls.push(`reconcile:${reason}`);
            return { status: "ok" } as never;
          },
          reconcileRoot: async (declared, reason, options) => {
            calls.push(
              `root:${reason}:${declared.kind}:${(options?.requiredPaths ?? []).join(",")}`,
            );
            return { status: "ok" } as never;
          },
          signal: async () => undefined,
        },
        close: () => Promise.resolve(),
      }),
    };
    root.computers.register(syncing);
    const identity = { userId: "user-1" };
    root.computers.assign(identity, "sprites");
    const computer = await root.computers.open(identity, { botId: "bot-1" });

    expect(computer.sync?.reconcileRoot).toBeDefined();
    await computer.sync?.reconcileRoot?.(
      {
        kind: "package-declared",
        userId: "user-1",
        packageId: "applets",
        rootId: "source",
      },
      "publish",
      { requiredPaths: ["a.b/dist/server.js"] },
    );
    expect(calls).toEqual(["root:publish:package-declared:a.b/dist/server.js"]);

    // Still guarded: a stale handle refuses it like every other operation.
    root.computers.register({ ...syncing, id: "local" });
    root.computers.assign(identity, "local");
    await expect(
      computer.sync?.reconcileRoot?.(
        {
          kind: "package-declared",
          userId: "user-1",
          packageId: "applets",
          rootId: "source",
        },
        "publish",
      ),
    ).rejects.toMatchObject({ code: "stale-assignment" });
    await root.fiber.dispose();
  });

  test("fails clearly when a User has no Computer assignment", async () => {
    const root = new Context();
    await root.plugin(ComputerRegistry);

    await expect(
      root.computers.open({ userId: "user-1" }, { botId: "bot-1" }),
    ).rejects.toMatchObject({
      code: "not-assigned",
    } satisfies Partial<ComputerError>);
    await root.fiber.dispose();
  });

  test("refuses an empty User or Bot identifier", async () => {
    const root = new Context();
    await root.plugin(ComputerRegistry);
    root.computers.register(provider("sprites", []));
    root.computers.assign({ userId: "user-1" }, "sprites");

    expect(() => computerIdentityKeyV1({ userId: "  " })).toThrow(
      ComputerError,
    );
    await expect(
      root.computers.open({ userId: "user-1" }, { botId: " " }),
    ).rejects.toMatchObject({ code: "invalid-request" });
    await root.fiber.dispose();
  });
});

// Parity row 27: the report a Computer's self-check prints, decoded exactly at
// its live stdout seam. A Computer that answered something else did not answer
// a half-usable report.
describe("the self-check report", () => {
  const report = {
    schemaVersion: 2,
    generation: 3,
    capturedAt: "2026-09-01T00:00:00Z",
    checks: [{ name: "disk-root", status: "pass", detail: "12% full" }],
    browserIdentity: null,
    summary: "1 checks, 1 passed, 0 failed",
  };

  test("decodes a report the Computer printed", () => {
    expect(decodeComputerDoctorReportV1(report)).toEqual({
      schemaVersion: 2,
      generation: 3,
      capturedAt: "2026-09-01T00:00:00Z",
      checks: [{ name: "disk-root", status: "pass", detail: "12% full" }],
      summary: "1 checks, 1 passed, 0 failed",
    });
  });

  // Parity row 34b. The measurement is optional because a Computer with no
  // browser running has nothing to measure, and `null` says that rather than
  // pretending to an empty user agent.
  test("keeps the browser measurement when the Computer made one", () => {
    expect(
      decodeComputerDoctorReportV1({
        ...report,
        browserIdentity: {
          userAgent: "Mozilla/5.0 … Chrome/141.0.0.0 Safari/537.36",
          webdriver: false,
          brands: ["Chromium/141", "Not?A_Brand/24"],
        },
      })?.browserIdentity,
    ).toEqual({
      userAgent: "Mozilla/5.0 … Chrome/141.0.0.0 Safari/537.36",
      webdriver: false,
      brands: ["Chromium/141", "Not?A_Brand/24"],
    });
    expect(
      decodeComputerDoctorReportV1({ ...report, browserIdentity: undefined }),
    ).not.toHaveProperty("browserIdentity");
  });

  test("keeps a failing check as a report, not as a decode failure", () => {
    const failing = {
      ...report,
      checks: [{ name: "dns", status: "fail", detail: "no resolver" }],
    };
    expect(decodeComputerDoctorReportV1(failing)?.checks[0]?.status).toBe(
      "fail",
    );
  });

  test("refuses anything that is not this schema", () => {
    for (const value of [
      undefined,
      null,
      "{}",
      { ...report, schemaVersion: 1 },
      { ...report, schemaVersion: 3 },
      { ...report, browserIdentity: "chrome" },
      { ...report, browserIdentity: { webdriver: false, brands: [] } },
      {
        ...report,
        browserIdentity: { userAgent: "", webdriver: false, brands: [] },
      },
      {
        ...report,
        browserIdentity: { userAgent: "Chrome", webdriver: "no", brands: [] },
      },
      {
        ...report,
        browserIdentity: { userAgent: "Chrome", webdriver: false, brands: "x" },
      },
      {
        ...report,
        browserIdentity: { userAgent: "Chrome", webdriver: false, brands: [7] },
      },
      { ...report, generation: "3" },
      { ...report, capturedAt: "" },
      { ...report, summary: 12 },
      { ...report, checks: [] },
      { ...report, checks: "none" },
      { ...report, checks: [{ name: "x", status: "maybe", detail: "" }] },
      { ...report, checks: [{ name: "", status: "pass", detail: "" }] },
      { ...report, checks: [{ status: "pass", detail: "" }] },
    ]) {
      expect(
        decodeComputerDoctorReportV1(value),
        JSON.stringify(value),
      ).toBeUndefined();
    }
  });
});
