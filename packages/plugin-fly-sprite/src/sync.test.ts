/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  isLoadableSkillSourceV1,
  type WorkspaceFilesV1,
  type WorkspaceSyncEffectV1,
  type WorkspaceSyncEffectsV1,
  type WorkspaceGenerationV1,
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
  FlySpriteComputer,
  WORKSPACE_SYNC_SERVICE,
  type SpriteHandle,
  type SpriteServiceStream,
  type SpritesClientHandle,
} from "./computer.ts";
import { FLY_WORKSPACE_LAYOUT, FlySpriteComputerProvider } from "./provider.ts";
import {
  createFlySpriteSyncV1,
  declaredWorkspaceRootsV1,
  type WorkspaceSyncReportV1,
} from "./sync.ts";
import { WORKSPACE_EMPTY_SHA256 } from "./workspace.ts";

const USER = "owner";
const BOT = "health";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const skillsRoot: WorkspaceRootV1 = {
  kind: "bot-instructions",
  userId: USER,
  botId: BOT,
};
const botMemoryRoot: WorkspaceRootV1 = {
  kind: "bot-memory",
  userId: USER,
  botId: BOT,
};
const userMemoryRoot: WorkspaceRootV1 = { kind: "user-memory", userId: USER };

const BOT_WRITER: WorkspaceWriterV1 = {
  kind: "bot",
  botId: BOT,
  sessionId: "session-1",
  turnId: "turn-1",
  runId: "run-1",
};
const USER_WRITER: WorkspaceWriterV1 = { kind: "user", userId: USER };

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function quoted(shell: string, name: string): string | undefined {
  return new RegExp(`${name}='([^']*)'`).exec(shell)?.[1];
}

function payload(shell: string, target: string): string | undefined {
  return new RegExp(`printf %s '([^']*)' \\| base64 -d > "\\$${target}"`).exec(
    shell,
  )?.[1];
}

/**
 * A Sprite whose durable filesystem is an in-memory map, interpreting the
 * shell the sync emits rather than running it — the scripts are GNU coreutils
 * and the test host is not. Every path the sync touches is an absolute path in
 * `files`, exactly as it would be on the Sprite.
 */
class FakeSyncSprite implements SpriteHandle {
  name = "frockbot-test";
  url = "https://frockbot-test-123.sprites.app/";
  readonly files = new Map<string, Uint8Array>();
  readonly services: string[] = [];
  /** Set to fail every storage call, as a paused Sprite does. */
  paused = false;
  /** Drops the next sidecar write, as a pause between store and Computer does. */
  dropNextMaterialize = false;

  execFileHTTP(
    file: string,
    args: string[] = [],
  ): Promise<{ stdout: string; stderr: string }> {
    if (this.paused) return Promise.reject(new Error("Sprite is paused"));
    if (file !== "bash") return Promise.resolve({ stdout: "", stderr: "" });
    const shell = args.at(-1) ?? "";
    return Promise.resolve({ stdout: this.interpret(shell), stderr: "" });
  }

  createService(name: string): Promise<SpriteServiceStream> {
    this.services.push(name);
    return Promise.resolve({
      async *[Symbol.asyncIterator]() {
        yield { type: "started" };
      },
    });
  }

  updateURLSettings(): Promise<void> {
    return Promise.resolve();
  }

  /** Writes a file the way a shell command on the Computer would: no sidecar. */
  shellWrite(root: string, relative: string, text: string): void {
    this.files.set(`${root}/${relative}`, encoder.encode(text));
  }

  shellRemove(root: string, relative: string): void {
    this.files.delete(`${root}/${relative}`);
  }

  text(path: string): string | undefined {
    const bytes = this.files.get(path);
    return bytes ? decoder.decode(bytes) : undefined;
  }

