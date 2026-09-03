import { beforeEach, describe, expect, test } from "bun:test";
import {
  bootstrapGeneration,
  compositionArtifactSetHashV1,
  compositionGenerationIdV1,
  decodeCompositionGenerationV1,
  type CompositionGenerationV1,
  type CompositionMemberV1,
} from "@frockbot/kernel-composition/generation";
import { decodeFrockBotManifest } from "@frockbot/kernel-composition";
import type { PackageBundleResultV1 } from "@frockbot/kernel-contracts";
import {
  artifactKey,
  authorshipArtifactKey,
  authorshipFailureKey,
  authorshipIntentKey,
  authorshipManifestKey,
  authorshipUndoIntentKey,
  authorshipUndoOutcomeKey,
  AUTHORSHIP_FAILURE_PREFIX,
  type AuthoredArtifactRecordV1,
  type AuthoredManifestRecordV1,
  type AuthoringFailureRecordV1,
  type AuthorPackageRequestV1,
  type AuthorshipIntentV1,
  sha256HexV1,
} from "@frockbot/plugin-authoring";
import {
  createPackageAuthoringHost,
  type AuthoringCompositionStore,
  type AuthoringStorage,
} from "./backend-authoring.ts";

const SOURCE = `export const tools = [{ name: "hello", description: "", inputSchema: {} }];
export async function execute() { return "hi"; }
`;

function requestFor(overrides: Partial<AuthorPackageRequestV1> = {}) {
  return {
    input: {
      packageId: "hello-world",
      displayName: "Hello world",
      tools: [{ name: "hello", description: "Says hi", inputSchema: {} }],
      source: SOURCE,
    },
    sourceHash: "a".repeat(64),
    effectId: "author-0123456789abcdef",
    sessionId: "user-1:bot-1",
    position: { turn: 1, step: 1 },
    ...overrides,
  } satisfies AuthorPackageRequestV1;
}

function memoryStorage() {
  const values = new Map<string, unknown>();
  const storage: AuthoringStorage & { values: Map<string, unknown> } = {
    values,
    get: <T>(key: string) => Promise.resolve(values.get(key) as T | undefined),
    put: (entries) => {
      for (const [key, value] of Object.entries(entries)) {
        values.set(key, structuredClone(value));
      }
      return Promise.resolve();
    },
    list: <T>({ prefix }: { prefix: string }) =>
      Promise.resolve(
        new Map(
          [...values.entries()].filter(([key]) => key.startsWith(prefix)),
        ) as Map<string, T>,
      ),
  };
  return storage;
}

async function memoryComposition() {
  const bootstrap = decodeCompositionGenerationV1({
    ...(await bootstrapGeneration(
      [
        {
          packageId: "shell",
          specifier: "@frockbot/plugin-shell",
          version: "0.0.1",
          manifest: { id: "shell", version: "0.0.1" },
        },
      ],
      { createdAt: "2026-08-31T00:00:00.000Z" },
    )),
    status: "active",
  });
  const generations = new Map<string, CompositionGenerationV1>([
    [bootstrap.generationId, bootstrap],
  ]);
  let current = bootstrap.generationId;
  let lastKnownGood = bootstrap.generationId;
  const store: AuthoringCompositionStore & {
    generations: Map<string, CompositionGenerationV1>;
    currentId(): string;
    activate(generationId: string): void;
    fail(generationId: string): void;
  } = {
    generations,
    currentId: () => current,
    current: () => Promise.resolve(generations.get(current)!),
    lastKnownGood: () => Promise.resolve(generations.get(lastKnownGood)!),
    activate: (generationId) => {
      const generation = generations.get(generationId)!;
      generations.set(generationId, { ...generation, status: "active" });
      current = generationId;
      lastKnownGood = generationId;
    },
    fail: (generationId) => {
      const generation = generations.get(generationId)!;
      generations.set(generationId, { ...generation, status: "failed" });
      current = generationId;
    },
    read: (generationId) => Promise.resolve(generations.get(generationId)),
    propose: (generation, options) => {
      if (generations.has(generation.generationId)) {
        throw new Error("composition generation already exists");
      }
      generations.set(generation.generationId, generation);
      if (options?.pin) current = generation.generationId;
      return Promise.resolve();
    },
    retainedCount: () => Promise.resolve(generations.size),
    list: ({ limit }) =>
      Promise.resolve({
        generations: [...generations.values()].reverse().slice(0, limit),
      }),
    revert: async (toGenerationId, origin, options) => {
      const target = generations.get(toGenerationId);
      if (!target) throw new Error("unknown target");
      const createdAt = options?.createdAt ?? "2026-08-31T02:00:00.000Z";
      const generation = decodeCompositionGenerationV1({
        schemaVersion: 1,
        generationId: compositionGenerationIdV1(
          createdAt,
          target.artifactSetHash,
        ),
        artifactSetHash: target.artifactSetHash,
        parentGenerationId: current,
        createdAt,
        origin,
        members: target.members,
        status: "pending",
      });
      const existing = generations.get(generation.generationId);
      if (existing) return existing;
      generations.set(generation.generationId, generation);
      current = generation.generationId;
      return generation;
    },
  };
  return store;
}

