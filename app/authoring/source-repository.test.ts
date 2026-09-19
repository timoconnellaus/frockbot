import { describe, expect, test } from "bun:test";
import { APPLET_BUILD_LIMITS } from "@frockbot/applets/build-contract";
import {
  appletSourcePathV1,
  appletsSourceRootV1,
} from "@frockbot/applets/root";
import type {
  WorkspaceFailureStatusV1,
  WorkspaceFilesV1,
  WorkspacePathV1,
  WorkspaceRootV1,
  WorkspaceWriteRequestV1,
} from "@frockbot/core/contracts";
import { appletAuthoringSourceRepositoryV1 } from "../applets-host/records.js";
import { pluginAuthoringSourceRepositoryV1 } from "../plugins/authoring.js";
import { pluginSourcePathV1, pluginsSourceRootV1 } from "../plugins/root.js";

const USER = "user-1";
const APPLET = `${USER}.${"a".repeat(32)}`;
const WRITER = {
  kind: "bot" as const,
  botId: "bot-1",
  sessionId: "session-1",
  turnId: "turn-1",
  runId: "run-1",
};

async function rejectionMessage(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (error) {
    if (error instanceof Error) return error.message;
    throw error;
  }
  throw new Error("the action unexpectedly succeeded");
}

function workspace(root: WorkspaceRootV1) {
  const files = new Map<string, { bytes: Uint8Array; generationId: string }>();
  const writes: WorkspaceWriteRequestV1[] = [];
  let generation = 0;
  let beforeNextWrite: (() => void) | undefined;
  let listFailure:
    { status: WorkspaceFailureStatusV1; reason: string } | undefined;
  const readFailures = new Map<
    string,
    { status: WorkspaceFailureStatusV1; reason: string }
  >();
  const entry = (
    path: string,
    held: { bytes: Uint8Array; generationId: string },
  ) => ({
    path: { root, path } as WorkspacePathV1,
    generation: {
      schemaVersion: 1 as const,
      generationId: held.generationId,
      contentHash: "0".repeat(64),
      size: held.bytes.byteLength,
      writer: { kind: "unattributed" as const },
      writtenAt: "2026-09-19T00:00:00.000Z",
    },
  });
  const set = (path: string, text: string) => {
    generation += 1;
    files.set(path, {
      bytes: new TextEncoder().encode(text),
      generationId: `generation-${generation}`,
    });
  };
  const setBytes = (path: string, bytes: Uint8Array) => {
    generation += 1;
    files.set(path, { bytes, generationId: `generation-${generation}` });
  };
  const api: WorkspaceFilesV1 = {
    async read(path) {
      const failure = readFailures.get(path.path);
      if (failure) return failure;
      const held = files.get(path.path);
      return held
        ? {
            status: "ok",
            file: { ...entry(path.path, held), bytes: held.bytes },
          }
        : { status: "not-found", reason: "no such file" };
    },
    async stat(path) {
      const held = files.get(path.path);
      return held
        ? { status: "ok", entry: entry(path.path, held) }
        : { status: "not-found", reason: "no such file" };
    },
    async list(request) {
      if (listFailure) return listFailure;
      return {
        status: "ok",
        entries: [...files]
          .filter(([path]) => path.startsWith(request.prefix ?? ""))
          .slice(0, request.limit)
          .map(([path, held]) => entry(path, held)),
      };
    },
    async write(request) {
      writes.push(request);
      beforeNextWrite?.();
      beforeNextWrite = undefined;
      const currentGenerationId =
        files.get(request.path.path)?.generationId ?? null;
      if (currentGenerationId !== request.expectedGenerationId) {
        return { status: "conflict", reason: "the file moved on" };
      }
      generation += 1;
      const held = {
        bytes: request.bytes,
        generationId: `generation-${generation}`,
      };
      files.set(request.path.path, held);
      return {
        status: "ok",
        generation: entry(request.path.path, held).generation,
      };
    },
    async delete() {
      return { status: "refused", reason: "not used" };
    },
  };
  return {
    api,
    set,
    setBytes,
    writes,
    failList(status: WorkspaceFailureStatusV1, reason: string) {
      listFailure = { status, reason };
    },
    failRead(path: string, status: WorkspaceFailureStatusV1, reason: string) {
      readFailures.set(path, { status, reason });
    },
    mutateBeforeNextWrite(path: string, text: string) {
      beforeNextWrite = () => set(path, text);
    },
  };
}