  keys(prefix = ""): string[] {
    return [...this.files.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort();
  }

  private interpret(shell: string): string {
    const root = quoted(shell, "ROOT");
    const relative = quoted(shell, "REL");
    if (shell.includes('printf "F\\t')) return this.scan(root ?? "");
    if (root && relative) {
      if (shell.includes("__SYNCED__")) {
        if (this.dropNextMaterialize) {
          this.dropNextMaterialize = false;
          return "";
        }
        return this.materialize(root, relative, shell);
      }
      if (shell.includes("__REMOVED__"))
        return this.remove(root, relative, shell);
      if (shell.includes("__FORGOTTEN__")) return this.forget(root, relative);
      if (shell.includes("__PRESERVED__"))
        return this.preserve(root, relative, shell);
      return this.read(`${root}/${relative}`);
    }
    const note = quoted(shell, "NOTE");
    if (note) {
      if (shell.includes("__NOTED__")) {
        const bytes = payload(shell, "NOTE") ?? "";
        this.files.set(note, Uint8Array.from(Buffer.from(bytes, "base64")));
        return "__NOTED__\n";
      }
      if (shell.includes("__CLEARED__")) {
        this.files.delete(note);
        return "__CLEARED__\n";
      }
      return this.read(note);
    }
    const signal = quoted(shell, "SIGNAL");
    if (signal) return this.read(signal, false);
    return "";
  }

  private read(path: string, base64 = true): string {
    const bytes = this.files.get(path);
    if (!bytes) return "__MISSING__\n";
    return base64
      ? `${Buffer.from(bytes).toString("base64")}\n`
      : `${decoder.decode(bytes)}\n`;
  }

  private scan(root: string): string {
    const rows: string[] = [];
    const generations = `${root}/.frockbot-generations/`;
    const graves = `${root}/.frockbot-sync/tombstones/`;
    for (const [path, bytes] of [...this.files].sort()) {
      if (!path.startsWith(`${root}/`)) continue;
      const relative = path.slice(root.length + 1);
      if (relative.startsWith(".frockbot-")) continue;
      const meta = this.files.get(`${generations}${relative}`);
      rows.push(
        [
          "F",
          Buffer.from(relative).toString("base64"),
          meta ? Buffer.from(meta).toString("base64") : "",
          sha256(bytes),
          String(bytes.byteLength),
        ].join("\t"),
      );
    }
    for (const [path, bytes] of [...this.files].sort()) {
      if (path.startsWith(graves)) {
        rows.push(
          [
            "T",
            Buffer.from(path.slice(graves.length)).toString("base64"),
            Buffer.from(bytes).toString("base64"),
          ].join("\t"),
        );
        continue;
      }
      if (!path.startsWith(generations)) continue;
      const relative = path.slice(generations.length);
      if (this.files.has(`${root}/${relative}`)) continue;
      rows.push(
        [
          "S",
          Buffer.from(relative).toString("base64"),
          Buffer.from(bytes).toString("base64"),
        ].join("\t"),
      );
    }
    return rows.length ? `${rows.join("\n")}\n` : "";
  }

  private materialize(root: string, relative: string, shell: string): string {
    const bytes = payload(shell, "TMP") ?? "";
    const meta = payload(shell, "MTMP") ?? "";
    this.files.set(
      `${root}/${relative}`,
      Uint8Array.from(Buffer.from(bytes, "base64")),
    );
    this.files.set(
      `${root}/.frockbot-generations/${relative}`,
      Uint8Array.from(Buffer.from(meta, "base64")),
    );
    this.files.delete(`${root}/.frockbot-sync/tombstones/${relative}`);
    return "__SYNCED__\n";
  }

  private remove(root: string, relative: string, shell: string): string {
    const record = payload(shell, "GTMP") ?? "";
    this.files.delete(`${root}/${relative}`);
    this.files.delete(`${root}/.frockbot-generations/${relative}`);
    this.files.set(
      `${root}/.frockbot-sync/tombstones/${relative}`,
      Uint8Array.from(Buffer.from(record, "base64")),
    );
    return "__REMOVED__\n";
  }

  private forget(root: string, relative: string): string {
    this.files.delete(`${root}/.frockbot-sync/tombstones/${relative}`);
    if (!this.files.has(`${root}/${relative}`)) {
      this.files.delete(`${root}/.frockbot-generations/${relative}`);
    }
    return "__FORGOTTEN__\n";
  }

  private preserve(root: string, relative: string, shell: string): string {
    const generationId =
      /conflicts\/\$REL\/([^"]*)"/.exec(shell)?.[1] ?? "unknown";
    const bytes = payload(shell, "KEPT") ?? "";
    this.files.set(
      `${root}/.frockbot-sync/conflicts/${relative}/${generationId}`,
      Uint8Array.from(Buffer.from(bytes, "base64")),
    );
    return "__PRESERVED__\n";
  }
}

class FakeClient implements SpritesClientHandle {
  constructor(readonly sprite: FakeSyncSprite) {}

  listAllSprites(): Promise<SpriteHandle[]> {
    return Promise.resolve([this.sprite]);
  }

  createSprite(): Promise<SpriteHandle> {
    return Promise.resolve(this.sprite);
  }

  getSprite(): Promise<SpriteHandle> {
    return Promise.resolve(this.sprite);
  }
}

const MOUNTS = {
  skills: `/home/box/agent-data/agents/${computerBotKey(BOT)}/skills`,
  botMemory: `/home/box/agent-data/agents/${computerBotKey(BOT)}/memory`,
  userMemory: "/home/box/agent-data/user-memory",
};

interface Harness {
  sprite: FakeSyncSprite;
  store: WorkspaceFilesV1;
  memory: WorkspaceFilesV1;
  generations: ReturnType<typeof createInMemoryWorkspaceGenerationsV1>;
  bucket: ReturnType<typeof createInMemoryObjectBucketV1>;
  sync: () => Promise<WorkspaceSyncReportV1>;
  agent: ReturnType<typeof createFlySpriteSyncV1>;
  roots: WorkspaceRootV1[];
}

function harness(
  options: {
    store?: (files: WorkspaceFilesV1) => WorkspaceFilesV1;
  } = {},
): Harness {
  const bucket = createInMemoryObjectBucketV1();
  const generations = createInMemoryWorkspaceGenerationsV1();
  const owner = { userId: USER };
  const store = createObjectWorkspaceFilesV1({
    bucket,
    generations,
    owner,
    surface: "sync",
  });
  const memory = createObjectWorkspaceFilesV1({
    bucket,
    generations,
    owner,
    surface: "memory",
  });
  const sprite = new FakeSyncSprite();
  const computer = new FlySpriteComputer({
    client: new FakeClient(sprite),
    spriteName: "frockbot-test",
  }).bot(BOT);
  const roots = declaredWorkspaceRootsV1(FLY_WORKSPACE_LAYOUT, {
    userId: USER,
    botIds: [BOT],
  });
  const agent = createFlySpriteSyncV1({
    computer,
    layout: FLY_WORKSPACE_LAYOUT,
    userId: USER,
    botDirectoryKey: computerBotKey,
    store: options.store ? options.store(store) : store,
    generations,
    roots,
  });
  return {
    sprite,
    store,
    memory,
    generations,
    bucket,
    roots,
    agent,
    sync: () => agent.sync(),
  };
}

/**
 * Removes a file the way the Workspace file surface's `delete` does — the file
 * and its sidecar gone, a tombstone record left behind whose first line is the
 * generation the removal superseded. A shell can write exactly this too, which
 * is the point of the tests that use it.
 */
function shellTombstone(
  sprite: FakeSyncSprite,
  mount: string,
  relative: string,
  supersedes: string,
  tombstone: WorkspaceGenerationV1,
): void {
  sprite.files.delete(`${mount}/${relative}`);
  sprite.files.delete(`${mount}/.frockbot-generations/${relative}`);
  sprite.files.set(
    `${mount}/.frockbot-sync/tombstones/${relative}`,
    encoder.encode(`${supersedes}\n${JSON.stringify(tombstone)}`),
  );
}

async function writeToStore(
  files: WorkspaceFilesV1,
  root: WorkspaceRootV1,
  path: string,
  text: string,
  writer: WorkspaceWriterV1,
  expected: string | null = null,
): Promise<WorkspaceGenerationV1> {
  const outcome = await files.write({
    path: { root, path },
    bytes: encoder.encode(text),
    writer,
    expectedGenerationId: expected,
  });
  if (outcome.status !== "ok") throw new Error(outcome.reason);
  return outcome.generation;
}

describe("the durable-root sync, store to Computer", () => {
  // Constitution — Computer and Workspace: "durable roots ... survive
  // hibernation, cold start, host migration, and image rebuild."
  test("a cold start with an empty disk repopulates every declared root", async () => {
    const { sprite, store, memory, sync, roots } = harness();

    await writeToStore(
      store,
      skillsRoot,
      "deploy/SKILL.md",
      "# deploy",
      BOT_WRITER,
    );
    await writeToStore(
      memory,
      botMemoryRoot,
      "profile.md",
      "likes tea",
      BOT_WRITER,
    );
    await writeToStore(
      memory,
      userMemoryRoot,
      `by-agent/${BOT}/profile.md`,
      "user fact",
      BOT_WRITER,
    );

    expect(sprite.files.size).toBe(0);
    const report = await sync();

    expect(report.failures).toEqual([]);
    expect(roots).toHaveLength(3);
    expect(sprite.text(`${MOUNTS.skills}/deploy/SKILL.md`)).toBe("# deploy");
    expect(sprite.text(`${MOUNTS.botMemory}/profile.md`)).toBe("likes tea");
    expect(sprite.text(`${MOUNTS.userMemory}/by-agent/${BOT}/profile.md`)).toBe(
      "user fact",
    );
    expect(report.roots.flatMap((entry) => entry.pulled)).toEqual([
      "deploy/SKILL.md",
      "profile.md",
      `by-agent/${BOT}/profile.md`,
    ]);

    // A second run with nothing changed moves nothing: the sidecar records the
    // generation, so "already here" is a comparison and not a re-download.
    const again = await sync();
    expect(again.roots.flatMap((entry) => entry.pulled)).toEqual([]);
  });

  // Constitution — Minimal kernel: "Only Skills under the Bot's own instruction
  // root, written under the Bot's own authority or its User's, are loaded as
  // instructions." A materialized Skill keeps the writer the store recorded,
  // so the loader's predicate can still answer.
  test("a Skill written through the store appears under the instruction root with its writer", async () => {
    const { sprite, store, sync } = harness();
    const generation = await writeToStore(
      store,
      skillsRoot,
      "deploy/SKILL.md",
      "---\nname: deploy\n---\n",
      BOT_WRITER,
    );

    await sync();

    const meta = sprite.text(
      `${MOUNTS.skills}/.frockbot-generations/deploy/SKILL.md`,
    );
    expect(meta?.split("\n")[0]).toBe(generation.generationId);
    const recorded = JSON.parse(
      meta?.slice(meta.indexOf("\n") + 1) ?? "{}",
    ) as WorkspaceGenerationV1;
    expect(recorded.writer).toEqual(BOT_WRITER);
    expect(
      isLoadableSkillSourceV1(
        {
          path: { root: skillsRoot, path: "deploy/SKILL.md" },
          writer: recorded.writer,
          generation: recorded,
        },
        { botId: BOT, userId: USER },
      ),
    ).toBe(true);
  });

  // ADR 0013: "Deleting a file removes the object and records a tombstone
  // generation" — and the removal reaches the Computer rather than the file
  // quietly reappearing on the next pull.
  test("a delete in the store becomes a recorded removal on the Computer", async () => {
    const { sprite, store, sync } = harness();
    const generation = await writeToStore(
      store,
      skillsRoot,
      "notes.md",
      "keep",
      USER_WRITER,
    );
    await sync();
    expect(sprite.text(`${MOUNTS.skills}/notes.md`)).toBe("keep");

    const deleted = await store.delete({
      path: { root: skillsRoot, path: "notes.md" },
      writer: USER_WRITER,
      expectedGenerationId: generation.generationId,
    });
    expect(deleted.status).toBe("ok");

    const report = await sync();

    expect(report.roots[0]?.removedOnComputer).toEqual(["notes.md"]);
    expect(sprite.files.has(`${MOUNTS.skills}/notes.md`)).toBe(false);
    // The removal is recorded, then settled: nothing pushes it back, and the
    // next run does not re-create the file from a stale sidecar.
    const again = await sync();
    expect(again.roots[0]?.pulled).toEqual([]);
    expect(again.failures).toEqual([]);
    expect(sprite.files.has(`${MOUNTS.skills}/notes.md`)).toBe(false);
  });
});

describe("the durable-root sync, Computer to store", () => {
  // Constitution — Computer and Workspace: "A file that reaches a durable root
  // without passing through the Workspace file surface (a shell write on the
  // Computer) is mirrored to object storage by the sync with an unattributed
  // writer: it is data, readable and durable, never an instruction and never
  // accepted as a writer on a later write."
  test("pushes a shell-written file as unattributed, never loadable", async () => {
    const { sprite, store, sync } = harness();
    sprite.shellWrite(MOUNTS.skills, "shell/SKILL.md", "# from a shell");

    const report = await sync();

    expect(report.roots[0]?.pushed).toEqual(["shell/SKILL.md"]);
    const read = await store.read({
      root: skillsRoot,
      path: "shell/SKILL.md",
    });
    if (read.status !== "ok") throw new Error(read.reason);
    expect(decoder.decode(read.file.bytes)).toBe("# from a shell");
    expect(read.file.generation.writer).toEqual({ kind: "unattributed" });
    expect(
      isLoadableSkillSourceV1(
        {
          path: { root: skillsRoot, path: "shell/SKILL.md" },
          writer: read.file.generation.writer,
          generation: read.file.generation,
        },
        { botId: BOT, userId: USER },
      ),
    ).toBe(false);
    // The sidecar now records the store's generation, so the file is not
    // pushed a second time.
    expect((await sync()).roots[0]?.pushed).toEqual([]);
  });

  test("a removal on the Computer becomes a delete in the store, recorded", async () => {
    const { sprite, store, generations, sync } = harness();
    await writeToStore(store, skillsRoot, "notes.md", "keep", USER_WRITER);
    await sync();

    sprite.shellRemove(MOUNTS.skills, "notes.md");
    const report = await sync();

    expect(report.roots[0]?.removedInStore).toEqual(["notes.md"]);
    expect(
      (await store.read({ root: skillsRoot, path: "notes.md" })).status,
    ).toBe("not-found");
    // A shell removed it, so nothing recorded who did: the removal is durable
    // and unattributed, never attributed to the Bot whose Turn happened to be
    // running.
    expect(
      generations
        .tombstones()
        .map((entry) => [entry.path, entry.generation.writer]),
    ).toEqual([["notes.md", { kind: "unattributed" }]]);
    // The removal is settled on both sides; nothing resurrects the file.
    expect((await sync()).failures).toEqual([]);
    expect(sprite.files.has(`${MOUNTS.skills}/notes.md`)).toBe(false);
  });

  // A tombstone lives in an ordinary directory on the Computer, so a shell can
  // write one naming any writer it likes, copying the superseded generation id
  // out of the sidecar beside it. A removal therefore reaches the store with no
  // writer at all — the constitution's answer for anything that did not pass
  // through the Workspace file surface — and only on a non-Memory root.
  test("pushes a Computer-side tombstone's removal as an unattributed delete", async () => {
    const { sprite, store, generations, sync } = harness();
    const generation = await writeToStore(
      store,
      skillsRoot,
      "notes.md",
      "keep",
      BOT_WRITER,
    );
    await sync();

    // The record a shell can write, and the record the Workspace file surface
    // writes, are the same bytes in the same place; this is both.
    shellTombstone(sprite, MOUNTS.skills, "notes.md", generation.generationId, {
      schemaVersion: 1,
      generationId: `${generation.generationId}-tombstone`,
      contentHash: WORKSPACE_EMPTY_SHA256,
      size: 0,
      writer: USER_WRITER,
      writtenAt: new Date(1_700_000_000_000).toISOString(),
    });
    const report = await sync();

    expect(report.roots[0]?.removedInStore).toEqual(["notes.md"]);
    expect(
      generations
        .tombstones()
        .map((entry) => [entry.path, entry.generation.writer]),
    ).toEqual([["notes.md", { kind: "unattributed" }]]);
  });

  // The generation the tombstone names is still load-bearing: it is the
  // conditional delete's precondition, so a removal the store has moved past is
  // refused and surfaced rather than applied.
  test("refuses a removal that supersedes a generation the store no longer holds", async () => {
    const { sprite, store, sync } = harness();
    const generation = await writeToStore(
      store,
      skillsRoot,
      "notes.md",
      "keep",
      BOT_WRITER,
    );
    await sync();

    shellTombstone(sprite, MOUNTS.skills, "notes.md", "1700000000000-forged", {
      schemaVersion: 1,
      generationId: "1700000000000-forged",
      contentHash: WORKSPACE_EMPTY_SHA256,
      size: 0,
      writer: USER_WRITER,
      writtenAt: new Date(1_700_000_000_000).toISOString(),
    });
    const report = await sync();

    expect(report.roots[0]?.removedInStore).toEqual([]);
    expect(report.conflicts.map((entry) => entry.path)).toEqual(["notes.md"]);
    const read = await store.read({ root: skillsRoot, path: "notes.md" });
    if (read.status !== "ok") throw new Error(read.reason);
    expect(read.file.generation.generationId).toBe(generation.generationId);
    // The file the store still holds is restored on the Computer.
    expect(sprite.text(`${MOUNTS.skills}/notes.md`)).toBe("keep");
  });
});

describe("the durable-root sync, conflicts", () => {
  // Constitution — Memory: "a write that would overwrite a generation its
  // writer has not seen is preserved as a conflicting generation and surfaced,
  // never merged or dropped"; ADR 0013 requires this proven before it ships.
  test("a Computer write and a store write to one path both survive, one as a surfaced conflict", async () => {
    const { sprite, store, generations, bucket, sync } = harness();
    const first = await writeToStore(
      store,
      skillsRoot,
      "notes.md",
      "original",
      USER_WRITER,
    );
    await sync();

    // Both sides move, neither having seen the other.
    sprite.shellWrite(MOUNTS.skills, "notes.md", "computer edit");
    const winner = await writeToStore(
      store,
      skillsRoot,
      "notes.md",
      "store edit",
      USER_WRITER,
      first.generationId,
    );

    const report = await sync();

    expect(report.conflicts).toHaveLength(1);
    const conflict = report.conflicts[0];
    expect(conflict?.path).toBe("notes.md");
    expect(conflict?.current?.generationId).toBe(winner.generationId);
    expect(conflict?.preserved?.conflictsWith).toBe(winner.generationId);

    // Both generations survive. The winner holds the file on both sides.
    const read = await store.read({ root: skillsRoot, path: "notes.md" });
    if (read.status !== "ok") throw new Error(read.reason);
    expect(decoder.decode(read.file.bytes)).toBe("store edit");
    expect(sprite.text(`${MOUNTS.skills}/notes.md`)).toBe("store edit");

    // The loser is preserved in object storage under its conflict key, in the
    // Durable Object's ledger, and on the Computer beside the winner.
    const preservedKey = bucket
      .keys()
      .find((key) => key.includes("notes.md.conflict/"));
    expect(preservedKey).toBeDefined();
    const preserved = await generations.conflicts(skillsRoot, "notes.md");
    expect(preserved.map((entry) => entry.generation.contentHash)).toEqual([
      sha256(encoder.encode("computer edit")),
    ]);
    const kept = sprite.keys(
      `${MOUNTS.skills}/.frockbot-sync/conflicts/notes.md/`,
    );
    expect(kept).toHaveLength(1);
    expect(sprite.text(kept[0] ?? "")).toBe("computer edit");
  });
});

describe("the durable-root sync, Memory roots", () => {
  // Constitution — Memory: "The Memory Package is the single writer of Memory
  // roots ... the Workspace presents Memory roots read-only through the
  // durable-root sync."
  test("a Memory file changed on the Computer is never pushed and is restored", async () => {
    const { sprite, memory, store, sync } = harness();
    const generation = await writeToStore(
      memory,
      botMemoryRoot,
      "profile.md",
      "likes tea",
      BOT_WRITER,
    );
    await sync();

    sprite.shellWrite(MOUNTS.botMemory, "profile.md", "likes coffee");
    const report = await sync();

    const memoryReport = report.roots.find(
      (entry) => entry.root.kind === "bot-memory",
    );
    expect(memoryReport?.pushed).toEqual([]);
    expect(memoryReport?.restored).toEqual(["profile.md"]);
    expect(sprite.text(`${MOUNTS.botMemory}/profile.md`)).toBe("likes tea");
    const read = await memory.read({ root: botMemoryRoot, path: "profile.md" });
    if (read.status !== "ok") throw new Error(read.reason);
    expect(decoder.decode(read.file.bytes)).toBe("likes tea");
    expect(read.file.generation.generationId).toBe(generation.generationId);

    // The sync surface refuses a Memory write outright, so there is no path by
    // which the Computer could have become a second writer.
    const refused = await store.write({
      path: { root: botMemoryRoot, path: "profile.md" },
      bytes: encoder.encode("likes coffee"),
      writer: BOT_WRITER,
      expectedGenerationId: generation.generationId,
    });
    expect(refused.status).toBe("refused");
  });

  test("a Memory file removed on the Computer is restored, never deleted in the store", async () => {
    const { sprite, memory, sync } = harness();
    await writeToStore(
      memory,
      botMemoryRoot,
      "profile.md",
      "likes tea",
      BOT_WRITER,
    );
    await sync();

    sprite.shellRemove(MOUNTS.botMemory, "profile.md");
    await sync();

    expect(sprite.text(`${MOUNTS.botMemory}/profile.md`)).toBe("likes tea");
    expect(
      (await memory.read({ root: botMemoryRoot, path: "profile.md" })).status,
    ).toBe("ok");
  });
});

describe("the durable-root sync, pauses", () => {
  // Constitution — Computer and Workspace: "Connections to the Computer are
  // expected to drop on every pause; every Computer client reconnects and
  // resumes rather than treating a dropped connection as failure." § Durable
  // effects: "Recovery never silently duplicates ... effects."
  test("a push interrupted by a pause resumes without writing a second generation", async () => {
    let dropAfterWrite = true;
    const { sprite, store, generations, bucket, sync } = harness({
      // The write lands and the answer never arrives: the Sprite paused, and
      // the connection carrying the outcome dropped.
      store: (files) => ({
        read: (path) => files.read(path),
        list: (request) => files.list(request),
        stat: (path) => files.stat(path),
        delete: (request) => files.delete(request),
        write: async (request) => {
          const outcome = await files.write(request);
          if (dropAfterWrite) {
            dropAfterWrite = false;
            throw new Error("connection reset by pause");
          }
          return outcome;
        },
      }),
    });
    sprite.shellWrite(MOUNTS.skills, "notes.md", "half sent");

    const interrupted = await sync();
    expect(interrupted.failures.map((entry) => entry.status)).toEqual([
      "unavailable",
    ]);
    // The intent is recorded in the Workspace and left unsettled, which is how
    // recovery knows to read the outcome rather than repeat the effect.
    expect(sprite.keys("/home/box/.frockbot/sync/effects/")).toHaveLength(1);

    const resumed = await sync();

    expect(resumed.failures).toEqual([]);
    expect(resumed.roots[0]?.adopted).toEqual(["notes.md"]);
    expect(resumed.roots[0]?.pushed).toEqual([]);
    expect(resumed.conflicts).toEqual([]);
    // Exactly one generation exists for the path: no duplicate, no conflict
    // object beside it.
    expect(
      bucket.keys().filter((key) => key.includes("notes.md")),
    ).toHaveLength(1);
    expect(await generations.conflicts(skillsRoot, "notes.md")).toEqual([]);
    expect(sprite.keys("/home/box/.frockbot/sync/effects/")).toHaveLength(0);
    const stat = await store.stat({ root: skillsRoot, path: "notes.md" });
    if (stat.status !== "ok") throw new Error(stat.reason);
    expect(stat.entry.generation.writer).toEqual({ kind: "unattributed" });
  });

  // § Durable effects: "Recovery never silently duplicates ... effects." The
  // push is not done when the store answers: the Computer still has no sidecar
  // for the bytes it holds. Settling the intent there would leave the next run
  // pushing the same file against `null` and colliding with the generation it
  // had itself just written — a conflict nobody caused.
  test("a push interrupted before its sidecar produces one generation and no conflict", async () => {
    const { sprite, store, generations, bucket, sync } = harness();
    sprite.shellWrite(MOUNTS.skills, "notes.md", "half sent");
    // The store takes the bytes; the Sprite pauses before the sidecar lands.
    sprite.dropNextMaterialize = true;

    const interrupted = await sync();
    expect(interrupted.failures.map((entry) => entry.status)).toEqual([
      "unavailable",
    ]);
    expect(interrupted.conflicts).toEqual([]);
    expect(sprite.keys("/home/box/.frockbot/sync/effects/")).toHaveLength(1);

    const resumed = await sync();

    expect(resumed.conflicts).toEqual([]);
    expect(resumed.failures).toEqual([]);
    expect(resumed.roots[0]?.adopted).toEqual(["notes.md"]);
    expect(
      bucket.keys().filter((key) => key.includes("notes.md")),
    ).toHaveLength(1);
    expect(await generations.conflicts(skillsRoot, "notes.md")).toEqual([]);
    expect(sprite.keys("/home/box/.frockbot/sync/effects/")).toHaveLength(0);
    const stat = await store.stat({ root: skillsRoot, path: "notes.md" });
    if (stat.status !== "ok") throw new Error(stat.reason);
    expect(stat.entry.generation.writer).toEqual({ kind: "unattributed" });
  });

  // "every Computer client reconnects and resumes rather than treating a
  // dropped connection as failure": a paused Sprite is `unavailable`, an
  // ordinary answer, and the next run completes the work.
  test("a paused Sprite answers unavailable and the next run completes the sync", async () => {
    const { sprite, store, sync } = harness();
    await writeToStore(store, skillsRoot, "notes.md", "keep", USER_WRITER);

    sprite.paused = true;
    const paused = await sync();
    expect(paused.failures.map((entry) => entry.status)).toEqual([
      "unavailable",
      "unavailable",
      "unavailable",
    ]);

    sprite.paused = false;
    const resumed = await sync();
    expect(resumed.failures).toEqual([]);
    expect(sprite.text(`${MOUNTS.skills}/notes.md`)).toBe("keep");
  });
});

describe("the on-Sprite sync service", () => {
  // Constitution — Computer and Workspace: "Only Computer-provider-declared
  // services may be reattached; other processes are assumed dead after a cold
  // pause."
  test("is declared as a provider service so a cold pause brings it back", async () => {
    const sprite = new FakeSyncSprite();
    const computer = new FlySpriteComputer({
      client: new FakeClient(sprite),
      spriteName: "frockbot-test",
    });

    await computer.bot(BOT).ensure();

    expect(sprite.services).toContain(WORKSPACE_SYNC_SERVICE);
  });

  test("its change signal is what a caller polls to decide when to sync", async () => {
    const { sprite, agent } = harness();

    expect(await agent.signal()).toEqual({ status: "ok" });
    sprite.files.set("/home/box/.frockbot/sync/signal", encoder.encode("7\n"));
    expect(await agent.signal()).toEqual({ status: "ok", text: "7" });
  });
});

// The sync as a Bot reaches it: `handle.sync` on the provider-neutral Computer
// interface, built from the host seam the Bot Durable Object supplies. These
// are the provider half of the caller wiring — the Computer Package decides
// *when* (`packages/plugin-computer/src/sync.test.ts`), and here is what
// actually happens against a Sprite when it does.
describe("the durable-root sync on the Computer handle", () => {
  interface EffectLog {
    effects: WorkspaceSyncEffectsV1;
    /** Every intent and settlement, in order, interleaved with store writes. */
    log: string[];
    pending: Map<string, WorkspaceSyncEffectV1>;
  }

  function recordingEffects(log: string[]): EffectLog {
    const pending = new Map<string, WorkspaceSyncEffectV1>();
    return {
      log,
      pending,
      effects: {
        intent: (effect) => {
          pending.set(effect.effectId, effect);
          log.push(`intent:${effect.kind}:${effect.path}`);
          return Promise.resolve();
        },
        settle: (effect) => {
          pending.delete(effect.effectId);
          log.push(`settle:${effect.kind}:${effect.path}`);
          return Promise.resolve();
        },
        pending: (effectId) => Promise.resolve(pending.get(effectId)),
      },
    };
  }

  function providerHarness() {
    const bucket = createInMemoryObjectBucketV1();
    const generations = createInMemoryWorkspaceGenerationsV1();
    const owner = { userId: USER };
    const store = createObjectWorkspaceFilesV1({
      bucket,
      generations,
      owner,
      surface: "sync",
    });
    const log: string[] = [];
    const effects = recordingEffects(log);
    const sprite = new FakeSyncSprite();
    const computer = new FlySpriteComputer({
      client: new FakeClient(sprite),
      spriteName: "frockbot-test",
    });
    const provider = new FlySpriteComputerProvider(computer, undefined, {
      // Every write the store takes is announced, so "intent before the push"
      // is an ordering claim about this one list.
      store: {
        read: (path) => store.read(path),
        list: (request) => store.list(request),
        stat: (path) => store.stat(path),
        write: (request) => {
          log.push(`write:${request.path.path}`);
          return store.write(request);
        },
        delete: (request) => {
          log.push(`delete:${request.path.path}`);
          return store.delete(request);
        },
      },
      effects: effects.effects,
      generations,
    });
    const open = () =>
      provider.open(
        { userId: USER },
        { botId: BOT },
        { providerId: "fly-sprite", generation: 1 },
      );
    return { sprite, store, generations, effects, provider, open };
  }

  test("pulls the store's durable roots onto the Computer before the Bot's first use", async () => {
    const { sprite, store, open } = providerHarness();
    await writeToStore(
      store,
      skillsRoot,
      "deploy/SKILL.md",
      "# deploy",
      BOT_WRITER,
    );

    const handle = await open();
    expect(handle.sync).toBeDefined();
    const summary = await handle.sync!.reconcile("open");

    expect(summary.status).toBe("ok");
    expect(summary.pulled).toBe(1);
    expect(sprite.text(`${MOUNTS.skills}/deploy/SKILL.md`)).toBe("# deploy");
  });

  test("pushes a shell write after the Turn, recording its intent before the write", async () => {
    const { sprite, store, effects, open } = providerHarness();
    const handle = await open();
    await handle.sync!.reconcile("open");
    sprite.shellWrite(MOUNTS.skills, "notes.md", "written by a shell");

    const summary = await handle.sync!.reconcile("turn-end");

    expect(summary.status).toBe("ok");
    expect(summary.pushed).toBe(1);
    // Intent, then the write, then settlement: the order § Durable effects
    // requires, so an interrupted push is read back rather than repeated.
    expect(effects.log).toEqual([
      "intent:push:notes.md",
      "write:notes.md",
      "settle:push:notes.md",
    ]);
    expect(effects.pending.size).toBe(0);
    const stored = await store.read({ root: skillsRoot, path: "notes.md" });
    expect(stored).toMatchObject({ status: "ok" });
    if (stored.status === "ok") {
      expect(decoder.decode(stored.file.bytes)).toBe("written by a shell");
      // A Turn was open, and it is still not evidence: one Computer serves all
      // of a User's Bots, so nothing here knows which process wrote the file.
      expect(stored.file.generation.writer).toEqual({ kind: "unattributed" });
      expect(
        isLoadableSkillSourceV1(
          {
            path: { root: skillsRoot, path: "notes.md" },
            writer: stored.file.generation.writer,
            generation: stored.file.generation,
          },
          { botId: BOT, userId: USER },
        ),
      ).toBe(false);
    }
  });

  test("answers unavailable rather than throwing when the Sprite is paused", async () => {
    const { sprite, open } = providerHarness();
    const handle = await open();
    sprite.paused = true;

    const summary = await handle.sync!.reconcile("turn-end");

    expect(summary.status).toBe("unavailable");
    expect(summary.failures).toBeGreaterThan(0);
    expect(await handle.sync!.signal()).toBeUndefined();
  });

  test("carries no sync at all when the host supplies no object-storage side", async () => {
    const sprite = new FakeSyncSprite();
    const provider = new FlySpriteComputerProvider(
      new FlySpriteComputer({
        client: new FakeClient(sprite),
        spriteName: "frockbot-test",
      }),
    );

    const handle = await provider.open(
      { userId: USER },
      { botId: BOT },
      { providerId: "fly-sprite", generation: 1 },
    );

    expect(handle.sync).toBeUndefined();
  });
});
