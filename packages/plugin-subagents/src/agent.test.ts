import { describe, expect, test } from "bun:test";
import {
  createSubagentModelsPromptSectionV1,
  foldPendingTaskMessagesV1,
  createTaskCheckTool,
  createTaskMessageTool,
  createTaskResumeTool,
  createTaskStopTool,
  createTaskTool,
  decodeTaskToolInputV1,
  subagentsAdmissionCeilingV1,
  TASK_DISPATCH_CAPABILITY_V1,
  TASK_LIFECYCLE_CAPABILITY_V1,
  type SubagentDispatchOutcomeV1,
  type SubagentDispatchRequestV1,
} from "./agent.js";
import { subagentModelCatalogV1 } from "./models.js";
import {
  TASK_MESSAGE_MAX_V1,
  TASK_PROMPT_MAX_BYTES_V1,
  type TaskModelBindingV1,
} from "./records.js";
import type { ToolExecutionContext } from "@frockbot/kernel-contracts";

const BINDING: TaskModelBindingV1 = {
  packageId: "provider-ollama-cloud",
  capabilityId: "ollama-cloud-models",
  connectionId: "conn-1",
  provider: "ollama-cloud",
  providerModelId: "glm-5.3-flash:cloud",
};

function context(): ToolExecutionContext {
  return {
    botId: "bot",
    agentId: "agent",
    sessionId: "user:bot",
    compositionGenerationId: "gen-1",
    effectId: "effect-1",
    turnType: "chat",
    signal: new AbortController().signal,
  };
}

function tool(
  dispatch: (
    request: SubagentDispatchRequestV1,
  ) => Promise<SubagentDispatchOutcomeV1>,
  turnType: "chat" | "automation" = "chat",
) {
  return createTaskTool({
    botId: "bot",
    writer: { sessionId: "user:bot", turnId: "run-1", runId: "run-1" },
    turnType,
    models: () =>
      subagentModelCatalogV1({
        bindings: [BINDING],
        defaultBinding: BINDING,
        turnType,
      }),
    dispatch,
  });
}

describe("the Task tool's declaration", () => {
  test("is admitted on chat and automation turns, so depth is one", () => {
    expect(tool(() => Promise.reject(new Error("unused"))).admission).toEqual({
      turnTypes: ["chat", "automation"],
    });
  });

  test("is bounded by the manifest ceiling it is contributed under", () => {
    expect(subagentsAdmissionCeilingV1(TASK_DISPATCH_CAPABILITY_V1)).toEqual([
      "chat",
      "automation",
    ]);
    expect(subagentsAdmissionCeilingV1("no-such-capability")).toBeUndefined();
  });
});

describe("decoding one Task call", () => {
  test("defaults the type to executor and background to true", () => {
    expect(
      decodeTaskToolInputV1({ description: "Look it up", prompt: "Do it." }),
    ).toMatchObject({ type: "executor", background: true, attachments: [] });
  });

  test("refuses an unknown field rather than ignoring it", () => {
    expect(() =>
      decodeTaskToolInputV1({
        description: "d",
        prompt: "p",
        parentSession: "user:bot",
      }),
    ).toThrow(/unknown field "parentSession"/);
  });

  test("refuses an unknown subagent type", () => {
    expect(() =>
      decodeTaskToolInputV1({ description: "d", prompt: "p", type: "wizard" }),
    ).toThrow(/type must be one of/);
  });

  test("refuses a prompt past the byte bound", () => {
    expect(() =>
      decodeTaskToolInputV1({
        description: "d",
        prompt: "a".repeat(TASK_PROMPT_MAX_BYTES_V1 + 1),
      }),
    ).toThrow(/at most 32768/);
  });

  test("refuses a fifth attachment", () => {
    expect(() =>
      decodeTaskToolInputV1({
        description: "d",
        prompt: "p",
        attachments: ["a", "b", "c", "d", "e"],
      }),
    ).toThrow(/at most 4 attachments/);
  });

  test("refuses watchVideo with nothing to watch", () => {
    expect(() =>
      decodeTaskToolInputV1({
        description: "d",
        prompt: "p",
        type: "watchVideo",
      }),
    ).toThrow(/needs at least one attachment/);
  });
});

