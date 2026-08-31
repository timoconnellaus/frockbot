import { describe, expect, test } from "bun:test";
import {
  decodeSkillSourceV1,
  decodeWorkspaceEntryV1,
  decodeWorkspaceFailureV1,
  decodeWorkspaceGenerationV1,
  decodeWorkspacePathV1,
  decodeWorkspaceRootV1,
  decodeWorkspaceWriterV1,
  decodeWorkspaceConflictV1,
  decodeWorkspaceGenerationRecordV1,
  isLoadableSkillSourceV1,
  isWorkspaceComputerReadOnlyRootV1,
  isWorkspaceInstructionRootV1,
  isWorkspaceMemoryRootV1,
  isWorkspaceSharedMemoryRootV1,
  memoryShardOwnerV1,
  memoryShardPathV1,
  memoryShardPrefixV1,
  workspaceMemoryShardV1,
  writerOwnsMemoryPathV1,
  normalizeWorkspaceRelativePathV1,
  workspaceMemoryProjectionV1,
  workspaceRootAcceptsKernelWriteV1,
  workspaceRootKeyV1,
  workspaceWriterMayWriteV1,
  WORKSPACE_MAX_PATH_LENGTH,
  WORKSPACE_MAX_PATH_SEGMENTS,
  WORKSPACE_MAX_SEGMENT_LENGTH,
  WORKSPACE_MEMORY_SHARD_PREFIX,
  type SkillSourceV1,
  type WorkspaceMemoryRootV1,
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

function userInstructionRoot(userId = "user-1"): WorkspaceRootV1 {
  return { kind: "user-instructions", userId };
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
      workspaceRootKeyV1(userInstructionRoot()),
      workspaceRootKeyV1(userInstructionRoot("user-2")),
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

  test("the User-global instruction root round-trips through its key and its decoder", () => {
    // ADR 0016 names the root `users/<id>/skills/`, and the object store keys
    // every file under `workspace/<root key>/`, so the key is that location.
    expect(workspaceRootKeyV1(userInstructionRoot())).toBe(
      "users/user-1/skills",
    );
    expect(workspaceRootKeyV1(userInstructionRoot("owner/one"))).toBe(
      "users/owner%2Fone/skills",
    );
    const decoded = decodeWorkspaceRootV1({
      kind: "user-instructions",
      userId: "user-1",
    });
    expect(decoded).toEqual(userInstructionRoot());
    expect(workspaceRootKeyV1(decoded)).toBe(
      workspaceRootKeyV1(userInstructionRoot()),
    );
    // A Bot id would name a root this kind does not have.
    expect(() =>
      decodeWorkspaceRootV1({
        kind: "user-instructions",
        userId: "user-1",
        botId: "bot-1",
      }),
    ).toThrow();
  });

  test("both instruction roots are instruction roots; only the User-global one is read-only on the Computer", () => {
    expect(isWorkspaceInstructionRootV1(instructionRoot())).toBe(true);
    expect(isWorkspaceInstructionRootV1(userInstructionRoot())).toBe(true);
    expect(
      isWorkspaceInstructionRootV1({
        kind: "user-memory",
        userId: "user-1",
      }),
    ).toBe(false);
    // ADR 0013 for Memory, ADR 0016 for the User-global instruction root: both
    // have a single writer over object storage, so the Computer presents them
    // read-only and the sync never pushes out of them.
    expect(isWorkspaceComputerReadOnlyRootV1(userInstructionRoot())).toBe(true);
    expect(
      isWorkspaceComputerReadOnlyRootV1({
        kind: "user-memory",
        userId: "user-1",
      }),
    ).toBe(true);
    expect(isWorkspaceComputerReadOnlyRootV1(instructionRoot())).toBe(false);
    // The kernel-consumed surface still writes it: read-only is a statement
    // about the Computer, not about the Skills Package.
    expect(workspaceRootAcceptsKernelWriteV1(userInstructionRoot())).toBe(true);
    expect(isWorkspaceMemoryRootV1(userInstructionRoot())).toBe(false);
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

  test("rejects the segments the object-storage key scheme and the sync reserve", () => {
    // `workspace/<root>/<relative>.conflict/<generationId>` preserves a losing
    // write, so a file may not occupy a `.conflict` segment: `notes.conflict`
    // would shadow its own conflicts, and `notes.conflict/a.md` would be read
    // as one. `.frockbot-generations` and `.frockbot-sync` belong to the
    // Computer-side sync agent.
    for (const path of [
      "notes.conflict",
      "notes.conflict/a.md",
      "notes.conflict/0000-0001",
      ".conflict",
      "skills/deploy.conflict/SKILL.md",
      ".frockbot-generations",
      ".frockbot-generations/notes.md",
      "skills/.frockbot-sync/tombstones/notes.md",
    ]) {
      expect(() => normalizeWorkspaceRelativePathV1(path)).toThrow();
    }
    // Nothing else that merely mentions the word is refused.
    expect(normalizeWorkspaceRelativePathV1("conflict/notes.md")).toBe(
      "conflict/notes.md",
    );
    expect(normalizeWorkspaceRelativePathV1("notes.conflicted.md")).toBe(
      "notes.conflicted.md",
    );
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

  test("a Skill in the User-global root written by any of the User's Bots is loadable", () => {
    // The whole point of the shared tier: Bot A authors, Bot B follows. ADR
    // 0016 — authority does not widen, because a Bot writing there writes
    // under authority it already holds.
    expect(
      isLoadableSkillSourceV1(
        skillSource(userInstructionRoot(), { ...bot, botId: "bot-2" }),
        owner,
      ),
    ).toBe(true);
    expect(
      isLoadableSkillSourceV1(skillSource(userInstructionRoot(), bot), owner),
    ).toBe(true);
    expect(
      isLoadableSkillSourceV1(
        skillSource(userInstructionRoot(), {
          kind: "user",
          userId: "user-1",
        }),
        owner,
      ),
    ).toBe(true);
  });

  test("another User's global root, and an unattributed or first-party writer in this User's, are refused", () => {
    expect(
      isLoadableSkillSourceV1(
        skillSource(userInstructionRoot("user-2"), bot),
        owner,
      ),
    ).toBe(false);
    expect(
      isLoadableSkillSourceV1(
        skillSource(userInstructionRoot(), { kind: "user", userId: "user-2" }),
        owner,
      ),
    ).toBe(false);
    for (const writer of [
      { kind: "unattributed" },
      { kind: "first-party", packageId: "skills" },
    ] satisfies WorkspaceWriterV1[]) {
      expect(
        isLoadableSkillSourceV1(
          skillSource(userInstructionRoot(), writer),
          owner,
        ),
      ).toBe(false);
    }
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

describe("the three Memory tiers", () => {
  const botRoot: WorkspaceMemoryRootV1 = {
    kind: "bot-memory",
    userId: "user-1",
    botId: "bot-1",
  };
  const userRoot: WorkspaceMemoryRootV1 = {
    kind: "user-memory",
    userId: "user-1",
  };
  const projectRoot: WorkspaceMemoryRootV1 = {
    kind: "project-memory",
    userId: "user-1",
    projectId: "school-run",
  };

  test("decodes a Project Memory root and bounds its Project id", () => {
    expect(decodeWorkspaceRootV1(projectRoot)).toEqual(projectRoot);
    expect(() =>
      decodeWorkspaceRootV1({ kind: "project-memory", userId: "user-1" }),
    ).toThrow();
    expect(() =>
      decodeWorkspaceRootV1({ ...projectRoot, projectId: "Not A Slug" }),
    ).toThrow();
    expect(() =>
      decodeWorkspaceRootV1({ ...projectRoot, projectId: "a".repeat(129) }),
    ).toThrow();
    expect(() =>
      decodeWorkspaceRootV1({ ...projectRoot, botId: "bot-1" }),
    ).toThrow();
  });

  test("all three kinds are Memory roots, and only two are shared", () => {
    expect(
      [botRoot, userRoot, projectRoot].map(isWorkspaceMemoryRootV1),
    ).toEqual([true, true, true]);
    expect(isWorkspaceMemoryRootV1(instructionRoot())).toBe(false);
    expect(
      [botRoot, userRoot, projectRoot].map(isWorkspaceSharedMemoryRootV1),
    ).toEqual([false, true, true]);
  });

  test("no Memory root accepts a kernel write, Project Memory included", () => {
    expect(workspaceRootAcceptsKernelWriteV1(projectRoot)).toBe(false);
  });

  test("a Project Memory root key never collides with another root", () => {
    expect(workspaceRootKeyV1(projectRoot)).toBe(
      "project-memory:user-1:school-run",
    );
    const keys = [
      workspaceRootKeyV1(botRoot),
      workspaceRootKeyV1(userRoot),
      workspaceRootKeyV1(projectRoot),
      workspaceRootKeyV1(instructionRoot()),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("shared Memory tiers are sharded per writing Bot", () => {
  const userRoot: WorkspaceMemoryRootV1 = {
    kind: "user-memory",
    userId: "user-1",
  };
  const projectRoot: WorkspaceMemoryRootV1 = {
    kind: "project-memory",
    userId: "user-1",
    projectId: "school-run",
  };
  const botRoot: WorkspaceMemoryRootV1 = {
    kind: "bot-memory",
    userId: "user-1",
    botId: "bot-1",
  };

  test("a shared root places a Bot's files under its own shard", () => {
    expect(memoryShardPrefixV1(userRoot, "bot-1")).toBe(
      `${WORKSPACE_MEMORY_SHARD_PREFIX}/bot-1/`,
    );
    expect(memoryShardPathV1(userRoot, "bot-1", "profile.md")).toEqual({
      root: userRoot,
      path: "by-agent/bot-1/profile.md",
    });
    expect(memoryShardPathV1(projectRoot, "bot-2", "log/2026-08.md")).toEqual({
      root: projectRoot,
      path: "by-agent/bot-2/log/2026-08.md",
    });
    expect(workspaceMemoryShardV1(projectRoot, "bot-2")).toEqual({
      root: projectRoot,
      botId: "bot-2",
      prefix: "by-agent/bot-2/",
    });
  });

  test("a Bot Memory root has one writer already, so it has no shard prefix", () => {
    expect(memoryShardPrefixV1(botRoot, "bot-1")).toBe("");
    expect(memoryShardPathV1(botRoot, "bot-1", "profile.md")).toEqual({
      root: botRoot,
      path: "profile.md",
    });
    expect(workspaceMemoryShardV1(botRoot, "bot-1").prefix).toBe("");
  });

  test("a shard path refuses an escaping relative path or Bot id", () => {
    expect(() =>
      memoryShardPathV1(userRoot, "bot-1", "../escape.md"),
    ).toThrow();
    expect(() =>
      memoryShardPathV1(userRoot, "bot-1", "/absolute.md"),
    ).toThrow();
    expect(() => memoryShardPathV1(userRoot, "a/b", "profile.md")).toThrow();
    expect(() => memoryShardPathV1(userRoot, "..", "profile.md")).toThrow();
    expect(() => memoryShardPathV1(userRoot, "", "profile.md")).toThrow();
  });

  test("the shard owner is read back off the path", () => {
    expect(
      memoryShardOwnerV1(memoryShardPathV1(userRoot, "bot-9", "profile.md")),
    ).toBe("bot-9");
    expect(memoryShardOwnerV1({ root: userRoot, path: "profile.md" })).toBe(
      undefined,
    );
    expect(memoryShardOwnerV1({ root: botRoot, path: "profile.md" })).toBe(
      "bot-1",
    );
    expect(
      memoryShardOwnerV1({ root: instructionRoot(), path: "a/SKILL.md" }),
    ).toBe(undefined);
  });

  test("a Bot writer owns only its own shard", () => {
    const bot = (botId: string): WorkspaceWriterV1 => ({
      kind: "bot",
      botId,
      sessionId: "user-1:bot",
      turnId: "turn-1",
      runId: "run-1",
    });
    const own = memoryShardPathV1(userRoot, "bot-1", "profile.md");
    expect(writerOwnsMemoryPathV1(own, bot("bot-1"))).toBe(true);
    expect(writerOwnsMemoryPathV1(own, bot("bot-2"))).toBe(false);
    // An unsharded file in a shared root belongs to no Bot's shard.
    expect(
      writerOwnsMemoryPathV1(
        { root: userRoot, path: "profile.md" },
        bot("bot-1"),
      ),
    ).toBe(false);
    // A Bot Memory root is its own Bot's shard, and no other Bot's.
    expect(
      writerOwnsMemoryPathV1(
        { root: botRoot, path: "profile.md" },
        bot("bot-1"),
      ),
    ).toBe(true);
    expect(
      writerOwnsMemoryPathV1(
        { root: botRoot, path: "profile.md" },
        bot("bot-2"),
      ),
    ).toBe(false);
  });

  test("a User owns every shard of their own root; a Package owns none", () => {
    const user: WorkspaceWriterV1 = { kind: "user", userId: "user-1" };
    const other: WorkspaceWriterV1 = { kind: "user", userId: "user-2" };
    expect(
      writerOwnsMemoryPathV1(
        memoryShardPathV1(projectRoot, "bot-7", "profile.md"),
        user,
      ),
    ).toBe(true);
    expect(
      writerOwnsMemoryPathV1(
        memoryShardPathV1(projectRoot, "bot-7", "profile.md"),
        other,
      ),
    ).toBe(false);
    expect(
      writerOwnsMemoryPathV1(memoryShardPathV1(userRoot, "bot-1", "p.md"), {
        kind: "first-party",
        packageId: "memory",
      }),
    ).toBe(false);
    expect(
      writerOwnsMemoryPathV1(memoryShardPathV1(userRoot, "bot-1", "p.md"), {
        kind: "unattributed",
      }),
    ).toBe(false);
  });

  test("the predicate answers only the Memory sharding rule", () => {
    expect(
      writerOwnsMemoryPathV1(
        { root: instructionRoot(), path: "skills/a/SKILL.md" },
        { kind: "user", userId: "user-1" },
      ),
    ).toBe(false);
  });
});

describe("conflicting generations survive as a declared variant", () => {
  test("a conflict carries both generations and decodes exactly", () => {
    const current = generation({ generationId: "000000000000001-000001" });
    const preserved = generation({
      generationId: "000000000000002-000001",
      conflictsWith: "000000000000001-000001",
    });
    const decoded = decodeWorkspaceConflictV1({
      status: "conflict",
      reason: "the file changed since the writer last saw it",
      current,
      preserved,
    });
    expect(decoded.current?.generationId).toBe("000000000000001-000001");
    expect(decoded.preserved?.conflictsWith).toBe("000000000000001-000001");
    expect(
      decodeWorkspaceFailureV1({
        status: "conflict",
        reason: "the file changed since the writer last saw it",
        current,
        preserved,
      }),
    ).toEqual(decoded);
    expect(() =>
      decodeWorkspaceConflictV1({ status: "refused", reason: "no" }),
    ).toThrow();
    expect(() =>
      decodeWorkspaceFailureV1({ status: "refused", reason: "no", current }),
    ).toThrow();
  });
});

describe("durable generation records", () => {
  test("a record names its root, path, generation, and object etag", () => {
    const entry = decodeWorkspaceGenerationRecordV1({
      schemaVersion: 1,
      root: instructionRoot(),
      path: "skills/deploy/SKILL.md",
      generation: generation(),
      etag: "abc123",
    });
    expect(entry.root).toEqual(instructionRoot());
    expect(entry.etag).toBe("abc123");
    expect(entry.deleted).toBe(undefined);
  });

  test("a tombstone is a record, so a delete leaves durable evidence", () => {
    const entry = decodeWorkspaceGenerationRecordV1({
      schemaVersion: 1,
      root: instructionRoot(),
      path: "skills/deploy/SKILL.md",
      generation: generation({
        contentHash:
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        size: 0,
      }),
      deleted: true,
    });
    expect(entry.deleted).toBe(true);
  });

  test("rejects an unknown field, a bad path, and a wrong schema version", () => {
    const base = {
      schemaVersion: 1,
      root: instructionRoot(),
      path: "a.md",
      generation: generation(),
    };
    expect(() =>
      decodeWorkspaceGenerationRecordV1({ ...base, surprise: 1 }),
    ).toThrow();
    expect(() =>
      decodeWorkspaceGenerationRecordV1({ ...base, path: "../a.md" }),
    ).toThrow();
    expect(() =>
      decodeWorkspaceGenerationRecordV1({ ...base, schemaVersion: 2 }),
    ).toThrow();
  });
});
