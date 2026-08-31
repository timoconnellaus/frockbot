import { describe, expect, test } from "bun:test";
import {
  decodeSkillSourceV1,
  decodeWorkspaceEntryV1,
  decodeWorkspaceFailureV1,
  decodeWorkspaceGenerationV1,
  decodeWorkspacePathV1,
  decodeWorkspaceRootV1,
  decodeWorkspaceWriterV1,
  isLoadableSkillSourceV1,
  normalizeWorkspaceRelativePathV1,
  workspaceMemoryProjectionV1,
  workspaceRootAcceptsKernelWriteV1,
  workspaceRootKeyV1,
  workspaceWriterMayWriteV1,
  WORKSPACE_MAX_PATH_LENGTH,
  WORKSPACE_MAX_PATH_SEGMENTS,
  WORKSPACE_MAX_SEGMENT_LENGTH,
  type SkillSourceV1,
  type WorkspaceFilesV1,
  type WorkspaceGenerationV1,
  type WorkspaceRootV1,
  type WorkspaceWriterV1,
} from "./workspace.js";

const HASH = "a".repeat(64);

function generation(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    generationId: "2026-08-31T00:00:00.000Z:0000000000000001",
    contentHash: HASH,
    size: 12,
    writer: { kind: "user", userId: "user-1" },
    writtenAt: "2026-08-31T00:00:00.000Z",
    ...overrides,
  };
}

function instructionRoot(): WorkspaceRootV1 {
  return { kind: "bot-instructions", userId: "user-1", botId: "bot-1" };
}

function skillSource(
  root: WorkspaceRootV1,
  writer: WorkspaceWriterV1,
): SkillSourceV1 {
  return {
    path: { root, path: "skills/deploy.md" },
    writer,
    generation: decodeWorkspaceGenerationV1(generation({ writer })),
  };
}

