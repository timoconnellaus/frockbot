import { describe, expect, test } from "bun:test";
import {
  appletCompositionMembersV1,
  appletDistPathV1,
  appletMembersDifferV1,
  createAppletCapabilityHostV1,
  decodeAppletBuildManifestV1,
  resolveAppletCompositionV1,
  APPLET_DIRECTORY_REVISION_SEEN_KEY,
  type AppletInstanceBindingV1,
  type AppletUserDirectoryV1,
} from "./backend-applets.js";
import {
  compositionArtifactSetHashV1,
  decodeCompositionGenerationV1,
  type CompositionGenerationV1,
} from "@frockbot/kernel-composition/generation";
import {
  APPLET_FOCUSED_KEY,
  type AppletGenerationV1,
} from "@frockbot/kernel-do";

const USER = "user-42";
const APPLET = `${USER}.${"a".repeat(32)}`;
const OTHER = `${USER}.${"b".repeat(32)}`;

function tool(name: string) {
  return {
    name,
    description: `The ${name} tool`,
    inputSchema: { type: "object" },
  };
}

async function bootstrap(): Promise<CompositionGenerationV1> {
  const members = [
    {
      packageId: "shell",
      specifier: "@frockbot/plugin-shell",
      version: "1.0.0",
      manifestHash: "c".repeat(64),
      provenance: {
        kind: "first-party" as const,
        packageId: "shell",
        version: "1.0.0",
      },
    },
  ];
  const artifactSetHash = await compositionArtifactSetHashV1(members);
  return decodeCompositionGenerationV1({
    schemaVersion: 1,
    generationId: `2026-09-03T00:00:00.000Z:${artifactSetHash.slice(0, 16)}`,
    artifactSetHash,
    createdAt: "2026-09-03T00:00:00.000Z",
    origin: { kind: "bootstrap" },
    members,
    status: "active",
  });
}

function memoryStorage() {
  const values = new Map<string, unknown>();
  return {
    values,
    get: <T>(key: string) => Promise.resolve(values.get(key) as T | undefined),
    put: (entries: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(entries))
        values.set(key, value);
      return Promise.resolve();
    },
  };
}

describe("Applet Composition members", () => {
  test("members are ordered by Applet id and carry their provenance", () => {
    const members = appletCompositionMembersV1([
      {
        appletId: OTHER,
        generationId: "g2",
        tools: [tool("b_tool")],
        provenance: { kind: "user" },
      },
      {
        appletId: APPLET,
        generationId: "g1",
        tools: [tool("a_tool")],
        provenance: {
          kind: "bot",
          botId: "bot-1",
          sessionId: `${USER}:bot-1`,
          turnId: "turn-1",
        },
      },
    ]);
    expect(members.map((member) => member.appletId)).toEqual([APPLET, OTHER]);
    expect(members[0]).toMatchObject({ kind: "applet", generationId: "g1" });
    expect(members[0]?.provenance).toMatchObject({
      kind: "bot",
      packageId: APPLET,
      version: "g1",
      botId: "bot-1",
    });
    expect(members[1]?.provenance).toMatchObject({ kind: "user" });
  });

  test("the artifact set hash moves with the Applet generation", async () => {
    const members = [
      {
        packageId: "shell",
        specifier: "@frockbot/plugin-shell",
        version: "1.0.0",
        manifestHash: "c".repeat(64),
        provenance: {
          kind: "first-party" as const,
          packageId: "shell",
          version: "1.0.0",
        },
      },
    ];
    const withoutApplets = await compositionArtifactSetHashV1(members);
    const first = appletCompositionMembersV1([
      {
        appletId: APPLET,
        generationId: "g1",
        tools: [tool("a_tool")],
        provenance: { kind: "user" },
      },
    ]);
    const second = appletCompositionMembersV1([
      {
        appletId: APPLET,
        generationId: "g2",
        tools: [tool("a_tool")],
        provenance: { kind: "user" },
      },
    ]);
    // A generation with no Applets hashes exactly as it always did.
    expect(await compositionArtifactSetHashV1(members, [])).toBe(
      withoutApplets,
    );
    expect(await compositionArtifactSetHashV1(members, first)).not.toBe(
      withoutApplets,
    );
    expect(await compositionArtifactSetHashV1(members, first)).not.toBe(
      await compositionArtifactSetHashV1(members, second),
    );
  });

  test("a changed tool set, generation, or Applet is a different member set", () => {
    const base = appletCompositionMembersV1([
      {
        appletId: APPLET,
        generationId: "g1",
        tools: [tool("a_tool")],
        provenance: { kind: "user" },
      },
    ]);
    expect(appletMembersDifferV1(base, base)).toBe(false);
    expect(appletMembersDifferV1(base, [])).toBe(true);
    expect(
      appletMembersDifferV1(
        base,
        appletCompositionMembersV1([
          {
            appletId: APPLET,
            generationId: "g2",
            tools: [tool("a_tool")],
            provenance: { kind: "user" },
          },
        ]),
      ),
    ).toBe(true);
    expect(
      appletMembersDifferV1(
        base,
        appletCompositionMembersV1([
          {
            appletId: APPLET,
            generationId: "g1",
            tools: [tool("a_tool"), tool("b_tool")],
            provenance: { kind: "user" },
          },
        ]),
      ),
    ).toBe(true);
  });
});