/** Pins a generation that adds one member to the current one. */
async function pinMember(
  store: Awaited<ReturnType<typeof memoryComposition>>,
  member: CompositionMemberV1,
) {
  const parent = store.generations.get(store.currentId())!;
  const members = [...parent.members, member].sort((left, right) =>
    left.packageId.localeCompare(right.packageId),
  );
  const artifactSetHash = await compositionArtifactSetHashV1(members);
  const createdAt = "2026-08-31T00:30:00.000Z";
  await store.propose(
    decodeCompositionGenerationV1({
      schemaVersion: 1,
      generationId: compositionGenerationIdV1(createdAt, artifactSetHash),
      artifactSetHash,
      parentGenerationId: parent.generationId,
      createdAt,
      origin: { kind: "user-install", userId: "user-1" },
      members,
      status: "active",
    }),
    { pin: true },
  );
}

function countingBundler(result: (effectId: string) => PackageBundleResultV1): {
  bundle(request: { effectId: string }): Promise<PackageBundleResultV1>;
  calls: number;
} {
  const binding = {
    calls: 0,
    bundle(request: { effectId: string }) {
      binding.calls += 1;
      return Promise.resolve(result(request.effectId));
    },
  };
  return binding;
}

function bundledResult(effectId: string, hash = "b".repeat(64)) {
  return {
    schemaVersion: 1,
    effectId,
    status: "bundled",
    artifact: {
      contentHash: hash,
      size: 128,
      mediaType: "application/javascript",
      bundlerVersion: "test-bundler@0",
    },
    module: "export const tools = [];",
    diagnostics: [],
  } satisfies PackageBundleResultV1;
}