describe("durable roots", () => {
  test("decodes each kind with its owner and rejects everything else", () => {
    expect(decodeWorkspaceRootV1(instructionRoot())).toEqual(instructionRoot());
    expect(
      decodeWorkspaceRootV1({ kind: "user-memory", userId: "user-1" }),
    ).toEqual({ kind: "user-memory", userId: "user-1" });
    expect(
      decodeWorkspaceRootV1({
        kind: "package-declared",
        userId: "user-1",
        packageId: "notes",
        rootId: "notes-archive",
      }).kind,
    ).toBe("package-declared");

    for (const invalid of [
      null,
      [],
      { kind: "unknown", userId: "user-1" },
      // a per-Bot kind without its Bot
      { kind: "bot-instructions", userId: "user-1" },
      // a User-scoped kind carrying a Bot
      { kind: "user-memory", userId: "user-1", botId: "bot-1" },
      { kind: "bot-memory", userId: "", botId: "bot-1" },
      { kind: "package-declared", userId: "user-1", packageId: "notes" },
      {
        kind: "package-declared",
        userId: "user-1",
        packageId: "notes",
        rootId: "../escape",
      },
    ]) {
      expect(() => decodeWorkspaceRootV1(invalid)).toThrow();
    }
  });

  test("keys are stable and never collide across kinds or owners", () => {
    const keys = [
      workspaceRootKeyV1(instructionRoot()),
      workspaceRootKeyV1({
        kind: "bot-memory",
        userId: "user-1",
        botId: "bot-1",
      }),
      workspaceRootKeyV1({ kind: "user-memory", userId: "user-1" }),
      workspaceRootKeyV1({
        kind: "user-memory",
        userId: "user-1:bot-1",
      }),
      workspaceRootKeyV1({
        kind: "package-declared",
        userId: "user-1",
        packageId: "notes",
        rootId: "archive",
      }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(workspaceRootKeyV1(instructionRoot())).toBe(
      workspaceRootKeyV1(instructionRoot()),
    );
  });
});

describe("workspace paths", () => {
  test("accepts normalized relative POSIX paths", () => {
    for (const path of [
      "notes.md",
      "skills/deploy.md",
      "a/b/c/d.txt",
      "spaced name.md",
      "..hidden/..leading.md",
    ]) {
      expect(normalizeWorkspaceRelativePathV1(path)).toBe(path);
    }
  });

  test("rejects traversal, absolute paths, and every other escape", () => {
    for (const path of [
      "",
      "/etc/passwd",
      "..",
      "../secret",
      "skills/../../etc/passwd",
      "skills/./deploy.md",
      "skills//deploy.md",
      "skills/",
      "windows\\path.md",
      "nul\u0000byte.md",
      "line\nbreak.md",
      "bell\u0007.md",
      "delete\u007f.md",
      " leading.md",
      "trailing.md ",
      "dir/ padded.md",
      "a".repeat(WORKSPACE_MAX_SEGMENT_LENGTH + 1),
      "a".repeat(WORKSPACE_MAX_PATH_LENGTH + 1),
      Array.from({ length: WORKSPACE_MAX_PATH_SEGMENTS + 1 }, () => "a").join(
        "/",
      ),
      123,
      null,
      undefined,
    ]) {
      expect(() => normalizeWorkspaceRelativePathV1(path)).toThrow();
    }
  });

  test("a decoded path carries its root and rejects extra fields", () => {
    expect(
      decodeWorkspacePathV1({ root: instructionRoot(), path: "skills/a.md" }),
    ).toEqual({ root: instructionRoot(), path: "skills/a.md" });
    expect(() =>
      decodeWorkspacePathV1({
        root: instructionRoot(),
        path: "skills/a.md",
        absolute: "/home/box/skills/a.md",
      }),
    ).toThrow();
    expect(() =>
      decodeWorkspacePathV1({ root: instructionRoot(), path: "../a.md" }),
    ).toThrow();
  });
});

describe("writer provenance and generations", () => {
  test("decodes an unattributed writer, which records that nobody was recorded", () => {
    expect(decodeWorkspaceWriterV1({ kind: "unattributed" })).toEqual({
      kind: "unattributed",
    });
    for (const invalid of [
      { kind: "unattributed", userId: "user-1" },
      { kind: "unattributed", packageId: "memory" },
    ]) {
      expect(() => decodeWorkspaceWriterV1(invalid)).toThrow();
    }
  });

  test("decodes the three provenance kinds and nothing else", () => {
    expect(
      decodeWorkspaceWriterV1({ kind: "first-party", packageId: "memory" }),
    ).toEqual({ kind: "first-party", packageId: "memory" });
    expect(decodeWorkspaceWriterV1({ kind: "user", userId: "user-1" })).toEqual(
      {
        kind: "user",
        userId: "user-1",
      },
    );
    expect(
      decodeWorkspaceWriterV1({
        kind: "bot",
        botId: "bot-1",
        sessionId: "session-1",
        turnId: "turn-1",
        runId: "run-1",
      }).kind,
    ).toBe("bot");

    for (const invalid of [
      { kind: "anonymous" },
      { kind: "user" },
      { kind: "bot", botId: "bot-1" },
      { kind: "user", userId: "user-1", botId: "bot-1" },
    ]) {
      expect(() => decodeWorkspaceWriterV1(invalid)).toThrow();
    }
  });

  test("a generation records its writer, its minted id, and its content address", () => {
    const decoded = decodeWorkspaceGenerationV1(generation());
    expect(decoded.writer).toEqual({ kind: "user", userId: "user-1" });
    expect(decoded.contentHash).toBe(HASH);
    expect(decoded.conflictsWith).toBeUndefined();
    expect(
      decodeWorkspaceGenerationV1(generation({ conflictsWith: "gen-0" }))
        .conflictsWith,
    ).toBe("gen-0");

    for (const invalid of [
      generation({ schemaVersion: 2 }),
      generation({ contentHash: "not-a-hash" }),
      generation({ size: -1 }),
      generation({ size: 1.5 }),
      generation({ size: Number.MAX_SAFE_INTEGER }),
      generation({ writer: { kind: "anonymous" } }),
      { ...generation(), unexpected: true },
    ]) {
      expect(() => decodeWorkspaceGenerationV1(invalid)).toThrow();
    }
  });

  test("an entry pairs a validated path with its generation", () => {
    const entry = decodeWorkspaceEntryV1({
      path: { root: instructionRoot(), path: "skills/a.md" },
      generation: generation(),
    });
    expect(entry.path.path).toBe("skills/a.md");
    expect(entry.generation.generationId).toBe(
      "2026-08-31T00:00:00.000Z:0000000000000001",
    );
  });
});

describe("declared failure variants", () => {
  test("decodes each status and refuses an undeclared one", () => {
    for (const status of [
      "not-found",
      "refused",
      "conflict",
      "unavailable",
    ] as const) {
      expect(decodeWorkspaceFailureV1({ status, reason: "why" })).toEqual({
        status,
        reason: "why",
      });
    }
    expect(() =>
      decodeWorkspaceFailureV1({ status: "ok", reason: "why" }),
    ).toThrow();
    expect(() => decodeWorkspaceFailureV1({ status: "refused" })).toThrow();
  });
});

describe("Memory roots are single-writer", () => {
  test("no Memory root accepts a write through the kernel-consumed interface", () => {
    expect(
      workspaceRootAcceptsKernelWriteV1({
        kind: "bot-memory",
        userId: "user-1",
        botId: "bot-1",
      }),
    ).toBe(false);
    expect(
      workspaceRootAcceptsKernelWriteV1({
        kind: "user-memory",
        userId: "user-1",
      }),
    ).toBe(false);
    expect(workspaceRootAcceptsKernelWriteV1(instructionRoot())).toBe(true);
    expect(
      workspaceRootAcceptsKernelWriteV1({
        kind: "package-declared",
        userId: "user-1",
        packageId: "notes",
        rootId: "archive",
      }),
    ).toBe(true);
  });

  test("no write may name an unattributed writer, whatever the root", () => {
    const unattributed: WorkspaceWriterV1 = { kind: "unattributed" };
    expect(workspaceWriterMayWriteV1(unattributed)).toBe(false);
    expect(workspaceWriterMayWriteV1({ kind: "user", userId: "user-1" })).toBe(
      true,
    );
    expect(
      workspaceRootAcceptsKernelWriteV1(instructionRoot(), unattributed),
    ).toBe(false);
    expect(
      workspaceRootAcceptsKernelWriteV1(
        {
          kind: "package-declared",
          userId: "user-1",
          packageId: "notes",
          rootId: "archive",
        },
        unattributed,
      ),
    ).toBe(false);
    expect(
      workspaceRootAcceptsKernelWriteV1(instructionRoot(), {
        kind: "user",
        userId: "user-1",
      }),
    ).toBe(true);
  });

  test("the Memory projection of a full file interface exposes no write path", () => {
    const calls: string[] = [];
    const files: WorkspaceFilesV1 = {
      read: async (path) => {
        calls.push(`read:${path.path}`);
        return { status: "not-found", reason: "absent" };
      },
      list: async () => ({ status: "ok", entries: [] }),
      stat: async () => ({ status: "not-found", reason: "absent" }),
      write: async () => {
        calls.push("write");
        return {
          status: "ok",
          generation: decodeWorkspaceGenerationV1(
            generation(),
          ) satisfies WorkspaceGenerationV1,
        };
      },
      delete: async () => {
        calls.push("delete");
        return {
          status: "ok",
          generation: decodeWorkspaceGenerationV1(generation()),
        };
      },
    };

    const projection = workspaceMemoryProjectionV1(files);

    expect(Object.keys(projection).sort()).toEqual(["list", "read", "stat"]);
    expect("write" in projection).toBe(false);
    expect("delete" in projection).toBe(false);
    expect(
      (projection as unknown as Record<string, unknown>).write,
    ).toBeUndefined();
    expect(calls).toEqual([]);
  });
});

describe("Skill sources", () => {
  const bot: WorkspaceWriterV1 = {
    kind: "bot",
    botId: "bot-1",
    sessionId: "session-1",
    turnId: "turn-1",
    runId: "run-1",
  };
  const owner = { botId: "bot-1", userId: "user-1" };

  test("a Skill under the Bot's own instruction root, written by the Bot or its User, is loadable", () => {
    expect(
      isLoadableSkillSourceV1(skillSource(instructionRoot(), bot), owner),
    ).toBe(true);
    expect(
      isLoadableSkillSourceV1(
        skillSource(instructionRoot(), { kind: "user", userId: "user-1" }),
        owner,
      ),
    ).toBe(true);
  });

  test("no other root kind is ever a Skill source", () => {
    for (const root of [
      { kind: "bot-memory", userId: "user-1", botId: "bot-1" },
      { kind: "user-memory", userId: "user-1" },
      {
        kind: "package-declared",
        userId: "user-1",
        packageId: "notes",
        rootId: "archive",
      },
    ] satisfies WorkspaceRootV1[]) {
      expect(isLoadableSkillSourceV1(skillSource(root, bot), owner)).toBe(
        false,
      );
    }
  });

  test("another Bot's instruction root, or another User's, is not a Skill source", () => {
    expect(
      isLoadableSkillSourceV1(
        skillSource(
          { kind: "bot-instructions", userId: "user-1", botId: "bot-2" },
          bot,
        ),
        owner,
      ),
    ).toBe(false);
    expect(
      isLoadableSkillSourceV1(
        skillSource(
          { kind: "bot-instructions", userId: "user-2", botId: "bot-1" },
          bot,
        ),
        owner,
      ),
    ).toBe(false);
  });

  test("a writer that is neither the Bot nor its User is refused", () => {
    for (const writer of [
      { kind: "first-party", packageId: "memory" },
      { kind: "user", userId: "user-2" },
      { ...bot, botId: "bot-2" },
    ] satisfies WorkspaceWriterV1[]) {
      expect(
        isLoadableSkillSourceV1(skillSource(instructionRoot(), writer), owner),
      ).toBe(false);
    }
  });

  test("a file with no recorded writer is never a Skill source", () => {
    // A shell command on the Computer can drop a SKILL.md into any root it can
    // reach. Nothing recorded who wrote it, so it is data, never an
    // instruction — even under the Bot's own instruction root.
    expect(
      isLoadableSkillSourceV1(
        skillSource(instructionRoot(), { kind: "unattributed" }),
        owner,
      ),
    ).toBe(false);
    expect(
      isLoadableSkillSourceV1(
        decodeSkillSourceV1({
          path: { root: instructionRoot(), path: "skills/dropped/SKILL.md" },
          writer: { kind: "unattributed" },
          generation: generation({ writer: { kind: "unattributed" } }),
        }),
        owner,
      ),
    ).toBe(false);
  });

  test("a decoded Skill source keeps its recorded writer", () => {
    const decoded = decodeSkillSourceV1({
      path: { root: instructionRoot(), path: "skills/deploy.md" },
      writer: bot,
      generation: generation({ writer: bot }),
    });
    expect(decoded.writer).toEqual(bot);
    expect(isLoadableSkillSourceV1(decoded, owner)).toBe(true);
    expect(() =>
      decodeSkillSourceV1({
        path: { root: instructionRoot(), path: "../deploy.md" },
        writer: bot,
        generation: generation({ writer: bot }),
      }),
    ).toThrow();
  });
});
