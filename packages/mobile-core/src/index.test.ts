import { afterEach, describe, expect, test } from "bun:test";
import { Context } from "cordis";
import { decodeMobileShareRequest, MobileCommandRegistry } from "./index.js";

const roots: Context[] = [];

async function createRegistry(): Promise<Context> {
  const root = new Context();
  roots.push(root);
  await root.plugin(MobileCommandRegistry);
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

describe("MobileCommandRegistry", () => {
  test("decodes and invokes a registered command", async () => {
    const root = await createRegistry();
    root.mobileCommands.register({
      id: "fixture.echo",
      decode(input: unknown): string {
        if (typeof input !== "string") throw new Error("text is required");
        return input;
      },
      execute: (input: string) => Promise.resolve(`echo:${input}`),
    });

    expect(
      await root.mobileCommands.invoke<string>("fixture.echo", "hello"),
    ).toBe("echo:hello");
    await expectFailure(
      root.mobileCommands.invoke("fixture.echo", { text: "no" }),
      "text is required",
    );
  });

  test("removes only the registration that owns the command", async () => {
    const root = await createRegistry();
    const dispose = root.mobileCommands.register({
      id: "fixture.command",
      decode: () => null,
      execute: () => Promise.resolve(),
    });

    expect(root.mobileCommands.list()).toEqual([{ id: "fixture.command" }]);
    dispose();
    dispose();
    expect(root.mobileCommands.list()).toEqual([]);
    await expectFailure(
      root.mobileCommands.invoke("fixture.command", null),
      'mobile command "fixture.command" is unavailable',
    );
  });

  test("rejects duplicate command ids", async () => {
    const root = await createRegistry();
    const first = {
      id: "fixture.command",
      decode: () => null,
      execute: () => Promise.resolve(),
    };
    root.mobileCommands.register(first);

    expect(() => root.mobileCommands.register(first)).toThrow(
      'mobile command "fixture.command" is already registered',
    );
  });

  test("rejects an empty command id", async () => {
    const root = await createRegistry();

    expect(() =>
      root.mobileCommands.register({
        id: "  ",
        decode: () => null,
        execute: () => Promise.resolve(),
      }),
    ).toThrow("mobile command id must not be empty");
  });

  test("lists registered commands in sorted order", async () => {
    const root = await createRegistry();
    root.mobileCommands.register({
      id: "fixture.second",
      decode: () => null,
      execute: () => Promise.resolve(),
    });
    root.mobileCommands.register({
      id: "fixture.first",
      decode: () => null,
      execute: () => Promise.resolve(),
    });

    expect(root.mobileCommands.list()).toEqual([
      { id: "fixture.first" },
      { id: "fixture.second" },
    ]);
  });

  test("honors cancellation before execution", async () => {
    const root = await createRegistry();
    let executions = 0;
    root.mobileCommands.register({
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
      root.mobileCommands.invoke("fixture.cancelled", null, controller.signal),
      "cancelled by test",
    );
    expect(executions).toBe(0);
  });
});

describe("decodeMobileShareRequest", () => {
  test("normalizes a share request that carries text", () => {
    expect(
      decodeMobileShareRequest({ title: " Turn ", text: " done ", url: " " }),
    ).toEqual({ title: "Turn", text: "done", url: undefined });
  });

  test("requires text or url", () => {
    expect(() => decodeMobileShareRequest({ title: "Turn" })).toThrow(
      "share request must include text or url",
    );
  });
});
