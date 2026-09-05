// What happens when a release and a Bot authoring a Package for itself reach
// the Composition pointer at the same moment, with a User's next message
// already queued behind the Turn that is running.
//
// Both writers derive a generation from `composition:current` and then yield —
// one to compile the deployment, one to bundle the Package it was asked for.
// Whichever wrote second used to replace the pointer outright, so the member
// the other one had just added was gone: the Bot told the person it had built
// them a tool, and the very next Turn did not have it. The pointer is a
// compare-and-swap now, and the loser re-derives from the winner.
import { describe, expect, test } from "bun:test";
import type { ApplicationPlan } from "@frockbot/kernel-composition/compiler";
import {
  type CompositionGenerationV1,
  type CompositionMemberV1,
  type CompositionStore,
} from "@frockbot/kernel-composition/generation";
import type { SessionEvent } from "@frockbot/kernel-contracts";
import {
  BotDurableAuthority,
  createStoredRunCodecV1,
  type BotDurableAuthorityHooks,
  type BotTurnExecutionInput,
  type OwnedBotTurnCommand,
} from "@frockbot/kernel-do";
import {
  bootstrapCompositionGeneration,
  resolveDeploymentCompositionV1,
} from "./backend-composition.js";
import { proposeAuthoredGenerationV1 } from "./backend-authoring.js";

const APPLETS_ARTIFACT_V1 = {
  contentHash: "a".repeat(64),
  size: 128,
  mediaType: "application/javascript" as const,
  bundlerVersion: "worker-bundler@0.2.3",
};
/** The same built-in Package as the deployment after a release rebuilt it. */
const APPLETS_ARTIFACT_V2 = {
  ...APPLETS_ARTIFACT_V1,
  contentHash: "b".repeat(64),
};

/** The Package the Bot authors mid-Turn, exactly as the authoring host builds it. */
const GREETER: CompositionMemberV1 = {
  packageId: "greeter",
  specifier: "bot:greeter",
  version: "0.0.1",
  manifestHash: "c".repeat(64),
  provenance: {
    kind: "bot",
    packageId: "greeter",
    version: "0.0.1",
    botId: "primary",
    sessionId: "user-1:primary",
    turnId: "run-1",
    runId: "run-1",
    authoredAt: "2026-09-05T00:00:05.000Z",
  },
  artifact: {
    contentHash: "d".repeat(64),
    size: 512,
    mediaType: "application/javascript",
    bundlerVersion: "worker-bundler@0.2.3",
  },
};

function plan(appletsArtifact: typeof APPLETS_ARTIFACT_V1): ApplicationPlan {
  return {
    packages: [
      {
        id: "shell",
        specifier: "@frockbot/plugin-shell",
        version: "1.0.0",
        manifest: { id: "shell" },
      },
      {
        id: "applets",
        specifier: "@frockbot/plugin-applets",
        version: "1.0.0",
        manifest: { id: "applets" },
        artifact: appletsArtifact,
      },
    ],
  } as unknown as ApplicationPlan;
}

/** The Bot object's storage: key/value, prefix list, and serialized transactions. */
class MemoryStorage {
  readonly values = new Map<string, unknown>();
  alarmAt: number | undefined;

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.values.get(key) as T | undefined);
  }

  put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof key === "string") this.values.set(key, structuredClone(value));
    else {
      for (const [entry, item] of Object.entries(key)) {
        this.values.set(entry, structuredClone(item));
      }
    }
    return Promise.resolve();
  }

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.values.delete(key));
  }

  list<T>(options: {
    prefix?: string;
    end?: string;
    reverse?: boolean;
    limit?: number;
  }): Promise<Map<string, T>> {
    const entries = [...this.values.entries()]
      .filter(
        ([key]) =>
          key.startsWith(options.prefix ?? "") &&
          (options.end === undefined || key < options.end),
      )
      .sort(([left], [right]) => left.localeCompare(right));
    if (options.reverse) entries.reverse();
    return Promise.resolve(
      new Map(entries.slice(0, options.limit) as Array<[string, T]>),
    );
  }

  #serialized: Promise<unknown> = Promise.resolve();

  transaction<T>(callback: (storage: MemoryStorage) => Promise<T>): Promise<T> {
    const next = this.#serialized.then(
      () => callback(this),
      () => callback(this),
    );
    this.#serialized = next.catch(() => undefined);
    return next;
  }

  setAlarm(scheduledTime: number): Promise<void> {
    this.alarmAt = scheduledTime;
    return Promise.resolve();
  }

  deleteAlarm(): Promise<void> {
    this.alarmAt = undefined;
    return Promise.resolve();
  }
}

