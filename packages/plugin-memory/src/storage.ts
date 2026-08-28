import type { MemoryBucket, MemoryScope } from "./types.js";

export interface DocumentMeta {
  documentHash?: string;
  hashes: Record<string, string>;
  vectorIds: string[];
}

export interface MemoryDocumentStore {
  readContent(scope: MemoryScope, path: string): Promise<string | null>;
  writeContent(
    scope: MemoryScope,
    path: string,
    content: string,
  ): Promise<void>;
  deleteContent(scope: MemoryScope, path: string): Promise<void>;
  readMeta(scope: MemoryScope, path: string): Promise<DocumentMeta>;
  writeMeta(
    scope: MemoryScope,
    path: string,
    meta: DocumentMeta,
  ): Promise<void>;
  deleteMeta(scope: MemoryScope, path: string): Promise<void>;
  listPaths(scope: MemoryScope): Promise<string[]>;
  dispose?(): Promise<void>;
}

/**
 * Keeps derived index metadata process-local so it shares a durability domain
 * with an in-process vector index: a fresh process sees empty meta and
 * re-embeds documents on their next write instead of skipping them.
 */
export class EphemeralIndexMetaStore implements MemoryDocumentStore {
  private readonly meta = new Map<string, DocumentMeta>();

  constructor(private readonly store: MemoryDocumentStore) {}

  private key(scope: MemoryScope, path: string): string {
    return `${scope.vectorNamespace}\0${path}`;
  }

  readContent(scope: MemoryScope, path: string): Promise<string | null> {
    return this.store.readContent(scope, path);
  }

  writeContent(scope: MemoryScope, path: string, content: string) {
    return this.store.writeContent(scope, path, content);
  }

  deleteContent(scope: MemoryScope, path: string): Promise<void> {
    return this.store.deleteContent(scope, path);
  }

  readMeta(scope: MemoryScope, path: string): Promise<DocumentMeta> {
    return Promise.resolve(
      this.meta.get(this.key(scope, path)) ?? { hashes: {}, vectorIds: [] },
    );
  }

  writeMeta(scope: MemoryScope, path: string, meta: DocumentMeta) {
    this.meta.set(this.key(scope, path), meta);
    return Promise.resolve();
  }

  deleteMeta(scope: MemoryScope, path: string): Promise<void> {
    this.meta.delete(this.key(scope, path));
    return Promise.resolve();
  }

  listPaths(scope: MemoryScope): Promise<string[]> {
    return this.store.listPaths(scope);
  }

  dispose(): Promise<void> {
    return this.store.dispose?.() ?? Promise.resolve();
  }
}

function fileKey(scope: MemoryScope, path: string): string {
  return `${scope.storagePrefix}/files/${path}`;
}

function metaKey(scope: MemoryScope, path: string): string {
  return `${scope.storagePrefix}/meta/${path}.json`;
}

export class MemoryStorage implements MemoryDocumentStore {
  constructor(private readonly bucket: MemoryBucket) {}

  async readContent(scope: MemoryScope, path: string): Promise<string | null> {
    const object = await this.bucket.get(fileKey(scope, path));
    return object ? object.text() : null;
  }

  async writeContent(
    scope: MemoryScope,
    path: string,
    content: string,
  ): Promise<void> {
    await this.bucket.put(fileKey(scope, path), content, {
      httpMetadata: { contentType: "text/markdown; charset=utf-8" },
    });
  }

  async deleteContent(scope: MemoryScope, path: string): Promise<void> {
    await this.bucket.delete(fileKey(scope, path));
  }

  async readMeta(scope: MemoryScope, path: string): Promise<DocumentMeta> {
    const object = await this.bucket.get(metaKey(scope, path));
    if (!object) return { hashes: {}, vectorIds: [] };
    try {
      const parsed = await object.json<DocumentMeta>();
      if (
        !parsed ||
        typeof parsed.hashes !== "object" ||
        parsed.hashes === null ||
        Array.isArray(parsed.hashes) ||
        !Object.values(parsed.hashes).every(
          (hash) => typeof hash === "string",
        ) ||
        (parsed.documentHash !== undefined &&
          typeof parsed.documentHash !== "string") ||
        !Array.isArray(parsed.vectorIds) ||
        !parsed.vectorIds.every((id) => typeof id === "string")
      ) {
        return { hashes: {}, vectorIds: [] };
      }
      return parsed;
    } catch {
      return { hashes: {}, vectorIds: [] };
    }
  }

  async writeMeta(
    scope: MemoryScope,
    path: string,
    meta: DocumentMeta,
  ): Promise<void> {
    await this.bucket.put(metaKey(scope, path), JSON.stringify(meta), {
      httpMetadata: { contentType: "application/json" },
    });
  }

  async deleteMeta(scope: MemoryScope, path: string): Promise<void> {
    await this.bucket.delete(metaKey(scope, path));
  }

  async listPaths(scope: MemoryScope): Promise<string[]> {
    const prefix = `${scope.storagePrefix}/files/`;
    const paths: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.bucket.list({ prefix, cursor });
      for (const object of page.objects) {
        paths.push(object.key.slice(prefix.length));
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return paths;
  }
}