describe("Applet Composition resolution", () => {
  async function resolveWith(
    applets: {
      appletId: string;
      generationId: string;
      tools: ReturnType<typeof tool>[];
      provenance: { kind: "user" };
    }[],
    options: {
      current?: CompositionGenerationV1;
      revision?: number;
      storage?: ReturnType<typeof memoryStorage>;
    } = {},
  ) {
    const current = options.current ?? (await bootstrap());
    const storage = options.storage ?? memoryStorage();
    const proposed: CompositionGenerationV1[] = [];
    const generation = await resolveAppletCompositionV1({
      directory: {
        compositionInput: () =>
          Promise.resolve({ revision: options.revision ?? 1, applets }),
      },
      composition: {
        current: () => Promise.resolve(current),
        propose: (candidate) => {
          proposed.push(candidate);
          return Promise.resolve();
        },
      },
      storage,
      origin: { kind: "user-install", userId: USER },
    });
    return { generation, proposed, storage, current };
  }

  test("a published Applet's tools appear in the Bot's next generation", async () => {
    const { generation, proposed, storage } = await resolveWith([
      {
        appletId: APPLET,
        generationId: "g1",
        tools: [tool("add_todo")],
        provenance: { kind: "user" },
      },
    ]);
    expect(generation).toBeDefined();
    expect(proposed).toHaveLength(1);
    expect(proposed[0]?.applets?.[0]).toMatchObject({
      appletId: APPLET,
      generationId: "g1",
    });
    expect(proposed[0]?.applets?.[0]?.tools.map((entry) => entry.name)).toEqual(
      ["add_todo"],
    );
    // The Package members are carried through unchanged.
    expect(proposed[0]?.members.map((member) => member.packageId)).toEqual([
      "shell",
    ]);
    expect(storage.values.get(APPLET_DIRECTORY_REVISION_SEEN_KEY)).toBe(1);
  });

  test("an unchanged directory proposes nothing", async () => {
    const first = await resolveWith([
      {
        appletId: APPLET,
        generationId: "g1",
        tools: [tool("add_todo")],
        provenance: { kind: "user" },
      },
    ]);
    const again = await resolveWith(
      [
        {
          appletId: APPLET,
          generationId: "g1",
          tools: [tool("add_todo")],
          provenance: { kind: "user" },
        },
      ],
      { current: first.proposed[0], storage: first.storage, revision: 1 },
    );
    expect(again.generation).toBeUndefined();
    expect(again.proposed).toEqual([]);
  });

  test("a deleted Applet's tools disappear at the next resolution", async () => {
    const published = await resolveWith([
      {
        appletId: APPLET,
        generationId: "g1",
        tools: [tool("add_todo")],
        provenance: { kind: "user" },
      },
    ]);
    const afterDelete = await resolveWith([], {
      current: published.proposed[0],
      storage: published.storage,
      revision: 2,
    });
    expect(afterDelete.proposed).toHaveLength(1);
    expect(afterDelete.proposed[0]?.applets).toBeUndefined();
    // The pinned generation the in-flight Turn holds is untouched: a new
    // generation was proposed beside it, never a mutation of it.
    expect(published.proposed[0]?.applets?.[0]?.appletId).toBe(APPLET);
    expect(afterDelete.proposed[0]?.parentGenerationId).toBe(
      published.proposed[0]?.generationId,
    );
  });
});

