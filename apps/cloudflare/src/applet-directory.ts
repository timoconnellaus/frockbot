// The User Durable Object's Applet directory.
//
// An Applet's source, state, generations and data are the User's, so the User
// Durable Object — already the authority for the Flock, Package availability,
// Connections and the Computer assignment — owns the list. It holds identity,
// pointers and access only: the display name, the current generation, the
// tool declarations a Composition copies, the provenance of the creation, the
// Bot that owns the Applet and the Bots it is shared with (ADR 0027). It never
// holds an Applet's code (immutable artifacts) or its contents (the facet).
//
// Every read and every change names the Bot acting. An Applet that Bot cannot
// reach is `AppletUnavailableError`, exactly as an Applet that does not exist,
// and a change only the owner may make is `AppletNotOwnerError` for a shared
// Bot.
//
// `applets:directory-revision` is the whole of the fan-out. A create, publish,
// revert, share, unshare, transfer, delete, or a lifecycle change of an owner
// or shared Bot advances it; every Bot compares the revision its current
// Composition generation resolved against this one at its next resolution and
// re-resolves when they differ.
import {
  appletCleanupKey,
  appletDirectoryEntryKey,
  decodeAppletDirectoryEntryV1,
  newAppletIdV1,
  APPLET_CLEANUP_PREFIX,
  APPLET_DIRECTORY_ENTRY_PREFIX,
  APPLET_DIRECTORY_REVISION_KEY,
  APPLET_MAX_PER_USER_V1,
  type AppletDirectoryEntryV1,
  type AppletToolDeclarationV1,
} from "@frockbot/core/durable";
import {
  appletImpactFingerprintV1,
  APPLET_MAX_SHARES_V1,
  type AppletProvenanceV1,
  type AppletSummaryV1,
  type BotAppletImpactViewV1,
} from "@frockbot/core/contracts";

/**
 * An id the directory does not list, lists as deleted or unavailable, or lists
 * for other Bots only. It is a settled answer rather than a blip, and callers
 * across the Durable Object hops recognise it by `name` — never by the wording
 * of its message.
 */
export class AppletUnavailableError extends Error {
  override readonly name = "AppletUnavailableError";
  constructor(appletId: string) {
    super(`Applet "${appletId}" is unavailable`);
  }
}

/** A shared Bot asking for something only the owner Bot may do. */
export class AppletNotOwnerError extends Error {
  override readonly name = "AppletNotOwnerError";
  constructor(appletId: string) {
    super(
      `Applet "${appletId}" is shared with this Bot; only the Bot that owns it can change it`,
    );
  }
}

/** A share or transfer to a Bot that cannot hold one. */
export class AppletAccessRefusedError extends Error {
  override readonly name = "AppletAccessRefusedError";
}

/** The bot/delete confirmation named a different set of Applets. */
export class AppletImpactConflictError extends Error {
  override readonly name = "AppletImpactConflictError";
  constructor(readonly fingerprint: string) {
    super(
      "the Applets this Bot owns changed since the deletion was confirmed; review them and confirm again",
    );
  }
}

/** The directory as one Bot reads it. */
export interface AppletDirectoryViewV1 {
  schemaVersion: 1;
  revision: number;
  applets: AppletSummaryV1[];
}

export interface AppletDirectoryStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  delete(key: string): Promise<boolean>;
}

/** What a Bot's lifecycle is, as the directory needs to know it. */
export type AppletBotStatusV1 = "active" | "archived" | "deleted" | "unknown";

export interface AppletCleanupV1 {
  schemaVersion: 1;
  appletId: string;
  recordedAt: string;
}

function reaches(entry: AppletDirectoryEntryV1, botId: string): boolean {
  return entry.ownerBotId === botId || entry.sharedWithBotIds.includes(botId);
}

