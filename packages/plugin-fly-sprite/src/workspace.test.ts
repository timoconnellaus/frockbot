/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  isLoadableSkillSourceV1,
  WORKSPACE_MAX_FILE_BYTES,
  WORKSPACE_MAX_LIST_ENTRIES,
  type WorkspaceGenerationsV1,
  type WorkspaceRootV1,
  type WorkspaceWriterV1,
} from "@frockbot/kernel-contracts";
import { createObjectWorkspaceFilesV1 } from "@frockbot/workspace-store";
import {
  createInMemoryObjectBucketV1,
  createInMemoryWorkspaceGenerationsV1,
} from "@frockbot/workspace-store/testing";
import {
  computerBotKey,
  type ComputerHostFactoryV1,
  FlySpriteComputer,
} from "./computer.ts";
import { FakeComputerHost, type FakeComputerRunV1 } from "./host-double.ts";
import { FLY_WORKSPACE_LAYOUT, FlySpriteComputerProvider } from "./provider.ts";
import { FlyComputerWorkspace } from "./workspace.ts";

const USER = "owner";
const BOT = "health";
const OTHER_BOT = "general";

const USER_WRITER: WorkspaceWriterV1 = { kind: "user", userId: USER };
const BOT_WRITER: WorkspaceWriterV1 = {
  kind: "bot",
  botId: BOT,
  sessionId: "session-1",
  turnId: "turn-1",
  runId: "run-1",
};
const PACKAGE_WRITER: WorkspaceWriterV1 = {
  kind: "first-party",
  packageId: "@frockbot/plugin-skills",
};

const skillsRoot: WorkspaceRootV1 = {
  kind: "bot-instructions",
  userId: USER,
  botId: BOT,
};
const otherSkillsRoot: WorkspaceRootV1 = {
  kind: "bot-instructions",
  userId: USER,
  botId: OTHER_BOT,
};
const botMemoryRoot: WorkspaceRootV1 = {
  kind: "bot-memory",
  userId: USER,
  botId: BOT,
};
const userMemoryRoot: WorkspaceRootV1 = { kind: "user-memory", userId: USER };
const packageRoot: WorkspaceRootV1 = {
  kind: "package-declared",
  userId: USER,
  packageId: "@frockbot/plugin-notes",
  rootId: "notes",
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function quoted(shell: string, name: string): string | undefined {
  return new RegExp(`${name}='([^']*)'`).exec(shell)?.[1];
}

/**
 * A Computer whose durable filesystem is an in-memory map. It interprets the
 * shell the Workspace surface emits rather than running it, because the
 * scripts are GNU coreutils and the test host is not.
 */
class FakeWorkspaceDisk {
  readonly files = new Map<string, { bytes: Uint8Array; meta?: string }>();
  offline = false;
  modifiedSeconds = 1_700_000_000;

  /** The runner the shared host double hands every script to. */
  readonly run = (script: string): FakeComputerRunV1 => {
    if (this.offline) return { exitCode: 1, stderr: "Sprite is paused" };
    const root = quoted(script, "ROOT");
    const relative = quoted(script, "REL");
    if (!root) return {};
    if (script.includes("__WRITTEN__") && relative) {
      return { stdout: this.write(`${root}/${relative}`, script) };
    }
    if (script.includes("__DELETED__") && relative) {
      return { stdout: this.remove(`${root}/${relative}`, script) };
    }
    if (script.includes('find "$ROOT"')) {
      return { stdout: this.list(root, script) };
    }
    if (relative) {
      return {
        stdout: this.load(
          `${root}/${relative}`,
          script.includes('base64 -w0 "$TARGET"'),
        ),
      };
    }
    return {};
  };

  private current(path: string): string {
    const entry = this.files.get(path);
    if (!entry) return "";
    if (!entry.meta) return "__UNRECORDED__";
    return (
      Buffer.from(entry.meta, "base64").toString("utf8").split("\n")[0] ?? ""
    );
  }

  private expected(shell: string): string {
    return /if \[ "\$CURRENT" != '([^']*)' \]/.exec(shell)?.[1] ?? "";
  }

  private write(path: string, shell: string): string {
    if (this.current(path) !== this.expected(shell)) return "__CONFLICT__\n";
    const bytes = /printf %s '([^']*)' \| base64 -d > "\$TMP"/.exec(shell)?.[1];
    const meta = /printf %s '([^']*)' \| base64 -d > "\$MTMP"/.exec(shell)?.[1];
    this.files.set(path, {
      bytes: Uint8Array.from(Buffer.from(bytes ?? "", "base64")),
      meta,
    });
    return "__WRITTEN__\n";
  }

  private remove(path: string, shell: string): string {
    if (!this.files.has(path)) return "__MISSING__\n";
    if (this.current(path) !== this.expected(shell)) return "__CONFLICT__\n";
    this.files.delete(path);
    return "__DELETED__\n";
  }

  private load(path: string, withBytes: boolean): string {
    const entry = this.files.get(path);
    if (!entry) return "__MISSING__\n";
    if (entry.bytes.byteLength > WORKSPACE_MAX_FILE_BYTES) {
      return "__TOO_LARGE__\n";
    }
    const lines = [
      entry.meta ?? "",
      sha256(entry.bytes),
      String(entry.bytes.byteLength),
      String(this.modifiedSeconds),
    ];
    if (withBytes) lines.push(Buffer.from(entry.bytes).toString("base64"));
    return `${lines.join("\n")}\n`;
  }

  private list(root: string, shell: string): string {
    const offset = Number(/OFFSET=(\d+)/.exec(shell)?.[1] ?? 0);
    const limit = Number(/LIMIT=(\d+)/.exec(shell)?.[1] ?? 100);
    const prefix = quoted(shell, "PREFIX") ?? "";
    const rows = [...this.files.entries()]
      .filter(([path]) => path.startsWith(`${root}/`))
      .map(([path, entry]) => [path.slice(root.length + 1), entry] as const)
      .filter(
        ([relative]) =>
          !prefix || relative === prefix || relative.startsWith(`${prefix}/`),
      )
      .sort(([left], [right]) => (left < right ? -1 : 1))
      .slice(offset, offset + limit + 1)
      .map(([relative, entry]) =>
        [
          Buffer.from(relative).toString("base64"),
          entry.meta ?? "",
          sha256(entry.bytes),
          String(entry.bytes.byteLength),
          String(this.modifiedSeconds),
        ].join("\t"),
      );
    return rows.length ? `${rows.join("\n")}\n` : "";
  }
}

