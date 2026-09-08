import { describe, expect, test } from "bun:test";
import {
  appletCompositionMembersV1,
  appletDiagnosticTextV1,
  appletMembersDifferV1,
  createAppletCapabilityHostV1,
  resolveAppletCompositionV1,
  APPLET_DIRECTORY_REVISION_SEEN_KEY,
  type AppletBuildServiceV1,
  type AppletInstanceBindingV1,
  type AppletUserDirectoryV1,
} from "./records.js";
import {
  APPLET_BUILD_LIMITS,
  type AppletBuildRequestV1,
  type AppletBuildResponseV1,
  type AppletBuildStageV1,
} from "@frockbot/applets/build-contract";
import type {
  WorkspaceFilesV1,
  WorkspacePathV1,
} from "@frockbot/core/contracts";
import {
  compositionArtifactSetHashV1,
  type CompositionMemberV1,
  decodeCompositionGenerationV1,
  type CompositionGenerationV1,
} from "@frockbot/core/durable";
import {
  APPLET_FOCUSED_KEY,
  type AppletGenerationV1,
} from "@frockbot/core/durable";

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
  const members: CompositionMemberV1[] = [];
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
    const members: CompositionMemberV1[] = [];
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
      origin: {
        kind: "bot-authored",
        runId: "run-1",
        sessionId: `${USER}:bot-1`,
        turnId: "turn-1",
      },
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
    // The Package members are carried through unchanged: a Bot that has
    // authored nothing has none, and resolving Applets adds none.
    expect(proposed[0]?.members).toEqual([]);
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

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** The Applet source root, as the store keys it for this User. */
const SOURCE_ROOT = {
  kind: "package-declared" as const,
  userId: USER,
  packageId: "applets",
  rootId: "source",
};

/**
 * The durable root, in memory: enough of `WorkspaceFilesV1` for the capability
 * host, with the conditional write the real store enforces.
 */
function workspaceFiles(seed: Record<string, string> = {}): WorkspaceFilesV1 {
  const files = new Map<string, { text: string; generationId: string }>();
  let minted = 0;
  for (const [path, text] of Object.entries(seed)) {
    minted += 1;
    files.set(path, { text, generationId: `g${minted}` });
  }
  const entryFor = (
    path: string,
    held: { text: string; generationId: string },
  ) => ({
    path: { root: SOURCE_ROOT, path } as WorkspacePathV1,
    generation: {
      schemaVersion: 1 as const,
      generationId: held.generationId,
      contentHash: "0".repeat(64),
      size: held.text.length,
      writer: { kind: "unattributed" as const },
      writtenAt: "2026-09-03T00:00:00.000Z",
    },
  });
  return {
    read: (path) => {
      const held = files.get(path.path);
      return Promise.resolve(
        held === undefined
          ? { status: "not-found" as const, reason: "no such file" }
          : {
              status: "ok" as const,
              file: {
                ...entryFor(path.path, held),
                bytes: new TextEncoder().encode(held.text),
              },
            },
      );
    },
    stat: (path) => {
      const held = files.get(path.path);
      return Promise.resolve(
        held === undefined
          ? { status: "not-found" as const, reason: "no such file" }
          : { status: "ok" as const, entry: entryFor(path.path, held) },
      );
    },
    list: (request) => {
      // The real store validates a prefix as a relative path, and a relative
      // path may not end in a slash: a trailing one answers `refused`, which
      // an end-to-end run found the hard way.
      if (request.prefix?.endsWith("/")) {
        return Promise.resolve({
          status: "refused" as const,
          reason: "workspace path has an invalid segment",
        });
      }
      return Promise.resolve({
        status: "ok" as const,
        entries: [...files]
          .filter(([path]) => path.startsWith(request.prefix ?? ""))
          .map(([path, held]) => entryFor(path, held)),
      });
    },
    write: (request) => {
      const held = files.get(request.path.path);
      const seen = held?.generationId ?? null;
      if (seen !== request.expectedGenerationId) {
        return Promise.resolve({
          status: "conflict" as const,
          reason: "the file moved on",
        });
      }
      minted += 1;
      const generation = {
        schemaVersion: 1 as const,
        generationId: `g${minted}`,
        contentHash: "0".repeat(64),
        size: request.bytes.byteLength,
        writer: request.writer,
        writtenAt: "2026-09-03T00:00:00.000Z",
      };
      files.set(request.path.path, {
        text: new TextDecoder().decode(request.bytes),
        generationId: generation.generationId,
      });
      return Promise.resolve({ status: "ok" as const, generation });
    },
    delete: () =>
      Promise.resolve({ status: "not-found" as const, reason: "unused" }),
  };
}

