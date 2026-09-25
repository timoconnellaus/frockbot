import { describe, expect, test } from "bun:test";
import {
  createAgentRuntimeHarness,
  frockbotToolCall,
} from "@frockbot/app/testkit";
import type { ComputerHostV1 } from "@frockbot/computer/core/host";
import {
  createComputerAgentFeature,
  type ComputerPluginPagesSeamV1,
} from "./agent.js";

const opened: string[] = [];
const host: ComputerHostV1 = {
  id: "fixture",
  capabilities: { viewerFrameOrigins: [] },
  open: () => {
    opened.push("open");
    return Promise.reject(new Error("a refused try opens no Computer"));
  },
};

const writer = { sessionId: "session-1", turnId: "turn-1", runId: "run-1" };

async function mounted(pluginPages?: ComputerPluginPagesSeamV1) {
  const harness = createAgentRuntimeHarness();
  harness.computers.register(host);
  await harness.mount(
    createComputerAgentFeature({
      userId: "user-1",
      defaultProviderId: "fixture",
      writer,
      ...(pluginPages ? { pluginPages } : {}),
    }),
  );
  return harness;
}

async function call(
  harness: Awaited<ReturnType<typeof mounted>>,
  input: unknown,
) {
  const context = {
    botId: "bot-1",
    agentId: "run-1",
    compositionGenerationId: "bootstrap",
    turnType: "chat" as const,
    sessionId: "session-1",
    effectId: "tool:1:1:0",
    signal: new AbortController().signal,
  };
  const prepared = await harness.tools.prepare(
    frockbotToolCall("plugin_page_try", input, crypto.randomUUID()),
    context,
  );
  if (prepared.kind !== "ready") return prepared.result;
  return harness.tools.executePrepared(prepared, context);
}

describe("plugin_page_try", () => {
  test("is offered only where there are pages to try", async () => {
    const without = await mounted();
    expect(await call(without, { pluginId: "tuner", steps: [] })).toMatchObject(
      {
        isError: true,
      },
    );
    await without.dispose();
  });

  test("refuses a bad try and a page it cannot build before waking a Computer", async () => {
    opened.length = 0;
    const asked: unknown[] = [];
    const harness = await mounted({
      pageToTry: (input) => {
        asked.push(input);
        return Promise.resolve({ failure: 'tuner has no page "notes"' });
      },
    });
    expect(
      await call(harness, { pluginId: "tuner", steps: [{ swipe: "left" }] }),
    ).toMatchObject({
      isError: true,
      content: expect.stringContaining("click, tone"),
    });
    expect(asked).toEqual([]);
    expect(
      await call(harness, {
        pluginId: "tuner",
        surfaceId: "notes",
        steps: [{ screenshot: "x" }],
      }),
    ).toMatchObject({
      isError: true,
      content: 'tuner has no page "notes"',
    });
    expect(asked).toEqual([{ pluginId: "tuner", surfaceId: "notes" }]);
    expect(opened).toEqual([]);
    await harness.dispose();
  });
});
