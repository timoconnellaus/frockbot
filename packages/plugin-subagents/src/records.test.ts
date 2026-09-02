import { describe, expect, test } from "bun:test";
import {
  decodeTaskDesktopLeaseIntentV1,
  decodeTaskMessageRecordV1,
  decodeTaskModelBindingV1,
  decodeTaskOutcomeV1,
  decodeTaskRecordV1,
  migrateStoredTaskRecordV1,
  taskPromptDigestV1,
  utf8ByteLengthV1,
  TASK_ATTACHMENT_LIMIT_V1,
  TASK_CONCURRENCY_PER_BOT_V1,
  TASK_CONCURRENCY_PER_USER_V1,
  TASK_DEADLINE_MS_V1,
  TASK_MAX_DEPTH_V1,
  TASK_MESSAGE_QUEUE_LIMIT_V1,
  TASK_PROMPT_MAX_BYTES_V1,
  type TaskRecordV1,
} from "./records.js";

const BINDING = {
  packageId: "provider-ollama-cloud",
  capabilityId: "ollama-cloud-models",
  connectionId: "conn-1",
  provider: "ollama-cloud",
  providerModelId: "glm-5.3-flash:cloud",
};

function taskRecord(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: 1,
    taskId: "tk-1",
    type: "executor",
    description: "Summarise the changelog",
    promptDigest: "a".repeat(64),
    model: { binding: BINDING, slug: "provider-ollama-cloud/glm-5.3-flash" },
    compositionGenerationId: "gen-1",
    background: true,
    depth: 1,
    status: "queued",
    dispatch: { runId: "run-1", turnId: "run-1", sessionId: "user:bot" },
    childSessionId: "task:tk-1",
    attachments: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    deadlineAt: "2026-09-01T00:30:00.000Z",
    ...overrides,
  };
}

describe("the bounds the plan states", () => {
  test("are stated once, here, and are the values the plan names", () => {
    expect({
      perBot: TASK_CONCURRENCY_PER_BOT_V1,
      perUser: TASK_CONCURRENCY_PER_USER_V1,
      depth: TASK_MAX_DEPTH_V1,
      promptBytes: TASK_PROMPT_MAX_BYTES_V1,
      attachments: TASK_ATTACHMENT_LIMIT_V1,
      queuedMessages: TASK_MESSAGE_QUEUE_LIMIT_V1,
      lifetimeMs: TASK_DEADLINE_MS_V1,
    }).toEqual({
      perBot: 4,
      perUser: 8,
      depth: 1,
      promptBytes: 32_768,
      attachments: 4,
      queuedMessages: 16,
      lifetimeMs: 30 * 60_000,
    });
  });

  test("the prompt bound is bytes, not characters", () => {
    expect(utf8ByteLengthV1("é")).toBe(2);
  });
});

