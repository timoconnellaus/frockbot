import { describe, expect, test } from "bun:test";
import type { CompositionGenerationViewV1 } from "@frockbot/configuration-core";
import { ref } from "vue";
import {
  compositionGenerationDiffV1,
  describeCompositionOriginV1,
  describeCompositionProvenanceV1,
  isOptimisticGenerationV1,
  optimisticRevertGenerationsV1,
  reconcileCompositionRevertV1,
} from "./composition.js";
import {
  createCompositionWebData,
  type CompositionWebData,
} from "./composition-state.js";

const BOOTSTRAP_GENERATION = "2026-08-31T00:00:00.000Z:0123456789abcdef";
const AUTHORED_GENERATION = "2026-09-01T00:00:00.000Z:fedcba9876543210";
const REVERTED_GENERATION = "2026-09-02T00:00:00.000Z:0123456789abcdef";

const shellMember = {
  packageId: "shell",
  version: "0.0.1",
  provenance: { kind: "first-party" as const },
};
const greeterMember = {
  packageId: "greeter",
  version: "0.0.2",
  contentHash: "b".repeat(64),
  provenance: {
    kind: "bot" as const,
    botId: "alpha",
    sessionId: "alice:alpha",
    turnId: "turn-1",
    runId: "run-1",
    authoredAt: "2026-09-01T00:00:00.000Z",
  },
};

const bootstrap: CompositionGenerationViewV1 = {
  schemaVersion: 1,
  botId: "alpha",
  generationId: BOOTSTRAP_GENERATION,
  createdAt: "2026-08-31T00:00:00.000Z",
  status: "superseded",
  isCurrent: false,
  origin: { kind: "bootstrap" },
  members: [shellMember],
};

const authored: CompositionGenerationViewV1 = {
  schemaVersion: 1,
  botId: "alpha",
  generationId: AUTHORED_GENERATION,
  createdAt: "2026-09-01T00:00:00.000Z",
  status: "active",
  isCurrent: true,
  parentGenerationId: BOOTSTRAP_GENERATION,
  origin: {
    kind: "bot-authored",
    runId: "run-1",
    sessionId: "alice:alpha",
    turnId: "turn-1",
  },
  members: [greeterMember, shellMember],
};

function transport(options: { receipt?: unknown } = {}) {
  const requests: { path: string; method: string; body?: string }[] = [];
  let currentGenerationId = AUTHORED_GENERATION;
  let generations = [authored, bootstrap];
  const request = (path: string, method = "GET", body?: string) => {
    requests.push({ path, method, ...(body === undefined ? {} : { body }) });
    if (method === "POST") {
      if (options.receipt !== undefined)
        return Promise.resolve(options.receipt);
      currentGenerationId = AUTHORED_GENERATION;
      generations = [
        {
          ...bootstrap,
          generationId: REVERTED_GENERATION,
          createdAt: "2026-09-02T00:00:00.000Z",
          status: "pending",
          isCurrent: false,
          parentGenerationId: AUTHORED_GENERATION,
          origin: {
            kind: "revert",
            revertsTo: BOOTSTRAP_GENERATION,
            userId: "alice",
          },
        },
        ...generations,
      ];
      return Promise.resolve({
        schemaVersion: 1,
        commandId: "composition-revert-1",
        status: "applied",
        generationId: REVERTED_GENERATION,
        currentGenerationId: AUTHORED_GENERATION,
      });
    }
    if (path.includes("/generations/")) {
      return Promise.resolve(bootstrap);
    }
    return Promise.resolve({
      schemaVersion: 1,
      botId: "alpha",
      currentGenerationId,
      generations,
    });
  };
  const state = ref<CompositionWebData>(
    undefined as unknown as CompositionWebData,
  );
  state.value = createCompositionWebData(state, {
    request,
    readAuthenticatedUserId: () => Promise.resolve("alice"),
    createCommandId: () => "composition-revert-1",
    now: () => new Date("2026-09-02T00:00:00.000Z"),
  });
  return { state, requests };
}

describe("Composition generation diff", () => {
  test("reports added, removed, changed, and unchanged members", () => {
    const diff = compositionGenerationDiffV1(authored, bootstrap);
    expect(diff.fromGenerationId).toBe(AUTHORED_GENERATION);
    expect(diff.toGenerationId).toBe(BOOTSTRAP_GENERATION);
    expect(diff.members).toEqual([
      {
        packageId: "greeter",
        change: "removed",
        from: { version: "0.0.2", contentHash: "b".repeat(64) },
      },
      {
        packageId: "shell",
        change: "unchanged",
        from: { version: "0.0.1" },
        to: { version: "0.0.1" },
      },
    ]);

    const rebuilt = compositionGenerationDiffV1(bootstrap, {
      ...authored,
      members: [
        { ...greeterMember, version: "0.0.3", contentHash: "c".repeat(64) },
        { ...shellMember, version: "0.0.2" },
      ],
    });
    expect(
      rebuilt.members.map((member) => [member.packageId, member.change]),
    ).toEqual([
      ["greeter", "added"],
      ["shell", "changed"],
    ]);
  });

  test("names provenance as Bot, User, or first-party", () => {
    expect(describeCompositionProvenanceV1(shellMember.provenance)).toBe(
      "First-party",
    );
    expect(describeCompositionProvenanceV1(greeterMember.provenance)).toBe(
      "Bot alpha · session alice:alpha · turn turn-1",
    );
    expect(
      describeCompositionProvenanceV1({
        kind: "user",
        userId: "alice",
        authoredAt: "2026-09-01T00:00:00.000Z",
      }),
    ).toBe("User alice");
    expect(describeCompositionOriginV1(authored.origin)).toContain(
      "Authored by the Bot",
    );
    expect(
      describeCompositionOriginV1({
        kind: "revert",
        revertsTo: BOOTSTRAP_GENERATION,
        userId: "alice",
      }),
    ).toContain("Reverted to");
  });
});