/**
 * The host double over one such disk, with `open` and `viewer` fenced off:
 * reaching a Workspace file must never provision a desktop or publish a
 * viewer, and a fixture that answered them would hide it if one did.
 */
function hostFor(disk: FakeWorkspaceDisk): {
  host: FakeComputerHost;
  factory: ComputerHostFactoryV1;
} {
  const host = new FakeComputerHost(disk.run);
  const factory: ComputerHostFactoryV1 = (identity, tenant) => ({
    ...host.factory(identity, tenant),
    open(): never {
      throw new Error("Workspace access must not provision a desktop");
    },
    viewer(): never {
      throw new Error("Workspace access must not publish a viewer");
    },
  });
  return { host, factory };
}

/**
 * The Workspace a User's own authority opens, rather than a Bot's. The
 * shell and Turn paths open a Computer as the Bot, so this is the only shape
 * in which a `user` writer is admitted.
 */
function openUserWorkspace(
  botId = BOT,
  disk = new FakeWorkspaceDisk(),
  generations: WorkspaceGenerationsV1 | "none" = ledger(),
) {
  const injected = generations === "none" ? undefined : generations;
  const { host, factory } = hostFor(disk);
  const computer = new FlySpriteComputer({
    identity: { userId: "workspace-user" },
    host: factory,
    spriteName: "frockbot-test",
  }).bot(botId);
  return {
    disk,
    host,
    generations: injected,
    workspace: new FlyComputerWorkspace(FLY_WORKSPACE_LAYOUT, {
      computer,
      userId: USER,
      botId,
      botDirectoryKey: computerBotKey,
      userAuthority: true,
      ...(injected ? { generations: injected } : {}),
    }),
  };
}

