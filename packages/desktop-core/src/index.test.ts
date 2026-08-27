import { afterEach, describe, expect, test } from "bun:test";
import { Context } from "cordis";
import { DesktopCommandRegistry } from "./index.js";

const roots: Context[] = [];

async function createRegistry(): Promise<Context> {
  const root = new Context();
  roots.push(root);
  await root.plugin(DesktopCommandRegistry);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => root.fiber.dispose()));
});

async function expectFailure(
  promise: Promise<unknown>,
  message: string,
): Promise<void> {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(failure instanceof Error ? failure.message : "").toContain(message);
}

describe("DesktopCommandRegistry", () => {
  test("decodes and invokes a registered command", async () => {
    const root = await createRegistry();
    root.desktopCommands.register({
      id: "fixture.echo",
      decode(input: unknown): string {
        if (typeof input !== "string") throw new Error("text is required");
        return input;
      },
      execute: (input: string) => Promise.resolve(`echo:${input}`),
    });

    expect(
      await root.desktopCommands.invoke<string>("fixture.echo", "hello"),
    ).toBe("echo:hello");
    await expectFailure(
      root.desktopCommands.invoke("fixture.echo", { text: "no" }),
      "text is required",
    );
  });

  test("removes only the registration that owns the command", async () => {
    const root = await createRegistry();
    const dispose = root.desktopCommands.register({
      id: "fixture.command",
      decode: () => null,
      execute: () => Promise.resolve(),
    });

    expect(root.desktopCommands.list()).toEqual([{ id: "fixture.command" }]);
    dispose();
    dispose();
    expect(root.desktopCommands.list()).toEqual([]);
    await expectFailure(
      root.desktopCommands.invoke("fixture.command", null),
      'desktop command "fixture.command" is unavailable',
    );
  });

  test("rejects duplicate command ids", async () => {
    const root = await createRegistry();
    const first = {
      id: "fixture.command",
      decode: () => null,
      execute: () => Promise.resolve(),
    };
    root.desktopCommands.register(first);

    expect(() => root.desktopCommands.register(first)).toThrow(
      'desktop command "fixture.command" is already registered',
    );
  });

  test("honors cancellation before execution", async () => {
    const root = await createRegistry();
    let executions = 0;
    root.desktopCommands.register({
      id: "fixture.cancelled",
      decode: () => null,
      execute: () => {
        executions += 1;
        return Promise.resolve();
      },
    });
    const controller = new AbortController();
    controller.abort(new Error("cancelled by test"));

    await expectFailure(
      root.desktopCommands.invoke("fixture.cancelled", null, controller.signal),
      "cancelled by test",
    );
    expect(executions).toBe(0);
  });
});