/** The scaffold a test seeds, as `applet_create` would have written it. */
const SOURCE = {
  [`${APPLET}/applet.json`]: '{"name":"todo"}',
  [`${APPLET}/server.ts`]: "export default class {}",
  [`${APPLET}/ui.tsx`]: "export default () => null;",
};

const BUILT_SERVER = "export class Todo {}";
const BUILT_UI = "<!doctype html><h1>Todo</h1>";

/** A build service that answers with real artifacts and honest hashes. */
function buildsCleanly(
  calls: AppletBuildRequestV1[] = [],
): AppletBuildServiceV1 {
  return {
    async build(request) {
      calls.push(request);
      return {
        status: "built",
        manifest: {
          contract: 1,
          tools: [tool("add_todo")],
          hashes: {
            server: await sha256Hex(BUILT_SERVER),
            ui: await sha256Hex(BUILT_UI),
          },
        },
        server: BUILT_SERVER,
        ui: BUILT_UI,
      };
    },
  };
}

function failsAt(
  stage: AppletBuildStageV1,
  message = "Property 'titel' does not exist.",
): AppletBuildServiceV1 {
  return {
    build: () =>
      Promise.resolve<AppletBuildResponseV1>({
        status: "failed",
        stage,
        diagnostics: [
          {
            file: "server.ts",
            line: 12,
            column: 5,
            message,
            severity: "error",
          },
        ],
      }),
  };
}