/**
 * The Durable Object's generation ledger, in memory. The Computer's Workspace
 * can attribute nothing without one — a sidecar on the Computer is a hint, and
 * the ledger is the authority — so every handle a Turn opens carries it.
 */
function ledger(): WorkspaceGenerationsV1 {
  return createInMemoryWorkspaceGenerationsV1();
}

/** A sync host over one in-memory bucket, sharing the ledger with the handle. */
function syncHostFor(generations: WorkspaceGenerationsV1) {
  return {
    store: createObjectWorkspaceFilesV1({
      bucket: createInMemoryObjectBucketV1(),
      generations,
      owner: { userId: USER },
      surface: "sync" as const,
    }),
    generations,
  };
}

async function openWorkspace(
  botId = BOT,
  disk = new FakeWorkspaceDisk(),
  generations: WorkspaceGenerationsV1 | "none" = ledger(),
) {
  const injected = generations === "none" ? undefined : generations;
  const { host, factory } = hostFor(disk);
  const provider = new FlySpriteComputerProvider(
    new FlySpriteComputer({
      identity: { userId: "workspace-user" },
      host: factory,
      spriteName: "frockbot-test",
    }),
    factory,
    injected ? syncHostFor(injected) : undefined,
  );
  const computer = await provider.open(
    { userId: USER },
    { botId },
    { providerId: "fly-sprite", generation: 1 },
  );
  const workspace = computer.workspace;
  if (!workspace) throw new Error("The Fly provider must expose a Workspace");
  return { disk, host, workspace, computer, generations: injected };
}

describe("Fly Workspace layout", () => {
  // Constitution — Computer and Workspace: "durable roots, declared by the
  // Computer Package's Workspace layout"; ADR 0013: the Workspace presents
  // Memory roots read-only.
  test("declares instruction, Memory, and Package roots, with Memory and the User-global instruction root read-only", () => {
    expect(FLY_WORKSPACE_LAYOUT.home).toBe("/home/box");
    expect(
      Object.fromEntries(
        FLY_WORKSPACE_LAYOUT.roots.map((root) => [
          root.kind,
          [root.mountPath, root.access, root.scope],
        ]),
      ),
    ).toEqual({
      "bot-instructions": [
        "/home/box/agent-data/agents/{bot}/skills",
        "read-write",
        "bot",
      ],
      // GrokBot's `agent-data/workflows`, read-only on the Computer because
      // the Skills Package writes it through object storage (ADR 0016).
      "user-instructions": [
        "/home/box/agent-data/workflows",
        "read-only",
        "user",
      ],
      "bot-memory": [
        "/home/box/agent-data/agents/{bot}/memory",
        "read-only",
        "bot",
      ],
      "user-memory": ["/home/box/agent-data/user-memory", "read-only", "user"],
      "package-declared": [
        "/home/box/agent-data/user-packages/{package}/{root}",
        "read-write",
        "user",
      ],
    });
  });
});

