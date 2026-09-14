// The directory is the one authority for who may reach and who may change an
// Applet (ADR 0027), so every rule is exercised here against the durable
// records themselves rather than through a Durable Object.
import { describe, expect, test } from "bun:test";
import {
  APPLET_CLEANUP_PREFIX,
  APPLET_DIRECTORY_REVISION_KEY,
  appletDirectoryEntryKey,
  type AppletToolDeclarationV1,
} from "@frockbot/core/durable";
import { appletImpactFingerprintV1 } from "@frockbot/core/contracts";
import {
  AppletDirectory,
  type AppletBotStatusV1,
  type AppletDirectoryStorage,
} from "./applet-directory.js";

const USER = "user-42";

function memory(): AppletDirectoryStorage & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    get: <T>(key: string) =>
      Promise.resolve(structuredClone(values.get(key)) as T | undefined),
    put: (entries) => {
      for (const [key, value] of Object.entries(entries))
        values.set(key, structuredClone(value));
      return Promise.resolve();
    },
    list: <T>({ prefix }: { prefix: string }) =>
      Promise.resolve(
        new Map(
          [...values].filter(([key]) => key.startsWith(prefix)) as [
            string,
            T,
          ][],
        ),
      ),
    delete: (key) => Promise.resolve(values.delete(key)),
  };
}

function tool(name: string): AppletToolDeclarationV1 {
  return { name, description: `The ${name} tool`, inputSchema: { type: "object" } };
}

function directory(
  statuses: Record<string, AppletBotStatusV1> = {
    scout: "active",
    sage: "active",
    pip: "active",
  },
) {
  const storage = memory();
  let clock = 0;
  return {
    storage,
    directory: new AppletDirectory(storage, {
      now: () => new Date(Date.UTC(2026, 8, 14, 0, 0, clock++)),
      botStatus: async (botId) => statuses[botId] ?? "unknown",
    }),
  };
}

async function created(
  subject: AppletDirectory,
  ownerBotId = "scout",
  displayName = "Todo",
) {
  return subject.create({
    userId: USER,
    ownerBotId,
    displayName,
    provenance: {
      kind: "bot",
      botId: ownerBotId,
      sessionId: `${USER}:${ownerBotId}`,
      turnId: "turn-1",
    },
  });
}

describe("who may reach an Applet", () => {
  test("the creating Bot owns it and no other Bot sees it", async () => {
    const { directory: subject } = directory();
    const todo = await created(subject);
    expect(todo).toMatchObject({
      ownerBotId: "scout",
      access: "owner",
      sharedWithBotIds: [],
      status: "draft",
    });
    expect((await subject.list("scout")).applets.map((a) => a.appletId)).toEqual(
      [todo.appletId],
    );
    expect((await subject.list("sage")).applets).toEqual([]);
    await expect(subject.read("sage", todo.appletId)).rejects.toMatchObject({
      name: "AppletUnavailableError",
    });
  });

  test("a share grants use and nothing else, and says who else uses it only to the owner", async () => {
    const { directory: subject } = directory();
    const todo = await created(subject);
    const shared = await subject.share({
      botId: "scout",
      appletId: todo.appletId,
      targetBotId: "sage",
    });
    expect(shared.sharedWithBotIds).toEqual(["sage"]);
    expect(await subject.read("sage", todo.appletId)).toMatchObject({
      access: "shared",
      ownerBotId: "scout",
      sharedWithBotIds: [],
    });
    for (const change of [
      () => subject.owned("sage", todo.appletId),
      () =>
        subject.recordGeneration({
          botId: "sage",
          appletId: todo.appletId,
          generationId: "g1",
          tools: [tool("add_todo")],
        }),
      () => subject.markDeleted({ botId: "sage", appletId: todo.appletId }),
      () =>
        subject.share({
          botId: "sage",
          appletId: todo.appletId,
          targetBotId: "pip",
        }),
      () =>
        subject.unshare({
          botId: "sage",
          appletId: todo.appletId,
          targetBotId: "sage",
        }),
      () =>
        subject.transfer({
          botId: "sage",
          appletId: todo.appletId,
          targetBotId: "pip",
        }),
    ]) {
      await expect(change()).rejects.toMatchObject({
        name: "AppletNotOwnerError",
      });
    }
    // Sharing twice is sharing once.
    const revision = await subject.revision();
    await subject.share({
      botId: "scout",
      appletId: todo.appletId,
      targetBotId: "sage",
    });
    expect(await subject.revision()).toBe(revision);
  });

  test("only an active Bot of the account may be given access", async () => {
    const { directory: subject } = directory({
      scout: "active",
      sage: "archived",
    });
    const todo = await created(subject);
    for (const targetBotId of ["sage", "stranger", "scout"]) {
      await expect(
        subject.share({ botId: "scout", appletId: todo.appletId, targetBotId }),
      ).rejects.toMatchObject({ name: "AppletAccessRefusedError" });
      await expect(
        subject.transfer({
          botId: "scout",
          appletId: todo.appletId,
          targetBotId,
        }),
      ).rejects.toMatchObject({ name: "AppletAccessRefusedError" });
    }
  });

  test("an unshare takes the Applet away from the next read", async () => {
    const { directory: subject } = directory();
    const todo = await created(subject);
    await subject.share({
      botId: "scout",
      appletId: todo.appletId,
      targetBotId: "sage",
    });
    await subject.unshare({
      botId: "scout",
      appletId: todo.appletId,
      targetBotId: "sage",
    });
    expect((await subject.list("sage")).applets).toEqual([]);
  });
});

