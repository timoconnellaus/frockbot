import { describe, expect, test } from "bun:test";
import {
  createAgentRuntimeHarness,
  frockbotToolCall,
} from "@frockbot/app/testkit";
import type { ComputerHostV1 } from "@frockbot/computer/core/host";
import { createComputerAgentFeature } from "./agent.js";

const host: ComputerHostV1 = {
  id: "fixture",
  capabilities: { viewerFrameOrigins: [] },
  open: () => Promise.reject(new Error("deleting a recording opens nothing")),
};

async function mounted(demonstrations?: {
  delete(id: string): Promise<"deleted" | "missing">;
}) {
  const harness = createAgentRuntimeHarness();
  harness.computers.register(host);
  await harness.mount(
    createComputerAgentFeature({
      userId: "user-1",
      defaultProviderId: "fixture",
      ...(demonstrations ? { demonstrations } : {}),
    }),
  );
  return harness;
}

async function call(
  harness: Awaited<ReturnType<typeof mounted>>,
  input: unknown,
  turnType: "chat" | "subagent" = "chat",
) {
  const context = {
    botId: "bot-1",
    agentId: "run-1",
    compositionGenerationId: "bootstrap",
    turnType,
    sessionId: "session-1",
    effectId: "tool:1:1:0",
    signal: new AbortController().signal,
  };
  const prepared = await harness.tools.prepare(
    frockbotToolCall("demonstration_delete", input, crypto.randomUUID()),
    context,
  );
  if (prepared.kind !== "ready") return prepared.result;
  return harness.tools.executePrepared(prepared, context);
}

describe("demonstration_delete", () => {
  const ID = "0123456789abcdef";

  test("deletes the one it names and says so, without waking a Computer", async () => {
    const asked: string[] = [];
    const harness = await mounted({
      delete: (id) => {
        asked.push(id);
        return Promise.resolve(asked.length === 1 ? "deleted" : "missing");
      },
    });

    expect(await call(harness, { demonstrationId: ID })).toMatchObject({
      isError: false,
      content: expect.stringContaining(`Deleted demonstration ${ID}`),
    });
    // Asked again, it is already gone: an answer, not a failure.
    expect(await call(harness, { demonstrationId: ID })).toMatchObject({
      isError: false,
      content: expect.stringContaining("no demonstration"),
    });
    expect(asked).toEqual([ID, ID]);
    await harness.dispose();
  });

  test("takes only a demonstration id", async () => {
    const harness = await mounted({
      delete: () => Promise.reject(new Error("never asked")),
    });
    for (const input of [
      {},
      { demonstrationId: "../../etc" },
      { demonstrationId: ID, also: "this" },
    ]) {
      expect(await call(harness, input)).toMatchObject({ isError: true });
    }
    await harness.dispose();
  });

  test("is offered to the conversation only, and only where recordings are kept", async () => {
    const harness = await mounted({
      delete: () => Promise.resolve("deleted"),
    });
    expect(
      await call(harness, { demonstrationId: ID }, "subagent"),
    ).toMatchObject({ isError: true });
    await harness.dispose();

    const without = await mounted();
    expect(await call(without, { demonstrationId: ID })).toMatchObject({
      isError: true,
    });
    await without.dispose();
  });
});
