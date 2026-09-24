import { describe, expect, test } from "bun:test";
import { isTaskIdV1 } from "@frockbot/app/subagents/records";
import {
  decodeSubagentRunTaskRequestV1,
  decodeSubagentTaskContextV1,
  subagentTaskContextV1,
  subagentTaskIdV1,
} from "./durable-binding.js";

describe("a task's files", () => {
  const attachment = {
    kind: "image",
    uploadId: "e".repeat(64),
    name: "demonstration-0123456789abcdef-screenshot-1.jpg",
    mediaType: "image/jpeg",
    bytes: 40_000,
  } as const;
  const request = {
    taskId: "task-0123456789abcdef0123456789abcdef",
    type: "watchVideo",
    parent: {
      userId: "user-1",
      botId: "bot-1",
      runId: "run-1",
      turnId: "turn-1",
      sessionId: "session-1",
    },
    compositionGenerationId: "generation-1",
    model: {
      binding: {
        packageId: "provider-ollama-cloud",
        capabilityId: "ollama-cloud-models",
        connectionId: "conn-1",
        provider: "ollama-cloud",
        providerModelId: "glm-5.3-flash:cloud",
      },
      slug: "provider-ollama-cloud/glm-5.3-flash",
    },
    prompt: "Describe what the screenshots show.",
    attachments: [attachment],
  };

  test("cross to the child and stay in its context as references", () => {
    const decoded = decodeSubagentRunTaskRequestV1(request);
    expect(decoded.attachments).toEqual([attachment]);
    const context = subagentTaskContextV1(decoded, "2026-09-24T00:00:00.000Z");
    expect(decodeSubagentTaskContextV1(context).attachments).toEqual([
      attachment,
    ]);
  });

  test("never carry a file's bytes", () => {
    expect(() =>
      decodeSubagentRunTaskRequestV1({
        ...request,
        attachments: [{ ...attachment, dataBase64: "AAAA" }],
      }),
    ).toThrow();
  });
});

describe("subagentTaskIdV1", () => {
  test("mints the same task id when the same call is replayed", async () => {
    const id = await subagentTaskIdV1("run-chat", "tool:1:1:0");
    expect(isTaskIdV1(id)).toBe(true);
    expect(await subagentTaskIdV1("run-chat", "tool:1:1:0")).toBe(id);
  });

  test("mints another task id for the same effect in another run", async () => {
    // Effect ids restart in every Session: a Routine Turn's first call is
    // `tool:1:1:0` exactly as the conversation's first call was.
    expect(await subagentTaskIdV1("run-chat", "tool:1:1:0")).not.toBe(
      await subagentTaskIdV1("run-routine", "tool:1:1:0"),
    );
  });
});
