import { beforeEach, describe, expect, test } from "bun:test";
import {
  bootstrapGeneration,
  compositionArtifactSetHashV1,
  decodeCompositionGenerationV1,
  type CompositionGenerationV1,
} from "@frockbot/kernel-composition/generation";
import type { PackageBundleResultV1 } from "@frockbot/kernel-contracts";
import {
  artifactKey,
  authorshipArtifactKey,
  authorshipFailureKey,
  authorshipIntentKey,
  AUTHORSHIP_FAILURE_PREFIX,
  type AuthoredArtifactRecordV1,
  type AuthoringFailureRecordV1,
  type AuthorPackageRequestV1,
  type AuthorshipIntentV1,
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
      tool: { name: "hello", description: "Says hi", inputSchema: {} },
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
  const store: AuthoringCompositionStore & {
    generations: Map<string, CompositionGenerationV1>;
    currentId(): string;
  } = {
    generations,
    currentId: () => current,
    current: () => Promise.resolve(generations.get(current)!),
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
  };
  return store;
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
  let reservations: unknown[];

  beforeEach(async () => {
    storage = memoryStorage();
    composition = await memoryComposition();
    written = [];
    reservations = [];
  });

  function host(options: {
    bundler: ReturnType<typeof countingBundler>;
    quota?: (request: unknown) => unknown;
    runId?: string;
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
    expect(written).toEqual(["b".repeat(64)]);
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
    const second = await host({ bundler, runId: "run-2" }).author(
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
});
