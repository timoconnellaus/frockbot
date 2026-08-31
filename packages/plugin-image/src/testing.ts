// Test doubles for this Package, and nothing production imports.
//
// The Workspace fake is local rather than borrowed from `plugin-skills`: that
// one seeds text, and everything here is bytes. It records every call so a
// test can prove reconciliation read the store and never the model.
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
  type WorkspaceStatOutcomeV1,
  type WorkspaceWriteOutcomeV1,
  type WorkspaceWriteRequestV1,
} from "@frockbot/kernel-contracts";
import { sha256HexV1 } from "./bytes.js";
import type { ImageModelInputV1, ImageModelV1 } from "./model.js";

interface StoredFile {
  entry: WorkspaceEntryV1;
  bytes: Uint8Array;
}

/** An in-memory `WorkspaceFilesV1` over bytes. Records every call it served. */
export class FakeImageWorkspace implements WorkspaceFilesV1 {
  readonly calls: string[] = [];
  #files = new Map<string, StoredFile>();
  #sequence = 0;
  /** Set to make the next `write` answer this outcome instead of storing. */
  nextWriteOutcome?: WorkspaceWriteOutcomeV1;

  #key(path: WorkspacePathV1): string {
    return `${workspaceRootKeyV1(path.root)}::${path.path}`;
  }

  #nextGenerationId(): string {
    this.#sequence += 1;
    return `gen-${String(this.#sequence).padStart(4, "0")}`;
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
    const key = workspaceRootKeyV1(request.root);
    const entries = [...this.#files.values()]
      .filter((stored) => workspaceRootKeyV1(stored.entry.path.root) === key)
      .map((stored) => stored.entry);
    return Promise.resolve({ status: "ok", entries });
  }

  async write(
    request: WorkspaceWriteRequestV1,
  ): Promise<WorkspaceWriteOutcomeV1> {
    this.calls.push(`write:${request.path.path}`);
    const scripted = this.nextWriteOutcome;
    if (scripted) {
      this.nextWriteOutcome = undefined;
      return scripted;
    }
    const key = this.#key(request.path);
    const existing = this.#files.get(key);
    const seen = existing?.entry.generation.generationId ?? null;
    if (seen !== request.expectedGenerationId) {
      return { status: "conflict", reason: "unexpected generation" };
    }
    const generation: WorkspaceGenerationV1 = {
      schemaVersion: 1,
      generationId: this.#nextGenerationId(),
      contentHash: await sha256HexV1(request.bytes),
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
    this.#files.delete(this.#key(request.path));
    return Promise.resolve({
      status: "refused",
      reason: "the fake does not tombstone",
    });
  }
}

/** The smallest valid PNG header this Package can decode, at a given size. */
export function fakePngBytesV1(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(64);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  // IHDR length (13) and type.
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}

/** An image model that answers fixed bytes and counts every call. */
export class FakeImageModel implements ImageModelV1 {
  readonly calls: Array<{ model: string; input: ImageModelInputV1 }> = [];
  #bytes: Uint8Array;
  /** Set to make the next `run` reject with this message. */
  failure?: string;

  constructor(bytes: Uint8Array = fakePngBytesV1(1024, 1024)) {
    this.#bytes = bytes;
  }

  run(model: string, input: ImageModelInputV1): Promise<ArrayBuffer> {
    this.calls.push({ model, input });
    if (this.failure) return Promise.reject(new Error(this.failure));
    return Promise.resolve(this.#bytes.slice().buffer as ArrayBuffer);
  }
}