describe("Applet build manifest", () => {
  test("a well-formed manifest decodes; anything else is refused", () => {
    const manifest = {
      contract: 1,
      tools: [tool("add_todo")],
      hashes: { server: "a".repeat(64), ui: "b".repeat(64) },
    };
    expect(decodeAppletBuildManifestV1(manifest)).toMatchObject({
      contract: 1,
    });
    expect(() =>
      decodeAppletBuildManifestV1({ ...manifest, contract: 2 }),
    ).toThrow(/contract/);
    expect(() =>
      decodeAppletBuildManifestV1({ ...manifest, extra: true }),
    ).toThrow(/invalid fields/);
    expect(() =>
      decodeAppletBuildManifestV1({
        ...manifest,
        hashes: { server: "short", ui: "b".repeat(64) },
      }),
    ).toThrow(/server/);
    expect(() =>
      decodeAppletBuildManifestV1({
        ...manifest,
        tools: [tool("add_todo"), tool("add_todo")],
      }),
    ).toThrow(/duplicate/);
  });

  test("the built files are read from the Applets Package's declared root", () => {
    expect(appletDistPathV1(USER, APPLET, "dist/server.js")).toEqual({
      root: {
        kind: "package-declared",
        userId: USER,
        packageId: "applets",
        rootId: "source",
      },
      path: `${APPLET}/dist/server.js`,
    });
  });
});

