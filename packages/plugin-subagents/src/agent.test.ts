import { describe, expect, test } from "bun:test";
import {
  createSubagentModelsPromptSectionV1,
  createTaskTool,
  decodeTaskToolInputV1,
  subagentsAdmissionCeilingV1,
  TASK_DISPATCH_CAPABILITY_V1,
  type SubagentDispatchOutcomeV1,
  type SubagentDispatchRequestV1,
} from "./agent.js";
import { subagentModelCatalogV1 } from "./models.js";
import {
  TASK_PROMPT_MAX_BYTES_V1,
  type TaskModelBindingV1,
} from "./records.js";
import type { ToolExecutionContext } from "@frockbot/kernel-contracts";

const BINDING: TaskModelBindingV1 = {
  assignmentId: "asg-1",
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
        assignments: [BINDING],
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
          assignments: [BINDING],
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

  test("renders nothing for a Bot with no enabled model Assignment", async () => {
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