describe("transfer", () => {
  test("makes the target the owner, keeps the former owner shared, and replays", async () => {
    const { directory: subject, storage } = directory();
    const todo = await created(subject);
    await subject.recordGeneration({
      botId: "scout",
      appletId: todo.appletId,
      generationId: "g1",
      tools: [tool("add_todo")],
    });
    await subject.share({
      botId: "scout",
      appletId: todo.appletId,
      targetBotId: "sage",
    });
    const before = structuredClone(
      storage.values.get(appletDirectoryEntryKey(todo.appletId)),
    ) as Record<string, unknown>;
    const transferred = await subject.transfer({
      botId: "scout",
      appletId: todo.appletId,
      targetBotId: "sage",
    });
    expect(transferred).toMatchObject({ ownerBotId: "sage", access: "shared" });
    expect(await subject.read("sage", todo.appletId)).toMatchObject({
      access: "owner",
      sharedWithBotIds: ["scout"],
    });
    // Metadata only: the generation, the tools and the provenance stay.
    expect(storage.values.get(appletDirectoryEntryKey(todo.appletId))).toEqual({
      ...before,
      ownerBotId: "sage",
      sharedWithBotIds: ["scout"],
    });
    // A retried transfer reads its own outcome back rather than a refusal.
    const revision = await subject.revision();
    expect(
      await subject.transfer({
        botId: "scout",
        appletId: todo.appletId,
        targetBotId: "sage",
      }),
    ).toEqual(transferred);
    expect(await subject.revision()).toBe(revision);
    // And the former owner can no longer change it.
    await expect(
      subject.markDeleted({ botId: "scout", appletId: todo.appletId }),
    ).rejects.toMatchObject({ name: "AppletNotOwnerError" });
  });
});

describe("tool names", () => {
  test("stay unique across the account, including Applets the Bot cannot see", async () => {
    const { directory: subject } = directory();
    const mine = await created(subject, "scout", "Mine");
    const theirs = await created(subject, "pip", "Theirs");
    await subject.recordGeneration({
      botId: "pip",
      appletId: theirs.appletId,
      generationId: "g1",
      tools: [tool("add_todo")],
    });
    expect(
      await subject.toolNameClashes({
        appletId: mine.appletId,
        names: ["add_todo", "add_note"],
      }),
    ).toEqual(["add_todo"]);
    // Its own names are not a clash with itself.
    expect(
      await subject.toolNameClashes({
        appletId: theirs.appletId,
        names: ["add_todo"],
      }),
    ).toEqual([]);
  });
});

describe("the Composition input", () => {
  test("carries every available published Applet with the Bots it reaches", async () => {
    const { directory: subject } = directory();
    const todo = await created(subject);
    const draft = await created(subject, "scout", "Draft");
    await subject.recordGeneration({
      botId: "scout",
      appletId: todo.appletId,
      generationId: "g1",
      tools: [tool("add_todo")],
    });
    await subject.share({
      botId: "scout",
      appletId: todo.appletId,
      targetBotId: "sage",
    });
    const input = await subject.compositionInput();
    expect(input.applets).toEqual([
      expect.objectContaining({
        appletId: todo.appletId,
        generationId: "g1",
        ownerBotId: "scout",
        sharedWithBotIds: ["sage"],
      }),
    ]);
    expect(input.applets.some((a) => a.appletId === draft.appletId)).toBe(false);
  });
});

