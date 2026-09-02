import { describe, expect, test } from "bun:test";
import { TaskStore, type TaskAdmissionRequestV1 } from "./store.js";
import { createMemorySubagentStorageV1 } from "./testing.js";
import {
  TASK_CONCURRENCY_PER_BOT_V1,
  TASK_DEADLINE_MS_V1,
  TASK_MESSAGE_QUEUE_LIMIT_V1,
} from "./records.js";
import { TASK_DESKTOP_LEASE_KEY, taskKeyV1 } from "./storage-keys.js";

const MODEL = {
  binding: {
    packageId: "provider-ollama-cloud",
    capabilityId: "ollama-cloud-models",
    connectionId: "conn-1",
    provider: "ollama-cloud",
    providerModelId: "glm-5.3-flash:cloud",
  },
  slug: "provider-ollama-cloud/glm-5.3-flash:cloud",
};

function request(
  taskId: string,
  overrides: Partial<TaskAdmissionRequestV1> = {},
): TaskAdmissionRequestV1 {
  return {
    taskId,
    type: "executor",
    description: `task ${taskId}`,
    promptDigest: "a".repeat(64),
    model: MODEL,
    compositionGenerationId: "gen-1",
    background: true,
    attachments: [],
    dispatch: { runId: "run-1", turnId: "run-1", sessionId: "user:bot" },
    now: new Date("2026-09-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("admitting a task", () => {
  test("reads an old model binding purely and writes it forward on lifecycle change", async () => {
    const storage = createMemorySubagentStorageV1();
    const store = new TaskStore(storage);
    await store.admit(request("tk-migrate"));
    const current = await storage.get<Record<string, unknown>>(
      taskKeyV1("tk-migrate"),
    );
    if (!current) throw new Error("test task was not stored");
    const currentModel = current.model as {
      binding: Record<string, unknown>;
      slug: string;
    };
    // `assignmentId` is the literal nested field removed by 03034e0.
    const historical = {
      ...current,
      model: {
        ...currentModel,
        binding: { assignmentId: "asg-1", ...currentModel.binding },
      },
    };
    await storage.put(taskKeyV1("tk-migrate"), historical);

    await expect(store.read("tk-migrate")).resolves.toMatchObject({
      status: "queued",
      model: { binding: MODEL.binding },
    });
    expect(await storage.get<unknown>(taskKeyV1("tk-migrate"))).toEqual(
      historical,
    );

    await store.markRunning("tk-migrate");
    const written = await storage.get<{
      status: string;
      model: { binding: object };
    }>(taskKeyV1("tk-migrate"));
    expect(written).toMatchObject({ status: "running" });
    expect(written?.model.binding).not.toHaveProperty("assignmentId");
  });

  test("writes the record, the active key and the index row in one go", async () => {
    const storage = createMemorySubagentStorageV1();
    const store = new TaskStore(storage);
    const admitted = await store.admit(request("tk-1"));
    expect(admitted.status).toBe("admitted");
    expect(storage.keys()).toEqual([
      "task-active:tk-1",
      "task-index:1000000000",
      "task:tk-1",
    ]);
    expect(admitted.status === "admitted" && admitted.record.deadlineAt).toBe(
      new Date(
        Date.parse("2026-09-01T00:00:00.000Z") + TASK_DEADLINE_MS_V1,
      ).toISOString(),
    );
  });

  test("depth is one by construction, not by counting", async () => {
    const store = new TaskStore(createMemorySubagentStorageV1());
    const admitted = await store.admit(request("tk-1"));
    expect(admitted.status === "admitted" && admitted.record.depth).toBe(1);
  });

  test("the same task id replays rather than dispatching a second child", async () => {
    const store = new TaskStore(createMemorySubagentStorageV1());
    await store.admit(request("tk-1"));
    const again = await store.admit(request("tk-1", { description: "other" }));
    expect(again.status).toBe("replayed");
    expect(again.status === "replayed" && again.record.description).toBe(
      "task tk-1",
    );
  });

  test("refuses the fifth concurrent task and says what the bound is", async () => {
    const store = new TaskStore(createMemorySubagentStorageV1());
    for (let index = 0; index < TASK_CONCURRENCY_PER_BOT_V1; index += 1) {
      expect((await store.admit(request(`tk-${index}`))).status).toBe(
        "admitted",
      );
    }
    const refused = await store.admit(request("tk-fifth"));
    expect(refused).toMatchObject({ status: "refused" });
    expect(refused.status === "refused" && refused.reason).toContain(
      "the bound is 4",
    );
  });

  test("a settled task gives its slot back, so the next one is admitted", async () => {
    const store = new TaskStore(createMemorySubagentStorageV1());
    for (let index = 0; index < TASK_CONCURRENCY_PER_BOT_V1; index += 1) {
      await store.admit(request(`tk-${index}`));
    }
    await store.settle("tk-0", {
      status: "completed",
      settledAt: "2026-09-01T00:05:00.000Z",
      summary: "done",
    });
    expect((await store.admit(request("tk-fifth"))).status).toBe("admitted");
  });

  test("a computerUse task records its desktop lease intent before anything runs", async () => {
    const storage = createMemorySubagentStorageV1();
    const store = new TaskStore(storage);
    await store.admit(request("tk-gui", { type: "computerUse" }));
    expect(await storage.get(TASK_DESKTOP_LEASE_KEY)).toMatchObject({
      taskId: "tk-gui",
      scope: "desktop-gui",
    });
    await store.settle("tk-gui", {
      status: "completed",
      settledAt: "2026-09-01T00:05:00.000Z",
    });
    expect(await storage.get(TASK_DESKTOP_LEASE_KEY)).toBeUndefined();
  });

  test("refuses a second computerUse task, naming the holder", async () => {
    const storage = createMemorySubagentStorageV1();
    const store = new TaskStore(storage);
    await store.admit(request("tk-gui", { type: "computerUse" }));
    await store.markRunning("tk-gui");
    await store.recordDesktopLease("bot", "tk-gui", "2026-09-01T00:31:00.000Z");

    const second = await store.admit(
      request("tk-gui-2", { type: "computerUse" }),
    );
    expect(second.status).toBe("refused");
    expect(second.status === "refused" && second.reason).toContain("tk-gui");
    expect(second.status === "refused" && second.reason).toContain(
      "2026-09-01T00:31:00.000Z",
    );
    // The refused dispatch wrote nothing: the holder still holds the key.
    expect(await storage.get(TASK_DESKTOP_LEASE_KEY)).toMatchObject({
      taskId: "tk-gui",
    });
    expect(storage.keys()).not.toContain("task:tk-gui-2");
  });

  test("the intent is durable before the lease is, and the acquire lands on it", async () => {
    const storage = createMemorySubagentStorageV1();
    const store = new TaskStore(storage);
    await store.admit(request("tk-gui", { type: "computerUse" }));
    // Intent: the task that asked, with nothing granted yet.
    expect(await storage.get(TASK_DESKTOP_LEASE_KEY)).toMatchObject({
      taskId: "tk-gui",
      scope: "desktop-gui",
    });
    expect(
      (await storage.get<{ expiresAt?: string }>(TASK_DESKTOP_LEASE_KEY))
        ?.expiresAt,
    ).toBeUndefined();
    // Effect: the host granted it, recorded on the same key.
    const acquired = await store.recordDesktopLease(
      "bot",
      "tk-gui",
      "2026-09-01T00:31:00.000Z",
    );
    expect(acquired).toMatchObject({
      taskId: "tk-gui",
      ownerId: "task-bot-tk-gui",
      expiresAt: "2026-09-01T00:31:00.000Z",
    });
  });

  test("a lapsed lease holds nothing, so the next computerUse task takes it", async () => {
    const storage = createMemorySubagentStorageV1();
    const store = new TaskStore(storage);
    await store.admit(request("tk-gui", { type: "computerUse" }));
    await store.markRunning("tk-gui");
    await store.recordDesktopLease("bot", "tk-gui", "2026-09-01T00:10:00.000Z");
    expect(
      await store.desktopLease(new Date("2026-09-01T00:20:00.000Z")),
    ).toBeUndefined();
    const second = await store.admit(
      request("tk-gui-2", {
        type: "computerUse",
        now: new Date("2026-09-01T00:20:00.000Z"),
      }),
    );
    expect(second.status).toBe("admitted");
  });

  test("releasing hands back only the lease this task holds", async () => {
    const storage = createMemorySubagentStorageV1();
    const store = new TaskStore(storage);
    await store.admit(request("tk-gui", { type: "computerUse" }));
    await store.recordDesktopLease("bot", "tk-gui", "2026-09-01T00:31:00.000Z");
    expect(await store.releaseDesktopLease("tk-other")).toBeUndefined();
    expect(await storage.get(TASK_DESKTOP_LEASE_KEY)).toBeDefined();
    expect(await store.releaseDesktopLease("tk-gui")).toMatchObject({
      taskId: "tk-gui",
      ownerId: "task-bot-tk-gui",
    });
    expect(await storage.get(TASK_DESKTOP_LEASE_KEY)).toBeUndefined();
  });

  test("refuses an invalid task id without writing anything", async () => {
    const storage = createMemorySubagentStorageV1();
    const store = new TaskStore(storage);
    expect(await store.admit(request("../escape"))).toMatchObject({
      status: "refused",
    });
    expect(storage.keys()).toEqual([]);
  });
});

describe("settling a task", () => {
  test("is idempotent on the task id", async () => {
    const store = new TaskStore(createMemorySubagentStorageV1());
    await store.admit(request("tk-1"));
    const first = await store.settle("tk-1", {
      status: "completed",
      settledAt: "2026-09-01T00:05:00.000Z",
      summary: "done",
    });
    const second = await store.settle("tk-1", {
      status: "failed",
      settledAt: "2026-09-01T00:06:00.000Z",
      failure: "should not win",
    });
    expect(first.status).toBe("settled");
    expect(second.status).toBe("replayed");
    expect(second.record.outcome).toMatchObject({ status: "completed" });
  });

  test("drops the active key, so the deadline leaves the alarm with it", async () => {
    const store = new TaskStore(createMemorySubagentStorageV1());
    await store.admit(request("tk-1"));
    expect(await store.deadlines()).toHaveLength(1);
    await store.settle("tk-1", {
      status: "stopped",
      settledAt: "2026-09-01T00:05:00.000Z",
    });
    expect(await store.deadlines()).toEqual([]);
    expect(await store.active()).toEqual([]);
  });
});

describe("the task list", () => {
  test("is newest first and carries no prompt", async () => {
    const store = new TaskStore(createMemorySubagentStorageV1());
    await store.admit(request("tk-1"));
    await store.admit(request("tk-2"));
    const view = await store.list("bot");
    expect(view.tasks.map((task) => task.taskId)).toEqual(["tk-2", "tk-1"]);
    expect(view.active).toBe(2);
    expect(Object.keys(view.tasks[0]!)).not.toContain("prompt");
    expect(Object.keys(view.tasks[0]!)).not.toContain("promptDigest");
  });

  test("shows a settled task's summary and stops counting it as active", async () => {
    const store = new TaskStore(createMemorySubagentStorageV1());
    await store.admit(request("tk-1"));
    await store.settle("tk-1", {
      status: "completed",
      settledAt: "2026-09-01T00:05:00.000Z",
      summary: "Read the changelog.",
    });
    const view = await store.list("bot");
    expect(view.active).toBe(0);
    expect(view.tasks[0]).toMatchObject({
      status: "completed",
      summary: "Read the changelog.",
    });
  });
});

describe("the bounded message queue", () => {
  async function running(store: TaskStore): Promise<void> {
    await store.admit(request("tk-1"));
    await store.markRunning("tk-1");
  }

  test("refuses a task that has not started, because it has nothing to read yet", async () => {
    const store = new TaskStore(createMemorySubagentStorageV1());
    await store.admit(request("tk-1"));
    const queued = await store.appendMessage("tk-1", "hello", new Date());
    expect(queued).toMatchObject({ status: "refused" });
    expect(queued.status === "refused" && queued.reason).toContain(
      "has not started yet",
    );
  });

  test("refuses a settled task, because it will never read again", async () => {
    const store = new TaskStore(createMemorySubagentStorageV1());
    await running(store);
    await store.settle("tk-1", {
      status: "completed",
      settledAt: "2026-09-01T00:05:00.000Z",
      summary: "done",
    });
    const queued = await store.appendMessage("tk-1", "hello", new Date());
    expect(queued.status === "refused" && queued.reason).toContain(
      "can no longer be messaged",
    );
  });

  test("refuses a task this Bot does not hold", async () => {
    const store = new TaskStore(createMemorySubagentStorageV1());
    const queued = await store.appendMessage("tk-9", "hello", new Date());
    expect(queued.status === "refused" && queued.reason).toContain("unknown");
  });

  test("queues in order and stops at the bound rather than growing", async () => {
    const store = new TaskStore(createMemorySubagentStorageV1());
    await running(store);
    for (let index = 0; index < TASK_MESSAGE_QUEUE_LIMIT_V1; index += 1) {
      const queued = await store.appendMessage(
        "tk-1",
        `message ${index}`,
        new Date(),
      );
      expect(queued).toMatchObject({ status: "queued", depth: index + 1 });
    }
    const overflow = await store.appendMessage(
      "tk-1",
      "one too many",
      new Date(),
    );
    expect(overflow.status === "refused" && overflow.reason).toContain(
      `the bound is ${TASK_MESSAGE_QUEUE_LIMIT_V1}`,
    );
    const queued = await store.messages("tk-1");
    expect(queued).toHaveLength(TASK_MESSAGE_QUEUE_LIMIT_V1);
    expect(queued.map((entry) => entry.message)).toEqual(
      Array.from(
        { length: TASK_MESSAGE_QUEUE_LIMIT_V1 },
        (_value, index) => `message ${index}`,
      ),
    );
  });

  test("a claim delivers each message exactly once, oldest first", async () => {
    const store = new TaskStore(createMemorySubagentStorageV1());
    await running(store);
    await store.appendMessage("tk-1", "first", new Date());
    await store.appendMessage("tk-1", "second", new Date());

    const claimed = await store.claimMessages(
      "tk-1",
      new Date("2026-09-01T00:01:00.000Z"),
    );
    expect(claimed.map((entry) => entry.message)).toEqual(["first", "second"]);
    expect(claimed.map((entry) => entry.seq)).toEqual([0, 1]);
    // The second claim is the retry a resumed step makes: the marks are read
    // back and the child is handed nothing a second time.
    expect(await store.claimMessages("tk-1", new Date())).toEqual([]);
    expect(await store.pendingMessages("tk-1")).toEqual([]);
    expect(await store.messages("tk-1")).toHaveLength(2);
  });

  test("a delivered message frees its place in the bound", async () => {
    const store = new TaskStore(createMemorySubagentStorageV1());
    await running(store);
    for (let index = 0; index < TASK_MESSAGE_QUEUE_LIMIT_V1; index += 1) {
      await store.appendMessage("tk-1", `message ${index}`, new Date());
    }
    expect(
      (await store.appendMessage("tk-1", "one too many", new Date())).status,
    ).toBe("refused");
    await store.claimMessages("tk-1", new Date());
    expect(
      await store.appendMessage("tk-1", "room again", new Date()),
    ).toMatchObject({ status: "queued", depth: 1 });
  });

  test("settling drops the queue nobody will drain", async () => {
    const store = new TaskStore(createMemorySubagentStorageV1());
    await running(store);
    await store.appendMessage("tk-1", "hello", new Date());
    await store.settle("tk-1", {
      status: "completed",
      settledAt: "2026-09-01T00:05:00.000Z",
      summary: "done",
    });
    expect(await store.messages("tk-1")).toEqual([]);
  });
});

describe("stopping a task", () => {
  test("records the intent once, and reads it back on a retry", async () => {
    const storage = createMemorySubagentStorageV1();
    const store = new TaskStore(storage);
    await store.admit(request("tk-1"));
    await store.markRunning("tk-1");
    expect(await store.stopRequested("tk-1")).toBe(false);
    expect(await store.requestStop("tk-1", new Date(), "bot")).toMatchObject({
      status: "requested",
    });
    expect(await store.stopRequested("tk-1")).toBe(true);
    expect(await store.requestStop("tk-1", new Date(), "user")).toMatchObject({
      status: "replayed",
    });
    expect(storage.keys()).toContain("task-stop:tk-1");
  });

  test("refuses a task that has already settled rather than rewriting an outcome", async () => {
    const store = new TaskStore(createMemorySubagentStorageV1());
    await store.admit(request("tk-1"));
    await store.settle("tk-1", {
      status: "completed",
      settledAt: "2026-09-01T00:05:00.000Z",
      summary: "done",
    });
    const stopped = await store.requestStop("tk-1", new Date(), "user");
    expect(stopped.status === "refused" && stopped.reason).toContain(
      "already completed",
    );
  });

  test("settling clears the intent, so the record is the only terminal fact", async () => {
    const storage = createMemorySubagentStorageV1();
    const store = new TaskStore(storage);
    await store.admit(request("tk-1"));
    await store.requestStop("tk-1", new Date(), "user");
    await store.settle("tk-1", {
      status: "stopped",
      settledAt: "2026-09-01T00:05:00.000Z",
      failure: "Stopped by your user.",
    });
    expect(storage.keys()).not.toContain("task-stop:tk-1");
  });
});

describe("resuming a task", () => {
  test("refuses a task that is still running", async () => {
    const store = new TaskStore(createMemorySubagentStorageV1());
    await store.admit(request("tk-1"));
    await store.markRunning("tk-1");
    const resumable = await store.resumable("tk-1");
    expect(resumable.status === "refused" && resumable.reason).toContain(
      "still running",
    );
  });

  test("refuses a task that was never admitted", async () => {
    const store = new TaskStore(createMemorySubagentStorageV1());
    const resumable = await store.resumable("tk-9");
    expect(resumable.status === "refused" && resumable.reason).toContain(
      "unknown",
    );
  });

  test("answers a finished task with the child it ran in", async () => {
    const store = new TaskStore(createMemorySubagentStorageV1());
    await store.admit(request("tk-1"));
    await store.settle("tk-1", {
      status: "completed",
      settledAt: "2026-09-01T00:05:00.000Z",
      summary: "done",
    });
    const resumable = await store.resumable("tk-1");
    expect(resumable).toMatchObject({
      status: "resumable",
      anchorTaskId: "tk-1",
    });
  });

  test("a resumed run keeps the resumed task's Session, so the child picks up its own cursor", async () => {
    const store = new TaskStore(createMemorySubagentStorageV1());
    await store.admit(request("tk-1"));
    const admitted = await store.admit(
      request("tk-2", { resumedFrom: "tk-1", anchorTaskId: "tk-1" }),
    );
    expect(admitted.status === "admitted" && admitted.record).toMatchObject({
      taskId: "tk-2",
      resumedFrom: "tk-1",
      childSessionId: "task:tk-1",
    });
    expect(
      (await store.resumable("tk-1")).status === "refused" ||
        (await store.read("tk-2")).childSessionId === "task:tk-1",
    ).toBe(true);
  });
});

describe("settling is idempotent on the task id", () => {
  test("a second settle reads the first outcome back", async () => {
    const store = new TaskStore(createMemorySubagentStorageV1());
    await store.admit(request("tk-1"));
    const first = await store.settle("tk-1", {
      status: "completed",
      settledAt: "2026-09-01T00:05:00.000Z",
      summary: "the first outcome",
    });
    const second = await store.settle("tk-1", {
      status: "failed",
      settledAt: "2026-09-01T00:06:00.000Z",
      failure: "a racing reconciliation",
    });
    expect(first.status).toBe("settled");
    expect(second.status).toBe("replayed");
    expect(second.record).toMatchObject({
      status: "completed",
      outcome: { summary: "the first outcome" },
    });
    expect((await store.list("bot")).active).toBe(0);
  });
});