describe("Fly Workspace files", () => {
  // Constitution — Computer and Workspace: "every write to a durable root
  // records its writer."
  test("records the writer of every durable-root write and answers with the generation", async () => {
    const { workspace } = await openWorkspace();

    const written = await workspace.write({
      path: { root: skillsRoot, path: "deploy/SKILL.md" },
      bytes: new TextEncoder().encode("# deploy"),
      writer: BOT_WRITER,
      expectedGenerationId: null,
    });

    expect(written).toMatchObject({ status: "ok" });
    if (written.status !== "ok") throw new Error(written.reason);
    expect(written.generation).toMatchObject({
      schemaVersion: 1,
      contentHash: sha256(new TextEncoder().encode("# deploy")),
      size: 8,
      writer: BOT_WRITER,
    });

    const stat = await workspace.stat({
      root: skillsRoot,
      path: "deploy/SKILL.md",
    });
    expect(stat).toMatchObject({
      status: "ok",
      entry: { generation: { writer: BOT_WRITER } },
    });
    const read = await workspace.read({
      root: skillsRoot,
      path: "deploy/SKILL.md",
    });
    if (read.status !== "ok") throw new Error(read.reason);
    expect(new TextDecoder().decode(read.file.bytes)).toBe("# deploy");
    expect(read.file.generation.generationId).toBe(
      written.generation.generationId,
    );
  });

  // Constitution — Memory: "the Workspace presents Memory roots read-only".
  test("refuses a write to either Memory root through the kernel-consumed surface", async () => {
    const { workspace } = await openWorkspace();

    for (const root of [botMemoryRoot, userMemoryRoot]) {
      expect(
        await workspace.write({
          path: { root, path: "profile.md" },
          bytes: new TextEncoder().encode("fact"),
          writer: BOT_WRITER,
          expectedGenerationId: null,
        }),
      ).toMatchObject({ status: "refused" });
      expect(
        await workspace.delete({
          path: { root, path: "profile.md" },
          writer: BOT_WRITER,
          expectedGenerationId: "whatever",
        }),
      ).toMatchObject({ status: "refused" });
    }
  });

  // A Memory root the sync materialized is readable through the kernel
  // surface: read-only, not invisible.
  test("reads a Memory root the sync materialized, and refuses to write it", async () => {
    const { disk, workspace } = await openWorkspace();
    disk.files.set(
      `/home/box/agent-data/agents/${computerBotKey(BOT)}/memory/profile.md`,
      { bytes: new TextEncoder().encode("fact") },
    );

    expect(
      await workspace.read({ root: botMemoryRoot, path: "profile.md" }),
    ).toMatchObject({ status: "ok" });
    expect(
      await workspace.write({
        path: { root: botMemoryRoot, path: "profile.md" },
        bytes: new TextEncoder().encode("other"),
        writer: BOT_WRITER,
        expectedGenerationId: null,
      }),
    ).toMatchObject({ status: "refused" });
  });

  // Constitution — Computer and Workspace: "a Bot's instruction root and Bot
  // Memory root are writable only by that Bot or its User."
  test("refuses a write to another Bot's instruction root and a first-party writer", async () => {
    const { workspace } = await openWorkspace();

    expect(
      await workspace.write({
        path: { root: otherSkillsRoot, path: "SKILL.md" },
        bytes: new TextEncoder().encode("x"),
        writer: BOT_WRITER,
        expectedGenerationId: null,
      }),
    ).toMatchObject({ status: "refused" });
    expect(
      await workspace.write({
        path: { root: skillsRoot, path: "SKILL.md" },
        bytes: new TextEncoder().encode("x"),
        writer: PACKAGE_WRITER,
        expectedGenerationId: null,
      }),
    ).toMatchObject({ status: "refused" });
    // The Bot's User may write it — from a handle the User opened.
    expect(
      await openUserWorkspace().workspace.write({
        path: { root: skillsRoot, path: "SKILL.md" },
        bytes: new TextEncoder().encode("x"),
        writer: USER_WRITER,
        expectedGenerationId: null,
      }),
    ).toMatchObject({ status: "ok" });
  });

  // Constitution — Computer and Workspace: "every write to a durable root
  // records its writer." The writer a request names is a claim; the handle's
  // tenant is the authority on it, or a Bot could record another Bot as the
  // writer of a file and a Package root would accept it.
  test("refuses a write naming a Bot that is not the handle's tenant", async () => {
    const { workspace } = await openWorkspace();
    const otherBotWriter: WorkspaceWriterV1 = {
      ...BOT_WRITER,
      botId: OTHER_BOT,
    };

    expect(
      await workspace.write({
        path: { root: otherSkillsRoot, path: "SKILL.md" },
        bytes: new TextEncoder().encode("x"),
        writer: otherBotWriter,
        expectedGenerationId: null,
      }),
    ).toMatchObject({ status: "refused" });
    expect(
      await workspace.write({
        path: { root: packageRoot, path: "shared.md" },
        bytes: new TextEncoder().encode("x"),
        writer: otherBotWriter,
        expectedGenerationId: null,
      }),
    ).toMatchObject({ status: "refused" });
  });

  // "Only Skills under the Bot's own instruction root, written under the Bot's
  // own authority or its User's, are loaded as instructions." A Bot that could
  // name its User as the writer would author itself a loadable Skill under an
  // authority it does not hold.
  test("refuses a user writer from a handle opened for a Bot", async () => {
    const { workspace } = await openWorkspace();

    expect(
      await workspace.write({
        path: { root: skillsRoot, path: "SKILL.md" },
        bytes: new TextEncoder().encode("x"),
        writer: USER_WRITER,
        expectedGenerationId: null,
      }),
    ).toMatchObject({ status: "refused" });
    expect(
      await workspace.delete({
        path: { root: skillsRoot, path: "SKILL.md" },
        writer: USER_WRITER,
        expectedGenerationId: "whatever",
      }),
    ).toMatchObject({ status: "refused" });
    // A User handle for a different User is refused by the root check too.
    expect(
      await openUserWorkspace().workspace.write({
        path: { root: skillsRoot, path: "SKILL.md" },
        bytes: new TextEncoder().encode("x"),
        writer: { kind: "user", userId: "someone-else" },
        expectedGenerationId: null,
      }),
    ).toMatchObject({ status: "refused" });
  });

  // ADR 0012: "Bots of one User may read each other's Workspace files" —
  // separation between tenants is organizational, not a security boundary.
  test("a Bot reads another Bot of the same User's Workspace file", async () => {
    const disk = new FakeWorkspaceDisk();
    const owner = await openWorkspace(OTHER_BOT, disk);
    await owner.workspace.write({
      path: { root: otherSkillsRoot, path: "notes.md" },
      bytes: new TextEncoder().encode("shared"),
      writer: { ...BOT_WRITER, botId: OTHER_BOT },
      expectedGenerationId: null,
    });

    const reader = await openWorkspace(BOT, disk);
    const read = await reader.workspace.read({
      root: otherSkillsRoot,
      path: "notes.md",
    });

    if (read.status !== "ok") throw new Error(read.reason);
    expect(new TextDecoder().decode(read.file.bytes)).toBe("shared");
  });

  test("refuses every root belonging to another User", async () => {
    const { workspace } = await openWorkspace();

    expect(
      await workspace.read({
        root: { kind: "user-memory", userId: "someone-else" },
        path: "profile.md",
      }),
    ).toMatchObject({ status: "refused" });
  });

  // ADR 0013: a write that would overwrite a generation its writer has not
  // seen is never silently merged.
  test("answers conflict when the expected generation is not the current one", async () => {
    const { workspace } = await openWorkspace();
    const first = await workspace.write({
      path: { root: packageRoot, path: "a.md" },
      bytes: new TextEncoder().encode("one"),
      writer: BOT_WRITER,
      expectedGenerationId: null,
    });
    if (first.status !== "ok") throw new Error(first.reason);

    expect(
      await workspace.write({
        path: { root: packageRoot, path: "a.md" },
        bytes: new TextEncoder().encode("two"),
        writer: BOT_WRITER,
        expectedGenerationId: null,
      }),
    ).toMatchObject({ status: "conflict" });
    expect(
      await workspace.write({
        path: { root: packageRoot, path: "a.md" },
        bytes: new TextEncoder().encode("two"),
        writer: BOT_WRITER,
        expectedGenerationId: first.generation.generationId,
      }),
    ).toMatchObject({ status: "ok" });
  });

  test("bounds a write at the contract's file size and refuses a traversal path", async () => {
    const { workspace } = await openWorkspace();

    expect(
      await workspace.write({
        path: { root: packageRoot, path: "big.bin" },
        bytes: new Uint8Array(WORKSPACE_MAX_FILE_BYTES + 1),
        writer: BOT_WRITER,
        expectedGenerationId: null,
      }),
    ).toMatchObject({ status: "refused" });
    expect(
      await workspace.read({ root: packageRoot, path: "../escape" }),
    ).toMatchObject({ status: "refused" });
  });

  test("lists a root by page and bounds a page at the contract limit", async () => {
    const { host, workspace } = await openWorkspace();
    for (let index = 0; index < 5; index += 1) {
      await workspace.write({
        path: { root: packageRoot, path: `note-${index}.md` },
        bytes: new TextEncoder().encode(String(index)),
        writer: BOT_WRITER,
        expectedGenerationId: null,
      });
    }

    const page = await workspace.list({ root: packageRoot, limit: 2 });
    if (page.status !== "ok") throw new Error(page.reason);
    expect(page.entries.map((entry) => entry.path.path)).toEqual([
      "note-0.md",
      "note-1.md",
    ]);
    expect(page.cursor).toBe("2");
    expect(page.entries[0]?.generation.writer).toEqual(BOT_WRITER);

    const rest = await workspace.list({
      root: packageRoot,
      cursor: page.cursor,
      limit: 10,
    });
    if (rest.status !== "ok") throw new Error(rest.reason);
    expect(rest.entries).toHaveLength(3);
    expect(rest.cursor).toBeUndefined();

    await workspace.list({ root: packageRoot, limit: 10_000 });
    expect(host.scripts.at(-1)).toContain(
      `LIMIT=${WORKSPACE_MAX_LIST_ENTRIES}`,
    );
  });

  test("deletes with a tombstone generation and then answers not-found", async () => {
    const { workspace } = await openWorkspace();
    const written = await workspace.write({
      path: { root: packageRoot, path: "gone.md" },
      bytes: new TextEncoder().encode("bye"),
      writer: BOT_WRITER,
      expectedGenerationId: null,
    });
    if (written.status !== "ok") throw new Error(written.reason);

    const removed = await workspace.delete({
      path: { root: packageRoot, path: "gone.md" },
      writer: BOT_WRITER,
      expectedGenerationId: written.generation.generationId,
    });

    expect(removed).toMatchObject({ status: "ok" });
    if (removed.status !== "ok") throw new Error(removed.reason);
    expect(removed.generation.size).toBe(0);
    expect(removed.generation.writer).toEqual(BOT_WRITER);
    expect(
      await workspace.read({ root: packageRoot, path: "gone.md" }),
    ).toMatchObject({ status: "not-found" });
    expect(
      await workspace.delete({
        path: { root: packageRoot, path: "gone.md" },
        writer: BOT_WRITER,
        expectedGenerationId: written.generation.generationId,
      }),
    ).toMatchObject({ status: "not-found" });
  });

  // A file written by ordinary shell work went around this surface, so no
  // sidecar records who wrote it. It is `unattributed` — not the User, not a
  // Bot — so it is readable data and never loadable as a Skill.
  test("attributes a file with no recorded writer as unattributed", async () => {
    const { disk, workspace } = await openWorkspace();
    disk.files.set(
      `/home/box/agent-data/agents/${computerBotKey(BOT)}/skills/by-shell.md`,
      { bytes: new TextEncoder().encode("hand-written") },
    );

    const stat = await workspace.stat({
      root: skillsRoot,
      path: "by-shell.md",
    });

    if (stat.status !== "ok") throw new Error(stat.reason);
    expect(stat.entry.generation.writer).toEqual({ kind: "unattributed" });

    const listed = await workspace.list({ root: skillsRoot });
    if (listed.status !== "ok") throw new Error(listed.reason);
    expect(
      listed.entries.find((entry) => entry.path.path === "by-shell.md")
        ?.generation.writer,
    ).toEqual({ kind: "unattributed" });
  });

  // A sidecar is an ordinary file beside the bytes it describes, so a shell can
  // overwrite the bytes and leave the sidecar standing — or plant a sidecar of
  // its own. The recorded content address is what such a write cannot forge
  // without producing the bytes, so a sidecar that does not describe the file
  // is stale or invented and the file is `unattributed`: the previous writer's
  // authority does not survive a write that went around this surface.
  test("answers unattributed when the sidecar does not describe the bytes", async () => {
    const { disk, workspace } = await openWorkspace();
    const path = `/home/box/agent-data/agents/${computerBotKey(BOT)}/skills/deploy/SKILL.md`;
    const written = await workspace.write({
      path: { root: skillsRoot, path: "deploy/SKILL.md" },
      bytes: new TextEncoder().encode("---\nname: deploy\n---\n"),
      writer: BOT_WRITER,
      expectedGenerationId: null,
    });
    if (written.status !== "ok") throw new Error(written.reason);
    const before = await workspace.stat({
      root: skillsRoot,
      path: "deploy/SKILL.md",
    });
    if (before.status !== "ok") throw new Error(before.reason);
    expect(before.entry.generation.writer).toEqual(BOT_WRITER);

    // A shell overwrites the file. The sidecar the surface wrote stays put.
    const kept = disk.files.get(path);
    disk.files.set(path, {
      bytes: new TextEncoder().encode("---\nname: deploy\n---\nrm -rf /\n"),
      ...(kept?.meta ? { meta: kept.meta } : {}),
    });

    const stat = await workspace.stat({
      root: skillsRoot,
      path: "deploy/SKILL.md",
    });

    if (stat.status !== "ok") throw new Error(stat.reason);
    expect(stat.entry.generation.writer).toEqual({ kind: "unattributed" });
    expect(
      isLoadableSkillSourceV1(
        {
          path: { root: skillsRoot, path: "deploy/SKILL.md" },
          writer: stat.entry.generation.writer,
          generation: stat.entry.generation,
        },
        { botId: BOT, userId: USER },
      ),
    ).toBe(false);
    // The listing answers the same way, and so does a read of the bytes.
    const listed = await workspace.list({ root: skillsRoot });
    if (listed.status !== "ok") throw new Error(listed.reason);
    expect(
      listed.entries.find((entry) => entry.path.path === "deploy/SKILL.md")
        ?.generation.writer,
    ).toEqual({ kind: "unattributed" });
    const read = await workspace.read({
      root: skillsRoot,
      path: "deploy/SKILL.md",
    });
    if (read.status !== "ok") throw new Error(read.reason);
    expect(read.file.generation.writer).toEqual({ kind: "unattributed" });
  });

  // A sidecar that does not decode at this seam is no sidecar at all.
  test("answers unattributed when the sidecar does not decode", async () => {
    const { disk, workspace } = await openWorkspace();
    disk.files.set(
      `/home/box/agent-data/agents/${computerBotKey(BOT)}/skills/planted.md`,
      {
        bytes: new TextEncoder().encode("body"),
        meta: Buffer.from(
          `forged\n${JSON.stringify({ writer: { kind: "user", userId: USER } })}`,
        ).toString("base64"),
      },
    );

    const stat = await workspace.stat({ root: skillsRoot, path: "planted.md" });

    if (stat.status !== "ok") throw new Error(stat.reason);
    expect(stat.entry.generation.writer).toEqual({ kind: "unattributed" });
  });

  // "every write to a durable root records its writer": `unattributed` is an
  // answer about a file nobody recorded, never a writer a caller may present.
  test("refuses a write or a delete that names an unattributed writer", async () => {
    const { workspace } = await openWorkspace();

    expect(
      await workspace.write({
        path: { root: skillsRoot, path: "SKILL.md" },
        bytes: new TextEncoder().encode("body"),
        writer: { kind: "unattributed" },
        expectedGenerationId: null,
      }),
    ).toMatchObject({ status: "refused" });
    expect(
      await workspace.delete({
        path: { root: packageRoot, path: "a.md" },
        writer: { kind: "unattributed" },
        expectedGenerationId: "whatever",
      }),
    ).toMatchObject({ status: "refused" });
  });

  // Constitution — Computer and Workspace: connections drop on every pause, so
  // "unavailable" is an ordinary answer, not an exception.
  test("answers unavailable rather than throwing when the Sprite is paused", async () => {
    const { disk, workspace } = await openWorkspace();
    disk.offline = true;

    expect(
      await workspace.read({ root: packageRoot, path: "a.md" }),
    ).toMatchObject({ status: "unavailable" });
    expect(await workspace.list({ root: packageRoot })).toMatchObject({
      status: "unavailable",
    });
    expect(
      await workspace.write({
        path: { root: packageRoot, path: "a.md" },
        bytes: new Uint8Array(1),
        writer: BOT_WRITER,
        expectedGenerationId: null,
      }),
    ).toMatchObject({ status: "unavailable" });
  });
});