describe("executing one Task call", () => {
  test("dispatches on the inherited binding when no model is named", async () => {
    let seen: SubagentDispatchRequestV1 | undefined;
    const result = await tool(async (request) => {
      seen = request;
      return {
        status: "dispatched",
        taskId: "tk-1",
        model: request.model.slug,
      };
    }).execute(
      { description: "Summarise", prompt: "Summarise the changelog." },
      context(),
    );
    expect(seen?.model.binding).toEqual(BINDING);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("tk-1");
    expect(result.content).toContain("do not poll");
  });

  test("refuses a model slug this Turn was not offered, without dispatching", async () => {
    let dispatched = false;
    const result = await tool(async () => {
      dispatched = true;
      return { status: "dispatched", taskId: "tk-1", model: "x" };
    }).execute(
      { description: "d", prompt: "p", model: "anthropic/opus" },
      context(),
    );
    expect(dispatched).toBe(false);
    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain(
      "is not one of this Turn's subagent models",
    );
  });

  test("carries the authority's bound refusal back to the model verbatim", async () => {
    const result = await tool(async () => ({
      status: "refused",
      reason:
        "this Bot already has 4 subagents running; the bound is 4. Wait for one to finish.",
    })).execute({ description: "d", prompt: "p" }, context());
    expect(result).toMatchObject({ isError: true });
    expect(result.content).toContain("the bound is 4");
  });

  test("refuses invalid input before it reaches the authority", async () => {
    let dispatched = false;
    const result = await tool(async () => {
      dispatched = true;
      return { status: "dispatched", taskId: "tk-1", model: "x" };
    }).execute({ description: "d" }, context());
    expect(dispatched).toBe(false);
    expect(result).toMatchObject({ isError: true });
  });
});

describe("the <available_subagent_models> section", () => {
  test("renders the catalog the host offers", async () => {
    const section = createSubagentModelsPromptSectionV1({
      models: () =>
        subagentModelCatalogV1({
          bindings: [BINDING],
          defaultBinding: BINDING,
          turnType: "chat",
        }),
    });
    const rendered = await section.render({
      sessionId: "user:bot",
      provider: "ollama-cloud",
      model: "glm-5.3-flash:cloud",
      turnType: "chat",
    });
    expect(rendered).toContain(
      'slug="provider-ollama-cloud/glm-5.3-flash:cloud"',
    );
  });

  test("renders nothing for a Bot with no enabled model binding", async () => {
    const section = createSubagentModelsPromptSectionV1({ models: () => [] });
    expect(
      await section.render({
        sessionId: "user:bot",
        provider: "p",
        model: "m",
        turnType: "chat",
      }),
    ).toBe("");
  });
});