describe("a Bot authoring a Package", () => {
  let storage: ReturnType<typeof memoryStorage>;
  let composition: Awaited<ReturnType<typeof memoryComposition>>;
  let written: string[];
  let writtenSources: string[];
  let writtenUi: string[];
  let sourceContents: Map<string, string>;
  let reservations: unknown[];

  beforeEach(async () => {
    storage = memoryStorage();
    composition = await memoryComposition();
    written = [];
    writtenSources = [];
    writtenUi = [];
    sourceContents = new Map();
    reservations = [];
  });

  function host(options: {
    bundler: ReturnType<typeof countingBundler>;
    quota?: (request: unknown) => unknown;
    runId?: string;
    currentToolNames?: readonly string[];
  }) {
    let ids = 0;
    return createPackageAuthoringHost({
      storage,
      composition,
      bundler: options.bundler as never,
      artifacts: {
        putPackageArtifact: (contentHash) => {
          written.push(contentHash);
          return Promise.resolve();
        },
        putPackageSource: (sourceHash, source) => {
          writtenSources.push(sourceHash);
          sourceContents.set(sourceHash, source);
          return Promise.resolve();
        },
        putPackageUiArtifact: (contentHash) => {
          writtenUi.push(contentHash);
          return Promise.resolve();
        },
        loadPackageSource: (sourceHash) =>
          Promise.resolve(sourceContents.get(sourceHash)),
        headPackageArtifact: () => Promise.resolve(undefined),
      },
      quota: {
        reserve: (request) => {
          reservations.push(request);
          return Promise.resolve(
            (options.quota?.(request) as never) ?? {
              schemaVersion: 1,
              status: "reserved",
              effectId: request.effectId,
              day: request.day,
              used: 1,
              limit: 100,
            },
          );
        },
      },
      userId: "user-1",
      botId: "bot-1",
      runId: options.runId ?? "run-1",
      turnId: options.runId ?? "run-1",
      compatibilityDate: "2026-08-27",
      currentToolNames: () => options.currentToolNames ?? [],
      now: () => new Date("2026-08-31T01:00:00.000Z"),
      newId: () => `id-${(ids += 1)}`,
    });
  }

  test("records intent before the bundler and an artifact with full provenance", async () => {
    const bundler = countingBundler((effectId) => bundledResult(effectId));
    const outcome = await host({ bundler }).author(requestFor());

    expect(outcome.status).toBe("authored");
    const intent = storage.values.get(
      authorshipIntentKey("author-0123456789abcdef"),
    ) as AuthorshipIntentV1;
    expect(intent).toMatchObject({
      status: "recorded",
      packageId: "hello-world",
      version: "0.0.1",
      runId: "run-1",
    });
    // The source itself is never durable Bot state; its hash is.
    expect(Object.hasOwn(intent, "source")).toBe(false);

    const artifact = storage.values.get(
      artifactKey("b".repeat(64)),
    ) as AuthoredArtifactRecordV1;
    expect(artifact.provenance).toEqual({
      kind: "bot",
      packageId: "hello-world",
      version: "0.0.1",
      botId: "bot-1",
      sessionId: "user-1:bot-1",
      turnId: "run-1",
      runId: "run-1",
      authoredAt: "2026-08-31T01:00:00.000Z",
    });
    expect(artifact.r2Key).toBe(`packages/${"b".repeat(64)}.mjs`);
    expect(artifact.sourceR2Key).toBe(`packages/${"a".repeat(64)}.ts`);
    expect(artifact.sourceHash).toBe("a".repeat(64));
    expect(written).toEqual(["b".repeat(64)]);
    expect(writtenSources).toEqual(["a".repeat(64)]);
    const manifestRecord = storage.values.get(
      authorshipManifestKey(artifact.manifestHash),
    ) as AuthoredManifestRecordV1;
    expect(decodeFrockBotManifest(manifestRecord.manifest)).toMatchObject({
      id: "hello-world",
      version: "0.0.1",
      contributions: { runtime: { host: "bot-isolate" } },
      tools: [{ name: "hello" }],
    });
  });

  test("stores declared loop hooks in the authored manifest", async () => {
    const bundler = countingBundler((effectId) => bundledResult(effectId));
    const outcome = await host({ bundler }).author(
      requestFor({
        input: {
          ...requestFor().input,
          hooks: ["agent/tool-exposure", "tools/post-execute"],
        },
      }),
    );
    if (outcome.status !== "authored") throw new Error(outcome.reason);

    const artifact = storage.values.get(
      artifactKey(outcome.contentHash),
    ) as AuthoredArtifactRecordV1;
    const manifestRecord = storage.values.get(
      authorshipManifestKey(artifact.manifestHash),
    ) as AuthoredManifestRecordV1;

    expect(manifestRecord.manifest).toMatchObject({
      hooks: ["agent/tool-exposure", "tools/post-execute"],
    });
  });

  test("stores every immutable page artifact and records them in the same manifest", async () => {
    const html = "<!doctype html><h1>Hello</h1>";
    const boardHtml = "<!doctype html><h1>Board</h1>";
    const contentHash = await sha256HexV1(html);
    const boardHash = await sha256HexV1(boardHtml);
    const uiArtifact = (hash: string, text: string) => ({
      contentHash: hash,
      size: new TextEncoder().encode(text).byteLength,
      mediaType: "text/html" as const,
      bundlerVersion: "frockbot-inline-html@1",
    });
    const bundler = countingBundler((effectId) => ({
      ...bundledResult(effectId),
      uiArtifacts: [
        { id: "main", artifact: uiArtifact(contentHash, html), html },
        {
          id: "board",
          artifact: uiArtifact(boardHash, boardHtml),
          html: boardHtml,
        },
      ],
    }));
    const request = requestFor();
    const outcome = await host({ bundler }).author({
      ...request,
      input: {
        ...request.input,
        hooks: ["agent/tool-exposure", "tools/post-execute"],
        ui: {
          pages: [
            {
              id: "main",
              html,
              mounts: [{ slot: "frockbot.tool-result:hello" }],
            },
            {
              id: "board",
              html: boardHtml,
              mounts: [{ slot: "frockbot.surface:board" }],
            },
          ],
          entries: [
            {
              id: "open",
              slot: "frockbot.sidebar-actions",
              label: "Board",
              icon: "sparkle",
              opens: { kind: "surface", page: "board" },
            },
          ],
        },
      },
    });
    expect(outcome.status).toBe("authored");
    expect(writtenUi).toEqual([contentHash, boardHash]);
    const artifact = storage.values.get(
      artifactKey("b".repeat(64)),
    ) as AuthoredArtifactRecordV1;
    const stored = storage.values.get(
      authorshipManifestKey(artifact.manifestHash),
    ) as AuthoredManifestRecordV1;
    const manifest = decodeFrockBotManifest(stored.manifest);
    expect(manifest.contributions.client).toEqual({
      kind: "iframe",
      pages: [
        {
          id: "main",
          artifact: uiArtifact(contentHash, html),
          mounts: [{ slot: "frockbot.tool-result:hello" }],
        },
        {
          id: "board",
          artifact: uiArtifact(boardHash, boardHtml),
          mounts: [{ slot: "frockbot.surface:board" }],
        },
      ],
      entries: [
        {
          id: "open",
          slot: "frockbot.sidebar-actions",
          label: "Board",
          icon: "sparkle",
          opens: { kind: "surface", page: "board" },
        },
      ],
    });
    expect(manifest.hooks).toEqual([
      "agent/tool-exposure",
      "tools/post-execute",
    ]);
  });

  test("proposes a pending generation pinned for the next Turn", async () => {
    const bundler = countingBundler((effectId) => bundledResult(effectId));
    const outcome = await host({ bundler }).author(requestFor());
    if (outcome.status !== "authored") throw new Error(outcome.reason);

    const generation = composition.generations.get(outcome.generationId)!;
    expect(generation.status).toBe("pending");
    expect(generation.origin).toEqual({
      kind: "bot-authored",
      runId: "run-1",
      sessionId: "user-1:bot-1",
      turnId: "run-1",
    });
    expect(generation.members.map((member) => member.packageId)).toEqual([
      "hello-world",
      "shell",
    ]);
    // The pointer advances so the *next* admitted Turn pins the proposal.
    expect(composition.currentId()).toBe(outcome.generationId);
    expect(generation.artifactSetHash).toBe(
      await compositionArtifactSetHashV1(generation.members),
    );
  });

  test("a replayed effect id does not bundle twice or record a second generation", async () => {
    const bundler = countingBundler((effectId) => bundledResult(effectId));
    const first = await host({ bundler }).author(requestFor());
    const second = await host({ bundler }).author(requestFor());

    expect(bundler.calls).toBe(1);
    expect(second).toEqual(first);
    expect(composition.generations.size).toBe(2);
  });

  test("re-authoring appends a version and supersedes the previous member", async () => {
    const bundler = countingBundler((effectId) =>
      bundledResult(
        effectId,
        effectId.includes("second") ? "c".repeat(64) : "b".repeat(64),
      ),
    );
    const first = await host({ bundler }).author(requestFor());
    if (first.status !== "authored") throw new Error(first.reason);
    composition.activate(first.generationId);
    const second = await host({
      bundler,
      runId: "run-2",
      currentToolNames: ["hello"],
    }).author(
      requestFor({ effectId: "author-second", sourceHash: "d".repeat(64) }),
    );
    if (first.status !== "authored" || second.status !== "authored") {
      throw new Error("authoring was refused");
    }

    expect(second.version).toBe("0.0.2");
    expect(second.supersededVersion).toBe("0.0.1");
    expect(second.generationId).not.toBe(first.generationId);
    // Neither the earlier generation nor the earlier artifact was mutated.
    expect(composition.generations.get(first.generationId)?.members).toEqual(
      composition.generations.get(first.generationId)!.members,
    );
    expect(
      composition.generations
        .get(first.generationId)!
        .members.find((member) => member.packageId === "hello-world")?.version,
    ).toBe("0.0.1");
    expect(
      composition.generations
        .get(second.generationId)!
        .members.find((member) => member.packageId === "hello-world")?.version,
    ).toBe("0.0.2");
    expect(storage.values.get(artifactKey("b".repeat(64)))).toBeDefined();
    expect(storage.values.get(artifactKey("c".repeat(64)))).toBeDefined();
    expect(
      composition.generations.get(second.generationId)?.parentGenerationId,
    ).toBe(first.generationId);
  });

  test("a failed pending generation is never inherited by later authoring", async () => {
    const bundler = countingBundler((effectId) =>
      bundledResult(
        effectId,
        effectId === "author-first" ? "b".repeat(64) : "c".repeat(64),
      ),
    );
    const first = await host({ bundler, runId: "run-1" }).author(
      requestFor({ effectId: "author-first" }),
    );
    if (first.status !== "authored") throw new Error(first.reason);
    composition.fail(first.generationId);

    const second = await host({ bundler, runId: "run-2" }).author(
      requestFor({
        effectId: "author-second",
        sourceHash: "d".repeat(64),
        input: {
          ...requestFor().input,
          packageId: "second-package",
          tools: [
            { name: "second_tool", description: "Second", inputSchema: {} },
          ],
        },
      }),
    );
    if (second.status !== "authored") throw new Error(second.reason);
    const generation = composition.generations.get(second.generationId)!;
    expect(generation.parentGenerationId).toBe(
      (await composition.lastKnownGood()).generationId,
    );
    expect(generation.members.map((member) => member.packageId)).toEqual([
      "second-package",
      "shell",
    ]);
  });

  test("re-authoring the same package repairs a failed proposal from last-known-good", async () => {
    const bundler = countingBundler((effectId) =>
      bundledResult(
        effectId,
        effectId === "author-broken" ? "b".repeat(64) : "c".repeat(64),
      ),
    );
    const broken = await host({ bundler, runId: "run-broken" }).author(
      requestFor({ effectId: "author-broken" }),
    );
    if (broken.status !== "authored") throw new Error(broken.reason);
    composition.fail(broken.generationId);

    const repaired = await host({ bundler, runId: "run-repair" }).author(
      requestFor({
        effectId: "author-repair",
        sourceHash: "d".repeat(64),
        input: { ...requestFor().input, source: `${SOURCE}// repaired\n` },
      }),
    );

    if (repaired.status !== "authored") throw new Error(repaired.reason);
    const generation = composition.generations.get(repaired.generationId)!;
    expect(generation.parentGenerationId).toBe(
      (await composition.lastKnownGood()).generationId,
    );
    expect(
      generation.members.find((member) => member.packageId === "hello-world")
        ?.version,
    ).toBe("0.0.2");
    expect(generation.members).toHaveLength(2);
  });

  test("a registered tool-name collision is refused before quota or bundling", async () => {
    const bundler = countingBundler((effectId) => bundledResult(effectId));
    const outcome = await host({
      bundler,
      currentToolNames: ["memory_write", "package_author"],
    }).author(
      requestFor({
        input: {
          ...requestFor().input,
          tools: [
            {
              name: "memory_write",
              description: "Would collide",
              inputSchema: {},
            },
          ],
        },
      }),
    );

    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") throw new Error("unreachable");
    expect(outcome.reason).toContain(
      'Tool "memory_write" is already registered',
    );
    expect(reservations).toEqual([]);
    expect(bundler.calls).toBe(0);
  });

  test("shadowing a first-party Package is refused before any durable effect", async () => {
    const bundler = countingBundler((effectId) => bundledResult(effectId));
    const outcome = await host({ bundler }).author(
      requestFor({
        input: { ...requestFor().input, packageId: "shell" },
      }),
    );

    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") throw new Error("unreachable");
    expect(outcome.reason).toContain('"shell"');
    expect(outcome.reason).toContain("first-party provenance");
    const failure = storage.values.get(
      authorshipFailureKey(outcome.failureId),
    ) as AuthoringFailureRecordV1;
    expect(failure).toMatchObject({
      phase: "compose",
      packageId: "shell",
      botId: "bot-1",
    });
    // Nothing durable happened beyond the failure record.
    expect(bundler.calls).toBe(0);
    expect(written).toEqual([]);
    expect(composition.generations.size).toBe(1);
    expect(reservations).toEqual([]);
    expect(
      storage.values.get(authorshipIntentKey("author-0123456789abcdef")),
    ).toBeUndefined();
  });

  test("shadowing a User-installed Package is refused too", async () => {
    await pinMember(composition, {
      packageId: "hello-world",
      specifier: "@acme/hello-world",
      version: "1.2.3",
      manifestHash: "f".repeat(64),
      provenance: {
        kind: "user",
        packageId: "hello-world",
        version: "1.2.3",
        userId: "user-1",
        authoredAt: "2026-08-30T00:00:00.000Z",
      },
      artifact: {
        contentHash: "a".repeat(64),
        size: 64,
        mediaType: "application/javascript",
        bundlerVersion: "test-bundler@0",
      },
    });
    const bundler = countingBundler((effectId) => bundledResult(effectId));
    const outcome = await host({ bundler }).author(requestFor());

    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") throw new Error("unreachable");
    expect(outcome.reason).toContain("user provenance");
    expect(bundler.calls).toBe(0);
    expect(composition.generations.size).toBe(2);
  });

  test("a quota breach is a visible durable failure, not a throw", async () => {
    const bundler = countingBundler((effectId) => bundledResult(effectId));
    const outcome = await host({
      bundler,
      quota: (request) => ({
        schemaVersion: 1,
        status: "refused",
        effectId: (request as { effectId: string }).effectId,
        day: "2026-08-31",
        limitName: "authored-per-day",
        reason: "this User has authored 100 generations on 2026-08-31",
        used: 100,
        limit: 100,
      }),
    }).author(requestFor());

    expect(outcome.status).toBe("refused");
    if (outcome.status !== "refused") throw new Error("unreachable");
    expect(outcome.reason).toContain("durable per-User quota");
    const failure = storage.values.get(
      authorshipFailureKey(outcome.failureId),
    ) as AuthoringFailureRecordV1;
    expect(failure).toMatchObject({ phase: "quota", botId: "bot-1" });
    // Nothing durable happened beyond the failure record.
    expect(bundler.calls).toBe(0);
    expect(written).toEqual([]);
    expect(composition.generations.size).toBe(1);
    expect(
      storage.values.get(authorshipIntentKey("author-0123456789abcdef")),
    ).toBeUndefined();
  });

  test("a bundler refusal is recorded as the effect's outcome and replays", async () => {
    const bundler = countingBundler((effectId) => ({
      schemaVersion: 1,
      effectId,
      status: "failed",
      failure: "bundle-failed",
      diagnostics: ["package.ts:2:1: Unexpected end of file"],
    }));
    const first = await host({ bundler }).author(requestFor());
    const second = await host({ bundler }).author(requestFor());

    expect(first.status).toBe("refused");
    expect(second).toEqual(first);
    expect(bundler.calls).toBe(1);
    expect(composition.generations.size).toBe(1);
  });

  test("an intent with no outcome is reported, never re-bundled", async () => {
    // The eviction window: intent durable, bundler outcome lost.
    await storage.put({
      [authorshipIntentKey("author-0123456789abcdef")]: {
        schemaVersion: 1,
        effectId: "author-0123456789abcdef",
        botId: "bot-1",
        sessionId: "user-1:bot-1",
        runId: "run-1",
        turnId: "run-1",
        packageId: "hello-world",
        version: "0.0.1",
        sourceHash: "a".repeat(64),
        manifestHash: "f".repeat(64),
        sourceBytes: SOURCE.length,
        recordedAt: "2026-08-31T00:30:00.000Z",
        status: "recorded",
      } satisfies AuthorshipIntentV1,
    });
    const bundler = countingBundler((effectId) => bundledResult(effectId));
    const outcome = await host({ bundler }).author(requestFor());

    expect(outcome.status).toBe("refused");
    expect(bundler.calls).toBe(0);
    const failures = [...storage.values.entries()].filter(([key]) =>
      key.startsWith(AUTHORSHIP_FAILURE_PREFIX),
    );
    expect(failures).toHaveLength(1);
    expect((failures[0]?.[1] as AuthoringFailureRecordV1).phase).toBe(
      "recovery",
    );
  });

  test("an effect whose artifact record vanished is unknown, not re-bundled", async () => {
    await storage.put({
      [authorshipIntentKey("author-0123456789abcdef")]: {
        schemaVersion: 1,
        effectId: "author-0123456789abcdef",
        botId: "bot-1",
        sessionId: "user-1:bot-1",
        runId: "run-1",
        turnId: "run-1",
        packageId: "hello-world",
        version: "0.0.1",
        sourceHash: "a".repeat(64),
        manifestHash: "f".repeat(64),
        sourceBytes: SOURCE.length,
        recordedAt: "2026-08-31T00:30:00.000Z",
        status: "recorded",
      } satisfies AuthorshipIntentV1,
      [authorshipArtifactKey("author-0123456789abcdef")]: {
        schemaVersion: 1,
        status: "bundled",
        effectId: "author-0123456789abcdef",
        contentHash: "e".repeat(64),
        version: "0.0.1",
      },
    });
    const bundler = countingBundler((effectId) => bundledResult(effectId));
    const outcome = await host({ bundler }).author(requestFor());

    expect(outcome.status).toBe("refused");
    expect(bundler.calls).toBe(0);
  });

  test("a host with no bundler refuses visibly instead of silently succeeding", async () => {
    const outcome = await createPackageAuthoringHost({
      storage,
      composition,
      quota: {
        reserve: (request) =>
          Promise.resolve({
            schemaVersion: 1,
            status: "reserved",
            effectId: request.effectId,
            day: request.day,
            used: 1,
            limit: 100,
          }),
      },
      userId: "user-1",
      botId: "bot-1",
      runId: "run-1",
      turnId: "run-1",
      compatibilityDate: "2026-08-27",
    }).author(requestFor());

    expect(outcome.status).toBe("refused");
    expect(composition.generations.size).toBe(1);
  });

  test("package undo records intent before an idempotent Bot-origin revert without moving last-known-good", async () => {
    const bundler = countingBundler((effectId) => bundledResult(effectId));
    const authored = await host({ bundler }).author(requestFor());
    if (authored.status !== "authored") throw new Error("authoring failed");
    composition.activate(authored.generationId);
    const goodBeforeUndo = await composition.lastKnownGood();
    const undoHost = host({ bundler, runId: "run-undo" });
    const effectId = await undoHost.undoEffectIdFor({});
    const request = {
      input: {},
      effectId,
      sessionId: "user-1:bot-1",
      position: { turn: 2, step: 1 },
    } as const;

    const first = await undoHost.undo(request);
    const replay = await undoHost.undo(request);

    expect(first).toEqual(replay);
    expect(first.status).toBe("recorded");
    if (first.status !== "recorded") throw new Error("undo was refused");
    const reverted = composition.generations.get(first.generationId)!;
    expect(reverted.origin).toEqual({
      kind: "revert",
      revertsTo: first.targetGenerationId,
      botId: "bot-1",
      runId: "run-undo",
      turnId: "run-undo",
    });
    expect(reverted.members.map((member) => member.packageId)).toEqual([
      "shell",
    ]);
    expect((await composition.lastKnownGood()).generationId).toBe(
      goodBeforeUndo.generationId,
    );
    expect(storage.values.has(authorshipUndoIntentKey(effectId))).toBe(true);
    expect(storage.values.has(authorshipUndoOutcomeKey(effectId))).toBe(true);
  });

  test("package_inspect_self returns generated contract, declared tools, stored source, and latest failure", async () => {
    const bundler = countingBundler((effectId) => bundledResult(effectId));
    const authored = await host({ bundler }).author(requestFor());
    if (authored.status !== "authored") throw new Error("authoring failed");
    composition.activate(authored.generationId);
    const inspecting = host({
      bundler,
      runId: "run-inspect",
      currentToolNames: ["hello", "memory_write"],
    });
    await inspecting.author(
      requestFor({
        effectId: "author-collision",
        sourceHash: "c".repeat(64),
        input: {
          ...requestFor().input,
          tools: [
            {
              name: "memory_write",
              description: "collides",
              inputSchema: {},
            },
          ],
        },
      }),
    );

    const view = await inspecting.inspectSelf();

    expect(view.contextContract).toContain(
      "interface BotPackageExecutionContextV1",
    );
    expect(view.contextContract).toContain("interface FrockBotIframeBridgeV1");
    expect(view.contextContract).toContain("window.frockbot=");
    expect(view.composition.members).toContainEqual(
      expect.objectContaining({
        packageId: "hello-world",
        declaredTools: ["hello"],
        source: SOURCE,
      }),
    );
    expect(view.failures).toContainEqual(
      expect.objectContaining({
        packageId: "hello-world",
        authoring: expect.objectContaining({ phase: "compose" }),
      }),
    );
  });
});
