import type { MemoryBucket, MemoryScope } from "./types.js";

export interface DocumentMeta {
  documentHash?: string;
  hashes: Record<string, string>;
  vectorIds: string[];
}

function fileKey(scope: MemoryScope, path: string): string {
  return `${scope.storagePrefix}/files/${path}`;
}

function metaKey(scope: MemoryScope, path: string): string {
  return `${scope.storagePrefix}/meta/${path}.json`;
}

export class MemoryStorage {
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