describe("the lifecycle tools", () => {
  test("are admitted on chat and automation turns, under the manifest ceiling", () => {
    expect(subagentsAdmissionCeilingV1(TASK_LIFECYCLE_CAPABILITY_V1)).toEqual([
      "chat",
      "automation",
    ]);
    for (const tool of [
      createTaskCheckTool({ check: () => Promise.reject(new Error("unused")) }),
      createTaskMessageTool({
        message: () => Promise.reject(new Error("unused")),
      }),
      createTaskStopTool({ stop: () => Promise.reject(new Error("unused")) }),
    ]) {
      expect(tool.admission).toEqual({ turnTypes: ["chat", "automation"] });
    }
  });

  test("task_check says it is a read, and that nothing here is worth polling", async () => {
    const tool = createTaskCheckTool({
      check: () =>
        Promise.resolve({
          status: "known",
          taskId: "tk-1",
          taskType: "executor",
          description: "read the changelog",
          taskStatus: "running",
          model: "provider-ollama-cloud/glm-5.3-flash:cloud",
          queuedMessages: 2,
        }),
    });
    expect(tool.idempotent).toBe(true);
    const result = await tool.execute({ taskId: "tk-1" }, context());
    expect(result.isError).toBe(false);
    expect(result.content).toContain("is running");
    expect(result.content).toContain("2 of your messages are waiting");
    expect(result.content).toContain("do not poll");
  });

  test("task_check reports the last summary of a settled task, and does not tell it to wait", async () => {
    const tool = createTaskCheckTool({
      check: () =>
        Promise.resolve({
          status: "known",
          taskId: "tk-1",
          taskType: "executor",
          description: "read the changelog",
          taskStatus: "completed",
          model: "m",
          summary: "It changed on Tuesday.",
          queuedMessages: 0,
        }),
    });
    const result = await tool.execute({ taskId: "tk-1" }, context());
    expect(result.content).toContain("Last summary: It changed on Tuesday.");
    expect(result.content).not.toContain("do not poll");
  });

  test("task_message refuses a task that is not running, without reaching the queue", async () => {
    let asked = false;
    const tool = createTaskMessageTool({
      message: () => {
        asked = true;
        return Promise.resolve({
          status: "refused",
          reason: 'task "tk-1" is completed and can no longer be messaged',
        });
      },
    });
    const result = await tool.execute(
      { taskId: "tk-1", message: "stop reading" },
      context(),
    );
    expect(asked).toBe(true);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("can no longer be messaged");
  });

  test("task_message refuses an unbounded payload at its own door", async () => {
    let asked = false;
    const tool = createTaskMessageTool({
      message: () => {
        asked = true;
        return Promise.resolve({ status: "queued", taskId: "tk-1", depth: 1 });
      },
    });
    const result = await tool.execute(
      { taskId: "tk-1", message: "x".repeat(TASK_MESSAGE_MAX_V1 + 1) },
      context(),
    );
    expect(asked).toBe(false);
    expect(result.isError).toBe(true);
  });

  test("task_stop is idempotent, because stopping a stopped task is stopping it once", () => {
    expect(
      createTaskStopTool({ stop: () => Promise.reject(new Error("unused")) })
        .idempotent,
    ).toBe(true);
  });

  test("task_resume refuses a model beside a resume, before anything is dispatched", async () => {
    let dispatched = false;
    const tool = createTaskResumeTool({
      writer: { sessionId: "user:bot", turnId: "run-1", runId: "run-1" },
      resume: () => {
        dispatched = true;
        return Promise.resolve({
          status: "dispatched",
          taskId: "tk-2",
          model: "m",
        });
      },
    });
    const result = await tool.execute(
      { resume: "tk-1", prompt: "keep going", model: "other/model" },
      context(),
    );
    expect(dispatched).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("does not take a model");
  });

  test("task_resume passes a running task's refusal straight through", async () => {
    const tool = createTaskResumeTool({
      writer: { sessionId: "user:bot", turnId: "run-1", runId: "run-1" },
      resume: () =>
        Promise.resolve({
          status: "refused",
          reason:
            'task "tk-1" is still running; resume names a subagent that has finished',
        }),
    });
    const result = await tool.execute(
      { resume: "tk-1", prompt: "keep going" },
      context(),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("still running");
  });

  test("task_resume defaults to the background, exactly as Task does", async () => {
    let seen: { background: boolean } | undefined;
    const tool = createTaskResumeTool({
      writer: { sessionId: "user:bot", turnId: "run-1", runId: "run-1" },
      resume: (request) => {
        seen = request;
        return Promise.resolve({
          status: "dispatched",
          taskId: "tk-2",
          model: "m",
        });
      },
    });
    const result = await tool.execute(
      { resume: "tk-1", prompt: "keep going" },
      context(),
    );
    expect(seen?.background).toBe(true);
    expect(result.content).toContain("Resumed subagent tk-1 as tk-2");
  });

  test("a blocking dispatch that settled inside the window answers with the summary", async () => {
    const result = await tool(() =>
      Promise.resolve({
        status: "settled",
        taskId: "tk-1",
        model: "m",
        taskStatus: "completed",
        summary: "It changed on Tuesday.",
      }),
    ).execute(
      {
        description: "read it",
        prompt: "read the changelog",
        background: false,
      },
      context(),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("It changed on Tuesday.");
  });

  test("a blocking dispatch that did not settle is honest that it only dispatched", async () => {
    const result = await tool(() =>
      Promise.resolve({ status: "dispatched", taskId: "tk-1", model: "m" }),
    ).execute(
      {
        description: "read it",
        prompt: "read the changelog",
        background: false,
      },
      context(),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain("did not finish inside the wait, id tk-1");
    // The Turn is told to answer, not to go looking: this wording is what
    // stopped the model calling task_check and then task_resume on it.
    expect(result.content).toContain("do not poll for it");
    expect(result.content).toContain("Answer the User now");
  });
});

// ---------------------------------------------------------------------------
// Message delivery (G3). A queue nobody reads is an empty queue: GrokBot's
// `MessageSubagent` influences the *running* child, so the child folds what its
// parent queued into the next step of its own Turn.
// ---------------------------------------------------------------------------

describe("delivering queued messages into the child's next step", () => {
  const entered = (
    inputs: Array<{ messageId: string; text: string }> = [],
  ) => ({ kind: "enter" as const, inputs });

  test("folds them in, in seq order, under ids derived from the queue", () => {
    const decision = foldPendingTaskMessagesV1(
      entered(),
      [
        { seq: 1, message: "second" },
        { seq: 0, message: "first" },
      ],
      "tk-1",
    );
    if (decision.kind !== "enter") throw new Error("the step was rejected");
    expect(decision.inputs.map((input) => input.messageId)).toEqual([
      "task-msg:tk-1:0",
      "task-msg:tk-1:1",
    ]);
    expect(decision.inputs[0]?.text).toContain("first");
    expect(decision.inputs[1]?.text).toContain("second");
    // It reads as a message from the dispatcher, because that is what it is:
    // the child has no transcript to place a bare instruction in.
    expect(decision.inputs[0]?.text).toContain("dispatcher");
  });

  test("keeps the step's own inputs ahead of the delivered ones", () => {
    const decision = foldPendingTaskMessagesV1(
      entered([{ messageId: "m-1", text: "the brief" }]),
      [{ seq: 0, message: "and one more thing" }],
      "tk-1",
    );
    if (decision.kind !== "enter") throw new Error("the step was rejected");
    expect(decision.inputs.map((input) => input.messageId)).toEqual([
      "m-1",
      "task-msg:tk-1:0",
    ]);
  });

  test("a step with nothing queued is the step it already was", () => {
    const decision = entered();
    expect(foldPendingTaskMessagesV1(decision, [], "tk-1")).toBe(decision);
  });

  test("a rejected step stays rejected: delivery never admits a Turn", () => {
    const rejected = { kind: "reject" as const, reason: "no" };
    expect(
      foldPendingTaskMessagesV1(rejected, [{ seq: 0, message: "hi" }], "tk-1"),
    ).toBe(rejected);
  });
});
