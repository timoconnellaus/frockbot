import { describe, expect, test } from "bun:test";
import type {
  PluginWorkerTriggerResultV1,
  ToolExecutionContext,
} from "@frockbot/core/contracts";
import type {
  PluginAuthoringHostV1,
  PluginTriggerSampleV1,
} from "./authoring.js";
import { pluginTools } from "./feature.js";

const CONTEXT: ToolExecutionContext = {
  botId: "bot-1",
  agentId: "run-1",
  compositionGenerationId: "gen-1",
  turnType: "chat",
  sessionId: "session-1",
  effectId: "tool:1:1:0",
  signal: new AbortController().signal,
};

function triggerTry(answer: PluginWorkerTriggerResultV1) {
  const asked: PluginTriggerSampleV1[] = [];
  // Only the one verb this tool calls; the rest would throw if reached.
  const plugins = {
    tryTrigger: async (sample: PluginTriggerSampleV1) => {
      asked.push(sample);
      return answer;
    },
  } as unknown as PluginAuthoringHostV1;
  const tool = pluginTools(
    {
      plugins,
      turn: { sessionId: "session-1", runId: "run-1", turnId: "run-1" },
    },
    { get: () => undefined },
  ).find((candidate) => candidate.name === "plugin_trigger_try")!;
  return { tool, asked };
}

describe("plugin_trigger_try", () => {
  test("is reviewed like the Plugin code it runs", () => {
    const { tool } = triggerTry({ schemaVersion: 1, status: "drop" });
    expect(tool.effect).toBe("mutate");
    expect(tool.idempotent).toBe(false);
  });

  test("hands the Plugin headers as the door does and says what would fire", async () => {
    const { tool, asked } = triggerTry({
      schemaVersion: 1,
      status: "fire",
      text: "Storm warning for Perth",
    });
    const result = await tool.execute(
      {
        pluginId: "alerts",
        trigger: "inbound",
        body: '{"city":"Perth"}',
        headers: { "X-Signature": "sig-1", Authorization: "Bearer k" },
      },
      CONTEXT,
    );
    expect(asked).toEqual([
      {
        pluginId: "alerts",
        trigger: "inbound",
        headers: { "x-signature": "sig-1" },
        body: '{"city":"Perth"}',
      },
    ]);
    expect(result).toEqual({
      isError: false,
      content: [
        `alerts's "inbound" trigger would fire its Routine, which would read:`,
        "Storm warning for Perth",
        "Nothing fired: this was a try.",
      ].join("\n"),
    });
  });

  test("plays a module's event with its source and no headers", async () => {
    const { tool, asked } = triggerTry({
      schemaVersion: 1,
      status: "drop",
      reason: "not for me",
    });
    const result = await tool.execute(
      {
        pluginId: "beeper",
        trigger: "message",
        body: '{"text":"hi"}',
        moduleEvent: { moduleId: "bridge", key: "m-1" },
      },
      CONTEXT,
    );
    expect(asked[0]?.source).toEqual({
      kind: "device-module",
      moduleId: "bridge",
      machineId: "plugin-trigger-try",
      key: "m-1",
    });
    expect(result.content).toBe(
      `beeper's "message" trigger would drop this delivery: not for me. Nothing fired: this was a try.`,
    );
    expect(
      await tool.execute(
        {
          pluginId: "beeper",
          trigger: "message",
          body: "not json",
          moduleEvent: { moduleId: "bridge", key: "m-2" },
        },
        CONTEXT,
      ),
    ).toMatchObject({
      isError: true,
      content: expect.stringContaining("JSON"),
    });
    expect(asked).toHaveLength(1);
  });
});
