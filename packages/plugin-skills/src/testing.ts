// An in-memory `WorkspaceFilesV1`, for tests only.
//
// The Computer Package implements the real Workspace file surface; this
// Package deliberately implements none of it. This fake exists so the loader's
// behaviour can be proven against the contract rather than against a host.
import {
  workspaceRootKeyV1,
  type WorkspaceDeleteRequestV1,
  type WorkspaceEntryV1,
  type WorkspaceFilesV1,
  type WorkspaceGenerationV1,
  type WorkspaceListOutcomeV1,
  type WorkspaceListRequestV1,
  type WorkspacePathV1,
  type WorkspaceReadOutcomeV1,
  type WorkspaceRootV1,
  type WorkspaceStatOutcomeV1,
  type WorkspaceWriteOutcomeV1,
  type WorkspaceWriteRequestV1,
  type WorkspaceWriterV1,
} from "@frockbot/kernel-contracts";

export interface FakeWorkspaceSeedV1 {
  root: WorkspaceRootV1;
  path: string;
  text: string;
  writer: WorkspaceWriterV1;
  generationId?: string;
}

async function hashOf(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.slice().buffer as ArrayBuffer,
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

interface StoredFile {
  entry: WorkspaceEntryV1;
  bytes: Uint8Array;
}

/** A Workspace whose files live in a Map. Records every call it served. */
export class FakeWorkspace implements WorkspaceFilesV1 {
  readonly calls: string[] = [];
  #files = new Map<string, StoredFile>();
  #sequence = 0;
  /** Set to make `list` answer a failure, to exercise the unreadable path. */
  listFailure?: { status: "unavailable" | "refused"; reason: string };
  /** Entries per `list` page, so a caller's paging can be exercised. */
  listPageSize = 100;

  static async seeded(seeds: FakeWorkspaceSeedV1[]): Promise<FakeWorkspace> {
    const workspace = new FakeWorkspace();
    for (const seed of seeds) await workspace.seed(seed);
    return workspace;
  }

  async seed(seed: FakeWorkspaceSeedV1): Promise<WorkspaceGenerationV1> {
    const bytes = new TextEncoder().encode(seed.text);
    const generation: WorkspaceGenerationV1 = {
      schemaVersion: 1,
      generationId: seed.generationId ?? this.#nextGenerationId(),
      contentHash: await hashOf(bytes),
      size: bytes.byteLength,
      writer: seed.writer,
      writtenAt: new Date(0).toISOString(),
    };
    const path: WorkspacePathV1 = { root: seed.root, path: seed.path };
    this.#files.set(this.#key(path), { entry: { path, generation }, bytes });
    return generation;
  }

  read(path: WorkspacePathV1): Promise<WorkspaceReadOutcomeV1> {
    this.calls.push(`read:${path.path}`);
    const stored = this.#files.get(this.#key(path));
    if (!stored) {
      return Promise.resolve({ status: "not-found", reason: "no such file" });
    }
    return Promise.resolve({
      status: "ok",
      file: { ...stored.entry, bytes: stored.bytes },
    });
  }

  stat(path: WorkspacePathV1): Promise<WorkspaceStatOutcomeV1> {
    this.calls.push(`stat:${path.path}`);
    const stored = this.#files.get(this.#key(path));
    if (!stored) {
      return Promise.resolve({ status: "not-found", reason: "no such file" });
    }
    return Promise.resolve({ status: "ok", entry: stored.entry });
  }

  list(request: WorkspaceListRequestV1): Promise<WorkspaceListOutcomeV1> {
    this.calls.push(`list:${workspaceRootKeyV1(request.root)}`);
    if (this.listFailure) return Promise.resolve({ ...this.listFailure });
    const key = workspaceRootKeyV1(request.root);
    const all = [...this.#files.values()]
      .filter((stored) => workspaceRootKeyV1(stored.entry.path.root) === key)
      .map((stored) => stored.entry)
      .sort((left, right) => left.path.path.localeCompare(right.path.path));
    const start = request.cursor ? Number(request.cursor) : 0;
    const size = request.limit ?? this.listPageSize;
    const entries = all.slice(start, start + size);
    const next = start + entries.length;
    return Promise.resolve({
      status: "ok",
      entries,
      ...(next < all.length ? { cursor: String(next) } : {}),
    });
  }

  async write(
    request: WorkspaceWriteRequestV1,
  ): Promise<WorkspaceWriteOutcomeV1> {
    this.calls.push(`write:${request.path.path}`);
    const key = this.#key(request.path);
    const existing = this.#files.get(key);
    const seen = existing?.entry.generation.generationId ?? null;
    if (seen !== request.expectedGenerationId) {
      return {
        status: "conflict",
        reason: `expected generation ${request.expectedGenerationId ?? "none"}`,
      };
    }
    const generation: WorkspaceGenerationV1 = {
      schemaVersion: 1,
      generationId: this.#nextGenerationId(),
      contentHash: await hashOf(request.bytes),
      size: request.bytes.byteLength,
      writer: request.writer,
      writtenAt: new Date(0).toISOString(),
    };
    this.#files.set(key, {
      entry: { path: request.path, generation },
      bytes: request.bytes,
    });
    return { status: "ok", generation };
  }

  delete(request: WorkspaceDeleteRequestV1): Promise<WorkspaceWriteOutcomeV1> {
    this.calls.push(`delete:${request.path.path}`);
    const key = this.#key(request.path);
    const existing = this.#files.get(key);
    if (!existing) {
      return Promise.resolve({ status: "not-found", reason: "no such file" });
    }
    this.#files.delete(key);
    return Promise.resolve({
      status: "ok",
      generation: existing.entry.generation,
    });
  }

  #key(path: WorkspacePathV1): string {
    return `${workspaceRootKeyV1(path.root)}|${path.path}`;
  }

  #nextGenerationId(): string {
    this.#sequence += 1;
    return `1970-01-01T00:00:00.000Z:${String(this.#sequence).padStart(16, "0")}`;
  }
}

export function skillMarkdown(
  name: string,
  description: string,
  body: string,
): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}