describe("ctx.applets", () => {
  function host(options: {
    source?: Record<string, string>;
    buildService?: AppletBuildServiceV1;
    directory?: Partial<AppletUserDirectoryV1>;
    instance?: Partial<AppletInstanceBindingV1>;
    storage?: ReturnType<typeof memoryStorage>;
    appOrigin?: string;
  }) {
    const storage = options.storage ?? memoryStorage();
    const recorded: unknown[] = [];
    const artifacts: Record<string, string> = {};
    const puts: string[] = [];
    const workspace = workspaceFiles(options.source);
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
      puts,
      workspace,
      host: createAppletCapabilityHostV1({
        userId: USER,
        botId: "bot-1",
        storage,
        directory,
        instanceFor: () => instance,
        artifacts: {
          putPackageArtifact: (hash, module) => {
            puts.push(`${hash}.mjs`);
            artifacts[`${hash}.mjs`] = module;
            return Promise.resolve();
          },
          putPackageUiArtifact: (hash, html) => {
            puts.push(`${hash}.html`);
            artifacts[`${hash}.html`] = html;
            return Promise.resolve();
          },
        },
        workspace,
        ...(options.buildService ? { buildService: options.buildService } : {}),
        ...(options.appOrigin ? { appOrigin: options.appOrigin } : {}),
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

  test("the source files are listed, read and rewritten in place", async () => {
    const { host: capability } = host({
      // A second Applet's file under the same root: the listing is the
      // directory, never everything the prefix happens to start.
      source: {
        ...SOURCE,
        [`${OTHER}/server.ts`]: "export default class C {}",
      },
    });
    expect(await capability.files({ appletId: APPLET })).toEqual([
      { path: "applet.json", size: 15 },
      { path: "server.ts", size: 23 },
      { path: "ui.tsx", size: 26 },
    ]);
    expect(
      await capability.readFile({ appletId: APPLET, path: "server.ts" }),
    ).toBe("export default class {}");

    // A rewrite supersedes the generation the file holds; the store's
    // conditional write would refuse an assertion of absence.
    await capability.writeFile(
      {
        appletId: APPLET,
        path: "server.ts",
        text: "export default class B {}",
      },
      scope,
    );
    expect(
      await capability.readFile({ appletId: APPLET, path: "server.ts" }),
    ).toBe("export default class B {}");
    await capability.writeFile(
      { appletId: APPLET, path: "lib/dates.ts", text: "export const a = 1;" },
      scope,
    );
    expect(
      (await capability.files({ appletId: APPLET })).map((file) => file.path),
    ).toContain("lib/dates.ts");
  });

  test("reading a file that is not there says so", async () => {
    const { host: capability } = host({ source: { ...SOURCE } });
    await expect(
      capability.readFile({ appletId: APPLET, path: "nope.ts" }),
    ).rejects.toThrow(/not-found/);
  });

  test("publish builds the stored source and stores what came back", async () => {
    const calls: AppletBuildRequestV1[] = [];
    const {
      host: capability,
      artifacts,
      recorded,
    } = host({ source: { ...SOURCE }, buildService: buildsCleanly(calls) });

    const outcome = await capability.publish({ appletId: APPLET }, scope);

    expect(outcome.status).toBe("published");
    // The whole source prefix went, relative to the Applet, with the Turn's
    // effect id as the build's idempotency key.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.mode).toBe("build");
    expect(calls[0]?.effectId).toBe(scope.effectId);
    expect(calls[0]?.files.map((file) => file.path)).toEqual([
      "applet.json",
      "server.ts",
      "ui.tsx",
    ]);
    // Content-addressed, and the bytes stored are the bytes hashed.
    expect(artifacts[`${await sha256Hex(BUILT_SERVER)}.mjs`]).toBe(
      BUILT_SERVER,
    );
    expect(artifacts[`${await sha256Hex(BUILT_UI)}.html`]).toBe(BUILT_UI);
    expect(recorded).toHaveLength(1);
    expect(await capability.readFocused()).toMatchObject({ appletId: APPLET });
  });

  test("re-publishing unchanged source writes no second artifact", async () => {
    const {
      host: capability,
      artifacts,
      puts,
    } = host({
      source: { ...SOURCE },
      buildService: buildsCleanly(),
    });
    await capability.publish({ appletId: APPLET }, scope);
    await capability.publish(
      { appletId: APPLET },
      { ...scope, effectId: "applet:turn-2:publish:x" },
    );
    // Two publishes, one pair of objects: the artifact key is the content
    // hash, so the second publish addressed exactly what the first stored.
    expect(Object.keys(artifacts)).toHaveLength(2);
    expect(new Set(puts).size).toBe(2);
  });

  for (const stage of [
    "descriptor",
    "typecheck",
    "lint",
    "bundle",
    "describe",
  ] as const) {
    test(`a build that fails at ${stage} is refused with its diagnostics`, async () => {
      const { host: capability, artifacts } = host({
        source: { ...SOURCE },
        buildService: failsAt(stage),
      });
      const outcome = await capability.publish({ appletId: APPLET }, scope);
      expect(outcome.status).toBe("failed");
      if (outcome.status !== "failed") return;
      expect(outcome.reason).toBe(`the build failed at the ${stage} stage`);
      expect(outcome.diagnostics).toEqual([
        "server.ts:12:5 Property 'titel' does not exist.",
      ]);
      // Nothing was stored and nothing was mounted.
      expect(Object.keys(artifacts)).toHaveLength(0);
    });
  }

  test("a build whose artifacts do not match its manifest is refused", async () => {
    const { host: capability, artifacts } = host({
      source: { ...SOURCE },
      buildService: {
        build: () =>
          Promise.resolve<AppletBuildResponseV1>({
            status: "built",
            manifest: {
              contract: 1,
              tools: [tool("add_todo")],
              hashes: { server: "a".repeat(64), ui: "b".repeat(64) },
            },
            server: BUILT_SERVER,
            ui: BUILT_UI,
          }),
      },
    });
    const outcome = await capability.publish({ appletId: APPLET }, scope);
    expect(outcome.status === "failed" && outcome.reason).toMatch(
      /manifest does not describe/,
    );
    expect(Object.keys(artifacts)).toHaveLength(0);
  });

  test("source over the ceiling is refused before the build is called", async () => {
    let called = false;
    const { host: capability } = host({
      source: {
        ...SOURCE,
        [`${APPLET}/big.ts`]: "x".repeat(APPLET_BUILD_LIMITS.fileText + 1),
      },
      buildService: {
        build: () => {
          called = true;
          throw new Error("must not be called");
        },
      },
    });
    const outcome = await capability.publish({ appletId: APPLET }, scope);
    expect(outcome.status === "failed" && outcome.reason).toMatch(/ceiling/);
    expect(called).toBe(false);
  });

  test("an Applet with no source is told to write some", async () => {
    const { host: capability } = host({ buildService: buildsCleanly() });
    const outcome = await capability.publish({ appletId: APPLET }, scope);
    expect(outcome.status === "failed" && outcome.reason).toMatch(
      /has no source/,
    );
  });

  test("a deployment without the build service refuses rather than throws", async () => {
    const { host: capability } = host({ source: { ...SOURCE } });
    const outcome = await capability.publish({ appletId: APPLET }, scope);
    expect(outcome.status === "failed" && outcome.reason).toMatch(
      /build service is unavailable/,
    );
  });

  test("a tool name another Applet owns is refused at publish", async () => {
    const { host: capability, artifacts } = host({
      source: { ...SOURCE },
      buildService: buildsCleanly(),
      directory: {
        list: () =>
          Promise.resolve({
            revision: 1,
            applets: [
              {
                appletId: OTHER,
                displayName: "Other",
                status: "published" as const,
                currentGenerationId: "g1",
                tools: ["add_todo"],
                createdAt: "2026-09-03T00:00:00.000Z",
              },
            ],
          }),
      },
    });
    const outcome = await capability.publish({ appletId: APPLET }, scope);
    expect(outcome.status === "failed" && outcome.diagnostics).toEqual([
      '"add_todo" is already a tool of "Other"',
    ]);
    expect(Object.keys(artifacts)).toHaveLength(0);
  });

  test("publish is idempotent by effect id", async () => {
    const shared = memoryStorage();
    const first = host({
      source: { ...SOURCE },
      buildService: buildsCleanly(),
      storage: shared,
    });
    const outcome = await first.host.publish({ appletId: APPLET }, scope);
    let builds = 0;
    const second = host({
      source: { ...SOURCE },
      storage: shared,
      buildService: {
        build: () => {
          builds += 1;
          throw new Error("must not run twice");
        },
      },
    });
    // The recorded effect answers rather than repeating the build and the
    // artifact write.
    expect(await second.host.publish({ appletId: APPLET }, scope)).toEqual(
      outcome,
    );
    expect(builds).toBe(0);
  });

  test("check builds without publishing and hands back a preview URL", async () => {
    const calls: AppletBuildRequestV1[] = [];
    const {
      host: capability,
      artifacts,
      recorded,
    } = host({
      source: { ...SOURCE },
      buildService: buildsCleanly(calls),
      appOrigin: "http://127.0.0.1:8797",
    });

    const result = await capability.check({ appletId: APPLET }, scope);

    expect(result).toEqual({
      status: "checked",
      tools: ["add_todo"],
      previewUrl: `http://ui.localhost:8797/packages/${await sha256Hex(BUILT_UI)}.html`,
    });
    // The artifacts are uploaded so the preview resolves; no generation was
    // recorded and nothing was mounted.
    expect(Object.keys(artifacts)).toHaveLength(2);
    expect(recorded).toHaveLength(0);
    expect(calls[0]?.mode).toBe("build");
  });

  test("a failing check answers with the diagnostics and stores nothing", async () => {
    const { host: capability, artifacts } = host({
      source: { ...SOURCE },
      buildService: failsAt("typecheck"),
    });
    const result = await capability.check({ appletId: APPLET }, scope);
    expect(result).toEqual({
      status: "failed",
      reason: "the build failed at the typecheck stage",
      diagnostics: ["server.ts:12:5 Property 'titel' does not exist."],
    });
    expect(Object.keys(artifacts)).toHaveLength(0);
  });

  test("a diagnostic reads as path:line:col message", () => {
    expect(
      appletDiagnosticTextV1({
        file: "ui.tsx",
        line: 3,
        column: 9,
        message: "no raw colours",
        severity: "error",
      }),
    ).toBe("ui.tsx:3:9 no raw colours");
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