/** One entry, as the Bot acting sees it. */
export function appletSummaryV1(
  entry: AppletDirectoryEntryV1,
  botId: string,
): AppletSummaryV1 {
  const owner = entry.ownerBotId === botId;
  return {
    appletId: entry.appletId,
    displayName: entry.displayName,
    status: entry.status,
    ...(entry.currentGenerationId
      ? { currentGenerationId: entry.currentGenerationId }
      : {}),
    tools: entry.tools.map((tool) => tool.name),
    createdAt: entry.createdAt,
    ownerBotId: entry.ownerBotId,
    access: owner ? "owner" : "shared",
    sharedWithBotIds: owner ? [...entry.sharedWithBotIds] : [],
  };
}

/**
 * One User's Applet directory over the User Durable Object's storage, or over
 * a transaction of it: the Bot lifecycle saga applies an Applet consequence in
 * the transaction that settles the Bot's lifecycle.
 *
 * Every mutation advances the revision in the same write as the entries, so a
 * reader never sees an entry a revision does not account for.
 */
export class AppletDirectory {
  readonly #storage: AppletDirectoryStorage;
  readonly #now: () => Date;
  readonly #botStatus: (botId: string) => Promise<AppletBotStatusV1>;

  constructor(
    storage: AppletDirectoryStorage,
    options: {
      now?: () => Date;
      /** Whether a Bot of this User may be given access. Shares and transfers only. */
      botStatus?: (botId: string) => Promise<AppletBotStatusV1>;
    } = {},
  ) {
    this.#storage = storage;
    this.#now = options.now ?? (() => new Date());
    this.#botStatus = options.botStatus ?? (async () => "unknown");
  }