describe("ctx.applets", () => {
  function host(options: {
    files?: Record<string, string>;
    directory?: Partial<AppletUserDirectoryV1>;
    instance?: Partial<AppletInstanceBindingV1>;
    storage?: ReturnType<typeof memoryStorage>;
  }) {
    const storage = options.storage ?? memoryStorage();
    const recorded: unknown[] = [];
    const artifacts: Record<string, string> = {};
    const directory: AppletUserDirectoryV1 = {
      list: () =>
        Promise.resolve({
          revision: 1,
          applets: [
            {
              appletId: APPLET,
              displayName: "Todo",
              status: "published" as const,
              currentGenerationId: "g1",
              tools: ["add_todo"],
              createdAt: "2026-09-03T00:00:00.000Z",
            },
          ],
        }),
      compositionInput: () => Promise.resolve({ revision: 1, applets: [] }),
      create: () =>
        Promise.resolve({
          appletId: APPLET,
          displayName: "Todo",
          status: "draft" as const,
          tools: [],
          createdAt: "2026-09-03T00:00:00.000Z",
        }),
      recordGeneration: (input) => {
        recorded.push(input);
        return Promise.resolve({
          appletId: input.appletId,
          displayName: "Todo",
          status: "published" as const,
          currentGenerationId: input.generationId,
          tools: input.tools.map((entry) => entry.name),
          createdAt: "2026-09-03T00:00:00.000Z",
        });
      },
      delete: () =>
        Promise.resolve({
          appletId: APPLET,
          displayName: "Todo",
          status: "deleted" as const,
          tools: [],
          createdAt: "2026-09-03T00:00:00.000Z",
        }),
      ...options.directory,
    };
    const instance: AppletInstanceBindingV1 = {
      publish: (input) =>
        Promise.resolve({
          status: "active" as const,
          generationId: input.generation.generationId,
          tools: input.generation.tools.map((entry) => entry.name),
        }),
      revert: (input) =>
        Promise.resolve({
          status: "active" as const,
          generationId: input.generation.generationId,
          tools: input.generation.tools.map((entry) => entry.name),
        }),
      invokeTool: () => Promise.resolve({ status: "ok" as const, content: "" }),
      read: () => Promise.resolve({ generations: [] as AppletGenerationV1[] }),
      ...options.instance,
    };
    return {
      storage,
      recorded,
      artifacts,
      host: createAppletCapabilityHostV1({
        userId: USER,
        botId: "bot-1",
        storage,
        directory,
        instanceFor: () => instance,
        artifacts: {
          putPackageArtifact: (hash, module) => {
            artifacts[hash] = module;
            return Promise.resolve();
          },
          putPackageUiArtifact: (hash, html) => {
            artifacts[hash] = html;
            return Promise.resolve();
          },
        },
        workspace: {
          read: (path) => {
            const bytes = options.files?.[path.path];
            return Promise.resolve(
              bytes === undefined
                ? {
                    status: "not-found" as const,
                    reason: "no such file",
                  }
                : {
                    status: "ok" as const,
                    file: {
                      path: path.path,
                      size: bytes.length,
                      contentHash: "0".repeat(64),
                      writer: { kind: "unattributed" as const },
                      bytes: new TextEncoder().encode(bytes),
                    },
                  },
            ) as never;
          },
          list: () => Promise.resolve({ status: "ok", entries: [] }) as never,
          stat: () =>
            Promise.resolve({ status: "not-found", reason: "" }) as never,
        },
        composition: {
          current: () => bootstrap(),
          lastKnownGood: () => bootstrap(),
          propose: () => Promise.resolve(),
        },
      }),
    };
  }

  const scope = {
    sessionId: `${USER}:bot-1`,
    runId: "run-1",
    turnId: "turn-1",
    effectId: "applet:turn-1:publish:x",
  };

  test("create mints an entry and focuses it", async () => {
    const { host: capability, storage } = host({});
    const created = await capability.create({ displayName: "Todo" }, scope);
    expect(created.appletId).toBe(APPLET);
    expect(await capability.readFocused()).toMatchObject({ appletId: APPLET });
    expect(storage.values.has(APPLET_FOCUSED_KEY)).toBe(true);
  });

  test("publish refuses an Applet that has not been built", async () => {
    const { host: capability } = host({ files: {} });
    const outcome = await capability.publish({ appletId: APPLET }, scope);
    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" && outcome.reason).toMatch(
      /applet build/,
    );
  });

  test("publish refuses a manifest whose hashes do not match the bytes", async () => {
    const { host: capability } = host({
      files: {
        [`${APPLET}/dist/server.js`]: "export class Applet {}",
        [`${APPLET}/dist/ui.html`]: "<h1>hi</h1>",
        [`${APPLET}/dist/manifest.json`]: JSON.stringify({
          contract: 1,
          tools: [tool("add_todo")],
          hashes: { server: "a".repeat(64), ui: "b".repeat(64) },
        }),
      },
    });
    const outcome = await capability.publish({ appletId: APPLET }, scope);
    expect(outcome.status).toBe("failed");
    expect(outcome.status === "failed" && outcome.reason).toMatch(
      /does not match the built files/,
    );
  });

  test("publish is idempotent by effect id", async () => {
    const shared = memoryStorage();
    const first = host({ files: {}, storage: shared });
    const outcome = await first.host.publish({ appletId: APPLET }, scope);
    let calls = 0;
    const second = host({
      files: {},
      storage: shared,
      directory: {
        recordGeneration: () => {
          calls += 1;
          throw new Error("must not run twice");
        },
      },
    });
    // The recorded effect answers rather than repeating the read and the write.
    expect(await second.host.publish({ appletId: APPLET }, scope)).toEqual(
      outcome,
    );
    expect(calls).toBe(0);
  });

  test("delete clears the focus when the deleted Applet was focused", async () => {
    const { host: capability } = host({});
    await capability.focus({ appletId: APPLET });
    await capability.delete({ appletId: APPLET });
    expect(await capability.readFocused()).toMatchObject({ appletId: null });
  });

  test("generations answers newest first and marks the current one", async () => {
    const generation = (id: string): AppletGenerationV1 => ({
      schemaVersion: 1,
      generationId: id,
      server: {
        contentHash: "a".repeat(64),
        size: 1,
        mediaType: "application/javascript",
        bundlerVersion: "test",
      },
      ui: {
        contentHash: "b".repeat(64),
        size: 1,
        mediaType: "text/html",
        bundlerVersion: "test",
      },
      tools: [tool("add_todo")],
      contract: 1,
      origin: "publish",
      provenance: {
        botId: "bot-1",
        sessionId: `${USER}:bot-1`,
        turnId: "turn-1",
        runId: "run-1",
      },
      createdAt: "2026-09-03T00:00:00.000Z",
      status: "active",
    });
    const { host: capability } = host({
      instance: {
        read: () =>
          Promise.resolve({
            current: { generationId: "g2" },
            generations: [generation("g1"), generation("g2")],
          }),
      },
    });
    const rows = await capability.generations({ appletId: APPLET });
    expect(rows.map((row) => row.generationId)).toEqual(["g2", "g1"]);
    expect(rows[0]?.isCurrent).toBe(true);
    expect(rows[1]?.isCurrent).toBe(false);
  });
});
