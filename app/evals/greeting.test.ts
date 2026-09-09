import { expect, test } from "bun:test";
import { createAgentLoop } from "@frockbot/core/agent-loop";
import { createAgentRuntimeHarness } from "@frockbot/app/testkit";
import { shellAgentFeature } from "../shell/agent.js";
import { gradeGreeting } from "./greeting.js";

for (const repairFirst of [false, true]) {
  test(`greeting grader ${repairFirst ? "rejects repaired delivery" : "accepts a single final send"}`, async () => {
    const root = createAgentRuntimeHarness();
    await root.mount(shellAgentFeature);
    let calls = 0;
    root.llm.register({
      id: "fixture",
      async *stream() {
        calls++;
        if (repairFirst && calls === 1)
          yield { type: "text-delta", text: "Hello!" };
        else
          yield {
            type: "tool-call",
            call: {
              id: `send-${calls}`,
              name: "send_to_user",
              input: {
                disposition: "finish",
                payload: { type: "text", text: "Hello! How can I help?" },
              },
            },
          };
        yield { type: "finish", reason: "completed" };
      },
    });
    const loop = createAgentLoop(root, {
      maxSteps: 3,
      composition: {
        generationId: "1970-01-01T00:00:00.000Z:0123456789abcdef",
        artifactSetHash: "a".repeat(64),
      },
    });
    try {
      const handle = await loop.create({
        botId: "eval",
        sessionId: "eval",
        provider: "fixture",
        model: "fixture",
        turnType: "chat",
        admitEffect: () => Promise.resolve(true),
      });
      handle.agent.send("Hi");
      await handle.agent.whenIdle();
      const result = gradeGreeting(handle.agent.session.events);
      expect(result.passed).toBe(!repairFirst);
      expect(result.checks.oneVisibleReply).toBe(true);
      expect(result.checks.oneModelCall).toBe(!repairFirst);
    } finally {
      await loop.dispose();
      await root.dispose();
    }
  });
}
