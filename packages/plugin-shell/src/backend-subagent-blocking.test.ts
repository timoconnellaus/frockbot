// The foreground `Task` wait (memory-v2 F4).
//
// A `Task {background:false}` that answered "dispatched" the instant anything
// went wrong read to the model as a call that had finished with no output. It
// then spent two more steps on `task_check` and `task_resume`. The wait must
// hold until the child settles, and give up only when the record is really
// unreadable.
import { describe, expect, test } from "bun:test";
import type { UserSettingsViewV1 } from "@frockbot/configuration-core";
import type {
  TaskOutcomeV1,
  TaskRecordV1,
} from "@frockbot/plugin-subagents/records";
import { taskKeyV1 } from "@frockbot/plugin-subagents/storage-keys";
import type { ShellBotBackendHost } from "./backend.js";

const identity = { userId: "user-1", botId: "primary" };
const TASK_ID = "task-1";

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  /** Reads to fail before the first success, to stand in for contention. */
  failReads = 0;
  reads = 0;

  get<T>(key: string): Promise<T | undefined> {
    this.reads += 1;
    if (this.failReads > 0) {
      this.failReads -= 1;
      return Promise.reject(new Error("storage is busy"));
    }
    return Promise.resolve(
      structuredClone(this.values.get(key)) as T | undefined,
    );
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

  list<T>(options: { prefix?: string }): Promise<Map<string, T>> {
    return Promise.resolve(
      new Map(
        [...this.values.entries()].filter(([key]) =>
          key.startsWith(options.prefix ?? ""),
        ) as Array<[string, T]>,
      ),
    );
  }

  transaction<T>(callback: (storage: MemoryStorage) => Promise<T>): Promise<T> {
    return callback(this);
  }

  setAlarm(): Promise<void> {
    return Promise.resolve();
  }

  deleteAlarm(): Promise<void> {
    return Promise.resolve();
  }
}

const user: UserSettingsViewV1 = {
  schemaVersion: 1,
  revision: 0,
  profile: { name: "User" },
  packages: [],
  connections: [],
};

function host(storage: MemoryStorage): ShellBotBackendHost {
  return {
    state: { storage } as unknown as DurableObjectState,
    env: {
      USER_CONFIGURATIONS: {
        idFromName: () => "user-id",
        get: () => ({ readConfiguration: () => Promise.resolve(user) }),
      },
    } as unknown as ShellBotBackendHost["env"],
  };
}

interface Waiting {
  sleeps: number;
  materializeSettings(
    identity: { userId: string; botId: string },
    profile: { name: string },
  ): Promise<unknown>;
  wait(taskId: string): Promise<TaskOutcomeV1 | undefined>;
}

/**
 * Exposes the wait and removes its sleep, which is the whole point of it.
 *
 * The class is reached through a dynamic import rather than a top-level one:
 * the Shell's backend and the foundation application import each other, and a
 * static import from a test module reads the class while it is still
 * initializing.
 */
async function waiting(host: ShellBotBackendHost): Promise<Waiting> {
  // The application first: it is the half of the cycle that has to finish
  // initializing before the Shell's class is readable.
  await import("@frockbot/application-foundation/contributions");
  const { ShellBotBackendContribution } = await import("./backend.js");
  return new (class extends ShellBotBackendContribution {
    sleeps = 0;

    protected override sleep(): Promise<void> {
      this.sleeps += 1;
      return Promise.resolve();
    }

    wait(taskId: string): Promise<TaskOutcomeV1 | undefined> {
      return this.awaitBlockingTask(identity, taskId, taskId);
    }
  })(host) as unknown as Waiting;
}

function record(overrides: Partial<TaskRecordV1> = {}): TaskRecordV1 {
  return {
    schemaVersion: 1,
    taskId: TASK_ID,
    type: "executor",
    description: "read it",
    promptDigest: "sha256:digest",
    model: {
      binding: {
        packageId: "models",
        capabilityId: "llm",
        connectionId: "connection-1",
        provider: "foundation",
        providerModelId: "foundation-model",
      },
      slug: "foundation-model",
    },
    compositionGenerationId: "generation-1",
    background: false,
    depth: 1,
    status: "running",
    dispatch: {
      runId: "run-1",
      turnId: "turn-1",
      sessionId: "user-1:primary",
    },
    childSessionId: `task:${TASK_ID}`,
    attachments: [],
    createdAt: "2026-09-03T00:00:00.000Z",
    deadlineAt: "2026-09-03T00:30:00.000Z",
    ...overrides,
  };
}

async function fixture(
  stored: TaskRecordV1,
): Promise<{ storage: MemoryStorage; contribution: Waiting }> {
  const storage = new MemoryStorage();
  const contribution = await waiting(host(storage));
  await contribution.materializeSettings(identity, { name: "Primary" });
  storage.values.set(taskKeyV1(stored.taskId), structuredClone(stored));
  return { storage, contribution };
}

describe("the foreground Task wait", () => {
  test("answers with the child's settled outcome", async () => {
    const { contribution } = await fixture(
      record({
        status: "completed",
        outcome: {
          status: "completed",
          settledAt: "2026-09-03T00:00:10.000Z",
          summary: "The root has six entries.",
        },
      }),
    );

    expect(await contribution.wait(TASK_ID)).toMatchObject({
      status: "completed",
      summary: "The root has six entries.",
    });
  });

  // The regression: one failed read used to end the wait, and the Task tool
  // then told the model the child was still running — for a child that had
  // already settled.
  test("rides out a transient read failure instead of giving up", async () => {
    const { storage, contribution } = await fixture(
      record({
        status: "completed",
        outcome: {
          status: "completed",
          settledAt: "2026-09-03T00:00:10.000Z",
          summary: "The root has six entries.",
        },
      }),
    );
    storage.failReads = 2;

    expect(await contribution.wait(TASK_ID)).toMatchObject({
      status: "completed",
      summary: "The root has six entries.",
    });
    expect(contribution.sleeps).toBeGreaterThan(0);
  });

  test("gives up when the record stays unreadable", async () => {
    const { storage, contribution } = await fixture(record());
    storage.failReads = Number.MAX_SAFE_INTEGER;

    expect(await contribution.wait(TASK_ID)).toBeUndefined();
  });
});
