import { describe, expect, test } from "bun:test";
import { Context } from "cordis";
import {
  ComputerError,
  ComputerRegistry,
  type ComputerHandle,
  type ComputerProvider,
  normalizeComputerPath,
} from "./core.js";

function provider(id: string, opened: string[]): ComputerProvider {
  return {
    id,
    async open(target, assignment): Promise<ComputerHandle> {
      opened.push(`${target.userId}:${target.botId}:${assignment.generation}`);
      return {
        assignment,
        close: () => Promise.resolve(),
      };
    },
  };
}

describe("Computer paths", () => {
  test("accepts relative POSIX paths and rejects namespace escapes", () => {
    expect(normalizeComputerPath("memory/profile.md")).toBe(
      "memory/profile.md",
    );
    for (const path of [
      "/etc/passwd",
      "../secret",
      "a/./b",
      "a//b",
      "a\\b",
      " spaced.md ",
      "line\nbreak.md",
    ]) {
      expect(() => normalizeComputerPath(path)).toThrow(ComputerError);
    }
  });
});

describe("ComputerRegistry", () => {
  test("opens a Bot's selected provider without exposing provider selection to consumers", async () => {
    const root = new Context();
    await root.plugin(ComputerRegistry);
    const opened: string[] = [];
    root.computers.register(provider("sprites", opened));
    const assignment = root.computers.assign(
      { userId: "user-1", botId: "bot-1" },
      "sprites",
    );

    const computer = await root.computers.open({
      userId: "user-1",
      botId: "bot-1",
    });

    expect(computer.assignment).toEqual(assignment);
    expect(opened).toEqual(["user-1:bot-1:1"]);
    await root.fiber.dispose();
  });

  test("increments the generation when a Bot changes provider", async () => {
    const root = new Context();
    await root.plugin(ComputerRegistry);
    root.computers.register(provider("sprites", []));
    root.computers.register(provider("local", []));
    const target = { userId: "user-1", botId: "bot-1" };

    expect(root.computers.assign(target, "sprites").generation).toBe(1);
    expect(root.computers.assign(target, "local")).toMatchObject({
      providerId: "local",
      generation: 2,
    });
    await root.fiber.dispose();
  });

  test("rejects operations through a stale handle after provider reassignment", async () => {
    const root = new Context();
    await root.plugin(ComputerRegistry);
    const executable = (id: string): ComputerProvider => ({
      id,
      open: async (_target, assignment) => ({
        assignment,
        exec: {
          execute: async () => ({
            exitCode: 0,
            stdout: new Uint8Array(),
            stderr: new Uint8Array(),
            outputTruncated: false,
          }),
        },
        close: () => Promise.resolve(),
      }),
    });
    root.computers.register(executable("sprites"));
    root.computers.register(executable("local"));
    const target = { userId: "user-1", botId: "bot-1" };
    root.computers.assign(target, "sprites");
    const oldComputer = await root.computers.open(target);

    root.computers.assign(target, "local");

    await expect(
      oldComputer.exec?.execute({ executable: "true" }),
    ).rejects.toMatchObject({ code: "stale-assignment" });
    await root.fiber.dispose();
  });

  test("fails clearly when a Bot has no Computer assignment", async () => {
    const root = new Context();
    await root.plugin(ComputerRegistry);

    await expect(
      root.computers.open({ userId: "user-1", botId: "bot-1" }),
    ).rejects.toMatchObject({
      code: "not-assigned",
    } satisfies Partial<ComputerError>);
    await root.fiber.dispose();
  });
});
