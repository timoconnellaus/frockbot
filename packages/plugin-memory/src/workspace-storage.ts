import type { ComputerDirectory } from "../../computer-core/src/core.js";
import type { DocumentMeta, MemoryDocumentStore } from "./storage.js";
import type { MemoryScope, MemoryTier } from "./types.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const EMPTY_META: DocumentMeta = { hashes: {}, vectorIds: [] };

function validMeta(value: unknown): value is DocumentMeta {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const meta = value as Partial<DocumentMeta>;
  return (
    typeof meta.hashes === "object" &&
    meta.hashes !== null &&
    !Array.isArray(meta.hashes) &&
    Object.values(meta.hashes).every((hash) => typeof hash === "string") &&
    (meta.documentHash === undefined ||
      typeof meta.documentHash === "string") &&
    Array.isArray(meta.vectorIds) &&
    meta.vectorIds.every((id) => typeof id === "string")
  );
}

function metaPath(path: string): string {
  return `.index/${path}.json`;
}

/** Stores canonical Markdown and derived index metadata on Computer disk. */
export class WorkspaceMemoryDocumentStore implements MemoryDocumentStore {
  constructor(
    private readonly directories: Record<MemoryTier, ComputerDirectory>,
    private readonly close?: () => Promise<void>,
  ) {}

  private directory(scope: MemoryScope): ComputerDirectory {
    return this.directories[scope.tier];
  }

  async readContent(scope: MemoryScope, path: string): Promise<string | null> {
    const file = await this.directory(scope).readFile(path);
    return file ? decoder.decode(file.bytes) : null;
  }

  async writeContent(
    scope: MemoryScope,
    path: string,
    content: string,
  ): Promise<void> {
    await this.directory(scope).writeFile(path, encoder.encode(content), {
      mediaType: "text/markdown; charset=utf-8",
    });
  }

  async deleteContent(scope: MemoryScope, path: string): Promise<void> {
    await this.directory(scope).deleteFile(path);
  }

  async readMeta(scope: MemoryScope, path: string): Promise<DocumentMeta> {
    const file = await this.directory(scope).readFile(metaPath(path));
    if (!file) return { ...EMPTY_META };
    try {
      const value: unknown = JSON.parse(decoder.decode(file.bytes));
      return validMeta(value) ? value : { ...EMPTY_META };
    } catch {
      return { ...EMPTY_META };
    }
  }

  async writeMeta(
    scope: MemoryScope,
    path: string,
    meta: DocumentMeta,
  ): Promise<void> {
    await this.directory(scope).writeFile(
      metaPath(path),
      encoder.encode(JSON.stringify(meta)),
      { mediaType: "application/json" },
    );
  }

  async deleteMeta(scope: MemoryScope, path: string): Promise<void> {
    await this.directory(scope).deleteFile(metaPath(path));
  }

  async listPaths(scope: MemoryScope): Promise<string[]> {
    const paths: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.directory(scope).listFiles({
        limit: 1000,
        cursor,
      });
      paths.push(
        ...page.files
          .map((file: { path: string }) => file.path)
          .filter((path: string) => !path.startsWith(".index/")),
      );
      cursor = page.cursor;
    } while (cursor);
    return paths;
  }

  async dispose(): Promise<void> {
    await this.close?.();
  }
}