describe("Composition optimistic revert", () => {
  test("draws a pending generation carrying the target's members", () => {
    const generations = optimisticRevertGenerationsV1({
      generations: [authored, bootstrap],
      botId: "alpha",
      toGenerationId: BOOTSTRAP_GENERATION,
      commandId: "composition-revert-1",
      createdAt: "2026-09-02T00:00:00.000Z",
      userId: "alice",
    });
    expect(generations).toHaveLength(3);
    expect(isOptimisticGenerationV1(generations[0]!)).toBe(true);
    expect(generations[0]?.status).toBe("pending");
    expect(generations[0]?.members).toEqual(bootstrap.members);
    expect(generations[0]?.parentGenerationId).toBe(AUTHORED_GENERATION);
    expect(() =>
      optimisticRevertGenerationsV1({
        generations: [authored],
        botId: "alpha",
        toGenerationId: "2026-01-01T00:00:00.000Z:aaaaaaaaaaaaaaaa",
        commandId: "composition-revert-2",
        createdAt: "2026-09-02T00:00:00.000Z",
        userId: "alice",
      }),
    ).toThrow("no longer listed");
  });

  test("reconciles the receipt onto the optimistic entry", () => {
    const optimistic = optimisticRevertGenerationsV1({
      generations: [authored, bootstrap],
      botId: "alpha",
      toGenerationId: BOOTSTRAP_GENERATION,
      commandId: "composition-revert-1",
      createdAt: "2026-09-02T00:00:00.000Z",
      userId: "alice",
    });

    const applied = reconcileCompositionRevertV1({
      generations: optimistic,
      commandId: "composition-revert-1",
      receipt: {
        schemaVersion: 1,
        commandId: "composition-revert-1",
        status: "applied",
        generationId: REVERTED_GENERATION,
        currentGenerationId: AUTHORED_GENERATION,
      },
    });
    expect(applied.generations[0]?.generationId).toBe(REVERTED_GENERATION);
    expect(applied.failure).toBeUndefined();

    const rejected = reconcileCompositionRevertV1({
      generations: optimistic,
      commandId: "composition-revert-1",
      receipt: {
        schemaVersion: 1,
        commandId: "composition-revert-1",
        status: "rejected",
        failure: "composition generation is newer",
        currentGenerationId: AUTHORED_GENERATION,
      },
    });
    expect(rejected.generations).toHaveLength(2);
    expect(rejected.failure).toBe("composition generation is newer");
  });
});

describe("Composition client state", () => {
  test("lists generations newest first and reads one for the diff", async () => {
    const { state, requests } = transport();

    await state.value.load("alpha");

    expect(state.value.currentGenerationId).toBe(AUTHORED_GENERATION);
    expect(
      state.value.generations.map((generation) => generation.generationId),
    ).toEqual([AUTHORED_GENERATION, BOOTSTRAP_GENERATION]);
    expect(requests[0]?.path).toBe(
      "/api/bots/alpha/composition/generations?limit=50",
    );

    await state.value.select(BOOTSTRAP_GENERATION);
    expect(state.value.selected?.generationId).toBe(BOOTSTRAP_GENERATION);
    expect(requests[1]?.path).toBe(
      `/api/bots/alpha/composition/generations/${encodeURIComponent(BOOTSTRAP_GENERATION)}`,
    );
  });

  test("reverts optimistically and reconciles against the reloaded records", async () => {
    const { state, requests } = transport();
    await state.value.load("alpha");

    await state.value.revert(BOOTSTRAP_GENERATION);

    expect(state.value.error).toBeUndefined();
    expect(requests[1]?.method).toBe("POST");
    expect(JSON.parse(requests[1]!.body!)).toEqual({
      schemaVersion: 1,
      type: "composition/revert",
      commandId: "composition-revert-1",
      botId: "alpha",
      toGenerationId: BOOTSTRAP_GENERATION,
      expectedGenerationId: AUTHORED_GENERATION,
    });
    // Reconciled: the durable records replace the optimistic entry.
    expect(
      state.value.generations.map((generation) => generation.generationId),
    ).toEqual([REVERTED_GENERATION, AUTHORED_GENERATION, BOOTSTRAP_GENERATION]);
    expect(state.value.generations.some(isOptimisticGenerationV1)).toBe(false);
    expect(state.value.currentGenerationId).toBe(AUTHORED_GENERATION);
  });

  test("restores the listed generations when the authority rejects the revert", async () => {
    const { state } = transport({
      receipt: {
        schemaVersion: 1,
        commandId: "composition-revert-1",
        status: "rejected",
        failure: "composition generation is newer",
        currentGenerationId: AUTHORED_GENERATION,
      },
    });
    await state.value.load("alpha");

    await state.value.revert(BOOTSTRAP_GENERATION);

    expect(state.value.error).toBe("composition generation is newer");
    expect(
      state.value.generations.map((generation) => generation.generationId),
    ).toEqual([AUTHORED_GENERATION, BOOTSTRAP_GENERATION]);
  });
});