describe("TaskRecordV1 decodes exactly", () => {
  test("migrates the pre-account-wide model binding and keeps unknown fields strict", () => {
    // Literal durable shape from ff25b5c84d963d9c25fb3e13aaeb9688fabc10c1.
    const stored = taskRecord({
      model: {
        binding: {
          assignmentId: "asg-1",
          ...BINDING,
        },
        slug: "provider-ollama-cloud/glm-5.3-flash",
      },
    });
    expect(decodeTaskRecordV1(migrateStoredTaskRecordV1(stored))).toEqual(
      taskRecord() as TaskRecordV1,
    );

    const unknown = taskRecord({
      model: {
        binding: { assignmentId: "asg-1", ...BINDING, unknown: true },
        slug: "provider-ollama-cloud/glm-5.3-flash:cloud",
      },
    });
    expect(() =>
      decodeTaskRecordV1(migrateStoredTaskRecordV1(unknown)),
    ).toThrow(/unknown field "unknown"/);

    const current = taskRecord();
    expect(migrateStoredTaskRecordV1(current)).toBe(current);
  });

  test("accepts a queued record and returns it field for field", () => {
    const decoded = decodeTaskRecordV1(taskRecord());
    expect(decoded).toEqual(taskRecord() as TaskRecordV1);
  });

  test("accepts a settled record whose outcome agrees with its status", () => {
    const decoded = decodeTaskRecordV1(
      taskRecord({
        status: "completed",
        outcome: {
          status: "completed",
          settledAt: "2026-09-01T00:10:00.000Z",
          summary: "Done.",
        },
      }),
    );
    expect(decoded.outcome).toMatchObject({ status: "completed" });
  });

  test("refuses an unknown field rather than dropping it", () => {
    expect(() => decodeTaskRecordV1(taskRecord({ prompt: "leaked" }))).toThrow(
      /unknown field "prompt"/,
    );
  });

  test("refuses a missing required field", () => {
    const { model: _model, ...rest } = taskRecord() as Record<string, unknown>;
    expect(() => decodeTaskRecordV1(rest)).toThrow(/is missing "model"/);
  });

  test("refuses a non-enumerable own property", () => {
    const candidate = taskRecord() as Record<string, unknown>;
    Object.defineProperty(candidate, "smuggled", {
      value: 1,
      enumerable: false,
    });
    expect(() => decodeTaskRecordV1(candidate)).toThrow(
      /has a non-enumerable field/,
    );
  });

  test("refuses an unknown status and an unknown type", () => {
    expect(() => decodeTaskRecordV1(taskRecord({ status: "paused" }))).toThrow(
      /status is invalid/,
    );
    expect(() =>
      decodeTaskRecordV1(taskRecord({ type: "researcher" })),
    ).toThrow(/type is invalid/);
  });

  test("refuses a depth past one: a subagent never dispatches a subagent", () => {
    expect(() => decodeTaskRecordV1(taskRecord({ depth: 2 }))).toThrow(
      /depth is invalid/,
    );
  });

  test("refuses a terminal status with no outcome, and an outcome with none", () => {
    expect(() =>
      decodeTaskRecordV1(taskRecord({ status: "completed" })),
    ).toThrow(/inconsistent terminal state/);
    expect(() =>
      decodeTaskRecordV1(
        taskRecord({
          outcome: {
            status: "completed",
            settledAt: "2026-09-01T00:10:00.000Z",
          },
        }),
      ),
    ).toThrow(/inconsistent terminal state/);
  });

  test("refuses an outcome that disagrees with the record's status", () => {
    expect(() =>
      decodeTaskRecordV1(
        taskRecord({
          status: "failed",
          outcome: {
            status: "completed",
            settledAt: "2026-09-01T00:10:00.000Z",
          },
        }),
      ),
    ).toThrow(/outcome disagrees with its status/);
  });

  test("refuses more attachments than the bound allows", () => {
    expect(() =>
      decodeTaskRecordV1(
        taskRecord({ attachments: ["a", "b", "c", "d", "e"] }),
      ),
    ).toThrow(/at most 4 entries/);
  });
});

describe("the model binding a task pins", () => {
  test("accepts exactly the fields the Shell resolves", () => {
    expect(decodeTaskModelBindingV1(BINDING)).toEqual(BINDING);
  });

  test("refuses a binding carrying anything else", () => {
    expect(() =>
      decodeTaskModelBindingV1({ ...BINDING, apiKey: "secret" }),
    ).toThrow(/unknown field "apiKey"/);
  });
});

describe("the terminal outcome", () => {
  test("refuses a non-terminal status", () => {
    expect(() =>
      decodeTaskOutcomeV1({
        status: "running",
        settledAt: "2026-09-01T00:10:00.000Z",
      }),
    ).toThrow(/status is invalid/);
  });

  test("refuses a completion that also carries a failure", () => {
    expect(() =>
      decodeTaskOutcomeV1({
        status: "completed",
        settledAt: "2026-09-01T00:10:00.000Z",
        summary: "ok",
        failure: "not ok",
      }),
    ).toThrow(/completed and carries a failure at once/);
  });
});

describe("the other records this Package writes", () => {
  test("a queued message decodes exactly", () => {
    const message = {
      schemaVersion: 1 as const,
      taskId: "tk-1",
      seq: 0,
      message: "one more thing",
      createdAt: "2026-09-01T00:00:00.000Z",
    };
    expect(decodeTaskMessageRecordV1(message)).toEqual(message);
    expect(() =>
      decodeTaskMessageRecordV1({ ...message, priority: "high" }),
    ).toThrow(/unknown field "priority"/);
  });

  test("the desktop lease intent names one scope and nothing else", () => {
    const intent = {
      schemaVersion: 1 as const,
      taskId: "tk-1",
      scope: "desktop-gui" as const,
      recordedAt: "2026-09-01T00:00:00.000Z",
    };
    expect(decodeTaskDesktopLeaseIntentV1(intent)).toEqual({
      ...intent,
      scope: "desktop-gui" as const,
    });
    expect(() =>
      decodeTaskDesktopLeaseIntentV1({ ...intent, scope: "browser" }),
    ).toThrow(/scope is invalid/);
  });
});

describe("the prompt digest", () => {
  test("is stable, and is what the record carries instead of the prompt", async () => {
    const digest = await taskPromptDigestV1("do the thing");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await taskPromptDigestV1("do the thing")).toBe(digest);
    expect(await taskPromptDigestV1("do the other thing")).not.toBe(digest);
  });
});
