import { describe, expect, test } from "bun:test";
import { createAgentRuntimeHarness } from "@frockbot/plugin-testkit";
import type { ShellMountedComposition } from "./backend-composition.js";
import { executeDirectToolTurn } from "./backend-runner.js";

describe("Package iframe direct tool Turn", () => {
  test("journals intent before execution and returns the result in the ordinary Session log", async () => {
    const runtime = createAgentRuntimeHarness();
    const session = runtime.sessions.create("user:bot");
    let calls = 0;
    runtime.tools.registerNamespace({
      name: "weather-page",
      external: true,
      status: "ready",
    });
    runtime.tools.register({
      name: "weather_lookup",
      namespace: "weather-page",
      description: "Weather",
      inputSchema: {},
      idempotent: true,
      execute: async () => {
        calls += 1;
        expect(session.events.at(-1)?.type).toBe("tool/call");
        return { content: '{"temperature":21}', isError: false };
      },
    });
    const previous = [...session.events];
    const generation = {
      schemaVersion: 1 as const,
      generationId: "generation-1",
      artifactSetHash: "a".repeat(64),
      createdAt: "2026-09-02T00:00:00.000Z",
      origin: { kind: "bootstrap" as const },
      members: [],
      status: "active" as const,
    };
    const composition = {
      generation,
      runtime: {
        services: runtime,
        agent: { agent: { session, botId: "bot", id: "bot" } },
      },
      verify: () => Promise.resolve(),
      dispose: () => runtime.dispose(),
    } as unknown as ShellMountedComposition;

    const result = await executeDirectToolTurn({
      command: {
        runId: "command-1",
        sessionId: "user:bot",
        acceptedAt: "2026-09-02T00:00:00.000Z",
        text: "Weather · weather_lookup",
        directTool: {
          generationId: "generation-1",
          packageId: "weather-page",
          name: "weather_lookup",
          input: { city: "Sydney" },
        },
      },
      previousEvents: previous,
      composition,
      admitEffect: () => Promise.resolve(true),
      signal: new AbortController().signal,
    });

    expect(calls).toBe(1);
    expect(result.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["tool/call", "tool/result", "turn/end"]),
    );
    expect(
      result.events.find((event) => event.type === "tool/result"),
    ).toMatchObject({
      name: "call_dynamic_tool",
      content: '{"temperature":21}',
    });
  });
});