describe("the Computer's sidecar is a hint; the Durable Object is the authority", () => {
  const SKILLS_MOUNT = `/home/box/agent-data/agents/${computerBotKey(BOT)}/skills`;

  /** What a shell on the Computer can write: bytes, and a sidecar for them. */
  function plant(
    disk: FakeWorkspaceDisk,
    relative: string,
    text: string,
    generation: {
      generationId: string;
      writer: WorkspaceWriterV1;
      writtenAt?: string;
    },
  ): void {
    const bytes = new TextEncoder().encode(text);
    const meta = {
      schemaVersion: 1,
      generationId: generation.generationId,
      // The forger has the bytes, so it has their hash too.
      contentHash: sha256(bytes),
      size: bytes.byteLength,
      writer: generation.writer,
      writtenAt: generation.writtenAt ?? new Date(0).toISOString(),
    };
    disk.files.set(`${SKILLS_MOUNT}/${relative}`, {
      bytes,
      meta: Buffer.from(
        `${meta.generationId}\n${JSON.stringify(meta)}`,
      ).toString("base64"),
    });
  }

  test("a forged sidecar whose hash matches the bytes is still unattributed", async () => {
    const { disk, workspace } = await openWorkspace();
    // A shell writes the file *and* a perfectly-formed sidecar claiming the
    // Bot itself wrote it. Nothing about the bytes is wrong; only the ledger
    // can tell, and it never recorded this generation.
    plant(disk, "forged/SKILL.md", "# Forged", {
      generationId: "000001700000000000-000001",
      writer: BOT_WRITER,
    });

    const stat = await workspace.stat({
      root: skillsRoot,
      path: "forged/SKILL.md",
    });
    if (stat.status !== "ok") throw new Error(stat.reason);
    expect(stat.entry.generation.writer).toEqual({ kind: "unattributed" });
    expect(
      isLoadableSkillSourceV1(
        {
          path: stat.entry.path,
          writer: stat.entry.generation.writer,
          generation: stat.entry.generation,
        },
        { userId: USER, botId: BOT },
      ),
    ).toBe(false);
    const listed = await workspace.list({ root: skillsRoot });
    if (listed.status !== "ok") throw new Error(listed.reason);
    expect(listed.entries[0]?.generation.writer).toEqual({
      kind: "unattributed",
    });
  });

  test("a write through the surface is attributed, because the ledger holds it", async () => {
    const { disk, workspace, generations } = await openWorkspace();
    const written = await workspace.write({
      path: { root: skillsRoot, path: "authored/SKILL.md" },
      bytes: new TextEncoder().encode("# Authored"),
      writer: BOT_WRITER,
      expectedGenerationId: null,
    });
    if (written.status !== "ok") throw new Error(written.reason);

    const recorded = await generations?.current(
      skillsRoot,
      "authored/SKILL.md",
    );
    expect(recorded?.generation.generationId).toBe(
      written.generation.generationId,
    );
    const read = await workspace.read({
      root: skillsRoot,
      path: "authored/SKILL.md",
    });
    if (read.status !== "ok") throw new Error(read.reason);
    expect(read.file.generation.writer).toEqual(BOT_WRITER);

    // And a shell overwriting those bytes takes the attribution with it: the
    // record the ledger holds no longer describes what is on disk, and a
    // sidecar re-forged over the new bytes names a generation the ledger
    // never minted.
    plant(disk, "authored/SKILL.md", "# Overwritten", {
      generationId: written.generation.generationId,
      writer: BOT_WRITER,
    });
    const after = await workspace.read({
      root: skillsRoot,
      path: "authored/SKILL.md",
    });
    if (after.status !== "ok") throw new Error(after.reason);
    expect(after.file.generation.writer).toEqual({ kind: "unattributed" });
  });

  test("with no ledger injected, every file is unattributed", async () => {
    const disk = new FakeWorkspaceDisk();
    const { workspace } = openUserWorkspace(BOT, disk, "none");
    const written = await workspace.write({
      path: { root: skillsRoot, path: "local/SKILL.md" },
      bytes: new TextEncoder().encode("# Local"),
      writer: USER_WRITER,
      expectedGenerationId: null,
    });
    if (written.status !== "ok") throw new Error(written.reason);

    const read = await workspace.read({
      root: skillsRoot,
      path: "local/SKILL.md",
    });
    if (read.status !== "ok") throw new Error(read.reason);
    expect(read.file.generation.writer).toEqual({ kind: "unattributed" });
  });
});