describe("a Bot's lifecycle", () => {
  async function published(subject: AppletDirectory) {
    const todo = await created(subject);
    await subject.recordGeneration({
      botId: "scout",
      appletId: todo.appletId,
      generationId: "g1",
      tools: [tool("add_todo")],
    });
    await subject.share({
      botId: "scout",
      appletId: todo.appletId,
      targetBotId: "sage",
    });
    return todo;
  }

  test("archiving the owner makes its Applets unavailable everywhere, and restoring brings them back", async () => {
    const { directory: subject, storage } = directory();
    const todo = await published(subject);
    const revision = await subject.revision();
    await subject.applyBotLifecycle("scout", "archived");
    expect(await subject.revision()).toBe(revision + 1);
    expect((await subject.list("sage")).applets).toEqual([]);
    expect((await subject.compositionInput()).applets).toEqual([]);
    // Nothing was deleted: the entry, its generation and its shares remain.
    expect(storage.values.get(appletDirectoryEntryKey(todo.appletId))).toMatchObject(
      {
        status: "published",
        currentGenerationId: "g1",
        sharedWithBotIds: ["sage"],
        available: false,
      },
    );
    expect(await subject.pendingCleanups()).toEqual([]);
    // A replayed settle is free.
    await subject.applyBotLifecycle("scout", "archived");
    expect(await subject.revision()).toBe(revision + 1);

    await subject.applyBotLifecycle("scout", "active");
    expect((await subject.list("sage")).applets).toMatchObject([
      { appletId: todo.appletId, access: "shared" },
    ]);
    expect((await subject.compositionInput()).applets).toHaveLength(1);
  });

  test("deleting the owner tombstones its Applets, shared or not, and queues their cleanup", async () => {
    const { directory: subject, storage } = directory();
    const todo = await published(subject);
    const { cleanups } = await subject.applyBotLifecycle("scout", "deleted");
    expect(cleanups).toEqual([todo.appletId]);
    expect((await subject.list("sage")).applets).toEqual([]);
    expect(storage.values.get(appletDirectoryEntryKey(todo.appletId))).toMatchObject(
      { status: "deleted", tools: [], sharedWithBotIds: [] },
    );
    expect(await subject.pendingCleanups()).toEqual([todo.appletId]);
    expect(storage.values.has(`${APPLET_CLEANUP_PREFIX}${todo.appletId}`)).toBe(
      true,
    );
    await subject.forgetCleanup(todo.appletId);
    expect(await subject.pendingCleanups()).toEqual([]);
    // Settled twice is settled once: a tombstone is not tombstoned again.
    const revision = storage.values.get(APPLET_DIRECTORY_REVISION_KEY);
    expect(await subject.applyBotLifecycle("scout", "deleted")).toEqual({
      cleanups: [],
    });
    expect(storage.values.get(APPLET_DIRECTORY_REVISION_KEY)).toBe(revision);
  });

  test("deleting a shared Bot takes it off every share", async () => {
    const { directory: subject } = directory();
    const todo = await published(subject);
    await subject.applyBotLifecycle("sage", "deleted");
    expect(await subject.read("scout", todo.appletId)).toMatchObject({
      sharedWithBotIds: [],
      status: "published",
    });
  });

  test("the impact names what the Bot owns and whom it is shared with", async () => {
    const { directory: subject } = directory();
    const todo = await published(subject);
    await created(subject, "pip", "Not scout's");
    const impact = await subject.impact("scout");
    expect(impact).toEqual({
      schemaVersion: 1,
      botId: "scout",
      fingerprint: appletImpactFingerprintV1([
        { appletId: todo.appletId, sharedWithBotIds: ["sage"] },
      ]),
      applets: [
        {
          appletId: todo.appletId,
          displayName: "Todo",
          status: "published",
          sharedWithBotIds: ["sage"],
        },
      ],
    });
    // A share after the confirmation is a different set to destroy.
    await subject.share({
      botId: "scout",
      appletId: todo.appletId,
      targetBotId: "pip",
    });
    expect((await subject.impact("scout")).fingerprint).not.toBe(
      impact.fingerprint,
    );
    // An archived Bot still owns its Applets; its impact still names them.
    await subject.applyBotLifecycle("scout", "archived");
    expect((await subject.impact("scout")).applets).toHaveLength(1);
  });
});

describe("the owner's deletion", () => {
  test("is a tombstone, a revision and a cleanup to-do in one write, and a second delete is gone", async () => {
    const storage = memory();
    const puts: string[][] = [];
    const recording = new AppletDirectory({
      ...storage,
      put: (entries) => {
        puts.push(Object.keys(entries).sort());
        return storage.put(entries);
      },
    });
    const todo = await created(recording);
    puts.length = 0;
    await recording.markDeleted({ botId: "scout", appletId: todo.appletId });
    expect(puts).toEqual([
      [
        `${APPLET_CLEANUP_PREFIX}${todo.appletId}`,
        APPLET_DIRECTORY_REVISION_KEY,
        appletDirectoryEntryKey(todo.appletId),
      ].sort(),
    ]);
    await expect(
      recording.markDeleted({ botId: "scout", appletId: todo.appletId }),
    ).rejects.toMatchObject({ name: "AppletUnavailableError" });
  });
});
