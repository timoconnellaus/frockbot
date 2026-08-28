import { describe, expect, test } from "bun:test";
import type {
  ComputerDirectory,
  ComputerFile,
} from "../../computer-core/src/core.js";
import { createMemoryScopes } from "./scopes.js";
import { WorkspaceMemoryDocumentStore } from "./workspace-storage.js";

function directory(): ComputerDirectory {
  const files = new Map<string, ComputerFile>();
  let version = 0;
  return {
    readFile: (path) => Promise.resolve(files.get(path) ?? null),
    writeFile: (path, bytes, options) => {
      const next = {
        path,
        bytes,
        size: bytes.byteLength,
        version: String(++version),
        mediaType: options?.mediaType,
      };
      files.set(path, next);
      return Promise.resolve(next);
    },
    deleteFile: (path) => Promise.resolve(files.delete(path)),
    listFiles: () =>
      Promise.resolve({
        files: [...files.values()],
      }),
  };
}

describe("WorkspaceMemoryDocumentStore", () => {
  test("stores canonical Markdown and hides derived index metadata from listings", async () => {
    const scopes = createMemoryScopes("owner", "bot-1");
    const store = new WorkspaceMemoryDocumentStore({
      agent: directory(),
      global: directory(),
    });

    await store.writeContent(scopes.agent, "profile.md", "Remember this");
    await store.writeMeta(scopes.agent, "profile.md", {
      documentHash: "hash",
      hashes: { chunk: "hash" },
      vectorIds: ["vector"],
    });

    expect(await store.readContent(scopes.agent, "profile.md")).toBe(
      "Remember this",
    );
    expect(await store.readMeta(scopes.agent, "profile.md")).toMatchObject({
      documentHash: "hash",
      vectorIds: ["vector"],
    });
    expect(await store.listPaths(scopes.agent)).toEqual(["profile.md"]);
  });
});
