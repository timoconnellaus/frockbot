import { describe, expect, test } from "bun:test";
import { Context } from "cordis";
import { SessionStore } from "@frockbot/kernel-contracts";
import { ToolRegistry } from "@frockbot/plugin-tools";
import type { ShellMountedComposition } from "./backend-composition.js";
import { executeDirectToolTurn } from "./backend-runner.js";

describe("Package iframe direct tool Turn", () => {
  test("journals intent before execution and returns the result in the ordinary Session log", async () => {
    const root = new Context();
    await root.plugin(SessionStore);
    await root.plugin(ToolRegistry);
    const session = root.sessions.create("user:bot");
    let calls = 0;
    root.tools.register({
      name: "weather_lookup",
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
      root,
      generation,
      runtime: {
        root,
        agent: { agent: { session, botId: "bot", id: "bot" } },
      },
      verify: () => Promise.resolve(),
      dispose: () => root.fiber.dispose(),
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
    ).toMatchObject({ name: "weather_lookup", content: '{"temperature":21}' });
  });
});
