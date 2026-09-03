// The User Durable Object's Applet directory.
//
// ADR 0022 decision 3: Applets are account-wide, so the User Durable Object —
// already the authority for Package availability, Connections, and the Computer
// assignment — owns the list. It holds identity and pointers only: the display
// name, the current generation, the tool declarations every Bot's Composition
// copies, and the provenance of the creation. It never holds an Applet's code
// (immutable artifacts) or its contents (the facet).
//
// `applets:directory-revision` is the whole of the fan-out. A create, publish,
// revert or delete advances it; every Bot of the User compares the revision its
// current Composition generation resolved against this one at its next
// resolution and re-resolves when they differ. That is why the User Durable
// Object never needs to know which Bots exist.
import {
  appletDirectoryEntryKey,
  decodeAppletDirectoryEntryV1,
  newAppletIdV1,
  APPLET_DIRECTORY_ENTRY_PREFIX,
  APPLET_DIRECTORY_REVISION_KEY,
  APPLET_MAX_PER_USER_V1,
  type AppletDirectoryEntryV1,
  type AppletToolDeclarationV1,
} from "@frockbot/kernel-do";
import type {
  AppletProvenanceV1,
  AppletSummaryV1,
} from "@frockbot/kernel-contracts";

/** The directory as a Bot isolate and the hosted client read it. */
export interface AppletDirectoryViewV1 {
  schemaVersion: 1;
  revision: number;
  applets: AppletSummaryV1[];
}

export interface AppletDirectoryStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
}

function summary(entry: AppletDirectoryEntryV1): AppletSummaryV1 {
  return {
    appletId: entry.appletId,
    displayName: entry.displayName,
    status: entry.status,
    ...(entry.currentGenerationId
      ? { currentGenerationId: entry.currentGenerationId }
      : {}),
    tools: entry.tools.map((tool) => tool.name),
    createdAt: entry.createdAt,
  };
}

/**
 * One User's Applet directory over the User Durable Object's storage.
 *
 * Every mutation advances the revision in the same write as the entry, so a
 * reader never sees an entry a revision does not account for.
 */
export class AppletDirectory {
  readonly #storage: AppletDirectoryStorage;
  readonly #now: () => Date;

  constructor(
    storage: AppletDirectoryStorage,
    now: () => Date = () => new Date(),
  ) {
    this.#storage = storage;
    this.#now = now;
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

  async entry(appletId: string): Promise<AppletDirectoryEntryV1 | undefined> {
    const stored = await this.#storage.get<unknown>(
      appletDirectoryEntryKey(appletId),
    );
    return stored === undefined
      ? undefined
      : decodeAppletDirectoryEntryV1(stored);
  }

  /** Deleted entries are tombstones: they stay, and they are never listed. */
  async list(): Promise<AppletDirectoryViewV1> {
    const entries = await this.#entries();
    return {
      schemaVersion: 1,
      revision: await this.revision(),
      applets: entries
        .filter((entry) => entry.status !== "deleted")
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .map(summary),
    };
  }

  /**
   * The Applet members one Composition generation resolves. The declarations
   * come from the directory, which copies them from the generation that
   * actually mounted, so a Bot's catalog can never name a tool the current
   * Applet generation does not export.
   */
  async compositionInput(): Promise<{
    revision: number;
    applets: {
      appletId: string;
      generationId: string;
      tools: AppletToolDeclarationV1[];
      provenance: AppletProvenanceV1;
    }[];
  }> {
    const entries = await this.#entries();
    return {
      revision: await this.revision(),
      applets: entries
        .filter(
          (entry) =>
            entry.status === "published" &&
            entry.currentGenerationId !== undefined &&
            entry.tools.length > 0,
        )
        .sort((left, right) => left.appletId.localeCompare(right.appletId))
        .map((entry) => ({
          appletId: entry.appletId,
          generationId: entry.currentGenerationId as string,
          tools: entry.tools,
          provenance: entry.provenance,
        })),
    };
  }

  async #write(
    entry: AppletDirectoryEntryV1,
  ): Promise<{ entry: AppletDirectoryEntryV1; revision: number }> {
    const revision = (await this.revision()) + 1;
    await this.#storage.put({
      [appletDirectoryEntryKey(entry.appletId)]: entry,
      [APPLET_DIRECTORY_REVISION_KEY]: revision,
    });
    return { entry, revision };
  }

  /** Mints the id in the ADR 0015 share shape and writes a `draft` entry. */
  async create(input: {
    ownerId: string;
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
      appletId: newAppletIdV1(input.ownerId),
      displayName: input.displayName,
      tools: [],
      provenance: input.provenance,
      createdAt: this.#now().toISOString(),
      status: "draft",
    });
    await this.#write(entry);
    return summary(entry);
  }

  /**
   * Records the generation the Applet Durable Object actually activated. The
   * directory follows the mount, never precedes it: a generation that failed
   * its health check leaves the entry pointing at the one still resident.
   */
  async recordGeneration(input: {
    appletId: string;
    generationId: string;
    tools: AppletToolDeclarationV1[];
  }): Promise<AppletSummaryV1> {
    const entry = await this.entry(input.appletId);
    if (!entry || entry.status === "deleted") {
      throw new Error(`Applet "${input.appletId}" is unavailable`);
    }
    const updated = decodeAppletDirectoryEntryV1({
      ...entry,
      currentGenerationId: input.generationId,
      tools: input.tools,
      status: "published",
    });
    await this.#write(updated);
    return summary(updated);
  }

  /**
   * Marks the entry deleted and advances the revision, so every Bot's next
   * Composition resolution drops the Applet's tools. The caller deletes the
   * facet and its storage through the Applet Durable Object.
   */
  async markDeleted(appletId: string): Promise<AppletSummaryV1> {
    const entry = await this.entry(appletId);
    if (!entry) throw new Error(`Applet "${appletId}" is unavailable`);
    const updated = decodeAppletDirectoryEntryV1({
      ...entry,
      tools: [],
      status: "deleted",
    });
    await this.#write(updated);
    return summary(updated);
  }
}