const codec = createStoredRunCodecV1<undefined>({
  decodeRunId: (value) => value as string,
  decodeConfigurationSnapshot: () => undefined,
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Lets whatever a command set in motion reach its durable state. */
async function admitted(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * An authority whose Turns are held open until the test releases them, and
 * which journal no `model/request` — so a User's next message queues behind
 * the running Turn instead of superseding it.
 */
function createAuthority(storage: MemoryStorage) {
  const observed: BotTurnExecutionInput<undefined>[] = [];
  const handles = new Map<string, Deferred<void>>();
  const started = new Map<string, Deferred<void>>();
  const handleFor = (runId: string, table: Map<string, Deferred<void>>) => {
    const existing = table.get(runId);
    if (existing) return existing;
    const created = deferred<void>();
    table.set(runId, created);
    return created;
  };
  const hooks: BotDurableAuthorityHooks<undefined> = {
    resolveAdmissionSnapshot: () => Promise.resolve(undefined),
    bootstrapComposition: () =>
      bootstrapCompositionGeneration(
        plan(APPLETS_ARTIFACT_V1),
        "2026-09-05T00:00:00.000Z",
      ),
    admittedSnapshot: () => Promise.resolve(undefined),
    executeTurn: async (input) => {
      observed.push(input);
      const runId = input.command.runId;
      const turn = observed.length;
      let seq = input.previousEvents.length;
      const appended: SessionEvent[] = [];
      const persist = async (
        ...events: Omit<SessionEvent, "seq" | "timestamp">[]
      ) => {
        const stamped = events.map(
          (event) =>
            ({
              ...event,
              seq: seq++,
              timestamp: "2026-09-05T00:00:10.000Z",
            }) as SessionEvent,
        );
        appended.push(...stamped);
        await input.persistSessionEvents(input.command.sessionId, stamped);
      };
      await persist(
        { type: "turn/start", turn } as never,
        {
          type: "user/message",
          turn,
          step: 1,
          messageId: `m-${runId}`,
          text: input.command.text,
        } as never,
      );
      handleFor(runId, started).resolve();
      await handleFor(runId, handles).promise;
      await persist({ type: "turn/end", turn, outcome: "completed" } as never);
      return { runId, text: `done: ${input.command.text}`, events: appended };
    },
    notification: () => undefined,
    scheduledDeadlines: () => Promise.resolve([]),
    scheduledWorkInFlight: () => false,
    deferScheduledWork: () => Promise.resolve(),
    settleScheduledWork: () => Promise.resolve(),
  };
  return {
    authority: new BotDurableAuthority<undefined>({
      state: { storage } as unknown as DurableObjectState,
      codec,
      hooks,
    }),
    observed,
    started: (runId: string) => handleFor(runId, started).promise,
    finish: (runId: string) => handleFor(runId, handles).resolve(),
  };
}

function command(
  runId: string,
  text: string,
  extra: Partial<OwnedBotTurnCommand> = {},
): OwnedBotTurnCommand {
  return {
    userId: "user-1",
    botId: "primary",
    runId,
    sessionId: "user-1:primary",
    acceptedAt: `2026-09-05T00:00:0${runId === "run-1" ? 1 : 2}.000Z`,
    text,
    ...extra,
  };
}

function packageIds(generation: CompositionGenerationV1): string[] {
  return generation.members.map((member) => member.packageId).sort();
}

function appletsArtifactHash(
  generation: CompositionGenerationV1,
): string | undefined {
  return generation.members.find((member) => member.packageId === "applets")
    ?.artifact?.contentHash;
}

describe("a release and a Bot-authored Package racing for the pointer", () => {
  test("neither loses the other's member, and the queued User Turn runs on both", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage);
    const composition = probe.authority.composition;

    // The Turn the person is talking to. It is asked for a new tool and holds
    // the object while it works.
    const authoringTurn = probe.authority.run(
      command("run-1", "build me a greeter"),
    );
    await probe.started("run-1");
    const admittedGeneration = (await composition.current()).generationId;

    // The person sends their next message. It is durably admitted and queued.
    const queuedTurn = probe.authority.run(
      command("run-2", "now say hi", {
        lane: "user",
        supersedes: { runId: "run-1" },
      }),
    );
    await admitted();
    expect((storage.values.get("run:run-2") as { phase: string }).phase).toBe(
      "queued",
    );

    // A release lands. Deployment-follow snapshots the pointer, then yields to
    // compile the deployment's artifacts — the window the bug lived in.
    const compiling = deferred<void>();
    let gate: Promise<void> | undefined = compiling.promise;
    const release = resolveDeploymentCompositionV1({
      plan: plan(APPLETS_ARTIFACT_V2),
      composition: {
        current: async () => {
          const snapshot = await composition.current();
          if (gate) {
            const waiting = gate;
            // Only the first attempt yields; the retry re-reads for real.
            gate = undefined;
            await waiting;
          }
          return snapshot;
        },
        propose: (generation, options) =>
          composition.propose(generation, options),
      } satisfies Pick<CompositionStore, "current" | "propose">,
      now: new Date("2026-09-05T00:00:06.000Z"),
    });
    await admitted();

    // While it is yielded, the running Turn finishes authoring and pins its
    // own generation.
    const authored = await proposeAuthoredGenerationV1({
      composition,
      member: GREETER,
      createdAt: "2026-09-05T00:00:05.000Z",
      origin: {
        kind: "bot-authored",
        runId: "run-1",
        sessionId: "user-1:primary",
        turnId: "run-1",
      },
    });
    expect((await composition.current()).generationId).toBe(
      authored.generation.generationId,
    );

    // The release resumes, loses the compare-and-swap, and re-derives.
    compiling.resolve();
    const followed = await release;
    if (!followed) throw new Error("the release proposed nothing");

    const pinned = await composition.current();
    expect(pinned.generationId).toBe(followed.generationId);
    // Both members survive: the deployment's rebuilt built-in *and* the
    // Package the Bot authored while the release was in flight.
    expect(packageIds(pinned)).toEqual(["applets", "greeter", "shell"]);
    expect(appletsArtifactHash(pinned)).toBe(APPLETS_ARTIFACT_V2.contentHash);
    expect(pinned.parentGenerationId).toBe(authored.generation.generationId);

    // And the message that was waiting runs on that generation, not on the one
    // the pointer named when it was admitted.
    probe.finish("run-1");
    await authoringTurn;
    await probe.started("run-2");
    probe.finish("run-2");
    await queuedTurn;

    const queuedInput = probe.observed.find(
      (input) => input.command.runId === "run-2",
    );
    if (!queuedInput) throw new Error("the queued Turn never ran");
    expect(queuedInput.compositionGenerationId).not.toBe(admittedGeneration);
    expect(queuedInput.compositionGenerationId).toBe(pinned.generationId);
  });

  test("authoring that loses the race keeps the deployment's built-in members", async () => {
    const storage = new MemoryStorage();
    const probe = createAuthority(storage);
    const composition = probe.authority.composition;
    await composition.materialize();

    // This time the release wins the pointer first.
    const followed = await resolveDeploymentCompositionV1({
      plan: plan(APPLETS_ARTIFACT_V2),
      composition,
      now: new Date("2026-09-05T00:00:06.000Z"),
    });
    if (!followed) throw new Error("the release proposed nothing");

    // Authoring derives its member set from last-known-good, which is still
    // the pre-release generation. It must not reinstate the old built-in
    // artifact over the one the deployment just followed to.
    const authored = await proposeAuthoredGenerationV1({
      composition,
      member: GREETER,
      createdAt: "2026-09-05T00:00:07.000Z",
      origin: {
        kind: "bot-authored",
        runId: "run-1",
        sessionId: "user-1:primary",
        turnId: "run-1",
      },
    });

    const pinned = await composition.current();
    expect(pinned.generationId).toBe(authored.generation.generationId);
    expect(packageIds(pinned)).toEqual(["applets", "greeter", "shell"]);
    expect(appletsArtifactHash(pinned)).toBe(APPLETS_ARTIFACT_V2.contentHash);
  });
});