  async revision(): Promise<number> {
    return (
      (await this.#storage.get<number>(APPLET_DIRECTORY_REVISION_KEY)) ?? 0
    );
  }

  async #entries(): Promise<AppletDirectoryEntryV1[]> {
    const stored = await this.#storage.list<unknown>({
      prefix: APPLET_DIRECTORY_ENTRY_PREFIX,
    });
    return [...stored.values()].map((value) =>
      decodeAppletDirectoryEntryV1(value),
    );
  }

  async #entry(appletId: string): Promise<AppletDirectoryEntryV1 | undefined> {
    const stored = await this.#storage.get<unknown>(
      appletDirectoryEntryKey(appletId),
    );
    return stored === undefined
      ? undefined
      : decodeAppletDirectoryEntryV1(stored);
  }

  /**
   * The entry one Bot may use, or `AppletUnavailableError`. Deleted,
   * unavailable and other Bots' Applets all answer the same way.
   */
  async access(
    botId: string,
    appletId: string,
  ): Promise<AppletDirectoryEntryV1> {
    const entry = await this.#entry(appletId);
    if (
      !entry ||
      entry.status === "deleted" ||
      !entry.available ||
      !reaches(entry, botId)
    ) {
      throw new AppletUnavailableError(appletId);
    }
    return entry;
  }

  /** The entry the acting Bot owns, or the error that says why not. */
  async owned(botId: string, appletId: string): Promise<AppletDirectoryEntryV1> {
    const entry = await this.access(botId, appletId);
    if (entry.ownerBotId !== botId) throw new AppletNotOwnerError(appletId);
    return entry;
  }

  /** One Applet as the acting Bot sees it. */
  async read(botId: string, appletId: string): Promise<AppletSummaryV1> {
    return appletSummaryV1(await this.access(botId, appletId), botId);
  }

  /** The Applets one Bot owns or is shared, oldest first. Never the account's. */
  async list(botId: string): Promise<AppletDirectoryViewV1> {
    const entries = await this.#entries();
    return {
      schemaVersion: 1,
      revision: await this.revision(),
      applets: entries
        .filter(
          (entry) =>
            entry.status !== "deleted" &&
            entry.available &&
            reaches(entry, botId),
        )
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map((entry) => appletSummaryV1(entry, botId)),
    };
  }

  /**
   * The Applet members the User's next Composition generation resolves. The
   * generation is the User's, so every available published Applet is in it,
   * with its access: a Bot registers only the members that reach it, and a
   * Turn pins the access with the tools. The declarations come from the
   * directory, which copies them from the generation that actually mounted.
   */
  async compositionInput(): Promise<{
    revision: number;
    applets: {
      appletId: string;
      generationId: string;
      tools: AppletToolDeclarationV1[];
      provenance: AppletProvenanceV1;
      ownerBotId: string;
      sharedWithBotIds: string[];
    }[];
  }> {
    const entries = await this.#entries();
    return {
      revision: await this.revision(),
      applets: entries
        .filter(
          (entry) =>
            entry.status === "published" &&
            entry.available &&
            entry.currentGenerationId !== undefined &&
            entry.tools.length > 0,
        )
        .sort((left, right) => left.appletId.localeCompare(right.appletId))
        .map((entry) => ({
          appletId: entry.appletId,
          generationId: entry.currentGenerationId as string,
          tools: entry.tools,
          provenance: entry.provenance,
          ownerBotId: entry.ownerBotId,
          sharedWithBotIds: [...entry.sharedWithBotIds].sort(),
        })),
    };
  }

  async #write(
    entries: readonly AppletDirectoryEntryV1[],
    extra: Record<string, unknown> = {},
  ): Promise<number> {
    const revision = (await this.revision()) + 1;
    await this.#storage.put({
      ...Object.fromEntries(
        entries.map((entry) => [appletDirectoryEntryKey(entry.appletId), entry]),
      ),
      ...extra,
      [APPLET_DIRECTORY_REVISION_KEY]: revision,
    });
    return revision;
  }

  /** Mints the id in the shared id shape and writes a `draft` the Bot owns. */
  async create(input: {
    userId: string;
    ownerBotId: string;
    displayName: string;
    provenance: AppletProvenanceV1;
  }): Promise<AppletSummaryV1> {
    const existing = await this.#entries();
    if (
      existing.filter((entry) => entry.status !== "deleted").length >=
      APPLET_MAX_PER_USER_V1
    ) {
      throw new Error(
        `this account already holds ${APPLET_MAX_PER_USER_V1} Applets`,
      );
    }
    const entry = decodeAppletDirectoryEntryV1({
      schemaVersion: 1,
      appletId: newAppletIdV1(input.userId),
      displayName: input.displayName,
      tools: [],
      provenance: input.provenance,
      createdAt: this.#now().toISOString(),
      status: "draft",
      ownerBotId: input.ownerBotId,
      sharedWithBotIds: [],
      available: true,
    });
    await this.#write([entry]);
    return appletSummaryV1(entry, input.ownerBotId);
  }

  /**
   * Records the generation the Applet Durable Object actually activated. The
   * directory follows the mount, never precedes it: a generation that failed
   * its health check leaves the entry pointing at the one still resident.
   */
  async recordGeneration(input: {
    botId: string;
    appletId: string;
    generationId: string;
    tools: AppletToolDeclarationV1[];
  }): Promise<AppletSummaryV1> {
    const entry = await this.owned(input.botId, input.appletId);
    const updated = decodeAppletDirectoryEntryV1({
      ...entry,
      currentGenerationId: input.generationId,
      tools: input.tools,
      status: "published",
    });
    await this.#write([updated]);
    return appletSummaryV1(updated, input.botId);
  }

  /**
   * Tool names already declared by another Applet of this account. Names are
   * unique across the account, not per Bot, so a share or a transfer can never
   * make one Bot's Composition hold two tools of one name. Only the clashing
   * names are answered: the other Applet may belong to a Bot that cannot see it.
   */
  async toolNameClashes(input: {
    appletId: string;
    names: readonly string[];
  }): Promise<string[]> {
    const taken = new Set<string>();
    for (const entry of await this.#entries()) {
      if (entry.appletId === input.appletId || entry.status === "deleted")
        continue;
      for (const tool of entry.tools) taken.add(tool.name);
    }
    return input.names.filter((name) => taken.has(name));
  }

  /** The tombstone and the cleanup to-do for one entry, not yet written. */
  #tombstone(entry: AppletDirectoryEntryV1): {
    entry: AppletDirectoryEntryV1;
    cleanup: Record<string, AppletCleanupV1>;
  } {
    return {
      entry: decodeAppletDirectoryEntryV1({
        ...entry,
        tools: [],
        sharedWithBotIds: [],
        status: "deleted",
      }),
      cleanup: {
        [appletCleanupKey(entry.appletId)]: {
          schemaVersion: 1,
          appletId: entry.appletId,
          recordedAt: this.#now().toISOString(),
        },
      },
    };
  }

  /**
   * The owner's deletion: the entry becomes a tombstone, its shares go with
   * it, the revision advances so no Bot's next Composition offers its tools,
   * and the cleanup to-do is written in the same put. The caller then deletes
   * the state and the source and drops the to-do.
   */
  async markDeleted(input: {
    botId: string;
    appletId: string;
  }): Promise<AppletSummaryV1> {
    const entry = await this.owned(input.botId, input.appletId);
    const { entry: tombstone, cleanup } = this.#tombstone(entry);
    await this.#write([tombstone], cleanup);
    return appletSummaryV1(tombstone, input.botId);
  }

  async #requireActiveBot(botId: string, verb: string): Promise<void> {
    const status = await this.#botStatus(botId);
    if (status !== "active") {
      throw new AppletAccessRefusedError(
        status === "archived"
          ? `Bot "${botId}" is archived, so an Applet cannot be ${verb} it`
          : `Bot "${botId}" is not an active Bot of this account`,
      );
    }
  }

  /** Grants an active Bot of this User use of the Applet. Idempotent. */
  async share(input: {
    botId: string;
    appletId: string;
    targetBotId: string;
  }): Promise<AppletSummaryV1> {
    const entry = await this.owned(input.botId, input.appletId);
    if (input.targetBotId === input.botId) {
      throw new AppletAccessRefusedError(
        "an Applet's owner already has access to it",
      );
    }
    if (entry.sharedWithBotIds.includes(input.targetBotId)) {
      return appletSummaryV1(entry, input.botId);
    }
    if (entry.sharedWithBotIds.length >= APPLET_MAX_SHARES_V1) {
      throw new AppletAccessRefusedError(
        `an Applet can be shared with at most ${APPLET_MAX_SHARES_V1} Bots`,
      );
    }
    await this.#requireActiveBot(input.targetBotId, "shared with");
    const updated = decodeAppletDirectoryEntryV1({
      ...entry,
      sharedWithBotIds: [...entry.sharedWithBotIds, input.targetBotId],
    });
    await this.#write([updated]);
    return appletSummaryV1(updated, input.botId);
  }

  /** Takes a Bot's use away. Idempotent: a Bot not shared is left alone. */
  async unshare(input: {
    botId: string;
    appletId: string;
    targetBotId: string;
  }): Promise<AppletSummaryV1> {
    const entry = await this.owned(input.botId, input.appletId);
    if (!entry.sharedWithBotIds.includes(input.targetBotId)) {
      return appletSummaryV1(entry, input.botId);
    }
    const updated = decodeAppletDirectoryEntryV1({
      ...entry,
      sharedWithBotIds: entry.sharedWithBotIds.filter(
        (id) => id !== input.targetBotId,
      ),
    });
    await this.#write([updated]);
    return appletSummaryV1(updated, input.botId);
  }

  /**
   * Makes an active Bot of this User the owner and keeps the former owner as a
   * shared Bot. Metadata only: the source, the state and the generations are
   * the User's and stay where they are.
   *
   * A replay after the transfer landed is recognised by its outcome — the
   * target owns it and the caller is shared — and answers the same summary
   * rather than a refusal the caller could not explain.
   */
  async transfer(input: {
    botId: string;
    appletId: string;
    targetBotId: string;
  }): Promise<AppletSummaryV1> {
    if (input.targetBotId === input.botId) {
      throw new AppletAccessRefusedError("this Bot already owns the Applet");
    }
    const current = await this.access(input.botId, input.appletId);
    if (
      current.ownerBotId === input.targetBotId &&
      current.sharedWithBotIds.includes(input.botId)
    ) {
      return appletSummaryV1(current, input.botId);
    }
    const entry = await this.owned(input.botId, input.appletId);
    await this.#requireActiveBot(input.targetBotId, "transferred to");
    const updated = decodeAppletDirectoryEntryV1({
      ...entry,
      ownerBotId: input.targetBotId,
      sharedWithBotIds: [
        ...entry.sharedWithBotIds.filter((id) => id !== input.targetBotId),
        input.botId,
      ],
    });
    await this.#write([updated]);
    return appletSummaryV1(updated, input.botId);
  }

  /** What archiving or deleting one Bot does to the Applets it owns. */
  async impact(botId: string): Promise<BotAppletImpactViewV1> {
    const owned = (await this.#entries())
      .filter(
        (entry) => entry.ownerBotId === botId && entry.status !== "deleted",
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const applets = owned.map((entry) => ({
      appletId: entry.appletId,
      displayName: entry.displayName,
      status: entry.status as "draft" | "published",
      sharedWithBotIds: [...entry.sharedWithBotIds],
    }));
    return {
      schemaVersion: 1,
      botId,
      fingerprint: appletImpactFingerprintV1(applets),
      applets,
    };
  }

  /**
   * The Applet consequence of one Bot's settled lifecycle, in the caller's
   * transaction. Archive leaves every owned Applet whole and unusable; restore
   * makes it usable again; delete tombstones every owned Applet — shared or
   * not — and queues its cleanup, and takes the deleted Bot off every share.
   * Nothing is written, and the revision stays, when nothing changed, so a
   * replayed settle is free.
   */
  async applyBotLifecycle(
    botId: string,
    status: "active" | "archived" | "deleted",
  ): Promise<{ cleanups: string[] }> {
    const changed: AppletDirectoryEntryV1[] = [];
    const cleanups: Record<string, AppletCleanupV1> = {};
    for (const entry of await this.#entries()) {
      if (entry.status === "deleted") continue;
      if (entry.ownerBotId === botId) {
        if (status === "deleted") {
          const tombstone = this.#tombstone(entry);
          changed.push(tombstone.entry);
          Object.assign(cleanups, tombstone.cleanup);
        } else if (entry.available !== (status === "active")) {
          changed.push(
            decodeAppletDirectoryEntryV1({
              ...entry,
              available: status === "active",
            }),
          );
        }
      } else if (
        status === "deleted" &&
        entry.sharedWithBotIds.includes(botId)
      ) {
        changed.push(
          decodeAppletDirectoryEntryV1({
            ...entry,
            sharedWithBotIds: entry.sharedWithBotIds.filter(
              (id) => id !== botId,
            ),
          }),
        );
      }
    }
    if (changed.length > 0) await this.#write(changed, cleanups);
    return {
      cleanups: Object.values(cleanups).map((cleanup) => cleanup.appletId),
    };
  }

  /** Deleted Applets whose state or source may still exist. */
  async pendingCleanups(): Promise<string[]> {
    const stored = await this.#storage.list<unknown>({
      prefix: APPLET_CLEANUP_PREFIX,
    });
    return [...stored.keys()].map((key) =>
      key.slice(APPLET_CLEANUP_PREFIX.length),
    );
  }

  /** The state and source are gone; drop the to-do. */
  async forgetCleanup(appletId: string): Promise<void> {
    await this.#storage.delete(appletCleanupKey(appletId));
  }
}