const adapters = [
  {
    name: "Applet",
    artifactId: APPLET,
    neighborId: `${USER}.${"b".repeat(32)}`,
    root: appletsSourceRootV1(USER),
    sourcePath: appletSourcePathV1,
    repository: appletAuthoringSourceRepositoryV1,
    sourceMediaType: "text/plain; charset=utf-8",
    emptyFailure: `${APPLET} has no source. Call applet_create, or write server.ts, ui.tsx and applet.json with applet_write_file.`,
  },
  {
    name: "Plugin",
    artifactId: "notes",
    neighborId: "notes-2",
    root: pluginsSourceRootV1(USER),
    sourcePath: pluginSourcePathV1,
    repository: pluginAuthoringSourceRepositoryV1,
    sourceMediaType: "text/typescript",
    emptyFailure:
      "notes has no source. Call plugin_create, or write plugin.ts and plugin.json with plugin_write_file.",
  },
] as const;

describe("Bot-authored source repositories", () => {
  for (const adapter of adapters) {
    test(`${adapter.name} uses the shared ordered, prefix-safe CRUD contract`, async () => {
      const store = workspace(adapter.root);
      const prefix = adapter.sourcePath(adapter.artifactId);
      store.set(`${prefix}z.ts`, "export const z = 1;");
      store.set(`${adapter.sourcePath(adapter.neighborId)}ignored.ts`, "no");
      store.set(`${prefix}a.json`, "{}");
      const repository = adapter.repository(store.api, USER);

      expect(await repository.list(adapter.artifactId)).toEqual({
        entries: [
          { path: "a.json", size: 2 },
          { path: "z.ts", size: 19 },
        ],
      });
      expect(await repository.readBuildSource(adapter.artifactId)).toEqual({
        files: [
          { path: "a.json", text: "{}" },
          { path: "z.ts", text: "export const z = 1;" },
        ],
      });

      await repository.write(adapter.artifactId, "z.ts", "changed", WRITER);
      await repository.write(adapter.artifactId, "new.ts", "new", WRITER);
      await repository.write(adapter.artifactId, "config.json", "{}", WRITER);
      expect(store.writes.map((write) => write.expectedGenerationId)).toEqual([
        "generation-1",
        null,
        null,
      ]);
      expect(store.writes.map((write) => write.mediaType)).toEqual([
        adapter.sourceMediaType,
        adapter.sourceMediaType,
        "application/json",
      ]);
      expect(store.writes.map((write) => write.path.path)).toEqual([
        `${prefix}z.ts`,
        `${prefix}new.ts`,
        `${prefix}config.json`,
      ]);
    });

    test(`${adapter.name} enforces the shared build-source bounds`, async () => {
      const emptyStore = workspace(adapter.root);
      const emptyRepository = adapter.repository(emptyStore.api, USER);
      expect(await emptyRepository.readBuildSource(adapter.artifactId)).toEqual(
        {
          failure: adapter.emptyFailure,
        },
      );

      const countStore = workspace(adapter.root);
      const prefix = adapter.sourcePath(adapter.artifactId);
      for (let index = 0; index <= APPLET_BUILD_LIMITS.files; index += 1) {
        countStore.set(`${prefix}${index}.ts`, "x");
      }
      expect(
        await adapter
          .repository(countStore.api, USER)
          .readBuildSource(adapter.artifactId),
      ).toEqual({
        failure: `${adapter.artifactId} has more than ${APPLET_BUILD_LIMITS.files} source files; the build service takes no more.`,
      });

      const sizeStore = workspace(adapter.root);
      sizeStore.set(
        `${prefix}large.ts`,
        "x".repeat(APPLET_BUILD_LIMITS.fileText + 1),
      );
      expect(
        await adapter
          .repository(sizeStore.api, USER)
          .readBuildSource(adapter.artifactId),
      ).toEqual({
        failure: `${adapter.artifactId}'s source is over the ${APPLET_BUILD_LIMITS.sourceBytes}-byte ceiling the build service accepts.`,
      });

      const aggregateStore = workspace(adapter.root);
      aggregateStore.set(
        `${prefix}first.ts`,
        "x".repeat(APPLET_BUILD_LIMITS.fileText),
      );
      aggregateStore.set(
        `${prefix}second.ts`,
        "x".repeat(APPLET_BUILD_LIMITS.fileText),
      );
      aggregateStore.set(`${prefix}third.ts`, "x");
      expect(
        await adapter
          .repository(aggregateStore.api, USER)
          .readBuildSource(adapter.artifactId),
      ).toEqual({
        failure: `${adapter.artifactId}'s source is over the ${APPLET_BUILD_LIMITS.sourceBytes}-byte ceiling the build service accepts.`,
      });

      const exactStore = workspace(adapter.root);
      exactStore.set(
        `${prefix}first.ts`,
        "x".repeat(APPLET_BUILD_LIMITS.fileText),
      );
      exactStore.set(
        `${prefix}second.ts`,
        "x".repeat(APPLET_BUILD_LIMITS.fileText),
      );
      const exact = await adapter
        .repository(exactStore.api, USER)
        .readBuildSource(adapter.artifactId);
      expect("files" in exact).toBe(true);
      if ("files" in exact) {
        expect(exact.files.map((file) => file.text.length)).toEqual([
          APPLET_BUILD_LIMITS.fileText,
          APPLET_BUILD_LIMITS.fileText,
        ]);
      }
    });

    test(`${adapter.name} preserves exact store failures and write conflicts`, async () => {
      const listStore = workspace(adapter.root);
      listStore.failList("unavailable", "store is offline");
      expect(
        await adapter.repository(listStore.api, USER).list(adapter.artifactId),
      ).toEqual({
        failure: `the ${adapter.name}'s source could not be listed: unavailable — store is offline`,
      });

      const prefix = adapter.sourcePath(adapter.artifactId);
      const readStore = workspace(adapter.root);
      readStore.failRead(
        `${prefix}source.ts`,
        "refused",
        "the caller cannot read it",
      );
      expect(
        await rejectionMessage(() =>
          adapter
            .repository(readStore.api, USER)
            .read(adapter.artifactId, "source.ts"),
        ),
      ).toBe('"source.ts" is refused');

      const writeStore = workspace(adapter.root);
      writeStore.set(`${prefix}source.ts`, "original");
      writeStore.mutateBeforeNextWrite(`${prefix}source.ts`, "concurrent");
      expect(
        await rejectionMessage(() =>
          adapter
            .repository(writeStore.api, USER)
            .write(adapter.artifactId, "source.ts", "replacement", WRITER),
        ),
      ).toBe('"source.ts" could not be written: conflict — the file moved on');
      expect(writeStore.writes).toHaveLength(1);
      expect(writeStore.writes[0]?.expectedGenerationId).toBe("generation-1");
    });
  }

  test("adapters retain their intentional UTF-8 decoding policies", async () => {
    const invalidUtf8 = new Uint8Array([0xc3, 0x28]);
    const appletStore = workspace(appletsSourceRootV1(USER));
    appletStore.setBytes(`${appletSourcePathV1(APPLET)}server.ts`, invalidUtf8);
    expect(
      await appletAuthoringSourceRepositoryV1(appletStore.api, USER).read(
        APPLET,
        "server.ts",
      ),
    ).toBe("�(");

    const pluginStore = workspace(pluginsSourceRootV1(USER));
    pluginStore.setBytes(
      `${pluginSourcePathV1("notes")}plugin.ts`,
      invalidUtf8,
    );
    await expect(
      pluginAuthoringSourceRepositoryV1(pluginStore.api, USER).read(
        "notes",
        "plugin.ts",
      ),
    ).rejects.toThrow();
  });
});
